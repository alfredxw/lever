package app

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

func getGroup(ctx context.Context, q store.Queryer, agentID, id string) (model.DirectoryGroup, error) {
	return store.Get[model.DirectoryGroup](ctx, q, "SELECT data FROM working_copies WHERE id=? AND agent_id=?", id, agentID)
}

func saveGroup(ctx context.Context, q worktreeStore, group model.DirectoryGroup) error {
	result, err := q.ExecContext(ctx, `INSERT INTO working_copies(id,agent_id,data) VALUES(?,?,?)
ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE working_copies.agent_id=excluded.agent_id`, group.ID, group.AgentID, store.JSON(group))
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		if err != nil {
			return err
		}
		return conflict("This ID already belongs to a different directory group")
	}
	return nil
}

// Scope roots below the same Git checkout are replaced together, at the same
// relative paths. Other Git and non-Git directories come from the Agent.
func scopeRepositories(ctx context.Context, scope model.Scope) ([]model.CheckoutOptions, error) {
	var repositories []model.CheckoutOptions
	for _, root := range scope.Roots {
		source, err := workspace.CheckoutRoot(ctx, root.Path)
		if errors.Is(err, workspace.ErrNotRepository) {
			continue
		}
		if err != nil {
			return nil, err
		}
		index := slices.IndexFunc(repositories, func(repo model.CheckoutOptions) bool { return repo.Source == source })
		if index >= 0 {
			repositories[index].RootIDs = append(repositories[index].RootIDs, root.ID)
			continue
		}
		gitDir, err := workspace.GitDir(ctx, source)
		if err != nil {
			return nil, err
		}
		repositories = append(repositories, model.CheckoutOptions{Source: source, GitDir: gitDir, RootIDs: []string{root.ID}})
	}
	return repositories, ctx.Err()
}

func resolveGroupScope(scope model.Scope, repositories []model.CheckoutOptions, checkouts []model.CopyCheckout) (model.Scope, error) {
	scope.Roots = slices.Clone(scope.Roots)
	for _, checkout := range checkouts {
		if checkout.ID == "" {
			return scope, conflict("A worktree in this directory group is unavailable")
		}
		index := slices.IndexFunc(repositories, func(repo model.CheckoutOptions) bool {
			return repo.Source == checkout.Source && repo.GitDir == checkout.GitDir
		})
		if index < 0 {
			return scope, conflict("The repository is no longer in the Agent Scope: " + checkout.Source)
		}
		for i, root := range scope.Roots {
			if slices.Contains(repositories[index].RootIDs, root.ID) {
				relative, err := filepath.Rel(checkout.Source, root.Path)
				if err != nil {
					return scope, err
				}
				scope.Roots[i].Path = filepath.Join(checkout.Path, relative)
			}
		}
	}
	seen := make(map[string]bool, len(scope.Roots))
	for _, root := range scope.Roots {
		if seen[root.Path] {
			return scope, conflict("Two Scope directories resolve to the same path: " + root.Path)
		}
		seen[root.Path] = true
	}
	return scope, nil
}

func projectGroup(group model.DirectoryGroup, scope model.Scope, repositories []model.CheckoutOptions, checkouts []model.CopyCheckout) model.WorkingCopy {
	resolved, err := resolveGroupScope(scope, repositories, checkouts)
	copy := model.WorkingCopy{DirectoryGroup: group, Scope: resolved, State: "ready", Checkouts: checkouts}
	if err != nil {
		copy.Error = err.Error()
		return copy
	}
	for _, checkout := range checkouts {
		if !checkout.Ready {
			copy.State = "preparing"
			if copy.Error == "" {
				copy.Error = checkout.Error
			}
		}
	}
	if copy.State == "ready" {
		if err := checkScope(copy.Scope); err != nil {
			copy.Error = err.Error()
		}
	}
	return copy
}

func groupCheckouts(group model.DirectoryGroup, catalogue map[string]model.CopyCheckout) []model.CopyCheckout {
	checkouts := make([]model.CopyCheckout, 0, len(group.WorktreeIDs))
	for _, id := range group.WorktreeIDs {
		checkouts = append(checkouts, catalogue[id])
	}
	return checkouts
}

