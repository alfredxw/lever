package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

type SocketOptions struct {
	Shell, OutputOnly bool
	CheckOrigin       func(*http.Request) bool
	Allowed           func(context.Context) bool
}

// ServeSocket attaches the existing xterm protocol to an authenticated workspace.
// A restricted viewer owns its shell for the lifetime of this connection.
func (m *Manager) ServeSocket(w http.ResponseWriter, r *http.Request, key Key, cwd string, release func(), scopeErr error, options SocketOptions) {
	defer func() {
		if release != nil {
			release()
		}
	}()
	query := r.URL.Query()
	cols, _ := strconv.Atoi(query.Get("cols"))
	rows, _ := strconv.Atoi(query.Get("rows"))
	if !ValidSize(cols, rows) {
		http.Error(w, "Invalid terminal size", http.StatusBadRequest)
		return
	}
	upgrader := websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: OutputFrameBytes,
		CheckOrigin: options.CheckOrigin,
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if scopeErr != nil {
		_ = conn.WriteJSON(map[string]any{"type": "error", "message": scopeErr.Error()})
		return
	}
	session, viewer, started, err := m.Attach(key, cwd, cols, rows, options.Shell && query.Get("start") == "1", release)
	if err != nil {
		kind := "error"
		if errors.Is(err, ErrBusy) {
			kind = "busy"
		}
		_ = conn.WriteJSON(map[string]any{"type": kind, "message": err.Error()})
		return
	}
	if session == nil {
		_ = conn.WriteJSON(map[string]string{"type": "ended"})
		return
	}
	if started {
		release = nil
	} else if release != nil {
		release()
		release = nil
	}
	defer m.Detach(key, session, viewer)
	if options.Allowed != nil {
		defer m.Terminate(key)
	}
	serveTerminal(r.Context(), conn, session, viewer, options.OutputOnly, options.Allowed)
}

// An attachment reads replay and live frames from the same stream. Each
// rendered output frame returns a credit to the current connection only.
func serveTerminal(parent context.Context, conn *websocket.Conn, session *Session, viewer *Viewer, outputOnly bool, allowed func(context.Context) bool) {
	conn.SetReadLimit(64 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	})
	ctx, cancel := context.WithCancel(parent)
	finished := make(chan struct{})
	ready := make(chan struct{})
	credits := make(chan struct{}, 8)
	for range cap(credits) {
		credits <- struct{}{}
	}
	go func() {
		defer close(finished)
		defer func() {
			select {
			case <-session.Closing:
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "terminal ended"), time.Now().Add(time.Second))
			default:
			}
			_ = conn.Close()
		}()
		size := viewer.Size
		if err := conn.WriteJSON(map[string]any{"type": "replay", "cols": size.Cols, "rows": size.Rows, "trimmed": viewer.Trimmed}); err != nil {
			return
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-session.Closing:
				return
			case <-credits:
			}
			frame, replayed := session.Next(ctx, viewer)
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if replayed {
				returnCredit(credits)
				close(ready)
				if err := conn.WriteJSON(map[string]any{"type": "ready", "cwd": session.Directory()}); err != nil {
					return
				}
				continue
			}
			if frame == nil {
				if ctx.Err() == nil {
					select {
					case <-session.Closing:
					default:
						_ = conn.WriteJSON(map[string]any{"type": "exit", "code": session.ExitCode()})
					}
				}
				return
			}
			if frame.Size != size {
				size = frame.Size
				if err := conn.WriteJSON(map[string]any{"type": "size", "cols": size.Cols, "rows": size.Rows}); err != nil {
					return
				}
			}
			if len(frame.Data) > 0 {
				if err := conn.WriteMessage(websocket.BinaryMessage, frame.Data); err != nil {
					return
				}
			} else {
				returnCredit(credits)
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if allowed != nil && !allowed(ctx) {
					_ = conn.Close()
					return
				}
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					_ = conn.Close()
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		_ = conn.Close()
		<-finished
	}()
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		writable := false
		select {
		case <-ready:
			writable = true
		default:
		}
		if kind == websocket.BinaryMessage {
			if outputOnly || !writable || !session.Input(viewer, data) {
				return
			}
			continue
		}
		var message struct {
			Type string `json:"type"`
			Size
		}
		if json.Unmarshal(data, &message) != nil {
			return
		}
		switch message.Type {
		case "ack":
			returnCredit(credits)
		case "resize":
			if !writable || !ValidSize(message.Cols, message.Rows) || !session.ResizeFor(viewer, message.Cols, message.Rows) {
				return
			}
		default:
			return
		}
	}
}

func returnCredit(credits chan struct{}) {
	select {
	case credits <- struct{}{}:
	default:
	}
}
