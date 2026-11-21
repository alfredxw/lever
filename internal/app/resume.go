package app

import (
	"context"
	"database/sql"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

func (a *App) Resume(ctx context.Context, runID, nativeTurnID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return conflict("Backend is shutting down")
	}
	if nativeTurnID == "" {
		return invalid("Select the paused turn to continue")
	}
	if e := a.active[runID]; e != nil && e.recovery != nil && e.recovery.Continue &&
		e.recovery.NativeTurnID != nil && *e.recovery.NativeTurnID == nativeTurnID {
		return nil
	}
	var run model.Run
	var session model.Session
	var profile model.Profile
	var config model.Provider
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		run, err = store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		if run.Status != "paused" || run.Superseded || run.NativeTurnID == nil || *run.NativeTurnID != nativeTurnID || a.hasActiveSessionLocked(run.SessionID) {
			return conflict("This reply is no longer paused")
		}
		session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", run.SessionID)
		if err != nil {
			return err
		}
		agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", run.AgentID)
		if err != nil {
			return err
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		if err := a.checkSessionScope(session); err != nil {
			return err
		}
		config, err = configuredProvider(ctx, tx, run.Selection.Provider)
		if err != nil {
			return err
		}
		if session.NativeID == "" || session.Selection.Provider != run.Selection.Provider || !provider.SupportsTurnContinuation(config.Type) {
			return conflict("The original runtime is no longer available to continue this reply")
		}
		profile = agent.Profile
		run.Status, run.Error = "starting", ""
		run.Continued = true
		return store.SaveRun(tx, run)
	})
	if err == nil {
		a.launchLocked(run, session, profile, config, &provider.Recovery{
			NativeTurnID: run.NativeTurnID, Continue: true, SkipOutputReplay: true,
		})
	}
	return err
}
