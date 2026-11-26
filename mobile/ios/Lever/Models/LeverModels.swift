import Foundation

// MARK: - Core Status & Account

struct CoreStatus: Codable, Sendable, Equatable {
    let paired: Bool
    let direct: Bool?
    let hostName: String?
    let hostPlatform: String?
    let origin: String?
    let hubId: String?
    let spaceId: String?
    let deviceId: String?
    let userId: String?
    let pushEnabled: Bool?
}

struct RemoteIdentity: Codable, Sendable, Equatable {
    let id: String
    let publicKey: String?
}

struct SpaceInfo: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let kind: String
}

struct AccountInfo: Codable, Sendable, Equatable {
    let hub: RemoteIdentity
    let userId: String
    let spaces: [SpaceInfo]
    let deviceId: String?
    let origin: String?
}

struct DeviceInfo: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let spaceId: String
    let name: String
    let role: String
    let platform: String
    let online: Bool
    let draining: Bool
    let revoked: Bool
    let lastSeen: Int64
    let version: Int64
}

// MARK: - Archive Wire Contract (mirrors internal/remoteproto/types.go)

struct DirectoryGroup: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let state: String?
}

struct RunItem: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let kind: String
    let title: String?
    let text: String?
    let truncated: Bool?
}

struct FileStat: Codable, Sendable, Equatable, Hashable {
    let name: String
    let additions: Int
    let deletions: Int
}

struct RequestOption: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let allow: Bool?
}

struct RequestQuestion: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let text: String
    let multiple: Bool?
    let options: [RequestOption]?
}

struct RequestAnswer: Codable, Sendable, Equatable {
    let allow: Bool
    let optionId: String?
    let answers: [String: [String]]?
}

struct ArchiveRecord: Codable, Sendable, Equatable, Identifiable {
    let kind: String
    let id: String
    let privateFlag: Bool?
    let agentId: String?
    let chatId: String?
    let sessionId: String?
    let runId: String?
    let taskId: String?
    let dispatchId: String?
    let title: String?
    let status: String?
    let type: String?
    let model: String?
    let provider: String?
    let avatar: String?
    let description: String?
    let permission: String?
    let groups: [DirectoryGroup]?
    let text: String?
    let items: [RunItem]?
    let files: [FileStat]?
    let error: String?
    let truncated: Bool?
    let superseded: Bool?
    let canSteer: Bool?
    let queuePaused: Bool?
    let workingCopyId: String?
    let workingCopyName: String?
    let answeredByUserId: String?
    let unreadSequence: Int64?
    let readSequence: Int64?
    let preview: String?
    let messageAt: String?
    let activeStatus: String?
    let pendingCount: Int?
    let replyCount: Int?
    let sourceRunId: String?
    let sequence: Int64?
    let createdAt: String?
    let updatedAt: String?
    let questions: [RequestQuestion]?
    let options: [RequestOption]?
    let answer: RequestAnswer?
    let allowOnce: RequestAnswer?

    enum CodingKeys: String, CodingKey {
        case kind, id, agentId, chatId, sessionId, runId, taskId, dispatchId
        case title, status, type, model, provider, avatar, description, permission
        case groups, text, items, files, error, truncated, superseded, canSteer
        case queuePaused, workingCopyId, workingCopyName, answeredByUserId
        case unreadSequence, readSequence, preview, messageAt, activeStatus
        case pendingCount, replyCount, sourceRunId, sequence, createdAt, updatedAt
        case questions, options, answer, allowOnce
        case privateFlag = "private"
    }

    var isPrivate: Bool { privateFlag == true }
}

struct ArchiveChange: Codable, Sendable, Equatable {
    let record: ArchiveRecord
    let deleted: Bool

    enum CodingKeys: String, CodingKey {
        case deleted
    }

    init(record: ArchiveRecord, deleted: Bool = false) {
        self.record = record
        self.deleted = deleted
    }

    init(from decoder: Decoder) throws {
        self.record = try ArchiveRecord(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.deleted = try container.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    }

    func encode(to encoder: Encoder) throws {
        try record.encode(to: encoder)
        if deleted {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(true, forKey: .deleted)
        }
    }
}

struct ArchiveCursor: Codable, Sendable, Equatable {
    let epoch: String
    let version: Int64
    let stream: String
}

struct ArchivePage: Codable, Sendable, Equatable {
    let cursor: ArchiveCursor
    let full: Bool
    let changes: [ArchiveChange]
}

// MARK: - Commands, Receipts, Read Sync, Push & Tasks

struct CommandIntent: Codable, Sendable, Equatable {
    var privateFlag: Bool?
    var id: String
    var kind: String
    var deviceId: String
    var agentId: String?
    var workingCopyId: String?
    var chatId: String?
    var sessionId: String?
    var runId: String?
    var requestId: String?
    var operation: String?
    var delivery: String?
    var text: String?
    var answer: RequestAnswer?

