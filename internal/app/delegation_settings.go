package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"lever/internal/model"
	"lever/internal/store"
)

const delegationSettingsKey = "delegation_settings"

var defaultDelegationSettings = model.DelegationSettings{
	DefaultPolicy: model.DelegationPolicyNone,
}

func delegationSettings(ctx context.Context, q store.Queryer) (model.DelegationSettings, error) {
	var raw string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", delegationSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultDelegationSettings, nil
	}
	if err != nil {
		return defaultDelegationSettings, err
	}
	var parsed model.DelegationSettings
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return defaultDelegationSettings, nil
	}
	if parsed.DefaultPolicy != model.DelegationPolicyNone && parsed.DefaultPolicy != model.DelegationPolicyAll {
		return defaultDelegationSettings, nil
	}
	if parsed.MaxDepth != 0 && parsed.MaxDepth != 1 && parsed.MaxDepth != 2 {
		parsed.MaxDepth = 1
	}
	if parsed.MaxConcurrent < 0 || parsed.MaxConcurrent > 20 {
		parsed.MaxConcurrent = 0
	}
	return parsed, nil
}

func (a *App) DelegationSettings(ctx context.Context) (model.DelegationSettings, error) {
	return delegationSettings(ctx, a.Store.DB)
}

func (a *App) SaveDelegationSettings(ctx context.Context, input model.DelegationSettings) (model.DelegationSettings, error) {
	if input.DefaultPolicy != model.DelegationPolicyNone && input.DefaultPolicy != model.DelegationPolicyAll {
		return model.DelegationSettings{}, invalid("Default delegation policy must be 'none' or 'all'")
	}
	if input.MaxDepth != 0 && input.MaxDepth != 1 && input.MaxDepth != 2 {
		return model.DelegationSettings{}, invalid("Default delegation max depth must be 1 or 2")
	}
	if input.MaxConcurrent != 0 && (input.MaxConcurrent < 1 || input.MaxConcurrent > 20) {
		return model.DelegationSettings{}, invalid("Max concurrent delegations must be between 1 and 20")
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, delegationSettingsKey, store.JSON(input)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "delegation-settings"})
	})
	return input, err
}
