import SafariServices
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Scheme A Chat Detail:
/// - Native left-edge swipe back (`InteractivePopEnabler`) + native Liquid Glass tab bar auto-hide
/// - Zero-stutter isolated right-edge swipe drawer (`RightEdgeDrawerOverlay`) with un-cleared & cleared Topics/Chats
/// - True backend + local progressive history loading (handles 300MB+ chats in <20ms)
/// - Desktop-aligned Composer defaulting to Topic mode (`话题`) with Multi-Provider Picker, Photos/Files, `@` Mentions & `/` Skills
struct ChatDetailView: View {
    @Bindable var store: LeverStore
    let route: ChatRoute
    let onOpenTopic: (TopicRoute) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var workspace: WorkspaceDestination?
    @State private var currentChatId: String?
    @State private var currentIsPrivate: Bool = false

    // Progressive history loading
    @State private var visibleEntryLimit: Int = 24

    // Drawer open state ONLY (drag offset lives inside isolated RightEdgeDrawerOverlay for 120fps)
    @State private var isDrawerOpen = false

    // Desktop-aligned Composer state (Default: Topic mode!)
    @State private var composerText = ""
    @State private var composeNewTopic = true
    @State private var selectedProviderId: String?
    @State private var selectedModelId: String?
    @State private var selectedEffort: String?
    @State private var selectedFast: Bool?
    @State private var selectedWorkingCopyId: String?
    @State private var draftAttachments: [DraftAttachmentItem] = []
    @State private var draftReferences: [MessageReference] = []
    @State private var showModelPicker = false
    @State private var showPhotoPicker = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var showFileImporter = false
    @State private var showMentionSheet = false
    @State private var suggestionDismissed = false
    @State private var isSending = false
    @State private var inlineError: String?
    @State private var didInitialScroll = false
    @State private var initialLoadFinished = false
    @FocusState private var inputFocused: Bool

    private var agentRecord: ArchiveRecord? {
        store.agentRecord(deviceId: route.deviceId, agentId: route.agentId)
    }

    private var agentName: String {
        if let title = agentRecord?.title, !title.isEmpty { return title }
        if let cid = currentChatId,
           let chat = store.mergedIndex(for: route.deviceId).first(where: { $0.kind == "chat" && $0.id == cid }),
           let title = chat.title, !title.isEmpty {
            return title
        }
        return "Agent 对话"
    }

    private var currentChatTitle: String {
        guard let cid = currentChatId else { return "新对话" }
        if let chat = store.mergedIndex(for: route.deviceId).first(where: { $0.kind == "chat" && $0.id == cid }),
           let title = chat.title, !title.isEmpty {
            return title
        }
        return "主对话"
    }

    private var agentSeed: String {
        "\(route.deviceId):\(route.agentId)"
    }

