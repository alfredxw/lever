import Foundation
import Observation
import SwiftUI
import UIKit
import UserNotifications

enum SendTargetMode: Equatable {
    case main
    case newTopic
    case topicReply(String)
}

private struct CachedArchiveState: Codable {
    var cursor: ArchiveCursor?
    var records: [ArchiveRecord]
}

/// Central @Observable state store for Lever iOS:
/// - Manages pairing, incremental LAN/Hub archive sync, disk cache, and adaptive live polling
/// - Keeps Desktop <-> Mobile read cursors synchronized monotonically
/// - Projects Scheme 1 Feishu IM feed rows and mixed main+Topic timelines
@Observable
@MainActor
final class LeverStore {
    // Pairing & connection state
    var coreStatus: CoreStatus = CoreStatus(
        paired: false, direct: nil, hostName: nil, hostPlatform: nil,
        origin: nil, hubId: nil, spaceId: nil, deviceId: nil, userId: nil, pushEnabled: nil
    )
    var account: AccountInfo?
    var devices: [DeviceInfo] = []
    var tasks: [SharedTask] = []
    var pushSettings: PushSettings = PushSettings(available: false, enabled: false)

    // Synced archive storage
    var indexByDevice: [String: [ArchiveRecord]] = [:]
    var privateIndexByDevice: [String: [ArchiveRecord]] = [:]
    var indexCursors: [String: ArchiveCursor] = [:]

    var chatRecordsByKey: [String: [ArchiveRecord]] = [:]
    var chatCursorsByKey: [String: ArchiveCursor] = [:]
    var chatRouteStreamByKey: [String: String] = [:]

    // Read-state synchronization
    var hubReadCursors: [String: [String: Int64]] = [:]
    var localReadCursors: [String: Int64] = [:]
    var pinnedAgentKeys: [String] = []

    // UI State
    var isBootstrapping = true
    var isSyncing = false
    var isPairing = false
    var lastSyncAt: Date?
    var lastSyncBanner: String?
    var errorMessage: String?
    var pendingPairLink: String?
    var pendingNavigationRoute: ChatRoute?
    var activeChatKey: String?
    var themePreference: AppThemePreference = .system {
        didSet { UserDefaults.standard.set(themePreference.rawValue, forKey: "lever.theme") }
    }

    private let bridge = LeverBridge.shared
    private let cache = LocalCache.shared
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var bannerTask: Task<Void, Never>?
    private var inFlightRefresh = false

    init() {
        if let raw = UserDefaults.standard.string(forKey: "lever.theme"),
           let pref = AppThemePreference(rawValue: raw) {
            themePreference = pref
        }
        pinnedAgentKeys = UserDefaults.standard.stringArray(forKey: "lever.pinnedAgents") ?? []
        localReadCursors = cache.load("read_cursors", as: [String: Int64].self) ?? [:]
    }

    var isPaired: Bool { coreStatus.paired }
    var isDirectMode: Bool { coreStatus.direct == true }

    var activeSpace: SpaceInfo? {
        account?.spaces.first
    }

    var spacePath: String? {
        guard let space = activeSpace else { return nil }
        return "/api/spaces/\(space.id)"
    }

    var connectionSummary: String {
        if !isPaired { return "未配对" }
        let hosts = hostDevices
        let onlineCount = hosts.filter(\.online).count
        if isDirectMode {
            if onlineCount > 0 { return "LAN 直连" }
            return "局域网未连接"
        }
        if indexCursors.values.contains(where: { $0.stream == "lan" }) {
            return "LAN 直连"
        }
        return onlineCount > 0 ? "Hub 共享" : "离线缓存"
    }

    var hostDevices: [DeviceInfo] {
        devices.filter { $0.role != "controller" }
    }

    // MARK: - Lifecycle

