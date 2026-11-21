package store

import (
	"context"
	"database/sql"

	"lever/internal/model"
)

func (s *Store) ComparisonResults(ctx context.Context, id string) ([]model.ComparisonResult, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	comparison, err := Get[model.Comparison](ctx, tx, "SELECT data FROM comparisons WHERE id=?", id)
	if err != nil {
		return nil, err
	}
	results := make([]model.ComparisonResult, 0, len(comparison.SessionIDs))
	for _, sessionID := range comparison.SessionIDs {
		session, err := Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", sessionID)
		if err != nil {
			return nil, err
		}
		run, err := Get[model.Run](ctx, tx, `SELECT data FROM runs WHERE session_id=?
AND json_extract(data,'$.comparisonId')=? ORDER BY sequence DESC LIMIT 1`, sessionID, id)
		if err != nil {
			return nil, err
		}
		results = append(results, model.ComparisonResult{Session: session, Run: run})
	}
	return results, tx.Commit()
}
