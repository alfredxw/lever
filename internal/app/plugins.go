package app

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin"
	"lever/internal/plugin/builtin/lark-bot"
	"lever/internal/store"
)

func (a *App) initPlugins(ctx context.Context) error {
	plugins, err := builtin.Plugins()
	if err != nil {
		return err
	}
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		// Databases predating provider instances have Agents bound directly to
		// the built-in IDs. Restore those IDs without seeding fresh installations.
		var legacy bool
		if err := tx.QueryRowContext(ctx, "SELECT NOT EXISTS(SELECT 1 FROM providers) AND EXISTS(SELECT 1 FROM agents)").Scan(&legacy); err != nil {
			return err
		}
		for _, p := range plugins {
			if _, err := tx.ExecContext(ctx, `
INSERT INTO plugins(id,data) VALUES(?,?)
ON CONFLICT(id) DO UPDATE SET data=json_set(plugins.data,'$.manifest',json_extract(excluded.data,'$.manifest'))
WHERE json_extract(plugins.data,'$.manifest')<>json_extract(excluded.data,'$.manifest')`, p.ID, store.JSON(p)); err != nil {
				return err
			}
			if legacy {
				for _, item := range p.Manifest.Contributes.Providers {
					config := localProviderConfig(p, item)
					if config.Type == "acp" && config.Command == "" {
						continue
					}
					config.ID = item.ID
					if _, err := tx.ExecContext(ctx, "INSERT INTO providers(id,data) VALUES(?,?)", config.ID, store.JSON(config)); err != nil {
						return err
					}
				}
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE providers SET data=json_set(data,'$.pluginId','lever.'||json_extract(data,'$.type'),'$.contributionId',json_extract(data,'$.type')) WHERE COALESCE(json_extract(data,'$.pluginId'),'')=''`)
		return err
	})
}

func pluginProvider(p model.Plugin, config model.Provider) model.Provider {
	if p.Current != nil && plugin.RelativeCommand(config.Command) {
		config.Command = filepath.Join(p.Directory, config.Command)
	}
	return config
}

func runtimeProvider(ctx context.Context, q store.Queryer, config model.Provider) (model.Provider, bool, error) {
	p, err := store.Get[model.Plugin](ctx, q, "SELECT data FROM plugins WHERE id=?", config.PluginID)
	if err != nil {
		return config, false, err
	}
	return pluginProvider(p, config), config.Enabled && p.Enabled && p.Installed, nil
}

func (a *App) Plugins(ctx context.Context) ([]model.Plugin, error) {
	return store.List[model.Plugin](ctx, a.Store.DB, "SELECT data FROM plugins WHERE json_extract(data,'$.installed')=1 ORDER BY json_extract(data,'$.builtin') DESC,rowid")
}

// Installation is declarative. Only a selected provider's adapter starts code.
// Directory installs reference the owner's local package; uninstall never removes source files.
func (a *App) InstallPlugin(ctx context.Context, manifest model.PluginManifest, directory string) (model.Plugin, error) {
	var err error
	if directory != "" {
		manifest, directory, err = plugin.Read(directory)
	} else {
		err = plugin.Validate(manifest)
	}
	if err != nil {
		return model.Plugin{}, invalid(err.Error())
	}
	if len(manifest.Contributes.Channels) != 0 && directory == "" {
		return model.Plugin{}, invalid("Install a local channel from its package directory")
	}
	if len(manifest.Contributes.EventSources) != 0 && directory == "" {
		return model.Plugin{}, invalid("Install an event source plugin from its package directory")
	}
	if err := validatePluginProviders(manifest); err != nil {
		return model.Plugin{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := model.Plugin{ID: ID(), Manifest: manifest, Enabled: true, Installed: true, Directory: directory}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		return insertPlugin(ctx, tx, p)
	})
	return p, err
}

func validatePluginProviders(m model.PluginManifest) error {
	for _, item := range m.Contributes.Providers {
		if err := validateProvider(model.Provider{Name: item.Name, Type: item.Driver, Command: item.Command, Args: item.Args}); err != nil {
			return err
		}
	}
	return nil
}

func checkPluginID(ctx context.Context, q store.Queryer, manifestID string) error {
	var installed bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM plugins WHERE json_extract(data,'$.manifest.id')=? AND json_extract(data,'$.installed')=1)", manifestID).Scan(&installed); err != nil {
		return err
	}
	if installed {
		return conflict("This plugin is already installed. Upgrade it from its original source.")
	}
	return nil
}

func insertPlugin(ctx context.Context, tx *sql.Tx, p model.Plugin) error {
	if err := checkPluginID(ctx, tx, p.Manifest.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO plugins(id,data) VALUES(?,?)", p.ID, store.JSON(p)); err != nil {
		return err
	}
	return store.Event(tx, model.Event{Type: "plugins"})
}

func savePlugin(ctx context.Context, tx *sql.Tx, p model.Plugin) error {
	if _, err := tx.ExecContext(ctx, "UPDATE plugins SET data=? WHERE id=?", store.JSON(p), p.ID); err != nil {
		return err
	}
	if len(p.Manifest.Contributes.EventSources) != 0 {
		if err := store.Event(tx, model.Event{Type: "automations"}); err != nil {
			return err
		}
	}
	return store.Event(tx, model.Event{Type: "plugins"})
}

func checkPluginRuns(ctx context.Context, q store.Queryer, id string) error {
	var pending bool
	if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs r JOIN providers p ON p.id=json_extract(r.data,'$.selection.provider') WHERE json_extract(p.data,'$.pluginId')=? AND r.status IN ('starting','running','waiting_user','cancelling','unknown','queued','steering'))`, id).Scan(&pending); err != nil {
		return err
	}
	if pending {
		return conflict("Stop or resolve this plugin's executions and queued messages first")
	}
	return nil
}

func (a *App) UpdatePlugin(ctx context.Context, id string, enabled, uninstall bool) error {
	a.mu.Lock()
	var configurations []model.Provider
	removePersonal := false
	removeEventSources := false
	var removed model.Plugin
	var waitPoll <-chan struct{}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		p, err := store.Get[model.Plugin](ctx, tx, "SELECT data FROM plugins WHERE id=?", id)
		if err != nil {
			return err
		}
		if !p.Installed {
			return conflict("Plugin is not installed")
		}
		if uninstall && p.Builtin {
			return conflict("Built-in plugins can be disabled")
		}
		if !enabled || uninstall {
			var err error
			configurations, err = store.List[model.Provider](ctx, tx, "SELECT data FROM providers WHERE json_extract(data,'$.pluginId')=?", id)
			if err != nil {
				return err
			}
			if err := checkPluginRuns(ctx, tx, id); err != nil {
				return err
			}
		}
		wasEnabled := p.Enabled
		p.Enabled = enabled
		if uninstall {
			removed = p
			p.Installed = false
			p.Enabled = false
			removePersonal = len(p.Manifest.Contributes.Channels) != 0
			removeEventSources = len(p.Manifest.Contributes.EventSources) != 0
			if removePersonal {
				config, err := store.Get[personalConfig](ctx, tx, "SELECT data FROM channel_connections WHERE kind=?", id)
				if err != nil && !errors.Is(err, sql.ErrNoRows) {
					return err
				}
				if config.Account != "" {
					if err := cancelChannelDeliveries(ctx, tx, personalBinding(id, config)); err != nil {
						return err
					}
				}
				if _, err := tx.ExecContext(ctx, "DELETE FROM channel_connections WHERE kind=?", id); err != nil {
					return err
				}
			}
		} else if enabled && !wasEnabled && len(p.Manifest.Contributes.EventSources) != 0 {
			if err := resetEventSourcePolls(ctx, tx, id); err != nil {
				return err
			}
		}
		return savePlugin(ctx, tx, p)
	})
	if err == nil {
		if !enabled || uninstall {
			a.stopPersonalLocked(id)
			if a.eventPoll != nil && a.eventPoll.pluginID == id {
				a.eventPoll.cancel()
				waitPoll = a.eventPoll.done
			}
		} else {
			a.resumePersonalLocked(id)
		}
		for _, config := range configurations {
			a.cancelProviderSetupLocked(config.ID)
		}
		if (!enabled || uninstall) && a.taskSync != nil && a.taskSync.pluginID == id {
			a.taskSync.cancel()
			a.taskSync = nil
		}
		a.wakeTaskSources()
		if id == larkbot.PluginID {
			a.feishu.enabled = enabled
			if !enabled {
				a.feishu.pairs = nil
				a.cancelFeishuRegistrationLocked()
			}
			a.syncFeishuRuntimesLocked()
		}
	}
	a.mu.Unlock()
	if err != nil {
		return err
	}
	if waitPoll != nil {
		<-waitPoll
	}
	if removePersonal {
		err = errors.Join(err, os.RemoveAll(filepath.Join(a.Store.Dir, "personal-channels", id)))
	}
	if removeEventSources {
		err = errors.Join(err, os.RemoveAll(a.eventSourceCacheDir(id)))
	}
	a.removePackage(removed.Current)
	a.removePackage(removed.Previous)
	return err
}

func contributionFor(ctx context.Context, q store.Queryer, config model.Provider) (model.Plugin, model.ProviderContribution, error) {
	p, err := store.Get[model.Plugin](ctx, q, "SELECT data FROM plugins WHERE id=?", config.PluginID)
	if errors.Is(err, sql.ErrNoRows) {
		err = invalid("Plugin is no longer installed")
	}
	if err != nil {
		return p, model.ProviderContribution{}, err
	}
	index := slices.IndexFunc(p.Manifest.Contributes.Providers, func(item model.ProviderContribution) bool { return item.ID == config.ContributionID })
	if index < 0 || p.Manifest.Contributes.Providers[index].Driver != config.Type {
		return p, model.ProviderContribution{}, invalid("Provider must belong to a declared plugin contribution")
	}
	return p, p.Manifest.Contributes.Providers[index], nil
}
