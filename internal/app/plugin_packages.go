package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/store"
	"lever/internal/workspace"
)

// A prepared directory is private to its preview until a single database
// transaction publishes it. Applying a preview never fetches or copies bytes.
type packagePreview struct {
	model.PluginPreview
	install  string
	revision int64
	timer    *time.Timer
}

func (a *App) packageRoot() string { return filepath.Join(a.Store.Dir, "plugin-packages") }

func (a *App) newPackageDir() (string, error) {
	root := a.packageRoot()
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	root, err := workspace.Canonical(root)
	if err != nil {
		return "", err
	}
	return os.MkdirTemp(root, "pkg-")
}

func (a *App) removePackage(release *model.PluginRelease) {
	if release == nil || !strings.HasPrefix(release.Package, "pkg-") || filepath.Base(release.Package) != release.Package {
		return
	}
	if err := os.RemoveAll(filepath.Join(a.packageRoot(), release.Package)); err != nil {
		slog.Warn("remove unused plugin package", "package", release.Package, "error", err)
	}
}

// The SQLite records are authoritative after a crash, including a crash between
// preparing a directory and applying it, or after committing an uninstall.
func (a *App) recoverPluginPackages(ctx context.Context) error {
	entries, err := os.ReadDir(a.packageRoot())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	root, err := workspace.Canonical(a.packageRoot())
	if err != nil {
		return err
	}
	plugins, err := a.Plugins(ctx)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	for _, p := range plugins {
		if p.Current == nil {
			continue
		}
		keep[p.Current.Package] = true
		if p.Previous != nil {
			keep[p.Previous.Package] = true
		}
		directory := filepath.Join(root, p.Current.Package)
		if directory != p.Directory {
			if _, err := a.Store.DB.ExecContext(ctx, "UPDATE plugins SET data=json_set(data,'$.directory',?) WHERE id=?", directory, p.ID); err != nil {
				return err
			}
		}
	}
	for _, entry := range entries {
		if !keep[entry.Name()] {
			a.removePackage(&model.PluginRelease{Package: entry.Name()})
		}
	}
	return nil
}

func installedPlugin(ctx context.Context, q store.Queryer, id string) (model.Plugin, error) {
	return store.Get[model.Plugin](ctx, q, "SELECT data FROM plugins WHERE id=? AND json_extract(data,'$.installed')=1", id)
}

func (a *App) CheckPluginUpdate(ctx context.Context, id string) (model.PluginUpdate, error) {
	p, err := installedPlugin(ctx, a.Store.DB, id)
	if err != nil {
		return model.PluginUpdate{}, err
	}
	if p.Current == nil {
		return model.PluginUpdate{}, invalid("This plugin has no Git update source")
	}
	current := p.Current
	update := model.PluginUpdate{Commit: current.Commit}
	if current.Source.Kind != "branch" {
		return update, nil
	}
	_, commit, err := plugin.ResolveGit(ctx, current.Source)
	if err != nil || commit == current.Commit {
		return update, err
	}
	tree, err := plugin.GitTree(ctx, current.Source, commit, "")
	if err != nil {
		return update, err
	}
	return model.PluginUpdate{Commit: commit, Available: tree != current.Tree}, nil
}

