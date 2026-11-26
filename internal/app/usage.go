package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"slices"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
)

const (
	usageTTL      = 5 * time.Minute
	usageRetry    = 30 * time.Second
	usageStaleAge = 30 * time.Minute
	usageMaxAge   = 3 * 24 * time.Hour
)

type usageKey struct{ id, configDir string }

type savedUsage struct {
	Windows   []model.UsageWindow `json:"windows"`
	SampledAt time.Time           `json:"sampledAt"`
}

type usageEntry struct {
	pluginID    string
	windows     []model.UsageWindow
	sampledAt   time.Time
	confirmed   bool // Value comes from a live probe, stream update, SQLite, or rollout.
	provisional bool // Seeded from SQLite or rollout and not yet confirmed in this process.
	refreshFail bool // Latest refresh attempt failed.
	lastErr     error
	expires     time.Time
	loading     *usageLoad
}

type usageLoad struct {
	done  chan struct{}
	value *model.ProviderUsage
	err   error
}

// ProviderUsage returns cached subscription allowance windows, refreshing in the
// background via singleflight so slow CLI probes never block or flap the UI.
func (a *App) ProviderUsage(ctx context.Context, id string, refresh bool) (*model.ProviderUsage, error) {
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
	if !provider.SupportsUsage(config) {
		a.mu.Unlock()
		return &model.ProviderUsage{Windows: []model.UsageWindow{}}, nil
	}
	now := time.Now()
	key := usageKey{id: id, configDir: provider.ConfigurationDirectory(config)}
	entry := a.usageEntryLocked(key, config, now)
	if !refresh && entry.confirmed && now.Before(entry.expires) {
		if entry.refreshFail {
			if snap, ok := usageSnapshot(entry.windows, entry.sampledAt, true, now); ok {
				a.mu.Unlock()
				return snap, nil
			}
			err := entry.lastErr
			a.mu.Unlock()
			return nil, err
		}
		if len(entry.windows) == 0 {
			sampled := formatUsageTime(entry.sampledAt)
			a.mu.Unlock()
			return &model.ProviderUsage{Windows: []model.UsageWindow{}, SampledAt: sampled}, nil
		}
		if snap, ok := usageSnapshot(entry.windows, entry.sampledAt, false, now); ok {
			a.mu.Unlock()
			return snap, nil
		}
	}
	swr, hasSWR := usageSnapshot(entry.windows, entry.sampledAt, entry.refreshFail, now)
	tryRollout := !refresh && !hasSWR && !entry.confirmed && config.Type == "codex" && !a.codexSessionsSharedLocked(config)
	load := entry.loading
	if load == nil {
		load = &usageLoad{done: make(chan struct{})}
		entry.loading = load
		a.wg.Go(func() {
			defer close(load.done)
			load.value, load.err = a.refreshUsage(config, key, entry)
		})
	}
	a.mu.Unlock()

	if !refresh && hasSWR {
		if _, err := provider.Executable(a.ctx, config); !provider.IsExecutableMissing(err) {
			return swr, nil
		}
	}
	if tryRollout {
		if _, err := provider.Executable(a.ctx, config); !provider.IsExecutableMissing(err) {
			if windows, sampledAt, ok := provider.CodexRolloutUsage(config, now, usageMaxAge); ok {
				if snap, ok := usageSnapshot(windows, sampledAt, false, now); ok {
					a.mu.Lock()
					if !a.closed && a.usages[key] == entry && !entry.confirmed {
						entry.windows = windows
						entry.sampledAt = sampledAt
						entry.confirmed = true
						entry.provisional = true
					}
					a.mu.Unlock()
					return snap, nil
				}
			}
		}
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-load.done:
		return load.value, load.err
	}
}

