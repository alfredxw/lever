package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

var copyID = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

type worktreeStore interface {
	store.Queryer
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func getCheckoutForOwner(ctx context.Context, q store.Queryer, owner worktreeOwner, id string) (model.CopyCheckout, error) {
	return store.Get[model.CopyCheckout](ctx, q, "SELECT data FROM "+owner.worktreeTable()+" WHERE "+owner.ownerColumn()+"=? AND id=?", owner.id, id)
}

func listCheckoutsForOwner(ctx context.Context, q store.Queryer, owner worktreeOwner) ([]model.CopyCheckout, error) {
	return store.List[model.CopyCheckout](ctx, q, "SELECT data FROM "+owner.worktreeTable()+" WHERE "+owner.ownerColumn()+"=? ORDER BY rowid DESC", owner.id)
}

func worktreeCatalogueForOwner(ctx context.Context, q store.Queryer, owner worktreeOwner) (map[string]model.CopyCheckout, error) {
	checkouts, err := listCheckoutsForOwner(ctx, q, owner)
	catalogue := make(map[string]model.CopyCheckout, len(checkouts))
	for _, checkout := range checkouts {
		catalogue[checkout.ID] = checkout
	}
	return catalogue, err
}

func registerCheckoutForOwner(ctx context.Context, q worktreeStore, owner worktreeOwner, checkout model.CopyCheckout) (model.CopyCheckout, error) {
	table, col := owner.worktreeTable(), owner.ownerColumn()
	existing, err := store.Get[model.CopyCheckout](ctx, q, "SELECT data FROM "+table+" WHERE "+col+"=? AND source=? AND path=?", owner.id, checkout.Source, checkout.Path)
	if !errors.Is(err, sql.ErrNoRows) {
		return existing, err
	}
	if checkout.ID == "" {
		checkout.ID = ID()
	}
	_, err = q.ExecContext(ctx, "INSERT INTO "+table+"(id,"+col+",source,path,data) VALUES(?,?,?,?,?)",
		checkout.ID, owner.id, checkout.Source, checkout.Path, store.JSON(checkout))
	return checkout, err
}

func updateCheckoutForOwner(ctx context.Context, q worktreeStore, owner worktreeOwner, checkout model.CopyCheckout) error {
	_, err := q.ExecContext(ctx, "UPDATE "+owner.worktreeTable()+" SET data=? WHERE id=?", store.JSON(checkout), checkout.ID)
	return err
}

func reserveCheckoutForOwner(ctx context.Context, q worktreeStore, owner worktreeOwner, checkout model.CopyCheckout) (model.CopyCheckout, error) {
	if checkout.Base != "" {
		var reserved bool
		if owner.project {
			err := q.QueryRowContext(ctx, `SELECT EXISTS(
SELECT 1 FROM project_worktrees WHERE path=? AND (project_id!=? OR source!=? OR COALESCE(json_extract(data,'$.base'),'')!=?)
) OR EXISTS(SELECT 1 FROM worktrees WHERE path=?)`, checkout.Path, owner.id, checkout.Source, checkout.Base, checkout.Path).Scan(&reserved)
			if err != nil {
				return checkout, err
			}
		} else {
			err := q.QueryRowContext(ctx, `SELECT EXISTS(
SELECT 1 FROM worktrees WHERE path=? AND (agent_id!=? OR source!=? OR COALESCE(json_extract(data,'$.base'),'')!=?)
) OR EXISTS(SELECT 1 FROM project_worktrees WHERE path=?)`, checkout.Path, owner.id, checkout.Source, checkout.Base, checkout.Path).Scan(&reserved)
			if err != nil {
				return checkout, err
			}
		}
		if reserved {
			return checkout, conflict("The planned worktree path is already registered")
		}
	}
	return registerCheckoutForOwner(ctx, q, owner, checkout)
}

func (a *App) worktreesForOwner(ctx context.Context, owner worktreeOwner) ([]model.CopyCheckout, error) {
	checkouts, err := listCheckoutsForOwner(ctx, a.Store.DB, owner)
	for i, checkout := range checkouts {
		if checkout.Ready {
			if path, err := workspace.Canonical(checkout.Path); err != nil || path != checkout.Path {
				checkouts[i].Error = "Worktree directory is unavailable: " + checkout.Path
			}
		}
	}
	return checkouts, err
}

func (a *App) Worktrees(ctx context.Context, agentID string) ([]model.CopyCheckout, error) {
	owner, err := a.agentWorktreeOwner(ctx, a.Store.DB, agentID)
	if err != nil {
		return nil, err
	}
	return a.worktreesForOwner(ctx, owner)
}

func (a *App) workingCopyOptionsForOwner(ctx context.Context, owner worktreeOwner, id string) (model.CopyOptions, error) {
	var options model.CopyOptions
	if !copyID.MatchString(id) {
		return options, invalid("A stable worktree request ID is required")
	}
	if owner.archived {
		return options, conflict("Agent is archived")
	}
	dir, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return options, err
	}
	options.Scope = owner.scope
	repositories, err := scopeRepositories(ctx, options.Scope)
	if err != nil {
		return options, err
	}
	catalogue, err := listCheckoutsForOwner(ctx, a.Store.DB, owner)
	if err != nil {
		return options, err
	}
	options.Groups = make([]model.CheckoutOptions, 0, len(repositories))
	for i, repo := range repositories {
		head, bases, existing, err := workspace.CheckoutOptions(ctx, repo.Source)
		if err != nil {
			return options, err
		}
		existing = slices.DeleteFunc(existing, func(item model.GitCheckout) bool { return item.Path == repo.Source })
		for j, item := range existing {
			if index := slices.IndexFunc(catalogue, func(checkout model.CopyCheckout) bool {
				return checkout.Source == repo.Source && checkout.Path == item.Path
			}); index >= 0 {
				existing[j].Name = catalogue[index].Name
			}
		}
		slot := fmt.Sprintf("%d", i+1)
		repo.Head, repo.Bases, repo.Existing = head, bases, existing
		repo.Setup = owner.worktreeSetup[repo.GitDir]
		repo.NewPath = filepath.Join(dir, "worktrees", id, slot+"-"+filepath.Base(repo.Source))
		repo.NewBranch = "lever/" + id + "-" + slot
		options.Groups = append(options.Groups, repo)
	}
	return options, nil
}

