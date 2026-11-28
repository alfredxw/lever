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

    // Two-stage lazy tool steps hydration (keyed by "\(deviceId):\(runId)")
    var runStepsByKey: [String: [RunItem]] = [:]
    var loadingRunStepsKeys: Set<String> = []

    // Pre-computed O(1) feed projections & reactive revision tokens
    var cachedFeedRows: [AgentFeedRow] = []
    var cachedTotalUnread: Int = 0
    var cachedTotalPending: Int = 0
    var cachedTotalRunning: Int = 0
    var dataVersion: Int = 0
    var chatVersionByKey: [String: Int] = [:]

    // Bidirectional read-state, cleared-state, and Composer metadata (providers, favorites, skills)
    var hubReadCursors: [String: [String: Int64]] = [:]
    var localReadCursors: [String: Int64] = [:]
    var hubClearedCursors: [String: [String: Int64]] = [:]
    var localClearedCursors: [String: Int64] = [:] // >0 cleared up to seq; 0 explicitly restored
    var pinnedAgentKeys: [String] = []
    var providersByDevice: [String: [ProviderCatalog]] = [:]
    var skillsByScopeKey: [String: [MessageReference]] = [:]
    var starredModelsByDevice: [String: [String: [String]]] = [:]

    @ObservationIgnored var liveRunsByDevice: [String: [ArchiveRecord]] = [:]
    @ObservationIgnored let activities = LiveActivityCoordinator()
    @ObservationIgnored private var pendingActivityLink: URL?
    var lockScreenProgress = UserDefaults.standard.bool(forKey: "lever.lockScreenProgress") {
        didSet {
            UserDefaults.standard.set(lockScreenProgress, forKey: "lever.lockScreenProgress")
            updateLiveActivity()
        }
    }

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

    @ObservationIgnored let pageSize = 15
    @ObservationIgnored let bridge = LeverBridge.shared
    @ObservationIgnored let db = AppDatabase.shared
    var media = LeverImagePipeline()
    @ObservationIgnored var eventTask: Task<Void, Never>?
    @ObservationIgnored var pollTask: Task<Void, Never>?
    @ObservationIgnored private var bannerTask: Task<Void, Never>?
    @ObservationIgnored var refreshDebounceTask: Task<Void, Never>?
    @ObservationIgnored var workspaceRevision = 0
    @ObservationIgnored var inFlightRefresh = false
    @ObservationIgnored var loadedTailKeys = Set<String>()
    @ObservationIgnored var prefetchedTopicKeys = Set<String>()

    // Internal memoization caches invalidated only on actual data mutation
    @ObservationIgnored var mergedIndexCache: [String: [ArchiveRecord]] = [:]
    @ObservationIgnored var agentRecordCache: [String: ArchiveRecord] = [:]
    @ObservationIgnored var timelineSnapshotCache: [String: TimelineSnapshot] = [:]
    @ObservationIgnored var drawerDataCache: [String: AgentDrawerData] = [:]

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

    // MARK: - Lifecycle

    func bootstrap() async {
        do { try await db.prepare() } catch { errorMessage = "本地缓存不可用：\(error.localizedDescription)" }
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
        if url.scheme == "leverdevice", url.host == "open" {
            pendingActivityLink = url
            openPendingActivity()
            return
        }
        let raw = url.absoluteString
        guard bridge.isValidPairLink(raw) else { return }
        if !isPaired {
            pendingPairLink = raw
            Task { await pair(link: raw) }
        } else {
            pendingPairLink = raw
        }
    }

    func openPendingActivity() {
        guard let url = pendingActivityLink, isPaired, !isBootstrapping,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        func field(_ name: String) -> String? { parts.queryItems?.first { $0.name == name }?.value }
        guard field("space") == activeSpace?.id, let device = field("device"), let chat = field("chat"), let agent = field("agent") else { return }
        let records = mergedIndex(for: device)
        guard let conversation = records.first(where: { $0.kind == "chat" && $0.id == chat && $0.agentId == agent }) else { return }
        let topic = field("topic")
        if let topic, !records.contains(where: { $0.kind == "session" && $0.type == "topic" && $0.id == topic && $0.chatId == chat }) { return }
        pendingActivityLink = nil
        pendingNavigationRoute = ChatRoute(deviceId: device, agentId: agent, chatId: chat, isPrivate: conversation.isPrivate, initialTopicId: topic)
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

    func unpair(peer: String? = nil) async {
        errorMessage = nil
        pollTask?.cancel()
        pollTask = nil
        await bridge.watch(false)
        do {
            if let peer {
                try await bridge.requestVoid("DELETE", path: "/native/direct-peers/\(peer)")
            } else {
                try await bridge.unpair()
            }
        } catch {
            errorMessage = error.localizedDescription
            await bridge.watch(true)
            startPollingLoop()
            return
        }
        await reloadAfterUnpair(removed: peer)
    }

    func reloadAfterUnpair(removed: String? = nil) async {
        guard let remaining = try? await bridge.status(), remaining.paired else {
            await resetWorkspaceState()
            return
        }
        var retained = Set(remaining.directPeerIds ?? [])
        if let removed, remaining.direct != true {
            retained.formUnion(devices.map(\.id))
            retained.remove(removed)
        }
        db.retainDeviceScopes(retained)
        await resetWorkspaceState(clearDisk: false)
        coreStatus = remaining
        await bridge.watch(true)
        await refreshAll(silent: false)
        startPollingLoop()
    }

    private func resetWorkspaceState(clearDisk: Bool = true) async {
        workspaceRevision &+= 1
        bridge.invalidateRequests()
        inFlightRefresh = false
        if clearDisk {
            db.clearAll()
        }
        activities.reconcile(enabled: false, snapshot: nil, hub: spacePath)
        pendingActivityLink = nil
        liveRunsByDevice.removeAll()
        let retiredMedia = media
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
        runStepsByKey = [:]
        loadingRunStepsKeys = []
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
        loadedTailKeys.removeAll()
        prefetchedTopicKeys.removeAll()
        invalidateAllProjections()
        await retiredMedia.clear()
        media = LeverImagePipeline()
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

    // MARK: - Helpers

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

    func urlEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}
