import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Scheme A Full-Screen Topic View:
/// - Pushed onto NavigationStack with native left-edge swipe-back (`InteractivePopEnabler`) & Liquid Glass tab bar auto-hide
/// - Zero-stutter isolated right-edge interactive drawer (`RightEdgeDrawerOverlay`) for switching Topics & Chats
/// - Dedicated per-topic paginated loading (`loadTopic` / `loadOlderTopicRuns`) for instant open even on 300MB+ chats
/// - Full Desktop-aligned Composer: Multi-provider Model Picker + Starred Models + Provider & Effort Icons + Photos/Files + `@` Mention + `/` Skills & Commands
struct TopicDetailView: View {
    @Bindable var store: LeverStore
    let route: TopicRoute
    var onSelectTopic: (TopicRoute) -> Void = { _ in }
    var onSelectChat: (ChatRoute) -> Void = { _ in }
    var onStartNewChat: (ChatRoute) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var isDrawerOpen = false
    @State private var replyText = ""
    @State private var selectedProviderId: String?
    @State private var selectedModelId: String?
    @State private var selectedEffort: String?
    @State private var selectedFast: Bool?
    @State private var showModelPicker = false
    @State private var visibleRunLimit = 25
    @State private var isSending = false
    @State private var inlineError: String?
    @State private var followRequest = 0
    @State private var paginationAnchor: String?
    @State private var initialLoadFinished = false

    // Attachments, `@` Mentions & `/` Skills
    @State private var draftAttachments: [DraftAttachmentItem] = []
    @State private var draftReferences: [MessageReference] = []
    @State private var showPhotoPicker = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    @State private var showFileImporter = false
    @State private var showMentionSheet = false
    @State private var suggestionDismissed = false

    @FocusState private var inputFocused: Bool

    private var agentRecord: ArchiveRecord? {
        store.agentRecord(deviceId: route.deviceId, agentId: route.agentId)
    }

    private var agentName: String {
        if let title = agentRecord?.title, !title.isEmpty { return title }
        return "Agent"
    }

    private var agentSeed: String {
        "\(route.deviceId):\(route.agentId)"
    }

    private var topic: TopicSummary? {
        let snap = store.timelineSnapshot(deviceId: route.deviceId, chatId: route.chatId, isPrivate: route.isPrivate)
        return snap.topics.first(where: { $0.id == route.topicId })
    }

    private var isLoadingTopic: Bool {
        store.isLoadingTopic(deviceId: route.deviceId, chatId: route.chatId, isPrivate: route.isPrivate, topicId: route.topicId)
    }

    private var topicLoadError: String? {
        store.topicLoadError(deviceId: route.deviceId, chatId: route.chatId, isPrivate: route.isPrivate, topicId: route.topicId)
    }

    private var hasMoreRemote: Bool {
        store.hasMoreTopicRuns(deviceId: route.deviceId, chatId: route.chatId, isPrivate: route.isPrivate, topicId: route.topicId)
    }

    private var isLoadingOlder: Bool {
        store.isLoadingOlderTopic(deviceId: route.deviceId, chatId: route.chatId, isPrivate: route.isPrivate, topicId: route.topicId)
    }

    private var visibleRuns: [ArchiveRecord] {
        guard let runs = topic?.runs else { return [] }
        if runs.count <= visibleRunLimit { return runs }
        return Array(runs.suffix(visibleRunLimit))
    }

    private var remainingOlderCount: Int {
        guard let runs = topic?.runs else { return 0 }
        return max(0, runs.count - visibleRunLimit)
    }

    private var effectiveProviderId: String? {
        selectedProviderId ?? topic?.provider ?? agentRecord?.provider
    }

    private var effectiveProviderCatalog: ProviderCatalog? {
        let all = store.providerCatalogs(deviceId: route.deviceId, fallbackAgent: agentRecord)
        if let pid = effectiveProviderId {
            return all.first(where: { $0.id == pid })
        }
        return all.first
    }

    private var effectiveModelId: String? {
        selectedModelId ?? topic?.model ?? agentRecord?.model
    }

    private var effectiveEffort: String? {
        if let eff = selectedEffort { return eff }
        if selectedModelId == nil && selectedProviderId == nil { return topic?.effort }
        return nil
    }

