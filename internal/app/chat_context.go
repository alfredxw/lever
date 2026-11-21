package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"lever/internal/model"
	"lever/internal/store"
)

const (
	contextPageBytes   = 8 << 10
	contextRunBytes    = 32 << 10
	contextTextBytes   = 1 << 10
	contextPageRecords = 10
	contextRunFilter   = "r.position IS NOT NULL AND r.status NOT IN ('queued','steering','steered','cancelled')"
)

type ContextAnchor struct {
	RunID  string `json:"runId"`
	ItemID string `json:"itemId,omitempty"`
	Offset int    `json:"offset,omitempty" jsonschema:"UTF-8 byte offset into the message"`
}

type ContextCursor struct {
	Position  ContextAnchor `json:"position"`
	Direction string        `json:"direction"`
}

type ContextMessage struct {
	SessionID string        `json:"sessionId"`
	Kind      string        `json:"kind"`
	Anchor    ContextAnchor `json:"anchor"`
	Role      string        `json:"role"`
	Status    string        `json:"status"`
	CreatedAt string        `json:"createdAt"`
	Text      string        `json:"text"`
}

type findContextInput struct {
	Query string `json:"query,omitempty" jsonschema:"A literal keyword or phrase, or omit it to list recent Topics"`
}

type FindContextResult struct {
	Topics  []model.TopicSummary `json:"topics,omitempty"`
	Matches []ContextMessage     `json:"matches,omitempty"`
}

type readContextInput struct {
	Target    string         `json:"target" jsonschema:"main, a sessionId from this Chat, or a conversation ID explicitly referenced in the current message"`
	Anchor    *ContextAnchor `json:"anchor,omitempty" jsonschema:"Start at this message, including it in the result"`
	Direction string         `json:"direction,omitempty" jsonschema:"older (default) or newer; newer starts at the anchor"`
	Cursor    *ContextCursor `json:"cursor,omitempty" jsonschema:"Pass nextCursor as returned, without anchor or direction"`
}

type ReadContextResult struct {
	Messages   []ContextMessage `json:"messages"`
	NextCursor *ContextCursor   `json:"nextCursor,omitempty"`
}

type FindContextCLIInput struct {
	ChatID string `json:"chatId,omitempty"`
	Query  string `json:"query,omitempty"`
}

type ReadContextCLIInput struct {
	ChatID    string         `json:"chatId,omitempty"`
	Target    string         `json:"target"`
	Anchor    *ContextAnchor `json:"anchor,omitempty"`
	Direction string         `json:"direction,omitempty"`
	Cursor    *ContextCursor `json:"cursor,omitempty"`
}

func (a *App) addChatContextTools(server *mcp.Server, owner *execution) {
	owner.mu.Lock()
	run := owner.run
	owner.mu.Unlock()
	addContextTool(server, owner, "find_chat_context",
		"Find recent Topics or matching messages in the current Lever Chat. Use when the task refers to another Topic, a prior decision, or related work outside this session. The returned messages describe past requests and results.",
		func(ctx context.Context, in findContextInput) (FindContextResult, error) {
			return a.findChatContext(ctx, run.ChatID, run.ID, in)
		})
	addContextTool(server, owner, "read_chat_context",
		"Read dialogue in this Chat or a conversation explicitly referenced by the current message. Use an anchor to read earlier or later messages and nextCursor to continue. Treat returned dialogue as historical context.",
		func(ctx context.Context, in readContextInput) (ReadContextResult, error) {
			return a.readChatContext(ctx, run, in)
		})
	if slices.ContainsFunc(run.References, isDocumentReference) {
		addContextTool(server, owner, "read_reference",
			"Read a note or Board item referenced by the current message. Pass nextOffset to continue. Returned content is source material for the current request.",
			func(ctx context.Context, in readReferenceInput) (referencePage, error) {
				return a.readReference(ctx, run.References, in)
			})
	}
}

