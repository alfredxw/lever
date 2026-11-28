import SwiftUI

/// Renders a single Run (user bubble + quiet Desktop-style continuous Agent prose +
/// collapsible tool steps + compact aggregate diff badge + interactive approval/question cards).
/// Conforms to `Equatable` so unchanged completed turns never re-evaluate during live streaming or scroll.
struct RunTurnView: View, Equatable {
    let run: ArchiveRecord
    let requests: [ArchiveRecord]
    let agentName: String
    let agentAvatar: String?
    var agentAvatarSpec: AvatarSpec? = nil
    var deviceId: String? = nil
    var store: LeverStore? = nil
    let agentSeed: String
    let isBusy: Bool
    var isSessionCleared: Bool = false
    var lazySteps: [RunItem]? = nil
    var isLoadingSteps: Bool = false
    var onLoadSteps: ((String) -> Void)? = nil
    let onAnswer: (ArchiveRecord, RequestAnswer?, Bool) -> Void
    let onStop: (String) -> Void

    @State private var showTools = false

    static func == (lhs: RunTurnView, rhs: RunTurnView) -> Bool {
        lhs.run == rhs.run
            && lhs.requests == rhs.requests
            && lhs.agentName == rhs.agentName
            && lhs.agentAvatar == rhs.agentAvatar
            && lhs.agentAvatarSpec == rhs.agentAvatarSpec
            && lhs.isBusy == rhs.isBusy
            && lhs.isSessionCleared == rhs.isSessionCleared
            && lhs.lazySteps == rhs.lazySteps
            && lhs.isLoadingSteps == rhs.isLoadingSteps
    }

