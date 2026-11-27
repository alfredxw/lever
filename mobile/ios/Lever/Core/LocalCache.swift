import Foundation

/// Off-main-thread disk cache under Application Support so opening Lever Mobile
/// shows cached devices, conversations, and local cursors instantly with zero UI hitching.
final class LocalCache: @unchecked Sendable {
    static let shared = LocalCache()

    private let fm = FileManager.default
    private let baseURL: URL
    private let queue = DispatchQueue(label: "app.lever.mobile.cache", qos: .utility)

    private init() {
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let dir = support.appendingPathComponent("LeverCache", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        baseURL = dir
    }

    func load<T: Decodable>(_ name: String, as type: T.Type = T.self) -> T? {
        queue.sync {
            let url = fileURL(for: name)
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }
    }

    func loadAsync<T: Decodable & Sendable>(_ name: String, as type: T.Type = T.self) async -> T? {
        await withCheckedContinuation { continuation in
            queue.async { [baseURL] in
                let url = baseURL.appendingPathComponent(Self.sanitize(name) + ".json")
                guard let data = try? Data(contentsOf: url),
                      let decoded = try? JSONDecoder().decode(T.self, from: data) else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: decoded)
            }
        }
    }

    func save<T: Encodable & Sendable>(_ value: T, as name: String) {
        queue.async { [baseURL] in
            guard let data = try? JSONEncoder().encode(value) else { return }
            let safe = Self.sanitize(name)
            let url = baseURL.appendingPathComponent(safe + ".json")
            try? data.write(to: url, options: .atomic)
        }
    }

    func clearAll() {
        queue.sync {
            if let files = try? fm.contentsOfDirectory(at: baseURL, includingPropertiesForKeys: nil) {
                for url in files {
                    try? fm.removeItem(at: url)
                }
            }
        }
    }

    private func fileURL(for name: String) -> URL {
        baseURL.appendingPathComponent(Self.sanitize(name) + ".json")
    }

    private static func sanitize(_ name: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return name.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }.reduce(into: "") { $0.append($1) }
    }
}