func (a *App) WorkingCopyOptions(ctx context.Context, agentID, id string) (model.CopyOptions, error) {
	owner, err := a.agentWorktreeOwner(ctx, a.Store.DB, agentID)
	if err != nil {
		return model.CopyOptions{}, err
	}
	return a.workingCopyOptionsForOwner(ctx, owner, id)
}

func planCheckout(repositories []model.CheckoutOptions, choice model.CopyChoice, name string) (model.CopyCheckout, error) {
	index := slices.IndexFunc(repositories, func(repo model.CheckoutOptions) bool { return repo.Source == choice.Source })
	if index < 0 || (choice.Base == "") == (choice.Path == "") {
		return model.CopyCheckout{}, invalid("Select one checkout or starting commit for a Scope repository")
	}
	repo := repositories[index]
	checkout := model.CopyCheckout{Source: repo.Source, GitDir: repo.GitDir}
	if choice.Base != "" {
		if !slices.ContainsFunc(repo.Bases, func(base model.GitCommit) bool { return base.Hash == choice.Base }) {
			return checkout, conflict("The starting commit changed; refresh the checkout options")
		}
		if workspace.Contains(repo.Source, repo.NewPath) {
			return checkout, invalid("The Lever data directory must be outside the repository to create its worktree")
		}
		checkout.Path, checkout.Branch, checkout.Base, checkout.Name = repo.NewPath, repo.NewBranch, choice.Base, name
	} else {
		index := slices.IndexFunc(repo.Existing, func(item model.GitCheckout) bool { return item.Path == choice.Path })
		if index < 0 {
			return checkout, invalid("Select an existing checkout from the same Git repository")
		}
		checkout.Path, checkout.Branch, checkout.Name = choice.Path, repo.Existing[index].Branch, repo.Existing[index].Name
	}
	return checkout, nil
}

func (a *App) createWorktreeForOwner(ctx context.Context, owner worktreeOwner, in model.CreateWorktree) (model.CopyCheckout, error) {
	if !copyID.MatchString(in.ID) {
		return model.CopyCheckout{}, invalid("A stable worktree request ID is required")
	}
	name := strings.TrimSpace(in.Name)
	if len(name) > 100 || (in.Choice.Base != "" && name == "") {
		return model.CopyCheckout{}, invalid("Enter a worktree name (up to 100 characters)")
	}
	options, err := a.workingCopyOptionsForOwner(ctx, owner, in.ID)
	if err != nil {
		return model.CopyCheckout{}, err
	}
	existing, err := getCheckoutForOwner(ctx, a.Store.DB, owner, in.ID)
	if err == nil {
		if existing.Source != in.Choice.Source || existing.Base != in.Choice.Base ||
			(in.Choice.Base != "" && (in.Choice.Path != "" || existing.Name != name)) ||
			(in.Choice.Base == "" && existing.Path != in.Choice.Path) {
			return existing, conflict("This request ID already belongs to a different worktree")
		}
		if !slices.ContainsFunc(options.Groups, func(repo model.CheckoutOptions) bool {
			return repo.Source == existing.Source && repo.GitDir == existing.GitDir
		}) {
			return existing, conflict("The repository is no longer in the Agent Scope")
		}
		return a.prepareCheckoutForOwner(ctx, owner, existing)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return existing, err
	}
	checkout, err := planCheckout(options.Groups, in.Choice, name)
	if err != nil {
		return checkout, err
	}
	checkout.ID = in.ID
	checkout, err = reserveCheckoutForOwner(ctx, a.Store.DB, owner, checkout)
	if err != nil {
		return checkout, err
	}
	return a.prepareCheckoutForOwner(ctx, owner, checkout)
}

