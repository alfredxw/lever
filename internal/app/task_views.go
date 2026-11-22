package app

import (
	"context"
	"database/sql"
	"strings"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) TaskViews(ctx context.Context) ([]model.TaskView, error) {
	return store.List[model.TaskView](ctx, a.Store.DB, "SELECT data FROM task_views ORDER BY rowid")
}

func (a *App) SaveTaskView(ctx context.Context, id string, view model.TaskView) (model.TaskView, error) {
	view.Name = strings.TrimSpace(view.Name)
	if id != view.ID || !taskIDPattern.MatchString(id) || view.Name == "" || !validTaskLabel(view.Name) {
		return model.TaskView{}, invalid("Enter a view name up to 100 characters")
	}
	switch view.Group {
	case "status", "project", "agent":
	default:
		return model.TaskView{}, invalid("Unknown task grouping")
	}
	switch view.Sort {
	case "", "deadline", "priority":
	default:
		return model.TaskView{}, invalid("Unknown task sort order")
	}
	switch view.QuickFilter {
	case "", "agent", "kind", "status", "project", "none":
	default:
		return model.TaskView{}, invalid("Unknown quick filter")
	}
	expected := view.Revision
	view.Revision++
	data := store.JSON(view)
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var result sql.Result
		var err error
		if expected == 0 {
			result, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO task_views(id,data) VALUES(?,?)", id, data)
		} else {
			result, err = tx.ExecContext(ctx, "UPDATE task_views SET data=? WHERE id=? AND json_extract(data,'$.revision')=?", data, id, expected)
		}
		if err != nil {
			return err
		}
		if changed, err := result.RowsAffected(); err != nil {
			return err
		} else if changed == 0 {
			var saved string
			err := tx.QueryRowContext(ctx, "SELECT data FROM task_views WHERE id=?", id).Scan(&saved)
			if err == nil && saved == data {
				return nil
			}
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			return conflict("This view changed in another window")
		}
		return store.Event(tx, model.Event{Type: "task-views"})
	})
	return view, err
}

func (a *App) DeleteTaskView(ctx context.Context, id string, revision int64) error {
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "DELETE FROM task_views WHERE id=? AND json_extract(data,'$.revision')=?", id, revision)
		if err != nil {
			return err
		}
		if changed, err := result.RowsAffected(); err != nil {
			return err
		} else if changed == 0 {
			var exists bool
			if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM task_views WHERE id=?)", id).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return conflict("This view changed in another window")
			}
			return nil
		}
		return store.Event(tx, model.Event{Type: "task-views"})
	})
}
