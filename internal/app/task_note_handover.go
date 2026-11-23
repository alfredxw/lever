package app

import (
	"context"
	"database/sql"
	"errors"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) NoteHandover(ctx context.Context, id string) (model.NoteHandover, error) {
	if !taskIDPattern.MatchString(id) {
		return model.NoteHandover{}, invalid("Choose a note")
	}
	var settings model.NoteHandover
	err := a.Store.DB.QueryRowContext(ctx, `SELECT COALESCE(agent_id,''),COALESCE(chat_id,''),one_click FROM note_handovers WHERE note_id=?`, id).
		Scan(&settings.AgentID, &settings.ChatID, &settings.OneClick)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return settings, err
}

func (a *App) SaveNoteHandover(ctx context.Context, id string, settings model.NoteHandover) (model.NoteHandover, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	if _, err := a.taskNote(ctx, id); err != nil {
		return model.NoteHandover{}, err
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if settings.AgentID == "" {
			if settings.ChatID != "" {
				return invalid("Select the Agent that owns this Chat")
			}
		} else {
			agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", settings.AgentID)
			if errors.Is(err, sql.ErrNoRows) || agent.Archived {
				return invalid("Select an active Agent")
			}
			if err != nil {
				return err
			}
			if settings.ChatID != "" {
				if _, err := handoverChat(ctx, tx, settings.ChatID, settings.AgentID); err != nil {
					return err
				}
			}
		}
		var err error
		if settings == (model.NoteHandover{}) {
			_, err = tx.ExecContext(ctx, "DELETE FROM note_handovers WHERE note_id=?", id)
		} else {
			_, err = tx.ExecContext(ctx, `INSERT INTO note_handovers(note_id,agent_id,chat_id,one_click) VALUES(?,NULLIF(?,''),NULLIF(?,''),?)
ON CONFLICT(note_id) DO UPDATE SET agent_id=excluded.agent_id,chat_id=excluded.chat_id,one_click=excluded.one_click`, id, settings.AgentID, settings.ChatID, settings.OneClick)
		}
		if err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "note-handover", TaskNoteID: id})
	})
	return settings, err
}

func configuredNoteChat(ctx context.Context, q store.Queryer, noteID, agentID string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, "SELECT chat_id FROM note_handovers WHERE note_id=? AND agent_id=? AND chat_id IS NOT NULL", noteID, agentID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return id, err
}

func handoverChat(ctx context.Context, q store.Queryer, id, agentID string) (model.Chat, error) {
	chat, err := store.Get[model.Chat](ctx, q, "SELECT data FROM chats WHERE id=?", id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (chat.AgentID != agentID || chat.Channel != "")) {
		return model.Chat{}, invalid("Select an existing Lever Chat owned by this Agent")
	}
	return chat, err
}

// Resolve the explicit Chat chosen for a note handover. A queued task keeps
// its chosen Chat, while direct dispatches read the note's current handover.
func explicitNoteHandoverChat(ctx context.Context, q store.Queryer, task model.TaskDispatch, queued *queuedTask) (model.Chat, error) {
	var id string
	if queued != nil {
		id = queued.DestinationChatID
	} else {
		var err error
		id, err = configuredNoteChat(ctx, q, task.NoteID, task.AgentID)
		if err != nil {
			return model.Chat{}, err
		}
	}
	if id == "" {
		return model.Chat{}, nil
	}
	return handoverChat(ctx, q, id, task.AgentID)
}

func noteDedicatedChat(ctx context.Context, q store.Queryer, agentID, noteID string) (model.Chat, error) {
	chat, err := store.Get[model.Chat](ctx, q, `SELECT data FROM chats
WHERE agent_id=? AND json_type(data,'$.noteId')='text' AND json_extract(data,'$.noteId')=?`, agentID, noteID)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return chat, err
}
