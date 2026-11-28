package provider

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
	"golang.org/x/net/html"

	"lever/internal/model"
)

const (
	maxGeneratedImageBytes     = 16 << 20
	maxTurnGeneratedImageBytes = 32 << 20
	maxTurnGeneratedImages     = 8
	maxImagePathLength         = 4096
)

var (
	generatedImageMarkdown = goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithRendererOptions(goldmarkhtml.WithUnsafe()),
	)
	unclosedHTMLOpenRe   = regexp.MustCompile(`(?i)^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)`)
	fencedCodeOpenRe     = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
	fencedCodeCloseRe    = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})[\t ]*$")
	schemePrefixRe       = regexp.MustCompile(`(?i)^([a-z][a-z\d+.-]*):`)
	windowsDrivePrefixRe = regexp.MustCompile(`(?i)^[a-z]:[\\/]`)
	windowsSlashDriveRe  = regexp.MustCompile(`(?i)^/[a-z]:/`)
	backtickSpanRe       = regexp.MustCompile("`([^`\r\n]+)`")
	inlineImagePathRe    = regexp.MustCompile(`(?i)(?:file://[^\s<>()"'` + "`" + `]+|(?:~[\\/]|/|[a-z]:[\\/])[^\s<>()"'` + "`" + `]*?\.(?:png|jpe?g|gif|webp|bmp|ico|avif|svg))`)
)

type turnImageBudget struct {
	count int
	bytes int
}

func newTurnImageBudget() *turnImageBudget {
	return &turnImageBudget{}
}

func isPreviewImageExt(path string) bool {
	switch strings.ToLower(filepath.Ext(strings.TrimSpace(path))) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg":
		return true
	default:
		return false
	}
}

func rasterImageExt(mimeType string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0])) {
	case "image/png":
		return ".png", true
	case "image/jpeg":
		return ".jpg", true
	case "image/gif":
		return ".gif", true
	case "image/webp":
		return ".webp", true
	case "image/bmp":
		return ".bmp", true
	default:
		return "", false
	}
}

func isWindowsDrivePath(path string) bool {
	return windowsDrivePrefixRe.MatchString(path)
}

func isUNCPath(path string) bool {
	return strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//")
}

func normalizeLocalImagePath(raw, cwd string) string {
	path := strings.TrimSpace(raw)
	if path == "" || len(path) > maxImagePathLength {
		return ""
	}
	for _, r := range path {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	if m := schemePrefixRe.FindStringSubmatch(path); m != nil && !isWindowsDrivePath(path) {
		scheme := strings.ToLower(m[1])
		switch scheme {
		case "file":
			u, err := url.Parse(path)
			if err != nil || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) {
				return ""
			}
			path = u.Path
			if windowsSlashDriveRe.MatchString(path) {
				path = path[1:]
			}
		case "sandbox":
			u, err := url.Parse(path)
			if err != nil || u.Host != "" || !strings.HasPrefix(u.Path, "/") {
				return ""
			}
			path = u.Path
			if windowsSlashDriveRe.MatchString(path) {
				path = path[1:]
			}
		default:
			return ""
		}
	} else if isUNCPath(path) {
		return ""
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil || !filepath.IsAbs(home) {
			return ""
		}
		rest := strings.ReplaceAll(path[2:], "\\", "/")
		if strings.HasPrefix(rest, "../") || rest == ".." {
			return ""
		}
		path = filepath.Join(home, filepath.FromSlash(rest))
	}
	if !isWindowsDrivePath(path) {
		if !filepath.IsAbs(path) {
			if cwd == "" || !filepath.IsAbs(cwd) {
				return ""
			}
			path = filepath.Join(cwd, filepath.FromSlash(strings.ReplaceAll(path, "\\", "/")))
		} else {
			path = filepath.Clean(path)
		}
	}
	if !isPreviewImageExt(path) {
		return ""
	}
	return path
}

