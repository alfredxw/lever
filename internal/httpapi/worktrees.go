package httpapi

import (
	"context"
	"net/http"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/terminal"
)

func (s *Server) workingCopyRoutes(mux *http.ServeMux, a *app.App) {
	const path = "/api/agents/{id}/working-copies"
	mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
		v, err := a.WorkingCopies(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET "+path+"/options", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		v, err := a.WorkingCopyOptions(ctx, r.PathValue("id"), r.URL.Query().Get("requestId"))
		respond(w, v, err)
	})
	saveGroup := func(w http.ResponseWriter, r *http.Request) {
		var in model.CreateWorkingCopy
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		v, err := a.SaveWorkingCopy(ctx, r.PathValue("id"), r.PathValue("copy"), in)
		respond(w, v, err)
	}
	mux.HandleFunc("POST "+path, saveGroup)
	mux.HandleFunc("PUT "+path+"/{copy}", saveGroup)
	mux.HandleFunc("POST "+path+"/{copy}/prepare", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		v, err := a.PrepareWorkingCopy(ctx, r.PathValue("id"), r.PathValue("copy"))
		respond(w, v, err)
	})
	mux.HandleFunc("PATCH "+path+"/{copy}", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Archived bool }
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.ArchiveWorkingCopy(r.Context(), r.PathValue("id"), r.PathValue("copy"), in.Archived)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE "+path+"/{copy}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, nil, a.DeleteWorkingCopy(r.Context(), r.PathValue("id"), r.PathValue("copy")))
	})

	const worktrees = "/api/agents/{id}/worktrees"
	mux.HandleFunc("GET "+worktrees, func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Worktrees(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST "+worktrees, func(w http.ResponseWriter, r *http.Request) {
		var in model.CreateWorktree
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		v, err := a.CreateWorktree(ctx, r.PathValue("id"), in)
		respond(w, v, err)
	})
	mux.HandleFunc("POST "+worktrees+"/{worktree}/prepare", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		v, err := a.PrepareWorktree(ctx, r.PathValue("id"), r.PathValue("worktree"))
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE "+worktrees+"/{worktree}", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		respond(w, nil, a.DeleteWorktree(ctx, r.PathValue("id"), r.PathValue("worktree")))
	})
	const setup = worktrees + "/{worktree}/setup/{attempt}"
	mux.HandleFunc("POST "+setup, func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Path, Command string
		}
		if err := readLimit(w, r, &input, 32<<10); err != nil {
			respond(w, nil, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		err := a.StartWorktreeSetup(ctx, worktreeTerminalKey(r), input.Path, input.Command)
		respond(w, map[string]bool{"started": true}, err)
	})
	mux.HandleFunc("GET "+setup, func(w http.ResponseWriter, r *http.Request) {
		s.terminalSocket(w, r, worktreeTerminalKey(r), "", nil, nil, outputTerminal)
	})
	mux.HandleFunc("DELETE "+setup, func(w http.ResponseWriter, r *http.Request) {
		a.Terminals.Terminate(worktreeTerminalKey(r))
		respond(w, map[string]bool{"closed": true}, nil)
	})
}

func worktreeTerminalKey(r *http.Request) terminal.Key {
	return terminal.Key{Agent: r.PathValue("id"), Worktree: r.PathValue("worktree"), ID: r.PathValue("attempt")}
}
