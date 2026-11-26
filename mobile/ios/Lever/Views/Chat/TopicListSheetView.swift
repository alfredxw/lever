import SwiftUI

/// Top-right `#` directory sheet: browse all Topics in the current Chat and switch between historical Chats.
struct TopicListSheetView: View {
    @Bindable var store: LeverStore
    let deviceId: String
    let agentId: String
    let agentName: String
    let currentChatId: String?
    let topics: [TopicSummary]
    let onSelectTopic: (String) -> Void
    let onSelectChat: (ArchiveRecord) -> Void
    let onStartNewChat: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var chats: [ArchiveRecord] {
        store.chatsForAgent(deviceId: deviceId, agentId: agentId)
    }

    var body: some View {
        NavigationStack {
            List {
                if !topics.isEmpty {
                    Section("当前对话的独立话题 (\(topics.count))") {
                        ForEach(topics) { topic in
                            Button {
                                onSelectTopic(topic.id)
                            } label: {
                                HStack(spacing: 10) {
                                    Text("#")
                                        .font(.system(size: 14, weight: .bold))
                                        .foregroundStyle(topic.status == "approval" ? LeverTheme.approvalAmber : LeverTheme.runningEmerald)
                                        .frame(width: 24, height: 24)
                                        .background(topic.status == "approval" ? LeverTheme.approvalAmberSoft : LeverTheme.runningEmeraldSoft)
                                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(topic.title)
                                            .font(.system(size: 14.5, weight: .semibold))
                                            .foregroundStyle(LeverTheme.inkPrimary)
                                            .lineLimit(1)
                                        Text("\(topic.replyCount) 轮对话")
                                            .font(.system(size: 12))
                                            .foregroundStyle(LeverTheme.inkTertiary)
                                    }

                                    Spacer()

                                    if topic.status == "approval" {
                                        Text("待审批")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(LeverTheme.approvalAmber)
                                            .padding(.horizontal, 7)
                                            .padding(.vertical, 3)
                                            .background(LeverTheme.approvalAmberSoft)
                                            .clipShape(Capsule())
                                    } else if topic.isUnread {
                                        Circle()
                                            .fill(LeverTheme.unreadRed)
                                            .frame(width: 8, height: 8)
                                    }
                                }
                            }
                        }
                    }
                }

                Section("历史对话 (\(chats.count))") {
                    if !store.isDirectMode {
                        Button {
                            onStartNewChat()
                        } label: {
                            Label("发起新对话", systemImage: "plus.bubble")
                                .font(.system(size: 14.5, weight: .medium))
                                .foregroundStyle(LeverTheme.inkPrimary)
                        }
                    }

                    ForEach(chats) { chat in
                        let isCurrent = chat.id == currentChatId
                        Button {
                            onSelectChat(chat)
                        } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(chat.title?.isEmpty == false ? chat.title! : "未命名对话")
                                            .font(.system(size: 14.5, weight: isCurrent ? .semibold : .regular))
                                            .foregroundStyle(LeverTheme.inkPrimary)
                                            .lineLimit(1)
                                        if chat.isPrivate {
                                            Image(systemName: "lock.fill")
                                                .font(.system(size: 10))
                                                .foregroundStyle(LeverTheme.inkTertiary)
                                        }
                                    }
                                    Text(LeverDate.compact(chat.updatedAt ?? chat.createdAt))
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(LeverTheme.inkTertiary)
                                }
                                Spacer()
                                if isCurrent {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(LeverTheme.inkPrimary)
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("\(agentName) · 话题目录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(LeverTheme.inkPrimary)
                }
            }
        }
    }
}
