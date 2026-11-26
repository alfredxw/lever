package provider

import (
	"encoding/json"
	"net/url"
	"strings"
	"unicode/utf8"

	"lever/internal/model"
)

const (
	puaStart = "\uE200"
	puaEnd   = "\uE201"
	puaSep   = "\uE202"
)

type codexCitationIndex map[string]model.CitationSource

func (idx codexCitationIndex) add(refID, title, rawURL string) {
	refID = strings.TrimSpace(refID)
	u := validCitationURL(rawURL)
	if refID == "" || u == "" {
		return
	}
	title = strings.TrimSpace(title)
	if existing, ok := idx[refID]; ok && existing.URL == u && title == "" {
		return
	}
	idx[refID] = model.CitationSource{Title: title, URL: u}
}

func validCitationURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return ""
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return ""
	}
	return raw
}

// addMCPResult indexes ref_id -> {title, url} mappings from Codex search tool
// results (such as codex_apps / search_service.web_run) across both live
// app-server _meta payloads and content envelopes stored in thread history.
func (idx codexCitationIndex) addMCPResult(result any) {
	if idx == nil {
		return
	}
	res := obj(result)
	if res == nil {
		return
	}
	for _, entry := range arr(obj(res["_meta"])["raw_messages"]) {
		msg := obj(entry)
		if content := obj(msg["content"]); content != nil {
			idx.add(str(content["ref_id"]), str(content["title"]), str(content["url"]))
		}
		for refID, value := range obj(obj(obj(msg["metadata"])["sonic_browser_tool"])["content"]) {
			item := obj(value)
			idx.add(refID, str(item["title"]), str(item["url"]))
		}
	}
	for _, entry := range arr(res["content"]) {
		part := obj(entry)
		if text := str(part["text"]); text != "" {
			idx.addSearchText(text)
		}
	}
}

func (idx codexCitationIndex) addSearchText(text string) {
	if !strings.Contains(text, "【") {
		return
	}
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "{") {
		var envelope struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal([]byte(trimmed), &envelope) == nil && len(envelope.Content) > 0 {
			for _, part := range envelope.Content {
				idx.addSearchText(part.Text)
			}
			return
		}
	}
	// Scan "<Title> (<URL>)\n【<ref_id>】" entries, including JSON-escaped "\\n"
	// fragments when Codex truncated a large result string mid-payload.
	const openBracket = "【"
	const closeBracket = "】"
	for pos := 0; pos < len(text); {
		rel := strings.Index(text[pos:], openBracket)
		if rel < 0 {
			break
		}
		start := pos + rel
		afterOpen := start + len(openBracket)
		endRel := strings.Index(text[afterOpen:], closeBracket)
		if endRel < 0 {
			break
		}
		refID := text[afterOpen : afterOpen+endRel]
		pos = afterOpen + endRel + len(closeBracket)
		if !isCitationRefID(refID) {
			continue
		}
		line, escaped := precedingSearchHeader(text[:start])
		if line == "" {
			continue
		}
		if escaped {
			line = unescapeJSONFragment(line)
		}
		if title, rawURL, ok := splitTitleAndURL(line); ok {
			idx.add(refID, title, rawURL)
		}
	}
}

