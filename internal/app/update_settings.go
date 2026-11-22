package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/store"
)

const (
	pluginUpdateSettingsKey = "plugin_update_settings"
	skillUpdateSettingsKey  = "skill_update_settings"
)

var defaultUpdateSettings = model.UpdateSettings{
	Mode:     "notify",
	Interval: "6h",
}

func normalizeUpdateSettings(s model.UpdateSettings) (model.UpdateSettings, error) {
	if s.Mode == "" {
		s.Mode = defaultUpdateSettings.Mode
	}
	if s.Interval == "" {
		s.Interval = defaultUpdateSettings.Interval
	}
	switch s.Mode {
	case "auto", "notify", "manual":
	default:
		return model.UpdateSettings{}, invalid("Update mode must be auto, notify, or manual")
	}
	switch s.Interval {
	case "1h", "6h", "24h":
	default:
		return model.UpdateSettings{}, invalid("Check interval must be 1h, 6h, or 24h")
	}
	return s, nil
}

func normalizeItemUpdatePolicy(policy string) (string, error) {
	policy = strings.TrimSpace(policy)
	if policy == "" {
		return "inherit", nil
	}
	switch policy {
	case "inherit", "auto", "notify", "manual":
		return policy, nil
	default:
		return "", invalid("Update policy must be inherit, auto, notify, or manual")
	}
}

func effectiveUpdateMode(itemPolicy string, global model.UpdateSettings) string {
	switch itemPolicy {
	case "auto", "notify", "manual":
		return itemPolicy
	default:
		return global.Mode
	}
}

func updateIntervalDuration(interval string) time.Duration {
	switch interval {
	case "1h":
		return time.Hour
	case "24h":
		return 24 * time.Hour
	default:
		return 6 * time.Hour
	}
}

func (a *App) loadUpdateSettings(ctx context.Context, key string) (model.UpdateSettings, error) {
	var raw string
	err := a.Store.DB.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultUpdateSettings, nil
	}
	if err != nil {
		return defaultUpdateSettings, err
	}
	var parsed model.UpdateSettings
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return defaultUpdateSettings, nil
	}
	normalized, err := normalizeUpdateSettings(parsed)
	if err != nil {
		return defaultUpdateSettings, nil
	}
	return normalized, nil
}

func (a *App) saveUpdateSettings(ctx context.Context, key, eventType string, s model.UpdateSettings) (model.UpdateSettings, error) {
	normalized, err := normalizeUpdateSettings(s)
	if err != nil {
		return model.UpdateSettings{}, err
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, store.JSON(normalized)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: eventType})
	})
	return normalized, err
}

func (a *App) PluginUpdateSettings(ctx context.Context) (model.UpdateSettings, error) {
	return a.loadUpdateSettings(ctx, pluginUpdateSettingsKey)
}

func (a *App) SavePluginUpdateSettings(ctx context.Context, s model.UpdateSettings) (model.UpdateSettings, error) {
	return a.saveUpdateSettings(ctx, pluginUpdateSettingsKey, "plugins", s)
}

func (a *App) SkillUpdateSettings(ctx context.Context) (model.UpdateSettings, error) {
	return a.loadUpdateSettings(ctx, skillUpdateSettingsKey)
}

func (a *App) SaveSkillUpdateSettings(ctx context.Context, s model.UpdateSettings) (model.UpdateSettings, error) {
	return a.saveUpdateSettings(ctx, skillUpdateSettingsKey, "skills", s)
}

func (a *App) SetPluginUpdatePolicy(ctx context.Context, id, policy string) (model.Plugin, error) {
	normalized, err := normalizeItemUpdatePolicy(policy)
	if err != nil {
		return model.Plugin{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var updated model.Plugin
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		p, err := installedPlugin(ctx, tx, id)
		if err != nil {
			return err
		}
		p.UpdatePolicy = normalized
		updated = p
		return savePlugin(ctx, tx, p)
	})
	return updated, err
}

