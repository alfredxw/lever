import SwiftUI

/// Scheme 1 Home: Feishu-style IM feed with filter capsules, pinned quick-access strip,
/// swipe-to-read / pin actions, and inline active # Topic cue strips.
struct FeedView: View {
    @Bindable var store: LeverStore
    @State private var selectedFilter: FeedFilter = .all
    @State private var searchText = ""
    @State private var navPath: [ChatRoute] = []

    private var allRows: [AgentFeedRow] {
        store.allAgentFeedRows
    }

    private var pinnedRows: [AgentFeedRow] {
        allRows.filter { store.isPinned($0.id) }
    }

    private var filteredRows: [AgentFeedRow] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return allRows.filter { row in
            switch selectedFilter {
            case .all: break
            case .approval: if row.pendingApprovalCount == 0 { return false }
            case .running: if !row.isRunning { return false }
            case .unread: if row.unreadSessionCount == 0 { return false }
            }
            guard !q.isEmpty else { return true }
            return row.name.lowercased().contains(q)
                || row.preview.lowercased().contains(q)
                || row.device.name.lowercased().contains(q)
                || (row.activeTopicCue?.title.lowercased().contains(q) ?? false)
        }
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            VStack(spacing: 0) {
                feedTopBar
                filterBar

                if let banner = store.lastSyncBanner {
                    syncToastBanner(banner)
                }

                List {
                    if !pinnedRows.isEmpty && searchText.isEmpty && selectedFilter == .all {
                        pinnedStrip
                            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                            .listRowBackground(LeverTheme.surface)
                            .listRowSeparatorTint(LeverTheme.hairline)
                    }

                    if filteredRows.isEmpty {
                        emptyFeedView
                            .listRowInsets(EdgeInsets(top: 44, leading: 24, bottom: 44, trailing: 24))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    } else {
                        ForEach(filteredRows) { row in
                            AgentFeedRowView(
                                row: row,
                                isPinned: store.isPinned(row.id),
                                onOpenMain: {
                                    openAgent(row, topicId: nil)
                                },
                                onOpenTopic: { cue in
                                    openAgent(row, topicId: cue.id, chatIdOverride: cue.chatId, isPrivateOverride: cue.isPrivate)
                                }
                            )
                            .listRowInsets(EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
                            .listRowBackground(LeverTheme.surface)
                            .listRowSeparatorTint(LeverTheme.hairline)
                            .swipeActions(edge: .trailing, allowsFullSwipe: row.unreadSessionCount > 0) {
                                if row.unreadSessionCount > 0 {
                                    Button {
                                        store.markAgentRead(row)
                                    } label: {
                                        Label("标已读", systemImage: "checkmark.circle")
                                    }
                                    .tint(LeverTheme.inkPrimary)
                                }
                                Button {
                                    store.togglePin(row.id)
                                } label: {
                                    Label(store.isPinned(row.id) ? "取消置顶" : "置顶", systemImage: store.isPinned(row.id) ? "pin.slash" : "pin")
                                }
                                .tint(Color(.systemGray))
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(LeverTheme.canvas)
                .refreshable {
                    await store.refreshAll(silent: false)
                }
            }
            .background(LeverTheme.canvas)
            .navigationBarHidden(true)
            .navigationDestination(for: ChatRoute.self) { route in
                ChatDetailView(store: store, route: route)
            }
            .onChange(of: store.pendingNavigationRoute, initial: true) { _, route in
                guard let route else { return }
                navPath = [route]
                store.pendingNavigationRoute = nil
            }
        }
    }

    // MARK: - Header & Feishu Filter Capsules

    private var feedTopBar: some View {
        VStack(spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Text("消息")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(LeverTheme.inkPrimary)

                connectionBadge

                Spacer()

                if store.totalUnreadSessions > 0 {
                    Button {
                        store.markAllRead()
                    } label: {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(LeverTheme.inkPrimary)
                            .frame(width: 34, height: 34)
                            .background(LeverTheme.surfaceInset)
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("全部标为已读")
                }

                Button {
                    Task { await store.refreshAll(silent: false) }
                } label: {
                    Group {
                        if store.isSyncing {
                            ProgressView()
                                .scaleEffect(0.75)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 15, weight: .medium))
                        }
                    }
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .frame(width: 34, height: 34)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("刷新同步")
            }

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(LeverTheme.inkTertiary)
                TextField("搜索 Agent、对话或话题…", text: $searchText)
                    .font(.system(size: 14.5))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .textInputAutocapitalization(.never)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
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
        .padding(.bottom, 8)
        .background(LeverTheme.surface)
    }

    private var connectionBadge: some View {
        let online = store.hostDevices.contains(where: \.online)
        return HStack(spacing: 5) {
            Circle()
                .fill(online ? LeverTheme.runningEmerald : LeverTheme.inkTertiary)
                .frame(width: 6.5, height: 6.5)
            Text(store.connectionSummary)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(LeverTheme.inkSecondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(LeverTheme.surfaceInset)
        .clipShape(Capsule())
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(FeedFilter.allCases) { filter in
                    let count = badgeCount(for: filter)
                    let active = selectedFilter == filter
                    Button {
                        Haptics.light()
                        selectedFilter = filter
                    } label: {
                        HStack(spacing: 5) {
                            if filter == .approval && count > 0 && !active {
                                Circle().fill(LeverTheme.approvalAmberDot).frame(width: 6, height: 6)
                            } else if filter == .running && count > 0 && !active {
                                Circle().fill(LeverTheme.runningEmerald).frame(width: 6, height: 6)
                            }
                            Text(filter.rawValue)
                                .font(.system(size: 13, weight: active ? .semibold : .medium))
                            if count > 0 && filter != .all {
                                Text("\(count)")
                                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                                    .opacity(active ? 0.85 : 0.7)
                            }
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 30)
                        .background(active ? LeverTheme.inkPrimary : LeverTheme.surfaceInset)
                        .foregroundStyle(active ? LeverTheme.surface : LeverTheme.inkSecondary)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(LeverTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private func badgeCount(for filter: FeedFilter) -> Int {
        switch filter {
        case .all: return allRows.count
        case .approval: return store.totalPendingApprovals
        case .running: return store.totalRunningAgents
        case .unread: return store.totalUnreadSessions
        }
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
        .foregroundStyle(LeverTheme.syncBlue)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(LeverTheme.syncBlueSoft)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Pinned Quick-Access Strip

    private var pinnedStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("置顶捷径")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(LeverTheme.inkTertiary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 16) {
                    ForEach(pinnedRows) { row in
                        Button {
                            openAgent(row, topicId: nil)
                        } label: {
                            VStack(spacing: 5) {
                                ZStack(alignment: .topTrailing) {
                                    AgentAvatarView(name: row.name, avatar: row.avatar, seed: row.id, size: 46)
                                        .overlay(alignment: .bottomTrailing) {
                                            if row.pendingApprovalCount > 0 {
                                                Circle()
                                                    .fill(LeverTheme.approvalAmberDot)
                                                    .frame(width: 12, height: 12)
                                                    .overlay(Circle().stroke(LeverTheme.surface, lineWidth: 2))
                                                    .offset(x: 2, y: 2)
                                            } else if row.isRunning {
                                                Circle()
                                                    .fill(LeverTheme.runningEmerald)
                                                    .frame(width: 12, height: 12)
                                                    .overlay(Circle().stroke(LeverTheme.surface, lineWidth: 2))
                                                    .offset(x: 2, y: 2)
                                            }
                                        }

                                    if row.unreadSessionCount > 0 {
                                        UnreadBadgePill(count: row.unreadSessionCount)
                                            .offset(x: 5, y: -4)
                                    }
                                }
                                Text(row.name)
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(LeverTheme.inkSecondary)
                                    .lineLimit(1)
                                    .frame(width: 58)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var emptyFeedView: some View {
        VStack(spacing: 10) {
            Image(systemName: selectedFilter == .all ? "bubble.left.and.bubble.right" : "checkmark.circle")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(LeverTheme.inkTertiary)
            Text(selectedFilter == .all ? "暂无已开放的 Agent 对话" : "当前筛选下没有会话")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(LeverTheme.inkPrimary)
            Text(selectedFilter == .all ? "在电脑端开放 Agent 或新建对话后下拉刷新即可同步" : "所有待处理事项均已与电脑端同步")
                .font(.system(size: 13))
                .foregroundStyle(LeverTheme.inkTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private func openAgent(
        _ row: AgentFeedRow,
        topicId: String?,
        chatIdOverride: String? = nil,
        isPrivateOverride: Bool? = nil
    ) {
        Haptics.light()
        let route = ChatRoute(
            deviceId: row.device.id,
            agentId: row.agentId,
            chatId: chatIdOverride ?? row.latestChat?.id,
            isPrivate: isPrivateOverride ?? row.isPrivate,
            initialTopicId: topicId
        )
        navPath.append(route)
    }
}

// MARK: - IM Feed Row with Nested Active Topic Cue

private struct AgentFeedRowView: View {
    let row: AgentFeedRow
    let isPinned: Bool
    let onOpenMain: () -> Void
    let onOpenTopic: (ActiveTopicCue) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .topTrailing) {
                AgentAvatarView(name: row.name, avatar: row.avatar, seed: row.id, size: 48)
                if row.unreadSessionCount > 0 {
                    UnreadBadgePill(count: row.unreadSessionCount)
                        .offset(x: 6, y: -5)
                }
            }
            .onTapGesture(perform: onOpenMain)

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(row.name)
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .lineLimit(1)

                    Text(row.device.name)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(LeverTheme.inkTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(LeverTheme.surfaceInset)
                        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .lineLimit(1)

                    if isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 9.5))
                            .foregroundStyle(LeverTheme.inkTertiary)
                    }

                    Spacer(minLength: 4)

                    Text(row.timeText)
                        .font(.system(size: 11.5).monospacedDigit())
                        .foregroundStyle(LeverTheme.inkTertiary)
                }

                HStack(spacing: 4) {
                    if row.pendingApprovalCount > 0 {
                        Text("[待审批]")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(LeverTheme.approvalAmber)
                    } else if row.isRunning {
                        Text("[运行中]")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(LeverTheme.runningEmerald)
                    }
                    Text(row.preview)
                        .font(.system(size: 13.5))
                        .foregroundStyle(LeverTheme.inkSecondary)
                        .lineLimit(1)
                }

                // Scheme 1 Signature: Nested active # Topic cue strip
                if let cue = row.activeTopicCue {
                    Button {
                        onOpenTopic(cue)
                    } label: {
                        let isAppr = cue.status == "approval"
                        let accent = isAppr ? LeverTheme.approvalAmber : LeverTheme.runningEmerald
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 1.5)
                                .fill(accent)
                                .frame(width: 2.5, height: 15)

                            Text("#")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(accent)

                            Text(cue.title)
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(LeverTheme.inkPrimary)
                                .lineLimit(1)

                            Spacer(minLength: 4)

                            Text(cueMetaText(cue))
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(accent)
                                .fixedSize()
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 6)
                        .background(isAppr ? LeverTheme.approvalAmberSoft : LeverTheme.runningEmeraldSoft)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpenMain)
        }
    }

    private func cueMetaText(_ cue: ActiveTopicCue) -> String {
        if cue.status == "approval" { return "等你审批 ›" }
        if cue.status == "running" { return "运行中 ›" }
        if cue.isUnread { return "新回复 ›" }
        return "\(cue.replyCount) 回复 ›"
    }
}

struct UnreadBadgePill: View {
    let count: Int

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .bold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 18)
            .background(LeverTheme.unreadRed)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(LeverTheme.surface, lineWidth: 1.8))
    }
}
