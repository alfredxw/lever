package app

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

type execution struct {
	app               *App
	ctx               context.Context
	cancel            context.CancelFunc
	runtimeCtx        context.Context
	interrupt         context.CancelCauseFunc
	mu                sync.Mutex
	run               model.Run
	session           model.Session
	profile           model.Profile
	provider          model.Provider
	recovery          *provider.Recovery
	hosted            bool
	pendingPermission *hostPermission
	skills            provider.SkillPlan
	requests          map[string]chan model.Answer
	setPermission     func(context.Context, string) error
	permissionChange  chan struct{}
	token             string
	contextToken      string
	done              chan struct{}
	steers            chan struct{}
	dirty             bool
	delegationMu      sync.Mutex
	historyMu         sync.Mutex
	historyBytes      int
}

func (e *execution) providerInput(run model.Run) provider.Input {
	input := provider.Input{Provider: e.provider, Session: e.session, Profile: e.profile, Skills: e.skills, RunID: run.ID, Text: runPrompt(run), Assets: filepath.Join(e.app.Store.Dir, "sessions", e.session.ID), Selection: run.Selection, References: run.References, Steers: e.steers, Recovery: e.recovery}
	if run.ChannelPrompt != "" {
		input.Profile.Instructions += "\n\n" + run.ChannelPrompt
	}
	if run.Task != nil && run.Selection.Permission != "read_only" {
		input.Profile.Instructions += "\n\nThis turn is assigned a Lever task. Call complete_current_task if available when you have delivered the original assigned task. Leave it open for progress updates, unrelated follow-ups, outstanding input or work, or a review requested by the user."
	}
	for _, file := range run.Attachments {
		input.Attachments = append(input.Attachments, provider.Attachment{Attachment: file, Path: e.app.AttachmentPath(file)})
	}
	return input
}

func (e *execution) Bind(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session.NativeID != "" && e.session.NativeID != id {
		return errors.New("runtime attempted to replace a bound session")
	}
	e.session.NativeID = id
	return e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.nativeId',?) WHERE id=?", id, e.session.ID)
		return err
	})
}

func (a *App) nameConversation(run model.Run, session model.Session, config model.Provider) {
	needed, err := a.Store.NeedsConversationTitle(a.ctx, run)
	if err == nil && needed {
		if prompt := store.TitlePrompt(run); prompt != "" {
			var title string
			title, err = provider.GenerateConversationTitle(a.ctx, config, session, prompt)
			if err == nil && title != "" {
				err = a.Store.SaveConversationTitle(a.ctx, run, title)
			}
		}
	}
	if err != nil && a.ctx.Err() == nil {
		slog.Debug("conversation title unavailable", "session", session.ID, "provider", config.ID, "error", err)
	}
}

func (e *execution) BindTurn(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.run
	// Codex reports one aggregate patch per native turn. Once a goal moves
	// into another turn, the execution's before/after snapshot covers both.
	multipleTurns := run.NativeTurnID != nil && *run.NativeTurnID != "" && *run.NativeTurnID != id
	if multipleTurns {
		run.TurnDiff = nil
	}
	run.NativeTurnID = &id
	run.CanPause = id != "" && !run.Quiet && e.providerInput(run).CanPauseTurn()
	if id != "" && run.Status == "starting" {
		run.Status = "running"
	}
	if err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		if multipleTurns {
			if _, err := tx.Exec("DELETE FROM run_turn_diffs WHERE run_id=?", run.ID); err != nil {
				return err
			}
		}
		return store.SaveRun(tx, run)
	}); err != nil {
		return err
	}
	e.run.NativeTurnID, e.run.Status, e.run.TurnDiff = run.NativeTurnID, run.Status, run.TurnDiff
	e.run.CanPause = run.CanPause
	e.dirty = false
	return nil
}