func (a *App) usageEntryLocked(key usageKey, config model.Provider, now time.Time) *usageEntry {
	if entry := a.usages[key]; entry != nil {
		return entry
	}
	entry := &usageEntry{pluginID: config.PluginID}
	saved, err := store.Get[savedUsage](a.ctx, a.Store.DB, "SELECT data FROM provider_usage WHERE provider_id=? AND config_dir=?", key.id, key.configDir)
	if err == nil && !saved.SampledAt.IsZero() && now.Sub(saved.SampledAt) <= usageMaxAge {
		if live := provider.LiveUsageWindows(saved.Windows, now); len(live) > 0 {
			entry.windows = live
			entry.sampledAt = saved.SampledAt.UTC()
			entry.confirmed = true
			entry.provisional = true
		}
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Warn("read cached provider usage", "provider", key.id, "error", err)
	}
	if a.usages == nil {
		a.usages = make(map[usageKey]*usageEntry)
	}
	a.usages[key] = entry
	return entry
}

func (a *App) refreshUsage(config model.Provider, key usageKey, entry *usageEntry) (*model.ProviderUsage, error) {
	startedAt := time.Now()
	windows, err := provider.Usage(a.ctx, config)
	finishedAt := time.Now()

	var rolloutWindows []model.UsageWindow
	var rolloutAt time.Time
	var hasRollout bool
	if err != nil && !provider.IsExecutableMissing(err) && !errors.Is(err, provider.ErrUsageUnsupported) && config.Type == "codex" {
		a.mu.Lock()
		shared := a.closed || a.codexSessionsSharedLocked(config)
		a.mu.Unlock()
		if !shared {
			rolloutWindows, rolloutAt, hasRollout = provider.CodexRolloutUsage(config, finishedAt, usageMaxAge)
		}
	}

	var notify bool
	a.mu.Lock()
	entry.loading = nil
	if provider.IsExecutableMissing(err) {
		if !a.closed && a.usages[key] == entry {
			a.invalidateProviderUsageLocked(key.id, true)
			notify = true
		}
		a.mu.Unlock()
		if notify {
			a.notifyProviderUsage()
		}
		return nil, err
	}
	if a.closed || a.usages[key] != entry {
		a.mu.Unlock()
		return nil, context.Canceled
	}
	if errors.Is(err, provider.ErrUsageUnsupported) {
		notify = len(entry.windows) > 0 || entry.refreshFail
		entry.windows = nil
		entry.sampledAt = finishedAt.UTC()
		entry.confirmed = true
		entry.provisional = false
		entry.refreshFail = false
		entry.lastErr = nil
		entry.expires = finishedAt.Add(usageTTL)
		a.deleteSavedUsageLocked(key)
		a.mu.Unlock()
		if notify {
			a.notifyProviderUsage()
		}
		return &model.ProviderUsage{Windows: []model.UsageWindow{}}, nil
	}
	// A live stream update pushed after this probe started is fresher; never roll it back
	// or mark it stale if the slower probe fails.
	if entry.confirmed && !entry.provisional && !entry.refreshFail && entry.sampledAt.After(startedAt) {
		if err == nil && len(windows) > 0 {
			merged := fillMissingUsageWindows(entry.windows, windows, finishedAt)
			if !slices.Equal(entry.windows, merged) {
				entry.windows = merged
				a.saveUsageLocked(key, entry.windows, entry.sampledAt)
				notify = true
			}
		}
		snap, ok := usageSnapshot(entry.windows, entry.sampledAt, false, finishedAt)
		sampled := formatUsageTime(entry.sampledAt)
		a.mu.Unlock()
		if notify {
			a.notifyProviderUsage()
		}
		if ok {
			return snap, nil
		}
		return &model.ProviderUsage{Windows: []model.UsageWindow{}, SampledAt: sampled}, nil
	}
	if err != nil {
		prevWindows := entry.windows
		wasFail := entry.refreshFail
		if hasRollout && rolloutAt.After(entry.sampledAt) {
			entry.windows = rolloutWindows
			entry.sampledAt = rolloutAt
		}
		if snap, ok := usageSnapshot(entry.windows, entry.sampledAt, true, finishedAt); ok {
			entry.confirmed = true
			entry.refreshFail = true
			entry.lastErr = err
			entry.expires = finishedAt.Add(usageRetry)
			notify = !wasFail || !slices.Equal(prevWindows, entry.windows)
			a.mu.Unlock()
			if notify {
				a.notifyProviderUsage()
			}
			return snap, nil
		}
		entry.windows = nil
		entry.confirmed = true
		entry.provisional = false
		entry.refreshFail = true
		entry.lastErr = err
		entry.expires = finishedAt.Add(usageRetry)
		a.mu.Unlock()
		return nil, err
	}

	live := provider.LiveUsageWindows(windows, finishedAt)
	notify = entry.provisional || entry.refreshFail || !slices.Equal(entry.windows, live)
	entry.windows = live
	entry.sampledAt = finishedAt.UTC()
	entry.confirmed = true
	entry.provisional = false
	entry.refreshFail = false
	entry.lastErr = nil
	entry.expires = finishedAt.Add(usageTTL)
	if len(live) > 0 {
		a.saveUsageLocked(key, live, entry.sampledAt)
	} else {
		a.deleteSavedUsageLocked(key)
	}
	out := slices.Clone(live)
	if out == nil {
		out = []model.UsageWindow{}
	}
	sampled := entry.sampledAt.Format(time.RFC3339)
	a.mu.Unlock()
	if notify {
		a.notifyProviderUsage()
	}
	return &model.ProviderUsage{Windows: out, SampledAt: sampled}, nil
}

