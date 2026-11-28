import SwiftUI

struct RunChangesSheetView: View {
    struct Review: Decodable { let changes: [Group] }
    struct Group: Decodable {
        struct Root: Decodable { let id: String }
        let root: Root
        let files: [File]?
    }
    struct File: Decodable, Hashable { let path, status: String; let additions, deletions: Int; let binary: Bool? }
    let device: DeviceInfo?
    let agent: String
    let run: ArchiveRecord
    @State private var groups: [Group]?
    @State private var error: String?
    @State private var retry = 0
    @State private var workspace: WorkspaceLocation?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error)
                    Button("重试") { retry += 1 }
                } else if let groups {
                    if groups.allSatisfy({ ($0.files ?? []).isEmpty }) { Text("本轮没有可查看的文件变更") }
                    ForEach(groups, id: \.root.id) { group in
                        Section {
                            ForEach(group.files ?? [], id: \.path) { file in
                                NavigationLink {
                                    WorkingFileDiff(device: device, agent: agent, root: group.root.id, file: file)
                                } label: {
                                    VStack(alignment: .leading) {
                                        Text(file.path).font(.body.monospaced()).lineLimit(3)
                                        Text("\(file.status)   +\(file.additions)  −\(file.deletions)").font(.caption.monospacedDigit())
                                    }
                                }
                            }
                        } header: {
                            if groups.count > 1 { Text(group.root.id) }
                        }
                    }
                } else { ProgressView("正在读取本轮变更") }
            }
            .navigationTitle("本轮文件变更")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                if NodeAction.workspace.unavailable(on: device) == nil, let device {
                    ToolbarItem(placement: .primaryAction) {
                        Button("工作区") {
                            Task {
                                do { workspace = try await .open(device: device.id, agent: agent, chat: run.chatId) }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                    }
                }
            }
            .task(id: retry) {
                error = NodeAction.changes.unavailable(on: device)
                guard error == nil, let device else { return }
                do {
                    let review: Review = try await LeverBridge.shared.request("GET", path: peerGitPath(device.id, agent, "changes", ["run":run.id]))
                    groups = review.changes
                } catch { self.error = error.localizedDescription }
            }
        }
        .sheet(item: $workspace) { PeerWorkspaceBrowser(location: $0).ignoresSafeArea() }
    }
}

private func peerGitPath(_ device: String, _ agent: String, _ resource: String, _ parameters: [String: String]) -> String {
    var path = URLComponents()
    path.path = "/api/nodes/\(device)/agents/\(agent)/\(resource)"
    path.queryItems = parameters.map { URLQueryItem(name: $0.key, value: $0.value) }
    return path.string ?? ""
}

private struct WorkingFileDiff: View {
    struct Response: Decodable { let patch: String }
    let device: DeviceInfo?
    let agent, root: String
    let file: RunChangesSheetView.File
    @State private var patch: String?
    @State private var message: String?
    @State private var retry = 0
    var body: some View {
        ScrollView {
            if let message {
                Text(message)
                if NodeAction.workspace.unavailable(on: device) == nil && file.binary != true {
                    Button("重试") { retry += 1 }
                }
            } else if let patch {
                if patch.isEmpty { Text("此文件当前没有工作区差异") }
                else {
                    // Choose a fence longer than any line in the patch can close.
                    let longest = patch.components(separatedBy: CharacterSet.newlines).map { $0.prefix(while: { $0 == "~" }).count }.max() ?? 0
                    let fence = String(repeating: "~", count: max(3, longest + 1))
                    MarkdownContentView(text: "\(fence)diff\n\(patch)\n\(fence)", foreground: .primary)
                }
            } else { ProgressView() }
        }
        .padding().navigationTitle("当前工作区差异").navigationBarTitleDisplayMode(.inline)
        .task(id: retry) {
            message = NodeAction.workspace.unavailable(on: device)
            guard message == nil, let device else { return }
            if file.binary == true { message = "二进制文件没有文本差异"; return }
            do {
                let result: Response = try await LeverBridge.shared.request("GET", path: peerGitPath(device.id, agent, "diff", ["root":root,"mode":"working","path":file.path]))
                patch = result.patch
            } catch { message = error.localizedDescription }
        }
    }
}
