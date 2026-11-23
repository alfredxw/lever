package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"lever/internal/model"
	"lever/internal/store"
)

const taskDispatchSettingsKey = "task_dispatch_settings"

var defaultTaskDispatchSettings = model.TaskDispatchSettings{
	ChatMode: model.TaskChatModeSingle,
}

func taskDispatchSettings(ctx context.Context, q store.Queryer) (model.TaskDispatchSettings, error) {
	var raw string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", taskDispatchSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultTaskDispatchSettings, nil
	}
	if err != nil {
		return defaultTaskDispatchSettings, err
	}
	var parsed model.TaskDispatchSettings
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil || !parsed.ChatMode.Valid() {
		return defaultTaskDispatchSettings, nil
	}
	return parsed, nil
}

func (a *App) TaskDispatchSettings(ctx context.Context) (model.TaskDispatchSettings, error) {
	return taskDispatchSettings(ctx, a.Store.DB)
}

func (a *App) SaveTaskDispatchSettings(ctx context.Context, input model.TaskDispatchSettings) (model.TaskDispatchSettings, error) {
	if !input.ChatMode.Valid() {
		return model.TaskDispatchSettings{}, invalid("Choose a valid work conversation mode")
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, taskDispatchSettingsKey, store.JSON(input)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-dispatch-settings"})
	})
	return input, err
}
