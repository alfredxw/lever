package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"lever/internal/model"
	"lever/internal/store"
)

const questionSettingsKey = "question_settings"

var defaultQuestionSettings = model.QuestionSettings{
	TimeoutSeconds: model.DefaultQuestionTimeoutSeconds,
}

func questionSettings(ctx context.Context, q store.Queryer) (model.QuestionSettings, error) {
	var raw string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", questionSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultQuestionSettings, nil
	}
	if err != nil {
		return defaultQuestionSettings, err
	}
	var parsed model.QuestionSettings
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return defaultQuestionSettings, nil
	}
	if parsed.TimeoutSeconds < 0 || parsed.TimeoutSeconds > model.MaxQuestionTimeoutSeconds {
		return defaultQuestionSettings, nil
	}
	return parsed, nil
}

func (a *App) QuestionSettings(ctx context.Context) (model.QuestionSettings, error) {
	return questionSettings(ctx, a.Store.DB)
}

func (a *App) SaveQuestionSettings(ctx context.Context, input model.QuestionSettings) (model.QuestionSettings, error) {
	if input.TimeoutSeconds < 0 || input.TimeoutSeconds > model.MaxQuestionTimeoutSeconds {
		return model.QuestionSettings{}, invalid(fmt.Sprintf("Question timeout must be between 0 and %d seconds", model.MaxQuestionTimeoutSeconds))
	}
	stored := model.QuestionSettings{TimeoutSeconds: input.TimeoutSeconds}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, questionSettingsKey, store.JSON(stored)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "question-settings"})
	})
	return stored, err
}
