import SwiftTerm
import SwiftUI

struct TerminalSheetView: View {
    let device, agent: String
    let session: String?
    @State private var client = RemoteTerminalClient()
    @State private var attempt = 0
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scene

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Text(scene == .background ? "已断开" : client.status).font(.caption)
                    Spacer()
                    if client.finished { Button("重新连接") { attempt += 1 } }
                }.padding(.horizontal).padding(.vertical, 5)
                SwiftTermView(client: client)
            }
            .navigationTitle("远程终端").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .task(id: Connection(attempt: attempt, background: scene == .background)) {
                if scene != .background { await client.connect(device: device, agent: agent, session: session) }
            }
        }
    }
    private struct Connection: Hashable { let attempt: Int; let background: Bool }
}

private struct SwiftTermView: UIViewRepresentable {
    let client: RemoteTerminalClient
    @Environment(\.colorScheme) private var colors
    func makeCoordinator() -> Coordinator { Coordinator(client) }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        let saved = UserDefaults.standard.double(forKey: "lever.terminal.font")
        view.font = .monospacedSystemFont(ofSize: saved > 0 ? min(18, max(10, saved)) : 13, weight: .regular)
        view.terminalDelegate = context.coordinator
        client.view = view
        context.coordinator.configure(view)
        return view
    }

    func updateUIView(_ view: TerminalView, context: Context) {
        guard context.coordinator.colorScheme != colors else { return }
        context.coordinator.colorScheme = colors
        let traits = UITraitCollection(userInterfaceStyle: colors == .dark ? .dark : .light)
        view.nativeForegroundColor = UIColor.label.resolvedColor(with: traits)
        view.nativeBackgroundColor = UIColor.systemBackground.resolvedColor(with: traits)
        let palette: [UInt32] = colors == .dark
            ? [0x202024,0xcc7979,0x83b693,0xc1a673,0x8ca8c8,0xb59ac6,0x81b7bc,0xc4c4c8,
               0x787880,0xe69b9b,0xa0cba9,0xd9c292,0xa9c2df,0xcdb5df,0xa0cfd2,0xf0f0f2]
            : [0x202024,0x974646,0x396945,0x795b26,0x425e85,0x725480,0x386b70,0xc9c9ce,
               0x66666e,0xa65050,0x47794e,0x866429,0x4c7095,0x84638d,0x467e82,0xf5f5f6]
        view.installColors(palette.map {
            SwiftTerm.Color(red8: UInt16(($0 >> 16) & 255), green8: UInt16(($0 >> 8) & 255), blue8: UInt16($0 & 255))
        })
    }

    @MainActor final class Coordinator: NSObject, TerminalViewDelegate {
        let client: RemoteTerminalClient
        var colorScheme: ColorScheme?
        weak var controlButton: UIButton?
        @objc private func resetControl() { controlButton?.isSelected = false }
        init(_ client: RemoteTerminalClient) { self.client = client }
        func configure(_ view: TerminalView) {
            let bar = UIStackView()
            bar.frame.size.height = 42
            bar.backgroundColor = .secondarySystemBackground
            bar.distribution = .fillEqually
            let keys = [("Esc","\u{1b}"),("Tab","\t"),("Ctrl",""),("←","\u{1b}[D"),("↓","\u{1b}[B"),("↑","\u{1b}[A"),("→","\u{1b}[C"),("粘贴",""),("收起","")]
            for (title, value) in keys {
                let button = UIButton(type: .system)
                button.setTitle(title, for: .normal)
                button.tintColor = .label
                button.addAction(UIAction { [weak self, weak view, weak button] _ in
                    guard let self, let view else { return }
                    switch title {
                    case "Ctrl": view.controlModifier.toggle(); button?.isSelected = view.controlModifier
                    case "粘贴": view.paste(nil)
                    case "收起": _ = view.resignFirstResponder()
                    default: self.client.input(Data(value.utf8))
                    }
                }, for: .touchUpInside)
                if title == "Ctrl" {
                    controlButton = button
                    NotificationCenter.default.addObserver(self, selector: #selector(resetControl), name: .terminalViewControlModifierReset, object: view)
                }
                bar.addArrangedSubview(button)
            }
            view.inputAccessoryView = bar
            view.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:))))
        }

        @objc private func pinch(_ gesture: UIPinchGestureRecognizer) {
            guard let view = gesture.view as? TerminalView else { return }
            let size = min(18, max(10, view.font.pointSize * gesture.scale))
            gesture.scale = 1
            view.font = .monospacedSystemFont(ofSize: size, weight: .regular)
            if gesture.state == .ended { UserDefaults.standard.set(size, forKey: "lever.terminal.font") }
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { client.resize(cols: newCols, rows: newRows) }
        func send(source: TerminalView, data: ArraySlice<UInt8>) { client.input(Data(data)) }
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, request: TerminalLinkRequest) {}
        func bell(source: TerminalView) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func clipboardRead(source: TerminalView) -> Data? { nil }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