func (a *App) PreviewPlugin(ctx context.Context, id string, input model.PluginPreviewInput) (model.PluginPreview, error) {
	var source model.PluginGitSource
	var p model.Plugin
	var err error
	var result model.PluginPreview
	if id != "" {
		p, err = installedPlugin(ctx, a.Store.DB, id)
		if err != nil {
			return result, err
		}
		if p.Current == nil || p.Revision != input.Revision {
			return result, conflict("The selected installation changed. Refresh its details.")
		}
		if input.URL != "" || input.Path != "" || (input.Commit != "" && (input.Ref != "" || p.Current.Source.Kind != "branch")) {
			return result, invalid("An update must use this installation's repository and directory")
		}
		source = p.Current.Source
		if input.Ref != "" {
			source, err = plugin.GitSource(source.URL, input.Ref, source.Path)
		}
	} else {
		if input.Commit != "" {
			return result, invalid("Select a branch, tag or commit in the ref field")
		}
		source, err = plugin.GitSource(input.URL, input.Ref, input.Path)
	}
	if err != nil {
		return result, invalid(err.Error())
	}
	commit := input.Commit
	if commit == "" {
		if id != "" && input.Ref == "" && source.Kind != "branch" {
			commit = p.Current.Commit
		} else {
			source, commit, err = plugin.ResolveGit(ctx, source)
			if err != nil {
				return result, err
			}
		}
	}
	dir, err := a.newPackageDir()
	if err != nil {
		return result, err
	}
	owned := true
	defer func() {
		if owned {
			os.RemoveAll(dir)
		}
	}()
	tree, err := plugin.GitTree(ctx, source, commit, dir)
	if err != nil {
		return result, err
	}
	manifest, _, err := plugin.ReadPackage(dir)
	if err != nil {
		return result, invalid(err.Error())
	}
	if err := validatePluginProviders(manifest); err != nil {
		return result, err
	}
	result = model.PluginPreview{ID: ID(), Manifest: manifest, Blockers: []string{}, Release: model.PluginRelease{
		Source: source, Commit: commit, Tree: tree, Version: manifest.Version, Package: filepath.Base(dir),
	}}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || ctx.Err() != nil {
		return result, conflict("Plugin preview was cancelled")
	}
	if len(a.pluginPreviews) >= 16 {
		return result, conflict("Close an unused plugin preview and try again")
	}
	if id == "" {
		err = checkPluginID(ctx, a.Store.DB, manifest.ID)
	} else {
		if manifest.ID != p.Manifest.ID {
			return result, conflict("The new manifest has a different plugin ID")
		}
		result.Blockers, err = pluginBlockers(ctx, a.Store.DB, p, manifest)
	}
	if err != nil {
		return result, err
	}
	pv := &packagePreview{PluginPreview: result, install: id, revision: p.Revision}
	pv.timer = time.AfterFunc(10*time.Minute, func() { a.DiscardPluginPreview(result.ID) })
	a.pluginPreviews[result.ID] = pv
	owned = false
	return result, nil
}

func (a *App) DiscardPluginPreview(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.discardPluginPreviewLocked(id)
}

func (a *App) discardPluginPreviewLocked(id string) {
	if pv := a.pluginPreviews[id]; pv != nil {
		pv.timer.Stop()
		delete(a.pluginPreviews, id)
		a.removePackage(&pv.Release)
	}
}

func (a *App) ApplyPluginPreview(ctx context.Context, id string) (model.Plugin, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	pv := a.pluginPreviews[id]
	if pv == nil {
		return model.Plugin{}, conflict("Plugin preview expired. Preview the package again.")
	}
	dir, err := workspace.Canonical(filepath.Join(a.packageRoot(), pv.Release.Package))
	if err != nil {
		return model.Plugin{}, err
	}
	var p model.Plugin
	if pv.install == "" {
		p = model.Plugin{ID: ID(), Manifest: pv.Manifest, Enabled: true, Installed: true, Directory: dir, Current: &pv.Release, Revision: 1}
		err = a.Store.Write(ctx, func(tx *sql.Tx) error { return insertPlugin(ctx, tx, p) })
	} else {
		p, err = a.switchPluginLocked(ctx, pv.install, pv.revision, pv.Manifest, &pv.Release, dir)
	}
	if err == nil {
		pv.timer.Stop()
		delete(a.pluginPreviews, id)
		if p.Current.Package != pv.Release.Package {
			a.removePackage(&pv.Release)
		}
	}
	return p, err
}

func (a *App) RollbackPlugin(ctx context.Context, id string, revision int64) (model.Plugin, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := installedPlugin(ctx, a.Store.DB, id)
	if err != nil {
		return p, err
	}
	if p.Current == nil || p.Previous == nil {
		return p, conflict("No previous plugin package is available")
	}
	manifest, dir, err := plugin.ReadPackage(filepath.Join(a.packageRoot(), p.Previous.Package))
	if err != nil {
		return p, err
	}
	return a.switchPluginLocked(ctx, id, revision, manifest, p.Previous, dir)
}

