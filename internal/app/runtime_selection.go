package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

const lastRuntimeSelectionKey = "last_runtime_selection"

func lastRuntimeSelection(ctx context.Context, q store.Queryer) (*model.Selection, error) {
	var raw string
	err := q.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", lastRuntimeSelectionKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var parsed model.Selection
	if json.Unmarshal([]byte(raw), &parsed) != nil || strings.TrimSpace(parsed.Provider) == "" {
		return nil, nil
	}
	parsed.Permission = ""
	return &parsed, nil
}

func saveLastRuntimeSelection(ctx context.Context, tx *sql.Tx, sel model.Selection) error {
	if strings.TrimSpace(sel.Provider) == "" {
		return nil
	}
	stored := model.Selection{
		Provider: sel.Provider,
		Model:    sel.Model,
		Effort:   sel.Effort,
		Fast:     sel.Fast,
	}
	_, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, lastRuntimeSelectionKey, store.JSON(stored))
	return err
}

func defaultRuntimeSelectionForNewAgent(ctx context.Context, q store.Queryer) (model.Selection, error) {
	if saved, err := lastRuntimeSelection(ctx, q); err != nil {
		return model.Selection{}, err
	} else if saved != nil {
		if config, available, err := lookupProvider(ctx, q, saved.Provider); err == nil && available {
			candidate := *saved
			if _, err := provider.ResolveSelectionWithDefault(candidate, model.Selection{}, config, ""); err != nil {
				candidate.Effort = ""
				candidate.Fast = false
			}
			candidate.Permission = ""
			return candidate, nil
		}
	}
	configs, err := store.List[model.Provider](ctx, q, "SELECT data FROM providers ORDER BY CASE id WHEN 'codex' THEN 0 WHEN 'claude' THEN 1 WHEN 'antigravity' THEN 2 WHEN 'pi' THEN 3 WHEN 'dsh' THEN 4 ELSE 5 END, rowid")
	if err != nil {
		return model.Selection{}, err
	}
	var fallback string
	for _, config := range configs {
		config, available, err := runtimeProvider(ctx, q, config)
		if err != nil {
			return model.Selection{}, err
		}
		if !available {
			continue
		}
		if fallback == "" {
			fallback = config.ID
		}
		if _, err := provider.Executable(ctx, config); err == nil {
			return model.Selection{Provider: config.ID}, nil
		}
	}
	if fallback != "" {
		return model.Selection{Provider: fallback}, nil
	}
	return model.Selection{}, invalid("Enable a runtime before creating an Agent")
}

func cachedCatalogForProvider(ctx context.Context, q store.Queryer, config model.Provider) *model.Catalog {
	if config.Type != "acp" && config.Type != "antigravity" {
		return nil
	}
	saved, err := store.Get[model.Catalog](ctx, q,
		"SELECT data FROM provider_catalogs WHERE provider_id=? AND config_dir=? ORDER BY rowid DESC LIMIT 1",
		config.ID, provider.ConfigurationDirectory(config))
	if err != nil || saved.Provider != config.ID || (len(saved.Permissions) == 0 && len(saved.LegacyPermissions) == 0) {
		return nil
	}
	normalized := provider.NormalizeCatalog(config, saved)
	return &normalized
}

func agentPermissionForProvider(ctx context.Context, q store.Queryer, profile model.Profile, target model.Provider) (string, error) {
	settings, err := permissionSettings(ctx, q)
	if err != nil {
		return "", err
	}
	catalog := cachedCatalogForProvider(ctx, q, target)
	return provider.PermissionForPolicy(target, catalog, profile.Permission, settings.DefaultMode, profile.Provider == target.ID), nil
}

func agentDefaultSelection(ctx context.Context, q store.Queryer, agent model.Agent) (model.Selection, error) {
	sel := model.Selection{
		Provider: agent.Profile.Provider,
		Model:    agent.Profile.Model,
		Effort:   agent.Profile.Effort,
		Fast:     agent.Profile.Fast,
	}
	if sel.Provider == "" {
		return sel, nil
	}
	config, err := store.Get[model.Provider](ctx, q, "SELECT data FROM providers WHERE id=?", sel.Provider)
	if errors.Is(err, sql.ErrNoRows) {
		sel.Permission = agent.Profile.Permission
		return sel, nil
	}
	if err != nil {
		return sel, err
	}
	sel.Permission, err = agentPermissionForProvider(ctx, q, agent.Profile, config)
	return sel, err
}

func (a *App) SaveAgentSelection(ctx context.Context, id string, input model.Selection) (model.Agent, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return model.Agent{}, invalid("Agent is required")
	}
	clean := model.Selection{
		Provider: strings.TrimSpace(input.Provider),
		Model:    strings.TrimSpace(input.Model),
		Effort:   strings.TrimSpace(input.Effort),
		Fast:     input.Fast,
	}
	if clean.Provider == "" {
		return model.Agent{}, invalid("Runtime is required")
	}
	if err := validateSelection(&clean); err != nil {
		return model.Agent{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	config, err := configuredProvider(ctx, a.Store.DB, clean.Provider)
	if err != nil {
		return model.Agent{}, err
	}
	if _, err := provider.ResolveSelectionWithDefault(clean, model.Selection{}, config, ""); err != nil {
		return model.Agent{}, invalid(err.Error())
	}
	var agent model.Agent
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		agent, err = store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", id)
		if err != nil {
			return err
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		if err := saveLastRuntimeSelection(ctx, tx, clean); err != nil {
			return err
		}
		changed := agent.Profile.Provider != clean.Provider ||
			agent.Profile.Model != clean.Model ||
			agent.Profile.Effort != clean.Effort ||
			agent.Profile.Fast != clean.Fast
		if !changed {
			return nil
		}
		agent.Profile.Provider = clean.Provider
		agent.Profile.Model = clean.Model
		agent.Profile.Effort = clean.Effort
		agent.Profile.Fast = clean.Fast
		agent.UpdatedAt = now()
		if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "agents"})
	})
	return agent, err
}
