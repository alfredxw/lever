package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"golang.org/x/net/html"

	"lever/internal/model"
)

// Bare URLs are already visible text. Parse their escapes and entities like any other text.
var titleMarkdown = goldmark.New(goldmark.WithExtensions(extension.Strikethrough, extension.Table, extension.TaskList))

// The empty owner distinguishes a user-supplied title, even the literal "New chat".
const ChatDisplayData = `CASE WHEN title_run_id='' THEN json_set(data,'$.titleIsCustom',json('true')) ELSE data END`

func messageSource(run model.Run) (text string, markdown bool) {
	switch {
	case strings.TrimSpace(run.Input) != "":
		return run.Input, true
	case len(run.Attachments) > 0:
		return run.Attachments[0].Name, false
	case len(run.References) > 0:
		return run.References[0].Name, false
	case run.Quote != nil:
		return run.Quote.Text, true
	default:
		return "", false
	}
}

func promptTitle(run model.Run) string {
	source, markdown := messageSource(run)
	if !markdown {
		return source
	}
	var rendered bytes.Buffer
	if err := titleMarkdown.Convert([]byte(source), &rendered); err != nil {
		return source
	}
	var text strings.Builder
	tokens := html.NewTokenizer(&rendered)
	for kind := tokens.Next(); kind != html.ErrorToken; kind = tokens.Next() {
		switch kind {
		case html.TextToken:
			text.Write(tokens.Text())
		case html.StartTagToken, html.SelfClosingTagToken:
			token := tokens.Token()
			switch token.Data {
			case "br":
				text.WriteByte(' ')
			case "img":
				for _, attr := range token.Attr {
					if attr.Key == "alt" {
						text.WriteString(attr.Val)
					}
				}
			}
		}
	}
	if label := strings.Join(strings.Fields(text.String()), " "); label != "" {
		return label
	}
	return strings.TrimSpace(source)
}

// ChatTitle is the generated label for a Chat's first message.
func ChatTitle(run model.Run) string {
	return clipChatTitle(promptTitle(run))
}

func clipChatTitle(text string) string {
	runes := []rune(text)
	return string(runes[:min(len(runes), 48)])
}

// SeedChatTitle remembers which message supplied the placeholder, including
// when a Chat starts with a Topic. An explicitly named Chat has no such owner.
func SeedChatTitle(tx *sql.Tx, chat *model.Chat, run, previous model.Run) error {
	if run.Quiet || (chat.Source != "user" && chat.Source != "") || (chat.Title != "New chat" && previous.ID == "") {
		return nil
	}
	var owner sql.NullString
	if err := tx.QueryRow("SELECT title_run_id FROM chats WHERE id=?", chat.ID).Scan(&owner); err != nil {
		return err
	}
	if owner.Valid {
		if owner.String == "" || owner.String != previous.ID {
			return nil
		}
	} else {
		// Older databases did not record the source. Preserve their existing
		// first-message edit behavior only when the old placeholder still matches.
		if previous.ID != "" && chat.Title != ChatTitle(previous) {
			return nil
		}
		var first bool
		if err := tx.QueryRow(`SELECT NOT EXISTS(SELECT 1 FROM runs WHERE chat_id=? AND position<? AND status NOT IN ('steering','steered','cancelled')
AND COALESCE(json_extract(data,'$.quiet'),0)=0
UNION ALL SELECT 1 FROM comparisons WHERE chat_id=? AND position<?)`, chat.ID, run.Sequence, chat.ID, run.Sequence).Scan(&first); err != nil || !first {
			return err
		}
	}
	chat.Title = ChatTitle(run)
	_, err := tx.Exec("UPDATE chats SET title_run_id=? WHERE id=?", run.ID, chat.ID)
	return err
}

// TitlePrompt contains only the visible user input, without runtime instructions,
// replayed history, or file contents.
func TitlePrompt(run model.Run) string {
	text := []rune(promptTitle(run))
	return string(text[:min(len(text), 2048)])
}

func needsConversationTitle(ctx context.Context, q Queryer, run model.Run) (bool, error) {
	var needed bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sessions
WHERE id=? AND title_run_id=? AND COALESCE(json_extract(data,'$.title'),'')='')
OR EXISTS(SELECT 1 FROM chats WHERE title_run_id=? AND json_extract(data,'$.title')=?)`,
		run.SessionID, run.ID, run.ID, ChatTitle(run)).Scan(&needed)
	return needed, err
}

func (s *Store) NeedsConversationTitle(ctx context.Context, run model.Run) (bool, error) {
	return needsConversationTitle(ctx, s.DB, run)
}

func sessionTitleOwner(ctx context.Context, q Queryer, run model.Run) (model.Run, bool, error) {
	var superseded bool
	if err := q.QueryRowContext(ctx, "SELECT COALESCE(json_extract(data,'$.superseded'),0) FROM runs WHERE id=?", run.ID).Scan(&superseded); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Run{}, false, nil
		}
		return model.Run{}, false, err
	}
	if superseded {
		return model.Run{}, false, nil
	}
	var ownerID string
	err := q.QueryRowContext(ctx, `SELECT r.id FROM runs r WHERE r.session_id=? AND COALESCE(json_extract(r.data,'$.superseded'),0)=0
