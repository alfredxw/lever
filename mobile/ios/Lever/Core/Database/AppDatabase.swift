import Foundation
import GRDB
import OSLog

/// Submit mutations in store order, including cache invalidations. Reads take WAL
/// snapshots on GRDB's readers after previously submitted writes have committed.
final class AppDatabase: Sendable {
    static let shared = AppDatabase()
    private let writer = DispatchQueue(label: "app.lever.mobile.cache-writer", qos: .userInitiated)
    private static let log = Logger(subsystem: "app.lever.mobile", category: "database")

    private static let pool = Result {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try open(support: support)
    }

    static func open(support: URL) throws -> DatabasePool {
        let directory = support.appendingPathComponent("LeverDB", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let pool = try DatabasePool(path: directory.appendingPathComponent("lever_mobile.sqlite").path)
        let legacy = support.appendingPathComponent("LeverCache", isDirectory: true)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("archive-search-v1") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, payload BLOB NOT NULL, updated_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
                    session_id TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL DEFAULT 0, payload BLOB NOT NULL,
                    updated_at INTEGER NOT NULL, PRIMARY KEY(scope,kind,id));
                CREATE INDEX IF NOT EXISTS idx_records_scope_sess_seq ON records(scope,session_id,kind,sequence DESC);
                CREATE VIRTUAL TABLE record_search USING fts5(terms, tokenize='unicode61');
                CREATE TRIGGER remove_search AFTER DELETE ON records BEGIN DELETE FROM record_search WHERE rowid=old.rowid; END;
                DELETE FROM kv WHERE key LIKE 'avatar:%';
                """)
            let rows = try Row.fetchCursor(db, sql: "SELECT rowid,payload FROM records")
            while let row = try rows.next() {
                guard let record = try? JSONDecoder().decode(ArchiveRecord.self, from: row["payload"] as Data) else { continue }
                try index(db, record: record, rowID: row["rowid"])
            }
        }
        migrator.registerMigration("separate-run-steps") { db in
            try db.execute(sql: """
                CREATE TABLE run_steps(device_id TEXT NOT NULL, run_id TEXT NOT NULL, payload BLOB NOT NULL,
                    PRIMARY KEY(device_id,run_id)) WITHOUT ROWID;
                INSERT INTO run_steps SELECT substr(parts,1,instr(parts,':')-1),substr(parts,instr(parts,':')+1),payload
                    FROM (SELECT substr(key,11) AS parts,payload FROM kv WHERE key GLOB 'run_steps:*:*');
                DELETE FROM kv WHERE key GLOB 'run_steps:*:*';
                """)
        }
        try migrator.migrate(pool)
        try LegacyCacheMigrator.migrate(legacy, into: pool)
        return pool
    }

    func prepare() async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            writer.async { done.resume(with: Self.pool.map { _ in () }) }
        }
    }

    private func write(_ work: @escaping @Sendable (Database) throws -> Void) {
        writer.async {
            do { try Self.pool.get().write(work) }
            catch { Self.log.error("Cache write failed: \(error.localizedDescription, privacy: .private)") }
        }
    }

    private func read<T: Sendable>(_ fallback: T, _ work: @escaping @Sendable (Database) throws -> T) async -> T {
        await withCheckedContinuation { continuation in
            writer.async {
                do {
                    try Self.pool.get().asyncRead { result in
                        do { continuation.resume(returning: try work(result.get())) }
                        catch {
                            Self.log.error("Cache read failed: \(error.localizedDescription, privacy: .private)")
                            continuation.resume(returning: fallback)
                        }
                    }
                } catch { continuation.resume(returning: fallback) }
            }
        }
    }

    func saveKV<T: Encodable & Sendable>(_ value: T, forKey key: String) {
        write { db in try Self.put(db, key: key, data: JSONEncoder().encode(value)) }
    }

    static func put(_ db: Database, key: String, data: Data) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO kv VALUES(?,?,unixepoch())", arguments: [key, data])
    }

    func loadKVAsync<T: Decodable & Sendable>(_ key: String, as type: T.Type) async -> T? {
        await read(nil) { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM kv WHERE key=?", arguments: [key])
                .map { try JSONDecoder().decode(type, from: $0) }
        }
    }

    func saveSteps(_ steps: [RunItem], device: String, run: String) {
        write { db in
            try db.execute(sql: "INSERT OR REPLACE INTO run_steps VALUES(?,?,?)", arguments: [device, run, try JSONEncoder().encode(steps)])
        }
    }

    func steps(device: String, run: String) async -> [RunItem]? {
        await read(nil) { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM run_steps WHERE device_id=? AND run_id=?", arguments: [device, run])
                .map { try JSONDecoder().decode([RunItem].self, from: $0) }
        }
    }

    func deleteKV(_ key: String) {
        write { db in try db.execute(sql: "DELETE FROM kv WHERE key=?", arguments: [key]) }
    }

    static func insert(_ db: Database, scope: String, records: [ArchiveRecord]) throws {
        let encoder = JSONEncoder()
        for record in records {
            let rowID = try Int64.fetchOne(db, sql: """
                INSERT INTO records(scope,kind,id,session_id,sequence,payload,updated_at) VALUES(?,?,?,?,?,?,unixepoch())
                ON CONFLICT(scope,kind,id) DO UPDATE SET session_id=excluded.session_id, sequence=excluded.sequence,
                    payload=excluded.payload, updated_at=excluded.updated_at RETURNING rowid
                """, arguments: [scope, record.kind, record.id, record.sessionId ?? "", record.sequence ?? 0, try encoder.encode(record)])
            if let rowID { try index(db, record: record, rowID: rowID) }
        }
    }

    private static func index(_ db: Database, record: ArchiveRecord, rowID: Int64) throws {
        try db.execute(sql: "DELETE FROM record_search WHERE rowid=?", arguments: [rowID])
        guard record.superseded != true, ["agent","chat","session","run"].contains(record.kind) else { return }
        let parts = [record.title, record.preview, record.text] + (record.items ?? []).filter { $0.kind == "text" || $0.kind == "user" }.map(\.text)
        let terms = searchTerms(parts.compactMap { $0 }.joined(separator: " "))
        guard !terms.isEmpty else { return }
        try db.execute(sql: "INSERT INTO record_search(rowid,terms) VALUES(?,?)", arguments: [rowID,terms])
    }

    // unicode61 groups adjacent Han characters. Separate them so FTS phrase
    // prefix queries also match words in an unspaced Chinese sentence.
    static func searchTerms(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            if scalar.properties.isIdeographic {
                result += " "; result.unicodeScalars.append(scalar); result += " "
            } else { result.unicodeScalars.append(scalar) }
        }
        return result
    }

    struct Match: Sendable { let scope: String; let record: ArchiveRecord }

    func search(_ query: String) async -> [Match] {
        let words = query.split(whereSeparator: \.isWhitespace).prefix(12).map {
            Self.searchTerms(String($0.prefix(100))).replacingOccurrences(of: "\"", with: "\"\"")
        }
        guard !words.isEmpty else { return [] }
        let pattern = words.map { "\"\($0)\"*" }.joined(separator: " AND ")
        return await read([]) { db in
            let rows = try Row.fetchAll(db, sql: """
                SELECT r.scope,r.payload FROM record_search JOIN records r ON r.rowid=record_search.rowid
                WHERE record_search MATCH ? AND (r.kind != 'run' OR r.scope LIKE 'chat:%')
                ORDER BY rank LIMIT 100
                """, arguments: [pattern])
            return try rows.map { Match(scope: $0["scope"], record: try JSONDecoder().decode(ArchiveRecord.self, from: $0["payload"] as Data)) }
        }
    }

    func upsertRecords(scope: String, records: [ArchiveRecord]) {
        write { db in try Self.insert(db, scope: scope, records: records) }
    }

    func deleteRecords(scope: String, keys: [(kind: String, id: String)]) {
        write { db in
            for key in keys { try db.execute(sql: "DELETE FROM records WHERE scope=? AND kind=? AND id=?", arguments: [scope,key.kind,key.id]) }
        }
    }

    func replaceScopeRecords(scope: String, records: [ArchiveRecord]) {
        write { db in
            try db.execute(sql: "DELETE FROM records WHERE scope=?", arguments: [scope])
            try Self.insert(db, scope: scope, records: records)
        }
    }

    func deleteScope(_ scope: String) { replaceScopeRecords(scope: scope, records: []) }

    private static func records(_ db: Database, _ sql: String, _ arguments: StatementArguments) throws -> [ArchiveRecord] {
        try Data.fetchAll(db, sql: sql, arguments: arguments).compactMap { try? JSONDecoder().decode(ArchiveRecord.self, from: $0) }
    }

    func loadAllRecordsAsync(scope: String) async -> [ArchiveRecord] {
        await read([]) { try Self.records($0, "SELECT payload FROM records WHERE scope=? ORDER BY kind,id", [scope]) }
    }

    func loadChatTailRecordsAsync(scope: String, topicId: String?, runLimit: Int) async -> [ArchiveRecord] {
        await read([]) { db in
            var result = try Self.records(db, "SELECT payload FROM records WHERE scope=? AND kind!='run'", [scope])
            if let session = topicId ?? result.first(where: { $0.kind == "session" && $0.type == "main" })?.id {
                result += try Self.records(db, "SELECT payload FROM records WHERE scope=? AND kind='run' AND session_id=? ORDER BY sequence DESC LIMIT ?", [scope,session,runLimit])
                if topicId == nil {
                    result += try Self.records(db, """
                        SELECT payload FROM (SELECT payload, row_number() OVER (PARTITION BY session_id ORDER BY sequence DESC) AS rn
                        FROM records WHERE scope=? AND kind='run' AND session_id!=?) WHERE rn<=3
                        """, [scope,session])
                }
            } else {
                result += try Self.records(db, "SELECT payload FROM records WHERE scope=? AND kind='run' ORDER BY sequence DESC LIMIT ?", [scope,runLimit])
            }
            return result
        }
    }

    func retainDeviceScopes(_ ids: Set<String>) {
        write { db in
            for scope in try String.fetchAll(db, sql: "SELECT DISTINCT scope FROM records")
            where !ids.contains(where: { scope == "index:\($0)" || scope == "priv:\($0)" || scope.hasPrefix("chat:\($0)|") }) {
                try db.execute(sql: "DELETE FROM records WHERE scope=?", arguments: [scope])
            }
            for device in try String.fetchAll(db, sql: "SELECT DISTINCT device_id FROM run_steps") where !ids.contains(device) {
                try db.execute(sql: "DELETE FROM run_steps WHERE device_id=?", arguments: [device])
            }
            for key in try String.fetchAll(db, sql: "SELECT key FROM kv")
            where (key.hasPrefix("index_cursor:") || key.hasPrefix("chat_cursor:")) &&
                !ids.contains(where: { key == "index_cursor:\($0)" || key.hasPrefix("chat_cursor:\($0)|") }) {
                try db.execute(sql: "DELETE FROM kv WHERE key=?", arguments: [key])
            }
        }
        checkpoint()
    }

    func clearAll() {
        write { db in
            try db.execute(sql: "DELETE FROM records; DELETE FROM kv; DELETE FROM run_steps")
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
            let legacy = support.appendingPathComponent("LeverCache", isDirectory: true)
            if FileManager.default.fileExists(atPath: legacy.path) { try? FileManager.default.removeItem(at: legacy) }
        }
        checkpoint()
    }

    private func checkpoint() {
        writer.async {
            do { try Self.pool.get().writeWithoutTransaction { try $0.execute(sql: "PRAGMA wal_checkpoint(TRUNCATE)") } }
            catch { Self.log.error("Cache checkpoint failed: \(error.localizedDescription, privacy: .private)") }
        }
    }
}
