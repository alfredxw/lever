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
    var directPeerIds: [String]? = nil
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
    var node: PeerNodeInfo? = nil
    let id: String
    let spaceId: String
    let name: String
    let role: String
    let platform: String
    let online: Bool
    let desktopActive: Bool?
    let draining: Bool
    let revoked: Bool
    let lastSeen: Int64
    let version: Int64

    var isDesktopActive: Bool {
        online && desktopActive == true
    }
}

// MARK: - Archive Wire Contract (mirrors internal/remoteproto/types.go)

struct AvatarSpec: Codable, Sendable, Equatable, Hashable {
    let kind: String // "preset" | "image" | "lucide" | "emoji" | "monogram"
    let value: String?
    let color: String?
}

struct ModelOption: Codable, Sendable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String?
    let description: String?
    let resolvedModel: String?
    let efforts: [String]?
    let defaultEffort: String?
    let fast: Bool?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return id
    }

    var subtitleText: String? {
        if let resolvedModel, !resolvedModel.isEmpty, resolvedModel.lowercased() != displayName.lowercased() {
            return resolvedModel
        }
        if let description, !description.isEmpty {
            return description
        }
        return nil
    }
}

struct ModelSelection: Codable, Sendable, Equatable, Hashable {
    var provider: String?
    var model: String?
    var effort: String?
    var fast: Bool?
    var permission: String?
}

struct AttachmentRef: Codable, Sendable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let mediaType: String?
    let size: Int64?

    var isImage: Bool {
        (mediaType ?? "").hasPrefix("image/")
    }
}

struct AttachmentUploadRequest: Codable, Sendable, Equatable {
    let chatId: String?
    let agentId: String?
    let name: String
    let data: String
}

struct MessageReference: Codable, Sendable, Equatable, Hashable, Identifiable {
    let kind: String // "topic" | "chat" | "agent" | "skill"
    let name: String
    let refId: String?
    let path: String?
    let provider: String?
    let description: String?
    let argumentHint: String?
    let start: Int?
    let end: Int?

    enum CodingKeys: String, CodingKey {
        case kind, name, path, provider, description, argumentHint, start, end
        case refId = "id"
    }

    var id: String {
        "\(kind):\(refId ?? path ?? name)"
    }
}

struct SlashCommandOption: Codable, Sendable, Equatable, Hashable, Identifiable {
    let name: String
    let description: String?
    let argumentHint: String?

    var id: String { name }
}

struct ProviderCatalog: Codable, Sendable, Equatable, Hashable, Identifiable {
    let id: String
    let name: String
    let type: String
    let pluginId: String?
    let models: [ModelOption]?
    let commands: [SlashCommandOption]?
}

struct ComposerMeta: Codable, Sendable, Equatable {
    let providers: [ProviderCatalog]
    let starredModels: [String: [String]]
    let skills: [MessageReference]
}

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

struct DiffSummary: Codable, Sendable, Equatable, Hashable {
    let files: Int?
    let additions: Int?
    let deletions: Int?
}

struct RequestOption: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let allow: Bool?
}

