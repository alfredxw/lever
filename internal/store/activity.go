package store

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"lever/internal/model"
)

// Fixed precision keeps timestamps sortable, including records restored from
// the variable-precision timestamps used by older versions.
const activityTime = "2006-01-02T15:04:05.000000000Z"

// Read the main Chat name and comparison origin from their owners, including
// for activity saved by older versions and for incremental event delivery.
const ConversationQuery = `SELECT COALESCE(CASE
  WHEN s.kind='main' THEN json_set(s.activity,'$.title',json_extract(c.data,'$.title'))
  WHEN json_type(s.data,'$.comparison')='object' THEN json_set(s.activity,'$.comparison',json_extract(s.data,'$.comparison'))
  ELSE s.activity END,'null') FROM sessions s JOIN chats c ON c.id=s.chat_id`

type sidebarMessage struct{ key, text string }

func lastMessage(run model.Run) sidebarMessage {
	for i := len(run.Items) - 1; i >= 0; i-- {
		if item := run.Items[i]; item.Kind == "user" && item.Message != nil {
			message := lastMessage(model.Run{Input: item.Message.Input, Attachments: item.Message.Attachments, References: item.Message.References, Quote: item.Message.Quote})
			message.key = "user:" + item.ID
			return message
		}
		if item := run.Items[i]; item.Kind == "text" && strings.TrimSpace(item.Text) != "" {
			return sidebarMessage{"assistant:" + item.ID, item.Text}
		}
	}
	text, _ := messageSource(run)
	return sidebarMessage{"user", text}
}

func messagePreview(text string) string {
	runes := []rune(strings.Join(strings.Fields(text), " "))
	if len(runes) > 160 {
		return string(runes[:160]) + "…"
	}
	return string(runes)
}

func saveActivity(tx *sql.Tx, activity model.Conversation) error {
	_, err := tx.Exec("UPDATE sessions SET activity=? WHERE id=?", JSON(activity), activity.ID)
	return err
}

func updateActivity(tx *sql.Tx, previous, run model.Run) error {
	if run.Quiet && previous.Sequence == 0 {
		// Keep the session discoverable from its Chat and history without replacing
		// an existing conversation's preview, recency or unread cursor.
		_, err := tx.Exec(`UPDATE sessions SET activity=json_object(
  'id',id,'agentId',?,'chatId',chat_id,'kind',kind,'title',COALESCE(json_extract(data,'$.title'),''),
  'backgroundOnly',json('true'),'unreadSequence',0,'messageAt','')
WHERE id=? AND activity IS NULL`, run.AgentID, run.SessionID)
		if err != nil {
			return err
		}
	}
	if run.Quiet && run.Status != "failed" && run.Status != "unknown" && run.Status != "waiting_user" {
		return nil
	}
	if run.Superseded || run.Status == "steering" || run.Status == "steered" {
		return nil
	}
	if run.Status == "cancelled" {
		_, err := tx.Exec(`UPDATE sessions SET activity=NULL, title_run_id=NULL
WHERE id=? AND activity IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs WHERE session_id=? AND status NOT IN ('steering','steered','cancelled')
)`, run.SessionID, run.SessionID)
		return err
	}
	if run.Status == "queued" {
		if len(run.AfterRunIDs) == 0 {
			return nil
		}
		return updateWaitingActivity(tx, run)
	}
	message := lastMessage(run)
	messageChanged := previous.Sequence == 0 || previous.Status == "queued" || message != lastMessage(previous)
	finished := run.Status != previous.Status && (!model.Active(run.Status) || run.Status == "unknown")
	if run.Quiet && finished {
		messageChanged = true
		if run.Error != "" {
			message.text = run.Error
		}
	}
	if !messageChanged && !finished {
		return nil
	}
	activity, err := Get[model.Conversation](context.Background(), tx, "SELECT COALESCE(activity,'null') FROM sessions WHERE id=?", run.SessionID)
	if err != nil {
		return err
	}
	if activity.ID == "" {
		var kind, title string
		if err := tx.QueryRow("SELECT kind,COALESCE(json_extract(data,'$.title'),'') FROM sessions WHERE id=?", run.SessionID).Scan(&kind, &title); err != nil {
			return err
		}
		activity = model.Conversation{ID: run.SessionID, ChatID: run.ChatID, AgentID: run.AgentID, Kind: kind, Title: title}
	}
	if activity.Title == "" {
		activity.Title = messagePreview(promptTitle(run))
		if activity.Kind == "topic" {
			if _, err := tx.Exec("UPDATE sessions SET title_run_id=? WHERE id=?", run.ID, run.SessionID); err != nil {
				return err
			}
		}
	}
	if messageChanged || activity.BackgroundOnly {
		activity.Preview = messagePreview(message.text)
		activity.MessageAt = time.Now().UTC().Format(activityTime)
	}
	activity.BackgroundOnly = false
	if finished {
		if !model.Active(run.Status) {
			activity.FinishedAt = run.FinishedAt
		}
		if err := tx.QueryRow("SELECT MAX(sequence) FROM events").Scan(&activity.UnreadSequence); err != nil {
			return err
		}
	}
	return saveActivity(tx, activity)
}