func imageComparisonKey(raw string, unescapeURL bool) string {
	path := strings.TrimSpace(raw)
	if path == "" {
		return ""
	}
	if m := schemePrefixRe.FindStringSubmatch(path); m != nil && !isWindowsDrivePath(path) {
		scheme := strings.ToLower(m[1])
		switch scheme {
		case "file":
			u, err := url.Parse(path)
			if err != nil {
				return ""
			}
			if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
				// Preserve UNC host for cross-platform comparison.
				path = "//" + u.Host + u.Path
			} else {
				path = u.Path
				if windowsSlashDriveRe.MatchString(path) {
					path = path[1:]
				}
			}
		case "sandbox":
			u, err := url.Parse(path)
			if err != nil || u.Host != "" {
				return ""
			}
			path = u.Path
			if windowsSlashDriveRe.MatchString(path) {
				path = path[1:]
			}
		default:
			return ""
		}
	} else if unescapeURL {
		if idx := strings.IndexAny(path, "?#"); idx >= 0 {
			path = path[:idx]
		}
		if decoded, err := url.PathUnescape(path); err == nil {
			path = decoded
		}
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
			path = filepath.Join(home, filepath.FromSlash(strings.ReplaceAll(path[2:], "\\", "/")))
		}
	}
	if isUNCPath(path) {
		return strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
	}
	if isWindowsDrivePath(path) {
		return strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
	}
	cleaned := filepath.ToSlash(filepath.Clean(path))
	if runtime.GOOS == "windows" {
		return strings.ToLower(cleaned)
	}
	return cleaned
}

func addImageComparisonKeys(set map[string]bool, raw string) {
	key := imageComparisonKey(raw, true)
	if key == "" {
		return
	}
	set[key] = true
	if filepath.IsAbs(key) {
		if resolved, err := filepath.EvalSymlinks(filepath.FromSlash(key)); err == nil {
			set[imageComparisonKey(resolved, false)] = true
		}
	}
}

func markdownImageSources(markdown string) []string {
	if strings.TrimSpace(markdown) == "" {
		return nil
	}
	var rendered bytes.Buffer
	if err := generatedImageMarkdown.Convert([]byte(markdown), &rendered); err != nil {
		return nil
	}
	var sources []string
	tokens := html.NewTokenizer(&rendered)
	for kind := tokens.Next(); kind != html.ErrorToken; kind = tokens.Next() {
		if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
			continue
		}
		token := tokens.Token()
		var key string
		switch token.Data {
		case "img":
			key = "src"
		case "source":
			key = "srcset"
		default:
			continue
		}
		for _, attr := range token.Attr {
			if attr.Key == key && strings.TrimSpace(attr.Val) != "" {
				sources = append(sources, attr.Val)
			}
		}
	}
	return sources
}

func formatGeneratedImageEmbed(path string) string {
	var destination string
	switch {
	case isWindowsDrivePath(path):
		destination = strings.ReplaceAll(path, "\\", "/")
	case isUNCPath(path):
		destination = "file:" + strings.ReplaceAll(path, "\\", "/")
	default:
		destination = path
	}
	var b strings.Builder
	b.Grow(len(destination) + 8)
	b.WriteString("![](<")
	for i := 0; i < len(destination); i++ {
		switch ch := destination[i]; ch {
		case '%':
			b.WriteString("%25")
		case '?':
			b.WriteString("%3F")
		case '#':
			b.WriteString("%23")
		case '&':
			b.WriteString("%26")
		case '\\':
			b.WriteString("%5C")
		case '\r':
			b.WriteString("%0D")
		case '\n':
			b.WriteString("%0A")
		case '<':
			b.WriteString(`\<`)
		case '>':
			b.WriteString(`\>`)
		default:
			b.WriteByte(ch)
		}
	}
	b.WriteString(">)")
	return b.String()
}

