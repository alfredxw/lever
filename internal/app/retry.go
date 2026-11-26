package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

func canContinueInterruptedRun(run model.Run, session model.Session) bool {
	if run.Status != "failed" && run.Status != "interrupted" {
		return false
	}
	if len(run.Items) == 0 {
		return false
	}
	if session.NativeID == "" || session.Selection.Provider != run.Selection.Provider {
		return false
	}
	if name, _ := provider.Command(runPrompt(run), len(run.Attachments) != 0, len(run.References) != 0); name != "" {
		return false
	}
	return true
}

func hasLaterExecutedRun(ctx context.Context, tx *sql.Tx, sessionID string, sequence int64) (bool, error) {
	var later bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(
SELECT 1 FROM runs
WHERE session_id=? AND position>? AND status NOT IN ('queued','steering','steered','cancelled')
)`, sessionID, sequence).Scan(&later)
	return later, err
}

func (a *App) Retry(ctx context.Context, runID, commandID string) (model.Run, error) {
	if strings.TrimSpace(commandID) == "" {
		return model.Run{}, invalid("commandId is required")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return model.Run{}, conflict("Backend is shutting down")
	}
	run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", runID)
	if err != nil {
		return model.Run{}, err
	}
	if run.ContinuationCommandID == commandID {
		return run, nil
	}
	if run.Status != "failed" && run.Status != "interrupted" {
		return model.Run{}, conflict("Only failed or stopped executions can be retried")
	}
	session, err := store.Get[model.Session](ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", run.SessionID)
	if err != nil {
		return model.Run{}, err
	}
	if !run.Superseded && canContinueInterruptedRun(run, session) {
		return a.continueInterruptedLocked(ctx, runID, commandID)
	}
	// Use the stored input so the retry is independent of the current draft.
	input := model.SendInput{CommandID: commandID, ChatID: run.ChatID, Text: run.Input, Selection: &run.Selection, References: run.References, Quote: run.Quote}
	for _, file := range run.Attachments {
		input.AttachmentIDs = append(input.AttachmentIDs, file.ID)
	}
	return a.sendLocked(ctx, input, sendOrigin{retry: &run})
}

func (a *App) continueInterruptedLocked(ctx context.Context, runID, commandID string) (model.Run, error) {
	var run model.Run
	var session model.Session
	var profile model.Profile
	var config model.Provider
	fresh := false
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		run, err = store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		if run.ContinuationCommandID == commandID {
			return nil
		}
		var usedCommand bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE command_id=?)", commandID).Scan(&usedCommand); err != nil {
			return err
		}
		if usedCommand {
			return errCommandConflict
		}
		if run.Superseded {
			return conflict("This message has already been replaced")
		}
		if run.Status != "failed" && run.Status != "interrupted" {
			return conflict("Only failed or stopped executions can be retried")
		}
		if err := requireLocalTurn(ctx, tx, run.ID, "Channel messages cannot be edited or rerun in Lever"); err != nil {
			return err
		}
		if a.hasActiveSessionLocked(run.SessionID) {
			return conflict("This conversation already has an active or unresolved execution")
		}
		var active bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM runs WHERE session_id=? AND status IN ('starting','running','waiting_user','cancelling','unknown'))", run.SessionID).Scan(&active); err != nil {
			return err
		}
		if active {
			return conflict("This conversation already has an active or unresolved execution")
		}
		later, err := hasLaterExecutedRun(ctx, tx, run.SessionID, run.Sequence)
		if err != nil {
			return err
		}
		if later {
			return conflict("Only the latest failed or stopped execution in this conversation can be retried")
		}
		session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", run.SessionID)
		if err != nil {
			return err
		}
		if !canContinueInterruptedRun(run, session) {
			return conflict("This execution can no longer be continued in place")
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
		if paused, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE session_id=? AND status='paused'", session.ID); err == nil {
			if err := finishPausedRun(tx, paused); err != nil {
				return err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		profile = agent.Profile
		run.Status, run.Error, run.FinishedAt = "starting", "", ""
		run.Continued = true
		run.ContinuationCommandID = commandID
		run.ResumeAfterShutdown = false
		if err := initRunSteerState(tx, &run, session, config); err != nil {
			return err
		}
		session.QueuePaused = true
		if _, err := tx.ExecContext(ctx, "UPDATE sessions SET data=? WHERE id=?", store.JSON(session), session.ID); err != nil {
			return err
		}
		if err := store.SaveRun(tx, run); err != nil {
			return err
		}
		fresh = true
		return nil
	})
	if err != nil {
		return model.Run{}, err
	}
	if fresh {
		a.launchLocked(run, session, profile, config, &provider.Recovery{
			NativeTurnID:     run.NativeTurnID,
			Continue:         true,
			SkipOutputReplay: true,
			ResumeFailed:     true,
			ItemPrefix:       "continue-" + ID() + ":",
		})
	}
	return run, nil
}