func (e *execution) stop(ctx context.Context, pause bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.run.Status == "cancelling" {
		return nil
	}
	if e.recovery != nil && e.run.Status == "starting" {
		return conflict("Checking whether the previous execution has stopped")
	}
	if pause && !e.run.CanPause {
		return conflict("This reply cannot be paused")
	}
	run := e.run
	run.Status = "cancelling"
	run.PauseRequested = pause
	if err := e.app.Store.Write(ctx, func(tx *sql.Tx) error {
		if pause {
			if err := requireLocalTurn(ctx, tx, run.ID, "Channel messages cannot be paused in Lever"); err != nil {
				return err
			}
		}
		if e.hosted {
			if _, err := tx.Exec("UPDATE runtime_hosts SET stop=1 WHERE run_id=?", run.ID); err != nil {
				return err
			}
		}
		if err := pauseQueue(tx, run.SessionID); err != nil {
			return err
		}
		return store.SaveRun(tx, run)
	}); err != nil {
		return err
	}
	e.run.Status, e.run.PauseRequested = run.Status, pause
	if !e.hosted {
		if pause {
			e.interrupt(provider.ErrPauseRequested)
		} else {
			e.cancel()
		}
	}
	return nil
}

func (e *execution) Item(item model.Item) error {
	if err := e.ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range e.run.Items {
		if e.run.Items[i].ID == item.ID {
			e.run.Items[i] = item
			e.dirty = true
			return nil
		}
	}
	e.run.Items = append(e.run.Items, item)
	e.dirty = true
	return nil
}

func (e *execution) UpdateRuntime(update func(*model.SessionRuntime)) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	var state model.SessionRuntime
	if e.session.Runtime != nil {
		state = *e.session.Runtime
	}
	update(&state)
	if reflect.DeepEqual(e.session.Runtime, &state) || (e.session.Runtime == nil && state == (model.SessionRuntime{})) {
		return nil
	}
	// A native pause acknowledgement may arrive after Stop cancels the turn.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(e.ctx), 2*time.Second)
	defer cancel()
	err := e.app.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.runtime',json(?)) WHERE id=?", store.JSON(state), e.session.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "session-runtime", ChatID: e.run.ChatID, SessionID: e.session.ID})
	})
	if err == nil {
		e.session.Runtime = &state
	}
	return err
}

// Persist the payload and its lightweight chat summary together. Codex may
// publish the same aggregate more than once, including at turn completion.
func (e *execution) TurnDiff(patch string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.run
	if run.TurnDiff == nil {
		return nil
	}
	err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		row, err := tx.Exec(`INSERT INTO run_turn_diffs(run_id,patch) VALUES(?,?)
			ON CONFLICT(run_id) DO UPDATE SET patch=excluded.patch WHERE patch<>excluded.patch`, run.ID, patch)
		if err != nil {
			return err
		}
		if changed, err := row.RowsAffected(); err != nil || changed == 0 {
			return err
		}
		result, parseErr := workspace.CodexTurnDiff(patch, "")
		summary := &model.TurnPatch{Root: run.TurnDiff.Root, Reported: true, Files: result.Files}
		if parseErr != nil {
			summary.Error = parseErr.Error()
		}
		run.TurnDiff = summary
		return store.SaveRun(tx, run)
	})
	if err == nil {
		e.run.TurnDiff = run.TurnDiff
	}
	return err
}

func (e *execution) flush() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.dirty {
		return nil
	}
	err := e.app.Store.Write(context.Background(), func(tx *sql.Tx) error { return store.SaveRun(tx, e.run) })
	if err == nil {
		e.dirty = false
	}
	return err
}

