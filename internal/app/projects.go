package app

import (
	"context"
	"database/sql"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/terminal"
	"lever/internal/workspace"
)

type worktreeOwner struct {
	project       bool
	id            string
	scope         model.Scope
	worktreeSetup map[string]string
	archived      bool
}

func (o worktreeOwner) copyTable() string {
	if o.project {
		return "project_working_copies"
	}
	return "working_copies"
}

func (o worktreeOwner) worktreeTable() string {
	if o.project {
		return "project_worktrees"
	}
	return "worktrees"
}

func (o worktreeOwner) ownerColumn() string {
	if o.project {
		return "project_id"
	}
	return "agent_id"
}

func (a *App) agentWorktreeOwner(ctx context.Context, q store.Queryer, agentID string) (worktreeOwner, error) {
	agent, err := store.Get[model.Agent](ctx, q, "SELECT data FROM agents WHERE id=?", agentID)
	if err != nil {
		return worktreeOwner{}, err
	}
	if agent.Profile.ProjectID != "" {
		project, err := store.Get[model.Project](ctx, q, "SELECT data FROM projects WHERE id=?", agent.Profile.ProjectID)
		if err == nil {
			return worktreeOwner{
				project:       true,
				id:            project.ID,
				scope:         project.Scope,
				worktreeSetup: project.WorktreeSetup,
				archived:      agent.Archived,
			}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return worktreeOwner{}, err
		}
	}
	return worktreeOwner{
		project:       false,
		id:            agent.ID,
		scope:         agent.Profile.Scope,
		worktreeSetup: agent.Profile.WorktreeSetup,
		archived:      agent.Archived,
	}, nil
}

func (a *App) projectWorktreeOwner(ctx context.Context, q store.Queryer, projectID string) (worktreeOwner, error) {
	project, err := store.Get[model.Project](ctx, q, "SELECT data FROM projects WHERE id=?", projectID)
	if err != nil {
		return worktreeOwner{}, err
	}
	return worktreeOwner{
		project:       true,
		id:            project.ID,
		scope:         project.Scope,
		worktreeSetup: project.WorktreeSetup,
	}, nil
}

func (a *App) normalizeScopeAndSetup(scope *model.Scope, setup map[string]string) error {
	if len(scope.Roots) == 0 {
		return invalid("At least one scope directory is required")
	}
	roots := map[string]bool{}
	paths := map[string]bool{}
	for i := range scope.Roots {
		r := &scope.Roots[i]
		if strings.TrimSpace(r.Path) == "" {
			return invalid("Scope path is required")
		}
		path, err := workspace.Canonical(r.Path)
		if err != nil {
			return invalid(err.Error())
		}
		r.Path = path
		if r.ID == "" {
			r.ID = ID()
		}
		if roots[r.ID] || paths[r.Path] {
			return invalid("Duplicate scope directory")
		}
		roots[r.ID] = true
		paths[r.Path] = true
	}
	if scope.PrimaryRootID == "" {
		scope.PrimaryRootID = scope.Roots[0].ID
	}
	if !roots[scope.PrimaryRootID] {
		return invalid("Default directory must belong to scope")
	}
	if err := a.checkRemoval(*scope); err != nil {
		return err
	}
	if len(setup) > 64 {
		return invalid("Too many worktree setup commands")
	}
	for repo, command := range setup {
		command = strings.TrimSpace(command)
		if !filepath.IsAbs(repo) || len(command) > 4096 || strings.ContainsRune(command, 0) {
			return invalid("Invalid worktree setup command")
		}
		if command == "" {
			delete(setup, repo)
		} else {
			setup[repo] = command
		}
	}
	return nil
}

func cloneScope(scope model.Scope) model.Scope {
	return model.Scope{
		Roots:         slices.Clone(scope.Roots),
		PrimaryRootID: scope.PrimaryRootID,
	}
}

func cloneSetup(setup map[string]string) map[string]string {
	if len(setup) == 0 {
		return nil
	}
	return maps.Clone(setup)
}

func (a *App) Projects(ctx context.Context) ([]model.Project, error) {
	return store.List[model.Project](ctx, a.Store.DB, "SELECT data FROM projects ORDER BY json_extract(data,'$.createdAt')")
}

