import SwiftUI
import Textual

/// Production SwiftUI streaming Markdown renderer powered by `Textual` (`gonzalezreal/textual`):
/// - Full GFM headings, lists, blockquotes, links, strikethrough, inline code, and LaTeX math
/// - Built-in Prism syntax highlighting with language header & one-tap copy button
/// - Two-pass measured `TableLayout` with uniform full-row header fill (zero jagged seam) & smart wrapping
/// - Native cross-block text selection and smooth streaming updates
struct MarkdownContentView: View {
    let text: String
    let foreground: Color
    var isUserBubble: Bool = false

    var body: some View {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            StructuredText(markdown: trimmed, syntaxExtensions: [.math])
                .font(.system(size: 15))
                .foregroundStyle(foreground)
                .textual.structuredTextStyle(LeverStructuredTextStyle(isUserBubble: isUserBubble))
                .textual.textSelection(.enabled)
        }
    }
}

// MARK: - Unified Lever Monochrome Textual Style

private struct LeverStructuredTextStyle: StructuredText.Style {
    let isUserBubble: Bool

    var inlineStyle: InlineStyle {
        InlineStyle()
            .code(
                .monospaced,
                .fontScale(0.88),
                .backgroundColor(isUserBubble ? Color.white.opacity(0.14) : Color.primary.opacity(0.08))
            )
            .strong(.fontWeight(.semibold))
            .link(.foregroundColor(isUserBubble ? LeverTheme.userBubbleInk : LeverTheme.syncBlue))
    }

    var headingStyle: LeverHeadingStyle { LeverHeadingStyle() }
    var paragraphStyle: LeverParagraphStyle { LeverParagraphStyle(compact: isUserBubble) }
    var blockQuoteStyle: LeverBlockQuoteStyle { LeverBlockQuoteStyle(isUserBubble: isUserBubble) }
    var codeBlockStyle: LeverCodeBlockStyle { LeverCodeBlockStyle(isUserBubble: isUserBubble) }
    var listItemStyle: StructuredText.DefaultListItemStyle { .default }
    var unorderedListMarker: StructuredText.HierarchicalSymbolListMarker { .hierarchical(.disc, .circle, .square) }
    var orderedListMarker: StructuredText.DecimalListMarker { .decimal }
    var tableStyle: LeverTableStyle { LeverTableStyle(isUserBubble: isUserBubble) }
    var tableCellStyle: LeverTableCellStyle { LeverTableCellStyle(isUserBubble: isUserBubble) }
    var thematicBreakStyle: StructuredText.DividerThematicBreakStyle { .divider }
}

private struct LeverParagraphStyle: StructuredText.ParagraphStyle {
    let compact: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textual.lineSpacing(.fontScaled(0.28))
            .textual.blockSpacing(.init(top: 0, bottom: compact ? 6 : 10))
    }
}

private struct LeverHeadingStyle: StructuredText.HeadingStyle {
    private static let scales: [CGFloat] = [1.24, 1.14, 1.06, 1.0, 0.95, 0.92]

    func makeBody(configuration: Configuration) -> some View {
        let idx = max(0, min(configuration.headingLevel - 1, Self.scales.count - 1))
        configuration.label
            .textual.fontScale(Self.scales[idx])
            .fontWeight(.semibold)
            .textual.lineSpacing(.fontScaled(0.18))
            .textual.blockSpacing(.init(top: configuration.headingLevel <= 2 ? 12 : 8, bottom: 6))
    }
}

private struct LeverBlockQuoteStyle: StructuredText.BlockQuoteStyle {
    let isUserBubble: Bool

    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                .fill(isUserBubble ? LeverTheme.userBubbleInk.opacity(0.45) : LeverTheme.hairlineStrong)
                .frame(width: 3)
            configuration.label
                .foregroundStyle(isUserBubble ? LeverTheme.userBubbleInk.opacity(0.86) : LeverTheme.inkSecondary)
        }
        .textual.blockSpacing(.init(top: 2, bottom: 10))
    }
}