    func bootstrap() async {
        bridge.start()
        startEventListener()

        do {
            coreStatus = try await bridge.status()
        } catch {
            coreStatus = CoreStatus(
                paired: false, direct: nil, hostName: nil, hostPlatform: nil,
                origin: nil, hubId: nil, spaceId: nil, deviceId: nil, userId: nil, pushEnabled: nil
            )
        }

        #if DEBUG
        if let autoLink = ProcessInfo.processInfo.environment["LEVER_AUTO_PAIR_LINK"],
           !autoLink.isEmpty,
           bridge.isValidPairLink(autoLink) {
            if coreStatus.paired {
                await unpair()
            }
            isBootstrapping = false
            await pair(link: autoLink)
        } else if coreStatus.paired {
            restoreCachedWorkspace()
            isBootstrapping = false
            await bridge.watch(true)
            await refreshAll(silent: true)
            startPollingLoop()
        } else {
            isBootstrapping = false
        }
        #else
        if coreStatus.paired {
            restoreCachedWorkspace()
            isBootstrapping = false
            await bridge.watch(true)
            await refreshAll(silent: true)
            startPollingLoop()
        } else {
            isBootstrapping = false
        }
        #endif
        #if DEBUG
        if isPaired, let openAgent = ProcessInfo.processInfo.environment["LEVER_DEBUG_OPEN_AGENT"], !openAgent.isEmpty {
            if let row = allAgentFeedRows.first(where: { $0.agentId == openAgent }) {
                let openTopic = ProcessInfo.processInfo.environment["LEVER_DEBUG_OPEN_TOPIC"]
                pendingNavigationRoute = ChatRoute(
                    deviceId: row.device.id,
                    agentId: row.agentId,
                    chatId: row.latestChat?.id,
                    isPrivate: row.isPrivate,
                    initialTopicId: (openTopic?.isEmpty == false) ? openTopic : nil
                )
            }
        }
        #endif
    }

