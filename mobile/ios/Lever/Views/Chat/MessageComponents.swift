import SwiftUI

/// Renders a single Run (user prompt + assistant Markdown/tools/diffs + interactive approvals)
/// shared between the Main Chat mixed timeline and the focused Topic Sheet.
struct RunTurnView: View {
    let run: ArchiveRecord
    let requests: [ArchiveRecord]
    let agentName: String
    let agentAvatar: String?
    let agentSeed: String
    let isBusy: Bool
    let onAnswer: (ArchiveRecord, RequestAnswer?, Bool) -> Void
    let onStop: (String) -> Void

    @State private var showTools = false

    private var userText: String {
        run.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var textItems: [RunItem] {
        (run.items ?? []).filter { $0.kind == "text" && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private var toolItems: [RunItem] {
        (run.items ?? []).filter { $0.kind != "text" && $0.kind != "user" }
    }

    private var isActive: Bool {
        isActiveRunStatus(run.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // User bubble
            if !userText.isEmpty {
                HStack {
                    Spacer(minLength: 48)
                    MarkdownTextView(text: userText, foreground: LeverTheme.userBubbleInk)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(LeverTheme.userBubbleBg)
                        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
                }
            }

            // Agent response card
            if !textItems.isEmpty || !toolItems.isEmpty || isActive || !(run.files ?? []).isEmpty || !(run.error ?? "").isEmpty {
                HStack(alignment: .top, spacing: 9) {
                    AgentAvatarView(name: agentName, avatar: agentAvatar, seed: agentSeed, size: 28)
                        .padding(.top, 2)

                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 8) {
                            if !toolItems.isEmpty {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.18)) {
                                        showTools.toggle()
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: showTools ? "chevron.down" : "chevron.right")
                                            .font(.system(size: 10, weight: .semibold))
                                        Text("\(toolItems.count) 个执行步骤")
                                            .font(.system(size: 12, weight: .medium))
                                        Spacer()
                                    }
                                    .foregroundStyle(LeverTheme.inkTertiary)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                }
                                .buttonStyle(.plain)

                                if showTools {
                                    VStack(alignment: .leading, spacing: 6) {
                                        ForEach(toolItems) { item in
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(item.title?.isEmpty == false ? item.title! : item.kind)
                                                    .font(.system(size: 11.5, weight: .semibold))
                                                    .foregroundStyle(LeverTheme.inkSecondary)
                                                if let detail = item.text, !detail.isEmpty {
                                                    Text(detail)
                                                        .font(.system(size: 11, design: .monospaced))
                                                        .foregroundStyle(LeverTheme.inkTertiary)
                                                        .lineLimit(5)
                                                }
                                            }
                                            .padding(8)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .background(LeverTheme.surfaceInset)
                                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                        }
                                    }
                                }
                            }

                            ForEach(textItems) { item in
                                MarkdownTextView(text: item.text ?? "", foreground: LeverTheme.inkPrimary)
                            }

                            if let err = run.error, !err.isEmpty {
                                Text(err)
                                    .font(.system(size: 13))
                                    .foregroundStyle(LeverTheme.unreadRed)
                                    .padding(10)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(LeverTheme.unreadRed.opacity(0.09))
                                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                            }

                            if let files = run.files, !files.isEmpty {
                                FileDiffStrip(files: files)
                            }

                            if isActive {
                                HStack(spacing: 8) {
                                    ProgressView()
                                        .scaleEffect(0.72)
                                        .tint(LeverTheme.runningEmerald)
                                    Text(runStatusLabel(run.status))
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(run.status == "waiting_user" ? LeverTheme.approvalAmber : LeverTheme.runningEmerald)
                                    Spacer()
                                    if run.status != "cancelling" {
                                        Button {
                                            onStop(run.id)
                                        } label: {
                                            HStack(spacing: 4) {
                                                Image(systemName: "stop.fill")
                                                    .font(.system(size: 9))
                                                Text("停止")
                                                    .font(.system(size: 11.5, weight: .semibold))
                                            }
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 4)
                                            .background(LeverTheme.surfacePill)
                                            .foregroundStyle(LeverTheme.inkPrimary)
                                            .clipShape(Capsule())
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(isBusy)
                                    }
                                }
                                .padding(.top, 2)
                            }
                        }
                        .padding(.horizontal, 13)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(LeverTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .strokeBorder(LeverTheme.hairline, lineWidth: 0.5)
                        )
                    }
                }
            }

            // Approval / Question Cards bound to this Run
            ForEach(requests) { req in
                RequestActionCard(
                    request: req,
                    disabled: isBusy,
                    onSubmit: { ans, allowRun in
                        onAnswer(req, ans, allowRun)
                    }
                )
            }
        }
    }
}

/// Scheme 1 Signature: Inline Topic Card embedded inside the main chat mixed timeline.
struct InlineTopicCardView: View {
    let topic: TopicSummary
    let agentName: String
    let onOpen: () -> Void