private struct LeverCodeBlockStyle: StructuredText.CodeBlockStyle {
    let isUserBubble: Bool

    func makeBody(configuration: Configuration) -> some View {
        LeverCodeBlockBody(configuration: configuration, isUserBubble: isUserBubble)
            .textual.blockSpacing(.init(top: 4, bottom: 12))
    }
}

private struct LeverCodeBlockBody: View {
    let configuration: StructuredText.CodeBlockStyleConfiguration
    let isUserBubble: Bool
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(languageLabel)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(LeverTheme.inkTertiary)
                Spacer()
                Button {
                    configuration.codeBlock.copyToPasteboard()
                    Haptics.light()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        copied = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10.5, weight: .medium))
                        Text(copied ? "已复制" : "复制")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(copied ? LeverTheme.runningEmerald : LeverTheme.inkSecondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(LeverTheme.surfacePill.opacity(0.68))

            Rectangle()
                .fill(LeverTheme.hairline)
                .frame(height: 0.5)

            Overflow { state in
                configuration.label
                    .textual.lineSpacing(.fontScaled(0.24))
                    .textual.fontScale(0.84)
                    .monospaced()
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: true, vertical: true)
                    .frame(minWidth: state.containerWidth, alignment: .leading)
                    .padding(11)
            }
        }
        .background(isUserBubble ? LeverTheme.surfaceElevated : LeverTheme.surfaceInset)
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(LeverTheme.hairlineStrong, lineWidth: 0.5)
        )
    }

    private var languageLabel: String {
        let trimmed = (configuration.languageHint ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "code" : trimmed
    }
}

private struct LeverTableCellStyle: StructuredText.TableCellStyle {
    let isUserBubble: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: configuration.row == 0 ? .semibold : .regular))
            .foregroundStyle(
                isUserBubble
                    ? LeverTheme.userBubbleInk.opacity(configuration.row == 0 ? 1.0 : 0.90)
                    : (configuration.row == 0 ? LeverTheme.inkPrimary : LeverTheme.inkSecondary)
            )
            .textual.lineSpacing(.fontScaled(0.24))
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
    }
}

private struct LeverTableStyle: StructuredText.TableStyle {
    let isUserBubble: Bool
    private static let borderWidth: CGFloat = 0.5

    func makeBody(configuration: Configuration) -> some View {
        Overflow { state in
            // Cap wide tables at 1.45x container width so columns stay comfortably legible
            // with smooth horizontal scroll while multi-sentence cells still wrap cleanly.
            let maxWidth = state.containerWidth.map { $0 * 1.45 }
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(minWidth: state.containerWidth, maxWidth: maxWidth, alignment: .leading)
                .textual.tableBackground { layout in
                    Canvas { context, _ in
                        if layout.numberOfRows > 0 {
                            let headerFill = isUserBubble ? Color.white.opacity(0.09) : LeverTheme.surfaceInset
                            context.fill(
                                Path(layout.rowBounds(0).integral),
                                with: .style(headerFill)
                            )
                        }
                    }
                }
                .textual.tableOverlay { layout in
                    Canvas { context, _ in
                        let lineColor = isUserBubble ? Color.white.opacity(0.16) : LeverTheme.hairline
                        for divider in layout.dividers() {
                            context.fill(
                                Path(divider),
                                with: .style(lineColor)
                            )
                        }
                    }
                }
                .padding(Self.borderWidth)
                .background(isUserBubble ? Color.white.opacity(0.03) : LeverTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(isUserBubble ? Color.white.opacity(0.20) : LeverTheme.hairlineStrong, lineWidth: Self.borderWidth)
                )
        }
        .textual.tableCellSpacing(horizontal: Self.borderWidth, vertical: Self.borderWidth)
        .textual.blockSpacing(.init(top: 4, bottom: 12))
    }
}
