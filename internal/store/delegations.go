package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"lever/internal/model"
)

func runSummaryExcerpt(raw string, maxRunes int) string {
	var run model.Run
	if err := json.Unmarshal([]byte(raw), &run); err != nil {
		return ""
	}
	var parts []string
	for _, item := range run.Items {
		if item.Kind == "text" && strings.TrimSpace(item.Text) != "" {
			parts = append(parts, strings.TrimSpace(item.Text))
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if text == "" {
		text = strings.TrimSpace(run.Error)
	}
	if text == "" {
		return ""
	}
	collapsed := strings.Join(strings.Fields(text), " ")
	runes := []rune(collapsed)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes-1]) + "…"
	}
	return collapsed
}

func (s *Store) ChatDelegations(ctx context.Context, chatID string) (model.ChatDelegations, error) {
	view := model.ChatDelegations{Outgoing: map[string][]model.DelegatedRun{}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return view, err
	}
	defer tx.Rollback()

	// Collect delegated runs recorded in delegation_runs (multi-turn aware) and
	// fall back to legacy delegations rows created before delegation_runs existed.
	rows, err := tx.QueryContext(ctx, `SELECT parent_run_id, delegation_id, run_id, session_id, chat_id, agent_id, title, status,
  turn, turns, provider, model, workspace, working_copy_name, run_data
FROM (
  SELECT dr.parent_run_id AS parent_run_id,
    dr.delegation_id AS delegation_id,
    child.id AS run_id,
    child.session_id AS session_id,
    child.chat_id AS chat_id,
    child.agent_id AS agent_id,
    json_extract(chat.data,'$.title') AS title,
    child.status AS status,
    dr.turn AS turn,
    (SELECT COUNT(*) FROM delegation_runs x WHERE x.delegation_id=dr.delegation_id) AS turns,
    COALESCE(json_extract(child.data,'$.selection.provider'),'') AS provider,
    COALESCE(json_extract(child.data,'$.selection.model'),'') AS model,
    COALESCE(json_extract(d.data,'$.workspace'),'') AS workspace,
    COALESCE(json_extract(cs.data,'$.workingCopyName'),'') AS working_copy_name,
    child.data AS run_data,
    child.position AS sort_pos,
    dr.created_at AS sort_at
  FROM runs parent
  JOIN delegation_runs dr ON dr.parent_run_id=parent.id
  JOIN delegations d ON d.id=dr.delegation_id
  JOIN runs child ON child.id=dr.child_run_id
  JOIN chats chat ON chat.id=child.chat_id
  LEFT JOIN sessions cs ON cs.id=child.session_id
  WHERE parent.chat_id=?
  UNION ALL
  SELECT d.parent_run_id AS parent_run_id,
    d.id AS delegation_id,
    child.id AS run_id,
    child.session_id AS session_id,
    child.chat_id AS chat_id,
    child.agent_id AS agent_id,
    json_extract(chat.data,'$.title') AS title,
    child.status AS status,
    1 AS turn,
    1 AS turns,
    COALESCE(json_extract(child.data,'$.selection.provider'),'') AS provider,
    COALESCE(json_extract(child.data,'$.selection.model'),'') AS model,
    COALESCE(json_extract(d.data,'$.workspace'),'') AS workspace,
    COALESCE(json_extract(cs.data,'$.workingCopyName'),'') AS working_copy_name,
    child.data AS run_data,
    child.position AS sort_pos,
    COALESCE(json_extract(child.data,'$.createdAt'),'') AS sort_at
  FROM runs parent
  JOIN delegations d ON d.parent_run_id=parent.id
  JOIN runs child ON child.command_id=?||d.id AND child.chat_id=json_extract(d.data,'$.chatId')
  JOIN chats chat ON chat.id=child.chat_id
  LEFT JOIN sessions cs ON cs.id=child.session_id
  WHERE parent.chat_id=?
    AND NOT EXISTS(SELECT 1 FROM delegation_runs dr WHERE dr.child_run_id=child.id)
) ORDER BY sort_pos, sort_at`, chatID, model.DelegationCommandPrefix, chatID)
	if err != nil {
		return view, err
	}
	defer rows.Close()
	for rows.Next() {
		var parentID, rawRun string
		var child model.DelegatedRun
		if err := rows.Scan(
			&parentID, &child.DelegationID, &child.RunID, &child.SessionID, &child.ChatID,
			&child.AgentID, &child.Title, &child.Status, &child.Turn, &child.Turns,
			&child.Provider, &child.Model, &child.Workspace, &child.WorkingCopyName, &rawRun,
		); err != nil {
			return view, err
		}
		child.Summary = runSummaryExcerpt(rawRun, 180)
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
	rows, err := tx.Query(`SELECT DISTINCT chat_id FROM (
  SELECT parent.chat_id AS chat_id
  FROM delegation_runs dr
  JOIN runs parent ON parent.id=dr.parent_run_id
  WHERE dr.child_run_id=?
  UNION
  SELECT parent.chat_id AS chat_id
  FROM runs child
  JOIN delegations d ON d.id=substr(child.command_id,length(?)+1) AND child.command_id=?||d.id
    AND child.chat_id=json_extract(d.data,'$.chatId')
  JOIN runs parent ON parent.id=d.parent_run_id
  WHERE child.id=?
)`, runID, model.DelegationCommandPrefix, model.DelegationCommandPrefix, runID)
	if err != nil {
		return err
	}
	var chats []string
	for rows.Next() {
		var source string
		if err := rows.Scan(&source); err != nil {
			rows.Close()
			return err
		}
		chats = append(chats, source)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, source := range chats {
		if err := Event(tx, model.Event{Type: "delegations", ChatID: source}); err != nil {
			return err
		}
	}
	return nil
}
