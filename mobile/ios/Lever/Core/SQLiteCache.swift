import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// High-performance local SQLite WAL cache for Lever iOS:
/// - Eliminates whole-file multi-MB JSON rewrites on every sync tick (row-level incremental UPSERT)
/// - Enables indexed O(log N) tail reads on cold open (`(scope, session_id, kind, sequence DESC)`)
/// - Stores KV metadata, raw avatar images, sync cursors, and lazily hydrated tool steps in one atomic WAL store
final class SQLiteCache: @unchecked Sendable {
    static let shared = SQLiteCache()

    private let queue = DispatchQueue(label: "app.lever.mobile.sqlite", qos: .userInitiated)
    private var db: OpaquePointer?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private init() {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = support.appendingPathComponent("LeverDB", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dbPath = dir.appendingPathComponent("lever_mobile.sqlite").path
        queue.sync {
            openAndMigrate(path: dbPath)
        }
    }

    deinit {
        if let db {
            sqlite3_close_v2(db)
        }
    }

    private func openAndMigrate(path: String) {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close_v2(handle) }
            return
        }
        db = handle
        exec("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 3000;
            PRAGMA temp_store = MEMORY;
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                payload BLOB NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS records (
                scope TEXT NOT NULL,
                kind TEXT NOT NULL,
                id TEXT NOT NULL,
                session_id TEXT NOT NULL DEFAULT '',
                sequence INTEGER NOT NULL DEFAULT 0,
                payload BLOB NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (scope, kind, id)
            );
            CREATE INDEX IF NOT EXISTS idx_records_scope_sess_seq
                ON records(scope, session_id, kind, sequence DESC);
            CREATE INDEX IF NOT EXISTS idx_records_scope_kind
                ON records(scope, kind);
        """)
    }

    // MARK: - Key-Value Store (Metadata, Cursors, Avatars, Lazy Steps)

    func loadKV<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        queue.sync {
            guard let data = readRawKVLocked(key) else { return nil }
            return try? decoder.decode(T.self, from: data)
        }
    }

    func loadKVAsync<T: Decodable & Sendable>(_ key: String, as type: T.Type = T.self) async -> T? {
        await withCheckedContinuation { continuation in
            queue.async {
                guard let data = self.readRawKVLocked(key),
                      let value = try? self.decoder.decode(T.self, from: data) else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: value)
            }
        }
    }

    func saveKV<T: Encodable & Sendable>(_ value: T, forKey key: String) {
        queue.async {
            guard let data = try? self.encoder.encode(value) else { return }
            self.writeRawKVLocked(data, forKey: key)
        }
    }

    func loadRawKV(_ key: String) -> Data? {
        queue.sync {
            readRawKVLocked(key)
        }
    }

    func saveRawKV(_ data: Data, forKey key: String) {
        queue.async {
            self.writeRawKVLocked(data, forKey: key)
        }
    }

    func deleteKV(_ key: String) {
        queue.async {
            guard let db = self.db else { return }
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, "DELETE FROM kv WHERE key = ?", -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, key, -1, sqliteTransient)
            sqlite3_step(stmt)
        }
    }

    // MARK: - Row-Level Records Store (Zero Whole-File Rewrites)

    func upsertRecords(scope: String, records: [ArchiveRecord]) {
        guard !records.isEmpty else { return }
        queue.async {
            self.upsertRecordsLocked(scope: scope, records: records)
        }
    }

    func deleteRecords(scope: String, keys: [(kind: String, id: String)]) {
        guard !keys.isEmpty else { return }
        queue.async {
            guard let db = self.db else { return }
            self.exec("BEGIN IMMEDIATE")
            var stmt: OpaquePointer?
            let sql = "DELETE FROM records WHERE scope = ? AND kind = ? AND id = ?"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                defer { sqlite3_finalize(stmt) }
                for item in keys {
                    sqlite3_reset(stmt)
                    sqlite3_clear_bindings(stmt)
                    sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                    sqlite3_bind_text(stmt, 2, item.kind, -1, sqliteTransient)
                    sqlite3_bind_text(stmt, 3, item.id, -1, sqliteTransient)
                    sqlite3_step(stmt)
                }
                self.exec("COMMIT")
            } else {
                self.exec("ROLLBACK")
            }
        }
    }

    func deleteScope(_ scope: String) {
        queue.async {
            guard let db = self.db else { return }
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, "DELETE FROM records WHERE scope = ?", -1, &stmt, nil) == SQLITE_OK else { return }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
            sqlite3_step(stmt)
        }
    }

    func replaceScopeRecords(scope: String, records: [ArchiveRecord]) {
        queue.async {
            guard let db = self.db else { return }
            self.exec("BEGIN IMMEDIATE")
            var delStmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "DELETE FROM records WHERE scope = ?", -1, &delStmt, nil) == SQLITE_OK {
                sqlite3_bind_text(delStmt, 1, scope, -1, sqliteTransient)
                sqlite3_step(delStmt)
                sqlite3_finalize(delStmt)
            }
            let ok = self.insertRecordsStatementsLocked(scope: scope, records: records)
            self.exec(ok ? "COMMIT" : "ROLLBACK")
        }
    }

    func loadAllRecordsAsync(scope: String) async -> [ArchiveRecord] {
        await withCheckedContinuation { continuation in
            queue.async {
                let rows = self.queryRecordsLocked(
                    sql: "SELECT payload FROM records WHERE scope = ? ORDER BY kind ASC, id ASC",
                    bind: { stmt in
                        sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                    }
                )
                continuation.resume(returning: rows)
            }
        }
    }

    /// Indexed tail hydration for ChatDetailView (topicId == nil) or TopicDetailView (topicId != nil).
    /// Reads only non-run structural records + latest `runLimit` turns for the target session (plus up to 3 preview runs per topic when viewing main chat).
    func loadChatTailRecordsAsync(scope: String, topicId: String?, runLimit: Int = 30) async -> [ArchiveRecord] {
        await withCheckedContinuation { continuation in
            queue.async {
                guard self.db != nil else {
                    continuation.resume(returning: [])
                    return
                }
                let limit = max(1, runLimit)
                var result: [ArchiveRecord] = []

                // 1. Structural records: chat, sessions, requests
                let metaRecords = self.queryRecordsLocked(
                    sql: "SELECT payload FROM records WHERE scope = ? AND kind != 'run'",
                    bind: { stmt in
                        sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                    }
                )
                result.append(contentsOf: metaRecords)

                if let topicId, !topicId.isEmpty {
                    // 2a. Focused topic tail read via idx_records_scope_sess_seq
                    let topicRuns = self.queryRecordsLocked(
                        sql: """
                        SELECT payload FROM records
                        WHERE scope = ? AND kind = 'run' AND session_id = ?
                        ORDER BY sequence DESC
                        LIMIT ?
                        """,
                        bind: { stmt in
                            sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                            sqlite3_bind_text(stmt, 2, topicId, -1, sqliteTransient)
                            sqlite3_bind_int64(stmt, 3, Int64(limit))
                        }
                    )
                    result.append(contentsOf: topicRuns)
                } else {
                    // 2b. Main chat tail read + compact latest 3 preview turns per topic
                    let mainSessionId = metaRecords.first(where: { $0.kind == "session" && $0.type == "main" })?.id ?? ""
                    if !mainSessionId.isEmpty {
                        let mainRuns = self.queryRecordsLocked(
                            sql: """
                            SELECT payload FROM records
                            WHERE scope = ? AND kind = 'run' AND session_id = ?
                            ORDER BY sequence DESC
                            LIMIT ?
                            """,
                            bind: { stmt in
                                sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                                sqlite3_bind_text(stmt, 2, mainSessionId, -1, sqliteTransient)
                                sqlite3_bind_int64(stmt, 3, Int64(limit))
                            }
                        )
                        result.append(contentsOf: mainRuns)

                        let topicPreviewRuns = self.queryRecordsLocked(
                            sql: """
                            SELECT payload FROM (
                                SELECT payload, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY sequence DESC) AS rn
                                FROM records
                                WHERE scope = ? AND kind = 'run' AND session_id != ?
                            ) WHERE rn <= 3
                            """,
                            bind: { stmt in
                                sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                                sqlite3_bind_text(stmt, 2, mainSessionId, -1, sqliteTransient)
                            }
                        )
                        result.append(contentsOf: topicPreviewRuns)
                    } else {
                        // Fallback if main session metadata hasn't been persisted yet
                        let recentRuns = self.queryRecordsLocked(
                            sql: """
                            SELECT payload FROM records
                            WHERE scope = ? AND kind = 'run'
                            ORDER BY sequence DESC
                            LIMIT ?
                            """,
                            bind: { stmt in
                                sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
                                sqlite3_bind_int64(stmt, 2, Int64(limit))
                            }
                        )
                        result.append(contentsOf: recentRuns)
                    }
                }

                continuation.resume(returning: result)
            }
        }
    }

    // MARK: - Maintenance & Unpair Cleanup

    func retainDeviceScopes(_ retainedDeviceIds: Set<String>) {
        queue.sync {
            guard let db = self.db else { return }
            // Delete record scopes not matching any retained device ID
            var scopesToDelete: [String] = []
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT DISTINCT scope FROM records", -1, &stmt, nil) == SQLITE_OK {
                defer { sqlite3_finalize(stmt) }
                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let cStr = sqlite3_column_text(stmt, 0) {
                        let scope = String(cString: cStr)
                        let keep = retainedDeviceIds.contains { id in
                            scope == "index:\(id)" || scope == "priv:\(id)" || scope.hasPrefix("chat:\(id)|")
                        }
                        if !keep { scopesToDelete.append(scope) }
                    }
                }
            }
            if !scopesToDelete.isEmpty {
                self.exec("BEGIN IMMEDIATE")
                var delStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "DELETE FROM records WHERE scope = ?", -1, &delStmt, nil) == SQLITE_OK {
                    defer { sqlite3_finalize(delStmt) }
                    for scope in scopesToDelete {
                        sqlite3_reset(delStmt)
                        sqlite3_clear_bindings(delStmt)
                        sqlite3_bind_text(delStmt, 1, scope, -1, sqliteTransient)
                        sqlite3_step(delStmt)
                    }
                }
                self.exec("COMMIT")
            }

            // Clean per-device KV entries (cursors & lazy run steps) for removed devices
            var kvToDelete: [String] = []
            var kvStmt: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT key FROM kv", -1, &kvStmt, nil) == SQLITE_OK {
                defer { sqlite3_finalize(kvStmt) }
                while sqlite3_step(kvStmt) == SQLITE_ROW {
                    if let cStr = sqlite3_column_text(kvStmt, 0) {
                        let key = String(cString: cStr)
                        if key.hasPrefix("index_cursor:") || key.hasPrefix("chat_cursor:") || key.hasPrefix("run_steps:") {
                            let keep = retainedDeviceIds.contains { id in
                                key == "index_cursor:\(id)"
                                    || key.hasPrefix("chat_cursor:\(id)|")
                                    || key.hasPrefix("run_steps:\(id):")
                            }
                            if !keep { kvToDelete.append(key) }
                        }
                    }
                }
            }
            if !kvToDelete.isEmpty {
                self.exec("BEGIN IMMEDIATE")
                var delStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "DELETE FROM kv WHERE key = ?", -1, &delStmt, nil) == SQLITE_OK {
                    defer { sqlite3_finalize(delStmt) }
                    for key in kvToDelete {
                        sqlite3_reset(delStmt)
                        sqlite3_clear_bindings(delStmt)
                        sqlite3_bind_text(delStmt, 1, key, -1, sqliteTransient)
                        sqlite3_step(delStmt)
                    }
                }
                self.exec("COMMIT")
            }
        }
    }

    func clearAll() {
        queue.sync {
            guard self.db != nil else { return }
            self.exec("DELETE FROM records; DELETE FROM kv; PRAGMA wal_checkpoint(TRUNCATE);")
        }
    }

    // MARK: - Internal SQLite Helpers (must run on `queue`)

    private func exec(_ sql: String) {
        guard let db else { return }
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    private func readRawKVLocked(_ key: String) -> Data? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT payload FROM kv WHERE key = ? LIMIT 1", -1, &stmt, nil) == SQLITE_OK else {
            return nil
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, sqliteTransient)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        guard let ptr = sqlite3_column_blob(stmt, 0) else { return Data() }
        let len = Int(sqlite3_column_bytes(stmt, 0))
        return Data(bytes: ptr, count: len)
    }

    private func writeRawKVLocked(_ data: Data, forKey key: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        let sql = """
            INSERT INTO kv(key, payload, updated_at) VALUES(?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
        """
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, sqliteTransient)
        bindBlob(stmt, index: 2, data: data)
        sqlite3_bind_int64(stmt, 3, Int64(Date().timeIntervalSince1970))
        sqlite3_step(stmt)
    }

    private func upsertRecordsLocked(scope: String, records: [ArchiveRecord]) {
        guard db != nil else { return }
        exec("BEGIN IMMEDIATE")
        let ok = insertRecordsStatementsLocked(scope: scope, records: records)
        exec(ok ? "COMMIT" : "ROLLBACK")
    }

    private func insertRecordsStatementsLocked(scope: String, records: [ArchiveRecord]) -> Bool {
        guard let db else { return false }
        let sql = """
            INSERT INTO records(scope, kind, id, session_id, sequence, payload, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, kind, id) DO UPDATE SET
                session_id = excluded.session_id,
                sequence = excluded.sequence,
                payload = excluded.payload,
                updated_at = excluded.updated_at
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }

