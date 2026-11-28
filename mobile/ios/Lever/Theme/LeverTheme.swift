import SwiftUI
import UIKit

/// Scheme A + Lever Desktop Monochrome Grayscale Foundation (Light & Dark).
/// Color lives strictly in authentic Desktop Agent avatars and restrained semantic status cues.
enum LeverTheme {
    static let canvas = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.047, green: 0.047, blue: 0.055, alpha: 1) // #0C0C0E
            : UIColor(red: 0.961, green: 0.961, blue: 0.969, alpha: 1) // #F5F5F7
    })

    static let surface = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.078, green: 0.078, blue: 0.090, alpha: 1) // #141417
            : UIColor.white
    })

    static let surfaceElevated = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.102, green: 0.102, blue: 0.118, alpha: 1) // #1A1A1E
            : UIColor(red: 0.969, green: 0.969, blue: 0.973, alpha: 1) // #F7F7F8
    })

    static let surfaceInset = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.133, green: 0.133, blue: 0.153, alpha: 1) // #222227
            : UIColor(red: 0.941, green: 0.941, blue: 0.949, alpha: 1) // #F0F0F2
    })

    static let surfacePill = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.165, green: 0.165, blue: 0.188, alpha: 1) // #2A2A30
            : UIColor(red: 0.918, green: 0.925, blue: 0.937, alpha: 1) // #EAECEF
    })

    static let inkPrimary = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.957, green: 0.957, blue: 0.965, alpha: 1) // #F4F4F6
            : UIColor(red: 0.067, green: 0.067, blue: 0.078, alpha: 1) // #111114
    })

    static let inkSecondary = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.631, green: 0.631, blue: 0.667, alpha: 1) // #A1A1AA
            : UIColor(red: 0.322, green: 0.322, blue: 0.357, alpha: 1) // #52525B
    })

    static let inkTertiary = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.443, green: 0.443, blue: 0.478, alpha: 1) // #71717A
            : UIColor(red: 0.541, green: 0.541, blue: 0.576, alpha: 1) // #8A8A93
    })

    static let hairline = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor.white.withAlphaComponent(0.085)
            : UIColor.black.withAlphaComponent(0.075)
    })

    static let hairlineStrong = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor.white.withAlphaComponent(0.145)
            : UIColor.black.withAlphaComponent(0.135)
    })

    // Gray user bubble + crisp white text in both Light & Dark modes
    static let userBubbleBg = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.176, green: 0.176, blue: 0.200, alpha: 1) // #2D2D33 refined dark gray
            : UIColor(red: 0.220, green: 0.224, blue: 0.247, alpha: 1) // #38393F refined slate gray
    })

    static let userBubbleInk = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.961, green: 0.961, blue: 0.969, alpha: 1) // #F5F5F7 crisp white
            : UIColor.white
    })

    // Crisp iOS calibrated switch ON track so white thumb always stays clearly readable
    static let switchTint = Color(UIColor.systemGreen)

    // Restrained semantic cues
    static let unreadRed = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 1.000, green: 0.271, blue: 0.227, alpha: 1) // #FF453A
            : UIColor(red: 0.957, green: 0.247, blue: 0.247, alpha: 1) // #F43F3F
    })

    static let runningEmerald = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.204, green: 0.827, blue: 0.600, alpha: 1) // #34D399
            : UIColor(red: 0.063, green: 0.725, blue: 0.506, alpha: 1) // #10B981
    })

    static let runningEmeraldSoft = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.204, green: 0.827, blue: 0.600, alpha: 0.14)
            : UIColor(red: 0.063, green: 0.725, blue: 0.506, alpha: 0.10)
    })

    static let approvalAmber = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 1) // #FBBF24
            : UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 1) // #D97706
    })

    static let approvalAmberDot = approvalAmber

    static let approvalAmberSoft = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 0.14)
            : UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 0.10)
    })

    static let syncBlue = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.376, green: 0.647, blue: 0.980, alpha: 1)
            : UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1)
    })

    static let syncBlueSoft = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.376, green: 0.647, blue: 0.980, alpha: 0.14)
            : UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 0.09)
    })

    static func hex(_ value: UInt32) -> Color {
        Color(
            red: Double((value >> 16) & 0xFF) / 255.0,
            green: Double((value >> 8) & 0xFF) / 255.0,
            blue: Double(value & 0xFF) / 255.0
        )
    }
}

