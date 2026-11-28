import Nuke
import SwiftUI
import Textual

struct MarkdownMediaLoader: AttachmentLoader {
    var space: String?
    var device: String?
    var pipeline: ImagePipeline?

    static func attachmentID(_ url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.query == nil, parts.fragment == nil, parts.user == nil, parts.password == nil, parts.port == nil else { return nil }
        if parts.scheme == "lever-attachment", parts.path.isEmpty { return parts.host }
        guard parts.scheme == nil && parts.host == nil else { return nil }
        for prefix in ["/api/attachments/", "/peer/v1/attachments/"] where parts.percentEncodedPath.hasPrefix(prefix) {
            let id = String(parts.percentEncodedPath.dropFirst(prefix.count))
            if !id.isEmpty && !id.contains("/") && !id.contains("%") { return id }
        }
        return nil
    }

    func attachment(for url: URL, text: String, environment: ColorEnvironmentValues) async throws -> MediaAttachment {
        guard let pipeline, let device, let id = Self.attachmentID(url), let media = LeverMedia(space: space, device: device, kind: .attachment, id: id) else {
            let external = ["https","http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil && url.user == nil && url.password == nil
            let label = [text, external ? url.host : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return MediaAttachment(image: nil, description: label.isEmpty ? "图片未加载" : label, external: external ? url : nil)
        }
        let image = try await pipeline.image(for: media.request(maxPixels: 960))
        return MediaAttachment(image: image, description: text)
    }

    struct MediaAttachment: Textual.Attachment {
        let image: UIImage?
        let description: String
        var external: URL? = nil
        @MainActor @ViewBuilder var body: some View {
            if let image { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(description) }
            else if let external {
                Link(destination: external) { Label(description, systemImage: "arrow.up.right.square").lineLimit(1) }
                    .font(.caption).foregroundStyle(.secondary)
            } else { Label(description, systemImage: "photo").lineLimit(1).font(.caption).foregroundStyle(.secondary) }
        }
        func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
            guard let image else { return CGSize(width: min(proposal.width ?? 240, CGFloat(min(32, description.count) * 9 + 22)), height: 22) }
            let size = image.size
            let scale = min(1, (proposal.width ?? 300) / max(size.width, 1), 320 / max(size.height, 1))
            return CGSize(width: size.width * scale, height: size.height * scale)
        }
    }
}

extension EnvironmentValues {
    @Entry var leverMarkdownMedia = MarkdownMediaLoader()
}
