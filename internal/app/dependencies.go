package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
)

const maxRunDependencies = 50

func normalizeAfterRunIDs(ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			return nil, invalid("Choose valid tasks to wait for")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
		if len(out) > maxRunDependencies {
			return nil, invalid("Wait for up to 50 tasks at once")
		}
	}
	return out, nil
}

func validateAfterRuns(ctx context.Context, tx *sql.Tx, afterRunIDs []string, editing model.Run, sessionID string) error {
	for _, depID := range afterRunIDs {
		if editing.ID != "" && depID == editing.ID {
			return invalid("A message cannot wait for itself")
		}
		dep, err := store.Get[model.Run](ctx, tx, "SELECT data FROM runs WHERE id=?", depID)
		if errors.Is(err, sql.ErrNoRows) {
			return invalid("One of the selected tasks no longer exists")
		}
		if err != nil {
			return err
		}
		if dep.Superseded || dep.Status == "steering" || dep.Status == "steered" {
			return invalid("Selected task cannot be waited for")
		}
		switch dep.Status {
		case "failed", "interrupted", "cancelled", "unknown", "paused":
			return conflict("One of the selected tasks did not finish successfully")
		case "queued":
			var blocked bool
			err := tx.QueryRowContext(ctx, `WITH RECURSIVE upstream(id) AS (
  SELECT rd.after_run_id FROM run_dependencies rd WHERE rd.run_id=?
  UNION
  SELECT rd.after_run_id FROM run_dependencies rd JOIN upstream u ON rd.run_id=u.id
) SELECT COALESCE((SELECT json_extract(data,'$.queuePaused') FROM sessions WHERE id=?),0)=1 OR EXISTS(
  SELECT 1 FROM upstream u
  JOIN runs ur ON ur.id=u.id
  JOIN sessions us ON us.id=ur.session_id
  WHERE ur.status IN ('failed','interrupted','cancelled','unknown','paused')
     OR (ur.status='queued' AND COALESCE(json_extract(us.data,'$.queuePaused'),0)=1)
)`, depID, dep.SessionID).Scan(&blocked)
			if err != nil {
				return err
			}
			if blocked {
				return conflict("One of the selected tasks is blocked by an unfinished task")
			}
		}
		if editing.ID != "" && dep.SessionID == sessionID && dep.Status == "queued" && dep.Sequence >= editing.Sequence {
			return invalid("Cannot wait for a later queued message in the same conversation")
		}
		if editing.ID != "" {
			var cycle bool
			err := tx.QueryRowContext(ctx, `WITH RECURSIVE chain(id) AS (
  SELECT ?
  UNION
  SELECT rd.after_run_id FROM run_dependencies rd JOIN chain c ON rd.run_id=c.id
) SELECT EXISTS(SELECT 1 FROM chain WHERE id=?)`, depID, editing.ID).Scan(&cycle)
			if err != nil {
				return err
			}
			if cycle {
				return invalid("Cannot create a circular task dependency")
			}
		}
	}
	return nil
}

func saveRunDependencies(ctx context.Context, tx *sql.Tx, runID string, afterRunIDs []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM run_dependencies WHERE run_id=?", runID); err != nil {
		return err
	}
	for _, depID := range afterRunIDs {
		if _, err := tx.ExecContext(ctx, "INSERT INTO run_dependencies(run_id,after_run_id) VALUES(?,?)", runID, depID); err != nil {
			return err
		}
	}
	return nil
}

func replaceRunDependencyTarget(ctx context.Context, tx *sql.Tx, oldRunID, newRunID string) error {
	waiters, err := store.List[model.Run](ctx, tx, `SELECT r.data FROM runs r
JOIN run_dependencies rd ON rd.run_id=r.id
WHERE rd.after_run_id=? AND r.status='queued'`, oldRunID)
	if err != nil {
		return err
	}
	if len(waiters) == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE run_dependencies SET after_run_id=?
WHERE after_run_id=? AND run_id IN (SELECT id FROM runs WHERE status='queued')`, newRunID, oldRunID); err != nil {
		return err
	}
	for _, waiter := range waiters {
		for i, depID := range waiter.AfterRunIDs {
			if depID == oldRunID {
				waiter.AfterRunIDs[i] = newRunID
			}
		}
		if err := store.SaveRun(tx, waiter); err != nil {
			return err
		}
	}
	return nil
}

func dependenciesReady(ctx context.Context, tx *sql.Tx, runID string) (bool, error) {
	var ready bool
	err := tx.QueryRowContext(ctx, `SELECT NOT EXISTS(
  SELECT 1 FROM run_dependencies rd
  JOIN runs dep ON dep.id=rd.after_run_id
  WHERE rd.run_id=? AND dep.status<>'completed'
)`, runID).Scan(&ready)
	return ready, err
}

func (a *App) advanceDependentRunsLocked(afterRunID string) {
	if a.closed {
		return
	}
	sessions, err := store.List[string](a.ctx, a.Store.DB, `SELECT json_quote(r.session_id)
FROM run_dependencies rd JOIN runs r ON r.id=rd.run_id
WHERE rd.after_run_id=? AND r.status='queued'
GROUP BY r.session_id
ORDER BY MIN(r.sequence)`, afterRunID)
	if err != nil {
		if a.ctx.Err() == nil {
			slog.Error("lookup dependent runs", "run", afterRunID, "error", err)
		}
		return
	}
	for _, sessionID := range sessions {
		if err := a.advanceQueueLocked(sessionID); err != nil && a.ctx.Err() == nil {
			slog.Error("advance dependent queue", "session", sessionID, "afterRun", afterRunID, "error", err)
		}
	}
}

func (a *App) advanceReadyDependentRuns() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	sessions, err := store.List[string](a.ctx, a.Store.DB, `SELECT json_quote(r.session_id)
FROM runs r
WHERE r.status='queued'
AND EXISTS(SELECT 1 FROM run_dependencies rd WHERE rd.run_id=r.id)
AND NOT EXISTS(SELECT 1 FROM run_dependencies rd JOIN runs dep ON dep.id=rd.after_run_id WHERE rd.run_id=r.id AND dep.status<>'completed')
GROUP BY r.session_id
ORDER BY MIN(r.sequence)`)
	if err != nil {
		if a.ctx.Err() == nil {
			slog.Error("lookup ready dependent runs", "error", err)
		}
		return
	}
	for _, sessionID := range sessions {
		if err := a.advanceQueueLocked(sessionID); err != nil && a.ctx.Err() == nil {
			slog.Error("advance ready dependent queue", "session", sessionID, "error", err)
		}
	}
}