func (a *App) ReloadPlugin(ctx context.Context, id string) (model.Plugin, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, err := installedPlugin(ctx, a.Store.DB, id)
	if err != nil {
		return p, err
	}
	if p.Builtin || p.Current != nil || p.Directory == "" {
		return p, invalid("Only a linked directory can be reloaded")
	}
	manifest, dir, err := plugin.Read(p.Directory)
	if err != nil {
		return p, invalid(err.Error())
	}
	if err = validatePluginProviders(manifest); err != nil {
		return p, err
	}
	return a.switchPluginLocked(ctx, id, p.Revision, manifest, nil, dir)
}

func (a *App) switchPluginLocked(ctx context.Context, id string, revision int64, m model.PluginManifest, release *model.PluginRelease, dir string) (model.Plugin, error) {
	var p model.Plugin
	var obsolete *model.PluginRelease
	var switched bool
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		p, err = installedPlugin(ctx, tx, id)
		if err != nil {
			return err
		}
		if p.Revision != revision || p.Manifest.ID != m.ID {
			return conflict("The plugin identity or version changed. Preview it again.")
		}
		if release != nil && p.Current != nil && (release.Source.URL != p.Current.Source.URL || release.Source.Path != p.Current.Source.Path) {
			return conflict("The package belongs to a different update source")
		}
		// Changing a tracking ref or advancing an unrelated monorepo commit
		// must not evict the last distinct package or restart a listener.
		if release != nil && p.Current != nil && release.Tree == p.Current.Tree {
			if p.Current.Source == release.Source && p.Current.Commit == release.Commit {
				return nil
			}
			p.Current.Commit, p.Current.Source = release.Commit, release.Source
			p.Revision++
			return savePlugin(ctx, tx, p)
		}
		blockers, err := pluginBlockers(ctx, tx, p, m)
		if err != nil {
			return err
		}
		if len(blockers) != 0 {
			return conflict("These connections, channels, or automations require a new installation: " + strings.Join(blockers, ", "))
		}
		if err := a.pluginIdleLocked(ctx, tx, p); err != nil {
			return err
		}
		obsolete = p.Previous
		p.Previous, p.Current = p.Current, release
		p.Manifest, p.Directory = m, dir
		p.Revision++
		if _, err = tx.ExecContext(ctx, "DELETE FROM provider_catalogs WHERE provider_id IN (SELECT id FROM providers WHERE json_extract(data,'$.pluginId')=?)", id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM provider_usage WHERE provider_id IN (SELECT id FROM providers WHERE json_extract(data,'$.pluginId')=?)", id); err != nil {
			return err
		}
		if len(m.Contributes.EventSources) != 0 {
			if err = resetEventSourcePolls(ctx, tx, id); err != nil {
				return err
			}
		}
		switched = true
		return savePlugin(ctx, tx, p)
	})
	if err != nil || !switched {
		return p, err
	}
	for key, entry := range a.catalogs {
		if entry.pluginID == id {
			delete(a.catalogs, key)
		}
	}
	for key, entry := range a.usages {
		if entry.pluginID == id {
			delete(a.usages, key)
		}
	}
	a.stopPersonalLocked(id)
	if a.eventPoll != nil && a.eventPoll.pluginID == id {
		a.eventPoll.cancel()
	}
	if a.taskSync != nil && a.taskSync.pluginID == id {
		a.taskSync.cancel()
		a.taskSync = nil
	}
	if p.Enabled && len(m.Contributes.TaskSources) != 0 {
		a.wakeTaskSources()
	}
	if p.Enabled && len(m.Contributes.Channels) != 0 {
		a.resumePersonalLocked(id)
	}
	if obsolete != nil && (release == nil || obsolete.Package != release.Package) {
		a.removePackage(obsolete)
	}
	return p, nil
}

