package httpapi

import (
	"errors"
	"net/http"
	"os"

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
	s.App.Terminals.ServeSocket(w, r, key, cwd, release, scopeErr, terminal.SocketOptions{Shell: mode == shellTerminal, OutputOnly: mode == outputTerminal, CheckOrigin: func(r *http.Request) bool { return s.allowsOrigin(r.Header.Get("Origin")) }})
}
