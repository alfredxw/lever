package eventstream

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"lever/internal/model"
)

type Record struct {
	ID   int64
	Type string
	Data []byte
}
type Source func(context.Context, int64, func(Record) error) error

// Consume reads complete SSE records, including multi-megabyte native turns.
func Consume(ctx context.Context, body io.Reader, emit func(Record) error) error {
	reader := bufio.NewReader(body)
	var rec Record
	for ctx.Err() == nil {
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if len(rec.Data) > 0 {
				if err = emit(rec); err != nil {
					return err
				}
			}
			rec = Record{}
		case strings.HasPrefix(line, "id:"):
			rec.ID, _ = strconv.ParseInt(strings.TrimSpace(line[3:]), 10, 64)
		case strings.HasPrefix(line, "event:"):
			rec.Type = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			if len(rec.Data) > 0 {
				rec.Data = append(rec.Data, '\n')
			}
			rec.Data = append(rec.Data, strings.TrimPrefix(line[5:], " ")...)
		}
	}
	return ctx.Err()
}

func mergeCursors(raw, local string) map[string]int64 {
	values := map[string]int64{}
	if token, ok := strings.CutPrefix(raw, "v1."); ok && len(token) < 65536 {
		b, err := base64.RawURLEncoding.DecodeString(token)
		if err == nil {
			_ = json.Unmarshal(b, &values)
		}
	} else if n, err := strconv.ParseInt(raw, 10, 64); err == nil && local != "" {
		values[local] = n
	}
	if values == nil {
		return map[string]int64{}
	}
	return values
}

// Each Owner's cursor advances independently. A reconnection never reuses
// another Owner's sequence, even when the two databases have identical IDs.
func Merge(w http.ResponseWriter, r *http.Request, local string, sources func(context.Context) map[string]Source) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	raw := r.Header.Get("Last-Event-ID")
	if raw == "" {
		raw = r.URL.Query().Get("after")
	}
	cursors := mergeCursors(raw, local)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	flush := http.NewResponseController(w)
	if flush.Flush() != nil {
		return
	}
	type incoming struct {
		node string
		rec  Record
	}
	items := make(chan incoming)
	running := map[string]context.CancelFunc{}
	refresh := func() {
		all := sources(ctx)
		for id, stop := range running {
			if all[id] == nil {
				stop()
				delete(running, id)
			}
		}
		for id, src := range all {
			if running[id] != nil {
				continue
			}
			child, stop := context.WithCancel(ctx)
			running[id] = stop
			go func(after int64) {
				for child.Err() == nil {
					err := src(child, after, func(rec Record) error {
						select {
						case <-child.Done():
							return child.Err()
						case items <- incoming{id, rec}:
							after = rec.ID
							return nil
						}
					})
					if child.Err() != nil {
						return
					}
					if err == nil {
						return
					}
					select {
					case <-child.Done():
						return
					case <-time.After(3 * time.Second):
					}
				}
			}(cursors[id])
		}
	}
	refresh()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
		case item := <-items:
			if running[item.node] == nil {
				continue
			}
			var ev model.Event
			if item.rec.Type != "reset" && json.Unmarshal(item.rec.Data, &ev) != nil {
				continue
			}
			ev.NodeID = item.node
			if item.rec.Type == "reset" {
				ev.Type = "reset"
			}
			cursors[item.node] = item.rec.ID
			cursor, _ := json.Marshal(cursors)
			data, _ := json.Marshal(ev)
			if _, err := fmt.Fprintf(w, "id: v1.%s\ndata: %s\n\n", base64.RawURLEncoding.EncodeToString(cursor), data); err != nil {
				return
			}
		}
		if flush.Flush() != nil {
			return
		}
	}
}
