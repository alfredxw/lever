import SwiftUI

enum NavDestination: Hashable {
    case chat(ChatRoute)
    case topic(TopicRoute)
}

/// Scheme A Home: WeChat-calm monochrome Agent feed with:
/// - Smooth in-place Expand/Collapse Topics animation (ScrollView + LazyVStack, zero UITableView jump)
/// - Global top-right toggle (expanded by default) + per-Agent manual collapse/expand chevron
/// - Global Agent / Chat / Topic search & authentic 5-kind Desktop avatars
/// - Seamless integration with native iOS Liquid Glass TabView
struct FeedView: View {
    @Bindable var store: LeverStore

    @State private var searchText = ""
    @State private var navPath: [NavDestination] = []
    @State private var manuallyCollapsedAgentIds: Set<String> = []
    @State private var manuallyExpandedAgentIds: Set<String> = []

    private var allRows: [AgentFeedRow] {
        store.cachedFeedRows
    }

    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var searchHits: [GlobalSearchHit] {
        guard !trimmedQuery.isEmpty else { return [] }
        return store.globalSearch(query: trimmedQuery)
    }

    private func isAgentTopicsExpanded(_ row: AgentFeedRow) -> Bool {
        guard !row.activeTopics.isEmpty else { return false }
        if store.homeTopicsExpanded {
            return !manuallyCollapsedAgentIds.contains(row.id)
        } else {
            return manuallyExpandedAgentIds.contains(row.id)
        }
    }