        let now = Int64(Date().timeIntervalSince1970)
        for rec in records {
            guard let data = try? encoder.encode(rec) else { continue }
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            sqlite3_bind_text(stmt, 1, scope, -1, sqliteTransient)
            sqlite3_bind_text(stmt, 2, rec.kind, -1, sqliteTransient)
            sqlite3_bind_text(stmt, 3, rec.id, -1, sqliteTransient)
            sqlite3_bind_text(stmt, 4, rec.sessionId ?? "", -1, sqliteTransient)
            sqlite3_bind_int64(stmt, 5, rec.sequence ?? 0)
            bindBlob(stmt, index: 6, data: data)
            sqlite3_bind_int64(stmt, 7, now)
            sqlite3_step(stmt)
        }
        return true
    }

    private func queryRecordsLocked(sql: String, bind: (OpaquePointer?) -> Void) -> [ArchiveRecord] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bind(stmt)

        var out: [ArchiveRecord] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let ptr = sqlite3_column_blob(stmt, 0) else { continue }
            let len = Int(sqlite3_column_bytes(stmt, 0))
            let data = Data(bytes: ptr, count: len)
            if let rec = try? decoder.decode(ArchiveRecord.self, from: data) {
                out.append(rec)
            }
        }
        return out
    }

    private func bindBlob(_ stmt: OpaquePointer?, index: Int32, data: Data) {
        if data.isEmpty {
            sqlite3_bind_blob(stmt, index, nil, 0, sqliteTransient)
        } else {
            data.withUnsafeBytes { buf in
                sqlite3_bind_blob(stmt, index, buf.baseAddress, Int32(buf.count), sqliteTransient)
            }
        }
    }
}
