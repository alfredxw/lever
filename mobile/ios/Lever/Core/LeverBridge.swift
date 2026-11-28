import Foundation
import LeverCore

enum LeverCoreError: LocalizedError {
    case message(String)
    case http(Int, String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .http(_, let msg), .message(let msg): return msg
        case .invalidResponse: return "无效的内部响应格式"
        }
    }
}

struct CoreEvent: Sendable {
    let kind: String
    let payload: String
}

private struct Envelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: String?
    let status: Int?
}

private struct RawEnvelope: Decodable {
    let ok: Bool
    let error: String?
    let status: Int?
}

/// Async Swift bridge around LeverCore.xcframework (Go transport, signing, LAN/Hub routing).
final class LeverBridge: @unchecked Sendable {
    static let shared = LeverBridge()

    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<CoreEvent>.Continuation] = [:]
    private var initialized = false
    private var credentialRevision = 0

    func invalidateRequests() { lock.withLock { credentialRevision &+= 1 } }

    private init() {}

    func start() {
        lock.lock()
        let already = initialized
        initialized = true
        lock.unlock()
        guard !already else { return }

        let getFn: lever_secret_get_fn = { keyPtr in
            guard let keyPtr else { return nil }
            let key = String(cString: keyPtr)
            guard let value = KeychainStore.shared.get(key) else { return nil }
            return strdup(value)
        }
        let setFn: lever_secret_set_fn = { keyPtr, valPtr in
            guard let keyPtr, let valPtr else { return -1 }
            let ok = KeychainStore.shared.set(String(cString: keyPtr), value: String(cString: valPtr))
            return ok ? 0 : -1
        }
        let delFn: lever_secret_del_fn = { keyPtr in
            guard let keyPtr else { return -1 }
            return KeychainStore.shared.delete(String(cString: keyPtr)) ? 0 : -1
        }
        let eventFn: lever_event_fn = { kindPtr, payloadPtr in
            let kind = kindPtr.map { String(cString: $0) } ?? ""
            let payload = payloadPtr.map { String(cString: $0) } ?? ""
            LeverBridge.shared.broadcast(CoreEvent(kind: kind, payload: payload))
        }
        let freeFn: lever_free_fn = { ptr in
            if let ptr { free(ptr) }
        }

        LeverCore_Init(getFn, setFn, delFn, eventFn, freeFn)
    }

    func events() -> AsyncStream<CoreEvent> {
        let id = UUID()
        return AsyncStream { continuation in
            lock.lock()
            continuations[id] = continuation
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                self?.removeContinuation(id)
            }
        }
    }

    private func removeContinuation(_ id: UUID) {
        lock.lock()
        continuations.removeValue(forKey: id)
        lock.unlock()
    }

    private func broadcast(_ event: CoreEvent) {
        lock.lock()
        let active = Array(continuations.values)
        lock.unlock()
        for c in active {
            c.yield(event)
        }
    }

    func isValidPairLink(_ link: String) -> Bool {
        withMutableCString(link) { cLink in
            LeverCore_ValidPairLink(cLink) == 1
        }
    }

    func status() async throws -> CoreStatus {
        try await runBlocking {
            let ptr = LeverCore_Status()
            return try self.decodeEnvelope(ptr, as: CoreStatus.self)
        }
    }

    func pair(link: String, deviceName: String) async throws {
        try await runBlocking {
            let ptr = self.withMutableCString(link) { cLink in
                self.withMutableCString(deviceName) { cName in
                    LeverCore_Pair(cLink, cName)
                }
            }
            _ = try self.decodeEnvelope(ptr, as: Bool.self)
        }
    }

    func unpair() async throws {
        try await runBlocking {
            let ptr = LeverCore_Unpair()
            _ = try self.decodeEnvelope(ptr, as: Bool.self)
        }
    }

    func request<T: Decodable>(_ method: String, path: String, body: Encodable? = nil, as type: T.Type = T.self) async throws -> T {
        let bodyString: String
        if let body {
            let data = try JSONEncoder().encode(AnyEncodable(body))
            bodyString = String(data: data, encoding: .utf8) ?? ""
        } else {
            bodyString = ""
        }
        return try await runBlocking {
            let ptr = self.withMutableCString(method) { cMethod in
                self.withMutableCString(path) { cPath in
                    self.withMutableCString(bodyString) { cBody in
                        LeverCore_Request(cMethod, cPath, cBody)
                    }
                }
            }
            return try self.decodeEnvelope(ptr, as: T.self)
        }
    }

    func fetchBinary(_ path: String) async throws -> Data {
        try await runBlocking {
            guard let pointer = self.withMutableCString(path, { LeverCore_FetchBinary($0) }) else { throw LeverCoreError.invalidResponse }
            let result = pointer.pointee
            defer { LeverCore_FreeBinary(pointer) }
            if let error = result.error { throw LeverCoreError.http(Int(result.status), String(cString: error)) }
            guard result.length > 0 else { return Data() }
            guard let bytes = result.data else { throw LeverCoreError.invalidResponse }
            return Data(bytes: bytes, count: Int(result.length))
        }
    }

    func requestVoid(_ method: String, path: String, body: Encodable? = nil) async throws {
        let bodyString: String
        if let body {
            let data = try JSONEncoder().encode(AnyEncodable(body))
            bodyString = String(data: data, encoding: .utf8) ?? ""
        } else {
            bodyString = ""
        }
        try await runBlocking {
            let ptr = self.withMutableCString(method) { cMethod in
                self.withMutableCString(path) { cPath in
                    self.withMutableCString(bodyString) { cBody in
                        LeverCore_Request(cMethod, cPath, cBody)
                    }
                }
            }
            try self.validateEnvelope(ptr)
        }
    }

    func watch(_ active: Bool) async {
        _ = try? await runBlocking {
            let ptr = LeverCore_Watch(active ? 1 : 0)
            try self.validateEnvelope(ptr)
        }
    }

    func networkChanged() {
        DispatchQueue.global(qos: .utility).async {
            LeverCore_NetworkChanged()
        }
    }

    func registerPushToken(_ token: String) async throws {
        try await runBlocking {
            let ptr = self.withMutableCString(token) { cToken in
                LeverCore_RegisterPushToken(cToken)
            }
            _ = try self.decodeEnvelope(ptr, as: Bool.self)
        }
    }

    func disablePush() async throws {
        try await runBlocking {
            let ptr = LeverCore_DisablePush()
            _ = try self.decodeEnvelope(ptr, as: Bool.self)
        }
    }

    func openPush(payload: String) async throws -> PushNotice {
        try await runBlocking {
            let ptr = self.withMutableCString(payload) { cPayload in
                LeverCore_OpenPush(cPayload)
            }
            return try self.decodeEnvelope(ptr, as: PushNotice.self)
        }
    }

    private func runBlocking<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        let revision = lock.withLock { credentialRevision }
        let value = try await Task.detached(priority: .userInitiated) { try work() }.value
        try Task.checkCancellation()
        guard lock.withLock({ revision == credentialRevision }) else { throw CancellationError() }
        return value
    }

    private func withMutableCString<R>(_ string: String, _ body: (UnsafeMutablePointer<CChar>?) -> R) -> R {
        guard let dup = strdup(string) else { return body(nil) }
        defer { free(dup) }
        return body(dup)
    }

    private func decodeEnvelope<T: Decodable>(_ ptr: UnsafeMutablePointer<CChar>?, as type: T.Type) throws -> T {
        guard let ptr else { throw LeverCoreError.invalidResponse }
        defer { LeverCore_Free(ptr) }
        let raw = String(cString: ptr)
        guard let data = raw.data(using: .utf8) else { throw LeverCoreError.invalidResponse }
        let env = try JSONDecoder().decode(Envelope<T>.self, from: data)
        if !env.ok {
            if let status = env.status { throw LeverCoreError.http(status, env.error ?? "操作失败") }
            throw LeverCoreError.message(env.error ?? "操作失败")
        }
        guard let value = env.data else {
            throw LeverCoreError.invalidResponse
        }
        return value
    }

    private func validateEnvelope(_ ptr: UnsafeMutablePointer<CChar>?) throws {
        guard let ptr else { throw LeverCoreError.invalidResponse }
        defer { LeverCore_Free(ptr) }
        let raw = String(cString: ptr)
        guard let data = raw.data(using: .utf8) else { throw LeverCoreError.invalidResponse }
        let env = try JSONDecoder().decode(RawEnvelope.self, from: data)
        if !env.ok {
            if let status = env.status { throw LeverCoreError.http(status, env.error ?? "操作失败") }
            throw LeverCoreError.message(env.error ?? "操作失败")
        }
    }
}

private struct AnyEncodable: Encodable {
    private let encodeImpl: (Encoder) throws -> Void

    init(_ wrapped: Encodable) {
        self.encodeImpl = wrapped.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeImpl(encoder)
    }
}
