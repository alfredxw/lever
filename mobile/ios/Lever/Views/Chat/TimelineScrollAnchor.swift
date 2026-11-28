import SwiftUI

/// Changing content height never changes follow intent. Only a gesture or an
/// explicit send/return-to-bottom action can take or release the bottom anchor.
struct TimelineScrollAnchor: ViewModifier {
    let firstID: String?
    let followRequest: Int
    @State private var position = ScrollPosition(idType: String.self)
    @State private var following = true
    @State private var scrolling = false
    @State private var farFromBottom = false
    @State private var unseen = false
    @State private var followTask: Task<Void, Never>?

    private struct Metrics: Equatable {
        let height, viewport: CGFloat
        let near, far: Bool
        init(_ geometry: ScrollGeometry) {
            height = geometry.contentSize.height
            viewport = geometry.containerSize.height
            let distance = height + geometry.contentInsets.bottom - geometry.contentOffset.y - viewport
            near = distance <= 48
            far = distance > 240
        }
    }

    func body(content: Content) -> some View {
        content
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($position)
            .onScrollPhaseChange { _, phase, context in
                scrolling = phase == .interacting || phase == .decelerating || phase == .tracking
                if scrolling {
                    followTask?.cancel()
                    followTask = nil
                } else if following && Metrics(context.geometry).near { follow() }
            }
            .onScrollGeometryChange(for: Metrics.self, of: Metrics.init) { old, new in
                farFromBottom = new.far
                if scrolling {
                    following = new.near
                    if following { unseen = false }
                } else if following && (old.height != new.height || old.viewport != new.viewport) {
                    follow()
                } else if !following && new.height > old.height { unseen = true }
            }
            .onChange(of: firstID) { old, new in
                if old == nil && new != nil && following { follow() }
            }
            .onChange(of: followRequest) { _, _ in goToBottom() }
            .overlay(alignment: .bottomTrailing) {
                if !following && farFromBottom {
                    Button(action: goToBottom) {
                        Image(systemName: "arrow.down").padding(12)
                            .background(.regularMaterial, in: Circle())
                            .overlay(alignment: .topTrailing) {
                                if unseen { Circle().fill(LeverTheme.runningEmerald).frame(width: 7, height: 7) }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(unseen ? "回到底部，有新消息" : "回到底部")
                    .padding(12)
                }
            }
            .onDisappear { followTask?.cancel(); followTask = nil }
    }

    private func goToBottom() {
        following = true
        unseen = false
        position.scrollTo(edge: .bottom)
    }

    private func follow() {
        guard followTask == nil else { return }
        followTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(70)) } catch { return }
            followTask = nil
            if following && !scrolling { position.scrollTo(edge: .bottom) }
        }
    }
}
