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

private struct CachedArchiveState: Codable, Sendable {
    var cursor: ArchiveCursor?
    var records: [ArchiveRecord]
}

/// Central @Observable state store for Lever iOS:
/// - Pre-computed & memoized O(1) feed, timeline, and drawer projections (120fps scrolling & gestures)
/// - Paginated LAN/Hub chat & per-topic archive sync (prevents multi-hundred-MB chat timeouts)
/// - Bidirectional Desktop <-> Mobile read-state and cleared-state synchronization
/// - Desktop-matched 5-kind avatar image disk cache & real session/run model projection
/// - Configurable Desktop-active silent notification policy
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
    var pushSettings: PushSettings = PushSettings(available: false, enabled: false, silenceWhenDesktopActive: true)

    // Synced archive storage
    var indexByDevice: [String: [ArchiveRecord]] = [:]
    var privateIndexByDevice: [String: [ArchiveRecord]] = [:]
    var indexCursors: [String: ArchiveCursor] = [:]

    var chatRecordsByKey: [String: [ArchiveRecord]] = [:]
    var chatCursorsByKey: [String: ArchiveCursor] = [:]
    var chatRouteStreamByKey: [String: String] = [:]

    // Pagination & loading state
    var loadingChatKeys: Set<String> = []
    var loadingTopicKeys: Set<String> = []
    var loadingOlderKeys: Set<String> = []
    var chatLoadErrorByKey: [String: String] = [:]
    var hasMoreMainByKey: [String: Bool] = [:]
    var hasMoreTopicByKey: [String: Bool] = [:]

    // Pre-computed O(1) feed projections & reactive revision tokens
    private(set) var cachedFeedRows: [AgentFeedRow] = []
    private(set) var cachedTotalUnread: Int = 0
    private(set) var cachedTotalPending: Int = 0
    private(set) var cachedTotalRunning: Int = 0
    private(set) var dataVersion: Int = 0
    private(set) var chatVersionByKey: [String: Int] = [:]

    // Bidirectional read-state, cleared-state, and Composer metadata (providers, favorites, skills)
    var hubReadCursors: [String: [String: Int64]] = [:]
    var localReadCursors: [String: Int64] = [:]
    var hubClearedCursors: [String: [String: Int64]] = [:]
    var localClearedCursors: [String: Int64] = [:] // >0 cleared up to seq; 0 explicitly restored
    var pinnedAgentKeys: [String] = []
    var providersByDevice: [String: [ProviderCatalog]] = [:]
    var skillsByScopeKey: [String: [MessageReference]] = [:]
    var starredModelsByDevice: [String: [String: [String]]] = [:]

    // UI Preferences
    var isBootstrapping = true
    var isSyncing = false
    var isPairing = false
    var lastSyncAt: Date?
    var lastSyncBanner: String?
    var errorMessage: String?
    var pendingPairLink: String?
    var pendingNavigationRoute: ChatRoute?
    var activeChatKey: String?
    var activeTopicId: String?

    var silenceWhenDesktopActive: Bool = true {
        didSet { UserDefaults.standard.set(silenceWhenDesktopActive, forKey: "lever.silenceWhenDesktopActive") }
    }
    var homeTopicsExpanded: Bool = true {
        didSet { UserDefaults.standard.set(homeTopicsExpanded, forKey: "lever.homeTopicsExpanded") }
    }
    var themePreference: AppThemePreference = .system {
        didSet { UserDefaults.standard.set(themePreference.rawValue, forKey: "lever.theme") }
    }

    @ObservationIgnored private let pageSize = 25
    @ObservationIgnored private let bridge = LeverBridge.shared
    @ObservationIgnored private let cache = LocalCache.shared
    @ObservationIgnored private let avatarMemoryCache = NSCache<NSString, UIImage>()
    @ObservationIgnored private var inFlightAvatars = Set<String>()
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var bannerTask: Task<Void, Never>?
    @ObservationIgnored private var inFlightRefresh = false

    // Internal memoization caches invalidated only on actual data mutation
    @ObservationIgnored private var mergedIndexCache: [String: [ArchiveRecord]] = [:]
    @ObservationIgnored private var agentRecordCache: [String: ArchiveRecord] = [:]
    @ObservationIgnored private var timelineSnapshotCache: [String: TimelineSnapshot] = [:]
    @ObservationIgnored private var drawerDataCache: [String: AgentDrawerData] = [:]

    init() {
        if let raw = UserDefaults.standard.string(forKey: "lever.theme"),
           let pref = AppThemePreference(rawValue: raw) {
            themePreference = pref
        }
        if UserDefaults.standard.object(forKey: "lever.silenceWhenDesktopActive") != nil {
            silenceWhenDesktopActive = UserDefaults.standard.bool(forKey: "lever.silenceWhenDesktopActive")
        }
        if UserDefaults.standard.object(forKey: "lever.homeTopicsExpanded") != nil {
            homeTopicsExpanded = UserDefaults.standard.bool(forKey: "lever.homeTopicsExpanded")
        }
        pinnedAgentKeys = UserDefaults.standard.stringArray(forKey: "lever.pinnedAgents") ?? []
        localReadCursors = cache.load("read_cursors", as: [String: Int64].self) ?? [:]
        localClearedCursors = cache.load("cleared_cursors", as: [String: Int64].self) ?? [:]
        starredModelsByDevice = cache.load("starred_models", as: [String: [String: [String]]].self) ?? [:]
        providersByDevice = cache.load("providers_by_device", as: [String: [ProviderCatalog]].self) ?? [:]
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

    var hostDevices: [DeviceInfo] {
        devices.filter { $0.role != "controller" }
    }

    var anyDesktopActive: Bool {
        hostDevices.contains(where: \.isDesktopActive)
    }

    var connectionSummary: String {
        if !isPaired { return "未配对" }
        let hosts = hostDevices
        let onlineCount = hosts.filter(\.online).count
        if isDirectMode {
            return onlineCount > 0 ? "LAN 直连" : "局域网未连接"
        }
        if indexCursors.values.contains(where: { $0.stream == "lan" }) {
            return "LAN 直连"
        }
        return onlineCount > 0 ? "已同步" : "离线缓存"
    }

    // O(1) aliases to pre-computed feed state
    var allAgentFeedRows: [AgentFeedRow] { cachedFeedRows }
    var totalUnreadSessions: Int { cachedTotalUnread }
    var totalPendingApprovals: Int { cachedTotalPending }
    var totalRunningAgents: Int { cachedTotalRunning }

    // MARK: - Projection Cache Management

    private func invalidateAllProjections() {
        mergedIndexCache.removeAll(keepingCapacity: true)
        agentRecordCache.removeAll(keepingCapacity: true)
        timelineSnapshotCache.removeAll(keepingCapacity: true)
        drawerDataCache.removeAll(keepingCapacity: true)
        rebuildFeedProjection()
        dataVersion &+= 1
    }

    private func invalidateChatCache(forKey key: String) {
        timelineSnapshotCache.removeValue(forKey: key)
        chatVersionByKey[key, default: 0] &+= 1
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
            await restoreCachedWorkspace()
            isBootstrapping = false
            await bridge.watch(true)
            await refreshAll(silent: true)
            startPollingLoop()
        } else {
            isBootstrapping = false
        }
        #else
        if coreStatus.paired {
            await restoreCachedWorkspace()
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
            if let row = cachedFeedRows.first(where: { $0.agentId == openAgent }) {
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
                await syncSilencePreferenceToHub()
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
        avatarMemoryCache.removeAllObjects()
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
        loadingChatKeys = []
        loadingTopicKeys = []
        loadingOlderKeys = []
        chatLoadErrorByKey = [:]
        hasMoreMainByKey = [:]
        hasMoreTopicByKey = [:]
        hubReadCursors = [:]
        localReadCursors = [:]
        hubClearedCursors = [:]
        localClearedCursors = [:]
        providersByDevice = [:]
        skillsByScopeKey = [:]
        starredModelsByDevice = [:]
        activeChatKey = nil
        activeTopicId = nil
        pendingNavigationRoute = nil
        chatVersionByKey = [:]
        invalidateAllProjections()
    }

    // MARK: - Sync Engine (Change-Gated + Backend Progressive Pagination)

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
            if account != me {
                account = me
                cache.save(me, as: "account")
            }

            guard let sPath = spacePath else { return }

            var projectionsDirty = false

            let fetchedDevices: [DeviceInfo] = try await bridge.request("GET", path: "\(sPath)/devices")
            if devices != fetchedDevices {
                devices = fetchedDevices
                cache.save(fetchedDevices, as: "devices")
                projectionsDirty = true
            }

            if !isDirectMode {
                if let cursors: [String: [String: Int64]] = try? await bridge.request("GET", path: "\(sPath)/read"),
                   hubReadCursors != cursors {
                    hubReadCursors = cursors
                    cache.save(cursors, as: "hub_read_cursors")
                    projectionsDirty = true
                }
                if let cleared: [String: [String: Int64]] = try? await bridge.request("GET", path: "\(sPath)/cleared"),
                   hubClearedCursors != cleared {
                    hubClearedCursors = cleared
                    cache.save(cleared, as: "hub_cleared_cursors")
                    projectionsDirty = true
                }
                if let fetchedTasks: [SharedTask] = try? await bridge.request("GET", path: "\(sPath)/tasks"),
                   tasks != fetchedTasks {
                    tasks = fetchedTasks
                }
            }

            for host in hostDevices where !host.revoked {
                let changed = await syncDeviceIndex(deviceId: host.id, spacePath: sPath)
                if changed { projectionsDirty = true }
            }

            if projectionsDirty {
                invalidateAllProjections()
            }

            if let key = activeChatKey {
                if let tid = activeTopicId,
                   let parsed = parseChatKey(key) {
                    await refreshTopic(
                        deviceId: parsed.deviceId,
                        chatId: parsed.chatId,
                        isPrivate: parsed.isPrivate,
                        topicId: tid,
                        spacePath: sPath,
                        showLoading: false
                    )
                } else {
                    await refreshChatByKey(key, spacePath: sPath, showLoading: false)
                }
            }

            lastSyncAt = Date()
            errorMessage = nil
        } catch {
            if !silent {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func syncDeviceIndex(deviceId: String, spacePath: String) async -> Bool {
        var didChange = false
        let prev = indexCursors[deviceId]
        var path = "\(spacePath)/archive/\(deviceId)?sync=1"
        if let prev, !prev.epoch.isEmpty {
            path += "&epoch=\(urlEncode(prev.epoch))&version=\(prev.version)&stream=\(urlEncode(prev.stream))"
        }
        if let page: ArchivePage = try? await bridge.request("GET", path: path) {
            if page.full || !page.changes.isEmpty {
                let merged = applyArchivePage(existing: indexByDevice[deviceId] ?? [], page: page)
                if indexByDevice[deviceId] != merged {
                    indexByDevice[deviceId] = merged
                    cache.save(CachedArchiveState(cursor: page.cursor, records: merged), as: "index_\(deviceId)")
                    didChange = true
                }
            }
            if indexCursors[deviceId] != page.cursor {
                indexCursors[deviceId] = page.cursor
            }
        }

        if let priv: [ArchiveRecord] = try? await bridge.request("GET", path: "\(spacePath)/private-archive/\(deviceId)") {
            let sortedPriv = sortRecords(priv)
            if privateIndexByDevice[deviceId] != sortedPriv {
                privateIndexByDevice[deviceId] = sortedPriv
                cache.save(sortedPriv, as: "priv_\(deviceId)")
                didChange = true
            }
        }
        return didChange
    }

    // MARK: - Paginated Chat & Topic Loading

    func chatKey(deviceId: String, chatId: String, isPrivate: Bool) -> String {
        "\(deviceId)|\(chatId)|\(isPrivate ? "1" : "0")"
    }

    func topicPageKey(chatKey: String, topicId: String) -> String {
        "\(chatKey)|\(topicId)"
    }

    private func parseChatKey(_ key: String) -> (deviceId: String, chatId: String, isPrivate: Bool)? {
        let parts = key.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { return nil }
        return (parts[0], parts[1], parts[2] == "1")
    }

    func isLoadingChat(deviceId: String, chatId: String, isPrivate: Bool) -> Bool {
        loadingChatKeys.contains(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    func isLoadingTopic(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> Bool {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return loadingTopicKeys.contains(topicPageKey(chatKey: key, topicId: topicId))
    }

    func isLoadingOlderChat(deviceId: String, chatId: String, isPrivate: Bool) -> Bool {
        loadingOlderKeys.contains(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    func isLoadingOlderTopic(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> Bool {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return loadingOlderKeys.contains(topicPageKey(chatKey: key, topicId: topicId))
    }

    func chatLoadError(deviceId: String, chatId: String, isPrivate: Bool) -> String? {
        chatLoadErrorByKey[chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)]
    }

    func topicLoadError(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> String? {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return chatLoadErrorByKey[topicPageKey(chatKey: key, topicId: topicId)]
    }

    func hasMoreMainRuns(deviceId: String, chatId: String, isPrivate: Bool) -> Bool {
        hasMoreMainByKey[chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)] ?? false
    }

    func hasMoreTopicRuns(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> Bool {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return hasMoreTopicByKey[topicPageKey(chatKey: key, topicId: topicId)] ?? false
    }

    func loadChat(deviceId: String, chatId: String, isPrivate: Bool) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        activeChatKey = key
        chatLoadErrorByKey.removeValue(forKey: key)

        // Hydrate cached records off the main thread so navigation transition never hitches
        if chatRecordsByKey[key] == nil,
           let cached = await cache.loadAsync("chat_\(key)", as: CachedArchiveState.self) {
            if chatRecordsByKey[key] == nil {
                chatRecordsByKey[key] = cached.records
                if let c = cached.cursor { chatCursorsByKey[key] = c }
                invalidateChatCache(forKey: key)
            }
        }

        await refreshChatByKey(key, spacePath: sPath, showLoading: true)
    }

    func refreshChatByKey(_ key: String, spacePath overridePath: String? = nil, showLoading: Bool = false) async {
        guard let sPath = overridePath ?? spacePath,
              let parsed = parseChatKey(key) else { return }

        if showLoading {
            loadingChatKeys.insert(key)
        }
        defer {
            if showLoading {
                loadingChatKeys.remove(key)
            }
        }

        let endpoint = parsed.isPrivate ? "private-archive" : "archive"
        let path = "\(sPath)/\(endpoint)/\(parsed.deviceId)?chat=\(urlEncode(parsed.chatId))&limit=\(pageSize)"

        do {
            let incoming: [ArchiveRecord] = try await bridge.request("GET", path: path)
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                cache.save(CachedArchiveState(cursor: chatCursorsByKey[key], records: merged), as: "chat_\(key)")
            }
            chatLoadErrorByKey.removeValue(forKey: key)
            chatRouteStreamByKey[key] = parsed.isPrivate ? "lan" : (indexCursors[parsed.deviceId]?.stream ?? "hub")

            if hasMoreMainByKey[key] == nil {
                let mainSessId = incoming.first(where: { $0.kind == "session" && $0.type == "main" })?.id
                    ?? merged.first(where: { $0.kind == "session" && $0.type == "main" })?.id
                if let mainSessId {
                    let mainRuns = incoming.filter { $0.kind == "run" && $0.sessionId == mainSessId && $0.superseded != true }
                    let minSeq = mainRuns.compactMap(\.sequence).min() ?? 0
                    hasMoreMainByKey[key] = mainRuns.count >= pageSize && minSeq > 1
                } else {
                    hasMoreMainByKey[key] = false
                }
            }
        } catch {
            if showLoading {
                chatLoadErrorByKey[key] = error.localizedDescription
            }
        }
    }

    func loadOlderChatRuns(deviceId: String, chatId: String, isPrivate: Bool) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        guard !loadingOlderKeys.contains(key) else { return }

        let snapshot = timelineSnapshot(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        guard let oldestSeq = snapshot.oldestMainSequence, oldestSeq > 1 else {
            hasMoreMainByKey[key] = false
            return
        }

        loadingOlderKeys.insert(key)
        defer { loadingOlderKeys.remove(key) }

        let endpoint = isPrivate ? "private-archive" : "archive"
        let path = "\(sPath)/\(endpoint)/\(deviceId)?chat=\(urlEncode(chatId))&before=\(oldestSeq)&limit=\(pageSize)"
        do {
            let incoming: [ArchiveRecord] = try await bridge.request("GET", path: path)
            let mainId = snapshot.mainSession?.id
            let olderMainRuns = incoming.filter {
                $0.kind == "run" && $0.sessionId == mainId && $0.superseded != true && ($0.sequence ?? Int64.max) < oldestSeq
            }
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                cache.save(CachedArchiveState(cursor: chatCursorsByKey[key], records: merged), as: "chat_\(key)")
            }
            let minReturned = olderMainRuns.compactMap(\.sequence).min() ?? 0
            if olderMainRuns.count < pageSize || minReturned <= 1 {
                hasMoreMainByKey[key] = false
            }
        } catch {
            chatLoadErrorByKey[key] = error.localizedDescription
        }
    }

    func loadTopic(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let tKey = topicPageKey(chatKey: key, topicId: topicId)
        activeChatKey = key
        activeTopicId = topicId
        chatLoadErrorByKey.removeValue(forKey: tKey)

        if chatRecordsByKey[key] == nil,
           let cached = await cache.loadAsync("chat_\(key)", as: CachedArchiveState.self) {
            if chatRecordsByKey[key] == nil {
                chatRecordsByKey[key] = cached.records
                if let c = cached.cursor { chatCursorsByKey[key] = c }
                invalidateChatCache(forKey: key)
            }
        }

        await refreshTopic(
            deviceId: deviceId,
            chatId: chatId,
            isPrivate: isPrivate,
            topicId: topicId,
            spacePath: sPath,
            showLoading: true
        )
    }

    func refreshTopic(
        deviceId: String,
        chatId: String,
        isPrivate: Bool,
        topicId: String,
        spacePath overridePath: String? = nil,
        showLoading: Bool = false
    ) async {
        guard let sPath = overridePath ?? spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let tKey = topicPageKey(chatKey: key, topicId: topicId)

        if showLoading {
            loadingTopicKeys.insert(tKey)
        }
        defer {
            if showLoading {
                loadingTopicKeys.remove(tKey)
            }
        }

        let endpoint = isPrivate ? "private-archive" : "archive"
        let path = "\(sPath)/\(endpoint)/\(deviceId)?chat=\(urlEncode(chatId))&session=\(urlEncode(topicId))&limit=\(pageSize)"

        do {
            let incoming: [ArchiveRecord] = try await bridge.request("GET", path: path)
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                cache.save(CachedArchiveState(cursor: chatCursorsByKey[key], records: merged), as: "chat_\(key)")
            }
            chatLoadErrorByKey.removeValue(forKey: tKey)

            if hasMoreTopicByKey[tKey] == nil {
                let topicRuns = incoming.filter { $0.kind == "run" && $0.sessionId == topicId && $0.superseded != true }
                let minSeq = topicRuns.compactMap(\.sequence).min() ?? 0
                hasMoreTopicByKey[tKey] = topicRuns.count >= pageSize && minSeq > 1
            }
        } catch {
            if showLoading {
                chatLoadErrorByKey[tKey] = error.localizedDescription
            }
        }
    }

    func loadOlderTopicRuns(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let tKey = topicPageKey(chatKey: key, topicId: topicId)
        guard !loadingOlderKeys.contains(tKey) else { return }

        let snapshot = timelineSnapshot(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        guard let topic = snapshot.topics.first(where: { $0.id == topicId }),
              let oldestSeq = topic.oldestRunSequence,
              oldestSeq > 1 else {
            hasMoreTopicByKey[tKey] = false
            return
        }

        loadingOlderKeys.insert(tKey)
        defer { loadingOlderKeys.remove(tKey) }

        let endpoint = isPrivate ? "private-archive" : "archive"
        let path = "\(sPath)/\(endpoint)/\(deviceId)?chat=\(urlEncode(chatId))&session=\(urlEncode(topicId))&before=\(oldestSeq)&limit=\(pageSize)"
        do {
            let incoming: [ArchiveRecord] = try await bridge.request("GET", path: path)
            let olderTopicRuns = incoming.filter {
                $0.kind == "run" && $0.sessionId == topicId && $0.superseded != true && ($0.sequence ?? Int64.max) < oldestSeq
            }
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                cache.save(CachedArchiveState(cursor: chatCursorsByKey[key], records: merged), as: "chat_\(key)")
            }
            let minReturned = olderTopicRuns.compactMap(\.sequence).min() ?? 0
            if olderTopicRuns.count < pageSize || minReturned <= 1 {
                hasMoreTopicByKey[tKey] = false
            }
        } catch {
            chatLoadErrorByKey[tKey] = error.localizedDescription
        }
    }

    private func sortRecords(_ records: [ArchiveRecord]) -> [ArchiveRecord] {
        records.sorted { lhs, rhs in
            if lhs.kind != rhs.kind { return lhs.kind < rhs.kind }
            return lhs.id < rhs.id
        }
    }

    private func mergeRecords(existing: [ArchiveRecord], incoming: [ArchiveRecord]) -> [ArchiveRecord] {
        var map: [String: ArchiveRecord] = Dictionary(minimumCapacity: existing.count + incoming.count)
        for r in existing {
            map["\(r.kind):\(r.id)"] = r
        }
        for r in incoming {
            map["\(r.kind):\(r.id)"] = r
        }
        return sortRecords(Array(map.values))
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
        return sortRecords(Array(map.values))
    }

    // MARK: - Desktop Avatar Image Cache

    func cachedAvatarImage(_ imageId: String) -> UIImage? {
        if let hit = avatarMemoryCache.object(forKey: imageId as NSString) {
            return hit
        }
        if let data = cache.load("avatar_\(imageId)", as: Data.self),
           let img = UIImage(data: data) {
            avatarMemoryCache.setObject(img, forKey: imageId as NSString)
            return img
        }
        return nil
    }

    func fetchAvatarImage(deviceId: String, imageId: String) async -> UIImage? {
        if let cached = cachedAvatarImage(imageId) { return cached }
        guard let sPath = spacePath, !inFlightAvatars.contains(imageId) else { return nil }
        inFlightAvatars.insert(imageId)
        defer { inFlightAvatars.remove(imageId) }
        guard let resp: AvatarImageResponse = try? await bridge.request("GET", path: "\(sPath)/avatars/\(deviceId)/\(imageId)"),
              let data = Data(base64Encoded: resp.data),
              let img = UIImage(data: data) else {
            return nil
        }
        avatarMemoryCache.setObject(img, forKey: imageId as NSString)
        cache.save(data, as: "avatar_\(imageId)")
        return img
    }

    // MARK: - Bidirectional Read-State & Cleared-State Sync

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

    func effectiveClearedCursor(deviceId: String, session: ArchiveRecord) -> Int64 {
        let key = "\(deviceId):\(session.id)"
        if let local = localClearedCursors[key] {
            if local == 0 { return 0 }
            let server = max(session.clearedSequence ?? 0, hubClearedCursors[deviceId]?[session.id] ?? 0)
            return max(local, server)
        }
        return max(session.clearedSequence ?? 0, hubClearedCursors[deviceId]?[session.id] ?? 0)
    }

    func isSessionCleared(deviceId: String, session: ArchiveRecord, isActiveRun: Bool = false) -> Bool {
        let pending = (session.pendingCount ?? 0) > 0
        let running = isActiveRun || isActiveRunStatus(session.activeStatus)
        if pending || running || isSessionUnread(deviceId: deviceId, session: session) {
            return false
        }
        let cleared = effectiveClearedCursor(deviceId: deviceId, session: session)
        guard cleared > 0 else { return false }
        let unreadSeq = session.unreadSequence ?? 0
        return unreadSeq <= cleared
    }

    func clearSessions(
        deviceId: String,
        marks: [ClearMark],
        alsoMarkRead readMarks: [ReadMark] = [],
        banner: String? = nil
    ) {
        let normalized = marks.compactMap { m -> ClearMark? in
            guard !m.sessionId.isEmpty else { return nil }
            return ClearMark(sessionId: m.sessionId, sequence: max(m.sequence, 1))
        }
        guard !normalized.isEmpty else { return }
        Haptics.light()

        // Mark unread idle sessions read atomically so Desktop & Mobile agree on readAndIdle + cleared
        let filteredReadMarks = readMarks.filter { mark in
            guard !mark.sessionId.isEmpty, mark.sequence > 0 else { return false }
            let key = "\(deviceId):\(mark.sessionId)"
            let current = max(
                localReadCursors[key] ?? 0,
                hubReadCursors[deviceId]?[mark.sessionId] ?? 0
            )
            return mark.sequence > current
        }
        if !filteredReadMarks.isEmpty {
            for mark in filteredReadMarks {
                let key = "\(deviceId):\(mark.sessionId)"
                localReadCursors[key] = max(localReadCursors[key] ?? 0, mark.sequence)
            }
            cache.save(localReadCursors, as: "read_cursors")
        }

        for m in normalized {
            let key = "\(deviceId):\(m.sessionId)"
            localClearedCursors[key] = max(localClearedCursors[key] ?? 0, m.sequence)
        }
        cache.save(localClearedCursors, as: "cleared_cursors")
        invalidateAllProjections()
        if let banner { showBanner(banner) }
        guard let sPath = spacePath else { return }
        let clearPayload = ClearSyncRequest(deviceId: deviceId, items: normalized)
        let readPayload = filteredReadMarks.isEmpty ? nil : ReadSyncRequest(deviceId: deviceId, items: filteredReadMarks)
        Task {
            if let readPayload {
                try? await bridge.requestVoid("POST", path: "\(sPath)/read", body: readPayload)
            }
            try? await bridge.requestVoid("POST", path: "\(sPath)/cleared", body: clearPayload)
        }
    }

    func clearSingleTopic(deviceId: String, topicId: String, unreadSequence: Int64, title: String) {
        let readMarks = unreadSequence > 0 ? [ReadMark(sessionId: topicId, sequence: unreadSequence)] : []
        clearSessions(
            deviceId: deviceId,
            marks: [ClearMark(sessionId: topicId, sequence: max(unreadSequence, 1))],
            alsoMarkRead: readMarks,
            banner: "已清理话题「\(title)」并同步桌面"
        )
    }

    func restoreSessions(deviceId: String, sessionIds: [String], banner: String? = nil) {
        let ids = sessionIds.filter { !$0.isEmpty }
        guard !ids.isEmpty else { return }
        Haptics.light()
        let marks = ids.map { ClearMark(sessionId: $0, sequence: 0) }
        for id in ids {
            localClearedCursors["\(deviceId):\(id)"] = 0
        }
        cache.save(localClearedCursors, as: "cleared_cursors")
        invalidateAllProjections()
        if let banner { showBanner(banner) }
        guard let sPath = spacePath else { return }
        let payload = ClearSyncRequest(deviceId: deviceId, items: marks)
        Task {
            try? await bridge.requestVoid("POST", path: "\(sPath)/cleared", body: payload)
        }
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

        for mark in filtered {
            let key = "\(deviceId):\(mark.sessionId)"
            localReadCursors[key] = max(localReadCursors[key] ?? 0, mark.sequence)
        }
        cache.save(localReadCursors, as: "read_cursors")
        invalidateAllProjections()

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
            banner: "「\(row.name)」已标为已读并同步到桌面"
        )
    }

    func markAllRead() {
        var grouped: [String: [ReadMark]] = [:]
        for row in cachedFeedRows where !row.unreadSessionMarks.isEmpty {
            grouped[row.device.id, default: []].append(contentsOf: row.unreadSessionMarks)
        }
        guard !grouped.isEmpty else { return }
        Haptics.medium()
        for (devId, marks) in grouped {
            markSessionsRead(deviceId: devId, marks: marks)
        }
        showBanner("全部已读状态已同步至桌面")
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
        invalidateAllProjections()
    }

    // MARK: - Composer Metadata (Multi-Provider Catalog, Starred Favorites, Skills) & Attachments

    func composerScopeKey(deviceId: String, agentId: String, providerId: String?) -> String {
        "\(deviceId)|\(agentId)|\(providerId ?? "")"
    }

    func providerCatalogs(deviceId: String, fallbackAgent: ArchiveRecord? = nil) -> [ProviderCatalog] {
        if let list = providersByDevice[deviceId], !list.isEmpty {
            return list
        }
        if let agent = fallbackAgent, let prov = agent.provider, !prov.isEmpty {
            return [ProviderCatalog(
                id: prov,
                name: prov,
                type: prov,
                pluginId: nil,
                models: agent.models,
                commands: nil
            )]
        }
        return []
    }

    func skills(deviceId: String, agentId: String, providerId: String?) -> [MessageReference] {
        let exact = composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: providerId)
        if let list = skillsByScopeKey[exact], !list.isEmpty { return list }
        let fallback = composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: nil)
        return skillsByScopeKey[fallback] ?? []
    }

    func starredModels(deviceId: String) -> [String: Set<String>] {
        let map = starredModelsByDevice[deviceId] ?? [:]
        return map.mapValues { Set($0) }
    }

    func isModelStarred(deviceId: String, providerId: String, modelId: String) -> Bool {
        starredModelsByDevice[deviceId]?[providerId]?.contains(modelId) == true
    }

    func toggleStarredModel(deviceId: String, providerId: String, modelId: String) {
        guard !providerId.isEmpty, !modelId.isEmpty else { return }
        Haptics.light()
        var deviceMap = starredModelsByDevice[deviceId] ?? [:]
        var list = deviceMap[providerId] ?? []
        if let idx = list.firstIndex(of: modelId) {
            list.remove(at: idx)
        } else {
            list.append(modelId)
        }
        if list.isEmpty {
            deviceMap.removeValue(forKey: providerId)
        } else {
            deviceMap[providerId] = list
        }
        starredModelsByDevice[deviceId] = deviceMap
        cache.save(starredModelsByDevice, as: "starred_models")

        guard let sPath = spacePath else { return }
        let payload = deviceMap
        Task {
            if let saved: [String: [String]] = try? await bridge.request("PUT", path: "\(sPath)/starred-models/\(deviceId)", body: payload) {
                if self.starredModelsByDevice[deviceId] != saved {
                    self.starredModelsByDevice[deviceId] = saved
                    self.cache.save(self.starredModelsByDevice, as: "starred_models")
                }
            }
        }
    }

    func loadComposerMeta(
        deviceId: String,
        agentId: String,
        chatId: String? = nil,
        sessionId: String? = nil,
        providerId: String? = nil
    ) async {
        guard let sPath = spacePath else { return }
        var params: [String] = []
        if !agentId.isEmpty { params.append("agent=\(urlEncode(agentId))") }
        if let chatId, !chatId.isEmpty { params.append("chat=\(urlEncode(chatId))") }
        if let sessionId, !sessionId.isEmpty { params.append("session=\(urlEncode(sessionId))") }
        if let providerId, !providerId.isEmpty { params.append("provider=\(urlEncode(providerId))") }
        let qs = params.isEmpty ? "" : "?\(params.joined(separator: "&"))"
        guard let meta: ComposerMeta = try? await bridge.request("GET", path: "\(sPath)/composer-meta/\(deviceId)\(qs)") else {
            return
        }
        if !meta.providers.isEmpty && providersByDevice[deviceId] != meta.providers {
            providersByDevice[deviceId] = meta.providers
            cache.save(providersByDevice, as: "providers_by_device")
        }
        // Merge remote starred models with local cache (remote authoritative when non-empty)
        if !meta.starredModels.isEmpty || starredModelsByDevice[deviceId] == nil {
            if starredModelsByDevice[deviceId] != meta.starredModels {
                starredModelsByDevice[deviceId] = meta.starredModels
                cache.save(starredModelsByDevice, as: "starred_models")
            }
        }
        let exactKey = composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: providerId)
        if skillsByScopeKey[exactKey] != meta.skills {
            skillsByScopeKey[exactKey] = meta.skills
        }
        if providerId == nil || skillsByScopeKey[composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: nil)] == nil {
            skillsByScopeKey[composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: nil)] = meta.skills
        }
    }

    func uploadAttachment(
        deviceId: String,
        chatId: String?,
        agentId: String,
        fileName: String,
        data: Data
    ) async throws -> AttachmentRef {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let req = AttachmentUploadRequest(
            chatId: chatId,
            agentId: chatId == nil ? agentId : nil,
            name: fileName,
            data: data.base64EncodedString()
        )
        return try await bridge.request("POST", path: "\(sPath)/attachments/\(deviceId)", body: req)
    }

    /// Returns grouped `@` mention candidates (Topics, Chats, Agents) for live Composer suggestions.
    func mentionCandidates(
        deviceId: String,
        currentAgentId: String,
        currentSessionId: String?,
        query rawQuery: String
    ) -> [(label: String, items: [MessageReference])] {
        let q = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let records = mergedIndex(for: deviceId)

        var agentsById: [String: String] = [:]
        var chatsById: [String: ArchiveRecord] = [:]
        for r in records {
            if r.kind == "agent" { agentsById[r.id] = (r.title?.isEmpty == false) ? r.title! : r.id }
            if r.kind == "chat" { chatsById[r.id] = r }
        }

        var topicRefs: [(TimeInterval, MessageReference)] = []
        var chatRefs: [(TimeInterval, MessageReference)] = []
        for sess in records where sess.kind == "session" && sess.id != currentSessionId {
            guard let cid = sess.chatId, let chat = chatsById[cid] else { continue }
            let agentName = sess.agentId.flatMap { agentsById[$0] } ?? chat.agentId.flatMap { agentsById[$0] } ?? ""
            let chatTitle = (chat.title?.isEmpty == false) ? chat.title! : "主对话"
            let t = LeverDate.timestamp(sess.messageAt ?? sess.createdAt)
            if sess.type == "topic" {
                let title = (sess.title?.isEmpty == false) ? sess.title! : "独立话题"
                let desc = [agentName, chatTitle].filter { !$0.isEmpty }.joined(separator: " · ")
                if q.isEmpty || title.lowercased().contains(q) || desc.lowercased().contains(q) {
                    topicRefs.append((t, MessageReference(
                        kind: "topic", name: title, refId: sess.id, path: nil,
                        provider: nil, description: desc, argumentHint: nil, start: nil, end: nil
                    )))
                }
            } else if sess.type == "main" {
                let desc = [agentName, "主对话"].filter { !$0.isEmpty }.joined(separator: " · ")
                if q.isEmpty || chatTitle.lowercased().contains(q) || desc.lowercased().contains(q) {
                    chatRefs.append((t, MessageReference(
                        kind: "chat", name: chatTitle, refId: sess.id, path: nil,
                        provider: nil, description: desc, argumentHint: nil, start: nil, end: nil
                    )))
                }
            }
        }

        var agentRefs: [MessageReference] = []
        for r in records where r.kind == "agent" && r.id != currentAgentId {
            let name = (r.title?.isEmpty == false) ? r.title! : r.id
            let desc = r.description ?? r.model ?? ""
            if q.isEmpty || name.lowercased().contains(q) || desc.lowercased().contains(q) {
                agentRefs.append(MessageReference(
                    kind: "agent", name: name, refId: r.id, path: nil,
                    provider: nil, description: desc, argumentHint: nil, start: nil, end: nil
                ))
            }
        }

        var groups: [(String, [MessageReference])] = []
        let sortedTopics = topicRefs.sorted { $0.0 > $1.0 }.prefix(24).map(\.1)
        if !sortedTopics.isEmpty { groups.append(("话题", Array(sortedTopics))) }
        let sortedChats = chatRefs.sorted { $0.0 > $1.0 }.prefix(12).map(\.1)
        if !sortedChats.isEmpty { groups.append(("对话", Array(sortedChats))) }
        if !agentRefs.isEmpty { groups.append(("协作 Agent", agentRefs)) }
        return groups
    }

    // MARK: - Commands (Send / Topic / Model Selection / Approve / Stop / Resume)

    func sendMessage(
        deviceId: String,
        agentId: String,
        chatId: String?,
        isPrivate: Bool,
        text: String,
        mode: SendTargetMode,
        workingCopyId: String? = nil,
        selection: ModelSelection? = nil,
        attachmentIds: [String]? = nil,
        references: [MessageReference]? = nil,
        delivery: String = "queue"
    ) async throws -> CommandReceipt {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = !(attachmentIds ?? []).isEmpty
        guard !trimmed.isEmpty || hasAttachments else { throw LeverCoreError.message("请输入消息内容或添加附件") }

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
            selection: selection,
            attachmentIds: (attachmentIds?.isEmpty == false) ? attachmentIds : nil,
            references: (references?.isEmpty == false) ? references : nil,
            answer: nil
        )

        let item: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        Haptics.light()
        if let targetChat = item.receipt.chatId ?? chatId {
            let key = chatKey(deviceId: deviceId, chatId: targetChat, isPrivate: isPrivate)
            if case .topicReply(let tid) = mode {
                await refreshTopic(deviceId: deviceId, chatId: targetChat, isPrivate: isPrivate, topicId: tid)
            } else {
                await refreshChatByKey(key)
            }
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
            selection: nil,
            answer: allowRun ? nil : answer
        )
        let _: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        Haptics.success()
        if let tid = activeTopicId, tid == request.sessionId {
            await refreshTopic(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate, topicId: tid)
        } else {
            await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
        }
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
            selection: nil,
            answer: nil
        )
        let _: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        Haptics.medium()
        if let tid = activeTopicId {
            await refreshTopic(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate, topicId: tid)
        } else {
            await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
        }
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
            selection: nil,
            answer: nil
        )
        let _: InboxItem = try await bridge.request("POST", path: "\(sPath)/commands", body: intent)
        await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    // MARK: - Push Settings & Desktop-Active Silent Policy

    func refreshPushSettings() async {
        guard let sPath = spacePath else { return }
        if let settings: PushSettings = try? await bridge.request("GET", path: "\(sPath)/push") {
            pushSettings = settings
            if let remoteSilence = settings.silenceWhenDesktopActive {
                silenceWhenDesktopActive = remoteSilence
            }
        }
    }

    func setSilenceWhenDesktopActive(_ enabled: Bool) async {
        silenceWhenDesktopActive = enabled
        guard !isDirectMode else { return }
        await syncSilencePreferenceToHub()
    }

    private func syncSilencePreferenceToHub() async {
        guard let sPath = spacePath, !isDirectMode else { return }
        if let updated: PushSettings = try? await bridge.request(
            "PATCH",
            path: "\(sPath)/push",
            body: PushPreferencesRequest(silenceWhenDesktopActive: silenceWhenDesktopActive)
        ) {
            pushSettings = updated
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

    // MARK: - Memoized Feed, Search, Drawer & Timeline Projections

    func mergedIndex(for deviceId: String) -> [ArchiveRecord] {
        let _ = dataVersion
        if let hit = mergedIndexCache[deviceId] {
            return hit
        }
        var combined: [String: ArchiveRecord] = [:]
        for r in privateIndexByDevice[deviceId] ?? [] {
            combined["\(r.kind):\(r.id)"] = r
        }
        for r in indexByDevice[deviceId] ?? [] {
            combined["\(r.kind):\(r.id)"] = r
        }
        let values = Array(combined.values)
        mergedIndexCache[deviceId] = values
        return values
    }

    private func rebuildFeedProjection() {
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
                    agentRecordCache["\(device.id):\(r.id)"] = r
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

                        if sess.type == "topic" && !isSessionCleared(deviceId: device.id, session: sess) {
                            let priority: Int
                            let cueStatus: String
                            if pending > 0 || status == "waiting_user" {
                                priority = 4
                                cueStatus = "approval"
                            } else if status == "running" || status == "starting" {
                                priority = 3
                                cueStatus = "running"
                            } else if unread {
                                priority = 2
                                cueStatus = "unread"
                            } else {
                                priority = 1
                                cueStatus = "idle"
                            }
                            let cueCanClear = pending == 0 && !isActiveRunStatus(status)
                            let cue = ActiveTopicCue(
                                id: sess.id,
                                chatId: chat.id,
                                isPrivate: chat.isPrivate,
                                title: (sess.title?.isEmpty == false) ? sess.title! : "独立话题",
                                status: cueStatus,
                                pendingCount: pending,
                                isUnread: unread,
                                unreadSequence: sess.unreadSequence ?? 0,
                                canClear: cueCanClear,
                                replyCount: sess.replyCount ?? 0,
                                preview: sess.preview ?? "",
                                updatedText: LeverDate.compact(sessTimeRaw)
                            )
                            topicCandidates.append((priority, sessTime, cue))
                        }
                    }
                }

                // Prefer the most recent chat that actually has sessions over empty "New chat" stubs
                let latestChat = chats.first { !(sessionsByChat[$0.id] ?? []).isEmpty } ?? chats.first
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

                let sortedTopics = topicCandidates.sorted { lhs, rhs in
                    if lhs.priority != rhs.priority { return lhs.priority > rhs.priority }
                    return lhs.time > rhs.time
                }.prefix(4).map(\.cue)

                rows.append(AgentFeedRow(
                    id: "\(device.id):\(aid)",
                    device: device,
                    agentId: aid,
                    name: name,
                    avatar: agent?.avatar,
                    avatarSpec: agent?.avatarSpec,
                    model: agent?.model,
                    provider: agent?.provider,
                    models: agent?.models ?? [],
                    latestChat: latestChat,
                    chatCount: chats.count,
                    unreadSessionCount: unreadSessions,
                    pendingApprovalCount: pendingApprovals,
                    isRunning: isRunning,
                    sortTimestamp: sortTime,
                    timeText: LeverDate.compact(displayTimeRaw),
                    preview: preview,
                    isPrivate: latestChat?.isPrivate ?? false,
                    activeTopics: Array(sortedTopics),
                    unreadSessionMarks: unreadMarks
                ))
            }
        }

        let sorted = rows.sorted { lhs, rhs in
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

        if cachedFeedRows != sorted {
            cachedFeedRows = sorted
        }
        let unreadSum = sorted.reduce(0) { $0 + $1.unreadSessionCount }
        let pendingSum = sorted.reduce(0) { $0 + $1.pendingApprovalCount }
        let runningSum = sorted.filter(\.isRunning).count
        if cachedTotalUnread != unreadSum { cachedTotalUnread = unreadSum }
        if cachedTotalPending != pendingSum { cachedTotalPending = pendingSum }
        if cachedTotalRunning != runningSum { cachedTotalRunning = runningSum }
    }

    func globalSearch(query rawQuery: String) -> [GlobalSearchHit] {
        let q = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        var hits: [GlobalSearchHit] = []

        for row in cachedFeedRows {
            if row.name.lowercased().contains(q) || row.preview.lowercased().contains(q) {
                hits.append(GlobalSearchHit(
                    id: "agent:\(row.id)",
                    kind: .agent,
                    deviceId: row.device.id,
                    agentId: row.agentId,
                    agentName: row.name,
                    avatar: row.avatar,
                    avatarSpec: row.avatarSpec,
                    chatId: row.latestChat?.id,
                    topicId: nil,
                    isPrivate: row.isPrivate,
                    title: row.name,
                    subtitle: row.preview,
                    timeText: row.timeText
                ))
            }

            let records = mergedIndex(for: row.device.id)
            let chats = chatsForAgent(deviceId: row.device.id, agentId: row.agentId)
            let chatMap = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, $0) })

            for chat in chats {
                let cTitle = (chat.title?.isEmpty == false) ? chat.title! : "主对话"
                if cTitle.lowercased().contains(q) {
                    hits.append(GlobalSearchHit(
                        id: "chat:\(row.device.id):\(chat.id)",
                        kind: .chat,
                        deviceId: row.device.id,
                        agentId: row.agentId,
                        agentName: row.name,
                        avatar: row.avatar,
                        avatarSpec: row.avatarSpec,
                        chatId: chat.id,
                        topicId: nil,
                        isPrivate: chat.isPrivate,
                        title: cTitle,
                        subtitle: "\(row.name) · 历史对话",
                        timeText: LeverDate.compact(chat.updatedAt ?? chat.createdAt)
                    ))
                }
            }

            for sess in records where sess.kind == "session" && sess.type == "topic" {
                guard let cid = sess.chatId, let chat = chatMap[cid] else { continue }
                let tTitle = (sess.title?.isEmpty == false) ? sess.title! : "独立话题"
                let tPreview = sess.preview ?? ""
                if tTitle.lowercased().contains(q) || tPreview.lowercased().contains(q) {
                    hits.append(GlobalSearchHit(
                        id: "topic:\(row.device.id):\(sess.id)",
                        kind: .topic,
                        deviceId: row.device.id,
                        agentId: row.agentId,
                        agentName: row.name,
                        avatar: row.avatar,
                        avatarSpec: row.avatarSpec,
                        chatId: cid,
                        topicId: sess.id,
                        isPrivate: chat.isPrivate,
                        title: tTitle,
                        subtitle: "\(row.name) · \(tPreview.isEmpty ? (chat.title ?? "话题") : tPreview)",
                        timeText: LeverDate.compact(sess.messageAt ?? sess.createdAt)
                    ))
                }
            }
        }
        return hits
    }

    /// Memoized O(1) drawer projection for right-edge swipe drawer (zero stutter while dragging!).
    func agentDrawerData(deviceId: String, agentId: String) -> AgentDrawerData {
        let _ = dataVersion
        let cacheKey = "\(deviceId):\(agentId)"
        if let hit = drawerDataCache[cacheKey] {
            return hit
        }

        let records = mergedIndex(for: deviceId)
        let chats = chatsForAgent(deviceId: deviceId, agentId: agentId)
        var sessionsByChat: [String: [ArchiveRecord]] = [:]
        for r in records where r.kind == "session" {
            if let cid = r.chatId {
                sessionsByChat[cid, default: []].append(r)
            }
        }

        var activeTopics: [AgentDrawerTopicItem] = []
        var clearedTopics: [AgentDrawerTopicItem] = []
        var activeChats: [AgentDrawerChatItem] = []
        var clearedChats: [AgentDrawerChatItem] = []

        for chat in chats {
            let chatTitle = (chat.title?.isEmpty == false) ? chat.title! : "未命名对话"
            let sessions = sessionsByChat[chat.id] ?? []
            let mainSess = sessions.first { $0.type == "main" }
            let topicSessions = sessions.filter { $0.type == "topic" }

            // Match Desktop AgentSidebar: skip completely empty 0-session "New chat" stubs
            if mainSess == nil && topicSessions.isEmpty {
                continue
            }

            var chatActiveTopicCount = 0
            var chatUnreadCount = 0
            var chatPendingCount = 0
            var chatRunning = false
            var bestPreview = ""
            var bestTime = max(LeverDate.timestamp(chat.updatedAt), LeverDate.timestamp(chat.createdAt))
            var bestTimeRaw = chat.updatedAt ?? chat.createdAt

            var activeTopicClearMarks: [ClearMark] = []
            var activeTopicReadMarks: [ReadMark] = []
            var latestClearedTopicId: String?
            var latestClearedTopicTime: TimeInterval = -1

            var mainUnread = false
            var mainPending = 0
            var mainRunning = false
            var mainCleared = false

            if let mainSess {
                mainUnread = isSessionUnread(deviceId: deviceId, session: mainSess)
                mainPending = mainSess.pendingCount ?? 0
                mainRunning = isActiveRunStatus(mainSess.activeStatus)
                mainCleared = isSessionCleared(deviceId: deviceId, session: mainSess)
                if mainUnread { chatUnreadCount += 1 }
                chatPendingCount += mainPending
                if mainRunning { chatRunning = true }
                if let p = mainSess.preview, !p.isEmpty { bestPreview = p }
                let mt = LeverDate.timestamp(mainSess.messageAt ?? mainSess.createdAt)
                if mt > bestTime {
                    bestTime = mt
                    bestTimeRaw = mainSess.messageAt ?? mainSess.createdAt
                }
            }

            for sess in topicSessions {
                let unread = isSessionUnread(deviceId: deviceId, session: sess)
                let pending = sess.pendingCount ?? 0
                let running = isActiveRunStatus(sess.activeStatus)
                if unread { chatUnreadCount += 1 }
                chatPendingCount += pending
                if running { chatRunning = true }

                let cleared = isSessionCleared(deviceId: deviceId, session: sess)
                let tRaw = (sess.messageAt?.isEmpty == false) ? sess.messageAt : sess.createdAt
                let tSort = LeverDate.timestamp(tRaw)
                if tSort > bestTime {
                    bestTime = tSort
                    bestTimeRaw = tRaw
                }

                if cleared {
                    if tSort > latestClearedTopicTime {
                        latestClearedTopicTime = tSort
                        latestClearedTopicId = sess.id
                    }
                } else {
                    chatActiveTopicCount += 1
                    if !running && pending == 0 {
                        let uSeq = sess.unreadSequence ?? 0
                        activeTopicClearMarks.append(ClearMark(sessionId: sess.id, sequence: max(uSeq, 1)))
                        if unread && uSeq > 0 {
                            activeTopicReadMarks.append(ReadMark(sessionId: sess.id, sequence: uSeq))
                        }
                    }
                }

                let status: String
                if pending > 0 || sess.activeStatus == "waiting_user" {
                    status = "approval"
                } else if running {
                    status = "running"
                } else if unread {
                    status = "unread"
                } else {
                    status = "idle"
                }

                // Allow clearing any idle (non-running, non-pending) topic even if unread (auto-marks read)
                let canClear = !running && pending == 0 && !cleared

                let item = AgentDrawerTopicItem(
                    id: sess.id,
                    chatId: chat.id,
                    chatTitle: chatTitle,
                    isPrivate: chat.isPrivate,
                    title: (sess.title?.isEmpty == false) ? sess.title! : "独立话题",
                    preview: sess.preview ?? "",
                    status: status,
                    isUnread: unread,
                    isCleared: cleared,
                    canClear: canClear,
                    unreadSequence: sess.unreadSequence ?? 0,
                    replyCount: sess.replyCount ?? 0,
                    sortTimestamp: tSort,
                    timeText: LeverDate.compact(tRaw)
                )
                if cleared {
                    clearedTopics.append(item)
                } else {
                    activeTopics.append(item)
                }
            }

            // Evaluate Chat cleared status 1:1 with Lever Desktop:
            // - Normal Chat (has mainSess): reflects mainSess's own cleared state independently of Topics!
            // - Topic-only Chat (mainSess == nil): cleared once all its Topics are cleared!
            let chatIsCleared: Bool
            let chatCanClear: Bool
            let clearMarksForChat: [ClearMark]
            let clearReadMarksForChat: [ReadMark]
            let restoreSessionIds: [String]

            if let mainSess {
                chatIsCleared = mainCleared
                chatCanClear = !mainCleared && !mainRunning && mainPending == 0
                let uSeq = mainSess.unreadSequence ?? 0
                clearMarksForChat = [ClearMark(sessionId: mainSess.id, sequence: max(uSeq, 1))]
                clearReadMarksForChat = (mainUnread && uSeq > 0) ? [ReadMark(sessionId: mainSess.id, sequence: uSeq)] : []
                restoreSessionIds = [mainSess.id]
            } else {
                chatIsCleared = chatActiveTopicCount == 0 && !chatRunning && chatPendingCount == 0
                chatCanClear = !chatIsCleared && !chatRunning && chatPendingCount == 0 && !activeTopicClearMarks.isEmpty
                clearMarksForChat = activeTopicClearMarks
                clearReadMarksForChat = activeTopicReadMarks
                restoreSessionIds = latestClearedTopicId.map { [$0] } ?? []
            }

            let chatItem = AgentDrawerChatItem(
                id: chat.id,
                restoreSessionIds: restoreSessionIds,
                isPrivate: chat.isPrivate,
                title: chatTitle,
                preview: bestPreview.isEmpty ? (topicSessions.isEmpty ? "暂无消息" : "\(topicSessions.count) 个话题") : bestPreview,
                topicCount: topicSessions.count,
                unreadCount: chatUnreadCount,
                isRunning: chatRunning,
                pendingCount: chatPendingCount,
                isCleared: chatIsCleared,
                canClear: chatCanClear,
                clearMarks: clearMarksForChat,
                clearReadMarks: clearReadMarksForChat,
                sortTimestamp: bestTime,
                timeText: LeverDate.compact(bestTimeRaw)
            )
            if chatIsCleared {
                clearedChats.append(chatItem)
            } else {
                activeChats.append(chatItem)
            }
        }

        let topicSort: (AgentDrawerTopicItem, AgentDrawerTopicItem) -> Bool = { lhs, rhs in
            func prio(_ s: String) -> Int {
                switch s {
                case "approval": return 4
                case "running": return 3
                case "unread": return 2
                default: return 1
                }
            }
            let lp = prio(lhs.status), rp = prio(rhs.status)
            if lp != rp { return lp > rp }
            return lhs.sortTimestamp > rhs.sortTimestamp
        }

        let result = AgentDrawerData(
            activeTopics: activeTopics.sorted(by: topicSort),
            activeChats: activeChats.sorted { $0.sortTimestamp > $1.sortTimestamp },
            clearedTopics: clearedTopics.sorted { $0.sortTimestamp > $1.sortTimestamp },
            clearedChats: clearedChats.sorted { $0.sortTimestamp > $1.sortTimestamp }
        )
        drawerDataCache[cacheKey] = result
        return result
    }

    func agentRecord(deviceId: String, agentId: String) -> ArchiveRecord? {
        let _ = dataVersion
        let key = "\(deviceId):\(agentId)"
        if let hit = agentRecordCache[key] {
            return hit
        }
        if let found = mergedIndex(for: deviceId).first(where: { $0.kind == "agent" && $0.id == agentId }) {
            agentRecordCache[key] = found
            return found
        }
        return nil
    }

    func chatsForAgent(deviceId: String, agentId: String) -> [ArchiveRecord] {
        mergedIndex(for: deviceId)
            .filter { $0.kind == "chat" && (($0.agentId == agentId) || ("__chat:\($0.id)" == agentId)) }
            .sorted {
                max(LeverDate.timestamp($0.updatedAt), LeverDate.timestamp($0.createdAt)) >
                max(LeverDate.timestamp($1.updatedAt), LeverDate.timestamp($1.createdAt))
            }
    }

    /// Memoized O(1) Desktop-aligned timeline snapshot:
    /// - Unions index sessions with detailed chat sessions so Topics always render immediately
    /// - Tracks real `mainHasQueuedRuns` (prevents false "主会话排队已暂停" banner when 0 runs queued)
    /// - Projects authentic session/run `model` & `effort` for both main Chat and every Topic
    func timelineSnapshot(deviceId: String, chatId: String, isPrivate: Bool) -> TimelineSnapshot {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let _ = dataVersion
        let _ = chatVersionByKey[key]
        if let hit = timelineSnapshotCache[key] {
            return hit
        }
        let snapshot = computeTimelineSnapshot(deviceId: deviceId, chatId: chatId, key: key)
        timelineSnapshotCache[key] = snapshot
        return snapshot
    }

    private func computeTimelineSnapshot(deviceId: String, chatId: String, key: String) -> TimelineSnapshot {
        let detailRecords = chatRecordsByKey[key] ?? []
        let indexRecords = mergedIndex(for: deviceId)

        // Union sessions from index and detail (detail takes precedence when loaded)
        var sessionMap: [String: ArchiveRecord] = [:]
        for r in indexRecords where r.kind == "session" && r.chatId == chatId {
            sessionMap[r.id] = r
        }
        for r in detailRecords where r.kind == "session" && r.chatId == chatId {
            sessionMap[r.id] = r
        }
        let sessions = Array(sessionMap.values)
        let mainSess = sessions.first { $0.type == "main" }
        let topicSessions = sessions.filter { $0.type == "topic" }

        let allRuns = detailRecords
            .filter { $0.kind == "run" && $0.chatId == chatId && $0.superseded != true }
            .sorted { ($0.sequence ?? 0) < ($1.sequence ?? 0) }

        var requestsByRun: [String: [ArchiveRecord]] = [:]
        for req in detailRecords where req.kind == "request" && req.chatId == chatId {
            if let rid = req.runId {
                requestsByRun[rid, default: []].append(req)
            }
        }

        var runsBySession: [String: [ArchiveRecord]] = [:]
        var runCreatedById: [String: TimeInterval] = [:]
        for run in allRuns {
            if let sid = run.sessionId {
                runsBySession[sid, default: []].append(run)
            }
            runCreatedById[run.id] = LeverDate.timestamp(run.createdAt)
        }

        var entries: [TimelineEntry] = []
        let mainRuns = mainSess.flatMap { runsBySession[$0.id] } ?? []
        for run in mainRuns {
            entries.append(.mainRun(run, requests: requestsByRun[run.id] ?? []))
        }

        let mainHasQueuedRuns = mainRuns.contains { $0.status == "queued" }
        let latestMainModelRun = mainRuns.last { $0.model?.isEmpty == false }
        let mainProvider = latestMainModelRun?.provider ?? ((mainSess?.provider?.isEmpty == false) ? mainSess?.provider : nil)
        let mainModel = latestMainModelRun?.model ?? ((mainSess?.model?.isEmpty == false) ? mainSess?.model : nil)
        let mainEffort = latestMainModelRun?.effort ?? ((mainSess?.effort?.isEmpty == false) ? mainSess?.effort : nil)
        let mainFast = latestMainModelRun?.fast ?? (mainSess?.fast ?? false)
        let oldestMainSeq = mainRuns.compactMap(\.sequence).min()

        var topics: [TopicSummary] = []
        topics.reserveCapacity(topicSessions.count)

        for sess in topicSessions {
            let tRuns = runsBySession[sess.id] ?? []
            var tReqsByRun: [String: [ArchiveRecord]] = [:]
            var pendingReq: ArchiveRecord?
            var files: [FileStat] = []
            var seenFiles = Set<String>()
            var previewLines: [TopicPreviewLine] = []

            for (idx, run) in tRuns.enumerated() {
                let reqs = requestsByRun[run.id] ?? []
                tReqsByRun[run.id] = reqs
                if pendingReq == nil, let p = reqs.first(where: { $0.status == "pending" }) {
                    pendingReq = p
                }
                for f in run.files ?? [] where !seenFiles.contains(f.name) {
                    seenFiles.insert(f.name)
                    files.append(f)
                }
                if idx > 0, let inp = run.text?.trimmingCharacters(in: .whitespacesAndNewlines), !inp.isEmpty {
                    previewLines.append(TopicPreviewLine(id: "u:\(run.id)", isUser: true, text: inp))
                }
                if let lastText = (run.items ?? []).last(where: { $0.kind == "text" && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?.text {
                    previewLines.append(TopicPreviewLine(id: "a:\(run.id)", isUser: false, text: lastText))
                } else if let err = run.error, !err.isEmpty {
                    previewLines.append(TopicPreviewLine(id: "e:\(run.id)", isUser: false, text: err))
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

            let latestModelRun = tRuns.last { $0.model?.isEmpty == false }
            let topicModel = latestModelRun?.model ?? ((sess.model?.isEmpty == false) ? sess.model : nil)
            let topicEffort = latestModelRun?.effort ?? ((sess.effort?.isEmpty == false) ? sess.effort : nil)
            let topicFast = latestModelRun?.fast ?? (sess.fast ?? false)
            let topicProvider = latestModelRun?.provider ?? ((sess.provider?.isEmpty == false) ? sess.provider : nil)
            let oldestTopicSeq = tRuns.compactMap(\.sequence).min()

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
            let isActive = status == "approval" || status == "running"
            let unread = isSessionUnread(deviceId: deviceId, session: sess)
            let cleared = isSessionCleared(deviceId: deviceId, session: sess, isActiveRun: isActive)

            let summary = TopicSummary(
                id: sess.id,
                chatId: chatId,
                title: title,
                rootPrompt: rootPrompt.isEmpty ? title : rootPrompt,
                latestReplyText: latestReplyText,
                latestReplyIsUser: latestIsUser,
                previewLines: Array(previewLines.suffix(3)),
                pendingRequest: pendingReq,
                status: status,
                model: topicModel,
                effort: topicEffort,
                fast: topicFast,
                provider: topicProvider,
                replyCount: max(tRuns.count, sess.replyCount ?? 0),
                unreadSequence: sess.unreadSequence ?? 0,
                isUnread: unread,
                isCleared: cleared,
                canClear: !cleared && !isActive,
                anchorTimestamp: anchorTime,
                updatedTimestamp: updatedTime,
                fileStats: files,
                runs: tRuns,
                requestsByRun: tReqsByRun,
                oldestRunSequence: oldestTopicSeq
            )
            topics.append(summary)
            entries.append(.topicCard(summary))
        }

        entries.sort { $0.sortDate < $1.sortDate }
        topics.sort { $0.updatedTimestamp > $1.updatedTimestamp }
        return TimelineSnapshot(
            entries: entries,
            topics: topics,
            mainSession: mainSess,
            mainHasQueuedRuns: mainHasQueuedRuns,
            mainProvider: mainProvider,
            mainModel: mainModel,
            mainEffort: mainEffort,
            mainFast: mainFast,
            oldestMainSequence: oldestMainSeq
        )
    }

    // MARK: - Helpers

    private func restoreCachedWorkspace() async {
        account = await cache.loadAsync("account", as: AccountInfo.self)
        devices = await cache.loadAsync("devices", as: [DeviceInfo].self) ?? []
        hubReadCursors = await cache.loadAsync("hub_read_cursors", as: [String: [String: Int64]].self) ?? [:]
        hubClearedCursors = await cache.loadAsync("hub_cleared_cursors", as: [String: [String: Int64]].self) ?? [:]
        for dev in hostDevices {
            if let cached = await cache.loadAsync("index_\(dev.id)", as: CachedArchiveState.self) {
                indexByDevice[dev.id] = cached.records
                if let c = cached.cursor { indexCursors[dev.id] = c }
            }
            if let priv = await cache.loadAsync("priv_\(dev.id)", as: [ArchiveRecord].self) {
                privateIndexByDevice[dev.id] = priv
            }
        }
        invalidateAllProjections()
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
                if self.activeChatKey != nil || self.cachedTotalRunning > 0 || self.cachedTotalPending > 0 {
                    intervalNs = 2_500_000_000
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
