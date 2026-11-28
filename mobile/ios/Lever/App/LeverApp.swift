import Network
import SwiftUI
import UIKit
import UserNotifications

final class LeverAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var store: LeverStore?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor [weak self] in
            self?.store?.handleAPNsDeviceToken(hex)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.store?.errorMessage = "系统推送注册失败：\(error.localizedDescription)"
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        Task { @MainActor [weak self] in
            await self?.store?.refreshAll(silent: true)
        }
        return [.banner, .sound, .badge]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        if let payload = userInfo["lever"] as? String {
            await MainActor.run { [weak self] in
                self?.store?.handlePushOpened(leverPayload: payload)
            }
        }
    }
}

@main
struct LeverApp: App {
    @UIApplicationDelegateAdaptor(LeverAppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = LeverStore()
    @State private var pathMonitor: NWPathMonitor?

    var body: some Scene {
        WindowGroup {
            RootContainerView(store: store)
                .preferredColorScheme(preferredColorScheme)
                .task {
                    delegate.store = store
                    startNetworkMonitor()
                    await store.bootstrap()
                }
                .onOpenURL { url in
                    store.handleIncomingURL(url)
                }
                .onChange(of: scenePhase) { _, phase in
                    store.handleSceneActive(phase == .active)
                }
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch store.themePreference {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    private func startNetworkMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { _ in
            Task { @MainActor in
                store.handleNetworkChanged()
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.lever.mobile.network"))
        pathMonitor = monitor
    }
}

private enum RootTab: Hashable {
    case chats
    case settings
}

private struct RootContainerView: View {
    @Bindable var store: LeverStore
    @State private var selectedTab: RootTab = .chats

    var body: some View {
        Group {
            if store.isBootstrapping {
                ZStack {
                    LeverTheme.canvas.ignoresSafeArea()
                    VStack(spacing: 14) {
                        LeverBrandMark(size: 58)
                        ProgressView()
                            .tint(LeverTheme.inkSecondary)
                    }
                }
            } else if !store.isPaired {
                PairingView(store: store)
            } else {
                nativeTabView
            }
        }
        .sheet(isPresented: Binding(get: { store.isPaired && store.pendingPairLink != nil }, set: { if !$0 { store.pendingPairLink = nil } })) {
            PairingView(store: store)
        }
        .onChange(of: store.pendingNavigationRoute, initial: true) { _, route in
            if route != nil {
                selectedTab = .chats
            }
        }
    }

    @ViewBuilder
    private var nativeTabView: some View {
        let baseTabView = TabView(selection: $selectedTab) {
            Tab("聊天", systemImage: "bubble.left.and.bubble.right", value: RootTab.chats) {
                FeedView(store: store)
            }
            .badge(store.cachedTotalUnread)

            Tab("设置", systemImage: "gearshape", value: RootTab.settings) {
                SettingsView(store: store)
            }
        }
        .tint(LeverTheme.inkPrimary)

        if #available(iOS 26.0, *) {
            baseTabView.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            baseTabView
        }
    }
}

struct LeverBrandMark: View {
    var size: CGFloat = 56

    var body: some View {
        Image("LeverPresetLogo")
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                    .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
            )
    }
}
