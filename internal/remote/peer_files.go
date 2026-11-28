package remote

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
	"lever/internal/store"
	"lever/internal/workspace"
)

func (q *peerRequest) fileRoot(r *http.Request) (string, string, error) {
	a, err := store.Get[model.Agent](r.Context(), q.host.App.Store.DB, "SELECT data FROM agents WHERE id=?", r.PathValue("id"))
	if err != nil {
		return "", "", err
	}
	root, err := workspace.Root(a.Profile.Scope, r.URL.Query().Get("root"))
	if err != nil {
		return "", "", os.ErrPermission
	}
	dataDir, err := workspace.Canonical(q.host.App.Store.Dir)
	return root, dataDir, err
}
func (q *peerRequest) files(_ http.ResponseWriter, r *http.Request) (any, error) {
	root, dataDir, err := q.fileRoot(r)
	if err != nil {
		return nil, err
	}
	return workspace.PeerList(r.Context(), root, r.URL.Query().Get("path"), dataDir)
}
func (q *peerRequest) file(w http.ResponseWriter, r *http.Request) (any, error) {
	root, dataDir, err := q.fileRoot(r)
	if err != nil {
		return nil, err
	}
	query := r.URL.Query()
	if expected := query.Get("rootPath"); expected != "" && expected != root {
		return nil, &app.Error{Status: 409, Message: "Workspace changed. Reopen the file."}
	}
	if r.Method == http.MethodGet && (query.Get("raw") == "true" || query.Get("asset") == "true" || query.Get("download") == "true" || query.Get("preview") == "html") {
		return nil, servePeerAsset(w, r, root, query.Get("path"), dataDir, "")
	}
	var write *model.FileWrite
	if r.Method == http.MethodPut {
		if q.policy.readOnly {
			return nil, os.ErrPermission
		}
		write = new(model.FileWrite)
		if err = peerBody(w, r, write); err != nil {
			return nil, err
		}
	}
	file, err := workspace.PeerFile(root, r.URL.Query().Get("path"), dataDir, write)
	switch {
	case errors.Is(err, workspace.ErrFileConflict):
		return nil, &app.Error{Status: 409, Message: err.Error()}
	case errors.Is(err, workspace.ErrInvalidFile), errors.Is(err, workspace.ErrUnsupportedPreview):
		return nil, &app.Error{Status: 400, Message: err.Error()}
	}
	return file, err
}

func (q *peerRequest) runPreview(w http.ResponseWriter, r *http.Request) (any, error) {
	a := q.host.App
	agent, err := store.Get[model.Agent](r.Context(), a.Store.DB, "SELECT a.data FROM agents a JOIN runs r ON r.agent_id=a.id WHERE r.id=?", r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	kind := r.URL.Query().Get("kind")
	if kind != "image" && kind != "html" && kind != "visualization" {
		return nil, os.ErrNotExist
	}
	dataDir, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return nil, err
	}
	rawPath := r.URL.Query().Get("path")
	if root, path, err := app.WorkspacePreviewPath(rawPath, agent.Profile.Scope); err == nil {
		return nil, servePeerAsset(w, r, root, path, dataDir, kind)
	}
	if kind != "image" {
		return nil, os.ErrNotExist
	}
	root, path, err := a.RunPreviewPath(r.Context(), r.PathValue("id"), rawPath, true)
	if err != nil {
		return nil, err
	}
	full := filepath.Join(root, filepath.FromSlash(path))
	if !workspace.PeerHostImageAllowed(full) {
		return nil, os.ErrNotExist
	}
	data, mediaType, err := workspace.ReadImage(root, path)
	if err != nil {
		return nil, err
	}
	if r.URL.Query().Get("info") == "true" {
		w.Header().Set("Content-Type", "application/json")
		writeLANJSON(w, r, map[string]string{"path": full})
		return nil, nil
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	if r.URL.Query().Get("download") == "true" {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)}))
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
	return nil, nil
}

func servePeerAsset(w http.ResponseWriter, r *http.Request, root, path, dataDir, kind string) error {
	file, mediaType, err := workspace.OpenPeerAsset(root, path, dataDir)
	if err != nil {
		return err
	}
	defer file.Close()
	if (kind == "image" && !strings.HasPrefix(mediaType, "image/")) || ((kind == "html" || kind == "visualization") && mediaType != "text/html") {
		return os.ErrNotExist
	}
	if kind != "" && r.URL.Query().Get("info") == "true" {
		w.Header().Set("Content-Type", "application/json")
		writeLANJSON(w, r, map[string]string{"path": filepath.Join(root, path)})
		return nil
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Query().Get("download") == "true" || mediaType == "application/octet-stream" {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)}))
	}
	http.ServeContent(w, r, "", time.Time{}, file)
	return nil
}

func (q *peerRequest) searchFiles(_ http.ResponseWriter, r *http.Request) (any, error) {
	query := r.URL.Query()
	term, mode := query.Get("query"), query.Get("mode")
	if len(term) > 1024 || !utf8.ValidString(term) || (mode != "content" && mode != "path") {
		return nil, &app.Error{Status: 400, Message: "Invalid file search"}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	a, err := store.Get[model.Agent](ctx, q.host.App.Store.DB, "SELECT data FROM agents WHERE id=?", r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	scope := a.Profile.Scope
	if id := query.Get("root"); id != "" {
		path, err := workspace.Root(scope, id)
		if err != nil {
			return nil, os.ErrPermission
		}
		scope.Roots = []model.Root{{ID: id, Path: path}}
	}
	dataDir, err := workspace.Canonical(q.host.App.Store.Dir)
	if err != nil {
		return nil, err
	}
	return workspace.PeerSearchFiles(ctx, scope, term, mode == "content", dataDir)
}

func (q *peerRequest) changeFile(w http.ResponseWriter, r *http.Request) (any, error) {
	if q.policy.readOnly {
		return nil, os.ErrPermission
	}
	root, data, err := q.fileRoot(r)
	if err != nil {
		return nil, err
	}
	var in struct {
		RootPath    string `json:"rootPath"`
		Directory   bool   `json:"directory"`
		Operation   string `json:"operation"`
		Destination string `json:"destination"`
	}
	if err = peerBody(w, r, &in); err != nil {
		return nil, err
	}
	if root != in.RootPath {
		return nil, &app.Error{Status: 409, Message: "Workspace changed. Reopen the directory."}
	}
	path := r.URL.Query().Get("path")
	var entry model.FileEntry
	if r.Pattern == "POST /peer/v1/agents/{id}/files" {
		entry, err = workspace.PeerCreate(root, path, data, in.Directory)
	} else {
		entry, err = workspace.PeerChange(root, path, data, in.Operation, in.Destination)
	}
	if errors.Is(err, os.ErrExist) {
		return nil, &app.Error{Status: 409, Message: "Destination already exists"}
	}
	if errors.Is(err, workspace.ErrInvalidFile) {
		return nil, &app.Error{Status: 400, Message: err.Error()}
	}
	return entry, err
}