extension RequestOption {
    private enum WireKey: String, CodingKey { case id, name, label, allow }
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: WireKey.self)
        id = try fields.decode(String.self, forKey: .id)
        name = try fields.decodeIfPresent(String.self, forKey: .name) ?? fields.decode(String.self, forKey: .label)
        allow = try fields.decodeIfPresent(Bool.self, forKey: .allow)
    }
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
    var privateFlag: Bool?
    var agentId: String?
    var chatId: String?
    var sessionId: String?
    var runId: String?
    var taskId: String?
    var dispatchId: String?
    var title: String?
    var status: String?
    var type: String?
    var model: String?
    var effort: String?
    var fast: Bool?
    var provider: String?
    var models: [ModelOption]?
    var avatar: String?
    var avatarSpec: AvatarSpec?
    var description: String?
    var permission: String?
    var groups: [DirectoryGroup]?
    var attachments: [AttachmentRef]?
    var text: String?
    var items: [RunItem]?
    var stepCount: Int?
    var files: [FileStat]?
    var diff: DiffSummary?
    var error: String?
    var truncated: Bool?
    var superseded: Bool?
    var canSteer: Bool?
    var queuePaused: Bool?
    var workingCopyId: String?
    var workingCopyName: String?
    var answeredByUserId: String?
    var unreadSequence: Int64?
    var readSequence: Int64?
    var clearedSequence: Int64?
    var preview: String?
    var messageAt: String?
    var activeStatus: String?
    var pendingCount: Int?
    var replyCount: Int?
    var sourceRunId: String?
    var sequence: Int64?
    var createdAt: String?
    var updatedAt: String?
    var questions: [RequestQuestion]?
    var options: [RequestOption]?
    var answer: RequestAnswer?
    var allowOnce: RequestAnswer?

    enum CodingKeys: String, CodingKey {
        case kind, id, agentId, chatId, sessionId, runId, taskId, dispatchId
        case title, status, type, model, effort, fast, provider, models, avatar, avatarSpec, description, permission
        case groups, attachments, text, items, stepCount, files, diff, error, truncated, superseded, canSteer
        case queuePaused, workingCopyId, workingCopyName, answeredByUserId
        case unreadSequence, readSequence, clearedSequence, preview, messageAt, activeStatus
        case pendingCount, replyCount, sourceRunId, sequence, createdAt, updatedAt
        case questions, options, answer, allowOnce
        case privateFlag = "private"
    }

    var isPrivate: Bool { privateFlag == true }

    /// Simplified aggregate file diff (+additions / -deletions), preferring backend `diff`
    /// and seamlessly falling back to aggregating legacy per-file `files`.
    var resolvedDiff: (files: Int, additions: Int, deletions: Int)? {
        if let d = diff {
            let f = d.files ?? 0
            let a = d.additions ?? 0
            let del = d.deletions ?? 0
            if f > 0 || a > 0 || del > 0 {
                return (f, a, del)
            }
        }
        if let list = files, !list.isEmpty {
            var a = 0
            var del = 0
            for item in list {
                a += item.additions
                del += item.deletions
            }
            if a > 0 || del > 0 || !list.isEmpty {
                return (list.count, a, del)
            }
        }
        return nil
    }
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

struct AvatarImageResponse: Codable, Sendable, Equatable {
    let mediaType: String
    let data: String
}

