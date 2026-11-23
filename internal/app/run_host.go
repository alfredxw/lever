package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/runhost"
	"lever/internal/store"
)

var errHostDetached = errors.New("backend detached from provider worker")

// Publish the exact input and the before-checkpoint before any provider can
// claim the turn. This is also the point at which a desktop restart is safe.
func (e *execution) startHost(in provider.Input) error {
	e.mu.Lock()
	err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO runtime_hosts(run_id,input) VALUES(?,?)", in.RunID, store.JSON(runhost.Input{Input: in, Changes: e.run.Changes})); err != nil {
			return err
		}
		run := e.run
		if e.recovery == nil {
			run.Status = "running"
		}
		return store.SaveRun(tx, run)
	})
	if err == nil {
		e.hosted = true
		if e.recovery == nil {
			e.run.Status = "running"
		}
	}
	e.mu.Unlock()
	if err != nil {
		return err
	}
	return e.followHost()
}

func (a *App) restoreRunHosts() error {
	inputs, err := store.List[provider.Input](a.ctx, a.Store.DB, "SELECT input FROM runtime_hosts")
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, in := range inputs {
		run, err := store.Get[model.Run](a.ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", in.RunID)
		if err != nil {
			return err
		}
		session, err := store.Get[model.Session](a.ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", run.SessionID)
		if err != nil {
			return err
		}
		e := a.newExecution(run, session, in.Profile, in.Provider, in.Recovery)
		e.hosted, e.skills, e.token = true, in.Skills, in.MCPToken
		e.contextToken = in.ContextToken
		if in.Provider.Type == "pi" && in.ContextToken == "" {
			e.contextToken, e.token = in.MCPToken, ""
		}
		var permission sql.NullString
		err = a.Store.DB.QueryRow(`SELECT h.history_bytes,c.id FROM runtime_hosts h LEFT JOIN runtime_commands c
   ON c.run_id=h.run_id AND c.kind='permission' WHERE h.run_id=?`, run.ID).Scan(&e.historyBytes, &permission)
		if err != nil {
			return err
		}
		if permission.Valid {
			e.beginHostPermission(permission.String)
		}
		a.trackLocked(e, e.followHost)
	}
	return nil
}

func (e *execution) cleanHostFiles() {
	_ = os.Remove(runhost.LockPath(e.app.Store.Dir, e.run.ID))
	if e.skills.ClaudeStage != "" {
		_ = os.RemoveAll(e.skills.ClaudeStage)
	}
}

type hostEvent struct {
	seq        int64
	kind, data string
}

func (e *execution) followHost() error {
	ticker := time.NewTicker(runhost.Poll)
	defer ticker.Stop()
	var lastCheck time.Time
	checkSteers := true
	for {
		if e.app.ctx.Err() != nil {
			e.endHostPermission(errHostDetached)
			return errHostDetached
		}
		var phase, detail, finished string
		err := e.app.Store.DB.QueryRowContext(e.app.ctx, "SELECT phase,error,finished_at FROM runtime_hosts WHERE run_id=?", e.run.ID).Scan(&phase, &detail, &finished)
		active := phase == "ready" || phase == "running"
		if err == nil && active && time.Since(lastCheck) >= time.Second {
			lastCheck = time.Now()
			err = runhost.Ensure(e.app.ctx, e.app.Store.DB, e.app.Store.Dir, e.run.ID, phase)
		}
		if err == nil {
			var more bool
			more, err = e.drainHostEvents()
			if err == nil && more {
				continue
			}
		}
		if err == nil {
			err = e.applyHostPermission(!active)
		}
		if err == nil && !active {
			err = e.returnUnsentSteers()
		}
		if err == nil && !active {
			e.mu.Lock()
			e.run.FinishedAt = finished
			e.mu.Unlock()
			switch phase {
			case "completed":
				return nil
			case "interrupted":
				return context.Canceled
			case "paused":
				return provider.ErrPaused
			case "unknown":
				return unconfirmedHostError(detail)
			case "failed":
				return errors.New(detail)
			default:
				err = errors.New("invalid provider worker state: " + phase)
			}
		}
		if err == nil && checkSteers && active {
			for {
				var msg *provider.Input
				msg, err = e.NextSteer()
				if err != nil || msg == nil {
					break
				}
			}
			checkSteers = err != nil
		}
		if err != nil && e.app.ctx.Err() == nil {
			slog.Warn("synchronize provider worker", "run", e.run.ID, "error", err)
			select {
			case <-e.app.ctx.Done():
			case <-time.After(time.Second):
			}
		}
		select {
		case <-e.app.ctx.Done():
		case <-e.steers:
			checkSteers = true
		case <-ticker.C:
		}
	}
}

func unconfirmedHostError(detail string) error {
	prefix := provider.ErrUnconfirmed.Error()
	detail = strings.TrimSpace(detail)
	switch {
	case detail == "" || detail == prefix:
		return provider.ErrUnconfirmed
	case strings.HasPrefix(detail, prefix+"\n"):
		detail = strings.TrimSpace(strings.TrimPrefix(detail, prefix+"\n"))
	case strings.HasPrefix(detail, prefix+": "):
		detail = strings.TrimSpace(strings.TrimPrefix(detail, prefix+": "))
	}
	if detail == "" {
		return provider.ErrUnconfirmed
	}
	return errors.Join(provider.ErrUnconfirmed, errors.New(detail))
}

// A queued steer that the worker never claimed is still safe to send later.
func (e *execution) returnUnsentSteers() error {
	messages, err := store.List[model.Run](e.ctx, e.app.Store.DB, `SELECT r.data FROM runs r JOIN runtime_commands c
 ON c.id=r.id WHERE c.run_id=? AND c.kind='steer' AND c.taken=0 AND r.status='steering'`, e.run.ID)
	if err != nil {
		return err
	}
	for _, msg := range messages {
		if err = e.Steered(msg.ID, provider.ErrSteerRejected); err != nil {
			return err
		}
	}
	return nil
}

func (e *execution) drainHostEvents() (bool, error) {
	db := e.app.Store.DB
	rows, err := db.QueryContext(e.app.ctx, "SELECT seq,kind,data FROM runtime_events WHERE run_id=? ORDER BY seq LIMIT 64", e.run.ID)
	if err != nil {
		return false, err
	}
	var events []hostEvent
	for rows.Next() {
		var v hostEvent
		if err = rows.Scan(&v.seq, &v.kind, &v.data); err != nil {
			break
		}
		events = append(events, v)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return false, err
	}
	for _, v := range events {
		if err = e.applyHostEvent(v); err != nil {
			return false, err
		}
		// A worker can coalesce another text delta while we project the previous
		// value. Only acknowledge the version that reached the durable transcript.
		if _, err = db.ExecContext(e.app.ctx, "DELETE FROM runtime_events WHERE seq=? AND data=?", v.seq, v.data); err != nil {
			return false, err
		}
	}
	return len(events) == 64, nil
}

func (e *execution) applyHostEvent(v hostEvent) error {
	var value string
	switch v.kind {
	case "bind", "turn", "patch", "closeRequest":
		if err := json.Unmarshal([]byte(v.data), &value); err != nil {
			return err
		}
	}
	switch v.kind {
	case "bind":
		return e.Bind(value)
	case "turn":
		return e.BindTurn(value)
	case "patch":
		return e.TurnDiff(value)
	case "closeRequest":
		return e.closeHostRequest(value)
	case "runtime":
		var update runhost.RuntimeUpdate
		if err := json.Unmarshal([]byte(v.data), &update); err != nil {
			return err
		}
		if err := e.UpdateRuntime(func(s *model.SessionRuntime) { *s = update.SessionRuntime }); err != nil {
			return err
		}
		if update.SteerState != "" {
			return e.SetSteerState(update.SteerState)
		}
		return nil
	case "changes":
		var changes []model.RunChanges
		if err := json.Unmarshal([]byte(v.data), &changes); err != nil {
			return err
		}
		e.mu.Lock()
		e.run.Changes = changes
		e.dirty = true
		e.mu.Unlock()
		return e.flush()
	case "item":
		var item model.Item
		if err := json.Unmarshal([]byte(v.data), &item); err != nil {
			return err
		}
		if err := e.Item(item); err != nil {
			return err
		}
		return e.flush()
	case "ask":
		var r model.Request
		if err := json.Unmarshal([]byte(v.data), &r); err != nil {
			return err
		}
		return e.openHostRequest(r)
	case "mutable":
		e.mu.Lock()
		e.run.PermissionMutable = true
		e.dirty = true
		e.mu.Unlock()
		return e.flush()
	case "steerable":
		var ready bool
		if err := json.Unmarshal([]byte(v.data), &ready); err != nil {
			return err
		}
		if ready {
			return e.SetSteerState(provider.SteerReady)
		}
		return e.SetSteerState(provider.SteerUnavailable)
	case "steerState":
		var state provider.SteerState
		if err := json.Unmarshal([]byte(v.data), &state); err != nil {
			return err
		}
		return e.SetSteerState(state)
	case "steered":
		var ack runhost.SteerResult
		if err := json.Unmarshal([]byte(v.data), &ack); err != nil {
			return err
		}
		return e.Steered(ack.ID, ack.Outcome.Err())
	}
	return errors.New("unknown provider event: " + v.kind)
}

func (e *execution) openHostRequest(r model.Request) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	next := e.run
	err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM requests WHERE id=?)", r.ID).Scan(&exists); err != nil || exists {
			return err
		}
		r.RunID, r.ChatID, r.SessionID, r.Status = next.ID, next.ChatID, next.SessionID, "pending"
		if r.Questions == nil {
			r.Questions = []model.Question{}
		}
		if next.AllowApprovals && r.Kind == "approval" && r.AllowOnce != nil {
			r.Status, r.Answer = "answered", r.AllowOnce
		} else if next.Status != "cancelling" {
			next.Status = "waiting_user"
		}
		if err := store.SaveRequest(tx, r); err != nil {
			return err
		}
		return store.SaveRun(tx, next)
	})
	if err == nil {
		e.run.Status = next.Status
	}
	return err
}
func (e *execution) closeHostRequest(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	next := e.run
	err := e.app.Store.Write(e.ctx, func(tx *sql.Tx) error {
		r, err := store.Get[model.Request](e.ctx, tx, "SELECT data FROM requests WHERE id=?", id)
		if err != nil {
			return err
		}
		if r.Status == "pending" {
			r.Status = "expired"
			if err = store.SaveRequest(tx, r); err != nil {
				return err
			}
		}
		var pending bool
		if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM requests WHERE run_id=? AND status='pending')", next.ID).Scan(&pending); err != nil {
			return err
		}
		if !pending && next.Status == "waiting_user" {
			next.Status = "running"
			return store.SaveRun(tx, next)
		}
		return nil
	})
	if err == nil {
		if e.run.Status == "waiting_user" && next.Status == "running" {
			e.wakeSteer()
		}
		e.run.Status = next.Status
	}
	return err
}

