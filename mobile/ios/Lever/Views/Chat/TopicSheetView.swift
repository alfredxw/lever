import SwiftUI

/// Scheme 1 Native iOS Topic Drawer Sheet: focused parallel Topic thread with
/// bidirectional read-state sync, inline approvals, and dedicated reply composer.
struct TopicSheetView: View {
    @Bindable var store: LeverStore
    let deviceId: String
    let agentId: String
    let agentName: String
    let agentAvatar: String?
    let agentSeed: String
    let chatId: String
    let isPrivate: Bool
    let topic: TopicSummary

    @Environment(\.dismiss) private var dismiss
    @State private var replyText = ""
    @State private var isSending = false
    @State private var inlineError: String?

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(topic.runs) { run in
                            RunTurnView(
                                run: run,
                                requests: topic.requestsByRun[run.id] ?? [],
                                agentName: agentName,
                                agentAvatar: agentAvatar,
                                agentSeed: agentSeed,
                                isBusy: isSending,
                                onAnswer: { req, ans, allowRun in
                                    handleAnswer(request: req, answer: ans, allowRun: allowRun)
                                },
                                onStop: { runId in
                                    handleStop(runId: runId)
                                }
                            )
                            .id(run.id)
                        }
                        Color.clear.frame(height: 6).id("topic-bottom")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(LeverTheme.canvas)
                .onChange(of: topic.runs.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo("topic-bottom", anchor: .bottom)
                    }
                }
            }

            if let err = inlineError, !err.isEmpty {
                Text(err)
                    .font(.system(size: 12.5))
                    .foregroundStyle(LeverTheme.unreadRed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(LeverTheme.unreadRed.opacity(0.10))
            }

            topicComposer
        }
        .background(LeverTheme.canvas)
        .onAppear {
            markTopicRead()
        }
        .onChange(of: topic.unreadSequence) { _, _ in
            markTopicRead()
        }
    }

    private var sheetHeader: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(topic.status == "approval" ? LeverTheme.approvalAmberSoft : LeverTheme.runningEmeraldSoft)
                Text("#")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(topic.status == "approval" ? LeverTheme.approvalAmber : LeverTheme.runningEmerald)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(topic.title)
                    .font(.system(size: 15.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .lineLimit(1)
                Text("\(agentName) · 独立话题 · 已与桌面同步已读")
                    .font(.system(size: 11.5))
                    .foregroundStyle(LeverTheme.inkTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(LeverTheme.inkSecondary)
                    .frame(width: 28, height: 28)
                    .background(LeverTheme.surfacePill)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 12)
        .background(LeverTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private var topicComposer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("回复此话题…", text: $replyText, axis: .vertical)
                .lineLimit(1...4)
                .font(.system(size: 15))
                .foregroundStyle(LeverTheme.inkPrimary)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(LeverTheme.surfaceInset)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button {
                sendReply()
            } label: {
                Group {
                    if isSending {
                        ProgressView()
                            .scaleEffect(0.75)
                            .tint(LeverTheme.surface)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                    }
                }
                .frame(width: 36, height: 36)
                .background(LeverTheme.inkPrimary)
                .foregroundStyle(LeverTheme.surface)
                .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(isSending || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(LeverTheme.surface)
        .overlay(alignment: .top) {
            Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
        }
    }

    private func markTopicRead() {
        guard topic.unreadSequence > 0 else { return }
        store.markSessionsRead(
            deviceId: deviceId,
            marks: [ReadMark(sessionId: topic.id, sequence: topic.unreadSequence)]
        )
    }

    private func sendReply() {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        replyText = ""
        isSending = true
        inlineError = nil

        Task {
            defer { isSending = false }
            do {
                _ = try await store.sendMessage(
                    deviceId: deviceId,
                    agentId: agentId,
                    chatId: chatId,
                    isPrivate: isPrivate,
                    text: text,
                    mode: .topicReply(topic.id)
                )
            } catch {
                replyText = text
                inlineError = error.localizedDescription
            }
        }
    }

    private func handleAnswer(request: ArchiveRecord, answer: RequestAnswer?, allowRun: Bool) {
        isSending = true
        inlineError = nil
        Task {
            defer { isSending = false }
            do {
                try await store.answerRequest(
                    deviceId: deviceId,
                    chatId: chatId,
                    isPrivate: isPrivate,
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
        isSending = true
        Task {
            defer { isSending = false }
            try? await store.stopRun(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate, runId: runId)
        }
    }
}