// MARK: - 1:1 Desktop Agent Avatar Palette (web/src/features/agents/avatarPalette.ts)

private struct MeshSwatch {
    let base: [Color]
    let start: UnitPoint
    let end: UnitPoint
    let glowA: (Color, UnitPoint)
    let glowB: (Color, UnitPoint)
}

private enum DesktopAvatarPalette {
    static let darkInk = LeverTheme.hex(0x19191C)

    static let meshes: [String: MeshSwatch] = [
        "gradient-prism": MeshSwatch(
            base: [LeverTheme.hex(0xEB824E), LeverTheme.hex(0xF0A170), LeverTheme.hex(0xAA8DE7)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0x9B7BED), UnitPoint(x: 0.30, y: 0.20)),
            glowB: (LeverTheme.hex(0x6FD9AE), UnitPoint(x: 0.95, y: 0.55))
        ),
        "gradient-coral": MeshSwatch(
            base: [LeverTheme.hex(0x62DCB1), LeverTheme.hex(0x84D6AA), LeverTheme.hex(0xE393BD)],
            start: .leading, end: .trailing,
            glowA: (LeverTheme.hex(0xEC70BD), UnitPoint(x: 0.92, y: 0.30)),
            glowB: (LeverTheme.hex(0xF18E77), UnitPoint(x: 0.68, y: 0.85))
        ),
        "gradient-citrus": MeshSwatch(
            base: [LeverTheme.hex(0xF7DF78), LeverTheme.hex(0xFFD985)],
            start: .topLeading, end: .bottomTrailing,
            glowA: (LeverTheme.hex(0xBCE978), UnitPoint(x: 0.82, y: 0.10)),
            glowB: (LeverTheme.hex(0xF5A56A), UnitPoint(x: 0.55, y: 0.94))
        ),
        "gradient-coast": MeshSwatch(
            base: [LeverTheme.hex(0x6A95F1), LeverTheme.hex(0x86B4EE), LeverTheme.hex(0xC4D5B2)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xF7D38A), UnitPoint(x: 0.54, y: 0.20)),
            glowB: (LeverTheme.hex(0x8AE5C3), UnitPoint(x: 0.94, y: 0.47))
        ),
        "gradient-sunset": MeshSwatch(
            base: [LeverTheme.hex(0xEF805F), LeverTheme.hex(0xF5A087), LeverTheme.hex(0xF3ADBD)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xFFD48B), UnitPoint(x: 0.22, y: 0.18)),
            glowB: (LeverTheme.hex(0xEA7EAF), UnitPoint(x: 0.94, y: 0.52))
        ),
        "gradient-jade": MeshSwatch(
            base: [LeverTheme.hex(0x4BBFA4), LeverTheme.hex(0x80D8A4), LeverTheme.hex(0xB1E8A0)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xC2ED8B), UnitPoint(x: 0.20, y: 0.13)),
            glowB: (LeverTheme.hex(0x72CBD3), UnitPoint(x: 0.96, y: 0.45))
        ),
        "gradient-glacier": MeshSwatch(
            base: [LeverTheme.hex(0x6B98F0), LeverTheme.hex(0x8EB2F3), LeverTheme.hex(0xB3D2F7)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0x92E5EF), UnitPoint(x: 0.18, y: 0.25)),
            glowB: (LeverTheme.hex(0xA9A6F4), UnitPoint(x: 0.90, y: 0.24))
        ),
        "gradient-orchid": MeshSwatch(
            base: [LeverTheme.hex(0xA07CE9), LeverTheme.hex(0xC38CE7), LeverTheme.hex(0xE5A9DA)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xF4A4CD), UnitPoint(x: 0.91, y: 0.27)),
            glowB: (LeverTheme.hex(0xB4A1F4), UnitPoint(x: 0.14, y: 0.30))
        ),
        "gradient-pearl": MeshSwatch(
            base: [LeverTheme.hex(0xA79EB7), LeverTheme.hex(0xDFD6DF), LeverTheme.hex(0xEEF0E4)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xF8E8D7), UnitPoint(x: 0.24, y: 0.16)),
            glowB: (LeverTheme.hex(0xB4CBD9), UnitPoint(x: 0.90, y: 0.62))
        ),
        "gradient-rose": MeshSwatch(
            base: [LeverTheme.hex(0xC46A79), LeverTheme.hex(0xED99A6), LeverTheme.hex(0xEFB5CE)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xFFCFCE), UnitPoint(x: 0.24, y: 0.16)),
            glowB: (LeverTheme.hex(0xC879AA), UnitPoint(x: 0.94, y: 0.48))
        ),
        "gradient-ember": MeshSwatch(
            base: [LeverTheme.hex(0xAE5464), LeverTheme.hex(0xEF9062), LeverTheme.hex(0xFFB469)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xFFD97F), UnitPoint(x: 0.76, y: 0.14)),
            glowB: (LeverTheme.hex(0xC76270), UnitPoint(x: 0.12, y: 0.68))
        ),
        "gradient-dune": MeshSwatch(
            base: [LeverTheme.hex(0xAC896E), LeverTheme.hex(0xD7B58A), LeverTheme.hex(0xEEE0BA)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xF7DEB0), UnitPoint(x: 0.22, y: 0.20)),
            glowB: (LeverTheme.hex(0xD8B492), UnitPoint(x: 0.94, y: 0.36))
        ),
        "gradient-meadow": MeshSwatch(
            base: [LeverTheme.hex(0x77A468), LeverTheme.hex(0xB5CF80), LeverTheme.hex(0xDCE5A0)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xE3EE98), UnitPoint(x: 0.25, y: 0.14)),
            glowB: (LeverTheme.hex(0x72B68A), UnitPoint(x: 0.92, y: 0.58))
        ),
        "gradient-lagoon": MeshSwatch(
            base: [LeverTheme.hex(0x41849C), LeverTheme.hex(0x68B9B5), LeverTheme.hex(0x9EDBCC)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0x91E9DD), UnitPoint(x: 0.30, y: 0.16)),
            glowB: (LeverTheme.hex(0x61B9C9), UnitPoint(x: 0.94, y: 0.48))
        ),
        "gradient-twilight": MeshSwatch(
            base: [LeverTheme.hex(0x6065AB), LeverTheme.hex(0x858EC9), LeverTheme.hex(0xADC4ED)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xB2BDF9), UnitPoint(x: 0.20, y: 0.18)),
            glowB: (LeverTheme.hex(0x879FD6), UnitPoint(x: 0.94, y: 0.56))
        ),
        "gradient-iris": MeshSwatch(
            base: [LeverTheme.hex(0x8262AD), LeverTheme.hex(0xAB86D1), LeverTheme.hex(0xD7A8D6)],
            start: .bottomLeading, end: .topTrailing,
            glowA: (LeverTheme.hex(0xD7B1EF), UnitPoint(x: 0.20, y: 0.18)),
            glowB: (LeverTheme.hex(0xB780BF), UnitPoint(x: 0.94, y: 0.42))
        ),
    ]

    static let solids: [String: (bg: Color, fg: Color)] = [
        "white": (LeverTheme.hex(0xFFFFFF), darkInk),
        "gray": (LeverTheme.hex(0xA3A3A3), darkInk),
        "black": (LeverTheme.hex(0x000000), .white),
        "red": (LeverTheme.hex(0xAD3849), .white),
        "amber": (LeverTheme.hex(0xDCA753), darkInk),
        "green": (LeverTheme.hex(0x72AD87), darkInk),
        "blue": (LeverTheme.hex(0x315FA0), .white),
        "violet": (LeverTheme.hex(0xB097DF), darkInk),
        "orange": (LeverTheme.hex(0xED945D), darkInk),
        "yellow": (LeverTheme.hex(0xF2D977), darkInk),
        "lime": (LeverTheme.hex(0xAFCE78), darkInk),
        "teal": (LeverTheme.hex(0x236961), .white),
        "cyan": (LeverTheme.hex(0x78C9D8), darkInk),
        "indigo": (LeverTheme.hex(0x4E4E86), .white),
        "magenta": (LeverTheme.hex(0x973E79), .white),
        "pink": (LeverTheme.hex(0xECA2BB), darkInk),
    ]

    static func fallbackHueColor(for seed: String) -> Color {
        var hash: UInt32 = 0
        for scalar in seed.unicodeScalars {
            hash = hash &* 31 &+ scalar.value
        }
        let hue = Double(hash % 360) / 360.0
        return Color(hue: hue, saturation: 0.48, brightness: 0.82)
    }

    static func sfSymbol(forLucide name: String) -> String {
        switch name.lowercased() {
        case "bot": return "cpu"
        case "code", "code2", "codexml": return "chevron.left.forwardslash.chevron.right"
        case "terminal", "terminalsquare": return "terminal"
        case "folders", "folder", "folderopen": return "folder.fill"
        case "globe", "globe2": return "globe"
        case "server": return "server.rack"
        case "database": return "cylinder.split.1x2"
        case "sparkles", "sparkle": return "sparkles"
        case "monitor", "laptop": return "desktopcomputer"
        case "cloud": return "cloud.fill"
        case "package", "box": return "shippingbox.fill"
        case "bookopen", "book": return "book.fill"
        case "flaskconical", "flaskround": return "flask.fill"
        case "shieldcheck", "shield": return "checkmark.shield.fill"
        case "rocket": return "paperplane.fill"
        case "gamepad2", "gamepad": return "gamecontroller.fill"
        case "music": return "music.note"
        case "image": return "photo.fill"
        case "gitbranch": return "arrow.triangle.branch"
        case "workflow": return "point.3.connected.trianglepath.dotted"
        case "wrench", "hammer": return "wrench.and.screwdriver.fill"
        case "layers": return "square.3.layers.3d"
        case "leaf", "sprout": return "leaf.fill"
        case "brain", "braincircuit": return "brain.head.profile"
        case "search": return "magnifyingglass"
        case "palette", "paintbrush": return "paintpalette.fill"
        case "zap", "bolt": return "bolt.fill"
        case "compass": return "safari.fill"
        case "bug": return "ladybug.fill"
        case "filecode", "filetext": return "doc.text.fill"
        case "messagecircle", "messagesquare": return "bubble.left.fill"
        case "star": return "star.fill"
        case "heart": return "heart.fill"
        case "cpu": return "cpu.fill"
        default: return "sparkles"
        }
    }
}

