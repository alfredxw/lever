import AVFoundation
import SwiftUI
import UIKit

struct PairingView: View {
    @Bindable var store: LeverStore
    @State private var linkText = ""
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            ZStack {
                LeverTheme.canvas.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 26) {
                        Spacer(minLength: 28)

                        VStack(spacing: 12) {
                            LeverBrandMark(size: 68)
                            Text("Lever")
                                .font(.system(size: 28, weight: .bold))
                                .foregroundStyle(LeverTheme.inkPrimary)
                            Text("连接你的工作电脑，随时与 Agent 同步话题与审批操作")
                                .font(.system(size: 14))
                                .foregroundStyle(LeverTheme.inkSecondary)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 12)
                        }

                        VStack(spacing: 16) {
                            Button {
                                Haptics.light()
                                showScanner = true
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "qrcode.viewfinder")
                                        .font(.system(size: 18, weight: .semibold))
                                    Text("扫码配对电脑或 Hub")
                                        .font(.system(size: 16, weight: .semibold))
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: 50)
                                .background(LeverTheme.inkPrimary)
                                .foregroundStyle(LeverTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(.plain)

                            HStack(spacing: 12) {
                                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
                                Text("或粘贴配对链接")
                                    .font(.system(size: 12))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    TextField("leverdevice://pair?...", text: $linkText)
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                        .font(.system(size: 14, design: .monospaced))
                                        .foregroundStyle(LeverTheme.inkPrimary)

                                    if linkText.isEmpty {
                                        Button("粘贴") {
                                            if let pasted = UIPasteboard.general.string {
                                                linkText = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                                                Haptics.light()
                                            }
                                        }
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(LeverTheme.inkSecondary)
                                    } else {
                                        Button {
                                            linkText = ""
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .foregroundStyle(LeverTheme.inkTertiary)
                                        }
                                    }
                                }
                                .padding(.horizontal, 14)
                                .frame(height: 46)
                                .background(LeverTheme.surfaceInset)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                                Button {
                                    Task { await store.pair(link: linkText) }
                                } label: {
                                    HStack(spacing: 8) {
                                        if store.isPairing {
                                            ProgressView()
                                                .tint(LeverTheme.inkPrimary)
                                        }
                                        Text(store.isPairing ? "正在建立加密连接…" : "连接并配对")
                                            .font(.system(size: 15, weight: .semibold))
                                    }
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 46)
                                    .background(LeverTheme.surfacePill)
                                    .foregroundStyle(LeverTheme.inkPrimary)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                                .buttonStyle(.plain)
                                .disabled(store.isPairing || linkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                .opacity(linkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.55 : 1)
                            }

                            if let err = store.errorMessage, !err.isEmpty {
                                Text(err)
                                    .font(.system(size: 13))
                                    .foregroundStyle(LeverTheme.unreadRed)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(12)
                                    .background(LeverTheme.unreadRed.opacity(0.10))
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                        .padding(18)
                        .background(LeverTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .strokeBorder(LeverTheme.hairline, lineWidth: 0.5)
                        )

                        VStack(alignment: .leading, spacing: 8) {
                            Label("免 Hub 局域网直连 · TLS 1.3 证书钉扎", systemImage: "wifi")
                            Label("桌面端「设置 → 远程与设备 → 配对新设备」获取二维码", systemImage: "laptopcomputer")
                        }
                        .font(.system(size: 12.5))
                        .foregroundStyle(LeverTheme.inkTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 32)
                }
            }
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { scanned in
                    showScanner = false
                    linkText = scanned
                    Task { await store.pair(link: scanned) }
                }
            }
            .onChange(of: store.pendingPairLink) { _, newValue in
                if let newValue, !newValue.isEmpty {
                    linkText = newValue
                }
            }
        }
    }
}

private struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onScanned: (String) -> Void
    @State private var cameraUnavailable = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if cameraUnavailable {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 36))
                            .foregroundStyle(.white.opacity(0.7))
                        Text("当前设备无法启用相机")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                        Text("请返回上一页直接粘贴电脑端生成的配对链接")
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.65))
                    }
                    .padding(24)
                } else {
                    QRScannerRepresentable(
                        onScanned: onScanned,
                        onUnavailable: { cameraUnavailable = true }
                    )
                    .ignoresSafeArea()

                    VStack {
                        Spacer()
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(.white.opacity(0.88), lineWidth: 2)
                            .frame(width: 248, height: 248)
                            .background(Color.clear)
                        Spacer()
                        Text("对准电脑端 Lever 显示的配对二维码")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 9)
                            .background(.black.opacity(0.55))
                            .clipShape(Capsule())
                            .padding(.bottom, 42)
                    }
                }
            }
            .navigationTitle("扫码配对")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
        }
    }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onScanned: (String) -> Void
    let onUnavailable: () -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let vc = QRScannerController()
        vc.onScanned = onScanned
        vc.onUnavailable = onUnavailable
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

private final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScanned: ((String) -> Void)?
    var onUnavailable: (() -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didScan = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            DispatchQueue.main.async { self.onUnavailable?() }
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            DispatchQueue.main.async { self.onUnavailable?() }
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.stopRunning()
            }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didScan,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let raw = obj.stringValue,
              LeverBridge.shared.isValidPairLink(raw) else { return }
        didScan = true
        Haptics.success()
        session.stopRunning()
        onScanned?(raw)
    }
}
