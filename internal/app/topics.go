package app

import (
	"context"
	"database/sql"
	"errors"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) CreateTopicFromRun(ctx context.Context, chatID, sourceRunID string) (model.SessionView, error) {
	if sourceRunID == "" {
		return model.SessionView{}, invalid("Choose a message to start the Topic")
	}
	var topicID string
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT id FROM sessions
WHERE chat_id=? AND kind='topic' AND json_extract(data,'$.sourceRunId')=?`, chatID, sourceRunID).Scan(&topicID)
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		source, err := store.Get[model.Run](ctx, tx, `SELECT r.data FROM runs r JOIN sessions s ON s.id=r.session_id
WHERE r.id=? AND r.chat_id=? AND s.kind='main'`, sourceRunID, chatID)
		if err != nil {
			return err
		}
		if source.Status != "completed" || source.Superseded {
			return conflict("Only completed turns in the current Chat history can start a Topic")
		}
		chat, err := store.Get[model.Chat](ctx, tx, "SELECT data FROM chats WHERE id=?", chatID)
		if err != nil {
			return err
		}
		if err := checkDesktopChat(chat); err != nil {
			return err
		}
		agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", chat.AgentID)
		if err != nil {
			return err
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		main, err := store.Get[model.Session](ctx, tx, "SELECT data FROM sessions WHERE id=?", source.SessionID)
		if err != nil {
			return err
		}
		topicID = ID()
		defaultSel, err := agentDefaultSelection(ctx, tx, agent)
		if err != nil {
			return err
		}
		session := model.Session{
			ID: topicID, ChatID: chat.ID, AgentID: agent.ID, Kind: "topic", CreatedAt: now(),
			Title: store.ChatTitle(source), SourceRunID: source.ID, ProjectID: main.ProjectID, Scope: main.Scope,
			WorkingCopyID: main.WorkingCopyID, WorkingCopyName: main.WorkingCopyName,
			Selection: defaultSel,
		}
		return store.InsertTopicFromRun(tx, session, source)
	})
	if err != nil {
		return model.SessionView{}, err
	}
	return a.Store.SessionView(ctx, topicID)
}
