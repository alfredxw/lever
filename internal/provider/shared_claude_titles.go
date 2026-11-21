package provider

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"os"
	"sync"
)

// A manual rename can be far behind the latest AI title. Keep both across
// appends so polling a busy, unrenamed transcript does not reread its history.
type claudeTitleSnapshot struct {
	info       os.FileInfo
	tail       []byte
	manual, ai string
}

var claudeTitleCache = struct {
	sync.Mutex
	files map[string]claudeTitleSnapshot
}{files: make(map[string]claudeTitleSnapshot)}

func sharedClaudeTitle(ctx context.Context, path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	claudeTitleCache.Lock()
	old := claudeTitleCache.files[path]
	claudeTitleCache.Unlock()
	if old.info != nil && os.SameFile(info, old.info) && old.info.Size() == info.Size() && old.info.ModTime() == info.ModTime() {
		return cmp.Or(old.manual, old.ai)
	}
	next := claudeTitleSnapshot{info: info}
	var floor int64
	if old.info != nil && os.SameFile(info, old.info) && info.Size() > old.info.Size() && bytes.HasSuffix(old.tail, []byte("\n")) {
		// Claude can rewrite trailing metadata before appending. Reuse the
		// previous prefix only if its ending bytes still match.
		check := make([]byte, len(old.tail))
		if _, err := file.ReadAt(check, old.info.Size()-int64(len(check))); err == nil && bytes.Equal(check, old.tail) {
			floor, next.manual, next.ai = old.info.Size(), old.manual, old.ai
		}
	}
	next.tail = make([]byte, min(info.Size(), 4096))
	if _, err := file.ReadAt(next.tail, info.Size()-int64(len(next.tail))); err != nil {
		return ""
	}
	var manualSeen, aiSeen bool
	err = readSharedFileBackwards(ctx, file, info.Size(), floor, func(line []byte) bool {
		if !bytes.Contains(line, []byte(`"custom-title"`)) && !bytes.Contains(line, []byte(`"ai-title"`)) {
			return false
		}
		var record struct{ Type, CustomTitle, AITitle string }
		if json.Unmarshal(line, &record) == nil {
			switch record.Type {
			case "custom-title":
				if !manualSeen {
					next.manual, manualSeen = sharedSnippet(record.CustomTitle), true
				}
			case "ai-title":
				if !aiSeen {
					next.ai, aiSeen = sharedSnippet(record.AITitle), true
				}
			}
		}
		return manualSeen && aiSeen
	})
	if err == nil {
		claudeTitleCache.Lock()
		if len(claudeTitleCache.files) >= SharedListLimit*2 && old.info == nil {
			for key := range claudeTitleCache.files {
				delete(claudeTitleCache.files, key)
				break
			}
		}
		claudeTitleCache.files[path] = next
		claudeTitleCache.Unlock()
	}
	return cmp.Or(next.manual, next.ai)
}
