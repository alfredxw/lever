package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"lever/internal/model"
	"lever/internal/store"
)

const visibleWorkItems = "SELECT data FROM work_items WHERE NOT EXISTS(SELECT 1 FROM task_triage WHERE task_id=work_items.id AND disposition='deleted')"

func (a *App) WorkItems(ctx context.Context) ([]model.WorkItem, error) {
	return store.List[model.WorkItem](ctx, a.Store.DB, visibleWorkItems+" ORDER BY rowid DESC")
}

func (a *App) WorkItem(ctx context.Context, id string) (model.WorkItem, error) {
	return store.Get[model.WorkItem](ctx, a.Store.DB, visibleWorkItems+" AND id=?", id)
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

func validateWorkItemTitle(title string) error {
	if title == "" || utf8.RuneCountInString(title) > 80 || strings.ContainsAny(title, "\r\n\x00") {
		return invalid("Enter a single-line title up to 80 characters")
	}
	return nil
}

func validateWorkItemBody(body string) error {
	if len(body) > 32<<10 || strings.ContainsRune(body, 0) {
		return invalid("Enter a description up to 32 KiB")
	}
	return nil
}

func validateWorkItemPriority(priority model.WorkItemPriority) error {
	switch priority {
	case "", model.WorkItemPriorityUrgent, model.WorkItemPriorityHigh, model.WorkItemPriorityMedium, model.WorkItemPriorityLow:
		return nil
	default:
		return invalid("Choose a valid priority")
	}
}

func (a *App) CreateWorkItem(ctx context.Context, agentID string, origin *model.RunLocation, input model.WorkItemInput) (model.WorkItem, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.RequestKey = strings.TrimSpace(input.RequestKey)
	var item model.WorkItem
	if err := validateWorkItemTitle(input.Title); err != nil {
		return item, err
	}
	if err := validateWorkItemBody(input.Body); err != nil {
		return item, err
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

func (a *App) CreateUserWorkItem(ctx context.Context, input model.UserWorkItemCreate) (model.WorkItem, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.Project = strings.TrimSpace(input.Project)
	input.AssigneeAgentID = strings.TrimSpace(input.AssigneeAgentID)
	var item model.WorkItem
	if err := validateWorkItemTitle(input.Title); err != nil {
		return item, err
	}
	if err := validateWorkItemBody(input.Body); err != nil {
		return item, err
	}
	if input.Project != "" && !validTaskLabel(input.Project) {
		return item, invalid("Enter a project name up to 100 characters")
	}
	if err := validateWorkItemPriority(input.Priority); err != nil {
		return item, err
	}
	if input.Deadline != nil {
		if _, _, _, err := normalizeDeadlineInput(*input.Deadline, time.Local); err != nil {
			return item, err
		}
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if input.AssigneeAgentID != "" {
			if err := checkWorkItemAgent(ctx, tx, input.AssigneeAgentID); err != nil {
				return err
			}
		}
		item = model.WorkItem{
			ID:              ID(),
			Title:           input.Title,
			Body:            input.Body,
			Project:         input.Project,
			Priority:        input.Priority,
			AssigneeAgentID: input.AssigneeAgentID,
			CreatedAt:       now(),
		}
		scope := "user"
		var key *string
		if input.OriginRunID != "" {
			origin := &model.RunLocation{RunID: input.OriginRunID}
			if err := tx.QueryRowContext(ctx, `SELECT r.chat_id,r.session_id,s.kind='topic' FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?`, origin.RunID).Scan(&origin.ChatID, &origin.SessionID, &origin.Topic); err != nil {
				return err
			}
			item.Origin = origin
			scope = "user:run:" + origin.RunID
			digest := hash(input)
			key = &digest
			existing, err := store.Get[model.WorkItem](ctx, tx, "SELECT data FROM work_items WHERE request_scope=? AND request_key=?", scope, digest)
			if err == nil {
				if err := checkTaskInBoard(ctx, tx, existing.ID); err != nil {
					if errors.Is(err, sql.ErrNoRows) {
						return conflict("This work item was deleted from Works")
					}
					return err
				}
				item = existing
				return nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO work_items(id,data,request_scope,request_key,input_hash)
VALUES(?,?,?,?,?)`, item.ID, store.JSON(item), scope, key, hash(item.ID)); err != nil {
			return err
		}
		if input.Deadline != nil {
			if _, err := upsertTaskDeadlineTx(ctx, tx, item.ID, *input.Deadline, time.Local); err != nil {
				return err
			}
			if err := store.Event(tx, model.Event{Type: "task-deadlines"}); err != nil {
				return err
			}
		}
		return store.Event(tx, model.Event{Type: "work-items"})
	})
	if err == nil && input.Deadline != nil {
		a.wakeTaskReminders()
	}
	return item, err
}

func (a *App) UpdateWorkItem(ctx context.Context, id string, input model.WorkItemUpdate) (model.WorkItem, error) {
	if input.Done == nil && input.Title == nil && input.Body == nil &&
		input.Project == nil && input.Priority == nil && input.AssigneeAgentID == nil {
		return model.WorkItem{}, invalid("Provide at least one work item field to update")
	}
	var item model.WorkItem
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		item, err = store.Get[model.WorkItem](ctx, tx, visibleWorkItems+" AND id=?", id)
		if err != nil {
			return err
		}
		changed := false
		if input.Title != nil {
			title := strings.TrimSpace(*input.Title)
			if err := validateWorkItemTitle(title); err != nil {
				return err
			}
			if item.Title != title {
				item.Title = title
				changed = true
			}
		}
		if input.Body != nil {
			body := strings.TrimSpace(*input.Body)
			if err := validateWorkItemBody(body); err != nil {
				return err
			}
			if item.Body != body {
				item.Body = body
				changed = true
			}
		}
		if input.Project != nil {
			project := strings.TrimSpace(*input.Project)
			if project != "" && !validTaskLabel(project) {
				return invalid("Enter a project name up to 100 characters")
			}
			if item.Project != project {
				item.Project = project
				changed = true
			}
		}
		if input.Priority != nil {
			if err := validateWorkItemPriority(*input.Priority); err != nil {
				return err
			}
			if item.Priority != *input.Priority {
				item.Priority = *input.Priority
				changed = true
			}
		}
		if input.AssigneeAgentID != nil {
			agentID := strings.TrimSpace(*input.AssigneeAgentID)
			if item.AssigneeAgentID != agentID {
				if err := checkTaskUnlinked(ctx, tx, id); err != nil {
					return err
				}
				if err := checkTaskNotQueued(ctx, tx, id); err != nil {
					return err
				}
				if agentID != "" {
					if err := checkWorkItemAgent(ctx, tx, agentID); err != nil {
						return err
					}
				}
				item.AssigneeAgentID = agentID
				changed = true
			}
		}
		if input.Done != nil && item.Done != *input.Done {
			if *input.Done {
				if err := checkTaskCompletable(ctx, tx, id); err != nil {
					return err
				}
			}
			item.Done = *input.Done
			changed = true
		}
		if !changed {
			return nil
		}
		if _, err := tx.ExecContext(ctx, "UPDATE work_items SET data=? WHERE id=?", store.JSON(item), id); err != nil {
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
		if err := checkTaskInBoard(ctx, tx, id); err != nil {
			return err
		}
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
