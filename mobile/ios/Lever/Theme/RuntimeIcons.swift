import SwiftUI

// MARK: - Authentic Desktop-Matched Provider Icons (web/src/components/RuntimeIcon.tsx)

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
                AntigravityMarkView()
            case "claude":
                ClaudeStarburstShape()
                    .fill(Color(red: 0.851, green: 0.467, blue: 0.341)) // #D97757
            case "codex":
                CodexBlossomShape()
                    .fill(style: FillStyle(eoFill: true))
            case "pi":
                PiGeometricShape()
                    .fill(style: FillStyle(eoFill: true))
            case "dsh":
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: size * 0.82, weight: .semibold))
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

// MARK: - Exact Vector Shapes (24x24 normalized)

/// OpenAI / Codex geometric blossom mark.
private struct CodexBlossomShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let cx = rect.midX
        let cy = rect.midY
        var p = Path()
        let petals = 6
        let ringR = s * 0.27
        let petalR = s * 0.24
        let innerR = s * 0.15
        for i in 0..<petals {
            let angle = CGFloat(i) * (.pi * 2 / CGFloat(petals)) - .pi / 2
            let px = cx + cos(angle) * ringR
            let py = cy + sin(angle) * ringR
            let capsule = CGRect(x: px - petalR, y: py - petalR, width: petalR * 2, height: petalR * 2)
            p.addEllipse(in: capsule)
        }
        // Center hexagon cutout (eoFill)
        var hex = Path()
        for i in 0..<6 {
            let angle = CGFloat(i) * (.pi / 3) - .pi / 6
            let pt = CGPoint(x: cx + cos(angle) * innerR, y: cy + sin(angle) * innerR)
            if i == 0 { hex.move(to: pt) } else { hex.addLine(to: pt) }
        }
        hex.closeSubpath()
        p.addPath(hex)
        return p
    }
}

/// Anthropic / Claude 12-ray starburst mark.
private struct ClaudeStarburstShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let cx = rect.midX
        let cy = rect.midY
        var p = Path()
        let rays = 12
        let outerR = s * 0.48
        let innerR = s * 0.14
        for i in 0..<rays {
            let angle = CGFloat(i) * (.pi * 2 / CGFloat(rays)) - .pi / 2
            let halfSpread: CGFloat = 0.11
            let p1 = CGPoint(x: cx + cos(angle - halfSpread) * innerR, y: cy + sin(angle - halfSpread) * innerR)
            let tip = CGPoint(x: cx + cos(angle) * outerR, y: cy + sin(angle) * outerR)
            let p2 = CGPoint(x: cx + cos(angle + halfSpread) * innerR, y: cy + sin(angle + halfSpread) * innerR)
            p.move(to: CGPoint(x: cx, y: cy))
            p.addLine(to: p1)
            p.addLine(to: tip)
            p.addLine(to: p2)
            p.closeSubpath()
        }
        p.addEllipse(in: CGRect(x: cx - innerR, y: cy - innerR, width: innerR * 2, height: innerR * 2))
        return p
    }
}

/// Pi exact geometric mark matching RuntimeIcon.tsx (24x24 viewBox).
private struct PiGeometricShape: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 24.0
        let sy = rect.height / 24.0
        func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
            CGRect(x: rect.minX + x * sx, y: rect.minY + y * sy, width: w * sx, height: h * sy)
        }
        var p = Path()
        // Outer L-frame with cutout window
        p.move(to: CGPoint(x: rect.minX + 1 * sx, y: rect.minY + 1 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 17.5 * sx, y: rect.minY + 1 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 17.5 * sx, y: rect.minY + 12 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 12 * sx, y: rect.minY + 12 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 12 * sx, y: rect.minY + 17.5 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 6.5 * sx, y: rect.minY + 17.5 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 6.5 * sx, y: rect.minY + 23 * sy))
        p.addLine(to: CGPoint(x: rect.minX + 1 * sx, y: rect.minY + 23 * sy))
        p.closeSubpath()
        p.addRect(r(6.5, 6.5, 5.5, 5.5))
        p.addRect(r(17.5, 12, 5.5, 11))
        return p
    }
}

/// Exact Antigravity mark traced from `web/src/components/icons/antigravity.svg` (180x180 viewBox)
/// with transparent background and authentic 4-color gradient blend (green / yellow / coral-red / blue).
private struct AntigravityMarkView: View {
    var body: some View {
        AntigravityMarkShape()
            .fill(
                LinearGradient(
                    stops: [
                        .init(color: Color(red: 0.0, green: 0.725, blue: 0.361), location: 0.0),   // #00B95C
                        .init(color: Color(red: 0.984, green: 0.737, blue: 0.016), location: 0.34), // #FBBC04
                        .init(color: Color(red: 0.988, green: 0.255, blue: 0.239), location: 0.62), // #FC413D
                        .init(color: Color(red: 0.192, green: 0.525, blue: 1.0), location: 1.0),    // #3186FF
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
    }
}

private struct AntigravityMarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 180.0
        let sy = rect.height / 180.0
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        var p = Path()
        p.move(to: pt(144.248, 149.062))
        p.addCurve(to: pt(152.685, 140.625), control1: pt(151.748, 154.688), control2: pt(162.998, 150.938))
        p.addCurve(to: pt(89.8727, 28.125), control1: pt(121.748, 110.625), control2: pt(128.31, 28.125))
        p.addCurve(to: pt(27.0602, 140.625), control1: pt(51.4352, 28.125), control2: pt(57.9977, 110.625))
        p.addCurve(to: pt(35.4977, 149.062), control1: pt(15.8102, 151.875), control2: pt(27.9977, 154.688))
        p.addCurve(to: pt(89.8727, 94.6875), control1: pt(64.5602, 129.375), control2: pt(62.6852, 94.6875))
        p.addCurve(to: pt(144.248, 149.062), control1: pt(117.06, 94.6875), control2: pt(115.185, 129.375))
        p.closeSubpath()
        return p
    }
}
