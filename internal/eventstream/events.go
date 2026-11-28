// Package eventstream delivers cursor-based Lever events from the authoritative store.
package eventstream

import (
	"context"
	"fmt"
	"lever/internal/model"
	"lever/internal/store"
	"net/http"
	"strconv"
	"time"
)

func Serve(w http.ResponseWriter, r *http.Request, st *store.Store, authorize func() bool, visible func(*model.Event) (bool, error)) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unavailable", 500)
		return
	}
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		cursor, _ = strconv.ParseInt(h, 10, 64)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	f.Flush()
	_ = fromStore(r.Context(), st, cursor, authorize, visible, func(rec Record) error {
		if rec.Type == "heartbeat" {
			_, err := fmt.Fprint(w, ": heartbeat\n\n")
			f.Flush()
			return err
		}
		var kind string
		if rec.Type != "" {
			kind = "event: " + rec.Type + "\n"
		}
		_, err := fmt.Fprintf(w, "id: %d\n%sdata: %s\n\n", rec.ID, kind, rec.Data)
		f.Flush()
		return err
	})
}

func Local(st *store.Store) Source {
	return func(ctx context.Context, cursor int64, emit func(Record) error) error {
		return fromStore(ctx, st, cursor, nil, nil, func(rec Record) error {
			if rec.Type == "heartbeat" {
				return nil
			}
			return emit(rec)
		})
	}
}
func fromStore(ctx context.Context, st *store.Store, cursor int64, authorize func() bool, visible func(*model.Event) (bool, error), emit func(Record) error) error {
	ch, unsubscribe := st.Subscribe()
	defer unsubscribe()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if authorize != nil && !authorize() {
			return nil
		}
		var min, max int64
		if err := st.DB.QueryRowContext(ctx, "SELECT coalesce(min(sequence),0),coalesce(max(sequence),0) FROM events").Scan(&min, &max); err != nil {
			return err
		}
		if cursor < min-1 || cursor > max {
			cursor = max
			if err := emit(Record{ID: max, Type: "reset", Data: []byte("{}")}); err != nil {
				return err
			}
		}
		events, err := st.Events(ctx, cursor)
		if err != nil {
			return err
		}
		for _, e := range events {
			cursor = e.Sequence
			if visible != nil {
				ok, err := visible(&e)
				if err != nil {
					return err
				}
				if !ok {
					continue
				}
			}
			if err := emit(Record{ID: e.Sequence, Data: []byte(store.JSON(e))}); err != nil {
				return err
			}
		}
		if len(events) == 100 {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		case <-ticker.C:
			if err := emit(Record{Type: "heartbeat"}); err != nil {
				return err
			}
		}
	}
	return ctx.Err()
}
