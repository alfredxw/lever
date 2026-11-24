package app

import (
	"context"
	"slices"

	"lever/internal/model"
	"lever/internal/terminal"
	"lever/internal/workspace"
)

// StartWorktreeSetup starts the exact command the user saw in the creation
// dialog. The setup terminal is keyed by a worktree rather than a Topic.
func (a *App) StartWorktreeSetup(ctx context.Context, key terminal.Key, path, command string) error {
	owner, err := a.agentWorktreeOwner(ctx, a.Store.DB, key.Agent)
	if err != nil {
		return err
	}
	return a.startWorktreeSetupForOwner(ctx, owner, key, path, command)
}

func (a *App) startWorktreeSetupForOwner(ctx context.Context, owner worktreeOwner, key terminal.Key, path, command string) error {
	if !copyID.MatchString(key.Worktree) || !copyID.MatchString(key.ID) || command == "" {
		return invalid("Invalid worktree setup request")
	}
	a.mu.Lock()
	var release func()
	defer func() {
		a.mu.Unlock()
		if release != nil {
			release()
		}
	}()
	if a.closed {
		return conflict("Backend is shutting down")
	}
	checkout, err := getCheckoutForOwner(ctx, a.Store.DB, owner, key.Worktree)
	if err != nil {
		return err
	}
	if checkout.Path != path || checkout.Base == "" {
		return invalid("Setup requires a worktree created by Lever")
	}
	if !checkout.Ready {
		return conflict("The worktree is unavailable")
	}
	if a.Terminals.Knows(key) {
		return nil
	}
	if owner.archived || owner.worktreeSetup[checkout.GitDir] != command {
		return conflict("The configured worktree setup command has changed")
	}
	if !slices.ContainsFunc(owner.scope.Roots, func(root model.Root) bool {
		if !workspace.Contains(checkout.Source, root.Path) {
			return false
		}
		actual, err := workspace.CheckoutRoot(ctx, root.Path)
		if err != nil || actual != checkout.Source {
			return false
		}
		repo, err := workspace.GitDir(ctx, actual)
		return err == nil && repo == checkout.GitDir
	}) {
		return conflict("The repository is no longer in the Agent Scope")
	}
	scope := model.Scope{Roots: []model.Root{{Path: checkout.Path}}}
	if err := a.checkRemoval(scope); err != nil {
		return err
	}
	if err := a.checkCheckoutActivity(ctx, checkout.Path); err != nil {
		return err
	}
	if err := workspace.ValidateOwnedCheckout(ctx, checkout); err != nil {
		return conflict(err.Error())
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.initializing == nil {
		a.initializing = make(map[string]bool)
	}
	a.initializing[checkout.Path] = true
	releaseScope := a.holdScope(scope)
	release = func() {
		a.mu.Lock()
		delete(a.initializing, checkout.Path)
		a.mu.Unlock()
		releaseScope()
	}
	started, err := a.Terminals.StartCommand(key, command, checkout.Path, release)
	if started {
		release = nil
	}
	return err
}
