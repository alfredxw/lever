import SwiftUI

/// Scheme 1 Chat Detail: 1:1 desktop-aligned mixed timeline (main runs + inline Topic cards)
/// with anti-misclick segmented composer (`连续对话 / # 新话题`) and native Topic Sheet.
struct ChatDetailView: View {
    @Bindable var store: LeverStore
    let route: ChatRoute

    @Environment(\.dismiss) private var dismiss
    @State private var currentChatId: String?
    @State private var currentIsPrivate: Bool = false
    @State private var activeTopicId: String?
    @State private var showTopicDirectory = false

    @State private var composerText = ""
    @State private var composeNewTopic = false
    @State private var isSending = false
    @State private var inlineError: String?
    @State private var didOpenInitialTopic = false
    @FocusState private var inputFocused: Bool

    private var device: DeviceInfo? {
        store.devices.first { $0.id == route.deviceId }
    }

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

    private var agentSeed: String {
        "\(route.deviceId):\(route.agentId)"
    }

    private var timelineData: (entries: [TimelineEntry], topics: [TopicSummary], mainSession: ArchiveRecord?) {
        guard let cid = currentChatId else { return ([], [], nil) }
        return store.mixedTimeline(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
    }

    private var activeTopicBinding: Binding<TopicSummary?> {
        Binding(
            get: {
                guard let id = activeTopicId else { return nil }
                return timelineData.topics.first { $0.id == id }
            },
            set: { newValue in
                activeTopicId = newValue?.id
            }
        )
    }

    private var routeSubtitle: String {
        let devName = device?.name ?? "电脑"
        let stream: String
        if let cid = currentChatId {
            let key = store.chatKey(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate)
            stream = (store.chatRouteStreamByKey[key] == "lan" || currentIsPrivate || store.isDirectMode) ? "LAN 直连" : "Hub 共享"
        } else {
            stream = store.connectionSummary
        }
        return "\(devName) · \(stream) · 已同步桌面"
    }

    private var otherUnreadCount: Int {
        let currentAgentUnread = store.allAgentFeedRows
            .first { $0.device.id == route.deviceId && $0.agentId == route.agentId }?
            .unreadSessionCount ?? 0
        return max(0, store.totalUnreadSessions - currentAgentUnread)
    }

    var body: some View {
        VStack(spacing: 0) {
            chatNavigationBar

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if let cid = currentChatId {
                            let data = timelineData
                            if data.entries.isEmpty {
                                emptyChatPlaceholder
                            } else {
                                HStack {
                                    Spacer()
                                    Text("主对话与独立话题按时间混排")
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(LeverTheme.inkTertiary)
                                        .padding(.vertical, 4)
                                    Spacer()
                                }

                                ForEach(data.entries) { entry in
                                    switch entry {
                                    case .mainRun(let run, let requests):
                                        RunTurnView(
                                            run: run,
                                            requests: requests,
                                            agentName: agentName,
                                            agentAvatar: agentRecord?.avatar,
                                            agentSeed: agentSeed,
                                            isBusy: isSending,
                                            onAnswer: { req, ans, allowRun in
                                                handleAnswer(chatId: cid, request: req, answer: ans, allowRun: allowRun)
                                            },
                                            onStop: { runId in
                                                handleStop(chatId: cid, runId: runId)
                                            }
                                        )
                                        .id(entry.id)

                                    case .topicCard(let topic):
                                        InlineTopicCardView(
                                            topic: topic,
                                            agentName: agentName,
                                            onOpen: {
                                                Haptics.light()
                                                activeTopicId = topic.id
                                            }
                                        )
                                        .id(entry.id)
                                    }
                                }
                            }
                            Color.clear.frame(height: 6).id("bottom-anchor")
                        } else {
                            emptyChatPlaceholder
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(LeverTheme.canvas)
                .onChange(of: timelineData.entries.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo("bottom-anchor", anchor: .bottom)
                    }
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

            if timelineData.mainSession?.queuePaused == true, let mainId = timelineData.mainSession?.id, let cid = currentChatId {
                HStack {
                    Text("主会话排队已暂停")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(LeverTheme.approvalAmber)
                    Spacer()
                    Button("恢复队列") {
                        Task {
                            try? await store.resumeQueue(deviceId: route.deviceId, chatId: cid, isPrivate: currentIsPrivate, sessionId: mainId)
                        }
                    }
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(LeverTheme.approvalAmberSoft)
            }

            composerBar
        }
        .background(LeverTheme.canvas)
        .navigationBarHidden(true)
        .toolbar(.hidden, for: .tabBar)
        .task {
            currentChatId = route.chatId
            currentIsPrivate = route.isPrivate
            if let cid = route.chatId {
                await store.loadChat(deviceId: route.deviceId, chatId: cid, isPrivate: route.isPrivate)
                markMainSessionRead()
                if !didOpenInitialTopic, let tid = route.initialTopicId {
                    didOpenInitialTopic = true
                    activeTopicId = tid
                }
            }
        }
        .onDisappear {
            store.activeChatKey = nil
        }
        .onChange(of: timelineData.mainSession?.unreadSequence) { _, _ in
            markMainSessionRead()
        }
        .sheet(item: activeTopicBinding) { topic in
            if let cid = currentChatId {
                TopicSheetView(
                    store: store,
                    deviceId: route.deviceId,
                    agentId: route.agentId,
                    agentName: agentName,
                    agentAvatar: agentRecord?.avatar,
                    agentSeed: agentSeed,
                    chatId: cid,
                    isPrivate: currentIsPrivate,
                    topic: topic
                )
                .presentationDetents([.fraction(0.88), .large])
                .presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $showTopicDirectory) {
            TopicListSheetView(
                store: store,
                deviceId: route.deviceId,
                agentId: route.agentId,
                agentName: agentName,
                currentChatId: currentChatId,
                topics: timelineData.topics,
                onSelectTopic: { tid in
                    showTopicDirectory = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        activeTopicId = tid
                    }
                },
                onSelectChat: { chat in
                    showTopicDirectory = false
                    currentChatId = chat.id
                    currentIsPrivate = chat.isPrivate
                    Task {
                        await store.loadChat(deviceId: route.deviceId, chatId: chat.id, isPrivate: chat.isPrivate)
                        markMainSessionRead()
                    }
                },
                onStartNewChat: {
                    showTopicDirectory = false
                    currentChatId = nil
                    currentIsPrivate = false
                    composeNewTopic = false
                    store.activeChatKey = nil
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    // MARK: - Top Nav Bar

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

            AgentAvatarView(name: agentName, avatar: agentRecord?.avatar, seed: agentSeed, size: 32)

            VStack(alignment: .leading, spacing: 1) {
                Text(agentName)
                    .font(.system(size: 15.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .lineLimit(1)
                Text(routeSubtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(LeverTheme.inkTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            Button {
                Haptics.light()
                showTopicDirectory = true
            } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "number")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .frame(width: 34, height: 34)
                        .background(LeverTheme.surfaceInset)
                        .clipShape(Circle())

                    let unreadTopics = timelineData.topics.filter(\.isUnread).count
                    if unreadTopics > 0 {
                        Circle()
                            .fill(LeverTheme.unreadRed)
                            .frame(width: 8, height: 8)
                            .offset(x: 1, y: -1)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("查看话题与历史对话")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(LeverTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    // MARK: - Anti-Misclick Segmented Composer (连续对话 / # 新话题)

    private var composerBar: some View {
        VStack(spacing: 8) {
            // Mode Switcher Bar
            HStack(spacing: 8) {
                HStack(spacing: 2) {
                    composerSegmentButton(title: "连续对话", active: !composeNewTopic) {
                        composeNewTopic = false
                    }
                    composerSegmentButton(title: "# 新话题", active: composeNewTopic, accent: true) {
                        composeNewTopic = true
                    }
                }
                .padding(2.5)
                .background(LeverTheme.surfaceInset)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

                Spacer()

                Text(composeNewTopic ? "发完后自动切回连续对话" : (agentRecord?.model ?? "发往主会话"))
                    .font(.system(size: 11.5))
                    .foregroundStyle(composeNewTopic ? LeverTheme.runningEmerald : LeverTheme.inkTertiary)
                    .lineLimit(1)
            }

            // Input + Send
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    composeNewTopic ? "输入新话题首条消息，将独立并行执行…" : "发消息给 \(agentName)…",
                    text: $composerText,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .font(.system(size: 15))
                .foregroundStyle(LeverTheme.inkPrimary)
                .focused($inputFocused)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(LeverTheme.surfaceInset)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(composeNewTopic ? LeverTheme.runningEmerald.opacity(0.6) : Color.clear, lineWidth: 1)
                )

                Button {
                    submitMessage()
                } label: {
                    Group {
                        if isSending {
                            ProgressView()
                                .scaleEffect(0.75)
                                .tint(composeNewTopic ? .white : LeverTheme.surface)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                        }
                    }
                    .frame(width: 36, height: 36)
                    .background(composeNewTopic ? LeverTheme.runningEmerald : LeverTheme.inkPrimary)
                    .foregroundStyle(composeNewTopic ? .white : LeverTheme.surface)
                    .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(isSending || composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 9)
        .padding(.bottom, 10)
        .background(LeverTheme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private func composerSegmentButton(title: String, active: Bool, accent: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.light()
            action()
        } label: {
            Text(title)
                .font(.system(size: 12, weight: active ? .semibold : .medium))
                .foregroundStyle(active ? (accent ? LeverTheme.runningEmerald : LeverTheme.inkPrimary) : LeverTheme.inkTertiary)
                .padding(.horizontal, 10)
                .frame(height: 25)
                .background(active ? LeverTheme.surface : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var emptyChatPlaceholder: some View {
        VStack(spacing: 10) {
            AgentAvatarView(name: agentName, avatar: agentRecord?.avatar, seed: agentSeed, size: 54)
            Text(agentName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(LeverTheme.inkPrimary)
            Text("发送消息开始连续对话，或切换「# 新话题」开启并行线程")
                .font(.system(size: 13))
                .foregroundStyle(LeverTheme.inkTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.horizontal, 28)
    }

    // MARK: - Actions

    /// Opening the main chat marks ONLY the main session read (never unread Topics — aligned with docs/design.md).
    private func markMainSessionRead() {
        guard let main = timelineData.mainSession,
              let uSeq = main.unreadSequence, uSeq > 0 else { return }
        store.markSessionsRead(
            deviceId: route.deviceId,
            marks: [ReadMark(sessionId: main.id, sequence: uSeq)]
        )
    }

    private func submitMessage() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        let wantNewTopic = composeNewTopic && currentChatId != nil
        composerText = ""
        isSending = true
        inlineError = nil

        Task {
            defer { isSending = false }
            do {
                let receipt = try await store.sendMessage(
                    deviceId: route.deviceId,
                    agentId: route.agentId,
                    chatId: currentChatId,
                    isPrivate: currentIsPrivate,
                    text: text,
                    mode: wantNewTopic ? .newTopic : .main
                )
                if let newChatId = receipt.chatId, currentChatId == nil {
                    currentChatId = newChatId
                    await store.loadChat(deviceId: route.deviceId, chatId: newChatId, isPrivate: currentIsPrivate)
                }
                if wantNewTopic {
                    // Anti-misclick: always reset composer back to 连续对话 after creating a topic!
                    composeNewTopic = false
                    if let newTopicId = receipt.sessionId, !newTopicId.isEmpty {
                        activeTopicId = newTopicId
                    }
                }
            } catch {
                composerText = text
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
