package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

func localProviderConfig(p model.Plugin, item model.ProviderContribution) model.Provider {
	config := model.Provider{PluginID: p.ID, ContributionID: item.ID, Type: item.Driver, Name: item.Name, Command: item.Command, Args: item.Args, Enabled: true}
	if config.Args == nil {
		config.Args = []string{}
	}
	if p.ID == "lever.antigravity" {
		config.Command = "agy" // The empty command selects Lever's managed ACP runtime.
	}
	return config
}

func localProvider(ctx context.Context, p model.Plugin, item model.ProviderContribution) (model.Provider, string) {
	config := localProviderConfig(p, item)
	if config.Type == "acp" && config.Command == "" {
		return config, ""
	}
	path, _ := provider.Executable(ctx, pluginProvider(p, config))
	return config, path
}

func sameProviderPath(left, right string) bool {
	if left == right {
		return true
	}
	a, errA := os.Stat(left)
	b, errB := os.Stat(right)
	return errA == nil && errB == nil && os.SameFile(a, b)
}

func connectedLocalProvider(ctx context.Context, configs []model.Provider, source model.Provider, path string) (model.Provider, bool) {
	for _, config := range configs {
		if config.PluginID != source.PluginID || config.ContributionID != source.ContributionID || !slices.Equal(config.Args, source.Args) ||
			!sameProviderPath(provider.ConfigurationDirectory(config), provider.ConfigurationDirectory(source)) {
			continue
		}
		if config.Command == source.Command {
			return config, true
		}
		if executable, err := provider.Executable(ctx, config); err == nil {
			left, errA := filepath.EvalSymlinks(path)
			right, errB := filepath.EvalSymlinks(executable)
			if errA == nil && errB == nil && left == right {
				return config, true
			}
		}
	}
	return model.Provider{}, false
}

func localProviderID(p model.Plugin, contributionID string, configs []model.Provider) string {
	if p.Builtin && !slices.ContainsFunc(configs, func(config model.Provider) bool { return config.ID == contributionID }) {
		return contributionID
	}
	return ID()
}

func localProviderOptOutKey(pluginID, contributionID string) string {
	return "providers.local.optOut/" + pluginID + "/" + contributionID
}

// ConnectLocalProviders adopts the built-in CLI defaults that exist on this host.
// Discovery must not start a runtime or replace an existing connection.
func (a *App) ConnectLocalProviders(ctx context.Context) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	plugins, err := a.Plugins(ctx)
	if err != nil {
		return false, err
	}
	configs, err := a.providerConfigs(ctx)
	if err != nil {
		return false, err
	}
	ctx = provider.WithStateDir(ctx, a.Store.Dir)
	start := len(configs)
	for _, p := range plugins {
		if !p.Builtin || !p.Enabled {
			continue
		}
		for _, item := range p.Manifest.Contributes.Providers {
			config, path := localProvider(ctx, p, item)
			if path == "" {
				continue
			}
			if _, found := connectedLocalProvider(ctx, configs, config, path); found {
				continue
			}
			var optedOut bool
			if err := a.Store.DB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?)", localProviderOptOutKey(p.ID, item.ID)).Scan(&optedOut); err != nil {
				return false, err
			}
			if optedOut {
				continue
			}
			if err := validateProvider(config); err != nil {
				return false, err
			}
			config.ID = localProviderID(p, item.ID, configs)
			configs = append(configs, config)
		}
	}
	if len(configs) == start {
		return false, nil
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		for _, config := range configs[start:] {
			if _, err := tx.ExecContext(ctx, "INSERT INTO providers(id,data) VALUES(?,?)", config.ID, store.JSON(config)); err != nil {
				return err
			}
		}
		return store.Event(tx, model.Event{Type: "providers"})
	})
	if err != nil {
		return false, err
	}
	if err := a.initStarterAgentLocked(); err != nil {
		slog.Warn("initialize starter Agent after connecting local runtimes", "error", err)
	}
	return true, nil
}

func rememberLocalProviderRemoval(ctx context.Context, tx *sql.Tx, config model.Provider) error {
	p, err := store.Get[model.Plugin](ctx, tx, "SELECT data FROM plugins WHERE id=?", config.PluginID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil || !p.Builtin {
		return err
	}
	for _, item := range p.Manifest.Contributes.Providers {
		if item.ID != config.ContributionID {
			continue
		}
		source, path := localProvider(ctx, p, item)
		if source.Type == "acp" && source.Command == "" {
			return nil
		}
		if _, found := connectedLocalProvider(ctx, []model.Provider{config}, source, path); found {
			_, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO settings(key,value) VALUES(?,'1')", localProviderOptOutKey(p.ID, item.ID))
			return err
		}
	}
	return nil
}

func (a *App) ProviderCandidates(ctx context.Context) ([]model.ProviderCandidate, error) {
	plugins, err := a.Plugins(ctx)
	if err != nil {
		return nil, err
	}
	configs, err := a.providerConfigs(ctx)
	if err != nil {
		return nil, err
	}
	result := []model.ProviderCandidate{}
	ctx = provider.WithStateDir(ctx, a.Store.Dir)
	for _, p := range plugins {
		if !p.Enabled {
			continue
		}
		for _, item := range p.Manifest.Contributes.Providers {
			config, path := localProvider(ctx, p, item)
			if path == "" {
				continue
			}
			if _, found := connectedLocalProvider(ctx, configs, config, path); !found {
				result = append(result, model.ProviderCandidate{PluginID: p.ID, ContributionID: item.ID, Name: item.Name, Path: path, ConfigPath: provider.ConfigurationDirectory(config)})
			}
		}
	}
	return result, nil
}

func (a *App) UseLocalProvider(ctx context.Context, pluginID, contributionID string) (model.Provider, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := store.Get[model.Plugin](ctx, a.Store.DB, "SELECT data FROM plugins WHERE id=?", pluginID)
	if err != nil {
		return model.Provider{}, err
	}
	index := slices.IndexFunc(p.Manifest.Contributes.Providers, func(item model.ProviderContribution) bool { return item.ID == contributionID })
	if !p.Installed || !p.Enabled || index < 0 {
		return model.Provider{}, invalid("This provider contribution is unavailable")
	}
	ctx = provider.WithStateDir(ctx, a.Store.Dir)
	config, path := localProvider(ctx, p, p.Manifest.Contributes.Providers[index])
	if path == "" {
		return config, invalid("The local executable could not be found")
	}
	configs, err := a.providerConfigs(ctx)
	if err != nil {
		return config, err
	}
	if existing, ok := connectedLocalProvider(ctx, configs, config, path); ok {
		return existing, nil
	}
	config.ID = localProviderID(p, contributionID, configs)
	return a.saveProviderLocked(ctx, ProviderInput{Provider: config}, true)
}