func (e *execution) Ask(ctx context.Context, r model.Request) (model.Answer, error) {
	r.ID = ID()
	r.RunID = e.run.ID
	r.ChatID = e.run.ChatID
	r.SessionID = e.run.SessionID
	r.Status = "pending"
	if r.Questions == nil {
		r.Questions = []model.Question{}
	}
	ch := make(chan model.Answer, 1)
	e.mu.Lock()
	if err := e.ctx.Err(); err != nil {
		e.mu.Unlock()
		return model.Answer{}, err
	}
	if e.run.AllowApprovals && r.Kind == "approval" && r.AllowOnce != nil {
		r.Status, r.Answer = "answered", r.AllowOnce
		err := e.app.Store.Write(ctx, func(tx *sql.Tx) error { return store.SaveRequest(tx, r) })
		e.mu.Unlock()
		return *r.Answer, err
	}
	e.requests[r.ID] = ch
	previous := e.run.Status
	e.run.Status = "waiting_user"
	err := e.app.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := store.SaveRequest(tx, r); err != nil {
			return err
		}
		return store.SaveRun(tx, e.run)
	})
	if err != nil {
		delete(e.requests, r.ID)
		e.run.Status = previous
	}
	e.mu.Unlock()
	if err != nil {
		return model.Answer{}, err
	}
	defer func() {
		e.mu.Lock()
		delete(e.requests, r.ID)
		if len(e.requests) == 0 && e.ctx.Err() == nil && e.run.Status == "waiting_user" {
			e.run.Status = "running"
			e.dirty = true
			e.wakeSteer()
		}
		e.mu.Unlock()
	}()
	select {
	case answer := <-ch:
		return answer, nil
	case <-ctx.Done():
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.ctx.Err() == nil && e.requests[r.ID] != nil {
			r.Status = "expired"
			err = e.app.Store.Write(e.ctx, func(tx *sql.Tx) error { return store.SaveRequest(tx, r) })
			if err != nil {
				return model.Answer{}, err
			}
		}
		return model.Answer{}, ctx.Err()
	case <-e.ctx.Done():
		return model.Answer{}, e.ctx.Err()
	}
}

func (e *execution) execute() error {
	assets := filepath.Join(e.app.Store.Dir, "sessions", e.session.ID)
	plan, cleanup, err := e.app.prepareSkillPlan(e.ctx, e.session.Scope, e.profile, e.provider, assets)
	defer func() {
		if !e.hosted {
			cleanup()
		}
	}()
	task := e.run.Task
	if task != nil && task.Record == "" {
		task = e.app.followupTask(e.ctx, task.ID)
	}
	e.mu.Lock()
	if cancelErr := e.ctx.Err(); cancelErr != nil {
		e.mu.Unlock()
		return cancelErr
	}
	e.skills, e.run.Task = plan, task
	if e.provider.Type == "codex" && e.run.TurnDiff == nil && e.run.NativeTurnID == nil {
		e.run.TurnDiff = &model.TurnPatch{
			Root:  model.Root{ID: e.session.PrimaryRootID, Path: workspace.CWD(e.session.Scope)},
			Files: []model.DiffFile{},
		}
	}
	if err == nil && e.recovery == nil {
		err = validateSkillReferences(e.run.References, plan.Disabled)
	}
	if err != nil && e.recovery != nil {
		err = errors.Join(provider.ErrUnconfirmed, err)
	}
	if e.recovery == nil && !e.app.independentProviders {
		e.run.Status = "running"
	}
	e.dirty = true
	e.mu.Unlock()
	if flushErr := e.flush(); flushErr != nil {
		err = flushErr
	}
	stopFlush := make(chan struct{})
	flushDone := make(chan struct{})
	go func() {
		defer close(flushDone)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopFlush:
				return
			case <-ticker.C:
				if err := e.flush(); err != nil {
					if e.app.independentProviders {
						slog.Warn("persist running execution", "run", e.run.ID, "error", err)
						continue
					}
					e.cancel()
					return
				}
			}
		}
	}()
	if err == nil {
		if e.recovery == nil {
			e.captureChanges(false)
		}
		e.mu.Lock()
		run := e.run
		input := e.providerInput(run)
		e.mu.Unlock()
		if run.Handoff && e.recovery == nil {
			input.HistoryContext, err = e.handoff(assets)
			input.History = filepath.Join(assets, "history-"+run.ID+".jsonl")
		}
		input.MCPURL = e.app.URL + "/mcp"
		input.MCPToken = e.token
		input.ContextToken = e.contextToken
		input.RequireMCP = e.canDelegate() || slices.ContainsFunc(run.References, model.Reference.RequiresMCP)
		if err == nil && input.Provider.Type == "antigravity" {
			err = e.app.prepareAntigravitySkillReferences(e.ctx, &input)
		}
		if err == nil {
			if e.app.independentProviders {
				err = e.startHost(input)
			} else {
				err = provider.Run(e.runtimeCtx, input, e)
			}
		}
	}
	e.mu.Lock()
	e.setPermission = nil
	permissionChange := e.permissionChange
	e.mu.Unlock()
	if permissionChange != nil {
		<-permissionChange
	}
	close(stopFlush)
	<-flushDone
	if e.hosted && e.app.ctx.Err() != nil {
		return errHostDetached
	}
	if !e.hosted {
		e.captureChanges(true)
	}
	return err
}