// An unclosed fence or raw HTML block swallows appended image embeds. Only a
// root-level block can swallow them; nested ones end with their container.
func unclosedTrailingMarkdownBlock(markdown string) string {
	if markdown == "" {
		return ""
	}
	source := []byte(markdown)
	doc := generatedImageMarkdown.Parser().Parse(text.NewReader(source))
	last := doc.LastChild()
	if last == nil {
		return ""
	}
	switch last.Kind() {
	case ast.KindFencedCodeBlock:
		lines := last.Lines()
		if lines.Len() == 0 {
			trimmed := strings.TrimRight(strings.ReplaceAll(strings.ReplaceAll(markdown, "\r\n", "\n"), "\r", "\n"), "\n")
			all := strings.Split(trimmed, "\n")
			if len(all) == 0 {
				return ""
			}
			if len(all) >= 2 {
				if openMatch := fencedCodeOpenRe.FindStringSubmatch(all[len(all)-2]); openMatch != nil {
					if closeMatch := fencedCodeCloseRe.FindStringSubmatch(all[len(all)-1]); closeMatch != nil &&
						closeMatch[1][0] == openMatch[1][0] && len(closeMatch[1]) >= len(openMatch[1]) {
						return ""
					}
				}
			}
			if openMatch := fencedCodeOpenRe.FindStringSubmatch(all[len(all)-1]); openMatch != nil {
				return openMatch[1]
			}
			return ""
		}
		// Walk back to the opening fence line immediately preceding the body.
		firstBody := lines.At(0).Start
		start := bytes.LastIndexByte(source[:firstBody], '\n')
		if start > 0 {
			start = bytes.LastIndexByte(source[:start], '\n') + 1
		} else {
			start = 0
		}
		block := markdown[start:]
		splitLines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(block, "\r\n", "\n"), "\r", "\n"), "\n")
		if len(splitLines) == 0 {
			return ""
		}
		m := fencedCodeOpenRe.FindStringSubmatch(splitLines[0])
		if m == nil {
			return ""
		}
		fence := m[1]
		// Strip trailing blank lines that came after the fence block.
		endIdx := len(splitLines) - 1
		for endIdx > 0 && splitLines[endIdx] == "" {
			endIdx--
		}
		if endIdx > 0 {
			if closeMatch := fencedCodeCloseRe.FindStringSubmatch(splitLines[endIdx]); closeMatch != nil {
				closing := closeMatch[1]
				if closing[0] == fence[0] && len(closing) >= len(fence) {
					return ""
				}
			}
		}
		return fence
	case ast.KindHTMLBlock:
		lines := last.Lines()
		if lines.Len() == 0 {
			return ""
		}
		var raw bytes.Buffer
		for i := 0; i < lines.Len(); i++ {
			seg := lines.At(i)
			raw.Write(seg.Value(source))
		}
		block := raw.String()
		if m := unclosedHTMLOpenRe.FindStringSubmatch(block); m != nil {
			tag := m[1]
			if !strings.Contains(strings.ToLower(block), "</"+strings.ToLower(tag)+">") {
				return "</" + tag + ">"
			}
			return ""
		}
		if strings.HasPrefix(strings.TrimLeft(block, " "), "<!--") && !strings.Contains(block, "-->") {
			return "-->"
		}
	}
	return ""
}

// appendGeneratedImageEmbeds appends Markdown image embeds for each saved image
// path not already shown as an image in text.
func appendGeneratedImageEmbeds(markdown string, savedPaths []string) string {
	if len(savedPaths) == 0 {
		return markdown
	}
	shown := map[string]bool{}
	for _, src := range markdownImageSources(markdown) {
		addImageComparisonKeys(shown, src)
	}
	var missing []string
	seenMissing := map[string]bool{}
	for _, raw := range savedPaths {
		path := strings.TrimSpace(raw)
		if path == "" {
			continue
		}
		key := imageComparisonKey(path, false)
		if key == "" || shown[key] || seenMissing[key] {
			continue
		}
		if filepath.IsAbs(key) {
			if resolved, err := filepath.EvalSymlinks(filepath.FromSlash(key)); err == nil {
				rk := imageComparisonKey(resolved, false)
				if shown[rk] || seenMissing[rk] {
					continue
				}
				seenMissing[rk] = true
			}
		}
		seenMissing[key] = true
		missing = append(missing, path)
	}
	if len(missing) == 0 {
		return markdown
	}
	result := markdown
	if closeBlock := unclosedTrailingMarkdownBlock(result); closeBlock != "" {
		if !strings.HasSuffix(result, "\n") && !strings.HasSuffix(result, "\r") {
			result += "\n"
		}
		result += closeBlock
	}
	for _, path := range missing {
		if result != "" {
			result += "\n\n"
		}
		result += formatGeneratedImageEmbed(path)
	}
	return result
}

func safeAssetSegment(raw, fallback string) string {
	var b strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
			if b.Len() >= 48 {
				break
			}
		}
	}
	if b.Len() == 0 {
		return fallback
	}
	return b.String()
}