func (a *App) CreateWorktree(ctx context.Context, agentID string, in model.CreateWorktree) (model.CopyCheckout, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.agentWorktreeOwner(ctx, a.Store.DB, agentID)
	if err != nil {
		return model.CopyCheckout{}, err
	}
	return a.createWorktreeForOwner(ctx, owner, in)
}

func (a *App) prepareWorktreeForOwner(ctx context.Context, owner worktreeOwner, id string) (model.CopyCheckout, error) {
	checkout, err := getCheckoutForOwner(ctx, a.Store.DB, owner, id)
	if err != nil {
		return checkout, err
	}
	if owner.archived {
		return checkout, conflict("Agent is archived")
	}
	repositories, err := scopeRepositories(ctx, owner.scope)
	if err != nil {
		return checkout, err
	}
	if !slices.ContainsFunc(repositories, func(repo model.CheckoutOptions) bool {
		return repo.Source == checkout.Source && repo.GitDir == checkout.GitDir
	}) {
		return checkout, conflict("The repository is no longer in the Agent Scope")
	}
	return a.prepareCheckoutForOwner(ctx, owner, checkout)
}

func (a *App) PrepareWorktree(ctx context.Context, agentID, id string) (model.CopyCheckout, error) {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.agentWorktreeOwner(ctx, a.Store.DB, agentID)
	if err != nil {
		return model.CopyCheckout{}, err
	}
	return a.prepareWorktreeForOwner(ctx, owner, id)
}

func (a *App) prepareCheckoutForOwner(ctx context.Context, owner worktreeOwner, checkout model.CopyCheckout) (model.CopyCheckout, error) {
	if checkout.Ready {
		return checkout, nil
	}
	if err := workspace.PrepareCheckout(ctx, checkout); err != nil {
		checkout.Error = err.Error()
	} else {
		checkout.Ready, checkout.Error = true, ""
	}
	return checkout, updateCheckoutForOwner(context.WithoutCancel(ctx), a.Store.DB, owner, checkout)
}

func (a *App) deleteWorktreeForOwner(ctx context.Context, owner worktreeOwner, id string) error {
	checkout, err := getCheckoutForOwner(ctx, a.Store.DB, owner, id)
	if err != nil {
		return err
	}
	if err := a.reserveCheckoutRemoval(ctx, checkout); err != nil {
		return err
	}
	if checkout.Base != "" {
		defer func() {
			a.mu.Lock()
			a.removingCheckout = ""
			a.mu.Unlock()
		}()
		a.closeIdleClaudeSessions()
		if err := workspace.RemoveCheckout(ctx, checkout); err != nil {
			return conflict(err.Error())
		}
	}
	_, err = a.Store.DB.ExecContext(context.WithoutCancel(ctx), "DELETE FROM "+owner.worktreeTable()+" WHERE id=?", id)
	return err
}

func (a *App) DeleteWorktree(ctx context.Context, agentID, id string) error {
	a.worktreeMu.Lock()
	defer a.worktreeMu.Unlock()
	owner, err := a.agentWorktreeOwner(ctx, a.Store.DB, agentID)
	if err != nil {
		return err
	}
	return a.deleteWorktreeForOwner(ctx, owner, id)
}