AND (
  EXISTS(SELECT 1 FROM sessions s WHERE s.id=r.session_id AND s.title_run_id=r.id AND COALESCE(json_extract(s.data,'$.title'),'')='')
  OR EXISTS(SELECT 1 FROM chats c WHERE c.title_run_id=r.id)
) ORDER BY CASE WHEN r.id=? THEN 0 ELSE 1 END, r.position LIMIT 1`, run.SessionID, run.ID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Run{}, false, nil
	}
	if err != nil {
		return model.Run{}, false, err
	}
	owner := run
	if ownerID != run.ID {
		owner, err = Get[model.Run](ctx, q, "SELECT data FROM runs WHERE id=?", ownerID)
		if err != nil {
			return model.Run{}, false, err
		}
	}
	needed, err := needsConversationTitle(ctx, q, owner)
	if err != nil || !needed {
		return model.Run{}, false, err
	}
	return owner, true, nil
}

// Apply only to the placeholders still owned by this input. Activity timestamps,
// message previews and unread cursors are independent of title changes.
func (s *Store) SaveConversationTitle(ctx context.Context, run model.Run, title string) error {
	return s.Write(ctx, func(tx *sql.Tx) error {
		return saveConversationTitle(tx, run, title)
	})
}

// SaveSessionTitle saves a native runtime-reported title for either this run
// or an earlier non-superseded root run in the same session whose placeholder
// still has not been named (e.g. a fast first turn followed by a resume update).
func (s *Store) SaveSessionTitle(ctx context.Context, run model.Run, title string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return nil
	}
	if _, needed, err := sessionTitleOwner(ctx, s.DB, run); err != nil || !needed {
		return err
	}
	return s.Write(ctx, func(tx *sql.Tx) error {
		owner, needed, err := sessionTitleOwner(ctx, tx, run)
		if err != nil || !needed {
			return err
		}
		return saveConversationTitle(tx, owner, title)
	})
}

func saveConversationTitle(tx *sql.Tx, run model.Run, title string) error {
	r, err := tx.Exec(`UPDATE sessions SET data=json_set(data,'$.title',?),activity=json_set(activity,'$.title',?)
WHERE id=? AND title_run_id=? AND COALESCE(json_extract(data,'$.title'),'')=''`, title, title, run.SessionID, run.ID)
	if err != nil {
		return err
	}
	topics, err := r.RowsAffected()
	if err != nil {
		return err
	}
	rows, err := tx.Query(`UPDATE chats SET data=json_set(data,'$.title',?)
WHERE title_run_id=? AND json_extract(data,'$.title')=? AND json_extract(data,'$.title')<>? RETURNING id`, title, run.ID, ChatTitle(run), title)
	if err != nil {
		return err
	}
	defer rows.Close()
	changed := make(map[string]bool)
	if topics != 0 {
		changed[run.ChatID] = true
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		changed[id] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for id := range changed {
		if id == run.ChatID && topics == 0 {
			if _, err := tx.Exec(`UPDATE sessions SET activity=json_set(activity,'$.title',?)
WHERE id=? AND kind='main' AND activity IS NOT NULL`, title, run.SessionID); err != nil {
				return err
			}
		}
		if err := Event(tx, model.Event{Type: "conversation-title", ChatID: id, SessionID: run.SessionID}); err != nil {
			return err
		}
	}
	return nil
}

// The original full input is needed to resolve markup that crossed the old title limit.
func backfillMessageTitles(tx *sql.Tx) error {
	var version int
	if err := tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version >= 6 {
		return err
	}
	rows, err := tx.Query(`
WITH titles(kind, id, title, root) AS (
  SELECT 'chat', c.id, json_extract(c.data,'$.title'), (
    SELECT id FROM runs WHERE chat_id=c.id AND position IS NOT NULL ORDER BY position LIMIT 1
  ) FROM chats c WHERE COALESCE(json_extract(c.data,'$.source'),'') IN ('','user','comparison')
  UNION ALL
  SELECT 'session', s.id, json_extract(s.activity,'$.title'), (
    SELECT id FROM runs WHERE session_id=s.id AND position IS NOT NULL
    AND status NOT IN ('queued','steering','steered','cancelled') ORDER BY position LIMIT 1
  ) FROM sessions s WHERE COALESCE(json_extract(s.data,'$.title'),'')=''
)
SELECT t.kind,t.id,t.title,json_object(
  'input',json_extract(r.data,'$.input'), 'attachments',json_extract(r.data,'$.attachments'),
  'references',json_extract(r.data,'$.references'), 'quote',json_extract(r.data,'$.quote')
) FROM titles t JOIN runs r ON r.id=t.root WHERE t.title<>''`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type change struct{ query, id, title string }
	var changes []change
	for rows.Next() {
		var kind, id, title, data string
		if err := rows.Scan(&kind, &id, &title, &data); err != nil {
			return err
		}
		var run model.Run
		if err := json.Unmarshal([]byte(data), &run); err != nil {
			return err
		}
		source, markdown := messageSource(run)
		if !markdown {
			continue
		}
		var label, query string
		if kind == "chat" {
			// A Chat may have been named explicitly. Match its former generated title.
			if strings.TrimSpace(run.Input) != "" {
				source = strings.TrimSpace(source)
			}
			if title != clipChatTitle(source) {
				continue
			}
			label = ChatTitle(run)
			query = "UPDATE chats SET data=json_set(data,'$.title',?) WHERE id=?"
		} else {
			label = messagePreview(promptTitle(run))
			query = "UPDATE sessions SET activity=json_set(activity,'$.title',?) WHERE id=?"
		}
		if label != title {
			changes = append(changes, change{query, id, label})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, change := range changes {
		if _, err := tx.Exec(change.query, change.title, change.id); err != nil {
			return err
		}
	}
	_, err = tx.Exec("PRAGMA user_version=6")
	return err
}
