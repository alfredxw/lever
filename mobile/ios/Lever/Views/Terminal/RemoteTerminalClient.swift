import Foundation
import Observation
import SwiftTerm

@MainActor @Observable
final class RemoteTerminalClient {
    var status = "正在连接"
    var finished = false
    @ObservationIgnored weak var view: TerminalView?
    @ObservationIgnored private let terminalId = UUID().uuidString
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var output: AsyncStream<URLSessionWebSocketTask.Message>.Continuation?
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var size = (cols: 80, rows: 24)

    struct Request: Encodable {
        let node, agent, sessionId, terminalId: String
        let cols, rows: Int
    }
    private struct Control: Decodable { let type: String; let cols, rows, code: Int?; let message: String? }

    func connect(device: String, agent: String, session: String?) async {
        finished = false
        ready = false
        status = "正在连接"
        let request = Request(node: device, agent: agent, sessionId: session ?? "", terminalId: terminalId, cols: size.cols, rows: size.rows)
        do {
            let location: String = try await LeverBridge.shared.request("POST", path: "/native/terminal", body: request)
            guard let url = URL(string: location), url.scheme == "ws", url.host == "127.0.0.1", let port = url.port else { throw LeverCoreError.invalidResponse }
            defer {
                Task { try? await LeverBridge.shared.requestVoid("POST", path: "/native/terminal/close", body: ["host":"127.0.0.1:\(port)"]) }
            }
            try Task.checkCancellation()
            let ws = URLSession.shared.webSocketTask(with: url)
            let (stream, continuation) = AsyncStream<URLSessionWebSocketTask.Message>.makeStream(bufferingPolicy: .bufferingOldest(64))
            socket = ws
            output = continuation
            ws.resume()
            let writer = Task {
                do { for await frame in stream { try await ws.send(frame) } }
                catch { ws.cancel(with: .goingAway, reason: nil) }
            }
            defer {
                continuation.finish()
                writer.cancel()
                ws.cancel(with: .goingAway, reason: nil)
                if socket === ws { socket = nil; output = nil; ready = false }
            }
            try await withTaskCancellationHandler {
                while !Task.isCancelled {
                    switch try await ws.receive() {
                    case .data(let bytes):
                        guard let view else { return }
                        view.feed(byteArray: Array(bytes)[...])
                        try await ws.send(.string(#"{"type":"ack"}"#))
                    case .string(let json):
                        let control = try JSONDecoder().decode(Control.self, from: Data(json.utf8))
                        switch control.type {
                        case "replay", "size":
                            if control.type == "replay" { view?.resetToInitialState() }
                            if let cols = control.cols, let rows = control.rows { view?.resize(cols: cols, rows: rows) }
                        case "ready":
                            ready = true; status = "已连接"
                            view?.resize(cols: size.cols, rows: size.rows)
                            resize(cols: size.cols, rows: size.rows)
                        case "exit": status = "终端已退出（\(control.code ?? 0)）"; finished = true; return
                        case "ended", "busy", "error":
                            status = control.message ?? (control.type == "busy" ? "终端已被占用" : "终端已关闭")
                            finished = true
                            return
                        default: continue
                        }
                    @unknown default: continue
                    }
                }
            } onCancel: { ws.cancel(with: .goingAway, reason: nil) }
        } catch {
            if !Task.isCancelled { status = error.localizedDescription; finished = true }
        }
    }

    func input(_ data: Data) { if ready { enqueue(.data(data)) } }

    func resize(cols: Int, rows: Int) {
        guard (2...500).contains(cols), (1...300).contains(rows) else { return }
        size = (cols, rows)
        if ready { enqueue(.string("{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}")) }
    }

    private func enqueue(_ frame: URLSessionWebSocketTask.Message) {
        if case .dropped = output?.yield(frame) {
            socket?.cancel(with: .goingAway, reason: nil)
        }
    }
}
