package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/store"
)

type queuedTask struct {
	model.TaskQueueInput
	taskDelivery
	Scope             model.Scope `json:"scope"`
	DestinationChatID string      `json:"chatId,omitempty"`
}

type taskDelivery struct {
	Images    []NoteAsset    `json:"images,omitempty"`
	Task      *model.RunTask `json:"completionTask,omitempty"`
	noteTitle string
}

func (a *App) TaskWorkflows(ctx context.Context) ([]model.TaskWorkflow, error) {
	return store.List[model.TaskWorkflow](ctx, a.Store.DB, `
WITH pending AS (
  SELECT id,task_id,agent_id,error,
    CASE WHEN error='' THEN ROW_NUMBER() OVER (PARTITION BY agent_id,(error='') ORDER BY position,id) END AS rank
  FROM task_queue WHERE state='queued'
), tasks AS (SELECT task_id FROM task_triage UNION SELECT task_id FROM pending)
SELECT json_object('taskId',tasks.task_id,'accepted',json(IIF(t.accepted=1,'true','false')),
  'closed',json(IIF(t.closed=1,'true','false')),
  'queue',CASE WHEN p.id IS NOT NULL THEN json_object('id',p.id,'agentId',p.agent_id,
    'position',p.rank,'error',NULLIF(p.error,'')) END)
FROM tasks LEFT JOIN task_triage t USING(task_id) LEFT JOIN pending p USING(task_id)`)
}

func (a *App) UpdateTaskWorkflow(ctx context.Context, id string, input model.TaskWorkflowUpdate) error {
	if !taskIDPattern.MatchString(id) {
		return invalid("Choose a task")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if input.Record == model.TaskRecordNote && input.Action != "withdraw" {
		a.notesMu.Lock()
		defer a.notesMu.Unlock()
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if input.Action == "withdraw" {
			result, err := tx.ExecContext(ctx, `UPDATE task_queue SET state='withdrawn',data='{}'
WHERE id=? AND task_id=? AND state IN ('queued','withdrawn')`, input.QueueID, id)
			if err != nil {
				return err
			}
			if changed, err := result.RowsAffected(); err != nil || changed == 0 {
				if err != nil {
					return err
				}
				return conflict("This task has already left the queue")
			}
		} else {
			if _, err := a.openTaskSource(ctx, tx, input.Record, id, input.NoteID); err != nil {
				return err
			}
			if err := checkTaskUnlinked(ctx, tx, id); err != nil {
				return err
			}
			if err := checkTaskNotQueued(ctx, tx, id); err != nil {
				return err
			}
			switch input.Action {
			case "accept":
				if input.Record != model.TaskRecordWorkItem {
					return invalid("Only a proposed task needs confirmation")
				}
				if err := checkTaskNotClosed(ctx, tx, id); err != nil {
					return err
				}
				if err := markTaskAccepted(ctx, tx, id); err != nil {
					return err
				}
			case "close":
				if _, err := tx.ExecContext(ctx, `INSERT INTO task_triage(task_id,closed) VALUES(?,1)
ON CONFLICT(task_id) DO UPDATE SET closed=1`, id); err != nil {
					return err
				}
			case "reopen":
				if _, err := tx.ExecContext(ctx, "UPDATE task_triage SET closed=0 WHERE task_id=?", id); err != nil {
					return err
				}
			default:
				return invalid("Choose a task action")
			}
		}
		return store.Event(tx, model.Event{Type: "task-workflow"})
	})
	if err == nil {
		a.wakeTaskQueue()
	}
	return err
}

