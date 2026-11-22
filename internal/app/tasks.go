package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/store"
)

var taskIDPattern = notes.IDPattern

// The caller holds notesMu for note-backed tasks.
func (a *App) openTaskSource(ctx context.Context, q store.Queryer, record model.TaskRecord, id, noteID string) (model.TaskNote, error) {
	return a.readBoardSource(ctx, q, record, id, noteID, true)
}

func (a *App) readBoardSource(ctx context.Context, q store.Queryer, record model.TaskRecord, id, noteID string, requireOpen bool) (model.TaskNote, error) {
	switch record {
	case model.TaskRecordExternal, model.TaskRecordWorkItem, model.TaskRecordAutomation:
		query := "SELECT done FROM external_tasks WHERE id=?"
		if record == model.TaskRecordWorkItem {
			query = "SELECT json_extract(data,'$.done') FROM work_items WHERE id=?"
		} else if record == model.TaskRecordAutomation {
			if requireOpen {
				return model.TaskNote{}, invalid("Run an automation from its plan")
			}
			query = "SELECT done FROM automation_runs WHERE id=? AND work_item=1 AND run_id IS NOT NULL"
		}
		var done bool
		err := q.QueryRowContext(ctx, query, id).Scan(&done)
		if errors.Is(err, sql.ErrNoRows) || (requireOpen && done) {
			return model.TaskNote{}, conflict("The task must be present and open")
		}
		return model.TaskNote{}, err
	case model.TaskRecordNote:
		catalog, err := a.readNotes(ctx)
		if err != nil {
			return model.TaskNote{}, err
		}
		if err := catalog.conflicts[noteID]; err != nil {
			return model.TaskNote{}, err
		}
		task := catalog.tasks[id]
		if task.NoteID == "" || task.NoteID != noteID || (requireOpen && task.Done) || task.Deleted {
			if catalog.notes[noteID].ID == "" && catalog.unavailable != nil {
				return model.TaskNote{}, catalog.unavailable
			}
			return model.TaskNote{}, conflict("The task must be present and open")
		}
		return catalog.notes[noteID], nil
	}
	return model.TaskNote{}, invalid("Choose a task")
}

// A task owns one Topic, or the main session of its original task Chat.
const taskSessions = `
SELECT s.id AS session_id,s.chat_id,json_extract(s.data,'$.agentId') AS agent_id,
  json_extract(s.data,'$.taskId') AS task_id,json_extract(s.data,'$.createdAt') AS dispatched_at,1 AS topic
FROM sessions s WHERE s.kind='topic' AND json_type(s.data,'$.taskId')='text'
UNION ALL
SELECT s.id,c.id,c.agent_id,json_extract(c.data,'$.taskId'),json_extract(c.data,'$.createdAt'),0
FROM chats c JOIN sessions s ON s.chat_id=c.id AND s.kind='main' WHERE json_type(c.data,'$.taskId')='text'`

func checkTaskUnlinked(ctx context.Context, q store.Queryer, id string) error {
	var linked bool
	if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM (`+taskSessions+`) WHERE task_id=?)`, id).Scan(&linked); err != nil {
		return err
	}
	if linked {
		return conflict("This task already has a conversation")
	}
	return nil
}

func prepareTaskHandoff(ctx context.Context, tx *sql.Tx, id string) error {
	var returned bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM task_triage WHERE task_id=? AND disposition='todo' AND closed=0)", id).Scan(&returned); err != nil {
		return err
	}
	if !returned {
		return checkTaskUnlinked(ctx, tx, id)
	}
	if running, err := taskHasUnfinishedRuns(ctx, tx, id); err != nil {
		return err
	} else if running {
		return conflict("Stop the previous execution or wait for it to finish before dispatching again")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE sessions SET data=json_remove(data,'$.taskId') WHERE kind='topic' AND data->>'taskId'=?", id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "UPDATE chats SET data=json_remove(data,'$.taskId') WHERE data->>'taskId'=?", id)
	return err
}

func checkTaskNotClosed(ctx context.Context, q store.Queryer, id string) error {
	var closed bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM task_triage WHERE task_id=? AND closed=1)", id).Scan(&closed); err != nil {
		return err
	}
	if closed {
		return conflict("Reopen this task first")
	}
	return nil
}

func checkTaskInBoard(ctx context.Context, q store.Queryer, id string) error {
	var removed bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM task_triage WHERE task_id=? AND disposition='deleted')", id).Scan(&removed); err != nil {
		return err
	}
	if removed {
		return sql.ErrNoRows
	}
	return nil
}

func checkTaskNotQueued(ctx context.Context, q store.Queryer, id string) error {
	var queued bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM task_queue WHERE task_id=? AND state='queued')", id).Scan(&queued); err != nil {
		return err
	}
	if queued {
		return conflict("Withdraw this task from the Agent's queue first")
	}
	return nil
}

func markTaskAccepted(ctx context.Context, tx *sql.Tx, id string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO task_triage(task_id,accepted) VALUES(?,1)
ON CONFLICT(task_id) DO UPDATE SET accepted=1`, id)
	return err
}