    private var isApproval: Bool { topic.status == "approval" }
    private var isRunning: Bool { topic.status == "running" }

    private var accentColor: Color {
        if isApproval { return LeverTheme.approvalAmberDot }
        if isRunning { return LeverTheme.runningEmerald }
        if topic.status == "failed" { return LeverTheme.unreadRed }
        return LeverTheme.inkTertiary
    }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text("# 话题 · \(topic.title)")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(isApproval ? LeverTheme.approvalAmber : LeverTheme.runningEmerald)
                            .lineLimit(1)

                        Spacer(minLength: 6)

                        topicStatusPill
                    }

                    Text(topic.rootPrompt)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 11)

                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)

                // Recent reply + pending approval command preview
                VStack(alignment: .leading, spacing: 6) {
                    if !topic.latestReplyText.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(topic.latestReplyIsUser ? "你:" : "\(agentName):")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(LeverTheme.inkPrimary)
                                .fixedSize()
                            Text(
                                topic.latestReplyText
                                    .replacingOccurrences(of: "\n", with: " ")
                                    .replacingOccurrences(of: "`", with: "")
                            )
                                .font(.system(size: 12.5))
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .lineLimit(2)
                        }
                    }

                    if let req = topic.pendingRequest {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text("待审批:")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(LeverTheme.approvalAmber)
                                .fixedSize()
                            Text((req.text?.isEmpty == false ? req.text! : req.title) ?? "需要你的确认")
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(LeverTheme.approvalAmber)
                                .lineLimit(1)
                        }
                    }

                    if !topic.fileStats.isEmpty {
                        FileDiffStrip(files: Array(topic.fileStats.prefix(3)))
                            .padding(.top, 2)
                    }
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 9)

                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)

                // Footer
                HStack {
                    HStack(spacing: 6) {
                        if topic.isUnread {
                            Circle()
                                .fill(LeverTheme.unreadRed)
                                .frame(width: 6.5, height: 6.5)
                            Text("有新回复 · 共 \(topic.replyCount) 轮")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(LeverTheme.unreadRed)
                        } else {
                            Text("\(topic.replyCount) 轮对话 · 已读同步")
                                .font(.system(size: 12))
                                .foregroundStyle(LeverTheme.inkTertiary)
                        }
                    }
                    Spacer()
                    Text("进入话题 ›")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(LeverTheme.surfaceElevated)
            }
            .background(LeverTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(alignment: .leading) {
                UnevenRoundedRectangle(
                    topLeadingRadius: 15,
                    bottomLeadingRadius: 15,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: 0
                )
                .fill(accentColor)
                .frame(width: 3.5)
            }
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .strokeBorder(isApproval ? LeverTheme.approvalAmberDot.opacity(0.45) : LeverTheme.hairline, lineWidth: 0.75)
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var topicStatusPill: some View {
        if isApproval {
            Text("▲ 等你审批")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(LeverTheme.approvalAmber)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(LeverTheme.approvalAmberSoft)
                .clipShape(Capsule())
        } else if isRunning {
            Text("● 运行中")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(LeverTheme.runningEmerald)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(LeverTheme.runningEmeraldSoft)
                .clipShape(Capsule())
        } else if topic.status == "failed" {
            Text("执行失败")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(LeverTheme.unreadRed)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(LeverTheme.unreadRed.opacity(0.12))
                .clipShape(Capsule())
        } else {
            Text("✓ 已完成")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(LeverTheme.inkTertiary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(LeverTheme.surfacePill)
                .clipShape(Capsule())
        }
    }
}

/// Interactive Permission Approval & Multi-choice Question Card.
struct RequestActionCard: View {
    let request: ArchiveRecord
    let disabled: Bool
    let onSubmit: (RequestAnswer?, Bool) -> Void

    @State private var answers: [String: [String]] = [:]

    private var isPending: Bool { request.status == "pending" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: isPending ? "exclamationmark.shield.fill" : "checkmark.circle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(isPending ? LeverTheme.approvalAmber : LeverTheme.runningEmerald)
                Text(request.title?.isEmpty == false ? request.title! : (request.type == "question" ? "需要回答" : "请求审批"))
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                Spacer()
                Text(runStatusLabel(request.status))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }

            if let detail = request.text, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(LeverTheme.inkSecondary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }

            if !isPending {
                Text(resolvedSummary)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(LeverTheme.inkSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else if request.type == "question" {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(request.questions ?? []) { q in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(q.text)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(LeverTheme.inkPrimary)
                            if let opts = q.options, !opts.isEmpty {
                                ForEach(opts) { opt in
                                    let selected = answers[q.id]?.contains(opt.id) == true
                                    Button {
                                        Haptics.light()
                                        toggleOption(question: q, option: opt)
                                    } label: {
                                        HStack(spacing: 8) {
                                            Image(systemName: selected ? (q.multiple == true ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multiple == true ? "square" : "circle"))
                                                .foregroundStyle(selected ? LeverTheme.inkPrimary : LeverTheme.inkTertiary)
                                            Text(opt.name)
                                                .font(.system(size: 13))
                                                .foregroundStyle(LeverTheme.inkPrimary)
                                            Spacer()
                                        }
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 8)
                                        .background(selected ? LeverTheme.surfacePill : LeverTheme.surfaceInset)
                                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                }
                            } else {
                                TextField("输入回答…", text: Binding(
                                    get: { answers[q.id]?.first ?? "" },
                                    set: { answers[q.id] = [$0] }
                                ))
                                .font(.system(size: 13.5))
                                .padding(.horizontal, 10)
                                .frame(height: 38)
                                .background(LeverTheme.surfaceInset)
                                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                            }
                        }
                    }

                    Button {
                        onSubmit(RequestAnswer(allow: true, optionId: nil, answers: answers), false)
                    } label: {
                        Text("提交回答")
                            .font(.system(size: 13.5, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 38)
                            .background(LeverTheme.inkPrimary)
                            .foregroundStyle(LeverTheme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled || !canSubmitQuestions)
                }
            } else {
                HStack(spacing: 8) {
                    if let opts = request.options, !opts.isEmpty {
                        ForEach(opts) { opt in
                            Button {
                                onSubmit(RequestAnswer(allow: opt.allow ?? false, optionId: opt.id, answers: nil), false)
                            } label: {
                                Text(opt.name)
                                    .font(.system(size: 13, weight: .semibold))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 36)
                                    .background(opt.allow == true ? LeverTheme.inkPrimary : LeverTheme.surfacePill)
                                    .foregroundStyle(opt.allow == true ? LeverTheme.surface : LeverTheme.inkPrimary)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(disabled)
                        }
                    } else {
                        Button {
                            onSubmit(RequestAnswer(allow: true, optionId: nil, answers: nil), false)
                        } label: {
                            Text("允许一次")
                                .font(.system(size: 13, weight: .semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                                .background(LeverTheme.inkPrimary)
                                .foregroundStyle(LeverTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled)

                        if request.allowOnce != nil {
                            Button {
                                onSubmit(nil, true)
                            } label: {
                                Text("本轮允许")
                                    .font(.system(size: 13, weight: .semibold))
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 36)
                                    .background(LeverTheme.surfacePill)
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(disabled)
                        }

                        Button {
                            onSubmit(RequestAnswer(allow: false, optionId: nil, answers: nil), false)
                        } label: {
                            Text("拒绝")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 14)
                                .frame(height: 36)
                                .background(LeverTheme.surfaceInset)
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled)
                    }
                }
            }
        }
        .padding(13)
        .background(LeverTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(isPending ? LeverTheme.approvalAmberDot.opacity(0.6) : LeverTheme.hairline, lineWidth: isPending ? 1 : 0.5)
        )
    }

    private var canSubmitQuestions: Bool {
        let qs = request.questions ?? []
        return !qs.isEmpty && qs.allSatisfy { q in
            (answers[q.id] ?? []).contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
    }

    private var resolvedSummary: String {
        if request.type == "question", let map = request.answer?.answers {
            let vals = map.values.flatMap { $0 }.joined(separator: "，")
            return "已回答 · \(vals)"
        }
        if let opt = request.answer?.optionId, !opt.isEmpty {
            return "已选择 · \(opt)"
        }
        if let allow = request.answer?.allow {
            return allow ? "已允许" : "已拒绝"
        }
        return runStatusLabel(request.status)
    }

    private func toggleOption(question: RequestQuestion, option: RequestOption) {
        var current = answers[question.id] ?? []
        if question.multiple == true {
            if let idx = current.firstIndex(of: option.id) {
                current.remove(at: idx)
            } else {
                current.append(option.id)
            }
            answers[question.id] = current
        } else {
            answers[question.id] = [option.id]
        }
    }
}

struct FileDiffStrip: View {
    let files: [FileStat]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(files, id: \.self) { file in
                    HStack(spacing: 4) {
                        Text(file.name)
                            .foregroundStyle(LeverTheme.inkSecondary)
                        if file.additions > 0 {
                            Text("+\(file.additions)")
                                .foregroundStyle(LeverTheme.runningEmerald)
                        }
                        if file.deletions > 0 {
                            Text("-\(file.deletions)")
                                .foregroundStyle(LeverTheme.unreadRed)
                        }
                    }
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
        }
    }
}

struct MarkdownTextView: View {
    let text: String
    let foreground: Color

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
                .font(.system(size: 14.5))
                .foregroundStyle(foreground)
                .textSelection(.enabled)
                .lineSpacing(3)
        } else {
            Text(text)
                .font(.system(size: 14.5))
                .foregroundStyle(foreground)
                .textSelection(.enabled)
                .lineSpacing(3)
        }
    }
}
