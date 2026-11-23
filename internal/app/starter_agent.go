package app

import (
	"database/sql"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

// A fresh installation can create its starter Agent once it has a connection.
func (a *App) InitStarterAgent() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.initStarterAgentLocked()
}

func (a *App) initStarterAgentLocked() error {
	ctx := a.ctx

	var pending bool
	if err := a.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM settings WHERE key=?)
AND NOT EXISTS(SELECT 1 FROM agents)`, store.StarterAgentPending).Scan(&pending); err != nil || !pending {
		return err
	}
	configs, err := a.providerConfigs(ctx)
	if err != nil {
		return err
	}
	var providerID string
	for _, config := range configs {
		config, available, err := runtimeProvider(ctx, a.Store.DB, config)
		if err != nil {
			return err
		}
		if !available {
			continue
		}
		if providerID == "" {
			providerID = config.ID
		}
		if _, err := provider.Executable(ctx, config); err == nil {
			providerID = config.ID
			break
		}
	}
	if providerID == "" {
		return nil
	}
	_, err = a.saveAgentLocked(ctx, model.Agent{
		Name:   "Lever",
		Avatar: &model.Avatar{Kind: "preset", Value: model.StarterAvatarPreset},
		Profile: model.Profile{
			Scope:       model.Scope{Roots: []model.Root{{Path: "~"}}},
			Provider:    providerID,
			Skills:      []string{},
			Delegations: []model.DelegationRule{},
		},
	}, func(tx *sql.Tx, _ model.Agent) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM settings WHERE key=?", store.StarterAgentPending)
		return err
	})
	return err
}
