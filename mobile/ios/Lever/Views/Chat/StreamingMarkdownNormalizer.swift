import Foundation

enum StreamingMarkdownNormalizer {
    /// Complete only the display copy. Ignore delimiters inside literal code.
    static func normalize(_ source: String) -> String {
        var fence: (marker: Character, count: Int)?
        var inlineCode = 0
        var math = false
        var emphasis: [String] = []
        var linkStart: String.Index?
        var linkDepth = 0
        var lineStart = true
        var i = source.startIndex
        while i < source.endIndex {
            let c = source[i], next = source.index(after: i)
            if c == "\n" { lineStart = true; i = next; continue }
            if lineStart && (c == " " || c == "\t") { i = next; continue }
            let atStart = lineStart
            lineStart = false
            if c == "\u{60}" || c == "~" {
                var end = next
                var count = 1
                while end < source.endIndex, source[end] == c { count += 1; end = source.index(after: end) }
                if atStart && count >= 3 && inlineCode == 0 {
                    if let open = fence {
                        if open.marker == c && count >= open.count { fence = nil }
                    } else { fence = (c,count) }
                } else if fence == nil && c == "\u{60}" {
                    if inlineCode == 0 { inlineCode = count } else if inlineCode == count { inlineCode = 0 }
                } else if fence == nil && inlineCode == 0 && c == "~" && count == 2 {
                    if emphasis.last == "~~" { emphasis.removeLast() } else { emphasis.append("~~") }
                }
                i = end
                continue
            }
            guard fence == nil && inlineCode == 0 else { i = next; continue }
            if c == "\\" { i = next < source.endIndex ? source.index(after: next) : next; continue }
            if c == "$" && next < source.endIndex && source[next] == "$" {
                math.toggle(); i = source.index(after: next); continue
            }
            guard !math else { i = next; continue }
            if linkDepth > 0 {
                if c == "(" { linkDepth += 1 }
                if c == ")" { linkDepth -= 1; if linkDepth == 0 { linkStart = nil } }
            } else if c == "]" && next < source.endIndex && source[next] == "(" {
                linkStart = next; linkDepth = 1; i = source.index(after: next); continue
            } else if c == "*" || c == "_" {
                var end = next
                while end < source.endIndex && source[end] == c { end = source.index(after: end) }
                let delimiter = String(source[i..<end])
                let previous = i == source.startIndex ? nil : source[source.index(before: i)]
                if emphasis.last == delimiter, previous?.isWhitespace == false { emphasis.removeLast() }
                else if delimiter.count <= 3, end < source.endIndex, !source[end].isWhitespace,
                        c != "_" || previous?.isLetter != true { emphasis.append(delimiter) }
                i = end; continue
            }
            i = next
        }
        var result = linkStart.map { String(source[..<$0]) } ?? source
        if let fence { result += "\n" + String(repeating: fence.marker, count: fence.count) }
        if inlineCode > 0 { result += String(repeating: "\u{60}", count: inlineCode) }
        if math { result += "\n$$" }
        return result + emphasis.reversed().joined()
    }
}