func updateWaitingActivity(tx *sql.Tx, run model.Run) error {
	activity, err := Get[model.Conversation](context.Background(), tx, "SELECT COALESCE(activity,'null') FROM sessions WHERE id=?", run.SessionID)
	if err != nil {
		return err
	}
	var kind, sessionTitle, titleRunID string
	if err := tx.QueryRow("SELECT kind,COALESCE(json_extract(data,'$.title'),''),COALESCE(title_run_id,'') FROM sessions WHERE id=?", run.SessionID).Scan(&kind, &sessionTitle, &titleRunID); err != nil {
		return err
	}
	if activity.ID == "" {
		activity = model.Conversation{
			ID:        run.SessionID,
			ChatID:    run.ChatID,
			AgentID:   run.AgentID,
			Kind:      kind,
			Title:     sessionTitle,
			Preview:   messagePreview(lastMessage(run).text),
			MessageAt: time.Now().UTC().Format(activityTime),
		}
		if activity.Title == "" {
			activity.Title = messagePreview(promptTitle(run))
			if kind == "topic" {
				if _, err := tx.Exec("UPDATE sessions SET title_run_id=? WHERE id=?", run.ID, run.SessionID); err != nil {
					return err
				}
			}
		}
		return saveActivity(tx, activity)
	}
	if titleRunID == run.ID {
		if sessionTitle == "" {
			activity.Title = messagePreview(promptTitle(run))
		}
		activity.Preview = messagePreview(lastMessage(run).text)
		return saveActivity(tx, activity)
	}
	return nil
}

// Backfill sessions that predate the projection, then upgrade any existing
// titles. Subsequent starts do not scan those transcripts again.
func (s *Store) backfillActivity() error {
	ctx := context.Background()
	return s.Write(ctx, func(tx *sql.Tx) error {
		var hasActivity bool
		if err := tx.QueryRow("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='activity'").Scan(&hasActivity); err != nil {
			return err
		}
		if !hasActivity {
			if _, err := tx.Exec("ALTER TABLE sessions ADD COLUMN activity TEXT"); err != nil {
				return err
			}
		}
		sessions, err := List[model.Session](ctx, tx, "SELECT json_set(s.data,'$.id',s.id,'$.chatId',s.chat_id,'$.kind',s.kind,'$.agentId',c.agent_id) FROM sessions s JOIN chats c ON c.id=s.chat_id WHERE s.activity IS NULL")
		if err != nil {
			return err
		}
		var cursor int64
		if err := tx.QueryRow("SELECT COALESCE(MAX(sequence),0) FROM events").Scan(&cursor); err != nil {
			return err
		}
		for _, session := range sessions {
			runs, err := List[model.Run](ctx, tx, "SELECT data FROM runs WHERE session_id=? AND position IS NOT NULL AND status NOT IN ('queued','steering','steered','cancelled') ORDER BY position", session.ID)
			if err != nil {
				return err
			}
			activity := model.Conversation{ID: session.ID, ChatID: session.ChatID, AgentID: session.AgentID, Kind: session.Kind, Title: session.Title}
			// The old Chat cursor is the best available historical read boundary.
			// Preserve it rather than making every old Topic newly unread.
			var legacyCursor int64
			if err := tx.QueryRow("SELECT COALESCE(json_extract(data,'$.activity.finishedSequence'),?) FROM chats WHERE id=?", cursor, session.ChatID).Scan(&legacyCursor); err != nil {
				return err
			}
			for _, run := range runs {
				if activity.Title == "" {
					activity.Title = messagePreview(promptTitle(run))
				}
				stamp := run.CreatedAt
				message := lastMessage(run)
				if message.key != "user" && run.FinishedAt != "" {
					stamp = run.FinishedAt
				}
				parsed, err := time.Parse(time.RFC3339Nano, stamp)
				if err != nil {
					return err
				}
				stamp = parsed.UTC().Format(activityTime)
				if stamp >= activity.MessageAt {
					activity.Preview = messagePreview(message.text)
					activity.MessageAt = stamp
				}
				if !model.Active(run.Status) || run.Status == "unknown" {
					activity.UnreadSequence = legacyCursor
				}
				if !model.Active(run.Status) && run.FinishedAt != "" {
					activity.FinishedAt = run.FinishedAt
				}
			}
			if err := saveActivity(tx, activity); err != nil {
				return err
			}
		}
		return backfillMessageTitles(tx)
	})
}

func requestActivity(tx *sql.Tx, request model.Request) error {
	if request.Status != "pending" {
		return nil
	}
	activity, err := Get[model.Conversation](context.Background(), tx, "SELECT activity FROM sessions WHERE id=?", request.SessionID)
	if err != nil {
		return err
	}
	activity.Preview = messagePreview(request.Title)
	activity.BackgroundOnly = false
	activity.MessageAt = time.Now().UTC().Format(activityTime)
	if err := tx.QueryRow("SELECT MAX(sequence) FROM events").Scan(&activity.UnreadSequence); err != nil {
		return err
	}
	return saveActivity(tx, activity)
}
