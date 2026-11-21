package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"lever/internal/model"
)

type sharedEntry struct {
	model.SharedMessage
	sources    []sharedImage
	toolID     string
	toolResult bool
}

func newSharedEntry(id, role, kind, at string) sharedEntry {
	return sharedEntry{SharedMessage: model.SharedMessage{
		Item: model.Item{ID: id, Kind: kind, Status: "completed"}, Role: role, CreatedAt: at,
	}}
}

// A page is measured in prompts and replies so a large tool log cannot hide
// previous exchanges. The UI receives bounded details and lazy image IDs.
type sharedPage struct {
	entries   []sharedEntry
	remaining int
	more      bool
}

func (p *sharedPage) add(entry sharedEntry) bool {
	switch entry.Kind {
	case "text", "final", "image":
		if p.remaining == 0 {
			p.more = true
			return false
		}
		p.remaining--
	case "tool", "reasoning":
		if entry.Text != "" {
			entry.DetailIDs = []string{entry.ID}
			entry.Text = ""
		}
	}
	entry.sources = nil
	p.entries = append(p.entries, entry)
	return true
}

func (p *sharedPage) messages() []model.SharedMessage {
	slices.Reverse(p.entries)
	messages := make([]model.SharedMessage, 0, len(p.entries))
	calls := map[string]int{}
	for _, entry := range p.entries {
		if callIndex, ok := calls[entry.toolID]; entry.toolResult && ok {
			call := &messages[callIndex]
			call.DetailIDs = append(call.DetailIDs, entry.DetailIDs...)
			call.Images = append(call.Images, entry.Images...)
			call.Status = entry.Status
			continue
		}
		if entry.toolID != "" && !entry.toolResult {
			calls[entry.toolID] = len(messages)
		}
		messages = append(messages, entry.SharedMessage)
	}
	return messages
}

func sharedDetail(text string) string {
	const max = 8 << 10
	if len(text) > max {
		return text[:max] + "\n…"
	}
	return text
}

type sharedImage struct {
	path string
	data string // base64 when the runtime embedded the image
}

const maxSharedImageBytes = 16 << 20

func (entry *sharedEntry) addImage(image sharedImage) {
	if strings.HasPrefix(image.path, "file://") {
		uri, err := url.Parse(image.path)
		image.path = ""
		if err == nil && (uri.Host == "" || uri.Host == "localhost") {
			image.path = uri.Path
			if runtime.GOOS == "windows" && len(image.path) > 2 && image.path[2] == ':' {
				image.path = strings.TrimPrefix(image.path, "/")
			}
		}
	}
	if !filepath.IsAbs(image.path) {
		image.path = ""
	}
	if len(image.data) > base64.StdEncoding.EncodedLen(maxSharedImageBytes) {
		image.data = ""
	}
	if image.path == "" && image.data == "" {
		return
	}
	name := ""
	if image.path != "" {
		name = filepath.Base(image.path)
	}
	entry.Images = append(entry.Images, model.SharedImage{ID: entry.ID + ":" + strconv.Itoa(len(entry.sources)), Name: name})
	entry.sources = append(entry.sources, image)
}

func (entry *sharedEntry) addImageURL(value string) {
	if header, data, ok := strings.Cut(value, ","); ok && strings.HasPrefix(header, "data:image/") && strings.HasSuffix(header, ";base64") {
		entry.addImage(sharedImage{data: data})
	} else if strings.HasPrefix(value, "file://") {
		entry.addImage(sharedImage{path: value})
	}
}

func (image sharedImage) read() ([]byte, string, error) {
	if image.path != "" {
		if data := sharedImageFile(image.path); data != nil {
			if mediaType := sharedImageType(data); mediaType != "" {
				return data, mediaType, nil
			}
		}
	}
	if image.data != "" {
		if data, err := base64.StdEncoding.DecodeString(image.data); err == nil && len(data) <= maxSharedImageBytes {
			if mediaType := sharedImageType(data); mediaType != "" {
				return data, mediaType, nil
			}
		}
	}
	return nil, "", os.ErrNotExist
}

func sharedImageFile(path string) []byte {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxSharedImageBytes {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSharedImageBytes+1))
	if err != nil || len(data) > maxSharedImageBytes {
		return nil
	}
	return data
}

func sharedImageType(data []byte) string {
	switch mime := http.DetectContentType(data); mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
		return mime
	default:
		return ""
	}
}

const maxSharedLine = 32 << 20

// Sidebar polls only scan the end of a native transcript.
func readSharedPreviewTail(ctx context.Context, path string, visit func([]byte) bool) {
	const previewBytes = 1 << 20
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		_ = readSharedLinesBackwards(ctx, path, max(0, info.Size()-previewBytes), visit)
	}
}

// Read only as far back as needed. Image and tool records can span chunks.
func readSharedLinesBackwards(ctx context.Context, path string, floor int64, visit func([]byte) bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	return readSharedFileBackwards(ctx, f, info.Size(), floor, visit)
}

func readSharedFileBackwards(ctx context.Context, f *os.File, size, floor int64, visit func([]byte) bool) error {
	chunk := make([]byte, 64<<10)
	lineEnd := size
	visitAt := func(start int64) (bool, error) {
		if size := lineEnd - start; size > 0 && size <= maxSharedLine {
			line := make([]byte, size)
			if _, err := f.ReadAt(line, start); err != nil {
				return false, err
			}
			return visit(line), nil
		}
		return false, nil
	}
	for end := size; end > floor; {
		if err := ctx.Err(); err != nil {
			return err
		}
		start := max(floor, end-int64(len(chunk)))
		part := chunk[:end-start]
		if _, err := f.ReadAt(part, start); err != nil {
			return err
		}
		for newline := bytes.LastIndexByte(part, '\n'); newline >= 0; newline = bytes.LastIndexByte(part, '\n') {
			if lineEnd > end {
				if stop, err := visitAt(start + int64(newline) + 1); stop || err != nil {
					return err
				}
			} else if line := part[newline+1:]; len(line) > 0 && visit(line) {
				return nil
			}
			lineEnd = start + int64(newline)
			part = part[:newline]
		}
		end = start
	}
	_, err := visitAt(floor)
	return err
}
