import SafariServices
import SwiftUI

enum NodeAction {
    case changes, workspace, attachment, terminal

    func unavailable(on device: DeviceInfo?) -> String? {
        guard let device, !device.revoked else { return "设备未配对" }
        guard device.online else { return "设备离线" }
        guard let node = device.node, node.supportsChat else { return "请升级电脑端 Lever" }
        let feature = switch self {
        case .changes: "git_v1"
        case .workspace, .attachment: "fs_v1"
        case .terminal: "terminal_v1"
        }
        guard node.features.contains(feature) else { return "请升级电脑端 Lever 以使用此功能" }
        switch self {
        case .terminal:
            guard node.accessLevel == "admin" else { return "需要电脑端授予管理员权限" }
            guard node.readOnlyFs != true else { return "设备当前为只读" }
            guard !device.draining && node.draining != true else { return "设备正在停止接受新任务" }
        case .workspace, .attachment:
            guard ["workspace","admin"].contains(node.accessLevel) else { return "需要电脑端授予工作区权限" }
        case .changes:
            guard ["chat","workspace","admin"].contains(node.accessLevel) else { return "需要电脑端授予对话权限" }
        }
        return nil
    }
}

struct WorkspaceLocation: Identifiable {
    let url: URL
    var id: URL { url }

    static func open(device: String, agent: String, chat: String?) async throws -> Self {
        let location: String = try await LeverBridge.shared.request("POST", path: "/native/workspace",
            body: ["node": device, "agent": agent, "chat": chat ?? ""])
        guard let url = URL(string: location), url.host == "127.0.0.1", url.port != nil else { throw LeverCoreError.invalidResponse }
        return Self(url: url)
    }
}

struct PeerWorkspaceBrowser: UIViewControllerRepresentable {
    let location: WorkspaceLocation
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: location.url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
    func makeCoordinator() -> String { "127.0.0.1:\(location.url.port!)" }
    static func dismantleUIViewController(_ controller: SFSafariViewController, coordinator host: String) {
        Task { try? await LeverBridge.shared.requestVoid("POST", path: "/native/workspace/close", body: ["host":host]) }
    }
}

struct WorkspaceActions: View {
    let device: DeviceInfo?
    let agent: String
    let chat, session: String?
    @State private var workspace: WorkspaceLocation?
    @State private var terminal = false
    @State private var error: String?

    var body: some View {
        HStack(spacing: 3) {
            Button {
                guard let device, check(.workspace) else { return }
                Task {
                    do { workspace = try await .open(device: device.id, agent: agent, chat: chat) }
                    catch { self.error = error.localizedDescription }
                }
            } label: { Image(systemName: "folder").frame(width: 36, height: 40) }
            .accessibilityLabel("打开工作区")

            Button {
                if check(.terminal) { terminal = true }
            } label: { Image(systemName: "terminal").frame(width: 36, height: 40) }
            .accessibilityLabel("远程终端")
        }
        .foregroundStyle(LeverTheme.inkPrimary)
        .sheet(item: $workspace) { PeerWorkspaceBrowser(location: $0).ignoresSafeArea() }
        .fullScreenCover(isPresented: $terminal) {
            if let device { TerminalSheetView(device: device.id, agent: agent, session: session) }
        }
        .alert("设备操作", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好") {}
        } message: { Text(error ?? "") }
    }

    private func check(_ action: NodeAction) -> Bool {
        error = action.unavailable(on: device)
        return error == nil
    }
}
