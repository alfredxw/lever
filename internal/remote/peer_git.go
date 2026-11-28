package remote

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"path"
	"path/filepath"
	"slices"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

func (q *peerRequest) git(_ http.ResponseWriter, r *http.Request) (any, error) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	a, err := store.Get[model.Agent](ctx, q.host.App.Store.DB, "SELECT data FROM agents WHERE id=?", r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	dataDir, err := workspace.Canonical(q.host.App.Store.Dir)
	if err != nil {
		return nil, err
	}
	route := path.Base(r.URL.Path)
	if route == "git-roots" || route == "git-summary" {
		roots := []model.Root{}
		summaries := []model.GitRootSummary{}
		for _, root := range a.Profile.Roots {
			if !workspace.PeerAllowsRoot(root.Path, dataDir) {
				continue
			}
			if _, err := workspace.CheckoutRoot(ctx, root.Path); errors.Is(err, workspace.ErrNotRepository) {
				continue
			} else if err != nil {
				return nil, err
			}
			roots = append(roots, root)
			if route == "git-summary" {
				summary, err := workspace.GitSummary(ctx, root)
				if err != nil {
					return nil, err
				}
				summaries = append(summaries, summary)
			}
		}
		if route == "git-roots" {
			return roots, nil
		}
		return summaries, nil
	}
	params := r.URL.Query()
	root, err := workspace.Root(a.Profile.Scope, params.Get("root"))
	if err != nil || !workspace.PeerAllowsRoot(root, dataDir) {
		return nil, &app.Error{Status: 403, Message: "Directory is outside allowed roots"}
	}
	switch route {
	case "branches":
		return workspace.Branches(ctx, root)
	case "commits":
		return workspace.RecentCommits(ctx, root)
	}
	return workspace.PeerDiff(ctx, root, dataDir, params.Get("mode"), params.Get("base"), params.Get("head"), workspace.DiffOptions{Path: params.Get("path"), Full: params.Get("full") == "true", IgnoreWhitespace: params.Get("ignoreWhitespace") == "true"})
}

func (q *peerRequest) changes(_ http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	s := q.host.App.Store
	scope := q.actor.scope
	agent := r.PathValue("id")
	var runID string
	err := s.DB.QueryRowContext(ctx, `SELECT r.id FROM runs r JOIN peer_chats c ON c.chat_id=r.chat_id
		WHERE r.agent_id=?1 AND c.hub=?2 AND c.space=?3 AND (?4='' OR r.id=?4) AND (?5='' OR r.session_id=?5)
		AND (?4<>'' OR r.status IN ('completed','failed','interrupted')) ORDER BY r.sequence DESC LIMIT 1`, agent, scope.HubID, scope.SpaceID, r.URL.Query().Get("run"), r.URL.Query().Get("sessionId")).Scan(&runID)
	if errors.Is(err, sql.ErrNoRows) && r.URL.Query().Get("run") == "" {
		return model.TurnReview{Changes: []model.RunChanges{}}, nil
	}
	if err != nil {
		return nil, err
	}
	review, err := q.host.App.RunReview(ctx, agent, "", runID)
	if err != nil {
		return nil, err
	}
	a, err := store.Get[model.Agent](ctx, s.DB, "SELECT data FROM agents WHERE id=?", agent)
	if err != nil {
		return nil, err
	}
	data, err := workspace.Canonical(s.Dir)
	if err != nil {
		return nil, err
	}
	out := model.TurnReview{RunID: runID, Changes: []model.RunChanges{}}
	for _, change := range review.Changes {
		if !slices.ContainsFunc(a.Profile.Roots, func(root model.Root) bool { return root.ID == change.Root.ID && root.Path == change.Root.Path }) || !workspace.PeerAllowsRoot(change.Root.Path, data) {
			continue
		}
		files := slices.DeleteFunc(change.Files, func(f model.DiffFile) bool {
			return !filepath.IsLocal(f.Path) || !workspace.PeerAllowsPath(change.Root.Path, f.Path, data)
		})
		out.Changes = append(out.Changes, model.RunChanges{Root: model.Root{ID: change.Root.ID}, Files: files})
	}
	return out, nil
}
