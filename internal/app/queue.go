package app

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

func (a *App) pauseQueueLocked(ctx context.Context, sessionID string) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error { return pauseQueue(tx, sessionID) })
}

func pauseQueue(tx *sql.Tx, sessionID string) error {
	if _, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.queuePaused',json('true')) WHERE id=?", sessionID); err != nil {
		return err
	}
	return store.Event(tx, model.Event{Type: "queue"})
}

func (a *App) hasActiveSessionLocked(sessionID string) bool {
	for _, e := range a.active {
		if e.session.ID == sessionID {
			return true
		}
	}
	return false
}

// advanceQueueLocked reserves one queued message before starting any runtime I/O.
// It reloads the session to respect the binding saved by the preceding run.
func (a *App) advanceQueueLocked(sessionID string) error {
	if a.closed || a.hasActiveSessionLocked(sessionID) {
		return nil
	}
	ctx := a.ctx
	var run model.Run
	var session model.Session
	var profile model.Profile
	var config model.Provider
	start := false
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		session, err = store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", sessionID)
		if err != nil {
			return err
		}
		if session.QueuePaused {
			return nil
		}
		run, err = store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE session_id=? AND status='queued' ORDER BY CASE WHEN command_id LIKE 'delegation-receipt:%' THEN 1 ELSE 0 END, sequence LIMIT 1", sessionID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		var preparing bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM personal_channel_turns WHERE run_id=? AND context_ready=0)", run.ID).Scan(&preparing); err != nil || preparing {
			return err
		}
		ready, err := dependenciesReady(ctx, tx, run.ID)
		if err != nil || !ready {
			return err
		}
		agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", session.AgentID)
		if err != nil {
			return err
		}
		if agent.Archived {
			return nil
		}
		var active int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE session_id=? AND status IN ('starting','running','waiting_user','cancelling','unknown')", sessionID).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return nil
		}
		if err := a.checkSessionScope(session); err != nil {
			return err
		}
		// Older queued messages can omit permissions. Resolve them before saving
		// the session so its own policy remains the fallback for the next run.
		run.Selection, config, err = resolveSelection(ctx, tx, run.Selection, session.Selection)
		if err != nil {
			return invalid(err.Error())
		}
		if session.NativeID == "" && session.Selection.Provider == run.Selection.Provider {
			var status string
			err := tx.QueryRow("SELECT status FROM runs WHERE session_id=? AND position IS NOT NULL AND status NOT IN ('queued','cancelled','steering','steered') ORDER BY position DESC LIMIT 1", session.ID).Scan(&status)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if status == "interrupted" || status == "unknown" {
				return conflict("This session stopped before its native identity was confirmed. Retry the stopped message or start a new Chat or topic.")
			}
		}
		if err := reserveRun(tx, &run, &session, config); err != nil {
			return err
		}
		profile = agent.Profile
		start = true
		return store.SaveRun(tx, run)
	})
	if err == nil && start {
		a.launchLocked(run, session, profile, config, nil)
	}
	return err
}