    func handleSceneActive(_ active: Bool) {
        if active {
            guard isPaired else { return }
            Task {
                await bridge.watch(true)
                await refreshAll(silent: true)
                startPollingLoop()
            }
        } else {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    func handleIncomingURL(_ url: URL) {
        let raw = url.absoluteString
        guard bridge.isValidPairLink(raw) else { return }
        if !isPaired {
            pendingPairLink = raw
            Task { await pair(link: raw) }
        } else {
            showBanner("已配对设备，如需切换请先在设置中解除配对")
        }
    }

    func handleNetworkChanged() {
        bridge.networkChanged()
        guard isPaired else { return }
        Task { await refreshAll(silent: true) }
    }

    func handleAPNsDeviceToken(_ tokenHex: String) {
        guard isPaired, !isDirectMode else { return }
        Task {
            do {
                try await bridge.registerPushToken(tokenHex)
                coreStatus = try await bridge.status()
                await refreshPushSettings()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func handlePushOpened(leverPayload: String) {
        guard isPaired else { return }
        Task {
            do {
                let notice = try await bridge.openPush(payload: leverPayload)
                await refreshAll(silent: true)
                let chatRec = mergedIndex(for: notice.deviceId).first { $0.kind == "chat" && $0.id == notice.chatId }
                let agentId = chatRec?.agentId ?? "__chat:\(notice.chatId)"
                let sessionRec = notice.sessionId.flatMap { sid in
                    mergedIndex(for: notice.deviceId).first { $0.kind == "session" && $0.id == sid }
                }
                let initialTopicId = (sessionRec?.type == "topic") ? sessionRec?.id : nil
                pendingNavigationRoute = ChatRoute(
                    deviceId: notice.deviceId,
                    agentId: agentId,
                    chatId: notice.chatId,
                    isPrivate: chatRec?.isPrivate ?? false,
                    initialTopicId: initialTopicId
                )
            } catch {
                // Ignore stale or foreign push payload
            }
        }
    }

    // MARK: - Pairing

    func pair(link: String) async {
        let trimmed = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = "请输入或扫描配对链接"
            return
        }
        isPairing = true
        errorMessage = nil
        defer { isPairing = false }

        do {
            let deviceName = UIDevice.current.name
            try await bridge.pair(link: trimmed, deviceName: deviceName)
            pendingPairLink = nil
            coreStatus = try await bridge.status()
            Haptics.success()
            await bridge.watch(true)
            await refreshAll(silent: false)
            startPollingLoop()
            if !isDirectMode {
                await refreshPushSettings()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func unpair() async {
        errorMessage = nil
        pollTask?.cancel()
        pollTask = nil
        await bridge.watch(false)
        do {
            try await bridge.unpair()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        resetWorkspaceState()
    }

    private func resetWorkspaceState() {
        cache.clearAll()
        coreStatus = CoreStatus(
            paired: false, direct: nil, hostName: nil, hostPlatform: nil,
            origin: nil, hubId: nil, spaceId: nil, deviceId: nil, userId: nil, pushEnabled: nil
        )
        account = nil
        devices = []
        tasks = []
        indexByDevice = [:]
        privateIndexByDevice = [:]
        indexCursors = [:]
        chatRecordsByKey = [:]
        chatCursorsByKey = [:]
        chatRouteStreamByKey = [:]
        hubReadCursors = [:]
        localReadCursors = [:]
        activeChatKey = nil
        pendingNavigationRoute = nil
    }

    // MARK: - Sync Engine

    func refreshAll(silent: Bool = false) async {
        guard isPaired, !inFlightRefresh else { return }
        inFlightRefresh = true
        if !silent { isSyncing = true }
        defer {
            inFlightRefresh = false
            isSyncing = false
        }

        do {
            let me: AccountInfo = try await bridge.request("GET", path: "/api/me")
            account = me
            cache.save(me, as: "account")

            guard let sPath = spacePath else { return }

            let fetchedDevices: [DeviceInfo] = try await bridge.request("GET", path: "\(sPath)/devices")
            devices = fetchedDevices
            cache.save(fetchedDevices, as: "devices")

            // Fetch Hub-side read cursors if connected to Hub
            if !isDirectMode {
                if let cursors: [String: [String: Int64]] = try? await bridge.request("GET", path: "\(sPath)/read") {
                    hubReadCursors = cursors
                    cache.save(cursors, as: "hub_read_cursors")
                }
                if let fetchedTasks: [SharedTask] = try? await bridge.request("GET", path: "\(sPath)/tasks") {
                    tasks = fetchedTasks
                }
            }

            // Sync each executable host device incrementally
            for host in hostDevices where !host.revoked {
                await syncDeviceIndex(deviceId: host.id, spacePath: sPath)
            }

            // Refresh currently open chat if any
            if let key = activeChatKey {
                await refreshChatByKey(key)
            }

            lastSyncAt = Date()
            errorMessage = nil
        } catch {
            if !silent {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func syncDeviceIndex(deviceId: String, spacePath: String) async {
        let prev = indexCursors[deviceId]
        var path = "\(spacePath)/archive/\(deviceId)?sync=1"
        if let prev, !prev.epoch.isEmpty {
            path += "&epoch=\(urlEncode(prev.epoch))&version=\(prev.version)&stream=\(urlEncode(prev.stream))"
        }
        if let page: ArchivePage = try? await bridge.request("GET", path: path) {
            let merged = applyArchivePage(existing: indexByDevice[deviceId] ?? [], page: page)
            indexByDevice[deviceId] = merged
            indexCursors[deviceId] = page.cursor
            cache.save(CachedArchiveState(cursor: page.cursor, records: merged), as: "index_\(deviceId)")
        }

        // Also try LAN private chats (covers Direct LAN local chats & device-only shared chats)
        if let priv: [ArchiveRecord] = try? await bridge.request("GET", path: "\(spacePath)/private-archive/\(deviceId)") {
            privateIndexByDevice[deviceId] = priv
            cache.save(priv, as: "priv_\(deviceId)")
        }
    }

    func loadChat(deviceId: String, chatId: String, isPrivate: Bool) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        activeChatKey = key

        if chatRecordsByKey[key] == nil,
           let cached = cache.load("chat_\(key)", as: CachedArchiveState.self) {
            chatRecordsByKey[key] = cached.records
            if let c = cached.cursor { chatCursorsByKey[key] = c }
        }

        await refreshChatByKey(key, spacePath: sPath)
    }

    func refreshChatByKey(_ key: String, spacePath overridePath: String? = nil) async {
        guard let sPath = overridePath ?? spacePath else { return }
        let parts = key.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { return }
        let deviceId = parts[0]
        let chatId = parts[1]
        let isPrivate = parts[2] == "1"

        if isPrivate {
            let path = "\(sPath)/private-archive/\(deviceId)?chat=\(urlEncode(chatId))"
            if let records: [ArchiveRecord] = try? await bridge.request("GET", path: path) {
                chatRecordsByKey[key] = records
                chatRouteStreamByKey[key] = "lan"
                cache.save(CachedArchiveState(cursor: nil, records: records), as: "chat_\(key)")
            }
            return
        }

        let prev = chatCursorsByKey[key]
        var path = "\(sPath)/archive/\(deviceId)?chat=\(urlEncode(chatId))&sync=1"
        if let prev, !prev.epoch.isEmpty {
            path += "&epoch=\(urlEncode(prev.epoch))&version=\(prev.version)&stream=\(urlEncode(prev.stream))"
        }
        if let page: ArchivePage = try? await bridge.request("GET", path: path) {
            let merged = applyArchivePage(existing: chatRecordsByKey[key] ?? [], page: page)
            chatRecordsByKey[key] = merged
            chatCursorsByKey[key] = page.cursor
            chatRouteStreamByKey[key] = page.cursor.stream
            cache.save(CachedArchiveState(cursor: page.cursor, records: merged), as: "chat_\(key)")
        }
    }

    func chatKey(deviceId: String, chatId: String, isPrivate: Bool) -> String {
        "\(deviceId)|\(chatId)|\(isPrivate ? "1" : "0")"
    }

    private func applyArchivePage(existing: [ArchiveRecord], page: ArchivePage) -> [ArchiveRecord] {
        var map: [String: ArchiveRecord] = [:]
        if !page.full {
            for r in existing {
                map["\(r.kind):\(r.id)"] = r
            }
        }
        for change in page.changes {
            let k = "\(change.record.kind):\(change.record.id)"
            if change.deleted {
                map.removeValue(forKey: k)
            } else {
                map[k] = change.record
            }
        }
        return Array(map.values)
    }

    // MARK: - Bidirectional Read-State Sync

    func effectiveReadCursor(deviceId: String, session: ArchiveRecord) -> Int64 {
        let serverSeq = session.readSequence ?? 0
        let hubSeq = hubReadCursors[deviceId]?[session.id] ?? 0
        let localSeq = localReadCursors["\(deviceId):\(session.id)"] ?? 0
        return max(serverSeq, max(hubSeq, localSeq))
    }

    func isSessionUnread(deviceId: String, session: ArchiveRecord) -> Bool {
        let unread = session.unreadSequence ?? 0
        guard unread > 0 else { return false }
        return unread > effectiveReadCursor(deviceId: deviceId, session: session)
    }

    func markSessionsRead(deviceId: String, marks: [ReadMark], banner: String? = nil) {
        let filtered = marks.filter { mark in
            guard !mark.sessionId.isEmpty, mark.sequence > 0 else { return false }
            let key = "\(deviceId):\(mark.sessionId)"
            let current = max(
                localReadCursors[key] ?? 0,
                hubReadCursors[deviceId]?[mark.sessionId] ?? 0
            )
            return mark.sequence > current
        }
        guard !filtered.isEmpty else { return }

        // Optimistic local update
        for mark in filtered {
            let key = "\(deviceId):\(mark.sessionId)"
            localReadCursors[key] = max(localReadCursors[key] ?? 0, mark.sequence)
        }
        cache.save(localReadCursors, as: "read_cursors")

        if let banner {
            showBanner(banner)
        }

        guard let sPath = spacePath else { return }
        let payload = ReadSyncRequest(deviceId: deviceId, items: filtered)
        Task {
            try? await bridge.requestVoid("POST", path: "\(sPath)/read", body: payload)
        }
    }

    func markAgentRead(_ row: AgentFeedRow) {
        guard !row.unreadSessionMarks.isEmpty else { return }
        Haptics.light()
        markSessionsRead(
            deviceId: row.device.id,
            marks: row.unreadSessionMarks,
            banner: "「\(row.name)」已标为已读并同步到电脑"
        )
    }

    func markAllRead() {
        let rows = allAgentFeedRows
        var grouped: [String: [ReadMark]] = [:]
        for row in rows where !row.unreadSessionMarks.isEmpty {
            grouped[row.device.id, default: []].append(contentsOf: row.unreadSessionMarks)
        }
        guard !grouped.isEmpty else { return }
        Haptics.medium()
        for (devId, marks) in grouped {
            markSessionsRead(deviceId: devId, marks: marks)
        }
        showBanner("全部已读状态已同步至电脑")
    }

    // MARK: - Pinning

    func isPinned(_ rowId: String) -> Bool {
        pinnedAgentKeys.contains(rowId)
    }

    func togglePin(_ rowId: String) {
        Haptics.light()
        if let idx = pinnedAgentKeys.firstIndex(of: rowId) {
            pinnedAgentKeys.remove(at: idx)
        } else {
            pinnedAgentKeys.insert(rowId, at: 0)
        }
        UserDefaults.standard.set(pinnedAgentKeys, forKey: "lever.pinnedAgents")
    }

    // MARK: - Commands (Send / Topic / Approve / Stop / Resume)

    func sendMessage(
        deviceId: String,
        agentId: String,
        chatId: String?,
        isPrivate: Bool,
        text: String,
        mode: SendTargetMode,
        workingCopyId: String? = nil,
        delivery: String = "queue"
    ) async throws -> CommandReceipt {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LeverCoreError.message("请输入消息内容") }

        var operation = "main"
        var sessionId: String? = nil
        switch mode {
        case .main:
            operation = "main"
        case .newTopic:
            operation = "topic"
        case .topicReply(let tid):
            operation = "reply"
            sessionId = tid
        }

        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: "send",
            deviceId: deviceId,
            agentId: chatId == nil ? agentId : nil,
            workingCopyId: workingCopyId,
            chatId: chatId,
            sessionId: sessionId,
            runId: nil,
            requestId: nil,
            operation: operation,
            delivery: delivery,
            text: trimmed,
            answer: nil
        )

        let item: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        Haptics.light()
        if let targetChat = item.receipt.chatId ?? chatId {
            let key = chatKey(deviceId: deviceId, chatId: targetChat, isPrivate: isPrivate)
            await refreshChatByKey(key)
        }
        await refreshAll(silent: true)
        return item.receipt
    }

    func answerRequest(
        deviceId: String,
        chatId: String,
        isPrivate: Bool,
        request: ArchiveRecord,
        answer: RequestAnswer? = nil,
        allowRun: Bool = false
    ) async throws {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: allowRun ? "allow_run" : "answer",
            deviceId: deviceId,
            agentId: nil,
            workingCopyId: nil,
            chatId: chatId,
            sessionId: request.sessionId,
            runId: allowRun ? request.runId : nil,
            requestId: allowRun ? nil : request.id,
            operation: nil,
            delivery: nil,
            text: nil,
            answer: allowRun ? nil : answer
        )
        let _: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        Haptics.success()
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        await refreshChatByKey(key)
        await refreshAll(silent: true)
    }

    func stopRun(deviceId: String, chatId: String, isPrivate: Bool, runId: String) async throws {
        guard let sPath = spacePath else { return }
        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: "stop",
            deviceId: deviceId,
            agentId: nil,
            workingCopyId: nil,
            chatId: chatId,
            sessionId: nil,
            runId: runId,
            requestId: nil,
            operation: nil,
            delivery: nil,
            text: nil,
            answer: nil
        )
        let _: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        Haptics.medium()
        await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    func resumeQueue(deviceId: String, chatId: String, isPrivate: Bool, sessionId: String) async throws {
        guard let sPath = spacePath else { return }
        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: "resume_queue",
            deviceId: deviceId,
            agentId: nil,
            workingCopyId: nil,
            chatId: chatId,
            sessionId: sessionId,
            runId: nil,
            requestId: nil,
            operation: nil,
            delivery: nil,
            text: nil,
            answer: nil
        )
        let _: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    // MARK: - Push Settings

    func refreshPushSettings() async {
        guard let sPath = spacePath else { return }
        if let settings: PushSettings = try? await bridge.request("GET", path: "\(sPath)/push") {
            pushSettings = settings
        }
    }

    func setPushEnabled(_ enabled: Bool) async {
        guard !isDirectMode else {
            errorMessage = "锁屏通知需要连接 Lever Hub"
            return
        }
        if !enabled {
            do {
                try await bridge.disablePush()
                coreStatus = try await bridge.status()
                await refreshPushSettings()
            } catch {
                errorMessage = error.localizedDescription
            }
            return
        }
        do {
            let center = UNUserNotificationCenter.current()
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else {
                errorMessage = "请在系统「设置 → 通知」中允许 Lever 发送通知"
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Feed & Mixed Timeline Projections (Scheme 1)

    func mergedIndex(for deviceId: String) -> [ArchiveRecord] {
        var combined: [String: ArchiveRecord] = [:]
        for r in privateIndexByDevice[deviceId] ?? [] {
            combined["\(r.kind):\(r.id)"] = r
        }
        for r in indexByDevice[deviceId] ?? [] {
            combined["\(r.kind):\(r.id)"] = r
        }
        return Array(combined.values)
    }

    var allAgentFeedRows: [AgentFeedRow] {
        var rows: [AgentFeedRow] = []

        for device in hostDevices where !device.revoked {
            let records = mergedIndex(for: device.id)
            var agentsMap: [String: ArchiveRecord] = [:]
            var chatsByAgent: [String: [ArchiveRecord]] = [:]
            var sessionsByChat: [String: [ArchiveRecord]] = [:]

            for r in records {
                switch r.kind {
                case "agent":
                    agentsMap[r.id] = r
                case "chat":
                    let aid = (r.agentId?.isEmpty == false) ? r.agentId! : "__chat:\(r.id)"
                    chatsByAgent[aid, default: []].append(r)
                case "session":
                    if let cid = r.chatId {
                        sessionsByChat[cid, default: []].append(r)
                    }
                default:
                    break
                }
            }

            let allAgentIds = Set(agentsMap.keys).union(chatsByAgent.keys)
            for aid in allAgentIds {
                let agent = agentsMap[aid]
                let chats = (chatsByAgent[aid] ?? []).sorted { lhs, rhs in
                    let lTime = max(LeverDate.timestamp(lhs.updatedAt), LeverDate.timestamp(lhs.createdAt))
                    let rTime = max(LeverDate.timestamp(rhs.updatedAt), LeverDate.timestamp(rhs.createdAt))
                    return lTime > rTime
                }

                var unreadSessions = 0
                var pendingApprovals = 0
                var isRunning = false
                var unreadMarks: [ReadMark] = []
                var bestSessionTime: TimeInterval = 0
                var bestSessionPreview: String = ""
                var bestTimeRaw: String?
                var topicCandidates: [(priority: Int, time: TimeInterval, cue: ActiveTopicCue)] = []

                for chat in chats {
                    let chatSessions = sessionsByChat[chat.id] ?? []
                    for sess in chatSessions {
                        let unread = isSessionUnread(deviceId: device.id, session: sess)
                        if unread {
                            unreadSessions += 1
                            if let uSeq = sess.unreadSequence, uSeq > 0 {
                                unreadMarks.append(ReadMark(sessionId: sess.id, sequence: uSeq))
                            }
                        }
                        let pending = sess.pendingCount ?? 0
                        pendingApprovals += pending
                        let status = sess.activeStatus ?? ""
                        if status == "running" || status == "starting" || status == "cancelling" {
                            isRunning = true
                        }

                        let sessTimeRaw = (sess.messageAt?.isEmpty == false) ? sess.messageAt : sess.createdAt
                        let sessTime = LeverDate.timestamp(sessTimeRaw)
                        if sessTime >= bestSessionTime {
                            bestSessionTime = sessTime
                            bestTimeRaw = sessTimeRaw
                            if let p = sess.preview, !p.isEmpty {
                                bestSessionPreview = p
                            }
                        }

                        if sess.type == "topic" {
                            let priority: Int
                            if pending > 0 || status == "waiting_user" {
                                priority = 4
                            } else if status == "running" || status == "starting" {
                                priority = 3
                            } else if unread {
                                priority = 2
                            } else {
                                priority = 1
                            }
                            if priority >= 2 {
                                let cue = ActiveTopicCue(
                                    id: sess.id,
                                    chatId: chat.id,
                                    isPrivate: chat.isPrivate,
                                    title: (sess.title?.isEmpty == false) ? sess.title! : "独立话题",
                                    status: (pending > 0 || status == "waiting_user") ? "approval" : ((status == "running" || status == "starting") ? "running" : "unread"),
                                    pendingCount: pending,
                                    isUnread: unread,
                                    replyCount: sess.replyCount ?? 0,
                                    preview: sess.preview ?? ""
                                )
                                topicCandidates.append((priority, sessTime, cue))
                            }
                        }
                    }
                }

                let latestChat = chats.first
                let chatSortTime = latestChat.map { max(LeverDate.timestamp($0.updatedAt), LeverDate.timestamp($0.createdAt)) } ?? 0
                let sortTime = max(bestSessionTime, chatSortTime)
                let displayTimeRaw = bestTimeRaw ?? latestChat?.updatedAt ?? latestChat?.createdAt

                let name = (agent?.title?.isEmpty == false) ? agent!.title! : (latestChat?.title ?? "本地对话")
                let preview: String
                if !bestSessionPreview.isEmpty {
                    preview = bestSessionPreview
                } else if let title = latestChat?.title, !title.isEmpty {
                    preview = title
                } else {
                    preview = [agent?.model ?? agent?.provider, "点击开始新对话"]
                        .compactMap { $0 }
                        .filter { !$0.isEmpty }
                        .joined(separator: " · ")
                }

                let bestCue = topicCandidates.sorted { lhs, rhs in
                    if lhs.priority != rhs.priority { return lhs.priority > rhs.priority }
                    return lhs.time > rhs.time
                }.first?.cue

                rows.append(AgentFeedRow(
                    id: "\(device.id):\(aid)",
                    device: device,
                    agentId: aid,
                    name: name,
                    avatar: agent?.avatar,
                    model: agent?.model,
                    provider: agent?.provider,
                    latestChat: latestChat,
                    chatCount: chats.count,
                    unreadSessionCount: unreadSessions,
                    pendingApprovalCount: pendingApprovals,
                    isRunning: isRunning,
                    sortTimestamp: sortTime,
                    timeText: LeverDate.compact(displayTimeRaw),
                    preview: preview,
                    isPrivate: latestChat?.isPrivate ?? false,
                    activeTopicCue: bestCue,
                    unreadSessionMarks: unreadMarks
                ))
            }
        }

        return rows.sorted { lhs, rhs in
            let lPin = isPinned(lhs.id)
            let rPin = isPinned(rhs.id)
            if lPin != rPin { return lPin }
            if lhs.pendingApprovalCount != rhs.pendingApprovalCount {
                return lhs.pendingApprovalCount > rhs.pendingApprovalCount
            }
            if lhs.sortTimestamp != rhs.sortTimestamp {
                return lhs.sortTimestamp > rhs.sortTimestamp
            }
            if lhs.unreadSessionCount != rhs.unreadSessionCount {
                return lhs.unreadSessionCount > rhs.unreadSessionCount
            }
            if lhs.device.online != rhs.device.online {
                return lhs.device.online
            }
            return lhs.name.localizedCompare(rhs.name) == .orderedAscending
        }
    }

    var totalUnreadSessions: Int {
        allAgentFeedRows.reduce(0) { $0 + $1.unreadSessionCount }
    }

    var totalPendingApprovals: Int {
        allAgentFeedRows.reduce(0) { $0 + $1.pendingApprovalCount }
    }

    var totalRunningAgents: Int {
        allAgentFeedRows.filter(\.isRunning).count
    }

    func agentRecord(deviceId: String, agentId: String) -> ArchiveRecord? {
        mergedIndex(for: deviceId).first { $0.kind == "agent" && $0.id == agentId }
    }

    func chatsForAgent(deviceId: String, agentId: String) -> [ArchiveRecord] {
        mergedIndex(for: deviceId)
            .filter { $0.kind == "chat" && (($0.agentId == agentId) || ("__chat:\($0.id)" == agentId)) }
            .sorted {
                max(LeverDate.timestamp($0.updatedAt), LeverDate.timestamp($0.createdAt)) >
                max(LeverDate.timestamp($1.updatedAt), LeverDate.timestamp($1.createdAt))
            }
    }

    func sessionsForChat(deviceId: String, chatId: String, isPrivate: Bool) -> [ArchiveRecord] {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let detailSessions = (chatRecordsByKey[key] ?? []).filter { $0.kind == "session" && $0.chatId == chatId }
        if !detailSessions.isEmpty { return detailSessions }
        return mergedIndex(for: deviceId).filter { $0.kind == "session" && $0.chatId == chatId }
    }

    func mainSession(deviceId: String, chatId: String, isPrivate: Bool) -> ArchiveRecord? {
        sessionsForChat(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
            .first { $0.type == "main" }
    }

    /// Builds Scheme 1's 1:1 desktop-aligned mixed timeline (main runs + inline Topic cards).
    func mixedTimeline(deviceId: String, chatId: String, isPrivate: Bool) -> (entries: [TimelineEntry], topics: [TopicSummary], mainSession: ArchiveRecord?) {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let records = chatRecordsByKey[key] ?? []

        let sessions = records.filter { $0.kind == "session" && $0.chatId == chatId }
        let mainSess = sessions.first { $0.type == "main" } ?? mainSession(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let topicSessions = sessions.filter { $0.type == "topic" }

        let allRuns = records
            .filter { $0.kind == "run" && $0.chatId == chatId && $0.superseded != true }
            .sorted { ($0.sequence ?? 0) < ($1.sequence ?? 0) }

        var requestsByRun: [String: [ArchiveRecord]] = [:]
        for req in records where req.kind == "request" && req.chatId == chatId {
            if let rid = req.runId {
                requestsByRun[rid, default: []].append(req)
            }
        }

        var runCreatedById: [String: TimeInterval] = [:]
        for run in allRuns {
            runCreatedById[run.id] = LeverDate.timestamp(run.createdAt)
        }

        var entries: [TimelineEntry] = []

        // Main session runs
        let mainRuns = allRuns.filter { $0.sessionId == mainSess?.id }
        for run in mainRuns {
            entries.append(.mainRun(run, requests: requestsByRun[run.id] ?? []))
        }

        // Topic cards interleaved chronologically
        var topics: [TopicSummary] = []
        for sess in topicSessions {
            let tRuns = allRuns.filter { $0.sessionId == sess.id }
            var tReqsByRun: [String: [ArchiveRecord]] = [:]
            var pendingReq: ArchiveRecord?
            var files: [FileStat] = []
            var seenFiles = Set<String>()

            for run in tRuns {
                let reqs = requestsByRun[run.id] ?? []
                tReqsByRun[run.id] = reqs
                if pendingReq == nil, let p = reqs.first(where: { $0.status == "pending" }) {
                    pendingReq = p
                }
                for f in run.files ?? [] where !seenFiles.contains(f.name) {
                    seenFiles.insert(f.name)
                    files.append(f)
                }
            }

            let rootPrompt = tRuns.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let title: String
            if let t = sess.title, !t.isEmpty {
                title = t
            } else if !rootPrompt.isEmpty {
                title = String(rootPrompt.prefix(48))
            } else {
                title = "独立话题"
            }

            let lastRun = tRuns.last
            var latestReplyText = ""
            var latestIsUser = false
            if let lastRun {
                if let lastTextItem = (lastRun.items ?? []).last(where: { $0.kind == "text" && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                    latestReplyText = lastTextItem.text ?? ""
                } else if let err = lastRun.error, !err.isEmpty {
                    latestReplyText = err
                } else if let inp = lastRun.text, !inp.isEmpty {
                    latestReplyText = inp
                    latestIsUser = true
                }
            } else if let p = sess.preview, !p.isEmpty {
                latestReplyText = p
            }

            let status: String
            if pendingReq != nil || lastRun?.status == "waiting_user" || (sess.pendingCount ?? 0) > 0 {
                status = "approval"
            } else if isActiveRunStatus(lastRun?.status) || isActiveRunStatus(sess.activeStatus) {
                status = "running"
            } else if lastRun?.status == "failed" {
                status = "failed"
            } else {
                status = "done"
            }

            let anchorTime: TimeInterval
            if let srcId = sess.sourceRunId, let srcTime = runCreatedById[srcId] {
                anchorTime = srcTime + 0.001
            } else if let firstRunTime = tRuns.first.map({ LeverDate.timestamp($0.createdAt) }), firstRunTime > 0 {
                anchorTime = firstRunTime
            } else {
                anchorTime = LeverDate.timestamp(sess.createdAt)
            }

            let updatedTime = max(
                LeverDate.timestamp(sess.messageAt),
                max(LeverDate.timestamp(lastRun?.updatedAt ?? lastRun?.createdAt), anchorTime)
            )

            let summary = TopicSummary(
                id: sess.id,
                chatId: chatId,
                title: title,
                rootPrompt: rootPrompt.isEmpty ? title : rootPrompt,
                latestReplyText: latestReplyText,
                latestReplyIsUser: latestIsUser,
                pendingRequest: pendingReq,
                status: status,
                replyCount: max(tRuns.count, sess.replyCount ?? 0),
                unreadSequence: sess.unreadSequence ?? 0,
                isUnread: isSessionUnread(deviceId: deviceId, session: sess),
                anchorTimestamp: anchorTime,
                updatedTimestamp: updatedTime,
                fileStats: files,
                runs: tRuns,
                requestsByRun: tReqsByRun
            )
            topics.append(summary)
            entries.append(.topicCard(summary))
        }

        entries.sort { $0.sortDate < $1.sortDate }
        topics.sort { $0.updatedTimestamp > $1.updatedTimestamp }
        return (entries, topics, mainSess)
    }

    // MARK: - Helpers

    private func restoreCachedWorkspace() {
        account = cache.load("account", as: AccountInfo.self)
        devices = cache.load("devices", as: [DeviceInfo].self) ?? []
        hubReadCursors = cache.load("hub_read_cursors", as: [String: [String: Int64]].self) ?? [:]
        for dev in hostDevices {
            if let cached = cache.load("index_\(dev.id)", as: CachedArchiveState.self) {
                indexByDevice[dev.id] = cached.records
                if let c = cached.cursor { indexCursors[dev.id] = c }
            }
            if let priv = cache.load("priv_\(dev.id)", as: [ArchiveRecord].self) {
                privateIndexByDevice[dev.id] = priv
            }
        }
    }

    private func startEventListener() {
        guard eventTask == nil else { return }
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await ev in self.bridge.events() {
                if Task.isCancelled { break }
                switch ev.kind {
                case "refresh":
                    await self.refreshAll(silent: true)
                case "unpaired":
                    self.resetWorkspaceState()
                default:
                    break
                }
            }
        }
    }

    private func startPollingLoop() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isPaired else { break }
                let intervalNs: UInt64
                if self.activeChatKey != nil || self.totalRunningAgents > 0 || self.totalPendingApprovals > 0 {
                    intervalNs = 2_500_000_000 // 2.5s while active or chatting
                } else {
                    intervalNs = self.isDirectMode ? 6_000_000_000 : 12_000_000_000
                }
                try? await Task.sleep(nanoseconds: intervalNs)
                if Task.isCancelled { break }
                await self.refreshAll(silent: true)
            }
        }
    }

    func showBanner(_ message: String) {
        bannerTask?.cancel()
        withAnimation(.easeOut(duration: 0.2)) {
            lastSyncBanner = message
        }
        bannerTask = Task {
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            if !Task.isCancelled {
                withAnimation(.easeOut(duration: 0.2)) {
                    lastSyncBanner = nil
                }
            }
        }
    }

    private func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}