func isCitationRefID(ref string) bool {
	if len(ref) == 0 || len(ref) > 64 {
		return false
	}
	for i := 0; i < len(ref); i++ {
		c := ref[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func precedingSearchHeader(before string) (string, bool) {
	end := len(before)
	escaped := false
	switch {
	case strings.HasSuffix(before, `\r\n`):
		end -= 4
		escaped = true
	case strings.HasSuffix(before, `\n`):
		end -= 2
		escaped = true
	case strings.HasSuffix(before, "\r\n"):
		end -= 2
	case strings.HasSuffix(before, "\n"):
		end--
	default:
		return "", false
	}
	prefix := before[:end]
	if escaped {
		start := 0
		if idx := strings.LastIndex(prefix, `\n`); idx >= 0 {
			start = idx + 2
		}
		if idx := strings.LastIndex(prefix, `"text":"`); idx >= 0 && idx+len(`"text":"`) > start {
			start = idx + len(`"text":"`)
		}
		if idx := strings.LastIndex(prefix, `"text": "`); idx >= 0 && idx+len(`"text": "`) > start {
			start = idx + len(`"text": "`)
		}
		return prefix[start:], true
	}
	start := strings.LastIndexByte(prefix, '\n') + 1
	return prefix[start:], false
}

func unescapeJSONFragment(s string) string {
	var decoded string
	if err := json.Unmarshal([]byte(`"`+s+`"`), &decoded); err == nil {
		return decoded
	}
	replacer := strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\/`, `/`)
	return replacer.Replace(s)
}

func splitTitleAndURL(line string) (string, string, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasSuffix(line, ")") {
		return "", "", false
	}
	open := strings.LastIndex(line, "(https://")
	if alt := strings.LastIndex(line, "(http://"); alt > open {
		open = alt
	}
	if open < 0 {
		return "", "", false
	}
	rawURL := line[open+1 : len(line)-1]
	if strings.ContainsAny(rawURL, " \t\r\n") || validCitationURL(rawURL) == "" {
		return "", "", false
	}
	return strings.TrimSpace(line[:open]), rawURL, true
}

func stripCodexCitations(raw string) string {
	text, _ := resolveCodexCitations(raw, nil, false)
	return text
}

// resolveCodexCitations strips OpenAI/Codex inline PUA citation markers outside
// Markdown code spans/blocks and returns clean text plus resolved citations
// anchored by UTF-16 offset. While streaming, incomplete trailing cite tokens
// are held back so raw private-use delimiters never flash in the UI.
func resolveCodexCitations(raw string, index codexCitationIndex, streaming bool) (string, []model.Citation) {
	if !strings.Contains(raw, puaStart) {
		return raw, nil
	}
	out := make([]byte, 0, len(raw))
	var citations []model.Citation
	utf16Len := 0

	appendBytes := func(s string) {
		out = append(out, s...)
		utf16Len += utf16StringLen(s)
	}
	trimTrailingSpace := func() {
		if len(out) >= 2 && out[len(out)-1] == ' ' && out[len(out)-2] != ' ' && out[len(out)-2] != '\n' && out[len(out)-2] != '\t' {
			out = out[:len(out)-1]
			utf16Len--
		}
	}

	atLineStart := true
	var fenceChar byte
	fenceLen := 0
	inlineCodeLen := 0

	for i := 0; i < len(raw); {
		if atLineStart && inlineCodeLen == 0 {
			atLineStart = false
			if next, char, count, handled := scanCodeFenceLine(raw, i, fenceChar, fenceLen); handled {
				appendBytes(raw[i:next])
				fenceChar, fenceLen = char, count
				i = next
				atLineStart = i > 0 && raw[i-1] == '\n'
				continue
			}
		}

		if fenceLen > 0 {
			nl := strings.IndexByte(raw[i:], '\n')
			if nl < 0 {
				appendBytes(raw[i:])
				break
			}
			end := i + nl + 1
			appendBytes(raw[i:end])
			i = end
			atLineStart = true
			continue
		}

		if raw[i] == '`' {
			end := i
			for end < len(raw) && raw[end] == '`' {
				end++
			}
			runLen := end - i
			if inlineCodeLen == 0 {
				if hasClosingBackticks(raw[end:], runLen) {
					inlineCodeLen = runLen
				}
			} else if runLen == inlineCodeLen {
				inlineCodeLen = 0
			}
			appendBytes(raw[i:end])
			i = end
			continue
		}

		if inlineCodeLen == 0 && strings.HasPrefix(raw[i:], puaStart) {
			afterStart := i + len(puaStart)
			closeIdx := findCitationClose(raw, afterStart)
			if closeIdx >= 0 {
				body := raw[afterStart:closeIdx]
				kind, rest, hasSep := strings.Cut(body, puaSep)
				if hasSep && isCiteMarkerKind(kind) {
					afterEnd := closeIdx + len(puaEnd)
					if shouldTrimSpaceBeforeCitation(raw[afterEnd:]) {
						trimTrailingSpace()
					}
					if sources := lookupCitationSources(rest, index); len(sources) > 0 {
						citations = appendCitation(citations, utf16Len, sources)
					}
					i = afterEnd
					continue
				}
			} else {
				tail := raw[afterStart:]
				nl := strings.IndexByte(tail, '\n')
				if streaming && nl < 0 && isPartialCiteToken(tail) {
					trimTrailingSpace()
					break
				}
				if !streaming && isIncompleteCiteBody(tail) {
					end := len(raw)
					if nl >= 0 {
						end = afterStart + nl
					}
					if shouldTrimSpaceBeforeCitation(raw[end:]) {
						trimTrailingSpace()
					}
					i = end
					continue
				}
			}
		}

		r, size := utf8.DecodeRuneInString(raw[i:])
		out = append(out, raw[i:i+size]...)
		utf16Len += utf16RuneLen(r)
		atLineStart = r == '\n'
		i += size
	}

	return string(out), citations
}

func scanCodeFenceLine(s string, start int, openChar byte, openLen int) (next int, char byte, count int, handled bool) {
	p := start
	for spaces := 0; spaces < 3 && p < len(s) && s[p] == ' '; spaces++ {
		p++
	}
	if p >= len(s) || (s[p] != '`' && s[p] != '~') {
		return start, openChar, openLen, false
	}
	c := s[p]
	runEnd := p
	for runEnd < len(s) && s[runEnd] == c {
		runEnd++
	}
	n := runEnd - p
	if n < 3 {
		return start, openChar, openLen, false
	}
	lineEnd := len(s)
	if nl := strings.IndexByte(s[runEnd:], '\n'); nl >= 0 {
		lineEnd = runEnd + nl + 1
	}
	rest := strings.TrimRight(s[runEnd:lineEnd], "\r\n")
	if openLen == 0 {
		if c == '`' && strings.ContainsRune(rest, '`') {
			return start, 0, 0, false
		}
		return lineEnd, c, n, true
	}
	if c == openChar && n >= openLen && strings.Trim(rest, " \t") == "" {
		return lineEnd, 0, 0, true
	}
	return start, openChar, openLen, false
}

func hasClosingBackticks(rest string, n int) bool {
	for i := 0; i < len(rest); {
		if rest[i] == '\n' && i+1 < len(rest) && rest[i+1] == '\n' {
			return false
		}
		if rest[i] != '`' {
			i++
			continue
		}
		end := i
		for end < len(rest) && rest[end] == '`' {
			end++
		}
		if end-i == n {
			return true
		}
		i = end
	}
	return false
}

func findCitationClose(s string, start int) int {
	for i := start; i < len(s); {
		if s[i] == '\n' || strings.HasPrefix(s[i:], puaStart) {
			return -1
		}
		if strings.HasPrefix(s[i:], puaEnd) {
			return i
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	return -1
}

func isCiteMarkerKind(kind string) bool {
	return kind == "cite" || kind == "filecite"
}

func isIncompleteCiteBody(tail string) bool {
	return strings.HasPrefix(tail, "cite"+puaSep) || strings.HasPrefix(tail, "filecite"+puaSep)
}

func isPartialCiteToken(tail string) bool {
	if isIncompleteCiteBody(tail) {
		return true
	}
	return strings.HasPrefix("cite"+puaSep, tail) || strings.HasPrefix("filecite"+puaSep, tail)
}

func shouldTrimSpaceBeforeCitation(after string) bool {
	if after == "" {
		return true
	}
	if strings.HasPrefix(after, puaStart) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(after)
	switch r {
	case ' ', '\t', '\n', '\r', '.', ',', ';', ':', '!', '?', ')', ']', '}',
		'。', '，', '；', '：', '！', '？', '）', '】', '》', '、':
		return true
	}
	return false
}

func lookupCitationSources(refs string, index codexCitationIndex) []model.CitationSource {
	if len(index) == 0 {
		return nil
	}
	var sources []model.CitationSource
	seen := map[string]bool{}
	for _, ref := range strings.Split(refs, puaSep) {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		source, ok := index[ref]
		if !ok || source.URL == "" || seen[source.URL] {
			continue
		}
		seen[source.URL] = true
		sources = append(sources, source)
	}
	return sources
}

func appendCitation(citations []model.Citation, offset int, sources []model.CitationSource) []model.Citation {
	if len(sources) == 0 {
		return citations
	}
	if n := len(citations); n > 0 && citations[n-1].Offset == offset {
		seen := make(map[string]bool, len(citations[n-1].Sources))
		for _, s := range citations[n-1].Sources {
			seen[s.URL] = true
		}
		for _, s := range sources {
			if !seen[s.URL] {
				seen[s.URL] = true
				citations[n-1].Sources = append(citations[n-1].Sources, s)
			}
		}
		return citations
	}
	return append(citations, model.Citation{Offset: offset, Sources: sources})
}

func utf16RuneLen(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}

func utf16StringLen(s string) int {
	n := 0
	for _, r := range s {
		n += utf16RuneLen(r)
	}
	return n
}

func claudeCitations(raw any) []model.CitationSource {
	var sources []model.CitationSource
	seen := map[string]bool{}
	for _, entry := range arr(raw) {
		c := obj(entry)
		u := validCitationURL(str(c["url"]))
		if u == "" || seen[u] {
			continue
		}
		seen[u] = true
		sources = append(sources, model.CitationSource{
			Title: strings.TrimSpace(str(c["title"])),
			URL:   u,
		})
	}
	return sources
}