func (a *App) SaveProject(ctx context.Context, project model.Project) (model.Project, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	project.Name = strings.TrimSpace(project.Name)
	if project.Name == "" || len(project.Name) > 100 {
		return project, invalid("Project name is required (up to 100 characters)")
	}
	creating := project.ID == ""
	if creating {
		project.ID = ID()
		project.CreatedAt = now()
	}
	if err := a.normalizeScopeAndSetup(&project.Scope, project.WorktreeSetup); err != nil {
		return project, err
	}
	if len(project.WorktreeSetup) == 0 {
		project.WorktreeSetup = nil
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if !creating {
			old, err := store.Get[model.Project](ctx, tx, "SELECT data FROM projects WHERE id=?", project.ID)
			if err != nil {
				return err
			}
			if project.UpdatedAt != old.UpdatedAt {
				return conflict("Project changed elsewhere. Reload before saving.")
			}
			project.CreatedAt = old.CreatedAt
		}
		project.UpdatedAt = now()
		if _, err := tx.ExecContext(ctx, "INSERT INTO projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", project.ID, store.JSON(project)); err != nil {
			return err
		}
		if !creating {
			linked, err := store.List[model.Agent](ctx, tx, "SELECT data FROM agents WHERE json_extract(data,'$.profile.projectId')=?", project.ID)
			if err != nil {
				return err
			}
			for _, agent := range linked {
				agent.Profile.Scope = cloneScope(project.Scope)
				agent.Profile.WorktreeSetup = cloneSetup(project.WorktreeSetup)
				agent.UpdatedAt = now()
				if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
					return err
				}
			}
			if len(linked) > 0 {
				if err := store.Event(tx, model.Event{Type: "agents"}); err != nil {
					return err
				}
			}
		}
		return store.Event(tx, model.Event{Type: "projects"})
	})
	return project, err
}

func (a *App) DeleteProject(ctx context.Context, id string) error {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	checkouts, err := store.List[model.CopyCheckout](ctx, a.Store.DB, "SELECT data FROM project_worktrees WHERE project_id=?", id)
	if err != nil {
		return err
	}
	for _, checkout := range checkouts {
		if checkout.Base != "" {
			return conflict("Remove this project's managed worktrees before deleting it")
		}
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := store.Get[model.Project](ctx, tx, "SELECT data FROM projects WHERE id=?", id); err != nil {
			return err
		}
		linked, err := store.List[model.Agent](ctx, tx, "SELECT data FROM agents WHERE json_extract(data,'$.profile.projectId')=?", id)
		if err != nil {
			return err
		}
		for _, agent := range linked {
			agent.Profile.ProjectID = ""
			agent.UpdatedAt = now()
			if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM projects WHERE id=?", id); err != nil {
			return err
		}
		if len(linked) > 0 {
			if err := store.Event(tx, model.Event{Type: "agents"}); err != nil {
				return err
			}
		}
		return store.Event(tx, model.Event{Type: "projects"})
	})
}

func (a *App) ProjectWorkingCopies(ctx context.Context, projectID string) ([]model.WorkingCopy, error) {
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return nil, err
	}
	return a.workingCopiesForOwner(ctx, owner)
}

func (a *App) ProjectWorkingCopyOptions(ctx context.Context, projectID, id string) (model.CopyOptions, error) {
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return model.CopyOptions{}, err
	}
	return a.workingCopyOptionsForOwner(ctx, owner, id)
}

func (a *App) SaveProjectWorkingCopy(ctx context.Context, projectID, id string, in model.CreateWorkingCopy) (model.WorkingCopy, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	return a.saveWorkingCopyForOwner(ctx, owner, id, in)
}

func (a *App) PrepareProjectWorkingCopy(ctx context.Context, projectID, id string) (model.WorkingCopy, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	group, err := getGroupForOwner(ctx, a.Store.DB, owner, id)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	return a.prepareGroupForOwner(ctx, owner, group)
}

func (a *App) ArchiveProjectWorkingCopy(ctx context.Context, projectID, id string, archived bool) (model.DirectoryGroup, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return model.DirectoryGroup{}, err
	}
	group, err := getGroupForOwner(ctx, a.Store.DB, owner, id)
	if err != nil {
		return group, err
	}
	group.Archived = archived
	return group, saveGroupForOwner(ctx, a.Store.DB, owner, group)
}

func (a *App) DeleteProjectWorkingCopy(ctx context.Context, projectID, id string) error {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	_, err := a.Store.DB.ExecContext(ctx, "DELETE FROM project_working_copies WHERE id=? AND project_id=?", id, projectID)
	return err
}

func (a *App) ProjectWorktrees(ctx context.Context, projectID string) ([]model.CopyCheckout, error) {
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return nil, err
	}
	return a.worktreesForOwner(ctx, owner)
}

func (a *App) CreateProjectWorktree(ctx context.Context, projectID string, in model.CreateWorktree) (model.CopyCheckout, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return model.CopyCheckout{}, err
	}
	return a.createWorktreeForOwner(ctx, owner, in)
}

func (a *App) PrepareProjectWorktree(ctx context.Context, projectID, id string) (model.CopyCheckout, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return model.CopyCheckout{}, err
	}
	return a.prepareWorktreeForOwner(ctx, owner, id)
}

func (a *App) DeleteProjectWorktree(ctx context.Context, projectID, id string) error {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return err
	}
	return a.deleteWorktreeForOwner(ctx, owner, id)
}

func (a *App) StartProjectWorktreeSetup(ctx context.Context, projectID string, key terminal.Key, path, command string) error {
	owner, err := a.projectWorktreeOwner(ctx, a.Store.DB, projectID)
	if err != nil {
		return err
	}
	return a.startWorktreeSetupForOwner(ctx, owner, key, path, command)
}