func (a *App) WorkingCopies(ctx context.Context, agentID string) ([]model.WorkingCopy, error) {
	groups, err := store.List[model.DirectoryGroup](ctx, a.Store.DB, "SELECT data FROM working_copies WHERE agent_id=? ORDER BY rowid DESC", agentID)
	copies := make([]model.WorkingCopy, 0, len(groups))
	if err != nil || len(groups) == 0 {
		return copies, err
	}
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID)
	if err != nil {
		return nil, err
	}
	repositories, err := scopeRepositories(ctx, agent.Profile.Scope)
	if err != nil {
		return nil, err
	}
	catalogue, err := worktreeCatalogue(ctx, a.Store.DB, agentID)
	if err != nil {
		return nil, err
	}
	for _, group := range groups {
		copy := projectGroup(group, agent.Profile.Scope, repositories, groupCheckouts(group, catalogue))
		copy.Topics, err = store.List[model.CopyTopic](ctx, a.Store.DB, `
SELECT json_object('id',s.id,'chatId',s.chat_id,'title',
  CASE WHEN s.kind='main' THEN json_extract(c.data,'$.title') ELSE json_extract(s.activity,'$.title') END,
  'busy',json(CASE WHEN EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.status IN ('queued','starting','running','waiting_user','cancelling','unknown'))
  THEN 'true' ELSE 'false' END))
FROM sessions s JOIN chats c ON c.id=s.chat_id WHERE json_extract(s.data,'$.workingCopyId')=?`, group.ID)
		if err != nil {
			return nil, err
		}
		copies = append(copies, copy)
	}
	return copies, nil
}

func (a *App) selectGroup(ctx context.Context, q store.Queryer, agent model.Agent, id string) (model.WorkingCopy, error) {
	group, err := getGroup(ctx, q, agent.ID, id)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	if group.Archived {
		return model.WorkingCopy{}, conflict("The directory group is archived")
	}
	catalogue, err := worktreeCatalogue(ctx, q, agent.ID)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	repositories, err := scopeRepositories(ctx, agent.Profile.Scope)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	copy := projectGroup(group, agent.Profile.Scope, repositories, groupCheckouts(group, catalogue))
	if copy.Error != "" {
		return copy, conflict(copy.Error)
	}
	if copy.State != "ready" {
		return copy, conflict("The directory group contains a worktree that is still being prepared")
	}
	for _, checkout := range copy.Checkouts {
		if err := workspace.ValidateCheckout(ctx, checkout); err != nil {
			return copy, conflict(err.Error())
		}
	}
	return copy, nil
}

// SaveWorkingCopy registers the selected checkouts and saves their references
// in one transaction before touching Git. A partial preparation can be retried.
func (a *App) SaveWorkingCopy(ctx context.Context, agentID, id string, in model.CreateWorkingCopy) (model.WorkingCopy, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	if !copyID.MatchString(in.ID) {
		return model.WorkingCopy{}, invalid("A stable worktree request ID is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 100 || len(in.Choices) == 0 {
		return model.WorkingCopy{}, invalid("Enter a name and select at least one worktree")
	}
	editing := id != ""
	if !editing {
		id = in.ID
	}
	existing, err := getGroup(ctx, a.Store.DB, agentID, id)
	if err != nil && (editing || !errors.Is(err, sql.ErrNoRows)) {
		return model.WorkingCopy{}, err
	}
	if existing.ID != "" {
		catalogue, err := worktreeCatalogue(ctx, a.Store.DB, agentID)
		if err != nil {
			return model.WorkingCopy{}, err
		}
		checkouts := groupCheckouts(existing, catalogue)
		matches := existing.Name == name && len(checkouts) == len(in.Choices) && !slices.ContainsFunc(checkouts, func(checkout model.CopyCheckout) bool {
			return !slices.ContainsFunc(in.Choices, func(choice model.CopyChoice) bool {
				if choice.Source != checkout.Source {
					return false
				}
				if choice.Base == "" {
					return choice.Path == checkout.Path
				}
				return choice.Path == "" && choice.Base == checkout.Base && filepath.Base(filepath.Dir(checkout.Path)) == in.ID
			})
		})
		if matches {
			return a.prepareGroup(ctx, existing)
		}
		if !editing {
			return model.WorkingCopy{}, conflict("This request ID already belongs to a different directory group")
		}
	}
	options, err := a.WorkingCopyOptions(ctx, agentID, in.ID)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	if options.PrimaryRootID != in.Scope.PrimaryRootID || !slices.Equal(options.Roots, in.Scope.Roots) {
		return model.WorkingCopy{}, conflict("The Agent Scope changed; reopen the directory group editor")
	}
	group := model.DirectoryGroup{ID: id, AgentID: agentID, Name: name, Archived: existing.Archived}
	checkouts := make([]model.CopyCheckout, 0, len(in.Choices))
	seen := map[string]bool{}
	for _, choice := range in.Choices {
		if seen[choice.Source] {
			return model.WorkingCopy{}, invalid("Select one checkout per repository")
		}
		seen[choice.Source] = true
		checkout, err := planCheckout(options.Groups, choice, name)
		if err != nil {
			return model.WorkingCopy{}, err
		}
		checkouts = append(checkouts, checkout)
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		for i, checkout := range checkouts {
			saved, err := reserveCheckout(ctx, tx, agentID, checkout)
			if err != nil {
				return err
			}
			checkouts[i] = saved
			group.WorktreeIDs = append(group.WorktreeIDs, saved.ID)
		}
		if _, err := resolveGroupScope(options.Scope, options.Groups, checkouts); err != nil {
			return err
		}
		return saveGroup(ctx, tx, group)
	})
	if err != nil {
		return model.WorkingCopy{}, err
	}
	return a.prepareGroup(ctx, group)
}