// The caller holds App.mu so the final status and release of the session have
// the same boundary for operations that admit new executions.
func (e *execution) finish(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	pauseRequested := e.run.PauseRequested
	e.run.CanPause, e.run.PauseRequested = false, false
	e.run.ResumeAfterShutdown = false
	switch {
	case e.recovery != nil && e.run.Status == "starting" && e.ctx.Err() != nil:
		e.run.Status = "unknown"
		e.run.ResumeAfterShutdown = e.app.closed && e.recovery.Continue
	case errors.Is(err, provider.ErrPaused):
		e.run.Status, e.run.FinishedAt = "paused", ""
		err = nil
	case pauseRequested && errors.Is(err, provider.ErrUnconfirmed):
		e.run.Status = "unknown"
	case e.ctx.Err() != nil || errors.Is(err, context.Canceled):
		e.run.ResumeAfterShutdown = e.app.closed && e.ctx.Err() != nil && e.provider.Type == "codex" && e.run.Status == "running"
		e.run.Status = "interrupted"
	case errors.Is(err, provider.ErrUnconfirmed):
		e.run.Status = "unknown"
	case err != nil:
		e.run.Status = "failed"
	default:
		e.run.Status = "completed"
	}
	if err != nil {
		e.run.Error = err.Error()
	}
	if e.run.Status != "paused" && e.run.FinishedAt == "" {
		e.run.FinishedAt = now()
	}
	e.run.PermissionMutable, e.run.CanSteer, e.run.SteerPending = false, false, false
	for i := range e.run.Items {
		if e.run.Items[i].Status == "running" {
			if e.run.Items[i].Kind == "subagent" {
				e.run.Items[i].Status = "unknown"
			} else {
				e.run.Items[i].Status = e.run.Status
			}
		}
	}
	// The provider has closed its owned process tree before any terminal state is
	// committed, so accepting another turn cannot overlap a stopping runtime.
	ctx := context.Background()
	var completeNote bool
	if saveErr := e.app.Store.Write(ctx, func(tx *sql.Tx) error {
		if e.hosted {
			if _, err := tx.Exec("DELETE FROM runtime_hosts WHERE run_id=?", e.run.ID); err != nil {
				return err
			}
		}
		released, err := releaseDeferredSteers(ctx, tx, e.run.ID)
		if err != nil {
			return err
		}
		pending, err := store.List[model.Run](ctx, tx, "SELECT data FROM runs WHERE status='steering' AND json_extract(data,'$.steerRunId')=?", e.run.ID)
		if err != nil {
			return err
		}
		for _, message := range pending {
			message.Status, message.FinishedAt = "steered", now()
			message.Error = "Delivery was not confirmed before the execution stopped; this input will not be replayed."
			if err := store.SaveRun(tx, message); err != nil {
				return err
			}
			for i := range e.run.Items {
				if e.run.Items[i].ID == message.ID {
					e.run.Items[i].Status = "unknown"
				}
			}
		}
		if e.run.Status != "completed" {
			if _, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.queuePaused',json('true')) WHERE id=?", e.run.SessionID); err != nil {
				return err
			}
		}
		requests, err := store.List[model.Request](context.Background(), tx, "SELECT data FROM requests WHERE run_id=? AND status='pending'", e.run.ID)
		if err != nil {
			return err
		}
		for _, r := range requests {
			r.Status = "expired"
			if err = store.SaveRequest(tx, r); err != nil {
				return err
			}
		}
		if err := store.SaveRun(tx, e.run); err != nil {
			return err
		}
		task := e.run.Task
		delivered := e.run.TaskCompletionRequested && e.run.Status == "completed" && len(requests) == 0 && len(pending) == 0 && !released
		if !delivered || task == nil || e.run.Selection.Permission == "read_only" {
			return nil
		}
		switch task.Record {
		case model.TaskRecordAutomation:
			err = setAutomationRunDone(ctx, tx, task.ID, e.run.ID, true)
		case model.TaskRecordWorkItem:
			err = setWorkItemDone(ctx, tx, task.ID, true)
		case model.TaskRecordNote:
			err = checkTaskCompletable(ctx, tx, task.ID)
			completeNote = err == nil
		}
		var refusal *Error
		if errors.As(err, &refusal) || errors.Is(err, sql.ErrNoRows) {
			return nil // The task moved on. Keep the run's actual outcome.
		}
		return err
	}); saveErr != nil {
		slog.Error("persist runtime outcome", "run", e.run.ID, "error", saveErr)
		return
	}
	if e.hosted {
		e.cleanHostFiles()
	}
	// Notes live on disk. Only write after the successful terminal state commits,
	// while App.mu still prevents a new turn from taking over this task.
	if completeNote {
		if err := e.app.completeNoteTask(ctx, *e.run.Task); err != nil {
			slog.Warn("leave delivered note task for review", "task", e.run.Task.ID, "error", err)
		}
	}
}

