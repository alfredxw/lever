package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"math"
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
	Images      []NoteAsset        `json:"images,omitempty"`
	Task        *model.RunTask     `json:"completionTask,omitempty"`
	noteTitle   string
	sourceID    string
	sourceTitle string
	origin      *model.RunLocation
}

func (a *App) TaskWorkflows(ctx context.Context) ([]model.TaskWorkflow, error) {
	return store.List[model.TaskWorkflow](ctx, a.Store.DB, `
WITH pending AS (
  SELECT id,task_id,agent_id,error,
    CASE WHEN error='' THEN ROW_NUMBER() OVER (PARTITION BY agent_id,(error='') ORDER BY position,id) END AS rank
  FROM task_queue WHERE state='queued'
), last_starts AS (
  SELECT agent_id, MAX(started_at) AS started_at FROM task_queue WHERE state='started' GROUP BY agent_id
), tasks AS (SELECT task_id FROM task_triage UNION SELECT task_id FROM pending)
SELECT json_object('taskId',tasks.task_id,'accepted',json(IIF(t.accepted=1,'true','false')),
  'disposition',NULLIF(t.disposition,''),
  'closed',json(IIF(t.closed=1,'true','false')),
  'queue',CASE WHEN p.id IS NOT NULL THEN json_object('id',p.id,'agentId',p.agent_id,
    'position',p.rank,'error',NULLIF(p.error,''),
    'nextStartAt',CASE
      WHEN COALESCE(json_extract(ag.data,'$.profile.taskStartIntervalMinutes'),0) > 0 AND COALESCE(ls.started_at,0) > 0
      THEN ls.started_at + CAST(json_extract(ag.data,'$.profile.taskStartIntervalMinutes') AS INTEGER) * 60000
      ELSE 0 END) END)
FROM tasks
LEFT JOIN task_triage t USING(task_id)
LEFT JOIN pending p USING(task_id)
LEFT JOIN agents ag ON ag.id=p.agent_id
LEFT JOIN last_starts ls ON ls.agent_id=p.agent_id`)
}

func (a *App) UpdateAgentTaskQueue(ctx context.Context, agentID string, input model.AgentTaskQueueSettings) (model.Agent, error) {
	if input.TaskConcurrency == nil && input.TaskStartIntervalMinutes == nil && input.TaskQueuePaused == nil {
		return model.Agent{}, invalid("Choose a task queue setting to update")
	}
	if input.TaskConcurrency != nil && *input.TaskConcurrency < 0 {
		return model.Agent{}, invalid("Choose a positive task concurrency and a valid start interval")
	}
	if input.TaskStartIntervalMinutes != nil && (*input.TaskStartIntervalMinutes < 0 ||
		int64(*input.TaskStartIntervalMinutes) > math.MaxInt64/int64(time.Minute)) {
		return model.Agent{}, invalid("Choose a positive task concurrency and a valid start interval")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var agent model.Agent
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		agent, err = store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", agentID)
		if err != nil {
			return err
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		if input.TaskConcurrency != nil {
			agent.Profile.TaskConcurrency = *input.TaskConcurrency
		}
		if input.TaskStartIntervalMinutes != nil {
			agent.Profile.TaskStartIntervalMinutes = *input.TaskStartIntervalMinutes
		}
		if input.TaskQueuePaused != nil {
			agent.Profile.TaskQueuePaused = *input.TaskQueuePaused
		}
		agent.UpdatedAt = now()
		if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
			return err
		}
		if err := store.Event(tx, model.Event{Type: "agents"}); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-workflow"})
	})
	if err == nil {
		a.wakeTaskQueue()
	}
	return agent, err
}

