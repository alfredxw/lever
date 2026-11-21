package store

import (
	"context"
	"database/sql"
	"errors"

	"lever/internal/model"
)

func (s *Store) ChatDelegations(ctx context.Context, chatID string) (model.ChatDelegations, error) {
	view := model.ChatDelegations{Outgoing: map[string][]model.DelegatedRun{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return view, err
	}
	defer tx.Rollback()

	// The accepted command identifies the exact run, even if the process stopped
	// before delegate_start could write its receipt. Follow-up runs have other commands.
	rows, err := tx.QueryContext(ctx, `SELECT d.parent_run_id, child.id, child.session_id, child.chat_id,
  child.agent_id, json_extract(chat.data,'$.title'), child.status
FROM runs parent JOIN delegations d ON d.parent_run_id=parent.id
JOIN runs child ON child.command_id=?||d.id AND child.chat_id=json_extract(d.data,'$.chatId')
JOIN chats chat ON chat.id=child.chat_id WHERE parent.chat_id=? ORDER BY child.position`, model.DelegationCommandPrefix, chatID)
	if err != nil {
		return view, err
	}
	defer rows.Close()
	for rows.Next() {
		var parentID string
		var child model.DelegatedRun
		if err := rows.Scan(&parentID, &child.RunID, &child.SessionID, &child.ChatID, &child.AgentID, &child.Title, &child.Status); err != nil {
			return view, err
		}
		view.Outgoing[parentID] = append(view.Outgoing[parentID], child)
	}
	if err := rows.Err(); err != nil {
		return view, err
	}
	if err := rows.Close(); err != nil {
		return view, err
	}

	var source model.DelegationTarget
	err = tx.QueryRowContext(ctx, `SELECT parent.id, parent.session_id, parent.chat_id,
  parent.agent_id, json_extract(chat.data,'$.title'), owner.kind='topic'
FROM sessions child JOIN runs parent ON parent.id=json_extract(child.data,'$.parentRunId')
JOIN chats chat ON chat.id=parent.chat_id JOIN sessions owner ON owner.id=parent.session_id
WHERE child.chat_id=? AND child.kind='main'`, chatID).Scan(&source.RunID, &source.SessionID, &source.ChatID, &source.AgentID, &source.Title, &source.Topic)
	if err == nil {
		view.Source = &source
	} else if !errors.Is(err, sql.ErrNoRows) {
		return view, err
	}
	return view, tx.Commit()
}

func notifyDelegation(tx *sql.Tx, runID string) error {
	var source string
	err := tx.QueryRow(`SELECT parent.chat_id FROM runs child
JOIN delegations d ON d.id=substr(child.command_id,length(?)+1) AND child.command_id=?||d.id
  AND child.chat_id=json_extract(d.data,'$.chatId')
JOIN runs parent ON parent.id=d.parent_run_id WHERE child.id=?`, model.DelegationCommandPrefix, model.DelegationCommandPrefix, runID).Scan(&source)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return Event(tx, model.Event{Type: "delegations", ChatID: source})
}
