package remote

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/app"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
	"lever/internal/workspace"
)

type browseRoot struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path,omitempty"`
}

func (h *Host) browseRoots(ctx context.Context) ([]browseRoot, error) {
	return store.List[browseRoot](ctx, h.App.Store.DB, `SELECT json_object('id',id,'name',name,'path',path) FROM remote_browse_roots ORDER BY name,id`)
}
func (h *Host) addBrowseRoot(ctx context.Context, path string) (any, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("select an absolute directory")
	}
	root, err := workspace.Canonical(path)
	if err != nil {
		return nil, err
	}
	data, err := workspace.Canonical(h.App.Store.Dir)
	if err != nil {
		return nil, err
	}
	if !workspace.PeerAllowsRoot(root, data) {
		return nil, os.ErrPermission
	}
	_, err = h.App.Store.DB.ExecContext(ctx, "INSERT INTO remote_browse_roots(id,name,path) VALUES(?,?,?) ON CONFLICT(path) DO NOTHING", p.NewID(), filepath.Base(root), root)
	return true, err
}
func (q *peerRequest) adminInfo(_ http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	a := q.host.App
	switch r.Pattern {
	case "GET /peer/v1/providers":
		items, err := a.Providers(ctx, false)
		if err != nil {
			return nil, err
		}
		type choice struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			Type      string `json:"type"`
			Available bool   `json:"available"`
		}
		out := []choice{}
		for _, v := range items {
			out = append(out, choice{v.ID, v.Name, v.Type, v.Available && v.Enabled})
		}
		return out, nil
	case "GET /peer/v1/providers/{id}/models":
		c, err := a.Catalog(ctx, r.PathValue("id"), "", false)
		if err != nil {
			return nil, err
		}
		if c == nil {
			return []model.ModelInfo{}, nil
		}
		return c.Models, nil
	case "GET /peer/v1/skills":
		agent := r.URL.Query().Get("agent")
		if agent != "" {
			if _, err := q.target(ctx, "agent", agent); err != nil {
				return nil, err
			}
		}
		items, err := a.Skills(ctx)
		if err != nil {
			return nil, err
		}
		type choice struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Selected    bool   `json:"selected,omitempty"`
		}
		out := []choice{}
		for _, s := range items {
			if s.Available {
				out = append(out, choice{s.ID, s.Name, s.Description, slices.Contains(s.AgentIDs, agent)})
			}
		}
		return out, nil
	case "GET /peer/v1/projects":
		return store.List[map[string]string](ctx, a.Store.DB, `SELECT json_object('id',id,'name',json_extract(data,'$.name')) FROM projects ORDER BY json_extract(data,'$.name')`)
	default:
		roots, err := q.host.browseRoots(ctx)
		if err != nil {
			return nil, err
		}
		if r.URL.Query().Get("root") == "" {
			for i := range roots {
				roots[i].Path = ""
			}
			return roots, nil
		}
		dataDir, err := workspace.Canonical(a.Store.Dir)
		if err != nil {
			return nil, err
		}
		for _, root := range roots {
			if root.ID == r.URL.Query().Get("root") {
				return workspace.PeerList(ctx, root.Path, r.URL.Query().Get("path"), dataDir)
			}
		}
		return nil, os.ErrPermission
	}
}

type agentEdit struct {
	SkillIDs     *[]string `json:"skillIds"`
	UpdatedAt    string    `json:"updatedAt"`
	Name         *string   `json:"name"`
	Description  *string   `json:"description"`
	Instructions *string   `json:"instructions"`
	Provider     *string   `json:"provider"`
	Model        *string   `json:"model"`
	ProjectID    *string   `json:"projectId"`
	RootID       string    `json:"rootId"`
	Directory    string    `json:"directory"`
	Archived     *bool     `json:"archived"`
}

func (q *peerRequest) saveAgent(w http.ResponseWriter, r *http.Request) (any, error) {
	var in agentEdit
	if err := peerBody(w, r, &in); err != nil {
		return nil, err
	}
	q.host.configMu.Lock()
	defer q.host.configMu.Unlock()
	ctx := r.Context()
	a := q.host.App
	policy, err := q.host.peerPolicy(ctx, q.actor)
	if err != nil || !policy.level.Allows(p.AccessAdmin) {
		return nil, os.ErrPermission
	}
	var saved model.Agent
	if id := r.PathValue("id"); id != "" {
		if _, err := q.target(ctx, "agent", id); err != nil {
			return nil, err
		}
		saved, err = store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", id)
		if err != nil {
			return nil, err
		}
		if in.UpdatedAt == "" || in.UpdatedAt != saved.UpdatedAt {
			return nil, &app.Error{Status: 409, Message: "Agent configuration changed"}
		}
	}
	data, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return nil, err
	}
	if in.ProjectID != nil && *in.ProjectID != "" {
		project, err := store.Get[model.Project](ctx, a.Store.DB, "SELECT data FROM projects WHERE id=?", *in.ProjectID)
		if err != nil {
			return nil, err
		}
		for _, root := range project.Roots {
			if !workspace.PeerAllowsRoot(root.Path, data) {
				return nil, os.ErrPermission
			}
		}
		saved.Profile.ProjectID = project.ID
	} else if in.RootID != "" {
		var base string
		if err := a.Store.DB.QueryRowContext(ctx, "SELECT path FROM remote_browse_roots WHERE id=?", in.RootID).Scan(&base); err != nil {
			return nil, err
		}
		relative := in.Directory
		if relative == "" {
			relative = "."
		}
		if !filepath.IsLocal(relative) || strings.Contains(relative, "\\") {
			return nil, os.ErrPermission
		}
		target, err := workspace.Canonical(filepath.Join(base, relative))
		if err != nil || !workspace.Contains(base, target) || !workspace.PeerAllowsRoot(target, data) {
			return nil, os.ErrPermission
		}
		saved.Profile.ProjectID = ""
		saved.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "root", Path: target}}, PrimaryRootID: "root"}
		saved.Profile.WorktreeSetup = nil
	} else if saved.ID == "" {
		return nil, &app.Error{Status: 400, Message: "Select an existing project or an allowed directory"}
	}
	if in.SkillIDs != nil {
		skills, err := a.Skills(ctx)
		if err != nil {
			return nil, err
		}
		available := map[string]string{}
		for _, s := range skills {
			if s.Available {
				available[s.ID] = s.Path
			}
		}
		paths := make([]string, 0, len(*in.SkillIDs))
		for _, id := range *in.SkillIDs {
			path, ok := available[id]
			if !ok {
				return nil, &app.Error{Status: 400, Message: "Select an installed skill"}
			}
			paths = append(paths, path)
		}
		saved.Profile.Skills = paths
	}
	if in.Name != nil {
		saved.Name = *in.Name
	}
	if in.Description != nil {
		saved.Profile.Description = *in.Description
	}
	if in.Instructions != nil {
		saved.Profile.Instructions = *in.Instructions
	}
	if in.Provider != nil {
		saved.Profile.Provider = *in.Provider
	}
	if in.Model != nil {
		saved.Profile.Model = *in.Model
	}
	if in.Archived != nil {
		saved.Archived = *in.Archived
	}
	saved, err = a.SavePeerAgent(ctx, saved, q.actor.scope)
	saved.Profile.WorktreeSetup = nil
	saved.Profile.Delegations = nil
	return saved, err
}