func reserveRun(tx *sql.Tx, run *model.Run, session *model.Session, config model.Provider) error {
	paused, err := store.Get[model.Run](context.Background(), tx, "SELECT data FROM runs WHERE session_id=? AND status='paused'", session.ID)
	if err == nil {
		if err := finishPausedRun(tx, paused); err != nil {
			return err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if session.Selection.Provider != run.Selection.Provider {
		session.NativeID = ""
		session.Runtime = nil
	}
	run.Handoff = session.NativeID == "" && session.SourceRunID != ""
	if session.NativeID == "" && !run.Handoff {
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM runs
WHERE session_id=? AND position IS NOT NULL AND status NOT IN ('queued','cancelled','steering','steered'))`, session.ID).Scan(&run.Handoff); err != nil {
			return err
		}
	}
	run.Status, run.Error, run.SteerRunID = "starting", "", ""
	if err := initRunSteerState(tx, run, *session, config); err != nil {
		return err
	}
	run.StartedAt = now()
	session.Selection = run.Selection
	_, err = tx.Exec("UPDATE sessions SET data=? WHERE id=?", store.JSON(session), session.ID)
	return err
}

func initRunSteerState(tx *sql.Tx, run *model.Run, session model.Session, config model.Provider) error {
	run.CanSteer, run.SteerPending = config.Type == "codex" || config.Type == "claude", false
	switch config.Type {
	case "pi":
		command := strings.Fields(runPrompt(*run))
		run.SteerPending = len(command) == 0 || command[0] != "/compact" || len(run.References)+len(run.Attachments) != 0
	case "acp", "antigravity":
		err := tx.QueryRow(`SELECT coalesce(json_extract(data,'$.capabilities.steering'),0) FROM provider_catalogs WHERE provider_id=? AND config_dir=? AND cwd=?`, config.ID, provider.ConfigurationDirectory(config), workspace.CWD(session.Scope)).Scan(&run.SteerPending)
		if errors.Is(err, sql.ErrNoRows) {
			run.SteerPending = config.Type == "antigravity" && provider.IsAntigravityCLI(config, config.Command)
		} else if err != nil {
			return err
		}
	}
	return nil
}

func (a *App) ResumeQueue(ctx context.Context, sessionID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.queuePaused',json('false')) WHERE id=?", sessionID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "queue"})
	}); err != nil {
		return err
	}
	if err := a.advanceQueueLocked(sessionID); err != nil {
		return err
	}
	if !a.hasActiveSessionLocked(sessionID) {
		a.scheduleDelegationReceiptsLocked(sessionID, true)
	}
	return nil
}

func (e *execution) checkSteer(ctx context.Context, tx *sql.Tx, current model.Run, selection model.Selection, refs []model.Reference) error {
	if slices.ContainsFunc(refs, model.Reference.RequiresMCP) {
		return conflict("Queue messages that reference Lever sources or collaborators so they get their own execution")
	}
	if e == nil || e.ctx.Err() != nil {
		return conflict("The current execution cannot accept this message. Keep it queued.")
	}
	if current.Status == "waiting_user" {
		return conflict("Answer the pending request or queue this message")
	}
	if current.Status != "starting" && current.Status != "running" {
		return conflict("The current execution cannot accept this message. Keep it queued.")
	}
	if err := requireLocalTurn(ctx, tx, current.ID, "Queue this message to keep it out of the channel reply"); err != nil {
		return err
	}
	if current.Selection.Provider != selection.Provider || current.Selection.Permission != selection.Permission {
		return conflict("Queue the message to change runtimes or permissions during an execution")
	}
	if !current.CanSteer && !current.SteerPending {
		return invalid("The current turn cannot accept steering. Queue this message instead.")
	}
	return nil
}

func (a *App) QueueAction(ctx context.Context, runID, action, target string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return conflict("Backend is shutting down")
	}
	var run model.Run
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		run, err = store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", runID)
		if err != nil {
			return err
		}
		if run.Status != "queued" {
			if action == "remove" && run.Status == "cancelled" {
				return nil
			}
			if action == "send" && run.SteerRunID != "" {
				return nil
			}
			return conflict("The message has already left the queue")
		}
		switch action {
		case "remove":
			run.Status, run.FinishedAt = "cancelled", now()
			if err := saveRunDependencies(ctx, tx, run.ID, nil); err != nil {
				return err
			}
		case "run_now":
			run.AfterRunIDs = nil
			if err := saveRunDependencies(ctx, tx, run.ID, nil); err != nil {
				return err
			}
			var headID string
			if err := tx.QueryRowContext(ctx, "SELECT id FROM runs WHERE session_id=? AND status='queued' ORDER BY sequence LIMIT 1", run.SessionID).Scan(&headID); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if headID == run.ID && !a.hasActiveSessionLocked(run.SessionID) {
				if _, err := tx.ExecContext(ctx, "UPDATE sessions SET data=json_set(data,'$.queuePaused',json('false')) WHERE id=?", run.SessionID); err != nil {
					return err
				}
			}
		case "send":
			if len(run.AfterRunIDs) > 0 {
				return conflict("Run this message now or remove its waiting tasks before steering")
			}
			if err := requireLocalTurn(ctx, tx, run.ID, "Channel messages run in queue order"); err != nil {
				return err
			}
			for _, e := range a.active {
				if e.session.ID == run.SessionID {
					if target != "" && target != e.run.ID {
						return conflict("The target turn has ended. The message is still queued.")
					}
					current, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", e.run.ID)
					if err != nil {
						return err
					}
					if run.SteerRunID == current.ID {
						return nil
					}
					selection := run.Selection
					if selection.Permission == "" {
						// Older queued messages inherit the session permission.
						selection.Permission = current.Selection.Permission
					}
					if err := e.checkSteer(ctx, tx, current, selection, run.References); err != nil {
						return err
					}
					if err := validateSkillReferences(run.References, e.profile.DisabledSkills); err != nil {
						return err
					}
					run.Delivery, run.SteerRunID = "steer", e.run.ID
					if err := saveSteerSelection(tx, run); err != nil {
						return err
					}
					break
				}
			}
			if run.SteerRunID == "" {
				return conflict("Resume the queue to start the next message")
			}
		default:
			return invalid("action must be send, remove or run_now")
		}
		return store.SaveRun(tx, run)
	})
	if err == nil && action == "send" {
		if e := a.active[run.SteerRunID]; e != nil {
			e.wakeSteer()
		}
	}
	if err == nil && (action == "run_now" || action == "remove") {
		return a.advanceQueueLocked(run.SessionID)
	}
	return err
}

func saveSteerSelection(tx *sql.Tx, run model.Run) error {
	// Save the next turn's model settings with the accepted steer. The active
	// turn keeps its own selection, and permissions can change independently.
	_, err := tx.Exec(`UPDATE sessions SET data=json_set(data,
'$.selection.model',?,'$.selection.effort',?,'$.selection.fast',json(?)) WHERE id=?`,
		run.Selection.Model, run.Selection.Effort, store.JSON(run.Selection.Fast), run.SessionID)
	return err
}

func (e *execution) SetSteerState(state provider.SteerState) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	unsupported := e.run.SteerPending && state == provider.SteerUnavailable
	e.run.CanSteer, e.run.SteerPending = state == provider.SteerReady, state == provider.SteerPending
	err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		if unsupported {
			if _, err := releaseDeferredSteers(e.ctx, tx, e.run.ID); err != nil {
				return err
			}
		}
		return store.SaveRun(tx, e.run)
	})
	if err == nil && e.run.CanSteer {
		e.wakeSteer()
	}
	return err
}

func releaseDeferredSteers(ctx context.Context, tx *sql.Tx, target string) (bool, error) {
	messages, err := store.List[model.Run](ctx, tx, "SELECT data FROM runs WHERE status='queued' AND json_extract(data,'$.steerRunId')=?", target)
	if err != nil {
		return false, err
	}
	for _, message := range messages {
		message.SteerRunID, message.Delivery = "", "queue"
		if err := store.SaveRun(tx, message); err != nil {
			return false, err
		}
	}
	return len(messages) > 0, nil
}

func (e *execution) wakeSteer() {
	select {
	case e.steers <- struct{}{}:
	default:
	}
}

func (e *execution) NextSteer() (*provider.Input, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.run.CanSteer || e.permissionChange != nil || (e.run.Status != "starting" && e.run.Status != "running") {
		return nil, nil
	}
	var run model.Run
	next := e.run
	err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		var err error
		run, err = store.Get[model.Run](e.ctx, tx, "SELECT data FROM runs WHERE status='queued' AND json_extract(data,'$.steerRunId')=? ORDER BY sequence LIMIT 1", e.run.ID)
		if err != nil {
			return err
		}
		run.Status = "steering"
		if err := store.SaveRun(tx, run); err != nil {
			return err
		}
		// Keep the user input at its actual position among streamed output.
		next.Items = append(slices.Clone(e.run.Items), model.Item{ID: run.ID, Kind: "user", Status: "running", Message: run.UserMessage()})
		// The prior delivery signal predates these new instructions.
		next.TaskCompletionRequested = false
		if e.hosted {
			input := e.providerInput(run)
			input.Selection = e.run.Selection
			if _, err := tx.Exec("INSERT INTO runtime_commands(run_id,id,kind,data) VALUES(?,?,'steer',?)", e.run.ID, run.ID, store.JSON(input)); err != nil {
				return err
			}
		}
		return store.SaveRun(tx, next)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	e.run.Items, e.run.TaskCompletionRequested = next.Items, next.TaskCompletionRequested
	input := e.providerInput(run)
	input.Selection = e.run.Selection
	return &input, nil
}

func (e *execution) Steered(id string, deliveryErr error) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	next := e.run
	next.Items = slices.Clone(e.run.Items)
	err := e.app.Store.Write(context.Background(), func(tx *sql.Tx) error {
		run, err := store.Get[model.Run](context.Background(), tx, "SELECT data FROM runs WHERE id=?", id)
		if err != nil {
			return err
		}
		if run.Status != "steering" {
			return nil
		}
		run.Status, run.FinishedAt, run.Error = "steered", now(), ""
		if deliveryErr != nil {
			run.Error = deliveryErr.Error()
		}
		rejected := errors.Is(deliveryErr, provider.ErrSteerRejected)
		if rejected {
			run.Status, run.Delivery, run.SteerRunID, run.FinishedAt = "queued", "queue", "", ""
		} else {
			run.Selection = e.run.Selection
		}
		for i, item := range next.Items {
			if item.ID != id {
				continue
			}
			if rejected {
				next.Items = append(next.Items[:i], next.Items[i+1:]...)
			} else {
				next.Items[i].Message, next.Items[i].Status = run.UserMessage(), "completed"
				if deliveryErr != nil {
					next.Items[i].Status = "unknown"
				}
			}
			break
		}
		if err := store.SaveRun(tx, run); err != nil {
			return err
		}
		return store.SaveRun(tx, next)
	})
	if err == nil {
		e.run.Items = next.Items
	}
	return err
}