// manifestsSafeForAutoUpdate guarantees auto-update never silently changes
// executable commands, drivers, args, or contributed capabilities.
func manifestsSafeForAutoUpdate(before, after model.PluginManifest) bool {
	if before.ID != after.ID {
		return false
	}
	if len(before.Contributes.Providers) != len(after.Contributes.Providers) ||
		len(before.Contributes.Channels) != len(after.Contributes.Channels) ||
		len(before.Contributes.EventSources) != len(after.Contributes.EventSources) ||
		len(before.Contributes.TaskSources) != len(after.Contributes.TaskSources) {
		return false
	}
	for i := range before.Contributes.Providers {
		b, a := before.Contributes.Providers[i], after.Contributes.Providers[i]
		if b.ID != a.ID || b.Driver != a.Driver || b.Command != a.Command || !slices.Equal(b.Args, a.Args) {
			return false
		}
	}
	for i := range before.Contributes.Channels {
		b, a := before.Contributes.Channels[i], after.Contributes.Channels[i]
		if b.ID != a.ID || b.Driver != a.Driver || b.Command != a.Command {
			return false
		}
	}
	for i := range before.Contributes.EventSources {
		b, a := before.Contributes.EventSources[i], after.Contributes.EventSources[i]
		if b.ID != a.ID || b.Driver != a.Driver || b.Command != a.Command {
			return false
		}
	}
	for i := range before.Contributes.TaskSources {
		if before.Contributes.TaskSources[i].ID != after.Contributes.TaskSources[i].ID {
			return false
		}
	}
	return true
}

// AutoUpdatePlugin safely upgrades a Git-tracked plugin when its update has
// no blockers and does not alter executable commands or capabilities.
func (a *App) AutoUpdatePlugin(ctx context.Context, id string) (model.Plugin, bool, error) {
	p, err := installedPlugin(ctx, a.Store.DB, id)
	if err != nil {
		return model.Plugin{}, false, err
	}
	if p.Current == nil || p.Current.Source.Kind != "branch" {
		return p, false, nil
	}
	check, err := a.CheckPluginUpdate(ctx, id)
	if err != nil || !check.Available {
		return p, false, err
	}
	pv, err := a.PreviewPlugin(ctx, id, model.PluginPreviewInput{
		Commit:   check.Commit,
		Revision: p.Revision,
	})
	if err != nil {
		return p, false, err
	}
	if len(pv.Blockers) > 0 || !manifestsSafeForAutoUpdate(p.Manifest, pv.Manifest) {
		a.DiscardPluginPreview(pv.ID)
		return p, false, nil
	}
	updated, err := a.ApplyPluginPreview(ctx, pv.ID)
	if err != nil {
		a.DiscardPluginPreview(pv.ID)
		return p, false, err
	}
	return updated, true, nil
}

func (a *App) runSubscriptionUpdates() {
	defer a.wg.Done()
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			a.pollDueSubscriptions(a.ctx)
		}
	}
}

func (a *App) pollDueSubscriptions(ctx context.Context) {
	skillSettings, err := a.SkillUpdateSettings(ctx)
	if err == nil && skillSettings.Mode != "manual" {
		interval := updateIntervalDuration(skillSettings.Interval)
		subs, _ := a.skillSubscriptionRecords(ctx)
		for _, rec := range subs {
			if ctx.Err() != nil {
				return
			}
			mode := effectiveUpdateMode(rec.UpdatePolicy, skillSettings)
			if mode == "manual" || rec.Source.Kind != "branch" {
				continue
			}
			if rec.LastCheckedAt != "" {
				if last, err := time.Parse(time.RFC3339Nano, rec.LastCheckedAt); err == nil && time.Since(last) < interval {
					continue
				}
			}
			updated, checkErr := a.CheckSkillSubscription(ctx, rec.ID)
			if checkErr == nil && updated.Available && mode == "auto" {
				_, _ = a.SyncSkillSubscription(ctx, rec.ID)
			}
		}
	}
	pluginSettings, err := a.PluginUpdateSettings(ctx)
	if err == nil && pluginSettings.Mode == "auto" {
		plugins, _ := a.Plugins(ctx)
		for _, p := range plugins {
			if ctx.Err() != nil {
				return
			}
			if p.Current == nil || p.Current.Source.Kind != "branch" {
				continue
			}
			if effectiveUpdateMode(p.UpdatePolicy, pluginSettings) != "auto" {
				continue
			}
			_, _, _ = a.AutoUpdatePlugin(ctx, p.ID)
		}
	}
}