/// Renders Agent avatars 1:1 with Lever Desktop (`preset`, `image`, `lucide`, `emoji`, `monogram`)
/// using all 16 Desktop mesh gradients and 16 solid swatches.
struct AgentAvatarView: View {
    let name: String
    let avatar: String?
    var avatarSpec: AvatarSpec? = nil
    var deviceId: String? = nil
    var store: LeverStore? = nil
    let seed: String
    var size: CGFloat = 46

    @State private var loadedImage: UIImage?

    private var effectiveSpec: AvatarSpec? {
        if let spec = avatarSpec, !spec.kind.isEmpty { return spec }
        if let legacy = avatar?.trimmingCharacters(in: .whitespacesAndNewlines), !legacy.isEmpty {
            let isEmoji = legacy.unicodeScalars.first?.properties.isEmojiPresentation == true
            return AvatarSpec(kind: isEmoji ? "emoji" : "monogram", value: legacy, color: "gradient-prism")
        }
        return nil
    }

    private var fallbackInitials: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "AG" }
        let parts = trimmed.split(whereSeparator: { $0.isWhitespace })
        if parts.count >= 2, let f = parts[0].first, let s = parts[1].first {
            return "\(f)\(s)".uppercased()
        }
        return String(trimmed.prefix(2)).uppercased()
    }

    private var swatchColorKey: String {
        effectiveSpec?.color?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var foregroundColor: Color {
        if let solid = DesktopAvatarPalette.solids[swatchColorKey] {
            return solid.fg
        }
        return DesktopAvatarPalette.darkInk
    }

    var body: some View {
        let corner = size * 0.27
        ZStack {
            if let spec = effectiveSpec, spec.kind == "preset", spec.value == "lever" {
                Image("LeverPresetLogo")
                    .resizable()
                    .scaledToFill()
            } else if let spec = effectiveSpec, spec.kind == "image", let img = loadedImage {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
            } else {
                swatchBackground
                glyphContent
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5)
        )
        .task(id: imageTaskKey) {
            loadedImage = nil
            guard let spec = effectiveSpec,
                  spec.kind == "image",
                  let imageId = spec.value,
                  imageId.count == 64,
                  let deviceId,
                  let store else {
                return
            }
            guard let reference = LeverMedia(space: store.activeSpace?.id, device: deviceId, kind: .avatar, id: imageId) else { return }
            let image = try? await store.media.pipeline.image(for: reference.request(maxPixels: size * 3))
            if !Task.isCancelled { loadedImage = image }
        }
    }

    private var imageTaskKey: String {
        "\(deviceId ?? ""):\(effectiveSpec?.kind ?? ""):\(effectiveSpec?.value ?? "")"
    }

    @ViewBuilder
    private var swatchBackground: some View {
        if let mesh = DesktopAvatarPalette.meshes[swatchColorKey] {
            ZStack {
                LinearGradient(colors: mesh.base, startPoint: mesh.start, endPoint: mesh.end)
                RadialGradient(
                    colors: [mesh.glowA.0, mesh.glowA.0.opacity(0)],
                    center: mesh.glowA.1,
                    startRadius: 0,
                    endRadius: size * 0.82
                )
                RadialGradient(
                    colors: [mesh.glowB.0, mesh.glowB.0.opacity(0)],
                    center: mesh.glowB.1,
                    startRadius: 0,
                    endRadius: size * 0.82
                )
            }
        } else if let solid = DesktopAvatarPalette.solids[swatchColorKey] {
            solid.bg
        } else {
            DesktopAvatarPalette.fallbackHueColor(for: seed)
        }
    }

    @ViewBuilder
    private var glyphContent: some View {
        if let spec = effectiveSpec {
            switch spec.kind {
            case "lucide":
                Image(systemName: DesktopAvatarPalette.sfSymbol(forLucide: spec.value ?? ""))
                    .font(.system(size: size * 0.44, weight: .semibold))
                    .foregroundStyle(foregroundColor)
            case "emoji":
                let val = (spec.value?.isEmpty == false) ? spec.value! : "🤖"
                Text(val)
                    .font(.system(size: size * 0.52))
            case "monogram":
                let val = (spec.value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
                    ? String(spec.value!.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2))
                    : fallbackInitials
                Text(val)
                    .font(.system(size: val.count > 1 ? size * 0.36 : size * 0.44, weight: .semibold))
                    .foregroundStyle(foregroundColor)
            default:
                Text(fallbackInitials)
                    .font(.system(size: size * 0.36, weight: .semibold))
                    .foregroundStyle(foregroundColor)
            }
        } else {
            Text(fallbackInitials)
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(foregroundColor)
        }
    }
}