func (a *App) reserveCheckoutRemoval(ctx context.Context, checkout model.CopyCheckout) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	groups, err := store.List[model.DirectoryGroup](ctx, a.Store.DB, `
SELECT data FROM working_copies AS g WHERE EXISTS (
  SELECT 1 FROM json_each(g.data,'$.worktreeIds') AS choice
  JOIN worktrees AS w ON w.id=choice.value
  WHERE w.id=? OR (? AND w.path=?)
)
UNION ALL
SELECT data FROM project_working_copies AS g WHERE EXISTS (
  SELECT 1 FROM json_each(g.data,'$.worktreeIds') AS choice
  JOIN project_worktrees AS w ON w.id=choice.value
  WHERE w.id=? OR (? AND w.path=?)
)`, checkout.ID, checkout.Base != "", checkout.Path, checkout.ID, checkout.Base != "", checkout.Path)
	if err != nil {
		return err
	}
	if len(groups) > 0 {
		return conflict("A directory group uses this worktree: " + groups[0].Name)
	}
	if checkout.Base == "" {
		return nil
	}
	agents, err := store.List[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents")
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if slices.ContainsFunc(agent.Profile.Roots, func(root model.Root) bool { return workspace.Contains(checkout.Path, root.Path) }) {
			return conflict("An Agent Scope uses this worktree: " + agent.Name)
		}
	}
	projects, err := store.List[model.Project](ctx, a.Store.DB, "SELECT data FROM projects")
	if err != nil {
		return err
	}
	for _, project := range projects {
		if slices.ContainsFunc(project.Roots, func(root model.Root) bool { return workspace.Contains(checkout.Path, root.Path) }) {
			return conflict("A Project Scope uses this worktree: " + project.Name)
		}
	}
	if err := a.checkCheckoutActivity(ctx, checkout.Path); err != nil {
		return err
	}
	a.removingCheckout = checkout.Path
	return nil
}

// The caller holds a.mu so a send cannot be accepted while leasing a checkout.
func (a *App) checkCheckoutActivity(ctx context.Context, path string) error {
	busy, err := store.List[model.Session](ctx, a.Store.DB, `SELECT s.data FROM sessions s WHERE EXISTS
(SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.status IN ('queued','starting','running','waiting_user','cancelling','unknown'))`)
	if err != nil {
		return err
	}
	for _, session := range busy {
		if slices.ContainsFunc(session.Roots, func(root model.Root) bool { return overlap(root.Path, path) }) {
			return conflict("A conversation has active, queued or unconfirmed work in this worktree")
		}
	}
	for dir := range a.scopeUsers {
		if overlap(dir, path) {
			return conflict("A file write or terminal is using this worktree")
		}
	}
	return nil
}

func checkScope(scope model.Scope) error {
	for _, root := range scope.Roots {
		if path, err := workspace.Canonical(root.Path); err != nil || path != root.Path {
			return conflict("Working directory is unavailable: " + root.Path)
		}
	}
	return nil
}

func overlap(a, b string) bool { return workspace.Contains(a, b) || workspace.Contains(b, a) }

func (a *App) checkRemoval(scope model.Scope) error {
	for _, root := range scope.Roots {
		if a.removingCheckout != "" && overlap(root.Path, a.removingCheckout) {
			return conflict("The worktree is being removed")
		}
	}
	return nil
}

func (a *App) checkInitializing(scope model.Scope) error {
	for _, root := range scope.Roots {
		for checkout := range a.initializing {
			if overlap(root.Path, checkout) {
				return conflict("Worktree initialization is still running")
			}
		}
	}
	return nil
}

// UseScope resolves tool paths. Writes and terminals hold the scope until
// they finish so removal cannot race them; reads may observe a removal.
func (a *App) UseScope(ctx context.Context, agentID, sessionID, copyID string, hold bool) (model.Scope, func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var scope model.Scope
	if sessionID == "" {
		agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID)
		if err != nil {
			return scope, nil, err
		}
		scope = agent.Profile.Scope
		if copyID != "" {
			copy, err := a.selectGroup(ctx, a.Store.DB, agent, copyID)
			if err != nil {
				return scope, nil, err
			}
			scope = copy.Scope
		}
	} else {
		session, err := store.Get[model.Session](ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", sessionID)
		if err != nil {
			return scope, nil, err
		}
		if session.AgentID != agentID {
			return scope, nil, invalid("Session must belong to this Agent")
		}
		if err := a.checkSessionScope(session); err != nil {
			return scope, nil, err
		}
		scope = session.Scope
	}
	if err := a.checkRemoval(scope); err != nil {
		return scope, nil, err
	}
	if !hold {
		return scope, func() {}, nil
	}
	if err := a.checkInitializing(scope); err != nil {
		return scope, nil, err
	}
	return scope, a.holdScope(scope), nil
}

// The caller holds a.mu and transfers the returned lease to its operation.
func (a *App) holdScope(scope model.Scope) func() {
	if a.scopeUsers == nil {
		a.scopeUsers = map[string]int{}
	}
	for _, root := range scope.Roots {
		a.scopeUsers[root.Path]++
	}
	return func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		for _, root := range scope.Roots {
			a.scopeUsers[root.Path]--
			if a.scopeUsers[root.Path] == 0 {
				delete(a.scopeUsers, root.Path)
			}
		}
	}
}

func (a *App) checkSessionScope(session model.Session) error {
	if err := a.checkRemoval(session.Scope); err != nil {
		return err
	}
	if err := a.checkInitializing(session.Scope); err != nil {
		return err
	}
	return checkScope(session.Scope)
}
