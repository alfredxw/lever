package app

import (
	"database/sql"
	"log/slog"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

// StartRestartRecovery reserves old runs before the server admits new work.
// Native inspection and continuation run through the usual execution owner.
func (a *App) StartRestartRecovery() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	for _, entry := range a.restarts {
		run, session, agent, config, err := a.reserveRestart(entry)
		if err != nil {
			slog.Warn("check interrupted execution", "run", entry.ID, "error", err)
			continue
		}
		if run.ID != "" {
			a.launchLocked(run, session, agent.Profile, config, &provider.Recovery{
				NativeTurnID: run.NativeTurnID, Continue: entry.Continue,
			})
		}
	}
	a.restarts = nil
}

func (a *App) reserveRestart(entry store.RestartRun) (run model.Run, session model.Session, agent model.Agent, config model.Provider, err error) {
	err = a.Store.Write(a.ctx, func(tx *sql.Tx) error {
		previous, err := store.Get[model.Run](a.ctx, tx, "SELECT data FROM runs WHERE id=?", entry.ID)
		if err != nil {
			return err
		}
		if previous.Superseded || (previous.Status != "unknown" && !previous.ResumeAfterShutdown) ||
			(previous.NativeTurnID != nil && *previous.NativeTurnID == "") || a.hasActiveSessionLocked(previous.SessionID) {
			return nil
		}
		session, err = store.Get[model.Session](a.ctx, tx, "SELECT data FROM sessions WHERE id=?", previous.SessionID)
		if err != nil || session.NativeID == "" || session.Selection.Provider != previous.Selection.Provider {
			return err
		}
		agent, err = store.Get[model.Agent](a.ctx, tx, "SELECT data FROM agents WHERE id=?", previous.AgentID)
		if err != nil || agent.Archived {
			return err
		}
		config, err = configuredProvider(a.ctx, tx, previous.Selection.Provider)
		if err != nil || config.Type != "codex" {
			return err
		}
		run = previous
		run.Status, run.Error, run.FinishedAt = "starting", "", ""
		run.ResumeAfterShutdown = false
		return store.SaveRun(tx, run)
	})
	return run, session, agent, config, err
}
