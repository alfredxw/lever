package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) WorkItems(ctx context.Context) ([]model.WorkItem, error) {
	return store.List[model.WorkItem](ctx, a.Store.DB, "SELECT data FROM work_items ORDER BY rowid DESC")
}

func (a *App) WorkItem(ctx context.Context, id string) (model.WorkItem, error) {
	return store.Get[model.WorkItem](ctx, a.Store.DB, "SELECT data FROM work_items WHERE id=?", id)
}

func checkWorkItemAgent(ctx context.Context, q store.Queryer, agentID string) error {
	agent, err := store.Get[model.Agent](ctx, q, "SELECT data FROM agents WHERE id=?", agentID)
	if err != nil {
		return err
	}
	if agent.Archived {
		return conflict("The Agent is archived")
	}
	return nil
}

func (a *App) CreateWorkItem(ctx context.Context, agentID string, origin *model.RunLocation, input model.WorkItemInput) (model.WorkItem, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.RequestKey = strings.TrimSpace(input.RequestKey)
	var item model.WorkItem
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 80 || strings.ContainsAny(input.Title, "\r\n\x00") {
		return item, invalid("Enter a single-line title up to 80 characters")
	}
	if len(input.Body) > 32<<10 || strings.ContainsRune(input.Body, 0) {
		return item, invalid("Enter a description up to 32 KiB")
	}
	if len(input.RequestKey) > 100 || strings.ContainsAny(input.RequestKey, "\r\n\x00") {
		return item, invalid("Use a request key up to 100 bytes")
	}
	scope := "agent:" + agentID
	if origin != nil {
		scope = "run:" + origin.RunID
	}
	digest := hash(input)
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if err := checkWorkItemAgent(ctx, tx, agentID); err != nil {
			return err
		}
		if input.RequestKey != "" {
			var id, existingHash string
			err := tx.QueryRowContext(ctx, "SELECT id,input_hash FROM work_items WHERE request_scope=? AND request_key=?", scope, input.RequestKey).Scan(&id, &existingHash)
			switch {
			case err == nil && existingHash != digest:
				return conflict("This request key already belongs to a different work item")
			case err == nil:
				item, err = store.Get[model.WorkItem](ctx, tx, "SELECT data FROM work_items WHERE id=?", id)
				return err
			case !errors.Is(err, sql.ErrNoRows):
				return err
			}
		}
		item = model.WorkItem{
			ID: ID(), Title: input.Title, Body: input.Body, CreatedByAgentID: agentID,
			AssigneeAgentID: agentID, Origin: origin, CreatedAt: now(),
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO work_items(id,data,request_scope,request_key,input_hash)
VALUES(?,?,?,NULLIF(?,''),?)`, item.ID, store.JSON(item), scope, input.RequestKey, digest); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "work-items"})
	})
	return item, err
}

func (a *App) DispatchWorkItem(ctx context.Context, id string, input model.ExternalTaskDispatch) (model.Run, error) {
	if !taskIDPattern.MatchString(id) || input.AgentID == "" {
		return model.Run{}, invalid("Select a task and an Agent")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	item, err := a.WorkItem(ctx, id)
	if err != nil {
		return model.Run{}, err
	}
	return a.dispatchStoredTask(ctx, model.TaskRecordWorkItem, id, item.Title, taskMessage(item.Title, item.Body), input)
}

func (a *App) SetWorkItemDone(ctx context.Context, id string, done bool) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		return setWorkItemDone(ctx, tx, id, done)
	})
}

func setWorkItemDone(ctx context.Context, tx *sql.Tx, id string, done bool) error {
	var current bool
	if err := tx.QueryRowContext(ctx, "SELECT json_extract(data,'$.done') FROM work_items WHERE id=?", id).Scan(&current); err != nil || current == done {
		return err
	}
	if done {
		if err := checkTaskCompletable(ctx, tx, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE work_items SET data=json_set(data,'$.done',json(?)) WHERE id=?", store.JSON(done), id); err != nil {
		return err
	}
	return store.Event(tx, model.Event{Type: "work-items"})
}

func (a *App) addWorkItemTool(server *mcp.Server, owner *execution) {
	mcp.AddTool(server, &mcp.Tool{
		Name: "work_item_create",
		Description: "Propose a follow-up task for the user to confirm in Lever's Board. " +
			"Supply a stable requestKey and reuse it if you retry.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, input model.WorkItemInput) (*mcp.CallToolResult, *model.WorkItem, error) {
		owner.mu.Lock()
		defer owner.mu.Unlock()
		if err := owner.ctx.Err(); err != nil {
			return nil, nil, err
		}
		if owner.run.Selection.Permission == "read_only" {
			return nil, nil, invalid("This run is read-only")
		}
		if owner.permissionChange != nil {
			return nil, nil, conflict("Wait for the permission change to finish")
		}
		if strings.TrimSpace(input.RequestKey) == "" {
			return nil, nil, invalid("A requestKey is required")
		}
		origin := model.RunLocation{
			ChatID: owner.run.ChatID, SessionID: owner.run.SessionID, RunID: owner.run.ID, Topic: owner.session.Kind == "topic",
		}
		item, err := a.CreateWorkItem(ctx, owner.session.AgentID, &origin, input)
		return nil, &item, err
	})
}
