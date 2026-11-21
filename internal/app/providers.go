package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"golang.org/x/sync/errgroup"
	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

func configuredProvider(ctx context.Context, q store.Queryer, id string) (model.Provider, error) {
	config, err := store.Get[model.Provider](ctx, q, "SELECT data FROM providers WHERE id=?", id)
	if errors.Is(err, sql.ErrNoRows) {
		return config, invalid("Runtime is no longer configured")
	}
	if err == nil {
		resolved, available, availabilityErr := runtimeProvider(ctx, q, config)
		if availabilityErr != nil {
			return config, availabilityErr
		}
		if !available {
			return config, invalid("Runtime or its plugin is disabled or uninstalled")
		}
		config = resolved
	}
	return config, err
}

func resolveSelection(ctx context.Context, q store.Queryer, selection, fallback model.Selection) (model.Selection, model.Provider, error) {
	if selection.Provider == "" {
		selection = fallback
	}
	config, err := configuredProvider(ctx, q, selection.Provider)
	if err != nil {
		return selection, config, err
	}
	selection, err = provider.ResolveSelection(selection, fallback, config)
	if err != nil {
		err = invalid(err.Error())
	}
	return selection, config, err
}

func (a *App) providerConfigs(ctx context.Context) ([]model.Provider, error) {
	return store.List[model.Provider](ctx, a.Store.DB, "SELECT data FROM providers ORDER BY CASE id WHEN 'codex' THEN 0 WHEN 'claude' THEN 1 WHEN 'antigravity' THEN 2 WHEN 'pi' THEN 3 WHEN 'dsh' THEN 4 ELSE 5 END, rowid")
}

func (a *App) Providers(ctx context.Context, checkLogin bool) ([]model.ProviderInfo, error) {
	configs, err := a.providerConfigs(ctx)
	if err != nil {
		return nil, err
	}
	ctx = provider.WithStateDir(ctx, a.Store.Dir)
	result := make([]model.ProviderInfo, len(configs))
	group, ctx := errgroup.WithContext(ctx)
	group.SetLimit(4)
	for i, config := range configs {
		group.Go(func() error {
			p, err := store.Get[model.Plugin](ctx, a.Store.DB, "SELECT data FROM plugins WHERE id=?", config.PluginID)
			if err != nil {
				return err
			}
			available := config.Enabled && p.Installed && p.Enabled
			probe := pluginProvider(p, config)
			probe.Enabled = available
			info := provider.Probe(ctx, probe)
			if checkLogin && available && info.Installed && info.Error == "" {
				info.LoginStatus = provider.LoginStatus(ctx, probe, info.Path)
			}
			info.Provider, info.Available = config, available
			for _, item := range p.Manifest.Contributes.Providers {
				if item.ID == config.ContributionID {
					info.ContributionName = item.Name
					break
				}
			}
			result[i] = info
			return nil
		})
	}
	return result, group.Wait()
}

func (a *App) ProviderUsage(ctx context.Context, id string) ([]model.UsageWindow, error) {
	config, err := configuredProvider(ctx, a.Store.DB, id)
	if err != nil {
		return nil, err
	}
	return provider.Usage(provider.WithStateDir(ctx, a.Store.Dir), config)
}

func (a *App) SetProviderAPIKey(ctx context.Context, id, key string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	config, err := configuredProvider(ctx, a.Store.DB, id)
	if err != nil {
		return err
	}
	key = strings.TrimSpace(key)
	if err := validateProviderKey(config, key); err != nil {
		return err
	}
	if err := provider.SetAntigravityKey(provider.WithStateDir(ctx, a.Store.Dir), id, key); err != nil {
		return err
	}
	a.invalidateProviderCatalogsLocked(id, true)
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		return store.Event(tx, model.Event{Type: "providers"})
	})
}

func validateProviderKey(config model.Provider, key string) error {
	if config.Type != "antigravity" || (config.AuthMethod != "gemini-api-key" && config.AuthMethod != "agent-platform") {
		return invalid("This provider does not use an API key")
	}
	if len(key) > 4096 || strings.ContainsAny(key, "\x00\r\n") {
		return invalid("Invalid API key")
	}
	return nil
}

