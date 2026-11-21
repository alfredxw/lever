package app

import (
	"context"
	"database/sql"

	"lever/internal/model"
	"lever/internal/store"
)

const externalTaskColumns = `'id',e.id,'source',s.contribution_id,'project',s.name,
  'reference',json_extract(e.data,'$.reference'),'kind',json_extract(e.data,'$.kind'),
  'state',json_extract(e.data,'$.state'),'title',json_extract(e.data,'$.title'),
  'done',json(CASE WHEN e.done THEN 'true' ELSE 'false' END)`

const externalTaskFrom = " FROM external_tasks e JOIN task_sources s ON s.id=e.source_id"

func (a *App) ExternalTasks(ctx context.Context) ([]model.ExternalTask, error) {
	// Keep tasks with local work when they leave their source's sync scope.
	return store.List[model.ExternalTask](ctx, a.Store.DB,
		"SELECT json_object("+externalTaskColumns+")"+externalTaskFrom+`
WHERE (s.status<>'removed' AND e.in_scope AND (s.sync_kind='both' OR s.sync_kind=json_extract(e.data,'$.kind')))
OR e.done=1 OR EXISTS(
  SELECT 1 FROM chats WHERE json_type(data,'$.taskId')='text' AND json_extract(data,'$.taskId')=e.id
)
OR EXISTS(SELECT 1 FROM task_triage WHERE task_id=e.id AND closed=1)
OR EXISTS(SELECT 1 FROM task_queue WHERE task_id=e.id AND state='queued')
ORDER BY s.name COLLATE NOCASE,e.rowid DESC`)
}

func (a *App) ExternalTask(ctx context.Context, id string) (model.ExternalTask, error) {
	return readExternalTask(ctx, a.Store.DB, id)
}

func readExternalTask(ctx context.Context, q store.Queryer, id string) (model.ExternalTask, error) {
	return store.Get[model.ExternalTask](ctx, q,
		"SELECT json_object("+externalTaskColumns+`,'url',json_extract(e.data,'$.url'),'body',json_extract(e.data,'$.body'))`+
			externalTaskFrom+" WHERE e.id=?", id)
}

func (a *App) DispatchExternalTask(ctx context.Context, id string, input model.ExternalTaskDispatch) (model.Run, error) {
	if !taskIDPattern.MatchString(id) || input.AgentID == "" {
		return model.Run{}, invalid("Select a task and an Agent")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	task, err := a.ExternalTask(ctx, id)
	if err != nil {
		return model.Run{}, err
	}
	text := task.Title + "\n\n" + task.URL
	if task.Body != "" {
		text += "\n\n" + task.Body
	}
	return a.dispatchStoredTask(ctx, model.TaskRecordExternal, id, task.Title, text, input)
}

func (a *App) SetExternalTaskDone(ctx context.Context, id string, done bool) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		var current bool
		if err := tx.QueryRowContext(ctx, "SELECT done FROM external_tasks WHERE id=?", id).Scan(&current); err != nil || current == done {
			return err
		}
		if done {
			if err := checkTaskCompletable(ctx, tx, id); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE external_tasks SET done=? WHERE id=?", done, id); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "external-tasks"})
	})
}
