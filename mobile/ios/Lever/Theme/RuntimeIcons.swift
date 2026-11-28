import SwiftUI

// MARK: - Authentic Lever Desktop Provider Icons (Extracted Verbatim from web/src/components/RuntimeIcon.tsx & antigravity.svg)

struct ProviderIconView: View {
    let providerId: String?
    var providerType: String? = nil
    var pluginId: String? = nil
    var size: CGFloat = 16

    private var normalizedKind: String {
        if pluginId == "lever.dsh" { return "dsh" }
        let raw = (providerType?.isEmpty == false ? providerType! : (providerId ?? "")).lowercased()
        if raw.contains("claude") { return "claude" }
        if raw.contains("codex") || raw.contains("openai") { return "codex" }
        if raw.contains("antigravity") || raw.contains("gemini") { return "antigravity" }
        if raw == "pi" { return "pi" }
        if raw == "dsh" || raw.contains("deepseek") { return "dsh" }
        return raw
    }

    var body: some View {
        Group {
            switch normalizedKind {
            case "antigravity":
                Image("ProviderAntigravity")
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            case "claude":
                Image("ProviderClaude")
                    .resizable()
                    .scaledToFit()
            case "codex":
                Image("ProviderCodex")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
            case "pi":
                Image("ProviderPi")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
            case "dsh":
                Image("ProviderDsh")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
            default:
                Image(systemName: "powerplug")
                    .font(.system(size: size * 0.82, weight: .medium))
            }
        }
        .frame(width: size, height: size)
    }
}

/// Signal-strength style Reasoning Effort icon (1..4 vertical ascending bars).
struct EffortIconView: View {
    let effort: String?
    var size: CGFloat = 13

    private var level: Int {
        switch (effort ?? "").lowercased() {
        case "none", "off": return 0
        case "minimal", "low": return 1
        case "medium", "med": return 2
        case "high": return 3
        case "xhigh", "max", "ultra": return 4
        default: return 2
        }
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: max(1.2, size * 0.11)) {
            ForEach(1...4, id: \.self) { idx in
                let active = idx <= level
                let barHeight = size * (0.32 + CGFloat(idx) * 0.17)
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(active ? AnyShapeStyle(.primary) : AnyShapeStyle(.primary.opacity(0.24)))
                    .frame(width: max(1.8, size * 0.16), height: barHeight)
            }
        }
        .frame(height: size, alignment: .bottom)
    }
}
