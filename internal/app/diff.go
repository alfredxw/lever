package app

import (
	"context"
	"database/sql"
	"errors"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

// RunReview resolves a pinned execution, or the most recently finished one
// in the selected session. An unscoped workspace can review the whole Agent.
func (a *App) RunReview(ctx context.Context, agentID, sessionID, runID string) (model.TurnReview, error) {
	query := `SELECT json_object('runId', id, 'turnDiff', json_extract(data,'$.turnDiff'),
		'changes', json(COALESCE(json_extract(data,'$.changes'),'[]'))) FROM runs WHERE agent_id=?`
	args := []any{agentID}
	if sessionID != "" {
		query += " AND session_id=?"
		args = append(args, sessionID)
	}
	if runID != "" {
		query += " AND id=?"
		args = append(args, runID)
	} else {
		// UTC RFC3339Nano timestamps have variable-width fractions. Compare
		// without their trailing Z so .1234 sorts after .123.
		query += ` AND status IN ('completed','failed','interrupted') AND json_extract(data,'$.startedAt') IS NOT NULL
			ORDER BY rtrim(json_extract(data,'$.finishedAt'),'Z') DESC, sequence DESC LIMIT 1`
	}
	review, err := store.Get[model.TurnReview](ctx, a.Store.DB, query, args...)
	if runID == "" && errors.Is(err, sql.ErrNoRows) {
		return model.TurnReview{Changes: []model.RunChanges{}}, nil
	}
	return review, err
}

func (a *App) ReviewDiff(ctx context.Context, review model.TurnReview, rootID string, snapshot bool, opts workspace.DiffOptions) (model.DiffResult, error) {
	if native := review.TurnDiff; !snapshot && native != nil {
		if !native.Reported || native.Root.ID != rootID {
			return model.DiffResult{}, sql.ErrNoRows
		}
		if opts.Full || opts.IgnoreWhitespace {
			return model.DiffResult{}, invalid("Codex supplies its own diff context and whitespace")
		}
		var patch string
		if err := a.Store.DB.QueryRowContext(ctx, "SELECT patch FROM run_turn_diffs WHERE run_id=?", review.RunID).Scan(&patch); err != nil {
			return model.DiffResult{}, err
		}
		result, err := workspace.CodexTurnDiff(patch, opts.Path)
		result.Repository = native.Root.Path
		return result, err
	}
	for _, change := range review.Changes {
		if change.Root.ID == rootID {
			return workspace.TurnDiff(ctx, change, opts)
		}
	}
	return model.DiffResult{}, sql.ErrNoRows
}
