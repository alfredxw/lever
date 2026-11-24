package httpapi

import (
	"context"
	"net/http"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/terminal"
)

func (s *Server) projectRoutes(mux *http.ServeMux, a *app.App) {
	mux.HandleFunc("GET /api/projects", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Projects(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/projects", func(w http.ResponseWriter, r *http.Request) {
		var v model.Project
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		if v.ID != "" {
			respond(w, nil, &app.Error{Status: 400, Message: "Use PUT to edit a project"})
			return
		}
		v, err := a.SaveProject(r.Context(), v)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/projects/{id}", func(w http.ResponseWriter, r *http.Request) {
		var v model.Project
		if err := read(w, r, &v); err != nil {
			respond(w, nil, err)
			return
		}
		v.ID = r.PathValue("id")
		v, err := a.SaveProject(r.Context(), v)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/projects/{id}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"deleted": true}, a.DeleteProject(r.Context(), r.PathValue("id")))
	})

	const path = "/api/projects/{id}/working-copies"
	mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ProjectWorkingCopies(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET "+path+"/options", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		v, err := a.ProjectWorkingCopyOptions(ctx, r.PathValue("id"), r.URL.Query().Get("requestId"))
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
		v, err := a.SaveProjectWorkingCopy(ctx, r.PathValue("id"), r.PathValue("copy"), in)
		respond(w, v, err)
	}
	mux.HandleFunc("POST "+path, saveGroup)
	mux.HandleFunc("PUT "+path+"/{copy}", saveGroup)
	mux.HandleFunc("POST "+path+"/{copy}/prepare", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		v, err := a.PrepareProjectWorkingCopy(ctx, r.PathValue("id"), r.PathValue("copy"))
		respond(w, v, err)
	})
	mux.HandleFunc("PATCH "+path+"/{copy}", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Archived bool }
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.ArchiveProjectWorkingCopy(r.Context(), r.PathValue("id"), r.PathValue("copy"), in.Archived)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE "+path+"/{copy}", func(w http.ResponseWriter, r *http.Request) {
		respond(w, nil, a.DeleteProjectWorkingCopy(r.Context(), r.PathValue("id"), r.PathValue("copy")))
	})

	const worktrees = "/api/projects/{id}/worktrees"
	mux.HandleFunc("GET "+worktrees, func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ProjectWorktrees(r.Context(), r.PathValue("id"))
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
		v, err := a.CreateProjectWorktree(ctx, r.PathValue("id"), in)
		respond(w, v, err)
	})
	mux.HandleFunc("POST "+worktrees+"/{worktree}/prepare", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		v, err := a.PrepareProjectWorktree(ctx, r.PathValue("id"), r.PathValue("worktree"))
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE "+worktrees+"/{worktree}", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		respond(w, nil, a.DeleteProjectWorktree(ctx, r.PathValue("id"), r.PathValue("worktree")))
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
		err := a.StartProjectWorktreeSetup(ctx, r.PathValue("id"), projectWorktreeTerminalKey(r), input.Path, input.Command)
		respond(w, map[string]bool{"started": true}, err)
	})
	mux.HandleFunc("GET "+setup, func(w http.ResponseWriter, r *http.Request) {
		s.terminalSocket(w, r, projectWorktreeTerminalKey(r), "", nil, nil, outputTerminal)
	})
	mux.HandleFunc("DELETE "+setup, func(w http.ResponseWriter, r *http.Request) {
		a.Terminals.Terminate(projectWorktreeTerminalKey(r))
		respond(w, map[string]bool{"closed": true}, nil)
	})
}

func projectWorktreeTerminalKey(r *http.Request) terminal.Key {
	return terminal.Key{Agent: "project:" + r.PathValue("id"), Worktree: r.PathValue("worktree"), ID: r.PathValue("attempt")}
}