    private var snapshot: TimelineSnapshot {
        guard let cid = currentChatId else { return .empty }
        return store.timelineSnapshot(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
    }

    private var isLoadingCurrentChat: Bool {
        guard let cid = currentChatId else { return false }
        return store.isLoadingChat(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
    }

    private var currentChatLoadError: String? {
        guard let cid = currentChatId else { return nil }
        return store.chatLoadError(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
    }

    private var hasMoreRemoteMain: Bool {
        guard let cid = currentChatId else { return false }
        return store.hasMoreMainRuns(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
    }

    private var isLoadingOlder: Bool {
        guard let cid = currentChatId else { return false }
        return store.isLoadingOlderChat(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
    }

    private var visibleEntries: [TimelineEntry] {
        let all = snapshot.entries
        if all.count <= visibleEntryLimit { return all }
        return Array(all.suffix(visibleEntryLimit))
    }

    private var remainingOlderCount: Int {
        max(0, snapshot.entries.count - visibleEntryLimit)
    }

    private var otherUnreadCount: Int {
        let currentAgentUnread = store.cachedFeedRows
            .first { $0.device.id == route.deviceId && $0.agentId == route.agentId }?
            .unreadSessionCount ?? 0
        return max(0, store.cachedTotalUnread - currentAgentUnread)
    }

    private var effectiveProviderId: String? {
        selectedProviderId ?? snapshot.mainProvider ?? agentRecord?.provider
    }

    private var effectiveProviderCatalog: ProviderCatalog? {
        let all = store.providerCatalogs(deviceId: route.deviceId, fallbackAgent: agentRecord)
        if let pid = effectiveProviderId {
            return all.first(where: { $0.id == pid })
        }
        return all.first
    }

    private var effectiveModelId: String? {
        selectedModelId ?? snapshot.mainModel ?? agentRecord?.model
    }

    private var effectiveEffort: String? {
        if let eff = selectedEffort { return eff }
        if selectedModelId == nil && selectedProviderId == nil { return snapshot.mainEffort }
        return nil
    }

    private var effectiveFast: Bool {
        selectedFast ?? (selectedModelId == nil && selectedProviderId == nil ? snapshot.mainFast : false)
    }

    private var effectiveModelName: String {
        let rawModel = effectiveModelId ?? "默认模型"
        if let match = effectiveProviderCatalog?.models?.first(where: { $0.id == rawModel }) {
            return match.displayName
        }
        if let match = agentRecord?.models?.first(where: { $0.id == rawModel }) {
            return match.displayName
        }
        return rawModel
    }

    private var activeTrigger: ComposerTrigger? {
        guard !suggestionDismissed else { return nil }
        return ComposerTrigger.detect(in: composerText)
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            VStack(spacing: 0) {
                chatNavigationBar

                if let banner = store.lastSyncBanner {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(LeverTheme.runningEmerald)
                        Text(banner)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(LeverTheme.inkPrimary)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(LeverTheme.surfaceElevated)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if let cid = currentChatId {
                                let entries = visibleEntries
                                if entries.isEmpty {
                                    if isLoadingCurrentChat || !initialLoadFinished {
                                        ConversationLoadingSkeleton(message: "正在从电脑同步消息…")
                                    } else if let loadErr = currentChatLoadError {
                                        errorChatPlaceholder(loadErr, chatId: cid)
                                    } else {
                                        emptyChatPlaceholder
                                    }
                                } else {
                                    if remainingOlderCount > 0 || hasMoreRemoteMain {
                                        loadOlderButton(chatId: cid)
                                    }

                                    ForEach(entries) { entry in
                                        switch entry {
                                        case .mainRun(let run, let requests):
                                            RunTurnView(
                                                run: run,
                                                requests: requests,
                                                agentName: agentName,
                                                agentAvatar: agentRecord?.avatar,
                                                agentAvatarSpec: agentRecord?.avatarSpec,
                                                deviceId: route.deviceId,
                                                store: store,
                                                agentSeed: agentSeed,
                                                isBusy: isSending,
                                                isSessionCleared: snapshot.mainSession.map { store.isSessionCleared(deviceId: route.deviceId, session: $0) } ?? false,
                                                lazySteps: store.runSteps(deviceId: route.deviceId, runId: run.id),
                                                isLoadingSteps: store.isLoadingRunSteps(deviceId: route.deviceId, runId: run.id),
                                                onLoadSteps: { runId in
                                                    let expected = run.stepCount ?? 0
                                                    Task {
                                                        await store.loadRunSteps(deviceId: route.deviceId, runId: runId, expectedCount: expected)
                                                    }
                                                },
                                                onAnswer: { req, ans, allowRun in
                                                    handleAnswer(chatId: cid, request: req, answer: ans, allowRun: allowRun)
                                                },
                                                onStop: { runId in
                                                    handleStop(chatId: cid, runId: runId)
                                                }
                                            )
                                            .equatable()
                                            .id(entry.id)

                                        case .topicCard(let topic):
                                            InlineTopicCardView(
                                                topic: topic,
                                                agentName: agentName,
                                                agentAvatar: agentRecord?.avatar,
                                                agentAvatarSpec: agentRecord?.avatarSpec,
                                                deviceId: route.deviceId,
                                                store: store,
                                                agentSeed: agentSeed,
                                                onOpen: {
                                                    Haptics.light()
                                                    onOpenTopic(TopicRoute(
                                                        deviceId: route.deviceId,
                                                        agentId: route.agentId,
                                                        chatId: cid,
                                                        isPrivate: currentIsPrivate,
                                                        topicId: topic.id
                                                    ))
                                                }
                                            )
                                            .contextMenu {
                                                Button {
                                                    onOpenTopic(TopicRoute(
                                                        deviceId: route.deviceId,
                                                        agentId: route.agentId,
                                                        chatId: cid,
                                                        isPrivate: currentIsPrivate,
                                                        topicId: topic.id
                                                    ))
                                                } label: {
                                                    Label("打开话题", systemImage: "arrow.up.right.square")
                                                }
                                                if topic.isCleared {
                                                    Button {
                                                        store.restoreSessions(
                                                            deviceId: route.deviceId,
                                                            sessionIds: [topic.id],
                                                            banner: "已恢复话题「\(topic.title)」"
                                                        )
                                                    } label: {
                                                        Label("恢复话题", systemImage: "arrow.uturn.backward")
                                                    }
                                                } else if topic.canClear {
                                                    Button {
                                                        store.clearSingleTopic(
                                                            deviceId: route.deviceId,
                                                            topicId: topic.id,
                                                            unreadSequence: topic.unreadSequence,
                                                            title: topic.title
                                                        )
                                                    } label: {
                                                        Label("清理话题", systemImage: "archivebox")
                                                    }
                                                }
                                            }
                                            .id(entry.id)
                                        }
                                    }
                                }
                                Color.clear.frame(height: 6).id("bottom-anchor")
                            } else {
                                emptyChatPlaceholder
                            }
                        }
                        .padding(.horizontal, 15)
                        .padding(.vertical, 12)
                    }
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .background(LeverTheme.canvas)
                    .onChange(of: snapshot.entries.last?.id) { _, _ in
                        guard didInitialScroll else { return }
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo("bottom-anchor", anchor: .bottom)
                        }
                    }
                    .onChange(of: snapshot.entries.isEmpty, initial: true) { _, isEmpty in
                        if !isEmpty && !didInitialScroll {
                            didInitialScroll = true
                            DispatchQueue.main.async {
                                proxy.scrollTo("bottom-anchor", anchor: .bottom)
                            }
                        }
                    }
                }

                if let loadErr = currentChatLoadError, !visibleEntries.isEmpty, let cid = currentChatId {
                    syncRetryBanner(loadErr, chatId: cid)
                }

                if let err = inlineError, !err.isEmpty {
                    inlineErrorBanner(err)
                }

                // Match Desktop QueuedMessages.tsx: ONLY show paused-queue banner when queued runs exist
                // and the session is not already cleared.
                if let mainSess = snapshot.mainSession,
                   mainSess.queuePaused == true,
                   !store.isSessionCleared(deviceId: route.deviceId, session: mainSess),
                   snapshot.mainHasQueuedRuns,
                   let cid = currentChatId {
                    pausedQueueBanner(chatId: cid, mainSessionId: mainSess.id)
                }

                desktopAlignedComposer
            }
            .background(LeverTheme.canvas)

            // Isolated Right-Edge Interactive Drawer (owns dragOffset so timeline performs 0 re-evals at 120fps)
            RightEdgeDrawerOverlay(
                isOpen: $isDrawerOpen,
                store: store,
                deviceId: route.deviceId,
                agentId: route.agentId,
                agentName: agentName,
                agentAvatar: agentRecord?.avatar,
                agentAvatarSpec: agentRecord?.avatarSpec,
                currentChatId: currentChatId,
                onDismissKeyboard: {
                    inputFocused = false
                },
                onSelectTopic: { item in
                    if currentChatId != item.chatId || currentIsPrivate != item.isPrivate {
                        currentChatId = item.chatId
                        currentIsPrivate = item.isPrivate
                        visibleEntryLimit = 24
                        didInitialScroll = false
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                        onOpenTopic(TopicRoute(
                            deviceId: route.deviceId,
                            agentId: route.agentId,
                            chatId: item.chatId,
                            isPrivate: item.isPrivate,
                            topicId: item.id
                        ))
                    }
                },
                onSelectChat: { item in
                    guard currentChatId != item.id || currentIsPrivate != item.isPrivate else { return }
                    currentChatId = item.id
                    currentIsPrivate = item.isPrivate
                    visibleEntryLimit = 24
                    didInitialScroll = false
                    initialLoadFinished = false
                    selectedProviderId = nil
                    selectedModelId = nil
                    selectedEffort = nil
                    selectedFast = nil
                    draftAttachments = []
                    draftReferences = []
                    Task {
                        await store.loadChat(deviceId: route.deviceId, chatId: item.id, isPrivate: item.isPrivate)
                        initialLoadFinished = true
                        await store.loadComposerMeta(deviceId: route.deviceId, agentId: route.agentId, chatId: item.id)
                        markMainSessionRead()
                    }
                },
                onStartNewChat: {
                    currentChatId = nil
                    currentIsPrivate = false
                    visibleEntryLimit = 24
                    didInitialScroll = false
                    composeNewTopic = true
                    selectedProviderId = nil
                    selectedModelId = nil
                    selectedEffort = nil
                    selectedFast = nil
                    draftAttachments = []
                    draftReferences = []
                    store.activeChatKey = nil
                }
            )
        }
        .background(InteractivePopEnabler())
        .sheet(item: $workspace, onDismiss: { Task { try? await LeverBridge.shared.requestVoid("POST", path: "/native/workspace/close") } }) { destination in
            PeerWorkspaceBrowser(url: destination.url).ignoresSafeArea()
        }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .task {
            currentChatId = route.chatId
            currentIsPrivate = route.isPrivate
            async let metaTask: Void = store.loadComposerMeta(
                deviceId: route.deviceId,
                agentId: route.agentId,
                chatId: route.chatId
            )
            if let cid = route.chatId {
                await store.loadChat(deviceId: route.deviceId, chatId: cid, isPrivate: route.isPrivate)
                markMainSessionRead()
            }
            initialLoadFinished = true
            _ = await metaTask
        }
        .onDisappear {
            if store.activeTopicId == nil {
                store.activeChatKey = nil
            }
        }
        .onChange(of: snapshot.mainSession?.unreadSequence) { _, _ in
            markMainSessionRead()
        }
        .onChange(of: composerText) { _, _ in
            suggestionDismissed = false
        }
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            let batch = items
            pickedPhotos = []
            handlePickedPhotos(batch)
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $pickedPhotos,
            maxSelectionCount: max(1, 8 - draftAttachments.count),
            matching: .images
        )
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                handlePickedFiles(urls)
            }
        }
        .sheet(isPresented: $showMentionSheet) {
            MentionPickerSheetView(
                store: store,
                deviceId: route.deviceId,
                currentAgentId: route.agentId,
                currentSessionId: snapshot.mainSession?.id,
                onSelect: { ref in
                    appendReference(ref, replacingRange: nil)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheetView(
                store: store,
                deviceId: route.deviceId,
                agentId: route.agentId,
                defaultProviderId: snapshot.mainProvider ?? agentRecord?.provider,
                defaultModelId: snapshot.mainModel ?? agentRecord?.model,
                defaultEffort: snapshot.mainEffort,
                defaultFast: snapshot.mainFast,
                defaultBadgeText: snapshot.mainModel != nil ? "当前会话" : "默认",
                fallbackAgent: agentRecord,
                selectedProviderId: $selectedProviderId,
                selectedModelId: $selectedModelId,
                selectedEffort: $selectedEffort,
                selectedFast: $selectedFast
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    // MARK: - Navigation Header

    private var chatNavigationBar: some View {
        HStack(spacing: 8) {
            Button {
                dismiss()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                    if otherUnreadCount > 0 {
                        Text("\(otherUnreadCount)")
                            .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(LeverTheme.surfacePill)
                            .clipShape(Capsule())
                    }
                }
                .foregroundStyle(LeverTheme.inkPrimary)
                .frame(minWidth: 34, minHeight: 34)
            }
            .buttonStyle(.plain)

            Button {
                openDrawer()
            } label: {
                HStack(spacing: 8) {
                    AgentAvatarView(
                        name: agentName,
                        avatar: agentRecord?.avatar,
                        avatarSpec: agentRecord?.avatarSpec,
                        deviceId: route.deviceId,
                        store: store,
                        seed: agentSeed,
                        size: 32
                    )

                    VStack(alignment: .leading, spacing: 1.5) {
                        Text(agentName)
                            .font(.system(size: 15.5, weight: .semibold))
                            .foregroundStyle(LeverTheme.inkPrimary)
                            .lineLimit(1)
                        NavSyncSubtitleView(
                            isSyncing: currentChatId != nil && (isLoadingCurrentChat || !initialLoadFinished),
                            text: "\(currentChatTitle) · \(snapshot.topics.count) 个话题"
                        )
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Spacer(minLength: 4)

            // Right Drawer Trigger Button (also accessible by swiping left from right edge!)
            Button {
                openDrawer()
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .frame(width: 34, height: 34)
                        .background(LeverTheme.surfaceInset)
                        .clipShape(Circle())

                    if snapshot.topics.contains(where: \.isUnread) {
                        Circle()
                            .fill(LeverTheme.unreadRed)
                            .frame(width: 8, height: 8)
                            .offset(x: 1, y: -1)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("展开当前 Agent 话题与对话侧栏")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(LeverTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    // MARK: - Progressive Load Older Button

    private func loadOlderButton(chatId: String) -> some View {
        HStack {
            Spacer()
            if store.hasNativeOwner(route.deviceId) {
                Button {
                    Task {
                        do {
                            let location: String = try await LeverBridge.shared.request("POST", path: "/native/workspace",
                                body: ["node": route.deviceId, "agent": route.agentId, "chat": currentChatId ?? ""])
                            if let url = URL(string: location) { workspace = WorkspaceDestination(url: url) }
                        } catch { inlineError = error.localizedDescription }
                    }
                } label: { Image(systemName: "folder").frame(width: 34, height: 34) }
                .accessibilityLabel("打开设备工作区")
            }
            Button {
                Haptics.light()
                let prevRemaining = remainingOlderCount
                visibleEntryLimit += 24
                if prevRemaining <= 24 && hasMoreRemoteMain {
                    Task {
                        await store.loadOlderChatRuns(deviceId: route.deviceId, chatId: chatId, isPrivate: currentIsPrivate)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    if isLoadingOlder {
                        ProgressView()
                            .scaleEffect(0.68)
                            .tint(LeverTheme.inkSecondary)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    Text(loadOlderLabel)
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(LeverTheme.inkSecondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(LeverTheme.surfaceInset)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(isLoadingOlder)
            Spacer()
        }
        .padding(.top, 2)
    }

    private var loadOlderLabel: String {
        if isLoadingOlder { return "正在加载更早的消息…" }
        if remainingOlderCount > 0 {
            return hasMoreRemoteMain
                ? "加载更早的历史消息（本地还有 \(remainingOlderCount) 条）"
                : "加载更早的历史消息（还有 \(remainingOlderCount) 条）"
        }
        return "加载更早的云端历史消息"
    }

    // MARK: - Desktop-Aligned Composer (Default: 话题 Mode + Multi-Provider + Photos/Files + @ + /)

    private var desktopAlignedComposer: some View {
        VStack(spacing: 0) {
            if let trigger = activeTrigger {
                let mentionGroups: [(label: String, items: [MessageReference])] = {
                    if case .mention(_, let q) = trigger {
                        return store.mentionCandidates(
                            deviceId: route.deviceId,
                            currentAgentId: route.agentId,
                            currentSessionId: snapshot.mainSession?.id,
                            query: q
                        )
                    }
                    return []
                }()
                ComposerSuggestionTray(
                    trigger: trigger,
                    skills: store.skills(deviceId: route.deviceId, agentId: route.agentId, providerId: effectiveProviderId),
                    slashCommands: effectiveProviderCatalog?.commands ?? [],
                    mentionGroups: mentionGroups,
                    allowModeCommands: true,
                    onSelectSkill: { skill in
                        if case .slash(let range, _) = trigger {
                            appendReference(skill, replacingRange: range)
                        }
                    },
                    onSelectSlashCommand: { cmd in
                        if case .slash(let range, _) = trigger {
                            applySlashCommand(cmd, replacingRange: range)
                        }
                    },
                    onSelectMention: { ref in
                        if case .mention(let range, _) = trigger {
                            appendReference(ref, replacingRange: range)
                        }
                    },
                    onDismiss: {
                        suggestionDismissed = true
                    }
                )
            }

            VStack(spacing: 8) {
                ComposerAttachmentsAndRefsBar(
                    attachments: draftAttachments,
                    references: draftReferences,
                    onRemoveAttachment: { id in
                        draftAttachments.removeAll { $0.id == id }
                    },
                    onRemoveReference: { id in
                        draftReferences.removeAll { $0.id == id }
                    }
                )

                TextField(
                    composeNewTopic ? "发起新话题，输入 / 调用 Skill，@ 引用话题…" : "在主对话发消息，输入 / 或 @…",
                    text: $composerText,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .font(.system(size: 15))
                .foregroundStyle(LeverTheme.inkPrimary)
                .focused($inputFocused)
                .padding(.horizontal, 4)
                .padding(.top, 2)

                HStack(spacing: 7) {
                    ComposerPlusMenu(
                        workingCopies: agentRecord?.groups ?? [],
                        selectedWorkingCopyId: $selectedWorkingCopyId,
                        onPickPhotos: {
                            inputFocused = false
                            showPhotoPicker = true
                        },
                        onPickFiles: {
                            inputFocused = false
                            showFileImporter = true
                        },
                        onInsertMention: {
                            inputFocused = false
                            showMentionSheet = true
                        },
                        onInsertSlash: {
                            suggestionDismissed = false
                            if composerText.isEmpty {
                                composerText = "/"
                            } else if composerText.last?.isWhitespace == true || composerText.last?.isNewline == true {
                                composerText.append("/")
                            } else {
                                composerText.append(" /")
                            }
                            inputFocused = true
                        }
                    )

                    Button {
                        Haptics.light()
                        withAnimation(.easeInOut(duration: 0.16)) {
                            composeNewTopic.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: composeNewTopic ? "number" : "bubble.left")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text(composeNewTopic ? "话题" : "对话")
                                .font(.system(size: 12.5, weight: .semibold))
                        }
                        .foregroundStyle(composeNewTopic ? LeverTheme.surface : LeverTheme.inkSecondary)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(composeNewTopic ? LeverTheme.inkPrimary : LeverTheme.surfaceInset)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)

                    Spacer(minLength: 4)

                    ComposerModelTriggerPill(
                        provider: effectiveProviderCatalog,
                        providerId: effectiveProviderId,
                        modelName: effectiveModelName,
                        effort: effectiveEffort,
                        fast: effectiveFast,
                        action: {
                            Haptics.light()
                            showModelPicker = true
                        }
                    )

                    let hasUploading = draftAttachments.contains(where: \.isUploading)
                    let hasUploadedFiles = draftAttachments.contains { $0.uploaded != nil }
                    let canSend = !isSending && !hasUploading && (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasUploadedFiles)
                    Button {
                        submitMessage()
                    } label: {
                        Group {
                            if isSending {
                                ProgressView()
                                    .scaleEffect(0.72)
                                    .tint(LeverTheme.surface)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 14, weight: .bold))
                            }
                        }
                        .frame(width: 32, height: 32)
                        .background(canSend ? LeverTheme.inkPrimary : LeverTheme.surfaceInset)
                        .foregroundStyle(canSend ? LeverTheme.surface : LeverTheme.inkTertiary)
                        .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(LeverTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(LeverTheme.hairlineStrong, lineWidth: 0.5)
            )
            .shadow(color: Color.black.opacity(0.06), radius: 14, x: 0, y: 4)
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 10)
        }
        .background(LeverTheme.canvas)
    }

    // MARK: - Auxiliary Views

    private var loadingChatPlaceholder: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(LeverTheme.inkSecondary)
            Text("正在同步对话内容…")
                .font(.system(size: 13.5))
                .foregroundStyle(LeverTheme.inkTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 72)
    }

    private func errorChatPlaceholder(_ error: String, chatId: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(LeverTheme.inkTertiary)
            Text("同步对话失败")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(LeverTheme.inkPrimary)
            Text(error)
                .font(.system(size: 12.5))
                .foregroundStyle(LeverTheme.inkTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button {
                Haptics.light()
                Task {
                    await store.loadChat(deviceId: route.deviceId, chatId: chatId, isPrivate: currentIsPrivate)
                }
            } label: {
                Text("重新加载")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.surface)
                    .padding(.horizontal, 18)
                    .frame(height: 36)
                    .background(LeverTheme.inkPrimary)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 64)
    }

    private func syncRetryBanner(_ error: String, chatId: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.2.circlepath.circle")
                .font(.system(size: 13))
            Text("同步未完成：\(error)")
                .font(.system(size: 12))
                .lineLimit(1)
            Spacer()
            Button("重试") {
                Haptics.light()
                Task {
                    await store.loadChat(deviceId: route.deviceId, chatId: chatId, isPrivate: currentIsPrivate)
                }
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(LeverTheme.inkPrimary)
        }
        .foregroundStyle(LeverTheme.inkSecondary)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(LeverTheme.surfaceElevated)
        .overlay(alignment: .top) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private var emptyChatPlaceholder: some View {
        VStack(spacing: 12) {
            AgentAvatarView(
                name: agentName,
                avatar: agentRecord?.avatar,
                avatarSpec: agentRecord?.avatarSpec,
                deviceId: route.deviceId,
                store: store,
                seed: agentSeed,
                size: 56
            )
            Text(agentName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(LeverTheme.inkPrimary)
            Text("默认以「话题」模式开启结构化会话，右滑可查看当前 Agent 的所有话题与历史对话。")
                .font(.system(size: 13))
                .foregroundStyle(LeverTheme.inkTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 64)
    }

    private func inlineErrorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
            Text(message)
                .font(.system(size: 12.5))
                .lineLimit(2)
            Spacer()
            Button {
                inlineError = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(LeverTheme.unreadRed)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(LeverTheme.unreadRed.opacity(0.10))
    }

    private func pausedQueueBanner(chatId: String, mainSessionId: String) -> some View {
        HStack {
            Text("主会话排队已暂停")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(LeverTheme.approvalAmber)
            Spacer()
            Button("恢复队列") {
                Task {
                    try? await store.resumeQueue(deviceId: route.deviceId, chatId: chatId, isPrivate: currentIsPrivate, sessionId: mainSessionId)
                }
            }
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(LeverTheme.inkPrimary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(LeverTheme.approvalAmberSoft)
    }

    // MARK: - Actions

    private func openDrawer() {
        inputFocused = false
        Haptics.light()
        withAnimation(.spring(response: 0.30, dampingFraction: 0.86)) {
            isDrawerOpen = true
        }
    }

    private func markMainSessionRead() {
        guard let main = snapshot.mainSession,
              let uSeq = main.unreadSequence,
              uSeq > 0 else { return }
        store.markSessionsRead(
            deviceId: route.deviceId,
            marks: [ReadMark(sessionId: main.id, sequence: uSeq)]
        )
    }

    private func buildSelection() -> ModelSelection? {
        guard selectedProviderId != nil || selectedModelId != nil || selectedEffort != nil || selectedFast != nil else { return nil }
        return ModelSelection(
            provider: selectedProviderId ?? snapshot.mainProvider ?? agentRecord?.provider,
            model: selectedModelId ?? snapshot.mainModel ?? agentRecord?.model,
            effort: selectedEffort ?? effectiveEffort,
            fast: selectedFast ?? effectiveFast,
            permission: nil
        )
    }

    private func appendReference(_ ref: MessageReference, replacingRange: Range<String.Index>?) {
        let token = "\(ref.kind == "skill" ? "$" : "@")\(ref.name) "
        if let range = replacingRange {
            composerText.replaceSubrange(range, with: token)
        } else if composerText.isEmpty || composerText.last?.isWhitespace == true || composerText.last?.isNewline == true {
            composerText.append(token)
        } else {
            composerText.append(" \(token)")
        }
        if !draftReferences.contains(where: { $0.id == ref.id }) {
            draftReferences.append(ref)
        }
        suggestionDismissed = true
        inputFocused = true
    }

    private func applySlashCommand(_ cmd: String, replacingRange: Range<String.Index>) {
        if cmd == "topic" {
            composeNewTopic = true
            composerText.replaceSubrange(replacingRange, with: "")
            suggestionDismissed = true
            return
        }
        if cmd == "chat" {
            composeNewTopic = false
            composerText.replaceSubrange(replacingRange, with: "")
            suggestionDismissed = true
            return
        }
        composerText.replaceSubrange(replacingRange, with: "/\(cmd) ")
        suggestionDismissed = true
        inputFocused = true
    }

    private func handlePickedPhotos(_ items: [PhotosPickerItem]) {
        let targetChatId = currentChatId
        let targetAgentId = route.agentId
        for (idx, item) in items.enumerated() {
            guard draftAttachments.count < 8 else { break }
            let draftId = UUID()
            draftAttachments.append(DraftAttachmentItem(
                id: draftId, fileName: "图片 \(idx + 1)", isImage: true,
                thumbnail: nil, uploaded: nil, isUploading: true, error: nil
            ))
            Task {
                guard let prepared = await ComposerMediaHelper.preparePhoto(item: item, index: idx + 1) else {
                    updateDraftAttachment(draftId) { $0.isUploading = false; $0.error = "读取图片失败" }
                    return
                }
                updateDraftAttachment(draftId) {
                    $0.thumbnail = prepared.thumbnail
                    $0.fileName = prepared.fileName
                }
                do {
                    let ref = try await store.uploadAttachment(
                        deviceId: route.deviceId,
                        chatId: targetChatId,
                        agentId: targetAgentId,
                        fileName: prepared.fileName,
                        data: prepared.data
                    )
                    updateDraftAttachment(draftId) {
                        $0.uploaded = ref
                        $0.isUploading = false
                    }
                } catch {
                    updateDraftAttachment(draftId) {
                        $0.isUploading = false
                        $0.error = error.localizedDescription
                    }
                }
            }
        }
    }

    private func handlePickedFiles(_ urls: [URL]) {
        let targetChatId = currentChatId
        let targetAgentId = route.agentId
        for url in urls {
            guard draftAttachments.count < 8 else { break }
            let draftId = UUID()
            let fallbackName = url.lastPathComponent.isEmpty ? "文件" : url.lastPathComponent
            draftAttachments.append(DraftAttachmentItem(
                id: draftId, fileName: fallbackName, isImage: false,
                thumbnail: nil, uploaded: nil, isUploading: true, error: nil
            ))
            Task {
                guard let prepared = await ComposerMediaHelper.prepareFile(url: url) else {
                    updateDraftAttachment(draftId) { $0.isUploading = false; $0.error = "文件超过 8MB 或不可读" }
                    return
                }
                updateDraftAttachment(draftId) {
                    $0.fileName = prepared.fileName
                    $0.thumbnail = prepared.thumbnail
                }
                do {
                    let ref = try await store.uploadAttachment(
                        deviceId: route.deviceId,
                        chatId: targetChatId,
                        agentId: targetAgentId,
                        fileName: prepared.fileName,
                        data: prepared.data
                    )
                    updateDraftAttachment(draftId) {
                        $0.uploaded = ref
                        $0.isUploading = false
                    }
                } catch {
                    updateDraftAttachment(draftId) {
                        $0.isUploading = false
                        $0.error = error.localizedDescription
                    }
                }
            }
        }
    }

    private func updateDraftAttachment(_ id: UUID, _ mutate: (inout DraftAttachmentItem) -> Void) {
        if let idx = draftAttachments.firstIndex(where: { $0.id == id }) {
            mutate(&draftAttachments[idx])
        }
    }

    private func submitMessage() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        let uploadedIds = draftAttachments.compactMap { $0.uploaded?.id }
        guard (!text.isEmpty || !uploadedIds.isEmpty), !isSending else { return }
        let sendAsNewTopic = composeNewTopic
        let targetChatId = currentChatId
        let selection = buildSelection()
        let savedAttachments = draftAttachments
        let savedReferences = draftReferences
        let resolvedRefs = ComposerMediaHelper.resolveReferences(in: text, references: savedReferences)

        composerText = ""
        draftAttachments = []
        draftReferences = []
        isSending = true
        inlineError = nil

        Task {
            defer { isSending = false }
            do {
                let receipt = try await store.sendMessage(
                    deviceId: route.deviceId,
                    agentId: route.agentId,
                    chatId: targetChatId,
                    isPrivate: currentIsPrivate,
                    text: text,
                    mode: sendAsNewTopic ? .newTopic : .main,
                    workingCopyId: selectedWorkingCopyId,
                    selection: selection,
                    attachmentIds: uploadedIds.isEmpty ? nil : uploadedIds,
                    references: resolvedRefs.isEmpty ? nil : resolvedRefs
                )
                if currentChatId == nil, let createdChatId = receipt.chatId {
                    currentChatId = createdChatId
                    await store.loadChat(deviceId: route.deviceId, chatId: createdChatId, isPrivate: currentIsPrivate)
                }
            } catch {
                composerText = text
                draftAttachments = savedAttachments
                draftReferences = savedReferences
                inlineError = error.localizedDescription
            }
        }
    }

    private func handleAnswer(chatId: String, request: ArchiveRecord, answer: RequestAnswer?, allowRun: Bool) {
        isSending = true
        inlineError = nil
        Task {
            defer { isSending = false }
            do {
                try await store.answerRequest(
                    deviceId: route.deviceId,
                    chatId: chatId,
                    isPrivate: currentIsPrivate,
                    request: request,
                    answer: answer,
                    allowRun: allowRun
                )
            } catch {
                inlineError = error.localizedDescription
            }
        }
    }

    private func handleStop(chatId: String, runId: String) {
        isSending = true
        Task {
            defer { isSending = false }
            try? await store.stopRun(deviceId: route.deviceId, chatId: chatId, isPrivate: currentIsPrivate, runId: runId)
        }
    }
}

// MARK: - Isolated 120fps Right-Edge Interactive Drawer Container

/// Owns `dragOffset` locally so dragging the right-edge drawer NEVER re-evaluates ChatDetailView's timeline.
private struct RightEdgeDrawerOverlay: View {
    @Binding var isOpen: Bool
    let store: LeverStore
    let deviceId: String
    let agentId: String
    let agentName: String
    let agentAvatar: String?
    let agentAvatarSpec: AvatarSpec?
    let currentChatId: String?
    let onDismissKeyboard: () -> Void
    let onSelectTopic: (AgentDrawerTopicItem) -> Void
    let onSelectChat: (AgentDrawerChatItem) -> Void
    let onStartNewChat: () -> Void

    @State private var dragOffset: CGFloat = 0
    private let drawerWidth: CGFloat = 312

    private var progress: CGFloat {
        if isOpen {
            return max(0, min(1, 1 - dragOffset / drawerWidth))
        } else {
            return max(0, min(1, -dragOffset / drawerWidth))
        }
    }

    private var offsetX: CGFloat {
        (1 - progress) * drawerWidth
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            if !isOpen {
                Color.clear
                    .frame(width: 30)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 10, coordinateSpace: .local)
                            .onChanged { value in
                                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                                if value.translation.width < 0 {
                                    if dragOffset == 0 {
                                        onDismissKeyboard()
                                    }
                                    dragOffset = max(-drawerWidth, value.translation.width)
                                }
                            }
                            .onEnded { value in
                                let shouldOpen = value.translation.width < -68 || value.predictedEndTranslation.width < -130
                                withAnimation(.spring(response: 0.30, dampingFraction: 0.86)) {
                                    isOpen = shouldOpen
                                    dragOffset = 0
                                }
                                if shouldOpen { Haptics.light() }
                            }
                    )
            }

            if isOpen || dragOffset < 0 {
                Color.black
                    .opacity(0.32 * Double(progress))
                    .ignoresSafeArea()
                    .onTapGesture {
                        close()
                    }
                    .zIndex(20)

                AgentDrawerView(
                    store: store,
                    deviceId: deviceId,
                    agentId: agentId,
                    agentName: agentName,
                    agentAvatar: agentAvatar,
                    agentAvatarSpec: agentAvatarSpec,
                    currentChatId: currentChatId,
                    onSelectTopic: { item in
                        close()
                        onSelectTopic(item)
                    },
                    onSelectChat: { item in
                        close()
                        onSelectChat(item)
                    },
                    onStartNewChat: {
                        close()
                        onStartNewChat()
                    },
                    onClose: {
                        close()
                    }
                )
                .frame(width: drawerWidth)
                .offset(x: offsetX)
                .shadow(color: Color.black.opacity(0.18), radius: 24, x: -8, y: 0)
                .gesture(
                    DragGesture(minimumDistance: 10, coordinateSpace: .local)
                        .onChanged { value in
                            guard abs(value.translation.width) > abs(value.translation.height) else { return }
                            if value.translation.width > 0 {
                                dragOffset = min(drawerWidth, value.translation.width)
                            }
                        }
                        .onEnded { value in
                            let shouldClose = value.translation.width > 68 || value.predictedEndTranslation.width > 130
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.88)) {
                                isOpen = !shouldClose
                                dragOffset = 0
                            }
                        }
                )
                .zIndex(30)
            }
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.88)) {
            isOpen = false
            dragOffset = 0
        }
    }
}

private struct WorkspaceDestination: Identifiable {
    let url: URL
    var id: URL { url }
}
private struct PeerWorkspaceBrowser: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