    enum CodingKeys: String, CodingKey {
        case id, kind, deviceId, agentId, workingCopyId, chatId, sessionId
        case runId, requestId, operation, delivery, text, answer
        case privateFlag = "private"
    }
}

struct CommandReceipt: Codable, Sendable, Equatable {
    let id: String
    let status: String
    let chatId: String?
    let sessionId: String?
    let runId: String?
    let detail: String?
}

struct InboxItem: Codable, Sendable, Equatable {
    let intent: CommandIntent
    let receipt: CommandReceipt
}

struct ReadMark: Codable, Sendable, Equatable {
    let sessionId: String
    let sequence: Int64
}

struct ReadSyncRequest: Codable, Sendable, Equatable {
    let deviceId: String
    let items: [ReadMark]
}

struct PushSettings: Codable, Sendable, Equatable {
    let available: Bool
    let enabled: Bool
}

struct PushNotice: Codable, Sendable, Equatable {
    let hubId: String
    let spaceId: String
    let deviceId: String
    let chatId: String
    let sessionId: String?
    let runId: String?
    let requestId: String?
    let kind: String
}

struct SharedTask: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let title: String
    let body: String
    let project: String?
    let deviceId: String?
    let version: Int64
    let status: String
    let dispatchId: String?
}

// MARK: - UI Derived Models (Scheme 1: Feishu IM + Mixed Timeline + Topic Drawer)

enum FeedFilter: String, CaseIterable, Identifiable {
    case all = "全部"
    case approval = "待审批"
    case running = "运行中"
    case unread = "未读"

    var id: String { rawValue }
}

enum AppThemePreference: String, CaseIterable, Identifiable {
    case system = "system"
    case light = "light"
    case dark = "dark"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

struct ActiveTopicCue: Equatable, Identifiable {
    let id: String
    let chatId: String
    let isPrivate: Bool
    let title: String
    let status: String
    let pendingCount: Int
    let isUnread: Bool
    let replyCount: Int
    let preview: String
}

struct AgentFeedRow: Identifiable, Equatable {
    let id: String // "\(device.id):\(agentId)"
    let device: DeviceInfo
    let agentId: String
    let name: String
    let avatar: String?
    let model: String?
    let provider: String?
    let latestChat: ArchiveRecord?
    let chatCount: Int
    let unreadSessionCount: Int
    let pendingApprovalCount: Int
    let isRunning: Bool
    let sortTimestamp: TimeInterval
    let timeText: String
    let preview: String
    let isPrivate: Bool
    let activeTopicCue: ActiveTopicCue?
    let unreadSessionMarks: [ReadMark]
}

struct ChatRoute: Hashable, Identifiable {
    let deviceId: String
    let agentId: String
    let chatId: String?
    let isPrivate: Bool
    let initialTopicId: String?

    var id: String { "\(deviceId):\(agentId):\(chatId ?? "new"):\(isPrivate)" }
}

enum TimelineEntry: Identifiable, Equatable {
    case mainRun(ArchiveRecord, requests: [ArchiveRecord])
    case topicCard(TopicSummary)

    var id: String {
        switch self {
        case .mainRun(let run, _): return "run:\(run.id)"
        case .topicCard(let topic): return "topic:\(topic.id)"
        }
    }

    var sortDate: TimeInterval {
        switch self {
        case .mainRun(let run, _): return LeverDate.timestamp(run.createdAt)
        case .topicCard(let topic): return topic.anchorTimestamp
        }
    }
}

struct TopicSummary: Identifiable, Equatable {
    let id: String
    let chatId: String
    let title: String
    let rootPrompt: String
    let latestReplyText: String
    let latestReplyIsUser: Bool
    let pendingRequest: ArchiveRecord?
    let status: String // "approval" | "running" | "failed" | "done"
    let replyCount: Int
    let unreadSequence: Int64
    let isUnread: Bool
    let anchorTimestamp: TimeInterval
    let updatedTimestamp: TimeInterval
    let fileStats: [FileStat]
    let runs: [ArchiveRecord]
    let requestsByRun: [String: [ArchiveRecord]]
}

// MARK: - Formatting Helpers

enum LeverDate {
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let timeOnly: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()
    private static let monthDay: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "M/d"
        return f
    }()

    static func parse(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return isoFrac.date(from: raw) ?? isoPlain.date(from: raw)
    }

    static func timestamp(_ raw: String?) -> TimeInterval {
        parse(raw)?.timeIntervalSince1970 ?? 0
    }

    static func compact(_ raw: String?) -> String {
        guard let date = parse(raw) else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            return timeOnly.string(from: date)
        }
        if cal.isDateInYesterday(date) {
            return "昨天"
        }
        return monthDay.string(from: date)
    }
}

func isActiveRunStatus(_ status: String?) -> Bool {
    switch status {
    case "starting", "running", "waiting_user", "cancelling", "queued", "paused", "unknown":
        return true
    default:
        return false
    }
}

func runStatusLabel(_ status: String?) -> String {
    switch status {
    case "starting": return "启动中"
    case "running": return "运行中"
    case "waiting_user": return "等你审批"
    case "cancelling": return "停止中"
    case "queued": return "排队中"
    case "paused": return "已暂停"
    case "completed": return "已完成"
    case "failed": return "执行失败"
    case "interrupted", "cancelled": return "已停止"
    case "unknown": return "需确认"
    case "pending": return "等待确认"
    case "answered": return "已处理"
    default: return status ?? ""
    }
}