    private var effectiveFast: Bool {
        selectedFast ?? (selectedModelId == nil && selectedProviderId == nil ? (topic?.fast ?? false) : false)
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
        return ComposerTrigger.detect(in: replyText)
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            VStack(spacing: 0) {
                topicHeader

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
                        if let topic {
                            if topic.runs.isEmpty {
                                if isLoadingTopic || !initialLoadFinished {
                                    ConversationLoadingSkeleton(message: "正在从电脑同步话题消息…")
                                } else if let loadErr = topicLoadError {
                                    VStack(spacing: 12) {
                                        Text("加载话题失败")
                                            .font(.system(size: 15, weight: .semibold))
                                            .foregroundStyle(LeverTheme.inkPrimary)
                                        Text(loadErr)
                                            .font(.system(size: 12.5))
                                            .foregroundStyle(LeverTheme.inkTertiary)
                                            .multilineTextAlignment(.center)
                                        Button {
                                            Haptics.light()
                                            initialLoadFinished = false
                                            Task {
                                                await store.loadTopic(
                                                    deviceId: route.deviceId,
                                                    chatId: route.chatId,
                                                    isPrivate: route.isPrivate,
                                                    topicId: route.topicId
                                                )
                                                initialLoadFinished = true
                                            }
                                        } label: {
                                            Text("重试")
                                                .font(.system(size: 13.5, weight: .semibold))
                                                .foregroundStyle(LeverTheme.surface)
                                                .padding(.horizontal, 18)
                                                .frame(height: 34)
                                                .background(LeverTheme.inkPrimary)
                                                .clipShape(Capsule())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 56)
                                } else {
                                    VStack(spacing: 8) {
                                        Image(systemName: "bubble.left.and.text.bubble.right")
                                            .font(.system(size: 28, weight: .light))
                                            .foregroundStyle(LeverTheme.inkTertiary)
                                        Text("暂无话题消息")
                                            .font(.system(size: 14.5, weight: .medium))
                                            .foregroundStyle(LeverTheme.inkSecondary)
                                        Text("在下方输入内容即可继续此话题")
                                            .font(.system(size: 12.5))
                                            .foregroundStyle(LeverTheme.inkTertiary)
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 64)
                                }
                            } else {
                                if remainingOlderCount > 0 || hasMoreRemote {
                                    HStack {
                                        Spacer()
                                        Button {
                                            Haptics.light()
                                            paginationAnchor = visibleRuns.first?.id
                let prevRemaining = remainingOlderCount
                                            visibleRunLimit += 25
                                            if prevRemaining <= 25 && hasMoreRemote {
                                                Task {
                                                    await store.loadOlderTopicRuns(
                                                        deviceId: route.deviceId,
                                                        chatId: route.chatId,
                                                        isPrivate: route.isPrivate,
                                                        topicId: route.topicId
                                                    )
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
                                                Text(
                                                    isLoadingOlder
                                                        ? "正在加载更早的消息…"
                                                        : (remainingOlderCount > 0 ? "加载更早的 \(remainingOlderCount) 轮消息" : "加载更早的云端历史消息")
                                                )
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
                                }

                                ForEach(visibleRuns) { run in
                                    RunTurnView(
                                        run: run,
                                        requests: topic.requestsByRun[run.id] ?? [],
                                        agentName: agentName,
                                        agentAvatar: agentRecord?.avatar,
                                        agentAvatarSpec: agentRecord?.avatarSpec,
                                        deviceId: route.deviceId,
                                        store: store,
                                        agentId: route.agentId,
                                        agentSeed: agentSeed,
                                        isBusy: isSending,
                                        isSessionCleared: topic.isCleared,
                                        lazySteps: store.runSteps(deviceId: route.deviceId, runId: run.id),
                                        isLoadingSteps: store.isLoadingRunSteps(deviceId: route.deviceId, runId: run.id),
                                        onLoadSteps: { runId in
                                            let expected = run.stepCount ?? 0
                                            Task {
                                                await store.loadRunSteps(deviceId: route.deviceId, runId: runId, expectedCount: expected)
                                            }
                                        },
                                        onAnswer: { req, ans, allowRun in
                                            handleAnswer(request: req, answer: ans, allowRun: allowRun)
                                        },
                                        onStop: { runId in
                                            handleStop(runId: runId)
                                        }
                                    )
                                    .equatable()
                                    .id(run.id)
                                }
                            }
                            Color.clear.frame(height: 6).id("topic-bottom")
                        } else {
                            ConversationLoadingSkeleton(message: "正在从电脑同步话题消息…")
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 15)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(LeverTheme.canvas)
                .modifier(TimelineScrollAnchor(firstID: visibleRuns.first?.id, followRequest: followRequest))
                .onChange(of: visibleRuns.first?.id) { _, _ in
                    guard let anchor = paginationAnchor else { return }
                    proxy.scrollTo(anchor, anchor: .top)
                    paginationAnchor = nil
                }
            }

            if let err = inlineError, !err.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 12))
                    Text(err)
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

                topicComposer
            }
            .background(LeverTheme.canvas)

            RightEdgeDrawerOverlay(
                isOpen: $isDrawerOpen,
                store: store,
                deviceId: route.deviceId,
                agentId: route.agentId,
                agentName: agentName,
                agentAvatar: agentRecord?.avatar,
                agentAvatarSpec: agentRecord?.avatarSpec,
                currentChatId: nil,
                currentTopicId: route.topicId,
                onDismissKeyboard: {
                    inputFocused = false
                },
                onSelectTopic: { item in
                    guard item.id != route.topicId || item.chatId != route.chatId || item.isPrivate != route.isPrivate else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                        onSelectTopic(TopicRoute(
                            deviceId: route.deviceId,
                            agentId: route.agentId,
                            chatId: item.chatId,
                            isPrivate: item.isPrivate,
                            topicId: item.id
                        ))
                    }
                },
                onSelectChat: { item in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                        onSelectChat(ChatRoute(
                            deviceId: route.deviceId,
                            agentId: route.agentId,
                            chatId: item.id,
                            isPrivate: item.isPrivate,
                            initialTopicId: nil
                        ))
                    }
                },
                onStartNewChat: {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                        onStartNewChat(ChatRoute(
                            deviceId: route.deviceId,
                            agentId: route.agentId,
                            chatId: nil,
                            isPrivate: false,
                            initialTopicId: nil
                        ))
                    }
                }
            )
        }
        .background(InteractivePopEnabler(isEnabled: !isDrawerOpen))
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .task {
            await store.loadTopic(
                deviceId: route.deviceId,
                chatId: route.chatId,
                isPrivate: route.isPrivate,
                topicId: route.topicId
            )
            initialLoadFinished = true
            markTopicRead()
            await store.loadComposerMeta(
                deviceId: route.deviceId,
                agentId: route.agentId,
                chatId: route.chatId,
                sessionId: route.topicId,
                providerId: effectiveProviderId
            )
        }
        .onChange(of: selectedProviderId) { _, newProvider in
            Task {
                await store.loadComposerMeta(
                    deviceId: route.deviceId,
                    agentId: route.agentId,
                    chatId: route.chatId,
                    sessionId: route.topicId,
                    providerId: newProvider
                )
            }
        }
        .onChange(of: replyText) { _, _ in
            suggestionDismissed = false
        }
        .onDisappear {
            if store.activeTopicId == route.topicId {
                store.activeTopicId = nil
            }
        }
        .onChange(of: topic?.unreadSequence) { _, _ in
            markTopicRead()
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $pickedPhotos,
            maxSelectionCount: max(1, 8 - draftAttachments.count),
            matching: .images
        )
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            let captured = items
            pickedPhotos = []
            handlePickedPhotos(captured)
        }
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
                currentSessionId: route.topicId
            ) { ref in
                appendReference(ref, replacingRange: nil)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheetView(
                store: store,
                deviceId: route.deviceId,
                agentId: route.agentId,
                defaultProviderId: topic?.provider ?? agentRecord?.provider,
                defaultModelId: topic?.model ?? agentRecord?.model,
                defaultEffort: topic?.effort,
                defaultFast: topic?.fast ?? false,
                defaultBadgeText: topic?.model != nil ? "当前话题模型" : "Agent 默认模型",
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

    // MARK: - Header

    private var topicHeader: some View {
        let hasOtherUnreadTopics = store.agentDrawerData(deviceId: route.deviceId, agentId: route.agentId)
            .activeTopics.contains { $0.id != route.topicId && $0.isUnread }

        return HStack(spacing: 8) {
            Button {
                dismiss()
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                    Text("返回")
                        .font(.system(size: 15))
                }
                .foregroundStyle(LeverTheme.inkPrimary)
                .frame(minHeight: 34)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 4)

            Button {
                openDrawer()
            } label: {
                VStack(spacing: 1.5) {
                    Text(topic?.title ?? "独立话题")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .lineLimit(1)
                    NavSyncSubtitleView(
                        isSyncing: isLoadingTopic || !initialLoadFinished,
                        text: "\(agentName) · 独立话题"
                    )
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Spacer(minLength: 4)

            WorkspaceActions(device: store.devices.first { $0.id == route.deviceId }, agent: route.agentId, chat: route.chatId, session: route.topicId)

            HStack(spacing: 6) {
                if let topic {
                    if topic.isCleared {
                        Button {
                            store.restoreSessions(deviceId: route.deviceId, sessionIds: [topic.id], banner: "已恢复此话题")
                        } label: {
                            Text("恢复")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(LeverTheme.inkPrimary)
                                .padding(.horizontal, 10)
                                .frame(height: 30)
                                .background(LeverTheme.surfaceInset)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    } else if topic.canClear {
                        Button {
                            store.clearSingleTopic(
                                deviceId: route.deviceId,
                                topicId: topic.id,
                                unreadSequence: topic.unreadSequence,
                                title: topic.title
                            )
                        } label: {
                            Text("清理")
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .padding(.horizontal, 11)
                                .frame(height: 30)
                                .background(LeverTheme.surfaceInset)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("清理此话题")
                    }
                }

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

                        if hasOtherUnreadTopics {
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
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(LeverTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private func openDrawer() {
        inputFocused = false
        Haptics.light()
        isDrawerOpen = true
    }

    // MARK: - Composer

    private var topicComposer: some View {
        VStack(spacing: 0) {
            if let trigger = activeTrigger {
                let mentionGroups: [(label: String, items: [MessageReference])] = {
                    if case .mention(_, let q) = trigger {
                        return store.mentionCandidates(
                            deviceId: route.deviceId,
                            currentAgentId: route.agentId,
                            currentSessionId: route.topicId,
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
                    allowModeCommands: false,
                    onSelectSkill: { skill in
                        if case .slash(let range, _) = trigger {
                            appendReference(skill, replacingRange: range)
                        }
                    },
                    onSelectSlashCommand: { cmd in
                        if case .slash(let range, _) = trigger {
                            replyText.replaceSubrange(range, with: "/\(cmd) ")
                            suggestionDismissed = true
                            inputFocused = true
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

                TextField("继续在此话题回复，输入 / 调用 Skill，@ 引用…", text: $replyText, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 15))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .focused($inputFocused)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)

                HStack(spacing: 8) {
                    ComposerPlusMenu(
                        workingCopies: [],
                        selectedWorkingCopyId: .constant(nil),
                        onPickPhotos: {
                            Haptics.light()
                            showPhotoPicker = true
                        },
                        onPickFiles: {
                            Haptics.light()
                            showFileImporter = true
                        },
                        onInsertMention: {
                            Haptics.light()
                            showMentionSheet = true
                        },
                        onInsertSlash: {
                            Haptics.light()
                            if replyText.isEmpty || replyText.last?.isWhitespace == true || replyText.last?.isNewline == true {
                                replyText.append("/")
                            } else {
                                replyText.append(" /")
                            }
                            suggestionDismissed = false
                            inputFocused = true
                        }
                    )

                    Spacer()

                    ComposerModelTriggerPill(
                        provider: effectiveProviderCatalog,
                        providerId: effectiveProviderId,
                        modelName: effectiveModelName,
                        effort: effectiveEffort,
                        fast: effectiveFast
                    ) {
                        Haptics.light()
                        showModelPicker = true
                        Task {
                            await store.loadComposerMeta(
                                deviceId: route.deviceId,
                                agentId: route.agentId,
                                chatId: route.chatId,
                                sessionId: route.topicId,
                                providerId: effectiveProviderId
                            )
                        }
                    }

                    let hasUploading = draftAttachments.contains(where: \.isUploading)
                    let hasUploadedAttachments = draftAttachments.contains(where: { $0.uploaded != nil })
                    let canSend = !isSending
                        && !hasUploading
                        && (!replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasUploadedAttachments)

                    Button {
                        sendReply()
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

    // MARK: - Actions

    private func markTopicRead() {
        guard let uSeq = topic?.unreadSequence, uSeq > 0 else { return }
        store.markSessionsRead(
            deviceId: route.deviceId,
            marks: [ReadMark(sessionId: route.topicId, sequence: uSeq)]
        )
    }

    private func buildSelection() -> ModelSelection? {
        guard selectedProviderId != nil || selectedModelId != nil || selectedEffort != nil || selectedFast != nil else { return nil }
        return ModelSelection(
            provider: selectedProviderId ?? topic?.provider ?? agentRecord?.provider,
            model: selectedModelId ?? topic?.model ?? agentRecord?.model,
            effort: selectedEffort ?? effectiveEffort,
            fast: selectedFast ?? effectiveFast,
            permission: nil
        )
    }

    private func appendReference(_ ref: MessageReference, replacingRange: Range<String.Index>?) {
        let token = "\(ref.kind == "skill" ? "$" : "@")\(ref.name) "
        if let range = replacingRange {
            replyText.replaceSubrange(range, with: token)
        } else if replyText.isEmpty || replyText.last?.isWhitespace == true || replyText.last?.isNewline == true {
            replyText.append(token)
        } else {
            replyText.append(" \(token)")
        }
        if !draftReferences.contains(where: { $0.id == ref.id }) {
            draftReferences.append(ref)
        }
        suggestionDismissed = true
        inputFocused = true
    }

    private func handlePickedPhotos(_ items: [PhotosPickerItem]) {
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
                        chatId: route.chatId,
                        agentId: route.agentId,
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
                        chatId: route.chatId,
                        agentId: route.agentId,
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

    private func sendReply() {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        let uploadedIds = draftAttachments.compactMap { $0.uploaded?.id }
        guard (!text.isEmpty || !uploadedIds.isEmpty), !isSending else { return }
        let selection = buildSelection()
        let savedAttachments = draftAttachments
        let savedReferences = draftReferences
        let resolvedRefs = ComposerMediaHelper.resolveReferences(in: text, references: savedReferences)

        replyText = ""
        draftAttachments = []
        draftReferences = []
        followRequest &+= 1
        isSending = true
        inlineError = nil

        Task {
            defer { isSending = false }
            do {
                _ = try await store.sendMessage(
                    deviceId: route.deviceId,
                    agentId: route.agentId,
                    chatId: route.chatId,
                    isPrivate: route.isPrivate,
                    text: text,
                    mode: .topicReply(route.topicId),
                    selection: selection,
                    attachmentIds: uploadedIds.isEmpty ? nil : uploadedIds,
                    references: resolvedRefs.isEmpty ? nil : resolvedRefs
                )
            } catch {
                replyText = text
                draftAttachments = savedAttachments
                draftReferences = savedReferences
                inlineError = error.localizedDescription
            }
        }
    }

    private func handleAnswer(request: ArchiveRecord, answer: RequestAnswer?, allowRun: Bool) {
        followRequest &+= 1
        isSending = true
        inlineError = nil
        Task {
            defer { isSending = false }
            do {
                try await store.answerRequest(
                    deviceId: route.deviceId,
                    chatId: route.chatId,
                    isPrivate: route.isPrivate,
                    request: request,
                    answer: answer,
                    allowRun: allowRun
                )
            } catch {
                inlineError = error.localizedDescription
            }
        }
    }

    private func handleStop(runId: String) {
        followRequest &+= 1
        isSending = true
        Task {
            defer { isSending = false }
            try? await store.stopRun(deviceId: route.deviceId, chatId: route.chatId, isPrivate: route.isPrivate, runId: runId)
        }
    }
}