type hostPermission struct {
	id   string
	done chan struct{}
	err  error
}

func (e *execution) beginHostPermission(id string) *hostPermission {
	p := &hostPermission{id: id, done: make(chan struct{})}
	e.pendingPermission = p
	e.permissionChange = p.done
	return p
}
func (e *execution) releaseHostPermission(err error) {
	if p := e.pendingPermission; p != nil {
		p.err = err
		close(p.done)
		e.pendingPermission = nil
		e.permissionChange = nil
		e.wakeSteer()
	}
}
func (e *execution) endHostPermission(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.releaseHostPermission(err)
}
func (e *execution) applyHostPermission(terminal bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if terminal {
		e.run.PermissionMutable = false
	}
	p := e.pendingPermission
	if p == nil {
		return nil
	}
	var permission string
	var raw sql.NullString
	if err := e.app.Store.DB.QueryRow("SELECT data,result FROM runtime_commands WHERE id=?", p.id).Scan(&permission, &raw); err != nil {
		return err
	}
	var failure error
	if raw.Valid {
		var outcome runhost.Outcome
		if err := json.Unmarshal([]byte(raw.String), &outcome); err != nil {
			return err
		}
		failure = outcome.Err()
	} else if terminal {
		failure = conflict("The execution ended before confirming the permission change")
	} else {
		return nil
	}
	if failure == nil {
		if err := e.savePermissionLocked(permission, p.id); err != nil {
			return err
		}
	} else {
		if _, err := e.app.Store.DB.Exec("DELETE FROM runtime_commands WHERE id=?", p.id); err != nil {
			return err
		}
		failure = conflict(failure.Error())
	}
	e.releaseHostPermission(failure)
	return nil
}
