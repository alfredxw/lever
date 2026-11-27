package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

const permissionSettingsKey = "permission_settings"

var defaultPermissionSettings = model.PermissionSettings{
	DefaultMode: model.DefaultPermissionAuto,
}

func permissionSettings(ctx context.Context, q store.Queryer) (model.PermissionSettings, error) {
	settings := defaultPermissionSettings
	var raw string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", permissionSettingsKey).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return settings, err
	}
	if err == nil {
		var parsed model.PermissionSettings
		if json.Unmarshal([]byte(raw), &parsed) == nil && parsed.DefaultMode.Valid() {
			settings.DefaultMode = parsed.DefaultMode
		}
	}
	var pending bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?)", store.PermissionSetupPending).Scan(&pending); err != nil {
		return settings, err
	}
	settings.NeedsSetup = pending
	return settings, nil
}

func defaultPermissionForProvider(ctx context.Context, q store.Queryer, config model.Provider, mode model.DefaultPermissionMode) string {
	if config.Type == "acp" || config.Type == "antigravity" {
		saved, err := store.Get[model.Catalog](ctx, q,
			"SELECT data FROM provider_catalogs WHERE provider_id=? AND config_dir=? ORDER BY rowid DESC LIMIT 1",
			config.ID, provider.ConfigurationDirectory(config))
		if err == nil && saved.Provider == config.ID && len(saved.Permissions) > 0 {
			saved = provider.NormalizeCatalog(config, saved)
			if permission := provider.DefaultPermissionForCatalog(saved, mode); permission != "" {
				return permission
			}
		}
	}
	return provider.DefaultPermissionForMode(config, mode)
}

func (a *App) PermissionSettings(ctx context.Context) (model.PermissionSettings, error) {
	return permissionSettings(ctx, a.Store.DB)
}

func (a *App) SavePermissionSettings(ctx context.Context, input model.PermissionSettings) (model.PermissionSettings, error) {
	if !input.DefaultMode.Valid() {
		return model.PermissionSettings{}, invalid("Default permission mode must be 'auto' or 'yolo'")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	stored := model.PermissionSettings{DefaultMode: input.DefaultMode}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var wasPending bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?)", store.PermissionSetupPending).Scan(&wasPending); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, permissionSettingsKey, store.JSON(stored)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM settings WHERE key=?", store.PermissionSetupPending); err != nil {
			return err
		}
		if wasPending {
			updatedStarter, err := syncUntouchedStarterAgentPermission(ctx, tx, input.DefaultMode)
			if err != nil {
				return err
			}
			if updatedStarter {
				if err := store.Event(tx, model.Event{Type: "agents"}); err != nil {
					return err
				}
			}
		}
		return store.Event(tx, model.Event{Type: "permission-settings"})
	})
	return stored, err
}

// syncUntouchedStarterAgentPermission updates the pre-created starter Agent on
// first launch once the user picks Auto or YOLO, provided it has not been used yet.
func syncUntouchedStarterAgentPermission(ctx context.Context, tx *sql.Tx, mode model.DefaultPermissionMode) (bool, error) {
	agents, err := store.List[model.Agent](ctx, tx, "SELECT data FROM agents")
	if err != nil || len(agents) != 1 {
		return false, err
	}
	agent := agents[0]
	if agent.Archived || agent.Avatar == nil || agent.Avatar.Kind != "preset" || agent.Avatar.Value != model.StarterAvatarPreset {
		return false, nil
	}
	if agent.Profile.Permission == "" {
		// An omitted profile permission already inherits the global default mode dynamically.
		return false, nil
	}
	var used bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM chats WHERE agent_id=? UNION ALL SELECT 1 FROM runs WHERE agent_id=?)`, agent.ID, agent.ID).Scan(&used); err != nil || used {
		return false, err
	}
	config, err := store.Get[model.Provider](ctx, tx, "SELECT data FROM providers WHERE id=?", agent.Profile.Provider)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	nextPermission := defaultPermissionForProvider(ctx, tx, config, mode)
	if nextPermission == "" || nextPermission == agent.Profile.Permission {
		return false, nil
	}
	agent.Profile.Permission = nextPermission
	agent.UpdatedAt = now()
	if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
		return false, err
	}
	return true, nil
}
