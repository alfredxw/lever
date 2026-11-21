package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gorilla/websocket"

	"lever/internal/app"
	"lever/internal/terminal"
)

func terminalKey(r *http.Request, id string) terminal.Key {
	return terminal.Key{Agent: r.PathValue("id"), Conversation: r.URL.Query().Get("sessionId"), ID: id}
}

func (s *Server) closeTerminal(w http.ResponseWriter, r *http.Request) {
	var request struct {
		IDs []string `json:"ids"`
	}
	if err := read(w, r, &request); err != nil {
		respond(w, nil, err)
		return
	}
	if len(request.IDs) == 0 || len(request.IDs) > 4 {
		respond(w, nil, &app.Error{Status: 400, Message: "Invalid terminal IDs"})
		return
	}
	for _, id := range request.IDs {
		if id == "" || len(id) > 128 {
			respond(w, nil, &app.Error{Status: 400, Message: "Invalid terminal ID"})
			return
		}
	}
	for _, id := range request.IDs {
		s.App.Terminals.Terminate(terminalKey(r, id))
	}
	respond(w, map[string]bool{"closed": true}, nil)
}

func (s *Server) terminal(w http.ResponseWriter, r *http.Request) {
	// Reuse the authenticated workspace scope. Transfer its lease to the
	// PTY when a shell is created so detached jobs still protect worktrees.
	cwd, release, scopeErr := scope(r, s.App, true)
	if scopeErr != nil {
		var scoped *app.Error
		if !errors.As(scopeErr, &scoped) || scoped.Status != http.StatusConflict {
			respond(w, nil, scopeErr)
			return
		}
	}
	id := r.URL.Query().Get("terminalId")
	if id == "" || len(id) > 128 {
		if release != nil {
			release()
		}
		respond(w, nil, &app.Error{Status: 400, Message: "Invalid terminal ID"})
		return
	}
	s.terminalSocket(w, r, terminalKey(r, id), cwd, release, scopeErr, shellTerminal)
}

func providerTerminalKey(r *http.Request) terminal.Key {
	return terminal.Key{Provider: r.PathValue("id"), ID: r.PathValue("terminal")}
}

func (s *Server) startProviderTerminal(w http.ResponseWriter, r *http.Request) {
	key := providerTerminalKey(r)
	if key.ID == "" || len(key.ID) > 128 {
		respond(w, nil, &app.Error{Status: 400, Message: "Invalid terminal ID"})
		return
	}
	respond(w, map[string]bool{"started": true}, s.App.StartProviderLogin(r.Context(), key))
}

func (s *Server) providerTerminal(w http.ResponseWriter, r *http.Request) {
	home, err := os.UserHomeDir()
	if err != nil {
		respond(w, nil, err)
		return
	}
	s.terminalSocket(w, r, providerTerminalKey(r), home, nil, nil, loginTerminal)
}

func (s *Server) closeProviderTerminal(w http.ResponseWriter, r *http.Request) {
	s.App.Terminals.Terminate(providerTerminalKey(r))
	respond(w, map[string]bool{"closed": true}, nil)
}

type terminalMode int

const (
	shellTerminal terminalMode = iota
	loginTerminal
	outputTerminal
)

func (s *Server) terminalSocket(w http.ResponseWriter, r *http.Request, key terminal.Key, cwd string, release func(), scopeErr error, mode terminalMode) {
	defer func() {
		if release != nil {
			release()
		}
	}()
	query := r.URL.Query()
	cols, _ := strconv.Atoi(query.Get("cols"))
	rows, _ := strconv.Atoi(query.Get("rows"))
	if !terminal.ValidSize(cols, rows) {
		respond(w, nil, &app.Error{Status: 400, Message: "Invalid terminal size"})
		return
	}
	upgrader := websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: terminal.OutputFrameBytes,
		CheckOrigin: func(r *http.Request) bool {
			return s.allowsOrigin(r.Header.Get("Origin"))
		},
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
	session, viewer, started, err := s.App.Terminals.Attach(key, cwd, cols, rows, mode == shellTerminal && query.Get("start") == "1", release)
	if err != nil {
		kind := "error"
		if errors.Is(err, terminal.ErrBusy) {
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
	defer s.App.Terminals.Detach(key, session, viewer)
	serveTerminal(conn, session, viewer, mode == outputTerminal)
}

// An attachment reads replay and live frames from the same stream. Each
// rendered output frame returns a credit to the current connection only.
func serveTerminal(conn *websocket.Conn, session *terminal.Session, viewer *terminal.Viewer, outputOnly bool) {
	conn.SetReadLimit(64 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	})
	ctx, cancel := context.WithCancel(context.Background())
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
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
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
			terminal.Size
		}
		if json.Unmarshal(data, &message) != nil {
			return
		}
		switch message.Type {
		case "ack":
			returnCredit(credits)
		case "resize":
			if !writable || !terminal.ValidSize(message.Cols, message.Rows) || !session.ResizeFor(viewer, message.Cols, message.Rows) {
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
