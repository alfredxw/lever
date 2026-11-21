package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

func (e *execution) EnablePermissionChanges(set func(context.Context, string) error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.setPermission = set
	e.run.PermissionMutable = true
	e.dirty = true
}

func (a *App) activeExecution(id string) *execution {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.active[id]
}

func (e *execution) acceptsPermissionChanges() bool {
	return e.ctx.Err() == nil && (e.run.Status == "running" || e.run.Status == "waiting_user")
}

func (a *App) SetRunPermission(ctx context.Context, id, permission string) error {
	if permission == "" || len(permission) > 200 || strings.ContainsAny(permission, "\x00\r\n") {
		return invalid("Choose a valid permission option")
	}
	e := a.activeExecution(id)
	if e == nil {
		return conflict("The execution is no longer active")
	}
	e.mu.Lock()
	set := e.setPermission
	if !e.acceptsPermissionChanges() || (set == nil && !(e.hosted && e.run.PermissionMutable)) || e.permissionChange != nil {
		e.mu.Unlock()
		return conflict("The runtime cannot change permissions at this point in the execution")
	}
	if e.run.Selection.Permission == permission {
		e.mu.Unlock()
		return nil
	}
	selection := e.run.Selection
	selection.Permission = permission
	if _, err := provider.ResolveSelection(selection, e.run.Selection, e.provider); err != nil {
		e.mu.Unlock()
		return invalid(err.Error())
	}
	if err := ctx.Err(); err != nil {
		e.mu.Unlock()
		return err
	}
	if e.hosted {
		p := e.beginHostPermission(ID())
		_, err := a.Store.DB.ExecContext(ctx, "INSERT INTO runtime_commands(run_id,id,kind,data) VALUES(?,?,'permission',?)", id, p.id, permission)
		if err != nil {
			e.releaseHostPermission(err)
		}
		e.mu.Unlock()
		if err != nil {
			return err
		}
		select {
		case <-p.done:
			return p.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	e.permissionChange = make(chan struct{})
	e.mu.Unlock()

	// Finish a dispatched update even if the UI closes while the runtime is applying it.
	changeCtx, cancel := context.WithTimeout(e.ctx, 10*time.Second)
	defer cancel()
	err := set(changeCtx, permission)
	e.mu.Lock()
	defer func() {
		close(e.permissionChange)
		e.permissionChange = nil
		e.mu.Unlock()
		e.wakeSteer()
	}()
	if err != nil {
		if errors.Is(err, provider.ErrUnconfirmed) && e.acceptsPermissionChanges() {
			e.cancel()
			return conflict("The runtime did not confirm the permission change. The execution was stopped.")
		}
		return conflict(err.Error())
	}
	if !e.acceptsPermissionChanges() {
		return conflict("The execution ended while permissions were changing")
	}
	return e.savePermissionLocked(permission, "")
}

func (e *execution) savePermissionLocked(permission, command string) error {
	a, id := e.app, e.run.ID
	next := e.run
	next.Selection.Permission, next.AllowApprovals = permission, false
	if err := a.Store.Write(context.Background(), func(tx *sql.Tx) error {
		if command != "" {
			if _, err := tx.Exec("DELETE FROM runtime_commands WHERE id=?", command); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("UPDATE sessions SET data=json_set(data,'$.selection.permission',?) WHERE id=?", permission, e.session.ID); err != nil {
			return err
		}
		steers, err := store.List[model.Run](context.Background(), tx, "SELECT data FROM runs WHERE status='queued' AND json_extract(data,'$.steerRunId')=?", id)
		if err != nil {
			return err
		}
		for _, steer := range steers {
			if steer.Selection.Permission != permission {
				steer.Delivery, steer.SteerRunID = "queue", ""
				if err := store.SaveRun(tx, steer); err != nil {
					return err
				}
			}
		}
		return store.SaveRun(tx, next)
	}); err != nil {
		if !e.hosted {
			e.cancel()
		}
		return err
	}
	e.session.Selection.Permission = permission
	e.run.Selection.Permission, e.run.AllowApprovals = permission, false
	return nil
}

// SetRunApprovals grants or revokes one-time tool approvals for this execution.
func (a *App) SetRunApprovals(ctx context.Context, id string, allow bool) error {
	e := a.activeExecution(id)
	if e == nil {
		return conflict("The execution is no longer active")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.acceptsPermissionChanges() {
		return conflict("The execution is no longer active")
	}
	if e.run.AllowApprovals == allow {
		return nil
	}
	next := e.run
	next.AllowApprovals = allow
	var approved []model.Request
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if allow {
			pending, err := store.List[model.Request](ctx, tx, "SELECT data FROM requests WHERE run_id=? AND status='pending'", id)
			if err != nil {
				return err
			}
			for _, request := range pending {
				if request.Kind != "approval" || request.AllowOnce == nil || (!e.hosted && e.requests[request.ID] == nil) {
					continue
				}
				request.Status, request.Answer = "answered", request.AllowOnce
				if err := store.SaveRequest(tx, request); err != nil {
					return err
				}
				approved = append(approved, request)
			}
		}
		return store.SaveRun(tx, next)
	}); err != nil {
		return err
	}
	e.run.AllowApprovals = allow
	for _, request := range approved {
		if ch := e.requests[request.ID]; ch != nil {
			ch <- *request.Answer
			delete(e.requests, request.ID)
		}
	}
	return nil
}
