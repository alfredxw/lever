import SwiftUI
import UIKit

/// Right-edge slide-over drawer inside ChatDetailView & TopicDetailView displaying the current Agent's
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
    var currentTopicId: String? = nil
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
        let isCurrent = item.id == currentTopicId
        return HStack(spacing: 8) {
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
                            .font(.system(size: 13.5, weight: (isCurrent || item.isUnread) ? .semibold : .medium))
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
                    } else if isCurrent {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(LeverTheme.inkPrimary)
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
        .background(isCurrent ? LeverTheme.surfaceInset : (clearedStyle ? LeverTheme.surfaceElevated.opacity(0.6) : LeverTheme.surfaceElevated))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(isCurrent ? LeverTheme.hairlineStrong : LeverTheme.hairline, lineWidth: 0.5)
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

// MARK: - Isolated 120fps Interactive Right-Edge Drawer Container

/// Shared stepless interactive drawer overlay for ChatDetailView & TopicDetailView.
/// Owns `progress` locally so 120fps dragging never re-evaluates the underlying timeline,
/// and uses a screen-scoped UIKit `UIPanGestureRecognizer` so pulling out and pushing back
/// track the finger 1:1 over both the drawer's `ScrollView` and the dimmed backdrop.
struct RightEdgeDrawerOverlay: View {
    @Binding var isOpen: Bool
    let store: LeverStore
    let deviceId: String
    let agentId: String
    let agentName: String
    let agentAvatar: String?
    let agentAvatarSpec: AvatarSpec?
    let currentChatId: String?
    var currentTopicId: String? = nil
    let onDismissKeyboard: () -> Void
    let onSelectTopic: (AgentDrawerTopicItem) -> Void
    let onSelectChat: (AgentDrawerChatItem) -> Void
    let onStartNewChat: () -> Void

    @State private var progress: CGFloat = 0
    @State private var isPresented = false
    @State private var isDragging = false
    @State private var dragStartProgress: CGFloat = 0

    private let drawerWidth: CGFloat = 312

    private var offsetX: CGFloat {
        (1 - progress) * drawerWidth
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            if isPresented {
                Color.black
                    .opacity(0.32 * Double(progress))
                    .ignoresSafeArea()
                    .allowsHitTesting(isOpen || isDragging)
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
                    currentTopicId: currentTopicId,
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
                .shadow(color: Color.black.opacity(0.18 * Double(progress)), radius: 24, x: -8, y: 0)
                .allowsHitTesting(isOpen)
                .zIndex(30)
            }
        }
        .background(
            DrawerPanGestureInstaller(
                drawerWidth: drawerWidth,
                isOpen: isOpen,
                currentProgress: progress,
                onBegin: handlePanBegan,
                onDelta: handlePanDelta,
                onEnd: handlePanEnded
            )
        )
        .onChange(of: isOpen) { _, newValue in
            guard !isDragging else { return }
            if newValue {
                if !isPresented || progress < 0.999 {
                    animateDrawer(open: true)
                }
            } else {
                if isPresented && progress > 0.001 {
                    animateDrawer(open: false)
                }
            }
        }
    }

    private func handlePanBegan() {
        isDragging = true
        let start: CGFloat = isOpen ? (progress > 0.001 ? progress : 1) : progress
        dragStartProgress = start
        if start < 0.05 {
            onDismissKeyboard()
        }
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) {
            isPresented = true
            progress = start
        }
    }

    private func handlePanDelta(_ deltaX: CGFloat) {
        let clamped = max(0, min(1, progress - deltaX / drawerWidth))
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) {
            progress = clamped
        }
    }

    private func handlePanEnded(_ deltaX: CGFloat, velocityX: CGFloat) {
        let current = max(0, min(1, progress - deltaX / drawerWidth))
        var tx = Transaction()
        tx.disablesAnimations = true
        withTransaction(tx) {
            progress = current
        }
        isDragging = false

        let targetOpen: Bool
        if velocityX < -350 {
            targetOpen = true
        } else if velocityX > 350 {
            targetOpen = false
        } else if dragStartProgress > 0.5 {
            targetOpen = current > 0.72
        } else {
            targetOpen = current > 0.26
        }

        let target: CGFloat = targetOpen ? 1 : 0
        let remaining = target - current
        let progressVelocity = -velocityX / drawerWidth
        let initialVelocity: Double
        if abs(remaining) > 0.04 {
            initialVelocity = max(-6, min(12, Double(progressVelocity / remaining)))
        } else {
            initialVelocity = 0
        }

        let shouldTriggerHaptic = targetOpen && !isOpen
        animateDrawer(open: targetOpen, initialVelocity: initialVelocity, hapticOnOpen: shouldTriggerHaptic)
    }

    private func animateDrawer(open: Bool, initialVelocity: Double = 0, hapticOnOpen: Bool = false) {
        if open {
            if hapticOnOpen {
                Haptics.light()
            }
            if !isPresented {
                var tx = Transaction()
                tx.disablesAnimations = true
                withTransaction(tx) {
                    progress = 0
                    isPresented = true
                    isOpen = true
                }
                DispatchQueue.main.async {
                    guard isOpen && !isDragging else { return }
                    withAnimation(.interpolatingSpring(duration: 0.30, bounce: 0.0, initialVelocity: initialVelocity)) {
                        progress = 1
                    }
                }
            } else {
                isOpen = true
                withAnimation(.interpolatingSpring(duration: 0.30, bounce: 0.0, initialVelocity: initialVelocity)) {
                    progress = 1
                }
            }
        } else {
            if progress <= 0.001 {
                isOpen = false
                progress = 0
                isPresented = false
                return
            }
            withAnimation(
                .interpolatingSpring(duration: 0.28, bounce: 0.0, initialVelocity: initialVelocity),
                completionCriteria: .logicallyComplete
            ) {
                isOpen = false
                progress = 0
            } completion: {
                if !isOpen && !isDragging && progress <= 0.001 {
                    isPresented = false
                }
            }
        }
    }

    private func close() {
        animateDrawer(open: false)
    }
}