func validateProvider(config model.Provider) error {
	if config.Name == "" || len(config.Name) > 100 {
		return invalid("Runtime name is required (up to 100 characters)")
	}
	definition := provider.Types()
	index := slices.IndexFunc(definition, func(kind model.ProviderType) bool { return kind.ID == config.Type })
	if index < 0 {
		return invalid("Unsupported runtime type")
	}
	if config.Command == "" && config.Type == "acp" {
		return invalid("Executable is required")
	}
	if len(config.Command) > 4096 || strings.ContainsAny(config.Command, "\x00\r\n") {
		return invalid("Invalid executable")
	}
	if len(config.Args) > 64 || (!definition[index].Arguments && len(config.Args) > 0) {
		return invalid("Unsupported runtime arguments")
	}
	for _, arg := range config.Args {
		if len(arg) > 4096 || strings.ContainsRune(arg, '\x00') {
			return invalid("Invalid runtime argument")
		}
	}
	if config.ConfigDir != "" && definition[index].ConfigEnv == "" {
		return invalid("This runtime does not support a custom configuration directory")
	}
	if config.ShadowHome != "" && !definition[index].ShadowHome {
		return invalid("Only Codex supports a shadow home")
	}
	for _, path := range []string{config.ConfigDir, config.ShadowHome} {
		if path != "" && (len(path) > 4096 || strings.ContainsAny(path, "\x00\r\n") || !filepath.IsAbs(path)) {
			return invalid("Configuration directory must be an absolute path")
		}
	}
	if config.AutoCompactWindow != 0 && (!definition[index].AutoCompactWindow || config.AutoCompactWindow < 100000 || config.AutoCompactWindow > 1000000) {
		return invalid("Claude's auto-compact window must be between 100,000 and 1,000,000 tokens")
	}
	if config.IdleCompaction != "" && !slices.Contains(definition[index].IdleCompactionModes, config.IdleCompaction) {
		return invalid("Unsupported idle compaction setting")
	}
	if config.AuthMethod != "" && (!slices.Contains(definition[index].AuthMethods, config.AuthMethod) || provider.IsAntigravityCLI(config, config.Command)) {
		return invalid("Choose an authentication method supported by this runtime")
	}
	gcp := config.AuthMethod == "oauth-business" || config.AuthMethod == "agent-platform"
	if config.AuthMethod == "oauth-business" && (config.GCPProject == "" || config.GCPLocation == "") {
		return invalid("Gemini Enterprise needs a GCP project and location")
	}
	for _, value := range []string{config.GCPProject, config.GCPLocation} {
		if value != "" && (!gcp || len(value) > 256 || strings.ContainsAny(value, "\x00\r\n")) {
			return invalid("Invalid GCP project or location")
		}
	}
	return nil
}

// ProviderInput contains setup-only fields that never enter a provider record or response.
type ProviderInput struct {
	model.Provider
	NewProfile bool   `json:"newProfile,omitempty"`
	APIKey     string `json:"apiKey,omitempty"`
}

func (a *App) SaveProvider(ctx context.Context, input ProviderInput) (model.Provider, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.saveProviderLocked(ctx, input, input.ID == "")
}