    private func toggleAgentTopics(_ row: AgentFeedRow) {
        Haptics.light()
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            if store.homeTopicsExpanded {
                if manuallyCollapsedAgentIds.contains(row.id) {
                    manuallyCollapsedAgentIds.remove(row.id)
                } else {
                    manuallyCollapsedAgentIds.insert(row.id)
                }
            } else {
                if manuallyExpandedAgentIds.contains(row.id) {
                    manuallyExpandedAgentIds.remove(row.id)
                } else {
                    manuallyExpandedAgentIds.insert(row.id)
                }
            }
        }
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            VStack(spacing: 0) {
                feedHeader

                if let banner = store.lastSyncBanner {
                    syncToastBanner(banner)
                }

                ScrollView {
                    LazyVStack(spacing: 0) {
                        if !trimmedQuery.isEmpty {
                            searchResultsSection
                        } else if allRows.isEmpty {
                            emptyFeedView
                                .padding(.top, 72)
                                .padding(.horizontal, 24)
                        } else {
                            ForEach(Array(allRows.enumerated()), id: \.element.id) { index, row in
                                let expanded = isAgentTopicsExpanded(row)
                                AgentWeChatGroupView(
                                    store: store,
                                    row: row,
                                    isPinned: store.isPinned(row.id),
                                    isTopicsExpanded: expanded,
                                    onOpenChat: {
                                        openAgent(row, topicId: nil)
                                    },
                                    onOpenTopic: { cue in
                                        openAgent(
                                            row,
                                            topicId: cue.id,
                                            chatIdOverride: cue.chatId,
                                            isPrivateOverride: cue.isPrivate
                                        )
                                    },
                                    onToggleTopics: {
                                        toggleAgentTopics(row)
                                    }
                                )
                                .contextMenu {
                                    if row.unreadSessionCount > 0 {
                                        Button {
                                            store.markAgentRead(row)
                                        } label: {
                                            Label("标为已读", systemImage: "checkmark.circle")
                                        }
                                    }
                                    Button {
                                        store.togglePin(row.id)
                                    } label: {
                                        Label(
                                            store.isPinned(row.id) ? "取消置顶" : "置顶",
                                            systemImage: store.isPinned(row.id) ? "pin.slash" : "pin"
                                        )
                                    }
                                    if !row.activeTopics.isEmpty {
                                        Button {
                                            toggleAgentTopics(row)
                                        } label: {
                                            Label(
                                                expanded ? "收起话题" : "展开话题",
                                                systemImage: expanded ? "chevron.up" : "chevron.down"
                                            )
                                        }
                                    }
                                }

                                if index < allRows.count - 1 {
                                    Rectangle()
                                        .fill(LeverTheme.hairline)
                                        .frame(height: 0.5)
                                        .padding(.leading, 76)
                                        .background(LeverTheme.surface)
                                }
                            }

                            Rectangle()
                                .fill(LeverTheme.hairline)
                                .frame(height: 0.5)
                        }
                    }
                    .padding(.bottom, 20)
                }
                .background(LeverTheme.canvas)
                .scrollDismissesKeyboard(.interactively)
                .refreshable {
                    await store.refreshAll(silent: false)
                }
            }
            .background(LeverTheme.canvas)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: NavDestination.self) { dest in
                switch dest {
                case .chat(let route):
                    ChatDetailView(
                        store: store,
                        route: route,
                        onOpenTopic: { topicRoute in
                            navPath.append(.topic(topicRoute))
                        }
                    )
                case .topic(let topicRoute):
                    TopicDetailView(store: store, route: topicRoute)
                }
            }
            .onChange(of: store.pendingNavigationRoute, initial: true) { _, route in
                guard let route else { return }
                var next: [NavDestination] = [.chat(route)]
                if let cid = route.chatId, let tid = route.initialTopicId, !tid.isEmpty {
                    next.append(.topic(TopicRoute(
                        deviceId: route.deviceId,
                        agentId: route.agentId,
                        chatId: cid,
                        isPrivate: route.isPrivate,
                        topicId: tid
                    )))
                }
                navPath = next
                store.pendingNavigationRoute = nil
            }
        }
    }

    // MARK: - Top Header (Title + Expand/Collapse Topics Toggle + Search)

    private var feedHeader: some View {
        VStack(spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text("聊天")
                    .font(.system(size: 27, weight: .bold))
                    .foregroundStyle(LeverTheme.inkPrimary)

                connectionDotPill

                Spacer(minLength: 6)

                if store.cachedTotalUnread > 0 {
                    Button {
                        store.markAllRead()
                    } label: {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(LeverTheme.inkSecondary)
                            .frame(width: 32, height: 32)
                            .background(LeverTheme.surfaceInset)
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("全部标为已读")
                }

                // Global Expand / Collapse Topics Toggle (Default: Expanded)
                Button {
                    Haptics.light()
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                        store.homeTopicsExpanded.toggle()
                        manuallyCollapsedAgentIds.removeAll()
                        manuallyExpandedAgentIds.removeAll()
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: store.homeTopicsExpanded ? "list.bullet.indent" : "list.bullet")
                            .font(.system(size: 12.5, weight: .semibold))
                        Text(store.homeTopicsExpanded ? "收起话题" : "展开话题")
                            .font(.system(size: 12.5, weight: .medium))
                    }
                    .foregroundStyle(store.homeTopicsExpanded ? LeverTheme.surface : LeverTheme.inkSecondary)
                    .padding(.horizontal, 11)
                    .frame(height: 32)
                    .background(store.homeTopicsExpanded ? LeverTheme.inkPrimary : LeverTheme.surfaceInset)
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(store.homeTopicsExpanded ? "收起子话题列表" : "展开子话题列表")
            }

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(LeverTheme.inkTertiary)
                TextField("搜索 Agent、历史对话或话题", text: $searchText)
                    .font(.system(size: 14.5))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .textInputAutocapitalization(.never)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(LeverTheme.inkTertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(LeverTheme.surfaceInset)
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(LeverTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private var connectionDotPill: some View {
        let online = store.hostDevices.contains(where: \.online)
        return HStack(spacing: 5) {
            Circle()
                .fill(online ? LeverTheme.runningEmerald : LeverTheme.inkTertiary)
                .frame(width: 6, height: 6)
            Text(store.connectionSummary)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(LeverTheme.inkTertiary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3.5)
        .background(LeverTheme.surfaceInset)
        .clipShape(Capsule())
    }

    private func syncToastBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 12, weight: .semibold))
            Text(message)
                .font(.system(size: 12.5, weight: .medium))
                .lineLimit(1)
            Spacer()
        }
        .foregroundStyle(LeverTheme.inkPrimary)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(LeverTheme.surfaceElevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Search Results

    @ViewBuilder
    private var searchResultsSection: some View {
        if searchHits.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(LeverTheme.inkTertiary)
                Text("未找到与「\(trimmedQuery)」相关的内容")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(LeverTheme.inkSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 64)
            .padding(.horizontal, 24)
        } else {
            ForEach(Array(searchHits.enumerated()), id: \.element.id) { idx, hit in
                Button {
                    openSearchHit(hit)
                } label: {
                    HStack(spacing: 12) {
                        AgentAvatarView(
                            name: hit.agentName,
                            avatar: hit.avatar,
                            avatarSpec: hit.avatarSpec,
                            deviceId: hit.deviceId,
                            store: store,
                            seed: "\(hit.deviceId):\(hit.agentId)",
                            size: 40
                        )
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(hit.title)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                Text(hit.kind.rawValue)
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(LeverTheme.inkSecondary)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2.5)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(Capsule())
                            }
                            HStack {
                                Text(hit.subtitle)
                                    .font(.system(size: 13))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                                    .lineLimit(1)
                                Spacer(minLength: 6)
                                if !hit.timeText.isEmpty {
                                    Text(hit.timeText)
                                        .font(.system(size: 11.5).monospacedDigit())
                                        .foregroundStyle(LeverTheme.inkTertiary)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(LeverTheme.surface)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if idx < searchHits.count - 1 {
                    Rectangle()
                        .fill(LeverTheme.hairline)
                        .frame(height: 0.5)
                        .padding(.leading, 68)
                        .background(LeverTheme.surface)
                }
            }
        }
    }

    private var emptyFeedView: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(LeverTheme.inkTertiary)
            Text("暂无已开放的 Agent 对话")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(LeverTheme.inkPrimary)
            Text("在电脑端开放 Agent 或新建对话后下拉刷新即可同步")
                .font(.system(size: 13))
                .foregroundStyle(LeverTheme.inkTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Navigation Helpers

    private func openAgent(
        _ row: AgentFeedRow,
        topicId: String?,
        chatIdOverride: String? = nil,
        isPrivateOverride: Bool? = nil
    ) {
        Haptics.light()
        let chatId = chatIdOverride ?? row.latestChat?.id
        let isPrivate = isPrivateOverride ?? row.isPrivate
        let chatRoute = ChatRoute(
            deviceId: row.device.id,
            agentId: row.agentId,
            chatId: chatId,
            isPrivate: isPrivate,
            initialTopicId: nil
        )
        if let topicId, let chatId {
            navPath = [
                .chat(chatRoute),
                .topic(TopicRoute(
                    deviceId: row.device.id,
                    agentId: row.agentId,
                    chatId: chatId,
                    isPrivate: isPrivate,
                    topicId: topicId
                )),
            ]
        } else {
            navPath = [.chat(chatRoute)]
        }
    }

    private func openSearchHit(_ hit: GlobalSearchHit) {
        Haptics.light()
        let chatRoute = ChatRoute(
            deviceId: hit.deviceId,
            agentId: hit.agentId,
            chatId: hit.chatId,
            isPrivate: hit.isPrivate,
            initialTopicId: nil
        )
        if let tid = hit.topicId, let cid = hit.chatId {
            navPath = [
                .chat(chatRoute),
                .topic(TopicRoute(
                    deviceId: hit.deviceId,
                    agentId: hit.agentId,
                    chatId: cid,
                    isPrivate: hit.isPrivate,
                    topicId: tid
                )),
            ]
        } else {
            navPath = [.chat(chatRoute)]
        }
    }
}

// MARK: - Scheme A Agent Row + Smooth In-Place Collapsible Sub-Topics

private struct AgentWeChatGroupView: View {
    let store: LeverStore
    let row: AgentFeedRow
    let isPinned: Bool
    let isTopicsExpanded: Bool
    let onOpenChat: () -> Void
    let onOpenTopic: (ActiveTopicCue) -> Void
    let onToggleTopics: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Button(action: onOpenChat) {
                    ZStack(alignment: .topTrailing) {
                        AgentAvatarView(
                            name: row.name,
                            avatar: row.avatar,
                            avatarSpec: row.avatarSpec,
                            deviceId: row.device.id,
                            store: store,
                            seed: row.id,
                            size: 48
                        )

                        if row.unreadSessionCount > 0 {
                            UnreadBadgePill(count: row.unreadSessionCount)
                                .offset(x: 6, y: -5)
                        }
                    }
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 4) {
                    // Row 1: Name + Pin + Right-aligned Timestamp (aligns uniformly across all rows)
                    Button(action: onOpenChat) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(row.name)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(LeverTheme.inkPrimary)
                                .lineLimit(1)

                            if isPinned {
                                Image(systemName: "pin.fill")
                                    .font(.system(size: 10))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }

                            Spacer(minLength: 6)

                            if !row.timeText.isEmpty {
                                Text(row.timeText)
                                    .font(.system(size: 12).monospacedDigit())
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    // Row 2: Status + Preview + Independent right-aligned Topic fold/unfold pill
                    HStack(alignment: .center, spacing: 6) {
                        Button(action: onOpenChat) {
                            HStack(spacing: 5) {
                                if row.pendingApprovalCount > 0 {
                                    Circle()
                                        .fill(LeverTheme.approvalAmberDot)
                                        .frame(width: 6.5, height: 6.5)
                                    Text("[待审批]")
                                        .font(.system(size: 13.5, weight: .medium))
                                        .foregroundStyle(LeverTheme.approvalAmber)
                                        .fixedSize()
                                } else if row.isRunning {
                                    Circle()
                                        .fill(LeverTheme.runningEmerald)
                                        .frame(width: 6.5, height: 6.5)
                                }

                                Text(stripMarkdownPreview(row.preview))
                                    .font(.system(size: 13.5))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                                    .lineLimit(1)

                                Spacer(minLength: 4)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if !row.activeTopics.isEmpty {
                            Button(action: onToggleTopics) {
                                HStack(spacing: 3) {
                                    Text("\(row.activeTopics.count)")
                                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                                    Image(systemName: "chevron.down")
                                        .font(.system(size: 9, weight: .semibold))
                                        .rotationEffect(.degrees(isTopicsExpanded ? 0 : -90))
                                }
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .padding(.horizontal, 7.5)
                                .frame(height: 22)
                                .background(LeverTheme.surfaceInset)
                                .clipShape(Capsule())
                                .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(isTopicsExpanded ? "收起 \(row.name) 的话题" : "展开 \(row.name) 的话题")
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)

            // Smooth in-place expandable sub-topics (no UITableView jump!)
            if isTopicsExpanded && !row.activeTopics.isEmpty {
                VStack(spacing: 5) {
                    ForEach(row.activeTopics) { cue in
                        Button {
                            onOpenTopic(cue)
                        } label: {
                            HStack(spacing: 7) {
                                Circle()
                                    .fill(subTopicDotColor(cue))
                                    .frame(width: 6, height: 6)

                                Text(cue.title)
                                    .font(.system(size: 13, weight: cue.isUnread ? .medium : .regular))
                                    .foregroundStyle(cue.isUnread ? LeverTheme.inkPrimary : LeverTheme.inkSecondary)
                                    .lineLimit(1)

                                Spacer(minLength: 6)

                                if cue.status == "approval" {
                                    Text("待审批")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(LeverTheme.approvalAmber)
                                } else if cue.status == "running" {
                                    Text("运行中")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(LeverTheme.runningEmerald)
                                } else if !cue.updatedText.isEmpty {
                                    Text(cue.updatedText)
                                        .font(.system(size: 11).monospacedDigit())
                                        .foregroundStyle(LeverTheme.inkTertiary)
                                }

                                if cue.isUnread {
                                    Circle()
                                        .fill(LeverTheme.unreadRed)
                                        .frame(width: 6, height: 6)
                                }
                            }
                            .padding(.horizontal, 11)
                            .padding(.vertical, 8)
                            .background(LeverTheme.surfaceElevated)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            if cue.isUnread && cue.unreadSequence > 0 {
                                Button {
                                    store.markSessionsRead(
                                        deviceId: row.device.id,
                                        marks: [ReadMark(sessionId: cue.id, sequence: cue.unreadSequence)],
                                        banner: "已将话题「\(cue.title)」标为已读"
                                    )
                                } label: {
                                    Label("标为已读", systemImage: "checkmark.circle")
                                }
                            }
                            if cue.canClear {
                                Button {
                                    store.clearSingleTopic(
                                        deviceId: row.device.id,
                                        topicId: cue.id,
                                        unreadSequence: cue.unreadSequence,
                                        title: cue.title
                                    )
                                } label: {
                                    Label("清理话题", systemImage: "archivebox")
                                }
                            }
                        }
                    }
                }
                .padding(.leading, 76)
                .padding(.trailing, 16)
                .padding(.bottom, 12)
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)),
                        removal: .opacity.combined(with: .move(edge: .top))
                    )
                )
            }
        }
        .background(LeverTheme.surface)
        .clipped()
    }

    private func subTopicDotColor(_ cue: ActiveTopicCue) -> Color {
        switch cue.status {
        case "approval": return LeverTheme.approvalAmberDot
        case "running": return LeverTheme.runningEmerald
        case "unread": return LeverTheme.inkPrimary
        default: return LeverTheme.inkTertiary.opacity(0.6)
        }
    }
}

struct UnreadBadgePill: View {
    let count: Int

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .bold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, count > 9 ? 5.5 : 0)
            .frame(minWidth: 19, minHeight: 19)
            .background(LeverTheme.unreadRed, in: Capsule())
            .overlay(Capsule().stroke(LeverTheme.surface, lineWidth: 2))
    }
}
