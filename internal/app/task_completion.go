package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"lever/internal/model"
	"lever/internal/notes"
	"lever/internal/store"
)

// Older runs have no task snapshot. The board and Chat can identify the
// original assignment, but an older Note no longer has a verifiable task body.
func taskForReplay(ctx context.Context, tx *sql.Tx, source *model.Run, chatTaskID, sessionKind string) (*model.RunTask, error) {
	if source.Task != nil || (source.AutomationID == "" && (sessionKind != "main" || chatTaskID == "")) {
		return source.Task, nil
	}
	var task model.RunTask
	err := tx.QueryRowContext(ctx, `SELECT id,'automation' FROM automation_runs WHERE run_id=? AND work_item=1
UNION ALL SELECT id,'workItem' FROM work_items WHERE id=? AND ?='' AND ?='main' LIMIT 1`,
		source.ID, chatTaskID, source.AutomationID, sessionKind).Scan(&task.ID, &task.Record)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &task, err
}

// An ordinary follow-up in a task conversation may finish the same local task.
// Automation cards belong to a specific fire, even when several fires share a Chat.
func (a *App) followupTask(ctx context.Context, id string) *model.RunTask {
	location, err := a.LocateTask(ctx, id)
	if err != nil {
		return nil
	}
	switch location.Record {
	case model.TaskRecordWorkItem:
		return &model.RunTask{ID: id, Record: location.Record}
	case model.TaskRecordNote:
		note, err := a.TaskNote(ctx, location.NoteID)
		if err == nil && note.State == model.TaskNoteActive {
			if delivery, err := noteDispatch(note, id); err == nil {
				return delivery.Task
			}
		}
	}
	return nil
}

func (e *execution) addTaskCompletionTool(server *mcp.Server) {
	mcp.AddTool(server, &mcp.Tool{
		Name:        "complete_current_task",
		Description: "Report that the task assigned to this run has been delivered. Lever marks it complete after this run succeeds. Leave it open when input, work or human review is still needed.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, map[string]bool, error) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if err := e.ctx.Err(); err != nil {
			return nil, nil, err
		}
		if e.run.Selection.Permission == "read_only" || e.permissionChange != nil || e.run.Status != "running" || e.run.Task == nil {
			return nil, nil, conflict("This run cannot complete the task")
		}
		if !e.run.TaskCompletionRequested {
			run := e.run
			run.TaskCompletionRequested = true
			if err := e.app.Store.Write(ctx, func(tx *sql.Tx) error { return store.SaveRun(tx, run) }); err != nil {
				return nil, nil, err
			}
			e.run.TaskCompletionRequested = true
		}
		return nil, map[string]bool{"requested": true}, nil
	})
}

func (a *App) completeNoteTask(ctx context.Context, task model.RunTask) error {
	return a.setNoteTaskCheck(ctx, task.NoteID, task.ID, &task, true)
}

func (a *App) setNoteTaskCheck(ctx context.Context, noteID, id string, snapshot *model.RunTask, done bool) error {
	note, err := a.TaskNote(ctx, noteID)
	if err != nil {
		return err
	}
	if snapshot != nil && (note.State != model.TaskNoteActive || note.Directory != snapshot.Directory) {
		return ErrTaskNoteVersion
	}
	blocks, markers, err := notes.ParseContent(note.Content)
	if err != nil {
		return err
	}
	body := notes.TaskBlocks(blocks, id)
	if len(body) == 0 {
		return conflict("The dispatched task is no longer in this note")
	}
	if snapshot != nil && hash(body) != snapshot.Version {
		return ErrTaskNoteVersion
	}
	if markers[id].Done == done {
		return nil
	}
	var attrs map[string]json.RawMessage
	if err := json.Unmarshal(body[0].Attrs, &attrs); err != nil {
		return err
	}
	attrs["done"], _ = json.Marshal(done)
	body[0].Attrs, err = json.Marshal(attrs)
	if err != nil {
		return err
	}
	note.Content, err = notes.Content(blocks)
	if err != nil {
		return err
	}
	_, err = a.SaveTaskNote(ctx, note.ID, note)
	return err
}