private struct DrawerPanGestureInstaller: UIViewControllerRepresentable {
    let drawerWidth: CGFloat
    let isOpen: Bool
    let currentProgress: CGFloat
    let onBegin: () -> Void
    let onDelta: (CGFloat) -> Void
    let onEnd: (CGFloat, CGFloat) -> Void

    func makeUIViewController(context: Context) -> DrawerPanGestureController {
        let controller = DrawerPanGestureController()
        apply(to: controller)
        return controller
    }

    func updateUIViewController(_ uiViewController: DrawerPanGestureController, context: Context) {
        apply(to: uiViewController)
        uiViewController.installIfNeeded()
    }

    static func dismantleUIViewController(_ uiViewController: DrawerPanGestureController, coordinator: ()) {
        uiViewController.uninstall()
    }

    private func apply(to controller: DrawerPanGestureController) {
        controller.drawerWidth = drawerWidth
        controller.isOpen = isOpen
        controller.currentProgress = currentProgress
        controller.onBegin = onBegin
        controller.onDelta = onDelta
        controller.onEnd = onEnd
    }
}

private final class DrawerPanGestureController: UIViewController, UIGestureRecognizerDelegate {
    var drawerWidth: CGFloat = 312
    var isOpen: Bool = false
    var currentProgress: CGFloat = 0
    var onBegin: () -> Void = {}
    var onDelta: (CGFloat) -> Void = { _ in }
    var onEnd: (CGFloat, CGFloat) -> Void = { _, _ in }

    private weak var installedView: UIView?
    private var touchStartX: CGFloat = 0
    private weak var touchView: UIView?
    private var didBeginPan = false

    private lazy var panGesture: UIPanGestureRecognizer = {
        let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        recognizer.delegate = self
        recognizer.maximumNumberOfTouches = 1
        recognizer.cancelsTouchesInView = true
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        return recognizer
    }()

    override func loadView() {
        let container = UIView()
        container.backgroundColor = .clear
        container.isUserInteractionEnabled = false
        view = container
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        installIfNeeded()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installIfNeeded()
    }

    deinit {
        uninstall()
    }

    func installIfNeeded() {
        guard let targetView = resolveScreenContainerView() else { return }
        if installedView === targetView { return }
        uninstall()
        targetView.addGestureRecognizer(panGesture)
        installedView = targetView
    }

    func uninstall() {
        installedView?.removeGestureRecognizer(panGesture)
        installedView = nil
    }