// Capture only at execution boundaries, never when a message is queued. A
// failed preview does not prevent the runtime from answering the user.
func (e *execution) captureChanges(after bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	e.mu.Lock()
	changes := append([]model.RunChanges(nil), e.run.Changes...)
	e.mu.Unlock()
	if !after {
		for _, root := range e.session.Roots {
			before, err := workspace.CaptureTree(ctx, root.Path, workspace.CheckpointRef(e.run.ID, root.ID, "before"))
			if errors.Is(err, workspace.ErrNotRepository) {
				continue
			}
			change := model.RunChanges{Root: root, Before: before, Files: []model.DiffFile{}}
			if err == nil && e.session.WorkingCopyID != "" {
				change.GitDir, change.Relative = workspace.SnapshotLocation(ctx, root.Path)
			}
			if err != nil {
				change.Error = err.Error()
			}
			changes = append(changes, change)
		}
	} else {
		workspace.FinishRunChanges(ctx, e.run.ID, changes)
	}
	e.mu.Lock()
	e.run.Changes = changes
	e.dirty = true
	e.mu.Unlock()
}

const skillBundlePluginName = "lever-session-skills"

// Each session executes serially. Refresh its native skill bundle before the
// next run; the active run and its steers keep using the same files. os.Root
// prevents symlinks inside a skill from escaping the selected bundle.
func prepareSkills(assets string, sources []string) error {
	if err := os.MkdirAll(filepath.Join(assets, ".claude-plugin"), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(assets, ".claude-plugin", "plugin.json"), []byte(`{"name":"`+skillBundlePluginName+`","version":"1.0.0"}`), 0600); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(assets, ".skills-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := copySkillPackages(tmp, sources); err != nil {
		return err
	}
	target := filepath.Join(assets, "skills")
	if err = os.RemoveAll(target); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func copySkillPackages(dir string, sources []string) error {
	var total int64
	for _, source := range sources {
		if err := copySkillPackage(source, filepath.Join(dir, filepath.Base(source)), &total); err != nil {
			return err
		}
	}
	return nil
}

func copySkillPackage(source, target string, total *int64) error {
	root, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer root.Close()
	return fs.WalkDir(root.FS(), ".", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("skill bundles must not contain symlinks")
		}
		dest := filepath.Join(target, filepath.FromSlash(path))
		if d.IsDir() {
			if d.Name() == ".git" {
				return fs.SkipDir
			}
			return os.MkdirAll(dest, 0700)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("skill bundles must contain regular files")
		}
		*total += info.Size()
		if *total > 32<<20 {
			return errors.New("selected skills exceed 32 MiB")
		}
		in, err := root.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600|(info.Mode()&0111))
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		return errors.Join(copyErr, out.Close())
	})
}