func (a *App) UpdateTaskWorkflow(ctx context.Context, id string, input model.TaskWorkflowUpdate) error {
	// Multi-target fires use a composite ID. readBoardSource checks the exact
	// persisted fire and its work-item setting before changing the board.
	if id == "" || (input.Record != model.TaskRecordAutomation && !taskIDPattern.MatchString(id)) {
		return invalid("Choose a task")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if input.Action == "todo" && input.Record == model.TaskRecordNote {
		if err := checkTaskInBoard(ctx, a.Store.DB, id); err != nil {
			return err
		}
		if err := a.setNoteTaskCheck(ctx, input.NoteID, id, nil, false); err != nil {
			return err
		}
	}
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
			if _, err := a.readBoardSource(ctx, tx, input.Record, id, input.NoteID, input.Action == "accept"); err != nil {
				return err
			}
			if input.Action != "delete" {
				if err := checkTaskInBoard(ctx, tx, id); err != nil {
					return err
				}
			}
			switch input.Action {
			case "accept":
				if input.Record != model.TaskRecordWorkItem {
					return invalid("Only a proposed task needs confirmation")
				}
				if err := checkTaskNotClosed(ctx, tx, id); err != nil {
					return err
				}
				if err := checkTaskUnlinked(ctx, tx, id); err != nil {
					return err
				}
				if err := checkTaskNotQueued(ctx, tx, id); err != nil {
					return err
				}
				if err := markTaskAccepted(ctx, tx, id); err != nil {
					return err
				}
			case "close", "delete", "todo":
				if _, err := tx.ExecContext(ctx, "UPDATE task_queue SET state='withdrawn',data='{}' WHERE task_id=? AND state='queued'", id); err != nil {
					return err
				}
				disposition := ""
				switch input.Action {
				case "todo":
					disposition = "todo"
					switch input.Record {
					case model.TaskRecordAutomation:
						if err := setAutomationRunDone(ctx, tx, id, "", false); err != nil {
							return err
						}
					case model.TaskRecordWorkItem:
						if err := setWorkItemDone(ctx, tx, id, false); err != nil {
							return err
						}
					case model.TaskRecordExternal:
						if _, err := tx.ExecContext(ctx, "UPDATE external_tasks SET done=0 WHERE id=?", id); err != nil {
							return err
						}
						if err := store.Event(tx, model.Event{Type: "external-tasks"}); err != nil {
							return err
						}
					}
				case "delete":
					disposition = "deleted"
					if input.Record == model.TaskRecordWorkItem {
						if err := store.Event(tx, model.Event{Type: "work-items"}); err != nil {
							return err
						}
					}
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO task_triage(task_id,accepted,closed,disposition) VALUES(?,?,?,?)
ON CONFLICT(task_id) DO UPDATE SET accepted=MAX(task_triage.accepted,excluded.accepted), closed=excluded.closed,
disposition=CASE WHEN excluded.disposition='' THEN task_triage.disposition ELSE excluded.disposition END`, id, input.Action == "todo", input.Action != "todo", disposition); err != nil {
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
		if err := prepareTaskHandoff(ctx, tx, input.TaskID); err != nil {
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
		newDue, err := effectiveTaskDueAt(ctx, tx, input.TaskID)
		if err != nil {
			return err
		}
		var position int
		if newDue > 0 {
			rows, err := tx.QueryContext(ctx, `
SELECT q.id, COALESCE(
  (SELECT NULLIF(d.due_at, 0) FROM task_deadlines d WHERE d.task_id=q.task_id),
  (SELECT NULLIF(CAST(COALESCE(json_extract(e.data,'$.dueAt'),0) AS INTEGER), 0) FROM external_tasks e WHERE e.id=q.task_id),
  0
) AS due_at
FROM task_queue q
WHERE q.agent_id=? AND q.state='queued' AND q.error=''
ORDER BY q.position, q.id`, input.AgentID)
			if err != nil {
				return err
			}
			type queuedPos struct {
				id    string
				dueAt int64
			}
			var existing []queuedPos
			for rows.Next() {
				var qp queuedPos
				if err := rows.Scan(&qp.id, &qp.dueAt); err != nil {
					rows.Close()
					return err
				}
				existing = append(existing, qp)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			insertAt := len(existing)
			for i, qp := range existing {
				if qp.dueAt == 0 || newDue < qp.dueAt {
					insertAt = i
					break
				}
			}
			position = insertAt + 1
			for i, qp := range existing {
				nextPos := i + 1
				if i >= insertAt {
					nextPos = i + 2
				}
				if _, err := tx.ExecContext(ctx, "UPDATE task_queue SET position=? WHERE id=?", nextPos, qp.id); err != nil {
					return err
				}
			}
		} else {
			if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(position),0)+1 FROM task_queue WHERE agent_id=? AND state='queued'", input.AgentID).Scan(&position); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `
INSERT INTO task_queue(id,task_id,agent_id,input_hash,position,data,state)
VALUES(?,?,?,?,?,?,'queued')`,
			input.CommandID, input.TaskID, input.AgentID, digest, position, store.JSON(entry))
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
	if agent.Archived || agent.Profile.TaskQueuePaused {
		return false, nil
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
	if entry.Record == model.TaskRecordNote {
		a.notesMu.Lock()
		defer a.notesMu.Unlock()
	}
	_, err = a.sendLocked(ctx, model.SendInput{
		CommandID: ID(), AgentID: agentID, WorkingCopyID: entry.WorkingCopyID,
		Operation: "topic", Text: taskMessage(entry.Text, entry.Note),
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