// recordProviderUsage folds live rate-limit updates observed during Codex or
// Claude turns into the cache and SQLite so the UI reflects usage immediately.
func (a *App) recordProviderUsage(config model.Provider, windows []model.UsageWindow) {
	if !provider.SupportsUsage(config) || len(windows) == 0 {
		return
	}
	now := time.Now()
	incoming := provider.LiveUsageWindows(windows, now)
	if len(incoming) == 0 {
		return
	}
	key := usageKey{id: config.ID, configDir: provider.ConfigurationDirectory(config)}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return
	}
	entry := a.usageEntryLocked(key, config, now)
	var existing []model.UsageWindow
	if entry.confirmed && !entry.sampledAt.IsZero() && now.Sub(entry.sampledAt) <= usageMaxAge {
		existing = entry.windows
	}
	merged := mergeUsageWindows(existing, incoming, now)
	if len(merged) == 0 {
		a.mu.Unlock()
		return
	}
	changed := !entry.confirmed || entry.provisional || entry.refreshFail || !slices.Equal(entry.windows, merged)
	shouldPersist := changed || now.Sub(entry.sampledAt) >= time.Minute
	entry.windows = merged
	entry.sampledAt = now.UTC()
	entry.confirmed = true
	entry.provisional = false
	entry.refreshFail = false
	entry.lastErr = nil
	entry.expires = now.Add(usageTTL)
	if shouldPersist {
		a.saveUsageLocked(key, merged, entry.sampledAt)
	}
	a.mu.Unlock()
	if changed {
		a.notifyProviderUsage()
	}
}

func (a *App) saveUsageLocked(key usageKey, windows []model.UsageWindow, sampledAt time.Time) {
	payload := savedUsage{Windows: windows, SampledAt: sampledAt.UTC()}
	if _, err := a.Store.DB.ExecContext(a.ctx, `INSERT INTO provider_usage(provider_id,config_dir,data) VALUES(?,?,?)
ON CONFLICT(provider_id,config_dir) DO UPDATE SET data=excluded.data`, key.id, key.configDir, store.JSON(payload)); err != nil {
		slog.Warn("save provider usage", "provider", key.id, "error", err)
	}
}

func (a *App) deleteSavedUsageLocked(key usageKey) {
	if _, err := a.Store.DB.ExecContext(a.ctx, "DELETE FROM provider_usage WHERE provider_id=? AND config_dir=?", key.id, key.configDir); err != nil {
		slog.Warn("clear provider usage", "provider", key.id, "error", err)
	}
}

