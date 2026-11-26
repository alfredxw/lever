import Foundation
import Security

/// Thread-safe iOS Keychain store scoped to Lever's private application keychain.
final class KeychainStore: @unchecked Sendable {
    static let shared = KeychainStore()

    private let service = "app.lever.mobile.credentials"
    private let lock = NSLock()
    #if targetEnvironment(simulator)
    private let simFallbackURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("lever-sim-keychain.json")
    }()
    #endif

    private init() {}

    func get(_ key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }

        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            return loadSimFallback()[key]
        }
        #endif
        return nil
    }

    @discardableResult
    func set(_ key: String, value: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard let data = value.data(using: .utf8) else { return false }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        var addQuery = query
        for (k, v) in attributes {
            addQuery[k] = v
        }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return true
        }
        #if targetEnvironment(simulator)
        if addStatus == errSecMissingEntitlement {
            var map = loadSimFallback()
            map[key] = value
            return saveSimFallback(map)
        }
        #endif
        return false
    }

    @discardableResult
    func delete(_ key: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            return true
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            var map = loadSimFallback()
            map.removeValue(forKey: key)
            return saveSimFallback(map)
        }
        #endif
        return false
    }

    #if targetEnvironment(simulator)
    private func loadSimFallback() -> [String: String] {
        guard let data = try? Data(contentsOf: simFallbackURL),
              let map = try? JSONDecoder().decode([String: String].self, from: data) else {
            return [:]
        }
        return map
    }

    private func saveSimFallback(_ map: [String: String]) -> Bool {
        guard let data = try? JSONEncoder().encode(map) else { return false }
        do {
            try data.write(to: simFallbackURL, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: simFallbackURL.path)
            return true
        } catch {
            return false
        }
    }
    #endif
}
