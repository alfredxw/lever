package httpapi

import (
	"bytes"
	"context"
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/workspace"
)

func fileRoutes(mux *http.ServeMux, base string, resolve fileScopeResolver, protected string) {
	mux.HandleFunc("GET "+base+"/files/search", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if len(q.Get("query")) > 1024 || !utf8.ValidString(q.Get("query")) || (q.Get("mode") != "content" && q.Get("mode") != "path") {
			respond(w, nil, &app.Error{Status: 400, Message: "Expected a query up to 1024 bytes and content or path mode"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		dirs, release, err := resolve(r.WithContext(ctx), false)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		if id := q.Get("root"); id != "" {
			path, err := workspace.Root(dirs, id)
			if err != nil {
				respond(w, nil, &app.Error{Status: 400, Message: err.Error()})
				return
			}
			dirs.Roots = []model.Root{{ID: id, Path: path}}
		}
		v, err := workspace.SearchFiles(ctx, dirs, q.Get("query"), q.Get("mode") == "content")
		respond(w, v, err)
	})
	mux.HandleFunc("GET "+base+"/files", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := rootForRequest(r, resolve, r.Method != http.MethodGet && r.Method != http.MethodHead)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		v, err := workspace.List(r.Context(), root, r.URL.Query().Get("path"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST "+base+"/files", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := rootForRequest(r, resolve, r.Method != http.MethodGet && r.Method != http.MethodHead)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		var input struct {
			RootPath  string `json:"rootPath"`
			Directory bool   `json:"directory"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.RootPath != root {
			respond(w, nil, &app.Error{Status: 409, Message: "Scope changed; reopen the directory before creating"})
			return
		}
		v, err := workspace.Create(root, r.URL.Query().Get("path"), input.Directory)
		switch {
		case errors.Is(err, os.ErrExist):
			err = &app.Error{Status: 409, Message: "A file or directory with this name already exists"}
		case errors.Is(err, workspace.ErrInvalidFile):
			err = &app.Error{Status: 400, Message: err.Error()}
		case errors.Is(err, os.ErrPermission):
			err = &app.Error{Status: 403, Message: err.Error()}
		}
		respond(w, v, err)
	})
	mux.HandleFunc("GET "+base+"/file", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := rootForRequest(r, resolve, r.Method != http.MethodGet && r.Method != http.MethodHead)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		query := r.URL.Query()
		if expected := query.Get("rootPath"); expected != "" && expected != root {
			respond(w, nil, &app.Error{Status: 409, Message: "Scope changed; reopen the file before reloading"})
			return
		}
		download := query.Get("download") == "true"
		htmlPreview := query.Get("preview") == "html"
		path := query.Get("path")
		if query.Get("raw") == "true" || download || htmlPreview {
			file, mediaType, err := workspace.OpenAsset(root, path)
			if err != nil {
				respond(w, nil, err)
				return
			}
			defer file.Close()
			if htmlPreview && !download && mediaType == "text/html" {
				htmlPreviewHeaders(w, r, false)
				http.ServeContent(w, r, "", time.Time{}, file)
				return
			}
			w.Header().Set("Content-Type", mediaType)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
			w.Header().Set("Cache-Control", "no-cache")
			if download || mediaType == "application/octet-stream" {
				w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)}))
			}
			http.ServeContent(w, r, "", time.Time{}, file)
			return
		}
		if query.Get("asset") == "true" {
			serveImageAsset(w, r, root, path)
			return
		}
		v, err := workspace.Read(root, path)
		if errors.Is(err, workspace.ErrUnsupportedPreview) {
			err = &app.Error{Status: http.StatusUnsupportedMediaType, Message: err.Error()}
		}
		respond(w, v, err)
	})
	mux.HandleFunc("PUT "+base+"/file", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := rootForRequest(r, resolve, r.Method != http.MethodGet && r.Method != http.MethodHead)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		var input model.FileWrite
		// A UTF-8 byte can expand to six bytes when JSON-escaped.
		if err := readLimit(w, r, &input, 6*workspace.MaxFileBytes+4096); err != nil {
			respond(w, nil, err)
			return
		}
		if input.RootPath != root {
			respond(w, nil, &app.Error{Status: 409, Message: "Scope changed; reopen the file before saving"})
			return
		}
		v, err := workspace.Write(root, r.URL.Query().Get("path"), input.Content, input.Version)
		switch {
		case errors.Is(err, workspace.ErrInvalidFile):
			err = &app.Error{Status: 400, Message: err.Error()}
		case errors.Is(err, os.ErrPermission):
			err = &app.Error{Status: 403, Message: err.Error()}
		}
		respond(w, v, err)
	})
	mux.HandleFunc("POST "+base+"/files/operation", func(w http.ResponseWriter, r *http.Request) {
		root, release, err := rootForRequest(r, resolve, true)
		if err != nil {
			respond(w, nil, err)
			return
		}
		defer release()
		var input struct {
			RootPath    string `json:"rootPath"`
			Operation   string `json:"operation"`
			Destination string `json:"destination"`
		}
		if err := read(w, r, &input); err != nil {
			respond(w, nil, err)
			return
		}
		if input.RootPath != root {
			respond(w, nil, &app.Error{Status: 409, Message: "Scope changed; reopen the directory"})
			return
		}
		path := r.URL.Query().Get("path")
		if protected != "" && strings.EqualFold(path, protected) && (input.Operation == "move" || input.Operation == "delete") {
			respond(w, nil, &app.Error{Status: 400, Message: "SKILL.md must remain at the root of its skill directory"})
			return
		}
		entry, err := workspace.ChangeEntry(root, path, input.Operation, input.Destination)
		switch {
		case errors.Is(err, os.ErrExist):
			err = &app.Error{Status: 409, Message: "A file or directory with this name already exists"}
		case errors.Is(err, workspace.ErrInvalidFile):
			err = &app.Error{Status: 400, Message: err.Error()}
		case errors.Is(err, os.ErrPermission):
			err = &app.Error{Status: 403, Message: err.Error()}
		case errors.Is(err, os.ErrNotExist):
			err = &app.Error{Status: 404, Message: err.Error()}
		}
		respond(w, entry, err)
	})
}

func serveImageAsset(w http.ResponseWriter, r *http.Request, root, path string) {
	data, mediaType, err := workspace.ReadImage(root, path)
	if err != nil {
		if errors.Is(err, workspace.ErrInvalidFile) {
			err = &app.Error{Status: 400, Message: err.Error()}
		}
		respond(w, nil, err)
		return
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

type fileScopeResolver func(r *http.Request, write bool) (model.Scope, func(), error)

func agentFileScope(a *app.App) fileScopeResolver {
	return func(r *http.Request, write bool) (model.Scope, func(), error) {
		query := r.URL.Query()
		return a.UseScope(r.Context(), r.PathValue("id"), query.Get("sessionId"), query.Get("workingCopyId"), write)
	}
}

func scope(r *http.Request, a *app.App, hold bool) (string, func(), error) {
	return rootForRequest(r, agentFileScope(a), hold)
}

func rootForRequest(r *http.Request, resolve fileScopeResolver, write bool) (string, func(), error) {
	dirs, release, err := resolve(r, write)
	if err != nil {
		return "", nil, err
	}
	id := r.URL.Query().Get("root")
	if id == "" {
		id = dirs.PrimaryRootID
	}
	root, err := workspace.Root(dirs, id)
	if err != nil {
		release()
		return "", nil, &app.Error{Status: 400, Message: err.Error()}
	}
	return root, release, nil
}