func (a *App) acceptTask(ctx context.Context, tx *sql.Tx, record model.TaskRecord, input model.TaskDispatch, queued *queuedTask) (taskDelivery, error) {
	note, err := a.openTaskSource(ctx, tx, record, input.TaskID, input.NoteID)
	if err != nil {
		return taskDelivery{}, err
	}
	if err := prepareTaskHandoff(ctx, tx, input.TaskID); err != nil {
		return taskDelivery{}, err
	}
	if err := checkTaskNotClosed(ctx, tx, input.TaskID); err != nil {
		return taskDelivery{}, err
	}
	if queued == nil {
		if err := checkTaskNotQueued(ctx, tx, input.TaskID); err != nil {
			return taskDelivery{}, err
		}
		if note.ID != "" && note.Version != input.Version {
			return taskDelivery{}, conflict("The task note changed before dispatch")
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE task_triage SET disposition='' WHERE task_id=? AND disposition='todo'", input.TaskID); err != nil {
		return taskDelivery{}, err
	}
	if record == model.TaskRecordWorkItem {
		if err := markTaskAccepted(ctx, tx, input.TaskID); err != nil {
			return taskDelivery{}, err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE work_items SET data=json_set(data,'$.assigneeAgentId',?) WHERE id=?", input.AgentID, input.TaskID); err != nil {
			return taskDelivery{}, err
		}
		if err := store.Event(tx, model.Event{Type: "work-items"}); err != nil {
			return taskDelivery{}, err
		}
		return taskDelivery{Task: &model.RunTask{ID: input.TaskID, Record: record}}, nil
	}
	if note.ID == "" {
		return taskDelivery{}, nil
	}
	var delivery taskDelivery
	if queued != nil && (queued.Task != nil || note.Version != input.Version) {
		// Older queue entries only have an entire-note version. Keep their
		// original attachments and require review if that note has changed.
		delivery = queued.taskDelivery
	} else if delivery, err = noteDispatch(note, input.TaskID); err != nil {
		return taskDelivery{}, err
	}
	delivery.noteTitle = note.Title
	return delivery, nil
}

func (a *App) DispatchTask(ctx context.Context, input model.TaskDispatch) (model.Run, error) {
	input.Title = strings.TrimSpace(input.Title)
	input.Note = strings.TrimSpace(input.Note)
	if !taskIDPattern.MatchString(input.TaskID) || !taskIDPattern.MatchString(input.NoteID) ||
		input.AgentID == "" || input.Title == "" || utf8.RuneCountInString(input.Title) > 80 {
		return model.Run{}, invalid("Select a task and an Agent")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	return a.sendLocked(ctx, model.SendInput{
		CommandID: input.CommandID, AgentID: input.AgentID, WorkingCopyID: input.WorkingCopyID,
		Operation: "topic", Text: taskMessage(input.Text, input.Note),
	}, sendOrigin{task: &input, taskRecord: model.TaskRecordNote})
}

// The caller holds App.mu. Stored tasks are handed off from their saved content.
func (a *App) dispatchStoredTask(ctx context.Context, record model.TaskRecord, id, title, text string, input model.ExternalTaskDispatch) (model.Run, error) {
	label := []rune(strings.TrimSpace(title))
	note := strings.TrimSpace(input.Note)
	return a.sendLocked(ctx, model.SendInput{
		CommandID: input.CommandID, AgentID: input.AgentID, WorkingCopyID: input.WorkingCopyID,
		Operation: "main", Text: taskMessage(text, note),
	}, sendOrigin{
		taskRecord: record,
		task:       &model.TaskDispatch{TaskID: id, Title: string(label[:min(len(label), 80)]), AgentID: input.AgentID, Note: note},
	})
}

func taskMessage(text, note string) string {
	if note == "" {
		return text
	}
	return text + "\n\n" + note
}

func checkTaskCompletable(ctx context.Context, tx *sql.Tx, id string) error {
	if err := checkTaskNotClosed(ctx, tx, id); err != nil {
		return err
	}
	if err := checkTaskNotQueued(ctx, tx, id); err != nil {
		return err
	}
	running, err := taskHasUnfinishedRuns(ctx, tx, id)
	if err == nil && running {
		return conflict("Wait for the task's Agent to finish before marking it complete")
	}
	return err
}

func taskHasUnfinishedRuns(ctx context.Context, q store.Queryer, id string) (bool, error) {
	var running bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(
SELECT 1 FROM (`+taskSessions+`) s JOIN runs r USING(session_id)
WHERE s.task_id=?
AND r.status IN ('starting','running','waiting_user','cancelling','unknown','paused','queued','steering'))`, id).Scan(&running)
	return running, err
}

func (a *App) TaskExecutions(ctx context.Context) ([]model.TaskExecution, error) {
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	catalog, err := a.readNotes(ctx)
	if err != nil {
		// Notes has its own error state. Preserve execution status for SQLite-backed items.
		catalog.tasks = nil
	} else {
		for id, task := range catalog.tasks {
			if catalog.conflicts[task.NoteID] != nil {
				delete(catalog.tasks, id)
			}
		}
	}
	return store.List[model.TaskExecution](ctx, a.Store.DB, `WITH task_sessions AS (`+taskSessions+`) SELECT data FROM (
SELECT json_object('taskId',s.task_id, 'noteId',COALESCE(json_extract(t.value,'$.noteId'),''),
  'record',CASE WHEN w.id IS NOT NULL THEN 'workItem' WHEN e.id IS NOT NULL THEN 'external' ELSE 'note' END,
  'chatId',s.chat_id, 'agentId',s.agent_id, 'sessionId',s.session_id, 'runId',COALESCE(r.id,''), 'status',COALESCE(r.status,''),
  'dispatchedAt',s.dispatched_at, 'topic',json(IIF(s.topic,'true','false')),
  'activityAt',COALESCE(NULLIF(json_extract(r.data,'$.finishedAt'),''),NULLIF(json_extract(r.data,'$.startedAt'),''),json_extract(r.data,'$.createdAt')),
  'done',json(CASE WHEN COALESCE(json_extract(w.data,'$.done'),e.done,json_extract(t.value,'$.done'),0) THEN 'true' ELSE 'false' END)) AS data,
  r.sequence AS sequence
FROM task_sessions s
LEFT JOIN json_each(?) t ON t.key=s.task_id AND COALESCE(json_extract(t.value,'$.deleted'),0)=0
LEFT JOIN external_tasks e ON e.id=s.task_id
LEFT JOIN work_items w ON w.id=s.task_id
LEFT JOIN runs r ON r.id=(
  SELECT id FROM runs WHERE session_id=s.session_id AND position IS NOT NULL AND status NOT IN ('steering','steered','cancelled')
    AND json_extract(data,'$.automationId') IS NULL
  ORDER BY CASE WHEN status IN ('starting','running','waiting_user','cancelling','unknown') THEN 0 ELSE 1 END,
    position DESC LIMIT 1
)
WHERE t.key IS NOT NULL OR e.id IS NOT NULL OR w.id IS NOT NULL
UNION ALL SELECT `+automationExecution+`,r.sequence`+automationRunJoin+` WHERE r.id IS NOT NULL AND ar.work_item=1
) execution WHERE NOT EXISTS(SELECT 1 FROM task_triage WHERE task_id=execution.data->>'taskId' AND disposition='deleted')
ORDER BY sequence DESC
`, store.JSON(catalog.tasks))
}

func (a *App) LocateTask(ctx context.Context, taskID string) (model.TaskLocation, error) {
	if err := checkTaskInBoard(ctx, a.Store.DB, taskID); err != nil {
		return model.TaskLocation{}, err
	}
	location, err := store.Get[model.TaskLocation](ctx, a.Store.DB, `SELECT '{"record":"workItem"}' FROM work_items WHERE id=?
UNION ALL SELECT '{"record":"external"}' FROM external_tasks WHERE id=?
UNION ALL SELECT '{"record":"automation"}' FROM automation_runs WHERE id=? AND run_id IS NOT NULL AND work_item=1 LIMIT 1`, taskID, taskID, taskID)
	if !errors.Is(err, sql.ErrNoRows) {
		return location, err
	}
	a.notesMu.Lock()
	defer a.notesMu.Unlock()
	catalog, err := a.readNotes(ctx)
	if err != nil {
		return model.TaskLocation{}, err
	}
	if task, ok := catalog.tasks[taskID]; ok && !task.Deleted {
		if err := catalog.conflicts[task.NoteID]; err != nil {
			return model.TaskLocation{}, err
		}
		return model.TaskLocation{Record: model.TaskRecordNote, NoteID: task.NoteID}, nil
	}
	return model.TaskLocation{}, sql.ErrNoRows
}
