package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

type catalogEntry struct {
	pluginID  string
	value     *model.Catalog
	confirmed bool // value contains the last confirmed models, even while provisional.
	expires   time.Time
	loading   *catalogLoad
}

type catalogLoad struct {
	done  chan struct{}
	value *model.Catalog
	err   error
}

type catalogKey struct{ id, configDir, cwd string }

const catalogRetry = 30 * time.Second

// Catalog returns no catalog when the configured runtime is absent.
func (a *App) Catalog(ctx context.Context, id, cwd string, refresh bool) (*model.Catalog, error) {
	var err error
	if cwd == "" {
		cwd, err = os.UserHomeDir()
	}
	if err == nil {
		cwd, err = workspace.Canonical(cwd)
	}
	if err != nil {
		return nil, invalid("Working directory is unavailable")
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, context.Canceled
	}
	config, err := configuredProvider(ctx, a.Store.DB, id)
	if err != nil {
		a.mu.Unlock()
		return nil, err
	}
	key := catalogKey{id: id, configDir: provider.ConfigurationDirectory(config), cwd: cwd}
	entry := a.catalogEntryLocked(key, config)
	cached := entry.value
	if !refresh && cached != nil && time.Now().Before(entry.expires) {
		a.mu.Unlock()
		return cached, nil
	}
	load := entry.loading
	if load == nil {
		load = &catalogLoad{done: make(chan struct{})}
		entry.loading = load
		a.wg.Go(func() {
			defer close(load.done)
			load.value, load.err = a.discoverCatalog(config, key, entry)
		})
	}
	a.mu.Unlock()
	if !refresh && cached != nil {
		// A local executable check also catches a runtime uninstalled between launches.
		if _, err := provider.Executable(a.ctx, config); !provider.IsExecutableMissing(err) {
			pending := *cached
			pending.Provisional = true
			return &pending, nil
		}
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-load.done:
		return load.value, load.err
	}
}

func (a *App) catalogEntryLocked(key catalogKey, config model.Provider) *catalogEntry {
	if entry := a.catalogs[key]; entry != nil {
		return entry
	}
	entry := &catalogEntry{pluginID: config.PluginID}
	saved, err := store.Get[model.Catalog](a.ctx, a.Store.DB, "SELECT data FROM provider_catalogs WHERE provider_id=? AND config_dir=? AND cwd=?", key.id, key.configDir, key.cwd)
	if err == nil && saved.Provider == key.id && len(saved.Models) > 0 && !saved.Provisional {
		saved.Provisional = true
		saved = provider.NormalizeCatalog(config, saved)
		entry.value, entry.confirmed = &saved, true
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Warn("read cached model catalog", "provider", key.id, "error", err)
	}
	if a.catalogs == nil {
		a.catalogs = make(map[catalogKey]*catalogEntry)
	}
	a.catalogs[key] = entry
	return entry
}

func (a *App) discoverCatalog(config model.Provider, key catalogKey, entry *catalogEntry) (*model.Catalog, error) {
	value, err := provider.Discover(a.ctx, config, key.cwd)
	a.mu.Lock()
	defer a.mu.Unlock()
	entry.loading = nil
	if provider.IsExecutableMissing(err) {
		if !a.closed && a.catalogs[key] == entry {
			a.invalidateProviderCatalogsLocked(key.id, false)
		}
		return nil, nil
	}
	if a.closed || a.catalogs[key] != entry {
		return nil, context.Canceled
	}
	if errors.Is(err, provider.ErrAntigravityCLIAuthRequired) {
		a.invalidateProviderCatalogsLocked(key.id, true)
		return nil, err
	}
	if err != nil {
		if entry.value == nil {
			delete(a.catalogs, key)
			return nil, err
		}
		value = *entry.value
		value.Provisional = true
	} else if value.Provisional && entry.confirmed {
		value.Models = entry.value.Models
	}
	ttl := 5 * time.Minute
	if value.Provisional {
		ttl = catalogRetry
	} else {
		entry.confirmed = true
		if _, err := a.Store.DB.ExecContext(a.ctx, `INSERT INTO provider_catalogs(provider_id,config_dir,cwd,data) VALUES(?,?,?,?)
ON CONFLICT(provider_id,config_dir,cwd) DO UPDATE SET data=excluded.data`, key.id, key.configDir, key.cwd, store.JSON(value)); err != nil {
			slog.Warn("save model catalog", "provider", key.id, "error", err)
		}
	}
	entry.value, entry.expires = &value, time.Now().Add(ttl)
	return &value, nil
}

func (a *App) invalidateProviderCatalogsLocked(id string, accountChanged bool) {
	for key := range a.catalogs {
		if key.id == id {
			delete(a.catalogs, key)
		}
	}
	if accountChanged {
		if _, err := a.Store.DB.ExecContext(a.ctx, "DELETE FROM provider_catalogs WHERE provider_id=?", id); err != nil {
			slog.Warn("clear model catalogs", "provider", id, "error", err)
		}
	}
}