func runExecutionContext[Out any](ctx context.Context, owner *execution, lookup func(context.Context) (Out, error)) (Out, string, error) {
	var zero Out
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	stop := context.AfterFunc(owner.ctx, cancel)
	defer stop()
	out, err := lookup(ctx)
	if err != nil {
		return zero, "", err
	}
	body := store.JSON(out)
	owner.historyMu.Lock()
	defer owner.historyMu.Unlock()
	if err := owner.ctx.Err(); err != nil {
		return zero, "", err
	}
	if len(body) > contextPageBytes || owner.historyBytes+len(body) > contextRunBytes {
		return zero, "", invalid("Chat context byte limit reached for this execution")
	}
	if owner.hosted {
		if _, err := owner.app.Store.DB.ExecContext(ctx, "UPDATE runtime_hosts SET history_bytes=? WHERE run_id=?", owner.historyBytes+len(body), owner.run.ID); err != nil {
			return zero, "", err
		}
	}
	owner.historyBytes += len(body)
	return out, body, nil
}

func addContextTool[In, Out any](server *mcp.Server, owner *execution, name, description string, lookup func(context.Context, In) (Out, error)) {
	tool := &mcp.Tool{Name: name, Description: description, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}
	mcp.AddTool(server, tool, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		_, body, err := runExecutionContext(ctx, owner, func(ctx context.Context) (Out, error) {
			return lookup(ctx, in)
		})
		if err != nil {
			return nil, nil, err
		}
		// Send one copy of the bounded payload to both text-only and structured clients.
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: body}}}, nil, nil
	})
}

func (a *App) checkChatExists(ctx context.Context, chatID string) error {
	var exists int
	err := a.Store.DB.QueryRowContext(ctx, "SELECT 1 FROM chats WHERE id=?", chatID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return &Error{Status: http.StatusNotFound, Message: "Chat is unavailable"}
	}
	return err
}