    private func resolveScreenContainerView() -> UIView? {
        if let nav = navigationController {
            var cur: UIViewController? = self
            while let vc = cur {
                if vc.parent === nav {
                    return vc.view
                }
                cur = vc.parent
            }
        }
        return parent?.view ?? view.superview
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard let host = installedView else { return }
        switch recognizer.state {
        case .began:
            didBeginPan = true
            recognizer.setTranslation(.zero, in: host)
            onBegin()
        case .changed:
            guard didBeginPan else { return }
            let deltaX = recognizer.translation(in: host).x
            recognizer.setTranslation(.zero, in: host)
            onDelta(deltaX)
        case .ended, .cancelled:
            guard didBeginPan else { return }
            didBeginPan = false
            let deltaX = recognizer.translation(in: host).x
            let velocityX = recognizer.velocity(in: host).x
            onEnd(deltaX, velocityX)
        default:
            break
        }
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === panGesture, let host = installedView else { return true }
        touchStartX = touch.location(in: host).x
        touchView = touch.view
        let drawerActive = isOpen || currentProgress > 0.01
        if isInsideInteractiveControl(touch.view, drawerActive: drawerActive) {
            return false
        }
        return true
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === panGesture, let host = installedView else { return false }
        let vel = panGesture.velocity(in: host)
        let trans = panGesture.translation(in: host)
        let dx = abs(vel.x) > 1 ? vel.x : trans.x
        let dy = abs(vel.y) > 1 ? vel.y : trans.y
        let drawerActive = isOpen || currentProgress > 0.01

        if drawerActive {
            guard abs(dx) > abs(dy) * 1.1 else { return false }
            if isOpen && currentProgress >= 0.99 {
                return dx > 0
            }
            return true
        } else {
            guard dx < 0 else { return false }
            let isFromRightEdge = touchStartX >= host.bounds.width - 44
            let horizontalRatio: CGFloat = isFromRightEdge ? 1.15 : 1.5
            guard abs(dx) > abs(dy) * horizontalRatio else { return false }
            if !isFromRightEdge && hasHorizontalScrollRoomToRight(from: touchView) {
                return false
            }
            if !isFromRightEdge && isScrollViewDecelerating(from: touchView) {
                return false
            }
            return true
        }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        guard gestureRecognizer === panGesture else { return false }
        let drawerActive = isOpen || currentProgress > 0.01

        if let scrollView = otherGestureRecognizer.view as? UIScrollView,
           otherGestureRecognizer === scrollView.panGestureRecognizer {
            if drawerActive {
                return !scrollView.isDecelerating
            }
            let hostWidth = installedView?.bounds.width ?? 0
            if touchStartX >= hostWidth - 44 {
                return true
            }
            let isHorizontallyScrollable = scrollView.contentSize.width > scrollView.bounds.width + 2
            return !isHorizontallyScrollable && !scrollView.isDecelerating
        }

        if drawerActive, let nav = navigationController {
            if otherGestureRecognizer === nav.interactivePopGestureRecognizer {
                return true
            }
            if #available(iOS 26.0, *),
               otherGestureRecognizer === nav.interactiveContentPopGestureRecognizer {
                return true
            }
        }

        return false
    }

    private func isInsideInteractiveControl(_ view: UIView?, drawerActive: Bool) -> Bool {
        var cur = view
        while let v = cur {
            if v is UISwitch || v is UISlider {
                return true
            }
            if !drawerActive, (v is UITextField || v is UITextView) {
                return true
            }
            cur = v.superview
        }
        return false
    }

    private func hasHorizontalScrollRoomToRight(from view: UIView?) -> Bool {
        var cur = view
        while let v = cur {
            if let sv = v as? UIScrollView, sv.isScrollEnabled {
                let maxOffsetX = sv.contentSize.width - sv.bounds.width + sv.adjustedContentInset.right
                if maxOffsetX > 2 && sv.contentOffset.x < maxOffsetX - 2 {
                    return true
                }
            }
            cur = v.superview
        }
        return false
    }

    private func isScrollViewDecelerating(from view: UIView?) -> Bool {
        var cur = view
        while let v = cur {
            if let sv = v as? UIScrollView, sv.isDecelerating {
                return true
            }
            cur = v.superview
        }
        return false
    }
}