func decodeBase64Image(raw string) ([]byte, string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, "", false
	}
	if header, payload, ok := strings.Cut(s, ","); ok && strings.HasPrefix(strings.ToLower(header), "data:image/") && strings.HasSuffix(strings.ToLower(header), ";base64") {
		s = payload
	}
	// Strip whitespace/line wraps that some providers emit in base64 payloads.
	var compact strings.Builder
	compact.Grow(len(s))
	for _, r := range s {
		if !unicode.IsSpace(r) {
			compact.WriteRune(r)
		}
	}
	s = compact.String()
	if s == "" || len(s) > base64.StdEncoding.EncodedLen(maxGeneratedImageBytes)+4 {
		return nil, "", false
	}
	var data []byte
	var err error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		data, err = enc.DecodeString(s)
		if err == nil {
			break
		}
	}
	if err != nil || len(data) == 0 || len(data) > maxGeneratedImageBytes {
		return nil, "", false
	}
	mimeType := http.DetectContentType(data)
	if _, ok := rasterImageExt(mimeType); !ok {
		return nil, "", false
	}
	return data, mimeType, true
}

// materializeBase64Image validates and stores a base64 raster image inside the
// session's managed generated-images directory so it can be previewed safely
// without bloating Run JSON with inline base64 payloads.
func materializeBase64Image(assetsDir, runID, key, encoded string, budget *turnImageBudget) (model.ImageFile, bool) {
	if assetsDir == "" || runID == "" || strings.TrimSpace(encoded) == "" {
		return model.ImageFile{}, false
	}
	if budget != nil && budget.count >= maxTurnGeneratedImages {
		return model.ImageFile{}, false
	}
	data, mimeType, ok := decodeBase64Image(encoded)
	if !ok {
		return model.ImageFile{}, false
	}
	if budget != nil && budget.bytes+len(data) > maxTurnGeneratedImageBytes {
		return model.ImageFile{}, false
	}
	ext, ok := rasterImageExt(mimeType)
	if !ok {
		return model.ImageFile{}, false
	}
	digest := sha256.Sum256(data)
	prefix := safeAssetSegment(key, "image")
	name := fmt.Sprintf("%s-%s%s", prefix, hex.EncodeToString(digest[:6]), ext)
	dir := filepath.Join(assetsDir, "generated-images", safeAssetSegment(runID, "run"))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return model.ImageFile{}, false
	}
	target := filepath.Join(dir, name)
	if _, err := os.Stat(target); err != nil {
		tmp, err := os.CreateTemp(dir, ".img-*")
		if err != nil {
			return model.ImageFile{}, false
		}
		tmpName := tmp.Name()
		_, writeErr := tmp.Write(data)
		closeErr := tmp.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(tmpName)
			return model.ImageFile{}, false
		}
		if err := os.Chmod(tmpName, 0600); err != nil {
			_ = os.Remove(tmpName)
			return model.ImageFile{}, false
		}
		if err := os.Rename(tmpName, target); err != nil {
			_ = os.Remove(tmpName)
			return model.ImageFile{}, false
		}
	}
	if budget != nil {
		budget.count++
		budget.bytes += len(data)
	}
	return model.ImageFile{Path: target, Name: name}, true
}

func appendUniqueImageFile(dst []model.ImageFile, img model.ImageFile) []model.ImageFile {
	if strings.TrimSpace(img.Path) == "" {
		return dst
	}
	key := imageComparisonKey(img.Path, false)
	for _, existing := range dst {
		if imageComparisonKey(existing.Path, false) == key {
			return dst
		}
	}
	if img.Name == "" {
		img.Name = filepath.Base(img.Path)
	}
	return append(dst, img)
}