// MARK: - Commands, Receipts, Read/Clear Sync, Push & Tasks

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
    var selection: ModelSelection?
    var attachmentIds: [String]?
    var references: [MessageReference]?
    var answer: RequestAnswer?

    enum CodingKeys: String, CodingKey {
        case id, kind, deviceId, agentId, workingCopyId, chatId, sessionId
        case runId, requestId, operation, delivery, text, selection, attachmentIds, references, answer
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

struct ClearMark: Codable, Sendable, Equatable {
    let sessionId: String
    let sequence: Int64
}

struct ClearSyncRequest: Codable, Sendable, Equatable {
    let deviceId: String
    let items: [ClearMark]
}

struct PushSettings: Codable, Sendable, Equatable {
    let available: Bool
    let enabled: Bool
    let silenceWhenDesktopActive: Bool?
}

struct PushPreferencesRequest: Codable, Sendable, Equatable {
    let silenceWhenDesktopActive: Bool
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

// MARK: - UI Navigation & Derived View Models

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
    let status: String // "approval" | "running" | "unread" | "idle"
    let pendingCount: Int
    let isUnread: Bool
    let unreadSequence: Int64
    let canClear: Bool
    let replyCount: Int
    let preview: String
    let updatedText: String
}

struct AgentFeedRow: Identifiable, Equatable {
    let id: String // "\(device.id):\(agentId)"
    let device: DeviceInfo
    let agentId: String
    let name: String
    let avatar: String?
    let avatarSpec: AvatarSpec?
    let model: String?
    let provider: String?
    let models: [ModelOption]
    let latestChat: ArchiveRecord?
    let chatCount: Int
    let unreadSessionCount: Int
    let pendingApprovalCount: Int
    let isRunning: Bool
    let sortTimestamp: TimeInterval
    let timeText: String
    let preview: String
    let isPrivate: Bool
    let activeTopics: [ActiveTopicCue]
    let unreadSessionMarks: [ReadMark]
}

struct AgentDrawerTopicItem: Identifiable, Equatable {
    let id: String // sessionId
    let chatId: String
    let chatTitle: String
    let isPrivate: Bool
    let title: String
    let preview: String
    let status: String // "approval" | "running" | "unread" | "idle"
    let isUnread: Bool
    let isCleared: Bool
    let canClear: Bool
    let unreadSequence: Int64
    let replyCount: Int
    let sortTimestamp: TimeInterval
    let timeText: String
}

struct AgentDrawerChatItem: Identifiable, Equatable {
    let id: String // chatId
    let restoreSessionIds: [String]
    let isPrivate: Bool
    let title: String
    let preview: String
    let topicCount: Int
    let unreadCount: Int
    let isRunning: Bool
    let pendingCount: Int
    let isCleared: Bool
    let canClear: Bool
    let clearMarks: [ClearMark]
    let clearReadMarks: [ReadMark]
    let sortTimestamp: TimeInterval
    let timeText: String
}

struct AgentDrawerData: Equatable {
    let activeTopics: [AgentDrawerTopicItem]
    let activeChats: [AgentDrawerChatItem]
    let clearedTopics: [AgentDrawerTopicItem]
    let clearedChats: [AgentDrawerChatItem]

    var clearedTotalCount: Int {
        clearedTopics.count + clearedChats.count
    }
}

struct GlobalSearchHit: Identifiable, Equatable {
    enum Kind: String {
        case agent = "Agent"
        case chat = "对话"
        case topic = "话题"
    }
    let id: String
    let kind: Kind
    let deviceId: String
    let agentId: String
    let agentName: String
    let avatar: String?
    let avatarSpec: AvatarSpec?
    let chatId: String?
    let topicId: String?
    let isPrivate: Bool
    let title: String
    let subtitle: String
    let timeText: String
}

struct ChatRoute: Hashable, Identifiable {
    let deviceId: String
    let agentId: String
    let chatId: String?
    let isPrivate: Bool
    let initialTopicId: String?

    var id: String { "\(deviceId):\(agentId):\(chatId ?? "new"):\(isPrivate)" }
}

struct TopicRoute: Hashable, Identifiable {
    let deviceId: String
    let agentId: String
    let chatId: String
    let isPrivate: Bool
    let topicId: String

    var id: String { "\(deviceId):\(chatId):\(topicId)" }
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

struct TopicPreviewLine: Identifiable, Equatable {
    let id: String
    let isUser: Bool
    let text: String
}

struct TopicSummary: Identifiable, Equatable {
    let id: String
    let chatId: String
    let title: String
    let rootPrompt: String
    let latestReplyText: String
    let latestReplyIsUser: Bool
    let previewLines: [TopicPreviewLine]
    let pendingRequest: ArchiveRecord?
    let status: String // "approval" | "running" | "failed" | "done"
    let model: String?
    let effort: String?
    let fast: Bool
    let provider: String?
    let replyCount: Int
    let unreadSequence: Int64
    let isUnread: Bool
    let isCleared: Bool
    let canClear: Bool
    let anchorTimestamp: TimeInterval
    let updatedTimestamp: TimeInterval
    let runs: [ArchiveRecord]
    let requestsByRun: [String: [ArchiveRecord]]
    let oldestRunSequence: Int64?
}

struct TimelineSnapshot: Equatable {
    let entries: [TimelineEntry]
    let topics: [TopicSummary]
    let mainSession: ArchiveRecord?
    let mainHasQueuedRuns: Bool
    let mainProvider: String?
    let mainModel: String?
    let mainEffort: String?
    let mainFast: Bool
    let oldestMainSequence: Int64?

    static let empty = TimelineSnapshot(
        entries: [],
        topics: [],
        mainSession: nil,
        mainHasQueuedRuns: false,
        mainProvider: nil,
        mainModel: nil,
        mainEffort: nil,
        mainFast: false,
        oldestMainSequence: nil
    )
}

func formatByteSize(_ bytes: Int64?) -> String {
    guard let bytes, bytes > 0 else { return "" }
    if bytes < 1024 { return "\(bytes) B" }
    let kb = Double(bytes) / 1024.0
    if kb < 1024 { return String(format: "%.0f KB", kb) }
    return String(format: "%.1f MB", kb / 1024.0)
}

// MARK: - Formatting Helpers (Cached to Eliminate ISO8601DateFormatter Overhead)

enum LeverDate {
    private static let lock = NSLock()
    private static let tsCache = NSCache<NSString, NSNumber>()
    private static let compactCache = NSCache<NSString, NSString>()

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
        let ts = timestamp(raw)
        return ts > 0 ? Date(timeIntervalSince1970: ts) : nil
    }

    static func timestamp(_ raw: String?) -> TimeInterval {
        guard let raw, !raw.isEmpty else { return 0 }
        let key = raw as NSString
        if let hit = tsCache.object(forKey: key) {
            return hit.doubleValue
        }
        lock.lock()
        let parsed = isoFrac.date(from: raw) ?? isoPlain.date(from: raw)
        lock.unlock()
        let value = parsed?.timeIntervalSince1970 ?? 0
        tsCache.setObject(NSNumber(value: value), forKey: key)
        return value
    }

    static func compact(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        let key = raw as NSString
        if let hit = compactCache.object(forKey: key) {
            return hit as String
        }
        guard let date = parse(raw) else { return "" }
        let cal = Calendar.current
        let result: String
        lock.lock()
        if cal.isDateInToday(date) {
            result = timeOnly.string(from: date)
        } else if cal.isDateInYesterday(date) {
            result = "昨天"
        } else {
            result = monthDay.string(from: date)
        }
        lock.unlock()
        compactCache.setObject(result as NSString, forKey: key)
        return result
    }
}

func formatEffortLabel(_ raw: String) -> String {
    switch raw.lowercased() {
    case "low": return "Low"
    case "medium": return "Medium"
    case "high": return "High"
    case "xhigh": return "XHigh"
    case "max": return "Max"
    default: return raw.capitalized
    }
}

func stripMarkdownPreview(_ raw: String) -> String {
    raw
        .replacingOccurrences(of: "\r\n", with: "\n")
        .components(separatedBy: "\n")
        .map { line in
            var s = line.trimmingCharacters(in: .whitespaces)
            while s.hasPrefix("#") || s.hasPrefix(">") || s.hasPrefix("-") || s.hasPrefix("*") {
                s.removeFirst()
                s = s.trimmingCharacters(in: .whitespaces)
            }
            return s
        }
        .filter { !$0.isEmpty && !$0.hasPrefix("```") }
        .joined(separator: " ")
        .replacingOccurrences(of: "**", with: "")
        .replacingOccurrences(of: "`", with: "")
}

func isActiveRunStatus(_ status: String?) -> Bool {
    switch status {
    case "starting", "running", "waiting_user", "cancelling", "unknown":
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

// Native Owner responses are decoded directly. Older paired devices keep their
// archive decoder. Both feed the same SwiftUI presentation types.
struct PeerNodeInfo: Codable, Sendable, Equatable {
    let protocolVersion: Int
    let minCompatibleProtocol: Int
    let features: [String]
    let accessLevel: String
    let cacheEpoch: String?
    var supportsChat: Bool { minCompatibleProtocol <= 1 && protocolVersion >= 1 && features.contains("peer_v1") }
}

struct PeerIndex: Decodable {
    struct Agent: Decodable {
        struct Profile: Decodable { let description, provider, model, permission: String? }
        let id, name: String
        let avatar: AvatarSpec?
        let profile: Profile
        var record: ArchiveRecord {
            var r = ArchiveRecord(kind: "agent", id: id)
            r.title = name; r.avatarSpec = avatar; r.description = profile.description
            r.provider = profile.provider; r.model = profile.model; r.permission = profile.permission
            return r
        }
    }
    struct Chat: Decodable {
        let id, agentId, title: String
        let createdAt, updatedAt: String?
        var record: ArchiveRecord {
            ArchiveRecord(kind: "chat", id: id, agentId: agentId, title: title, createdAt: createdAt, updatedAt: updatedAt)
        }
    }
    struct Session: Decodable {
        let id, chatId, agentId, kind: String
        let title, preview, messageAt, sourceRunId, workingCopyId, workingCopyName: String?
        let unreadSequence, readSequence, clearedSequence: Int64?
        var record: ArchiveRecord {
            var r = ArchiveRecord(kind: "session", id: id, agentId: agentId, chatId: chatId, title: title, type: kind)
            r.preview = preview; r.messageAt = messageAt; r.sourceRunId = sourceRunId
            r.workingCopyId = workingCopyId; r.workingCopyName = workingCopyName
            r.unreadSequence = unreadSequence; r.readSequence = readSequence; r.clearedSequence = clearedSequence
            return r
        }
    }
    let agents: [Agent]?
    let chats: [Chat]?
    let conversations: [Session]?
    var records: [ArchiveRecord] {
        (agents ?? []).map(\.record) + (chats ?? []).map(\.record) + (conversations ?? []).map(\.record)
    }
}

struct PeerHistory: Decodable {
    struct Run: Decodable {
        let id, sessionId, chatId, input, status: String
        let error, createdAt, updatedAt: String?
        let sequence, unreadSequence: Int64?
        let attachments: [AttachmentRef]?
        let items: [RunItem]?
        let stepCount: Int?
        let selection: ModelSelection?
        var record: ArchiveRecord {
            var r = ArchiveRecord(kind: "run", id: id, chatId: chatId, sessionId: sessionId, status: status)
            r.text = input; r.items = items; r.stepCount = stepCount; r.sequence = sequence; r.unreadSequence = unreadSequence
            r.attachments = attachments; r.error = error; r.createdAt = createdAt; r.updatedAt = updatedAt
            r.provider = selection?.provider; r.model = selection?.model; r.effort = selection?.effort; r.fast = selection?.fast
            return r
        }
    }
    struct RunEnvelope: Decodable {
        let run: Run
    }
    struct Request: Decodable {
        let id, sessionId, chatId, runId, kind, status, title: String
        let detail: String?
        let options: [RequestOption]?
        let questions: [RequestQuestion]?
        let answer, allowOnce: RequestAnswer?
        var record: ArchiveRecord {
            ArchiveRecord(kind: "request", id: id, chatId: chatId, sessionId: sessionId, runId: runId, title: title,
                          status: status, type: kind, text: detail, questions: questions, options: options, answer: answer, allowOnce: allowOnce)
        }
    }
    let chat: PeerIndex.Chat?
    let sessions: [PeerIndex.Session]?
    let runs: [Run]?
    let requests: [Request]?
    var records: [ArchiveRecord] {
        let turns = (runs ?? []).map(\.record)
        let prompts = (requests ?? []).map(\.record)
        return [chat?.record].compactMap { $0 } + (sessions ?? []).map(\.record) + turns + prompts
    }
}

struct PeerCommandBody: Encodable {
    var intent: CommandIntent
    enum Keys: String, CodingKey { case commandId }
    func encode(to encoder: Encoder) throws {
        if intent.kind == "send" { try intent.encode(to: encoder) } else { try intent.answer?.encode(to: encoder) }
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(intent.id, forKey: .commandId)
    }
}
