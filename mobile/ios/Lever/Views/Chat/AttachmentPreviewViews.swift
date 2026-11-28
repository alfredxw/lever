import Nuke
import NukeUI
import Photos
import QuickLook
import SwiftUI

struct AttachmentPreviewViews: View {
    let attachments: [AttachmentRef]
    let device: DeviceInfo?
    let store: LeverStore?
    @State private var preview: AttachmentRef?
    @State private var message: String?
    @State private var retry = 0

    var body: some View {
        let canRead = device?.revoked == false && device?.node?.supportsChat == true && ["workspace","admin"].contains(device?.node?.accessLevel ?? "")
        let images = canRead ? attachments.filter(\.isImage) : []
        if !images.isEmpty, let store {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: min(images.count, images.count > 4 ? 3 : 2)), spacing: 4) {
                ForEach(images) { file in
                    if let reference = media(file) {
                        LazyImage(request: reference.request(maxPixels: images.count == 1 ? 840 : 420)) { state in
                            if let image = state.image {
                                Button { preview = file } label: { image.resizable().aspectRatio(contentMode: .fill) }
                            } else if state.error != nil {
                                Button { retry += 1 } label: { Label("重试", systemImage: "arrow.clockwise") }
                            } else { ProgressView() }
                        }
                        .pipeline(store.media.pipeline)
                        .id("\(file.id):\(retry)")
                        .frame(maxWidth: .infinity).frame(height: images.count == 1 ? 160 : 94)
                        .background(LeverTheme.surfaceInset).clipShape(RoundedRectangle(cornerRadius: 10))
                        .accessibilityLabel(file.name)
                    }
                }
            }
            .frame(maxWidth: 276)
        }
        ForEach(attachments.filter { !canRead || !$0.isImage }) { file in
            Button {
                if let reason = NodeAction.attachment.unavailable(on: device) { message = reason }
                else { preview = file }
            } label: {
                Label("\(file.name)  \(formatByteSize(file.size))", systemImage: file.isImage ? "photo" : "doc")
                    .font(.caption).lineLimit(2).padding(8).background(LeverTheme.surfaceInset, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        Color.clear.frame(width: 0, height: 0)
            .fullScreenCover(item: $preview) { file in
                if let reference = media(file), let store { AttachmentViewer(file: file, media: reference, pipeline: store.media.pipeline) }
            }
            .alert("附件预览", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("好") {}
            } message: { Text(message ?? "") }
    }

    private func media(_ file: AttachmentRef) -> LeverMedia? {
        device.flatMap { LeverMedia(space: store?.activeSpace?.id, device: $0.id, kind: .attachment, id: file.id) }
    }
}

private struct AttachmentViewer: View {
    let file: AttachmentRef
    let media: LeverMedia
    let pipeline: ImagePipeline
    @Environment(\.dismiss) private var dismiss
    @State private var local: URL?
    @State private var image: UIImage?
    @State private var message: String?
    @State private var loadingError: String?
    @State private var attempt = 0
    @State private var zoomed = false

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ZoomImage(image: image, zoomed: $zoomed)
                        .simultaneousGesture(DragGesture().onEnded { value in
                            if !zoomed && value.translation.height > 100 && abs(value.translation.width) < value.translation.height { dismiss() }
                        })
                } else if let local { FileQuickLook(url: local) }
                else if let loadingError { VStack { Text(loadingError); Button("重试") { attempt += 1 } } }
                else { ProgressView("正在打开附件") }
            }
            .navigationTitle(file.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                if let local {
                    ToolbarItemGroup(placement: .primaryAction) {
                        if file.isImage {
                            Button {
                                Task {
                                    do {
                                        try await PHPhotoLibrary.shared().performChanges {
                                            PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: local, options: nil)
                                        }
                                        message = "已保存到相册"
                                    } catch { message = error.localizedDescription }
                                }
                            } label: { Label("保存到相册", systemImage: "square.and.arrow.down") }
                        }
                        ShareLink(item: local)
                    }
                }
            }
        }
        .task(id: attempt) {
            loadingError = nil
            do {
                let data: Data
                if file.isImage {
                    let request = media.request(maxPixels: 4096)
                    async let decoded = pipeline.image(for: request)
                    let (bytes, _) = try await pipeline.data(for: media.originalRequest)
                    data = bytes
                    let fullImage = try await decoded
                    try Task.checkCancellation()
                    image = fullImage
                } else { data = try await LeverBridge.shared.fetchBinary(media.path) }
                let url = try await Task.detached { try Self.temporaryFile(data, named: file.name) }.value
                guard !Task.isCancelled else { Self.remove(url); return }
                local = url
            } catch { if !Task.isCancelled { loadingError = error.localizedDescription } }
        }
        .onDisappear { if let local { Self.remove(local) } }
        .alert("附件", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("好") {}
        } message: { Text(message ?? "") }
    }

    private nonisolated static func temporaryFile(_ data: Data, named: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let name = (named as NSString).lastPathComponent
        let url = directory.appendingPathComponent(["", ".", "..", "/"].contains(name) ? "附件" : name)
        do { try data.write(to: url, options: [.atomic, .completeFileProtection]); return url }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
    }

    private static func remove(_ url: URL) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

private struct FileQuickLook: UIViewControllerRepresentable {
    let url: URL
    final class Source: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(_ url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
    func makeCoordinator() -> Source { Source(url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let view = QLPreviewController(); view.dataSource = context.coordinator; return view
    }
    func updateUIViewController(_ view: QLPreviewController, context: Context) {}
}

private struct ZoomImage: UIViewRepresentable {
    let image: UIImage
    @Binding var zoomed: Bool
    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        var zoomed: Binding<Bool>
        init(_ zoomed: Binding<Bool>) { self.zoomed = zoomed }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { zoomed.wrappedValue = scrollView.zoomScale > 1.01 }
        @objc func doubleTap(_ tap: UITapGestureRecognizer) {
            guard let view = tap.view as? UIScrollView else { return }
            if view.zoomScale > 1 { view.setZoomScale(1, animated: true); return }
            let point = tap.location(in: imageView), size = view.bounds.size
            view.zoom(to: CGRect(x: point.x-size.width/4, y: point.y-size.height/4, width: size.width/2, height: size.height/2), animated: true)
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator($zoomed) }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView(), view = context.coordinator.imageView
        scroll.maximumZoomScale = 5
        scroll.delegate = context.coordinator
        view.image = image; view.contentMode = .scaleAspectFit
        scroll.addSubview(view)
        view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([view.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
                                     view.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
                                     view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
                                     view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
                                     view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
                                     view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor)])
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2; scroll.addGestureRecognizer(tap)
        return scroll
    }
    func updateUIView(_ view: UIScrollView, context: Context) {}
}