func (a *App) saveProviderLocked(ctx context.Context, input ProviderInput, creating bool) (model.Provider, error) {
	config, newProfile := input.Provider, input.NewProfile
	config.Name, config.Command = strings.TrimSpace(config.Name), strings.TrimSpace(config.Command)
	for _, field := range []*string{&config.ConfigDir, &config.ShadowHome} {
		path := strings.TrimSpace(*field)
		if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
			home, err := os.UserHomeDir()
			if err != nil {
				return config, err
			}
			path = filepath.Join(home, strings.TrimLeft(path[1:], `/\`))
		}
		if path != "" {
			path = filepath.Clean(path)
		}
		*field = path
	}
	if err := validateProvider(config); err != nil {
		return config, err
	}
	key := strings.TrimSpace(input.APIKey)
	if key != "" {
		if !creating {
			return config, invalid("Update the API key through this connection's credential settings")
		}
		if err := validateProviderKey(config, key); err != nil {
			return config, err
		}
	}
	p, item, err := contributionFor(ctx, a.Store.DB, config)
	if err != nil {
		return config, err
	}
	if !p.Builtin && (config.Command != item.Command || !slices.Equal(config.Args, item.Args)) {
		return config, invalid("The plugin owns its provider executable and arguments")
	}
	if creating && (!p.Installed || !p.Enabled) {
		return config, invalid("Plugin is disabled or uninstalled")
	}

	if config.Args == nil {
		config.Args = []string{}
	}
	if creating {
		if config.ID == "" {
			config.ID = ID()
		}
		config.HiddenModels = nil
		managedRoot, err := filepath.Abs(filepath.Join(a.Store.Dir, "providers", config.Type))
		if err != nil {
			return config, err
		}
		config.ManagedProfile = newProfile || (provider.SupportsLoginProfile(config) && filepath.Dir(config.ConfigDir) == managedRoot)
	}
	if newProfile {
		if !creating || config.ConfigDir != "" || config.ShadowHome != "" || !provider.SupportsLoginProfile(config) {
			return config, invalid("Choose a supported runtime to create a new login profile")
		}
		config.ConfigDir, err = filepath.Abs(filepath.Join(a.Store.Dir, "providers", config.Type, config.ID))
		if err != nil {
			return config, err
		}
		if err := os.MkdirAll(config.ConfigDir, 0700); err != nil {
			return config, err
		}
	}
	if key != "" {
		if err := provider.SetAntigravityKey(provider.WithStateDir(ctx, a.Store.Dir), config.ID, key); err != nil {
			return config, err
		}
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if !creating {
			old, err := store.Get[model.Provider](ctx, tx, "SELECT data FROM providers WHERE id=?", config.ID)
			if err != nil {
				return err
			}
			// Launch identity is immutable: an edit must never resume another runtime's native session.
			if old.PluginID != config.PluginID || old.ContributionID != config.ContributionID || old.Type != config.Type || old.Command != config.Command || old.ConfigDir != config.ConfigDir || old.ShadowHome != config.ShadowHome || old.AuthMethod != config.AuthMethod || old.GCPProject != config.GCPProject || old.GCPLocation != config.GCPLocation || !slices.Equal(old.Args, config.Args) {
				return conflict("Create a new runtime to change its executable, arguments, configuration directory, or type")
			}
			config.HiddenModels = old.HiddenModels
			config.ManagedProfile = old.ManagedProfile
			if old.Enabled && !config.Enabled {
				var count int
				if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE json_extract(data,'$.selection.provider')=? AND status IN ('starting','running','waiting_user','cancelling','unknown','queued','steering')", config.ID).Scan(&count); err != nil {
					return err
				}
				if count > 0 {
					return conflict("Stop or resolve this runtime's executions and queued messages before disabling it")
				}
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO providers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", config.ID, store.JSON(config)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "providers"})
	})
	if err != nil && newProfile {
		_ = os.Remove(config.ConfigDir) // Only an empty, newly allocated profile can be removed.
	}
	if err != nil && key != "" {
		err = errors.Join(err, provider.SetAntigravityKey(provider.WithStateDir(ctx, a.Store.Dir), config.ID, ""))
	}
	if err == nil && config.Enabled {
		if starterErr := a.initStarterAgentLocked(); starterErr != nil {
			// The connection is durable. The pending starter is retried on startup.
			slog.Warn("initialize starter Agent after connecting runtime", "error", starterErr)
		}
	}
	if err == nil && !config.Enabled {
		a.cancelProviderSetupLocked(config.ID)
		a.invalidateProviderCatalogsLocked(config.ID, false)
	}
	return config, err
}

func (a *App) SetProviderModelVisibility(ctx context.Context, id string, models []string, visible bool) (model.Provider, error) {
	if len(models) == 0 || slices.ContainsFunc(models, func(id string) bool { return len(id) > 4096 }) {
		return model.Provider{}, invalid("Invalid model IDs")
	}
	var config model.Provider
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		config, err = store.Get[model.Provider](ctx, tx, "SELECT data FROM providers WHERE id=?", id)
		if err != nil {
			return err
		}
		hidden := make(map[string]struct{}, len(config.HiddenModels))
		for _, model := range config.HiddenModels {
			hidden[model] = struct{}{}
		}
		for _, model := range models {
			if visible {
				delete(hidden, model)
			} else {
				hidden[model] = struct{}{}
			}
		}
		next := slices.Sorted(maps.Keys(hidden))
		if slices.Equal(config.HiddenModels, next) {
			return nil
		}
		config.HiddenModels = next
		if _, err := tx.ExecContext(ctx, "UPDATE providers SET data=? WHERE id=?", store.JSON(config), id); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "providers"})
	})
	return config, err
}

func (a *App) DeleteProvider(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var used bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE json_extract(data,'$.profile.provider')=? UNION ALL SELECT 1 FROM sessions WHERE json_extract(data,'$.selection.provider')=? UNION ALL SELECT 1 FROM runs WHERE json_extract(data,'$.selection.provider')=?)`, id, id, id).Scan(&used); err != nil {
			return err
		}
		if used {
			return conflict("This runtime is referenced by an Agent or conversation. Disable it to keep that history.")
		}
		config, err := store.Get[model.Provider](ctx, tx, "SELECT data FROM providers WHERE id=?", id)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			if err := rememberLocalProviderRemoval(provider.WithStateDir(ctx, a.Store.Dir), tx, config); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM providers WHERE id=?", id); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "providers"})
	})
	if err == nil {
		a.cancelProviderSetupLocked(id)
		a.invalidateProviderCatalogsLocked(id, false)
		err = provider.SetAntigravityKey(provider.WithStateDir(ctx, a.Store.Dir), id, "")
	}
	return err
}