func (a *App) invalidateProviderUsageLocked(id string, clearDisk bool) {
	for key := range a.usages {
		if key.id == id {
			delete(a.usages, key)
		}
	}
	if clearDisk {
		if _, err := a.Store.DB.ExecContext(a.ctx, "DELETE FROM provider_usage WHERE provider_id=?", id); err != nil {
			slog.Warn("clear provider usage", "provider", id, "error", err)
		}
	}
}

func (a *App) observeProviderProbes(infos []model.ProviderInfo) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	for _, info := range infos {
		if !info.Available || !info.Installed {
			a.invalidateProviderUsageLocked(info.ID, true)
			continue
		}
		if info.Error == "" && !info.ReportsUsage {
			a.invalidateProviderUsageLocked(info.ID, true)
		}
		if info.Error == "" && info.Version != "" && info.Type == "antigravity" {
			if prev, ok := a.usageVersions[info.ID]; ok && prev != info.Version {
				a.invalidateProviderUsageLocked(info.ID, false)
			}
			if a.usageVersions == nil {
				a.usageVersions = make(map[string]string)
			}
			a.usageVersions[info.ID] = info.Version
		}
	}
}

func (a *App) codexSessionsSharedLocked(config model.Provider) bool {
	if config.Type != "codex" {
		return false
	}
	if config.ShadowHome != "" {
		return true
	}
	base := provider.SharedStore(config)
	if base == "" {
		return true
	}
	providers, err := store.List[model.Provider](a.ctx, a.Store.DB, "SELECT data FROM providers WHERE json_extract(data,'$.type')='codex'")
	if err != nil {
		return true
	}
	for _, other := range providers {
		if other.ShadowHome != "" && provider.SharedStore(other) == base {
			return true
		}
	}
	return false
}

func (a *App) notifyProviderUsage() {
	if a.ctx.Err() != nil {
		return
	}
	if err := a.Store.Write(a.ctx, func(tx *sql.Tx) error {
		return store.Event(tx, model.Event{Type: "provider-usage"})
	}); err != nil && a.ctx.Err() == nil {
		slog.Warn("publish provider usage event", "error", err)
	}
}

func usageSnapshot(windows []model.UsageWindow, sampledAt time.Time, failed bool, now time.Time) (*model.ProviderUsage, bool) {
	if sampledAt.IsZero() || now.Sub(sampledAt) > usageMaxAge {
		return nil, false
	}
	live := provider.LiveUsageWindows(windows, now)
	if len(live) == 0 {
		return nil, false
	}
	return &model.ProviderUsage{
		Windows:   live,
		SampledAt: sampledAt.UTC().Format(time.RFC3339),
		Stale:     failed || now.Sub(sampledAt) >= usageStaleAge,
	}, true
}

func formatUsageTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func mergeUsageWindows(existing, update []model.UsageWindow, now time.Time) []model.UsageWindow {
	merged := slices.Clone(provider.LiveUsageWindows(existing, now))
	for _, w := range provider.LiveUsageWindows(update, now) {
		index := slices.IndexFunc(merged, func(item model.UsageWindow) bool { return item.ID == w.ID })
		if index >= 0 {
			prev := merged[index]
			if w.Minutes == 0 && prev.Minutes > 0 {
				w.Minutes = prev.Minutes
			}
			if w.ResetsAt == "" && prev.ResetsAt != "" {
				w.ResetsAt = prev.ResetsAt
			}
			if w.Group == "" && prev.Group != "" {
				w.Group = prev.Group
			}
			merged[index] = w
		} else {
			merged = append(merged, w)
		}
	}
	return merged
}

func fillMissingUsageWindows(current, fallback []model.UsageWindow, now time.Time) []model.UsageWindow {
	merged := slices.Clone(provider.LiveUsageWindows(current, now))
	for _, w := range provider.LiveUsageWindows(fallback, now) {
		if !slices.ContainsFunc(merged, func(item model.UsageWindow) bool { return item.ID == w.ID }) {
			merged = append(merged, w)
		}
	}
	return merged
}
