import SwiftUI
import UIKit

/// Monochrome grayscale foundation for Light & Dark modes, with semantic accents
/// reserved strictly for status cues, unread badges, and Agent avatars (AGENTS.md).
enum LeverTheme {
    static let canvas = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.047, green: 0.051, blue: 0.059, alpha: 1) // #0C0D0F
            : UIColor(red: 0.965, green: 0.969, blue: 0.976, alpha: 1) // #F6F7F9
    })

    static let surface = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.086, green: 0.090, blue: 0.106, alpha: 1) // #16171B
            : UIColor.white
    })

    static let surfaceElevated = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.118, green: 0.125, blue: 0.145, alpha: 1) // #1E2025
            : UIColor(red: 0.984, green: 0.988, blue: 0.992, alpha: 1) // #FBFCFD
    })

    static let surfaceInset = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.141, green: 0.149, blue: 0.173, alpha: 1) // #24262C
            : UIColor(red: 0.945, green: 0.953, blue: 0.965, alpha: 1) // #F1F3F6
    })

    static let surfacePill = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.165, green: 0.173, blue: 0.200, alpha: 1) // #2A2C33
            : UIColor(red: 0.929, green: 0.937, blue: 0.953, alpha: 1) // #EDEFF3
    })

    static let inkPrimary = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.953, green: 0.957, blue: 0.969, alpha: 1) // #F3F4F7
            : UIColor(red: 0.067, green: 0.075, blue: 0.090, alpha: 1) // #111317
    })

    static let inkSecondary = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.671, green: 0.690, blue: 0.733, alpha: 1) // #ABB0BB
            : UIColor(red: 0.349, green: 0.373, blue: 0.424, alpha: 1) // #595F6C
    })

    static let inkTertiary = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.467, green: 0.490, blue: 0.541, alpha: 1) // #777D8A
            : UIColor(red: 0.533, green: 0.561, blue: 0.612, alpha: 1) // #888F9C
    })

    static let hairline = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor.white.withAlphaComponent(0.085)
            : UIColor.black.withAlphaComponent(0.075)
    })

    static let hairlineStrong = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor.white.withAlphaComponent(0.15)
            : UIColor.black.withAlphaComponent(0.14)
    })

    static let userBubbleBg = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.953, green: 0.957, blue: 0.969, alpha: 1)
            : UIColor(red: 0.094, green: 0.102, blue: 0.122, alpha: 1)
    })

    static let userBubbleInk = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.067, green: 0.075, blue: 0.090, alpha: 1)
            : UIColor.white
    })

    // Semantic accents
    static let unreadRed = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.973, green: 0.443, blue: 0.443, alpha: 1) // #F87171
            : UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 1) // #EF4444
    })

    static let runningEmerald = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.204, green: 0.827, blue: 0.600, alpha: 1) // #34D399
            : UIColor(red: 0.020, green: 0.588, blue: 0.412, alpha: 1) // #059669
    })

    static let runningEmeraldSoft = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.204, green: 0.827, blue: 0.600, alpha: 0.14)
            : UIColor(red: 0.020, green: 0.588, blue: 0.412, alpha: 0.10)
    })

    static let approvalAmber = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 1) // #FBBF24
            : UIColor(red: 0.706, green: 0.325, blue: 0.035, alpha: 1) // #B45309
    })

    static let approvalAmberDot = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 1)
            : UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #F59E0B
    })

    static let approvalAmberSoft = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 0.15)
            : UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 0.13)
    })

    static let syncBlue = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.376, green: 0.647, blue: 0.980, alpha: 1) // #60A5FA
            : UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1) // #2563EB
    })

    static let syncBlueSoft = Color(UIColor { tc in
        tc.userInterfaceStyle == .dark
            ? UIColor(red: 0.376, green: 0.647, blue: 0.980, alpha: 0.14)
            : UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 0.09)
    })

    static let avatarPalette: [Color] = [
        Color(red: 0.231, green: 0.420, blue: 0.878), // Indigo blue
        Color(red: 0.769, green: 0.369, blue: 0.227), // Terracotta
        Color(red: 0.059, green: 0.463, blue: 0.431), // Deep teal
        Color(red: 0.486, green: 0.227, blue: 0.929), // Violet
        Color(red: 0.745, green: 0.094, blue: 0.365), // Rose
        Color(red: 0.149, green: 0.388, blue: 0.569), // Slate blue
    ]

    static func avatarColor(for seed: String) -> Color {
        var hash: UInt64 = 5381
        for b in seed.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt64(b)
        }
        return avatarPalette[Int(hash % UInt64(avatarPalette.count))]
    }
}

struct AgentAvatarView: View {
    let name: String
    let avatar: String?
    let seed: String
    var size: CGFloat = 46

    private var displayGlyph: String {
        if let av = avatar?.trimmingCharacters(in: .whitespacesAndNewlines), !av.isEmpty {
            return String(av.prefix(2))
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "L" }
        return String(first).uppercased()
    }

    private var isEmoji: Bool {
        displayGlyph.unicodeScalars.first?.properties.isEmojiPresentation == true
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(LeverTheme.avatarColor(for: seed))
            Text(displayGlyph)
                .font(.system(size: isEmoji ? size * 0.50 : size * 0.40, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
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
