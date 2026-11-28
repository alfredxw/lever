import Foundation
import GRDB
import OSLog

enum LegacyCacheMigrator {
    struct Archive: Decodable { let cursor: ArchiveCursor?; let records: [ArchiveRecord] }

    static func migrate(_ directory: URL, into pool: DatabasePool) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: directory.path) else { return }
        let files = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        let metadata = ["account","devices","read_cursors","cleared_cursors","hub_read_cursors","hub_cleared_cursors","providers_by_device","starred_models"]
        // A failed import keeps its original file. Only committed files may be removed.
        let imported = try pool.write { db in
            var consumed: [URL] = []
            for file in files {
                let key = file.deletingPathExtension().lastPathComponent
                if key.hasPrefix("avatar_") { consumed.append(file); continue }
                guard metadata.contains(key), let data = try? Data(contentsOf: file),
                      (try? JSONSerialization.jsonObject(with: data)) != nil else { continue }
                try db.execute(sql: "INSERT OR IGNORE INTO kv VALUES(?,?,unixepoch())", arguments: [key,data])
                consumed.append(file)
            }
            let data = try Data.fetchOne(db, sql: "SELECT payload FROM kv WHERE key='devices'")
            let devices = data.flatMap { try? JSONDecoder().decode([DeviceInfo].self, from: $0) } ?? []
            for file in files {
                let name = file.deletingPathExtension().lastPathComponent
                guard let scope = scope(for: name, devices: devices) else { continue }
                if try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM records WHERE scope=?)", arguments: [scope]) == true {
                    consumed.append(file)
                    continue
                }
                guard let data = try? Data(contentsOf: file) else { continue }
                do {
                    if scope.hasPrefix("priv:") {
                        try AppDatabase.insert(db, scope: scope, records: JSONDecoder().decode([ArchiveRecord].self, from: data))
                    } else {
                        let archive = try JSONDecoder().decode(Archive.self, from: data)
                        try AppDatabase.insert(db, scope: scope, records: archive.records)
                        if let cursor = archive.cursor, let colon = scope.firstIndex(of: ":") {
                            let key = scope[..<colon] + "_cursor" + scope[colon...]
                            try db.execute(sql: "INSERT OR IGNORE INTO kv VALUES(?,?,unixepoch())",
                                           arguments: [String(key), try JSONEncoder().encode(cursor)])
                        }
                    }
                    consumed.append(file)
                } catch is DecodingError {
                    Logger(subsystem: "app.lever.mobile", category: "database").warning("Kept an unreadable legacy archive")
                }
            }
            return consumed
        }
        for file in imported { try? fm.removeItem(at: file) }
        if (try? fm.contentsOfDirectory(atPath: directory.path).isEmpty) == true { try? fm.removeItem(at: directory) }
    }

    private static func scope(for name: String, devices: [DeviceInfo]) -> String? {
        guard let prefix = ["index_", "priv_", "chat_"].first(where: { name.hasPrefix($0) }) else { return nil }
        let key = String(name.dropFirst(prefix.count))
        if prefix != "chat_" { return String(prefix.dropLast()) + ":" + key }
        guard let device = devices.first(where: { key.hasPrefix($0.id + "_") }),
              let privacy = key.last, "01".contains(privacy), key.hasSuffix("_" + String(privacy)) else { return nil }
        let chat = key.dropFirst(device.id.count + 1).dropLast(2)
        return "chat:\(device.id)|\(chat)|\(privacy)"
    }
}
