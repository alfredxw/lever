import Foundation
import Nuke

/// The cache key includes the credential space and owner. Only paths built
/// from typed media references reach the authenticated Go transport.
struct LeverMedia: Hashable, Sendable {
    enum Kind { case attachment, avatar }
    let path: String
    init?(space: String?, device: String, kind: Kind, id: String) {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard let space, [space, device, id].allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(allowed.contains) }) else { return nil }
        let resource = kind == .attachment ? "nodes/\(device)/attachments/\(id)" : "avatars/\(device)/\(id)"
        path = "/api/spaces/\(space)/\(resource)"
    }

    var originalRequest: ImageRequest { ImageRequest(id: path, data: { try await LeverBridge.shared.fetchBinary(path) }) }

    func request(maxPixels: CGFloat) -> ImageRequest {
        var request = originalRequest
        request.thumbnail = .init(maxPixelSize: maxPixels)
        return request
    }
}

final class LeverImagePipeline {
    let pipeline: ImagePipeline
    private let disk: DataCache?

    init() {
        let cache = try? DataCache(name: "LeverMediaCache")
        cache?.sizeLimit = 200 * 1024 * 1024
        disk = cache
        pipeline = ImagePipeline {
            $0.imageCache = ImageCache(costLimit: 60 * 1024 * 1024)
            $0.dataCache = cache
            $0.dataCachePolicy = .storeOriginalData
        }
    }

    func clear() async {
        pipeline.invalidate()
        pipeline.cache.removeAll()
        await disk?.flush()
    }
}