func (a *App) PrepareWorkingCopy(ctx context.Context, agentID, id string) (model.WorkingCopy, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	group, err := getGroup(ctx, a.Store.DB, agentID, id)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	return a.prepareGroup(ctx, group)
}

func (a *App) prepareGroup(ctx context.Context, group model.DirectoryGroup) (model.WorkingCopy, error) {
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", group.AgentID)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	if agent.Archived {
		return model.WorkingCopy{}, conflict("Agent is archived")
	}
	catalogue, err := worktreeCatalogue(ctx, a.Store.DB, group.AgentID)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	repositories, err := scopeRepositories(ctx, agent.Profile.Scope)
	if err != nil {
		return model.WorkingCopy{}, err
	}
	checkouts := groupCheckouts(group, catalogue)
	copy := projectGroup(group, agent.Profile.Scope, repositories, checkouts)
	if copy.State == "ready" {
		return copy, nil
	}
	for i, checkout := range checkouts {
		if checkout.Ready {
			continue
		}
		if !slices.ContainsFunc(repositories, func(repo model.CheckoutOptions) bool {
			return repo.Source == checkout.Source && repo.GitDir == checkout.GitDir
		}) {
			break
		}
		saved, err := a.prepareCheckout(ctx, checkout)
		if err != nil {
			return copy, err
		}
		checkouts[i] = saved
		if !saved.Ready {
			break
		}
	}
	return projectGroup(group, agent.Profile.Scope, repositories, checkouts), nil
}

func (a *App) ArchiveWorkingCopy(ctx context.Context, agentID, id string, archived bool) (model.DirectoryGroup, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	group, err := getGroup(ctx, a.Store.DB, agentID, id)
	if err != nil {
		return group, err
	}
	group.Archived = archived
	return group, saveGroup(ctx, a.Store.DB, group)
}

func (a *App) DeleteWorkingCopy(ctx context.Context, agentID, id string) error {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	_, err := a.Store.DB.ExecContext(ctx, "DELETE FROM working_copies WHERE id=? AND agent_id=?", id, agentID)
	return err
}

// Older rows embedded both Git checkouts and a Scope. Keep the group identity
// for drafts and sessions while registering each checkout once per Agent.
func (a *App) migrateWorkingCopies(ctx context.Context) error {
	type legacyCopy struct {
		model.DirectoryGroup
		Checkouts []model.CopyCheckout
		State     string
		Error     string
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		copies, err := store.List[legacyCopy](ctx, tx, "SELECT data FROM working_copies WHERE json_type(data,'$.worktreeIds') IS NULL")
		if err != nil {
			return err
		}
		for _, copy := range copies {
			for _, checkout := range copy.Checkouts {
				if copy.State == "removed" {
					break
				}
				if checkout.Base != "" {
					checkout.Name = copy.Name
				}
				if !checkout.Ready {
					checkout.Error = copy.Error
				}
				saved, err := registerCheckout(ctx, tx, copy.AgentID, checkout)
				if err != nil {
					return err
				}
				if checkout.Base != "" && saved.Base == "" {
					checkout.ID = saved.ID
					if err := updateCheckout(ctx, tx, checkout); err != nil {
						return err
					}
				}
				copy.WorktreeIDs = append(copy.WorktreeIDs, saved.ID)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE sessions SET data=json_set(data,'$.workingCopyName',?)
WHERE json_extract(data,'$.workingCopyId')=?`, copy.Name, copy.ID); err != nil {
				return err
			}
			if copy.State == "removed" || copy.State == "removing" {
				if _, err := tx.ExecContext(ctx, "DELETE FROM working_copies WHERE id=?", copy.ID); err != nil {
					return err
				}
			} else if err := saveGroup(ctx, tx, copy.DirectoryGroup); err != nil {
				return err
			}
		}
		return nil
	})
}