// Changing a launch contract would attach an old native session to a different
// runtime. Keep every existing connection, including disabled historical ones.
func pluginBlockers(ctx context.Context, q store.Queryer, p model.Plugin, m model.PluginManifest) ([]string, error) {
	configs, err := store.List[model.Provider](ctx, q, "SELECT data FROM providers WHERE json_extract(data,'$.pluginId')=? ORDER BY rowid", p.ID)
	if err != nil {
		return nil, err
	}
	blockers := []string{}
	for _, c := range configs {
		ok := slices.ContainsFunc(m.Contributes.Providers, func(v model.ProviderContribution) bool {
			return v.ID == c.ContributionID && v.Driver == c.Type && v.Command == c.Command && slices.Equal(v.Args, c.Args)
		})
		if !ok {
			blockers = append(blockers, fmt.Sprintf("%s (%s)", c.Name, c.ContributionID))
		}
	}
	if old := p.Manifest.Contributes.Channels; len(old) != 0 {
		next := m.Contributes.Channels
		if len(next) == 0 || next[0].ID != old[0].ID || next[0].Driver != old[0].Driver {
			blockers = append(blockers, fmt.Sprintf("%s (%s)", old[0].Name, old[0].ID))
		}
	}
	automations, err := store.List[model.Automation](ctx, q, "SELECT data FROM automations WHERE state<>'archived' AND json_extract(data,'$.trigger.source.pluginId')=? ORDER BY rowid", p.ID)
	if err != nil {
		return nil, err
	}
	for _, item := range automations {
		source := item.Trigger.Source
		if source == nil {
			continue
		}
		oldIdx := slices.IndexFunc(p.Manifest.Contributes.EventSources, func(v model.EventSourceContribution) bool {
			return v.ID == source.ContributionID
		})
		newIdx := slices.IndexFunc(m.Contributes.EventSources, func(v model.EventSourceContribution) bool {
			return v.ID == source.ContributionID
		})
		if newIdx < 0 || (oldIdx >= 0 && m.Contributes.EventSources[newIdx].Driver != p.Manifest.Contributes.EventSources[oldIdx].Driver) {
			blockers = append(blockers, fmt.Sprintf("%s (%s)", item.Name, source.ContributionID))
		}
	}
	taskSources, err := store.List[struct {
		Name           string `json:"name"`
		ContributionID string `json:"contributionId"`
	}](ctx, q, "SELECT json_object('name',name,'contributionId',contribution_id) FROM task_sources WHERE plugin_id=? AND status<>'removed' ORDER BY rowid", p.ID)
	if err != nil {
		return nil, err
	}
	for _, item := range taskSources {
		oldIdx := slices.IndexFunc(p.Manifest.Contributes.TaskSources, func(v model.TaskSourceContribution) bool {
			return v.ID == item.ContributionID
		})
		newIdx := slices.IndexFunc(m.Contributes.TaskSources, func(v model.TaskSourceContribution) bool {
			return v.ID == item.ContributionID
		})
		if newIdx < 0 || (oldIdx >= 0 && m.Contributes.TaskSources[newIdx].Driver != p.Manifest.Contributes.TaskSources[oldIdx].Driver) {
			blockers = append(blockers, fmt.Sprintf("%s (%s)", item.Name, item.ContributionID))
		}
	}
	return blockers, nil
}

func (a *App) pluginIdleLocked(ctx context.Context, q store.Queryer, p model.Plugin) error {
	if err := checkPluginRuns(ctx, q, p.ID); err != nil {
		return err
	}
	if worker := a.personal[p.ID]; worker != nil {
		switch worker.state {
		case "connecting", "preparing", "pairing":
			return conflict("Wait for the channel to connect, or cancel pairing first")
		}
	}
	if len(p.Manifest.Contributes.Channels) == 0 {
		return nil
	}
	config, err := store.Get[personalConfig](ctx, q, "SELECT data FROM channel_connections WHERE kind=?", p.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	binding := personalBinding(p.ID, config)
	var busy bool
	err = q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM channel_deliveries WHERE binding_id=? AND status='sending'
		UNION ALL SELECT 1 FROM personal_channel_turns t JOIN runs r ON r.id=t.run_id WHERE t.binding=?
		AND (t.context_ready=0 OR t.reaction_status='pending' OR r.status IN ('starting','running','waiting_user','cancelling','unknown','queued','steering')))`, binding, binding).Scan(&busy)
	if err == nil && busy {
		return conflict("Resolve the channel's active executions, requests and receipts first")
	}
	return err
}