    private var userText: String {
        run.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var contentItems: [RunItem] {
        (run.items ?? []).filter {
            ($0.kind == "text" || $0.kind == "user")
                && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private var embeddedToolItems: [RunItem] {
        (run.items ?? []).filter { $0.kind != "text" && $0.kind != "user" }
    }

    private var effectiveToolItems: [RunItem] {
        !embeddedToolItems.isEmpty ? embeddedToolItems : (lazySteps ?? [])
    }

    private var displayedStepCount: Int {
        max(effectiveToolItems.count, run.stepCount ?? 0)
    }

    private var effectiveStatus: String? {
        if isSessionCleared && run.status == "paused" {
            return "interrupted"
        }
        return run.status
    }

    private var isActive: Bool {
        isActiveRunStatus(effectiveStatus)
    }

    private var isPaused: Bool {
        !isSessionCleared && run.status == "paused"
    }

    private var diffSummary: (files: Int, additions: Int, deletions: Int)? {
        run.resolvedDiff
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            let runAttachments = run.attachments ?? []
            if !userText.isEmpty || !runAttachments.isEmpty {
                HStack {
                    Spacer(minLength: 48)
                    VStack(alignment: .trailing, spacing: 6) {
                        if !runAttachments.isEmpty {
                            HStack(spacing: 6) {
                                ForEach(runAttachments) { att in
                                    HStack(spacing: 5) {
                                        Image(systemName: att.isImage ? "photo" : "doc.fill")
                                            .font(.system(size: 11))
                                        Text(att.name)
                                            .font(.system(size: 11.5, weight: .medium))
                                            .lineLimit(1)
                                            .frame(maxWidth: 140, alignment: .leading)
                                    }
                                    .foregroundStyle(LeverTheme.inkSecondary)
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 5)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                }
                            }
                        }

                        if !userText.isEmpty {
                            MarkdownTextView(text: userText, foreground: LeverTheme.userBubbleInk, isUserBubble: true)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .background(LeverTheme.userBubbleBg)
                                .clipShape(
                                    UnevenRoundedRectangle(
                                        topLeadingRadius: 17,
                                        bottomLeadingRadius: 17,
                                        bottomTrailingRadius: 5,
                                        topTrailingRadius: 17,
                                        style: .continuous
                                    )
                                )
                                .overlay(
                                    UnevenRoundedRectangle(
                                        topLeadingRadius: 17,
                                        bottomLeadingRadius: 17,
                                        bottomTrailingRadius: 5,
                                        topTrailingRadius: 17,
                                        style: .continuous
                                    )
                                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
                                )
                        }
                    }
                }
            }

            if !contentItems.isEmpty || displayedStepCount > 0 || isActive || isPaused || diffSummary != nil || !(run.error ?? "").isEmpty {
                HStack(alignment: .top, spacing: 9) {
                    AgentAvatarView(
                        name: agentName,
                        avatar: agentAvatar,
                        avatarSpec: agentAvatarSpec,
                        deviceId: deviceId,
                        store: store,
                        seed: agentSeed,
                        size: 26
                    )
                    .padding(.top, 2)

                    VStack(alignment: .leading, spacing: 8) {
                        if displayedStepCount > 0 {
                            Button {
                                let nextOpen = !showTools
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    showTools = nextOpen
                                }
                                if nextOpen
                                    && embeddedToolItems.isEmpty
                                    && (effectiveToolItems.isEmpty || displayedStepCount > effectiveToolItems.count) {
                                    onLoadSteps?(run.id)
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: showTools ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 10, weight: .semibold))
                                    Text("\(displayedStepCount) 个执行步骤")
                                        .font(.system(size: 12, weight: .medium))
                                    Spacer()
                                    if isLoadingSteps {
                                        ProgressView()
                                            .scaleEffect(0.62)
                                            .tint(LeverTheme.inkTertiary)
                                    }
                                }
                                .foregroundStyle(LeverTheme.inkTertiary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(LeverTheme.surfaceInset)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            }
                            .buttonStyle(.plain)

                            if showTools {
                                if effectiveToolItems.isEmpty && isLoadingSteps {
                                    HStack(spacing: 8) {
                                        ProgressView()
                                            .scaleEffect(0.68)
                                            .tint(LeverTheme.inkTertiary)
                                        Text("正在按需加载执行步骤…")
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(LeverTheme.inkTertiary)
                                        Spacer()
                                    }
                                    .padding(10)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                } else if effectiveToolItems.isEmpty {
                                    HStack(spacing: 8) {
                                        Text("未能加载执行步骤")
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(LeverTheme.inkTertiary)
                                        Spacer()
                                        Button("重试") {
                                            onLoadSteps?(run.id)
                                        }
                                        .font(.system(size: 11.5, weight: .medium))
                                        .foregroundStyle(LeverTheme.inkSecondary)
                                        .buttonStyle(.plain)
                                    }
                                    .padding(10)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                } else {
                                    VStack(alignment: .leading, spacing: 6) {
                                        ForEach(effectiveToolItems) { item in
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
                        }

                        ForEach(contentItems) { item in
                            if item.kind == "user" {
                                Text(item.text ?? "")
                                    .font(.system(size: 13.5))
                                    .foregroundStyle(LeverTheme.inkSecondary)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            } else {
                                MarkdownTextView(text: item.text ?? "", foreground: LeverTheme.inkPrimary)
                            }
                        }

                        if let err = run.error, !err.isEmpty {
                            Text(err)
                                .font(.system(size: 13))
                                .foregroundStyle(LeverTheme.unreadRed)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(LeverTheme.unreadRed.opacity(0.09))
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }

                        if let diff = diffSummary {
                            DiffSummaryBadge(files: diff.files, additions: diff.additions, deletions: diff.deletions)
                        }

                        if isActive {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .scaleEffect(0.72)
                                    .tint(LeverTheme.runningEmerald)
                                Text(runStatusLabel(effectiveStatus))
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(effectiveStatus == "waiting_user" ? LeverTheme.approvalAmber : LeverTheme.runningEmerald)
                                Spacer()
                                if effectiveStatus != "cancelling" {
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
                        } else if isPaused {
                            HStack(spacing: 6) {
                                Image(systemName: "pause.circle")
                                    .font(.system(size: 12, weight: .medium))
                                Text("已暂停")
                                    .font(.system(size: 12, weight: .medium))
                            }
                            .foregroundStyle(LeverTheme.inkTertiary)
                            .padding(.top, 2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

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

/// Quiet Scheme A / Lever Desktop `Topic.tsx`-aligned inline Topic card inside the main Chat timeline.
struct InlineTopicCardView: View {
    let topic: TopicSummary
    let agentName: String
    let agentAvatar: String?
    var agentAvatarSpec: AvatarSpec? = nil
    var deviceId: String? = nil
    var store: LeverStore? = nil
    let agentSeed: String
    let onOpen: () -> Void

    private var isApproval: Bool { topic.status == "approval" }
    private var isRunning: Bool { topic.status == "running" }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 9) {
                // Root prompt / title
                Text(topic.rootPrompt)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                Rectangle()
                    .fill(LeverTheme.hairline)
                    .frame(height: 0.5)

                // Compact Desktop-style recent reply previews
                VStack(alignment: .leading, spacing: 6) {
                    if !topic.previewLines.isEmpty {
                        ForEach(topic.previewLines.prefix(2)) { line in
                            HStack(alignment: .center, spacing: 7) {
                                if line.isUser {
                                    Text("你")
                                        .font(.system(size: 10.5, weight: .semibold))
                                        .foregroundStyle(LeverTheme.inkSecondary)
                                        .frame(width: 18, height: 18)
                                        .background(LeverTheme.surfaceInset)
                                        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                                } else {
                                    AgentAvatarView(
                                        name: agentName,
                                        avatar: agentAvatar,
                                        avatarSpec: agentAvatarSpec,
                                        deviceId: deviceId,
                                        store: store,
                                        seed: agentSeed,
                                        size: 18
                                    )
                                }
                                Text(stripMarkdownPreview(line.text))
                                    .font(.system(size: 13))
                                    .foregroundStyle(LeverTheme.inkSecondary)
                                    .lineLimit(1)
                            }
                        }
                    } else if !topic.latestReplyText.isEmpty {
                        HStack(alignment: .center, spacing: 7) {
                            AgentAvatarView(
                                name: agentName,
                                avatar: agentAvatar,
                                avatarSpec: agentAvatarSpec,
                                deviceId: deviceId,
                                store: store,
                                seed: agentSeed,
                                size: 18
                            )
                            Text(stripMarkdownPreview(topic.latestReplyText))
                                .font(.system(size: 13))
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .lineLimit(1)
                        }
                    }

                    if let req = topic.pendingRequest {
                        HStack(spacing: 5) {
                            Circle().fill(LeverTheme.approvalAmberDot).frame(width: 6, height: 6)
                            Text((req.text?.isEmpty == false ? req.text! : req.title) ?? "等待确认命令")
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(LeverTheme.approvalAmber)
                                .lineLimit(1)
                        }
                    }
                }

                // Quiet Footer
                HStack(spacing: 8) {
                    HStack(spacing: 5) {
                        Image(systemName: "bubble.left")
                            .font(.system(size: 11))
                        Text("\(topic.replyCount) 条回复")
                            .font(.system(size: 12))
                    }
                    .foregroundStyle(LeverTheme.inkTertiary)

                    if isApproval {
                        HStack(spacing: 4) {
                            Circle().fill(LeverTheme.approvalAmberDot).frame(width: 5.5, height: 5.5)
                            Text("等你审批")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .foregroundStyle(LeverTheme.approvalAmber)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(LeverTheme.approvalAmberSoft)
                        .clipShape(Capsule())
                    } else if isRunning {
                        HStack(spacing: 4) {
                            Circle().fill(LeverTheme.runningEmerald).frame(width: 5.5, height: 5.5)
                            Text("运行中")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .foregroundStyle(LeverTheme.runningEmerald)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(LeverTheme.runningEmeraldSoft)
                        .clipShape(Capsule())
                    } else if topic.status == "failed" {
                        Text("执行失败")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(LeverTheme.unreadRed)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2.5)
                            .background(LeverTheme.unreadRed.opacity(0.11))
                            .clipShape(Capsule())
                    } else if topic.isCleared {
                        Text("已清理")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(LeverTheme.inkTertiary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2.5)
                            .background(LeverTheme.surfaceInset)
                            .clipShape(Capsule())
                    }

                    Spacer(minLength: 4)

                    if topic.isUnread {
                        Circle()
                            .fill(LeverTheme.unreadRed)
                            .frame(width: 6.5, height: 6.5)
                    }

                    Text("查看 ›")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(LeverTheme.inkSecondary)
                }
                .padding(.top, 2)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(LeverTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .strokeBorder(LeverTheme.hairlineStrong, lineWidth: 0.5)
            )
            .shadow(color: Color.black.opacity(0.03), radius: 6, x: 0, y: 2)
        }
        .buttonStyle(.plain)
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
                Circle()
                    .fill(isPending ? LeverTheme.approvalAmberDot : LeverTheme.runningEmerald)
                    .frame(width: 7, height: 7)
                Text(request.title?.isEmpty == false ? request.title! : (request.type == "question" ? "需要回答" : "请求审批命令"))
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkPrimary)
                Spacer()
                Text(isPending ? "等待确认" : runStatusLabel(request.status))
                    .font(.system(size: 11.5))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }

            if let detail = request.text, !detail.isEmpty {
                Text(detail)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(LeverTheme.surfaceInset)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
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
                                    .frame(height: 38)
                                    .background(opt.allow == true ? LeverTheme.inkPrimary : LeverTheme.surfaceInset)
                                    .foregroundStyle(opt.allow == true ? LeverTheme.surface : LeverTheme.inkPrimary)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(disabled)
                        }
                    } else {
                        Button {
                            onSubmit(request.allowOnce ?? RequestAnswer(allow: true, optionId: nil, answers: nil), false)
                        } label: {
                            Text("允许一次")
                                .font(.system(size: 13, weight: .semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                                .background(LeverTheme.inkPrimary)
                                .foregroundStyle(LeverTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled)

                        Button {
                            onSubmit(nil, true)
                        } label: {
                            Text("本轮允许")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 12)
                                .frame(height: 38)
                                .background(LeverTheme.surfaceInset)
                                .foregroundStyle(LeverTheme.inkPrimary)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(disabled)

                        Button {
                            onSubmit(RequestAnswer(allow: false, optionId: nil, answers: nil), false)
                        } label: {
                            Text("拒绝")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 14)
                                .frame(height: 38)
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
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(LeverTheme.hairlineStrong, lineWidth: 0.5)
        )
    }

    private var canSubmitQuestions: Bool {
        guard let qs = request.questions, !qs.isEmpty else { return false }
        return qs.allSatisfy { q in
            !(answers[q.id]?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.isEmpty ?? true)
        }
    }

    private var resolvedSummary: String {
        if let ans = request.answer {
            if let optId = ans.optionId,
               let match = request.options?.first(where: { $0.id == optId }) {
                return "已选择：\(match.name)"
            }
            if let qa = ans.answers, !qa.isEmpty {
                return "已提交回答"
            }
            return ans.allow ? "已允许执行" : "已拒绝"
        }
        return "已同步处理状态"
    }

    private func toggleOption(question: RequestQuestion, option: RequestOption) {
        var list = answers[question.id] ?? []
        if question.multiple == true {
            if let idx = list.firstIndex(of: option.id) {
                list.remove(at: idx)
            } else {
                list.append(option.id)
            }
        } else {
            list = [option.id]
        }
        answers[question.id] = list
    }
}

/// Compact aggregate diff pill displayed right after an assistant reply (no per-file breakdown).
struct DiffSummaryBadge: View {
    let files: Int
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(LeverTheme.inkTertiary)
            Text(files > 0 ? "\(files) 个文件变更" : "文件变更")
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(LeverTheme.inkSecondary)
            if additions > 0 {
                Text("+\(additions)")
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(LeverTheme.runningEmerald)
            }
            if deletions > 0 {
                Text("-\(deletions)")
                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(LeverTheme.unreadRed)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(LeverTheme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(LeverTheme.hairline, lineWidth: 0.5)
        )
    }
}

/// Full Block + Inline cached Markdown renderer (headings, fenced code blocks, lists, quotes, tables, inline code).
struct MarkdownTextView: View, Equatable {
    let text: String
    let foreground: Color
    var isUserBubble: Bool = false

    static func == (lhs: MarkdownTextView, rhs: MarkdownTextView) -> Bool {
        lhs.text == rhs.text && lhs.isUserBubble == rhs.isUserBubble
    }

    var body: some View {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            MarkdownContentView(text: trimmed, foreground: foreground, isUserBubble: isUserBubble)
                .equatable()
        }
    }
}

/// Subtle grayscale shimmer skeleton shown during cold-cache first sync so users immediately
/// see that messages are being fetched from Desktop instead of staring at a blank screen.
struct ConversationLoadingSkeleton: View {
    var message: String = "正在同步消息…"
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 7) {
                ProgressView()
                    .scaleEffect(0.75)
                    .tint(LeverTheme.inkSecondary)
                Text(message)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)

            // User bubble placeholder
            HStack {
                Spacer(minLength: 90)
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(LeverTheme.surfaceInset)
                    .frame(height: 38)
            }

            // Assistant reply placeholder
            HStack(alignment: .top, spacing: 9) {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(LeverTheme.surfaceInset)
                    .frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(LeverTheme.surfaceInset)
                        .frame(height: 14)
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(LeverTheme.surfaceInset)
                        .frame(maxWidth: 240, minHeight: 14, maxHeight: 14)
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(LeverTheme.surfaceInset)
                        .frame(maxWidth: 170, minHeight: 14, maxHeight: 14)
                }
            }

            // Second turn placeholder
            HStack {
                Spacer(minLength: 130)
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(LeverTheme.surfaceInset)
                    .frame(height: 34)
            }

            HStack(alignment: .top, spacing: 9) {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(LeverTheme.surfaceInset)
                    .frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(LeverTheme.surfaceInset)
                        .frame(height: 14)
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(LeverTheme.surfaceInset)
                        .frame(maxWidth: 200, minHeight: 14, maxHeight: 14)
                }
            }
        }
        .opacity(pulse ? 0.52 : 0.92)
        .animation(.easeInOut(duration: 0.95).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = true }
        .padding(.vertical, 10)
    }
}

/// Non-blocking inline sync indicator displayed in navigation subtitles while warm-cached
/// conversations refresh their latest delta in the background.
struct NavSyncSubtitleView: View {
    let isSyncing: Bool
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            if isSyncing {
                ProgressView()
                    .scaleEffect(0.56)
                    .frame(width: 11, height: 11)
                    .tint(LeverTheme.inkTertiary)
            }
            Text(isSyncing ? "同步中…" : text)
                .font(.system(size: 11.5))
                .foregroundStyle(LeverTheme.inkTertiary)
                .lineLimit(1)
        }
        .animation(.easeOut(duration: 0.18), value: isSyncing)
    }
}
