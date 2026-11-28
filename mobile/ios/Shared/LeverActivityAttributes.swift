import ActivityKit
import Foundation

struct LeverActivityAttributes: ActivityAttributes, Hashable {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable { case running, waitingUser, completed, failed }
        let phase: Phase
        let stepCount, pendingCount: Int
        var label: String {
            switch phase {
            case .running: "运行中"
            case .waitingUser: "等待你处理"
            case .completed: "已完成"
            case .failed: "执行已停止"
            }
        }
        var ended: Bool { phase == .completed || phase == .failed }
    }

    let space, node, agent, chat, session, run: String
    let isTopic: Bool
    let started: Date
    var destination: URL? {
        var link = URLComponents()
        link.scheme = "leverdevice"; link.host = "open"
        link.queryItems = [URLQueryItem(name: "space", value: space), URLQueryItem(name: "device", value: node),
                           URLQueryItem(name: "agent", value: agent), URLQueryItem(name: "chat", value: chat)]
        if isTopic { link.queryItems?.append(URLQueryItem(name: "topic", value: session)) }
        return link.url
    }
}
