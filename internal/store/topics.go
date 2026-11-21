package store

import (
	"context"
	"database/sql"
	"time"

	"lever/internal/model"
)

func InsertTopicFromRun(tx *sql.Tx, session model.Session, source model.Run) error {
	activity := model.Conversation{
		ID: session.ID, ChatID: session.ChatID, AgentID: session.AgentID, Kind: session.Kind,
		Title: session.Title, Preview: messagePreview(lastMessage(source).text),
		MessageAt: time.Now().UTC().Format(activityTime),
	}
	if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data,activity) VALUES(?,?,?,?,?)", session.ID, session.ChatID, session.Kind, JSON(session), JSON(activity)); err != nil {
		return err
	}
	return Event(tx, model.Event{Type: "topic-created", ChatID: session.ChatID, SessionID: session.ID})
}

func ReadTopicSource(ctx context.Context, q Queryer, session model.Session) (*model.TopicSource, error) {
	// Edits preserve the original row by ID after removing it from the active timeline.
	run, err := Get[model.Run](ctx, q, "SELECT data FROM runs WHERE id=? AND chat_id=?", session.SourceRunID, session.ChatID)
	if err != nil {
		return nil, err
	}
	source := &model.TopicSource{Message: *run.UserMessage(), Items: []model.Item{}, FinishedAt: run.FinishedAt}
	for _, item := range run.Items {
		if item.Status == "completed" && (item.Kind == "text" || (item.Kind == "user" && item.Message != nil)) {
			source.Items = append(source.Items, item)
		}
	}
	return source, nil
}