// MARK: - Native Left-Edge Interactive Pop Gesture Enabler

private final class SafePopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    weak var nav: UINavigationController?
    init(nav: UINavigationController) { self.nav = nav }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let nav else { return false }
        return nav.viewControllers.count > 1
    }
}

private var safePopDelegateKey: UInt8 = 0

/// Keeps UINavigationController's native left-edge swipe-to-go-back smooth even when
/// `.toolbar(.hidden, for: .navigationBar)` is used for bespoke iOS headers,
/// while safely disabling the gesture at root (`viewControllers.count <= 1`) to prevent stack hangs.
struct InteractivePopEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> PopEnablerController {
        PopEnablerController()
    }
    func updateUIViewController(_ uiViewController: PopEnablerController, context: Context) {
        uiViewController.enablePopGesture()
    }

    final class PopEnablerController: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            enablePopGesture()
        }

        func enablePopGesture() {
            guard let nav = navigationController else { return }
            let delegate: SafePopGestureDelegate
            if let existing = objc_getAssociatedObject(nav, &safePopDelegateKey) as? SafePopGestureDelegate {
                delegate = existing
            } else {
                delegate = SafePopGestureDelegate(nav: nav)
                objc_setAssociatedObject(nav, &safePopDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            }
            nav.interactivePopGestureRecognizer?.isEnabled = true
            nav.interactivePopGestureRecognizer?.delegate = delegate
        }
    }
}

enum Haptics {
    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
    static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}