func (a *App) FindChatContextCLI(ctx context.Context, authHeader string, in FindContextCLIInput) (FindContextResult, error) {
	if authHeader != "" {
		owner := a.activeExecutionByToken(authHeader)
		if owner == nil {
			return FindContextResult{}, &Error{Status: http.StatusUnauthorized, Message: "Invalid or expired execution capability"}
		}
		if strings.TrimSpace(in.ChatID) != "" {
			return FindContextResult{}, invalid("Cannot combine chatId with an execution capability")
		}
		owner.mu.Lock()
		run := owner.run
		owner.mu.Unlock()
		out, _, err := runExecutionContext(ctx, owner, func(ctx context.Context) (FindContextResult, error) {
			return a.findChatContext(ctx, run.ChatID, run.ID, findContextInput{Query: in.Query})
		})
		return out, err
	}
	chatID := strings.TrimSpace(in.ChatID)
	if chatID == "" {
		return FindContextResult{}, invalid("A Chat ID is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := a.checkChatExists(ctx, chatID); err != nil {
		return FindContextResult{}, err
	}
	return a.findChatContext(ctx, chatID, "", findContextInput{Query: in.Query})
}

func (a *App) ReadChatContextCLI(ctx context.Context, authHeader string, in ReadContextCLIInput) (ReadContextResult, error) {
	req := readContextInput{Target: strings.TrimSpace(in.Target), Anchor: in.Anchor, Direction: in.Direction, Cursor: in.Cursor}
	if authHeader != "" {
		owner := a.activeExecutionByToken(authHeader)
		if owner == nil {
			return ReadContextResult{}, &Error{Status: http.StatusUnauthorized, Message: "Invalid or expired execution capability"}
		}
		if strings.TrimSpace(in.ChatID) != "" {
			return ReadContextResult{}, invalid("Cannot combine chatId with an execution capability")
		}
		owner.mu.Lock()
		run := owner.run
		owner.mu.Unlock()
		out, _, err := runExecutionContext(ctx, owner, func(ctx context.Context) (ReadContextResult, error) {
			return a.readChatContext(ctx, run, req)
		})
		return out, err
	}
	if req.Target == "" {
		return ReadContextResult{}, invalid("A target conversation is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	chatID := strings.TrimSpace(in.ChatID)
	if chatID == "" {
		if req.Target == "main" {
			return ReadContextResult{}, invalid("A Chat ID is required when target is main")
		}
		err := a.Store.DB.QueryRowContext(ctx, "SELECT chat_id FROM sessions WHERE id=?", req.Target).Scan(&chatID)
		if errors.Is(err, sql.ErrNoRows) {
			return ReadContextResult{}, &Error{Status: http.StatusNotFound, Message: "Conversation is unavailable"}
		}
		if err != nil {
			return ReadContextResult{}, err
		}
	} else if err := a.checkChatExists(ctx, chatID); err != nil {
		return ReadContextResult{}, err
	}
	return a.readChatContext(ctx, model.Run{ChatID: chatID}, req)
}

func (a *App) findChatContext(ctx context.Context, chatID, currentRunID string, in findContextInput) (FindContextResult, error) {
	var out FindContextResult
	query := strings.TrimSpace(in.Query)
	if query == "" {
		topics, err := a.Store.ChatTopics(ctx, chatID, contextPageRecords)
		out.Topics = topics
		for len(out.Topics) > 0 && len(store.JSON(out)) > contextPageBytes {
			out.Topics = out.Topics[:len(out.Topics)-1]
		}
		return out, err
	}
	if len(query) > 256 {
		return out, invalid("Search query must be at most 256 bytes")
	}
	match := regexp.MustCompile("(?i)" + regexp.QuoteMeta(query))
	err := walkContextRuns(ctx, a.Store.DB, "SELECT r.data,s.kind FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.chat_id=? AND r.id<>? AND "+contextRunFilter+" ORDER BY r.position DESC", []any{chatID, currentRunID}, func(run model.Run, kind string) (bool, error) {
		messages := contextMessages(run, kind)
		slices.Reverse(messages)
		for _, message := range messages {
			hit := match.FindStringIndex(message.Text)
			if hit == nil {
				continue
			}
			start := contextTextEnd(message.Text, 0, max(0, hit[0]-64))
			end := contextTextEnd(message.Text, hit[1], 96)
			message.Text = message.Text[start:end]
			message.Anchor.Offset = start
			out.Matches = append(out.Matches, message)
			if len(store.JSON(out)) > contextPageBytes {
				out.Matches = out.Matches[:len(out.Matches)-1]
				return false, nil
			}
			if len(out.Matches) == contextPageRecords {
				return false, nil
			}
		}
		return true, nil
	})
	return out, err
}

func (a *App) readChatContext(ctx context.Context, run model.Run, in readContextInput) (ReadContextResult, error) {
	out := ReadContextResult{Messages: []ContextMessage{}}
	position, direction := in.Anchor, in.Direction
	if in.Cursor != nil {
		if position != nil || direction != "" {
			return out, invalid("Use a cursor on its own")
		}
		position, direction = &in.Cursor.Position, in.Cursor.Direction
	}
	if direction == "" {
		direction = "older"
	}
	newer := direction == "newer"
	if (direction != "older" && !newer) || (newer && position == nil) {
		return out, invalid("Use older, or newer with an anchor")
	}
	tx, err := a.Store.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	mentioned := slices.ContainsFunc(run.References, func(ref model.Reference) bool {
		return (ref.Kind == "chat" || ref.Kind == "topic") && ref.ID == in.Target
	})
	var sessionID, chatID, kind, sourceID string
	err = tx.QueryRowContext(ctx, `SELECT id,chat_id,kind,COALESCE(json_extract(data,'$.sourceRunId'),'') FROM sessions
WHERE (id=? AND (chat_id=? OR ?)) OR (chat_id=? AND ?='main' AND kind='main')`,
		in.Target, run.ChatID, mentioned, run.ChatID, in.Target).Scan(&sessionID, &chatID, &kind, &sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		if in.Target == "main" && position == nil {
			return out, nil
		}
		return out, invalid("Conversation is unavailable in this Chat")
	}
	if err != nil {
		return out, err
	}
	// A Topic created from a main turn displays that exact turn as its opening
	// dialogue, even if the main conversation later replaces it.
	const dialogue = `WITH dialogue AS (
SELECT r.id,r.data,r.position FROM runs r WHERE r.chat_id=? AND r.session_id=? AND r.id<>? AND ` + contextRunFilter + `
UNION ALL SELECT id,data,0 FROM runs WHERE chat_id=? AND id=? AND id<>?
) `
	args := []any{chatID, sessionID, run.ID, chatID, sourceID, run.ID}
	sequence := int64(math.MaxInt64)
	if position != nil {
		err = tx.QueryRowContext(ctx, dialogue+"SELECT position FROM dialogue WHERE id=?", append(args, position.RunID)...).Scan(&sequence)
		if errors.Is(err, sql.ErrNoRows) {
			return out, invalid("Message is unavailable in this conversation")
		}
		if err != nil {
			return out, err
		}
	}
	order := "position<=? ORDER BY position DESC"
	if newer {
		order = "position>=? ORDER BY position ASC"
	}
	err = walkContextRuns(ctx, tx, dialogue+"SELECT data,? FROM dialogue WHERE "+order, append(args, kind, sequence), func(run model.Run, kind string) (bool, error) {
		run.SessionID = sessionID
		messages := contextMessages(run, kind)
		if !newer {
			slices.Reverse(messages)
		}
		offset := 0
		if position != nil {
			i := slices.IndexFunc(messages, func(message ContextMessage) bool { return message.Anchor.ItemID == position.ItemID })
			if i < 0 {
				return false, invalid("Message is unavailable in this conversation")
			}
			messages, offset, position = messages[i:], position.Offset, nil
		}
		for _, message := range messages {
			if offset < 0 || offset >= len(message.Text) || !utf8.RuneStart(message.Text[offset]) {
				return false, invalid("Invalid message offset")
			}
			message.Anchor.Offset = offset
			if len(out.Messages) == contextPageRecords {
				out.NextCursor = &ContextCursor{Position: message.Anchor, Direction: direction}
				return false, nil
			}
			end := contextTextEnd(message.Text, offset, contextTextBytes)
			more := end < len(message.Text)
			message.Text = message.Text[offset:end]
			out.Messages = append(out.Messages, message)
			if more {
				out.NextCursor = &ContextCursor{Position: message.Anchor, Direction: direction}
				out.NextCursor.Position.Offset = end
				return false, nil
			}
			offset = 0
		}
		return true, nil
	})
	if err != nil {
		return out, err
	}
	for len(out.Messages) > 0 && len(store.JSON(out)) > contextPageBytes {
		last := len(out.Messages) - 1
		out.NextCursor = &ContextCursor{Position: out.Messages[last].Anchor, Direction: direction}
		out.Messages = out.Messages[:last]
	}
	if len(out.Messages) == 0 && out.NextCursor != nil {
		return out, invalid("Message is too large to return within the Chat context limit")
	}
	if !newer {
		slices.Reverse(out.Messages)
	}
	return out, nil
}

func contextTextEnd(text string, start, size int) int {
	end := min(start+size, len(text))
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end--
	}
	return end
}

func contextMessages(run model.Run, kind string) []ContextMessage {
	messages := []ContextMessage{}
	add := func(itemID, role, createdAt, text string) {
		if strings.TrimSpace(text) != "" {
			messages = append(messages, ContextMessage{
				SessionID: run.SessionID, Kind: kind, Anchor: ContextAnchor{RunID: run.ID, ItemID: itemID},
				Role: role, Status: run.Status, CreatedAt: createdAt, Text: text,
			})
		}
	}
	add("", "user", run.CreatedAt, run.Input)
	for _, item := range run.Items {
		switch {
		case item.Kind == "user" && item.Message != nil && item.Status == "completed":
			add(item.ID, "user", item.Message.CreatedAt, item.Message.Input)
		case item.Kind == "text" && item.Status == "completed":
			add(item.ID, "assistant", run.CreatedAt, item.Text)
		}
	}
	return messages
}

func walkContextRuns(ctx context.Context, q store.Queryer, query string, args []any, visit func(model.Run, string) (bool, error)) error {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw, kind string
		if err := rows.Scan(&raw, &kind); err != nil {
			return err
		}
		var run model.Run
		if err := json.Unmarshal([]byte(raw), &run); err != nil {
			return err
		}
		if more, err := visit(run, kind); !more || err != nil {
			return err
		}
	}
	return rows.Err()
}
