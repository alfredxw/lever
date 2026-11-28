import SwiftUI

/// Right-edge slide-over drawer inside ChatDetailView displaying the current Agent's
/// un-cleared Topics and Chats, with an interactive toggle to inspect and restore
/// cleared Topics and Chats (bidirectionally synced with Lever Desktop).
struct AgentDrawerView: View {
    @Bindable var store: LeverStore
    let deviceId: String
    let agentId: String
    let agentName: String
    let agentAvatar: String?
    let agentAvatarSpec: AvatarSpec?
    let currentChatId: String?
    let onSelectTopic: (AgentDrawerTopicItem) -> Void
    let onSelectChat: (AgentDrawerChatItem) -> Void
    let onStartNewChat: () -> Void
    let onClose: () -> Void

    @State private var showCleared = false

    private var data: AgentDrawerData {
        store.agentDrawerData(deviceId: deviceId, agentId: agentId)
    }

    var body: some View {
        VStack(spacing: 0) {
            drawerHeader
            clearedToggleBar

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    // Section 1: Active (Un-cleared) Topics
                    VStack(alignment: .leading, spacing: 6) {
                        sectionHeader(title: "未清理话题", count: data.activeTopics.count)
                        if data.activeTopics.isEmpty {
                            emptyRow("暂无未清理的话题")
                        } else {
                            ForEach(data.activeTopics) { item in
                                topicRow(item, clearedStyle: false)
                            }
                        }
                    }

                    // Section 2: Active (Un-cleared) Chats
                    VStack(alignment: .leading, spacing: 6) {
                        sectionHeader(title: "未清理对话", count: data.activeChats.count)
                        if data.activeChats.isEmpty {
                            emptyRow("暂无未清理的对话")
                        } else {
                            ForEach(data.activeChats) { item in
                                chatRow(item, clearedStyle: false)
                            }
                        }
                    }

                    // Optional Section 3 & 4: Cleared Topics & Chats when toggle is ON
                    if showCleared {
                        Rectangle()
                            .fill(LeverTheme.hairline)
                            .frame(height: 0.5)
                            .padding(.vertical, 2)

                        VStack(alignment: .leading, spacing: 6) {
                            sectionHeader(title: "已清理话题", count: data.clearedTopics.count)
                            if data.clearedTopics.isEmpty {
                                emptyRow("暂无已清理的话题")
                            } else {
                                ForEach(data.clearedTopics) { item in
                                    topicRow(item, clearedStyle: true)
                                }
                            }
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            sectionHeader(title: "已清理对话", count: data.clearedChats.count)
                            if data.clearedChats.isEmpty {
                                emptyRow("暂无已清理的对话")
                            } else {
                                ForEach(data.clearedChats) { item in
                                    chatRow(item, clearedStyle: true)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
            }
            .scrollIndicators(.hidden)

            // Bottom New Chat Action
            VStack(spacing: 0) {
                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
                Button {
                    Haptics.light()
                    onStartNewChat()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                        Text("新建对话")
                            .font(.system(size: 14.5, weight: .semibold))
                    }
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 42)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 16)
            }
            .background(LeverTheme.surface)
        }
        .background(LeverTheme.surface)
    }

    // MARK: - Header & Cleared Toggle

    private var drawerHeader: some View {
        HStack(spacing: 10) {
            AgentAvatarView(
                name: agentName,
                avatar: agentAvatar,
                avatarSpec: agentAvatarSpec,
                deviceId: deviceId,
                store: store,
                seed: "\(deviceId):\(agentId)",
                size: 34
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(agentName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .lineLimit(1)
                Text("话题与对话目录")
                    .font(.system(size: 11.5))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }
            Spacer(minLength: 4)
            Button {
                Haptics.light()
                onClose()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkSecondary)
                    .frame(width: 30, height: 30)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭侧栏")
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private var clearedToggleBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "archivebox")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(LeverTheme.inkSecondary)
                Text("显示已清理")
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(LeverTheme.inkPrimary)
                if data.clearedTotalCount > 0 {
                    Text("\(data.clearedTotalCount)")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(LeverTheme.inkSecondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(LeverTheme.surfaceInset)
                        .clipShape(Capsule())
                }
            }
            Spacer()
            Toggle("", isOn: Binding(
                get: { showCleared },
                set: { next in
                    Haptics.light()
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                        showCleared = next
                    }
                }
            ))
            .labelsHidden()
            .tint(LeverTheme.switchTint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(LeverTheme.surfaceElevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    // MARK: - Section & Rows

    private func sectionHeader(title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(LeverTheme.inkTertiary)
            Text("\(count)")
                .font(.system(size: 11, weight: .medium).monospacedDigit())
                .foregroundStyle(LeverTheme.inkTertiary)
            Spacer()
        }
        .padding(.horizontal, 4)
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12.5))
            .foregroundStyle(LeverTheme.inkTertiary)
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(LeverTheme.surfaceElevated.opacity(0.7))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func topicRow(_ item: AgentDrawerTopicItem, clearedStyle: Bool) -> some View {
        HStack(spacing: 8) {
            Button {
                Haptics.light()
                onSelectTopic(item)
            } label: {
                HStack(spacing: 8) {
                    Circle()
                        .fill(topicDotColor(item, cleared: clearedStyle))
                        .frame(width: 6.5, height: 6.5)

                    VStack(alignment: .leading, spacing: 2.5) {
                        Text(item.title)
                            .font(.system(size: 13.5, weight: item.isUnread ? .semibold : .medium))
                            .foregroundStyle(clearedStyle ? LeverTheme.inkSecondary : LeverTheme.inkPrimary)
                            .lineLimit(1)

                        HStack(spacing: 5) {
                            if item.status == "approval" {
                                Text("待审批")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(LeverTheme.approvalAmber)
                            } else if item.status == "running" {
                                Text("运行中")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(LeverTheme.runningEmerald)
                            } else {
                                Text(item.chatTitle)
                                    .font(.system(size: 11))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                                    .lineLimit(1)
                            }
                            if !item.timeText.isEmpty {
                                Text("· \(item.timeText)")
                                    .font(.system(size: 11).monospacedDigit())
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }
                        }
                    }

                    Spacer(minLength: 4)

                    if item.isUnread {
                        Circle()
                            .fill(LeverTheme.unreadRed)
                            .frame(width: 6.5, height: 6.5)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if clearedStyle {
                Button {
                    store.restoreSessions(deviceId: deviceId, sessionIds: [item.id], banner: "已恢复话题「\(item.title)」")
                } label: {
                    Text("恢复")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(LeverTheme.surfacePill)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            } else if item.canClear {
                Button {
                    store.clearSingleTopic(
                        deviceId: deviceId,
                        topicId: item.id,
                        unreadSequence: item.unreadSequence,
                        title: item.title
                    )
                } label: {
                    Text("清理")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(LeverTheme.inkSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(LeverTheme.surfaceInset)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清理话题「\(item.title)」")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(clearedStyle ? LeverTheme.surfaceElevated.opacity(0.6) : LeverTheme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(LeverTheme.hairline, lineWidth: 0.5)
        )
        .contextMenu {
            if clearedStyle {
                Button {
                    store.restoreSessions(deviceId: deviceId, sessionIds: [item.id], banner: "已恢复话题「\(item.title)」")
                } label: {
                    Label("恢复话题", systemImage: "arrow.uturn.backward")
                }
            } else if item.canClear {
                Button {
                    store.clearSingleTopic(
                        deviceId: deviceId,
                        topicId: item.id,
                        unreadSequence: item.unreadSequence,
                        title: item.title
                    )
                } label: {
                    Label("清理话题", systemImage: "archivebox")
                }
            }
        }
    }

    private func chatRow(_ item: AgentDrawerChatItem, clearedStyle: Bool) -> some View {
        let isCurrent = item.id == currentChatId
        return HStack(spacing: 8) {
            Button {
                Haptics.light()
                onSelectChat(item)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isCurrent ? "bubble.left.fill" : "bubble.left")
                        .font(.system(size: 13))
                        .foregroundStyle(isCurrent ? LeverTheme.inkPrimary : LeverTheme.inkTertiary)
                        .frame(width: 18)

                    VStack(alignment: .leading, spacing: 2.5) {
                        Text(item.title)
                            .font(.system(size: 13.5, weight: isCurrent ? .semibold : .medium))
                            .foregroundStyle(clearedStyle ? LeverTheme.inkSecondary : LeverTheme.inkPrimary)
                            .lineLimit(1)

                        HStack(spacing: 5) {
                            if item.topicCount > 0 {
                                Text("\(item.topicCount) 话题")
                                    .font(.system(size: 11))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }
                            if !item.timeText.isEmpty {
                                Text(item.topicCount > 0 ? "· \(item.timeText)" : item.timeText)
                                    .font(.system(size: 11).monospacedDigit())
                                    .foregroundStyle(LeverTheme.inkTertiary)
                            }
                        }
                    }

                    Spacer(minLength: 4)

                    if item.unreadCount > 0 {
                        Text("\(item.unreadCount)")
                            .font(.system(size: 10.5, weight: .bold).monospacedDigit())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5.5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(LeverTheme.unreadRed, in: Capsule())
                    } else if isCurrent {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(LeverTheme.inkPrimary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if clearedStyle, !item.restoreSessionIds.isEmpty {
                Button {
                    store.restoreSessions(deviceId: deviceId, sessionIds: item.restoreSessionIds, banner: "已恢复对话「\(item.title)」")
                } label: {
                    Text("恢复")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(LeverTheme.surfacePill)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            } else if item.canClear && !item.clearMarks.isEmpty {
                Button {
                    store.clearSessions(
                        deviceId: deviceId,
                        marks: item.clearMarks,
                        alsoMarkRead: item.clearReadMarks,
                        banner: "已清理对话「\(item.title)」"
                    )
                } label: {
                    Text("清理")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(LeverTheme.inkSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(LeverTheme.surfaceInset)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清理对话「\(item.title)」")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(isCurrent ? LeverTheme.surfaceInset : (clearedStyle ? LeverTheme.surfaceElevated.opacity(0.6) : LeverTheme.surfaceElevated))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(isCurrent ? LeverTheme.hairlineStrong : LeverTheme.hairline, lineWidth: 0.5)
        )
        .contextMenu {
            if clearedStyle, !item.restoreSessionIds.isEmpty {
                Button {
                    store.restoreSessions(deviceId: deviceId, sessionIds: item.restoreSessionIds, banner: "已恢复对话「\(item.title)」")
                } label: {
                    Label("恢复对话", systemImage: "arrow.uturn.backward")
                }
            } else if item.canClear && !item.clearMarks.isEmpty {
                Button {
                    store.clearSessions(
                        deviceId: deviceId,
                        marks: item.clearMarks,
                        alsoMarkRead: item.clearReadMarks,
                        banner: "已清理对话「\(item.title)」"
                    )
                } label: {
                    Label("清理对话", systemImage: "archivebox")
                }
            }
        }
    }

    private func topicDotColor(_ item: AgentDrawerTopicItem, cleared: Bool) -> Color {
        if cleared { return LeverTheme.inkTertiary.opacity(0.45) }
        switch item.status {
        case "approval": return LeverTheme.approvalAmberDot
        case "running": return LeverTheme.runningEmerald
        case "unread": return LeverTheme.inkPrimary
        default: return LeverTheme.inkTertiary.opacity(0.65)
        }
    }
}