// extractToolOutputImages walks structured tool results (MCP, Codex dynamic tools,
// Claude tool_result, Pi tool_execution_end, ACP rawOutput), persists embedded
// base64 raster images to managed session storage, and returns both the
// extracted ImageFiles and a sanitized copy with base64 payloads stripped.
func extractToolOutputImages(assetsDir, runID, toolID, cwd string, value any, budget *turnImageBudget) ([]model.ImageFile, any) {
	if value == nil {
		return nil, nil
	}
	var images []model.ImageFile
	seq := 0
	var walk func(v any, depth int) any
	walk = func(v any, depth int) any {
		if depth > 12 || v == nil {
			return v
		}
		switch typed := v.(type) {
		case []any:
			out := make([]any, len(typed))
			for i, entry := range typed {
				out[i] = walk(entry, depth+1)
			}
			return out
		case map[string]any:
			kind := strings.ToLower(str(typed["type"]))
			switch kind {
			case "image":
				var encoded string
				if raw := str(typed["data"]); raw != "" {
					encoded = raw
				} else if src := obj(typed["source"]); src != nil && strings.EqualFold(str(src["type"]), "base64") {
					encoded = str(src["data"])
				}
				if encoded != "" {
					seq++
					key := fmt.Sprintf("%s-%d", safeAssetSegment(toolID, "tool"), seq)
					if img, ok := materializeBase64Image(assetsDir, runID, key, encoded, budget); ok {
						images = appendUniqueImageFile(images, img)
						return object{"type": "image", "name": img.Name, "path": img.Path}
					}
					return object{"type": "image", "omitted": true}
				}
				if uri := str(typed["uri"]); uri != "" {
					if path := normalizeLocalImagePath(uri, cwd); path != "" {
						images = appendUniqueImageFile(images, model.ImageFile{Path: path, Name: filepath.Base(path)})
					}
				}
			case "inputimage", "input_image":
				rawURL := str(typed["imageUrl"])
				if rawURL == "" {
					rawURL = str(typed["image_url"])
				}
				if strings.HasPrefix(strings.ToLower(strings.TrimSpace(rawURL)), "data:image/") {
					seq++
					key := fmt.Sprintf("%s-%d", safeAssetSegment(toolID, "tool"), seq)
					if img, ok := materializeBase64Image(assetsDir, runID, key, rawURL, budget); ok {
						images = appendUniqueImageFile(images, img)
						return object{"type": "image", "name": img.Name, "path": img.Path}
					}
					return object{"type": "image", "omitted": true}
				}
				if path := normalizeLocalImagePath(rawURL, cwd); path != "" {
					images = appendUniqueImageFile(images, model.ImageFile{Path: path, Name: filepath.Base(path)})
				}
			}
			out := make(map[string]any, len(typed))
			for k, val := range typed {
				if k == "blob" && strings.HasPrefix(strings.ToLower(str(typed["mimeType"])), "image/") {
					if raw, ok := val.(string); ok && raw != "" {
						seq++
						key := fmt.Sprintf("%s-%d", safeAssetSegment(toolID, "tool"), seq)
						if img, ok := materializeBase64Image(assetsDir, runID, key, raw, budget); ok {
							images = appendUniqueImageFile(images, img)
							out["name"] = img.Name
							out["path"] = img.Path
							continue
						}
						out["omitted"] = true
						continue
					}
				}
				out[k] = walk(val, depth+1)
			}
			return out
		default:
			return v
		}
	}
	sanitized := walk(value, 0)
	return images, sanitized
}

func existingRegularImageFile(path string) bool {
	if path == "" || !isPreviewImageExt(path) {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && info.Size() <= 32<<20
}

// extractExistingImagePaths finds local image paths referenced in a subagent
// report (Markdown links/embeds, inline code spans, or bare paths) and keeps
// only paths that resolve to existing regular image files on disk.
func extractExistingImagePaths(report, cwd string) []model.ImageFile {
	if strings.TrimSpace(report) == "" {
		return nil
	}
	var candidates []string
	var rendered bytes.Buffer
	if err := generatedImageMarkdown.Convert([]byte(report), &rendered); err == nil {
		tokens := html.NewTokenizer(&rendered)
		for kind := tokens.Next(); kind != html.ErrorToken; kind = tokens.Next() {
			if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
				continue
			}
			token := tokens.Token()
			var key string
			switch token.Data {
			case "img":
				key = "src"
			case "a":
				key = "href"
			case "source":
				key = "srcset"
			default:
				continue
			}
			for _, attr := range token.Attr {
				if attr.Key == key && strings.TrimSpace(attr.Val) != "" {
					candidates = append(candidates, attr.Val)
				}
			}
		}
	}
	for _, m := range backtickSpanRe.FindAllStringSubmatch(report, -1) {
		candidates = append(candidates, m[1])
	}
	for _, m := range inlineImagePathRe.FindAllString(report, -1) {
		candidates = append(candidates, strings.TrimRight(m, ".,;:!?)]"))
	}
	var out []model.ImageFile
	for _, raw := range candidates {
		path := normalizeLocalImagePath(raw, cwd)
		if existingRegularImageFile(path) {
			out = appendUniqueImageFile(out, model.ImageFile{Path: path, Name: filepath.Base(path)})
		}
	}
	return out
}