func (a *App) EnqueueTask(ctx context.Context, input model.TaskQueueInput) error {
	input.Title = strings.TrimSpace(input.Title)
	input.Note = strings.TrimSpace(input.Note)
	if !taskIDPattern.MatchString(input.TaskID) || input.AgentID == "" ||
		input.CommandID == "" || len(input.CommandID) > 100 {
		return invalid("Choose a task and an Agent")
	}
	digest := hash(input)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return conflict("Backend is shutting down")
	}
	if input.Record == model.TaskRecordNote {
		a.notesMu.Lock()
		defer a.notesMu.Unlock()
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var existing string
		err := tx.QueryRowContext(ctx, "SELECT input_hash FROM task_queue WHERE id=?", input.CommandID).Scan(&existing)
		if err == nil {
			if existing != digest {
				return errCommandConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		note, err := a.openTaskSource(ctx, tx, input.Record, input.TaskID, input.NoteID)
		if err != nil {
			return err
		}
		if err := checkTaskUnlinked(ctx, tx, input.TaskID); err != nil {
			return err
		}
		if err := checkTaskNotClosed(ctx, tx, input.TaskID); err != nil {
			return err
		}
		if err := checkTaskNotQueued(ctx, tx, input.TaskID); err != nil {
			return err
		}
		entry := queuedTask{TaskQueueInput: input}
		if err := a.prepareQueuedTask(ctx, tx, note, &entry); err != nil {
			return err
		}
		if input.Record == model.TaskRecordWorkItem {
			if err := markTaskAccepted(ctx, tx, input.TaskID); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO task_queue(id,task_id,agent_id,input_hash,position,data,state)
VALUES(?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM task_queue WHERE agent_id=? AND state='queued'),?,'queued')`,
			input.CommandID, input.TaskID, input.AgentID, digest, input.AgentID, store.JSON(entry))
		if err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-workflow"})
	})
	if err == nil {
		a.wakeTaskQueue()
	}
	return err
}

func (a *App) prepareQueuedTask(ctx context.Context, tx *sql.Tx, note model.TaskNote, entry *queuedTask) error {
	switch entry.Record {
	case model.TaskRecordNote:
		if note.Version != entry.Version {
			return conflict("The task note changed before dispatch")
		}
		if entry.Title == "" || utf8.RuneCountInString(entry.Title) > 80 {
			return invalid("Enter a task title up to 80 characters")
		}
		delivery, err := noteDispatch(note, entry.TaskID)
		if err != nil {
			return err
		}
		if len(delivery.Images) > MaxAttachments {
			return invalid("A message can have up to 8 attachments")
		}
		entry.taskDelivery = delivery
		entry.DestinationChatID, err = configuredNoteChat(ctx, tx, note.ID, entry.AgentID)
		if err != nil {
			return err
		}
	case model.TaskRecordWorkItem:
		item, err := store.Get[model.WorkItem](ctx, tx, "SELECT data FROM work_items WHERE id=?", entry.TaskID)
		if err != nil {
			return err
		}
		entry.Title, entry.Text = item.Title, taskMessage(item.Title, item.Body)
	case model.TaskRecordExternal:
		item, err := readExternalTask(ctx, tx, entry.TaskID)
		if err != nil {
			return err
		}
		label := []rune(strings.TrimSpace(item.Title))
		entry.Title = string(label[:min(80, len(label))])
		entry.Text = taskMessage(item.Title+"\n\n"+item.URL, item.Body)
	}
	if err := validateMessage(entry.CommandID, taskMessage(entry.Text, entry.Note), nil, nil, nil); err != nil {
		return err
	}
	agent, err := store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", entry.AgentID)
	if err != nil {
		return err
	}
	if agent.Archived {
		return conflict("Agent is archived")
	}
	entry.Scope = agent.Profile.Scope
	if entry.WorkingCopyID != "" {
		copy, err := a.selectGroup(ctx, tx, agent, entry.WorkingCopyID)
		if err != nil {
			return err
		}
		entry.Scope = copy.Scope
	}
	return a.checkSessionScope(model.Session{Scope: entry.Scope})
}

func (a *App) ReorderTaskQueue(ctx context.Context, agentID string, ids []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		current, err := store.List[string](ctx, tx, `SELECT json_quote(id) FROM task_queue
WHERE agent_id=? AND state='queued' AND error=''`, agentID)
		if err != nil {
			return err
		}
		idsPresent := make(map[string]bool, len(current))
		for _, id := range current {
			idsPresent[id] = true
		}
		if len(ids) != len(current) {
			return conflict("The queue has changed. Refresh its order.")
		}
		for i, id := range ids {
			if !idsPresent[id] {
				return conflict("The queue has changed. Refresh its order.")
			}
			delete(idsPresent, id)
			if _, err := tx.ExecContext(ctx, "UPDATE task_queue SET position=? WHERE id=?", i+1, id); err != nil {
				return err
			}
		}
		return store.Event(tx, model.Event{Type: "task-workflow"})
	})
	if err == nil {
		a.wakeTaskQueue()
	}
	return err
}

func (a *App) wakeTaskQueue() {
	select {
	case a.taskQueueWake <- struct{}{}:
	default:
	}
}

func (a *App) runTaskQueue() {
	defer a.wg.Done()
	clock := time.NewTicker(time.Second)
	defer clock.Stop()
	for a.ctx.Err() == nil {
		if err := a.consumeTaskQueues(); err != nil && a.ctx.Err() == nil {
			slog.Error("Consume task queues", "error", err)
		}
		select {
		case <-a.ctx.Done():
		case <-a.taskQueueWake:
		case <-clock.C:
		}
	}
}

func (a *App) consumeTaskQueues() error {
	agents, err := store.List[string](a.ctx, a.Store.DB, `SELECT DISTINCT json_quote(agent_id)
FROM task_queue WHERE state='queued' AND error=''`)
	if err != nil {
		return err
	}
	for _, id := range agents {
		for {
			advanced, err := a.consumeTask(id)
			if err != nil && a.ctx.Err() == nil {
				slog.Error("Consume Agent task queue", "agent", id, "error", err)
			}
			if !advanced || err != nil {
				break
			}
		}
	}
	return nil
}

func (a *App) consumeTask(agentID string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return false, nil
	}
	ctx := a.ctx
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID)
	if err != nil {
		return false, err
	}
	var active int
	var lastStart int64
	err = a.Store.DB.QueryRowContext(ctx, `
SELECT (SELECT COUNT(*) FROM runs r
  WHERE r.agent_id=? AND r.status IN ('starting','running','waiting_user','cancelling','unknown','queued')
  AND EXISTS(SELECT 1 FROM task_queue q WHERE q.run_id=r.id)),
  (SELECT COALESCE(MAX(started_at),0) FROM task_queue WHERE agent_id=? AND state='started')`,
		agentID, agentID).Scan(&active, &lastStart)
	if err != nil {
		return false, err
	}
	if active >= max(1, agent.Profile.TaskConcurrency) {
		return false, nil
	}
	if interval := time.Duration(agent.Profile.TaskStartIntervalMinutes) * time.Minute; interval > 0 &&
		lastStart > 0 && time.Since(time.UnixMilli(lastStart)) < interval {
		return false, nil
	}
	entry, err := store.Get[queuedTask](ctx, a.Store.DB, `SELECT data FROM task_queue
WHERE agent_id=? AND state='queued' AND error='' ORDER BY position,id LIMIT 1`, agentID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	op := "main"
	if entry.Record == model.TaskRecordNote {
		a.notesMu.Lock()
		defer a.notesMu.Unlock()
		op = "topic"
	}
	_, err = a.sendLocked(ctx, model.SendInput{
		CommandID: ID(), AgentID: agentID, WorkingCopyID: entry.WorkingCopyID,
		Operation: op, Text: taskMessage(entry.Text, entry.Note),
	}, sendOrigin{task: &entry.TaskDispatch, taskRecord: entry.Record, taskQueue: &entry})
	if err == nil {
		return true, nil
	}
	if errors.Is(err, ErrTaskNotesUnavailable) {
		return false, nil
	}
	var refusal *Error
	if !errors.As(err, &refusal) && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	// A task whose source or execution settings went away is still visible and
	// can be withdrawn without blocking later items behind it.
	return true, a.Store.Write(ctx, func(tx *sql.Tx) error {
		reason := "Task or Agent settings are no longer available"
		if refusal != nil {
			reason = refusal.Message
		}
		if _, err := tx.ExecContext(ctx, "UPDATE task_queue SET error=? WHERE id=? AND state='queued'", reason, entry.CommandID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-workflow"})
	})
}
