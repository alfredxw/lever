package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin/github"
	"lever/internal/plugin/builtin/lark-todos"
	"lever/internal/store"
)

const (
	taskSyncInterval      = 5 * time.Minute
	maxTaskSourceConfigKB = 256
)

type taskSubscription struct {
	model.TaskSource
	TargetID   string `json:"targetId"`
	Cursor     string `json:"cursor"`
	NextSyncAt int64  `json:"nextSyncAt"`
}

type taskSourceSync struct {
	sourceID string
	pluginID string
	cancel   context.CancelFunc
}

const taskSourceSelect = `
SELECT json_object('id',s.id,'pluginId',s.plugin_id,'contributionId',s.contribution_id,
  'name',s.name,'summary',s.summary,'syncKind',s.sync_kind,
  'larkScope',CASE WHEN s.plugin_id='lever.lark-todos' THEN json_object(
    'allAssigned',json(CASE WHEN json_array_length(s.lark_section_ids)=0 THEN 'true' ELSE 'false' END),
    'sectionIds',json(s.lark_section_ids),'excludedTaskIds',json(s.lark_excluded_task_ids),
    'filters',json(s.lark_filters)) END,
  'config',CASE WHEN s.config_json<>'null' THEN json(s.config_json) END,
  'enabled',json(CASE WHEN s.status='active' THEN 'true' ELSE 'false' END),
  'pluginEnabled',json(CASE WHEN ` + taskPluginEnabled + ` THEN 'true' ELSE 'false' END),
  'syncPending',json(CASE WHEN s.next_sync_at=0 THEN 'true' ELSE 'false' END),
  'lastSyncedAt',s.last_synced_at,'error',s.error,
  'targetId',s.target_id,'cursor',s.cursor,'nextSyncAt',s.next_sync_at)
FROM task_sources s JOIN plugins p ON p.id=s.plugin_id`

const taskPluginEnabled = "json_extract(p.data,'$.enabled')=1 AND json_extract(p.data,'$.installed')=1"

func (a *App) taskSourceCacheDir(pluginID string) string {
	return filepath.Join(a.Store.Dir, "task-sources", pluginID)
}

func (a *App) resolveExternalTaskSource(ctx context.Context, q store.Queryer, pluginID, contributionID, sourceID string) (plugin.StdioTaskSource, model.TaskSourceContribution, bool, error) {
	p, err := store.Get[model.Plugin](ctx, q, "SELECT data FROM plugins WHERE id=?", pluginID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !p.Installed) {
		return plugin.StdioTaskSource{}, model.TaskSourceContribution{}, false, nil
	}
	if err != nil {
		return plugin.StdioTaskSource{}, model.TaskSourceContribution{}, false, err
	}
	if p.Builtin || p.Directory == "" {
		return plugin.StdioTaskSource{}, model.TaskSourceContribution{}, p.Enabled && p.Installed, nil
	}
	index := slices.IndexFunc(p.Manifest.Contributes.TaskSources, func(item model.TaskSourceContribution) bool {
		return item.ID == contributionID
	})
	if index < 0 {
		return plugin.StdioTaskSource{}, model.TaskSourceContribution{}, p.Enabled && p.Installed, nil
	}
	item := p.Manifest.Contributes.TaskSources[index]
	if item.Driver != plugin.TaskSourceStdioDriver || item.Command == "" {
		return plugin.StdioTaskSource{}, item, p.Enabled && p.Installed, nil
	}
	return plugin.StdioTaskSource{
		Directory:      p.Directory,
		ContributionID: item.ID,
		Command:        item.Command,
		CacheDir:       a.taskSourceCacheDir(p.ID),
		SourceID:       sourceID,
	}, item, p.Enabled && p.Installed, nil
}

func (a *App) TaskSources(ctx context.Context) ([]model.TaskSource, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rows, err := store.List[model.TaskSource](ctx, a.Store.DB, taskSourceSelect+" WHERE s.status<>'removed' ORDER BY s.name COLLATE NOCASE")
	if err != nil {
		return nil, err
	}
	for i := range rows {
		if a.taskSync != nil && rows[i].ID == a.taskSync.sourceID {
			rows[i].SyncPending = true
		}
	}
	return rows, nil
}

func taskSource(ctx context.Context, q store.Queryer, id string) (taskSubscription, error) {
	return store.Get[taskSubscription](ctx, q, taskSourceSelect+" WHERE s.id=? AND s.status<>'removed'", id)
}

func taskSourcePluginEnabled(ctx context.Context, q store.Queryer, id string) (bool, error) {
	var enabled bool
	err := q.QueryRowContext(ctx, "SELECT "+taskPluginEnabled+" FROM plugins p WHERE p.id=?", id).Scan(&enabled)
	return enabled, err
}

func validateTaskSourceKind(pluginID string, kind model.TaskSourceKind) error {
	if !kind.Valid() {
		return invalid("Choose Issue, PR, or both")
	}
	if pluginID != github.PluginID && kind != model.TaskSourceKindBoth {
		return invalid("Issue and PR filters are available for GitHub sources")
	}
	return nil
}

func normalizeTaskConfig(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "{}", nil
	}
	if len(trimmed) > maxTaskSourceConfigKB<<10 {
		return "", invalid("Task source configuration is too large")
	}
	var obj map[string]any
	if err := json.Unmarshal(trimmed, &obj); err != nil || obj == nil {
		return "", invalid("Task source configuration must be a JSON object")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, trimmed); err != nil {
		return "", invalid("Invalid task source configuration")
	}
	return compact.String(), nil
}

func firstNoticeMessage(notices []model.TaskSourceNotice, fallback string) string {
	for _, n := range notices {
		if strings.TrimSpace(n.Message) != "" {
			return strings.TrimSpace(n.Message)
		}
	}
	return fallback
}

func (a *App) InspectTaskSource(ctx context.Context, input model.TaskSourceInspectRequest) (model.TaskSourceInspect, error) {
	if input.SourceID != "" && (input.PluginID == "" || input.ContributionID == "") {
		source, err := taskSource(ctx, a.Store.DB, input.SourceID)
		if err != nil {
			return model.TaskSourceInspect{}, err
		}
		input.PluginID = source.PluginID
		input.ContributionID = source.ContributionID
		if len(bytes.TrimSpace(input.Config)) == 0 {
			input.Config = source.Config
		}
	}
	stdio, _, enabled, err := a.resolveExternalTaskSource(ctx, a.Store.DB, input.PluginID, input.ContributionID, input.SourceID)
	if err != nil {
		return model.TaskSourceInspect{}, err
	}
	if stdio.Command == "" {
		return model.TaskSourceInspect{}, invalid("Unknown external task source")
	}
	if !enabled {
		return model.TaskSourceInspect{}, conflict("Enable this plugin before configuring a source")
	}
	if len(bytes.TrimSpace(input.Config)) > 0 {
		clean, err := normalizeTaskConfig(input.Config)
		if err != nil {
			return model.TaskSourceInspect{}, err
		}
		input.Config = json.RawMessage(clean)
	}
	deadline, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return stdio.Inspect(deadline, input)
}

func (a *App) PreviewTaskSource(ctx context.Context, input model.TaskSourcePreviewRequest) (model.TaskSourcePreview, error) {
	if input.SourceID != "" && (input.PluginID == "" || input.ContributionID == "") {
		source, err := taskSource(ctx, a.Store.DB, input.SourceID)
		if err != nil {
			return model.TaskSourcePreview{}, err
		}
		input.PluginID = source.PluginID
		input.ContributionID = source.ContributionID
		if len(bytes.TrimSpace(input.Config)) == 0 {
			input.Config = source.Config
		}
	}
	stdio, _, enabled, err := a.resolveExternalTaskSource(ctx, a.Store.DB, input.PluginID, input.ContributionID, input.SourceID)
	if err != nil {
		return model.TaskSourcePreview{}, err
	}
	if stdio.Command == "" {
		return model.TaskSourcePreview{}, invalid("Unknown external task source")
	}
	if !enabled {
		return model.TaskSourcePreview{}, conflict("Enable this plugin before previewing a source")
	}
	if len(bytes.TrimSpace(input.Config)) > 0 {
		clean, err := normalizeTaskConfig(input.Config)
		if err != nil {
			return model.TaskSourcePreview{}, err
		}
		input.Config = json.RawMessage(clean)
	}
	deadline, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return stdio.Preview(deadline, input)
}

func (a *App) LarkTaskPreview(ctx context.Context, sourceID string) (*model.LarkTaskPreview, error) {
	enabled, err := taskSourcePluginEnabled(ctx, a.Store.DB, larktodos.PluginID)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, conflict("Enable Lark Todos to list its task groups")
	}
	var targetID string
	if sourceID != "" {
		source, err := taskSource(ctx, a.Store.DB, sourceID)
		if err != nil {
			return nil, err
		}
		if source.PluginID != larktodos.PluginID {
			return nil, invalid("Choose a Lark Todos source")
		}
		targetID = source.TargetID
	}
	return larktodos.NewTaskSource().Preview(ctx, targetID)
}

func normalizeLarkScope(pluginID string, scope *model.LarkTaskScope) (model.LarkTaskScope, error) {
	empty := model.LarkTaskScope{SectionIDs: []string{}, ExcludedTaskIDs: []string{}}
	if pluginID != larktodos.PluginID {
		if scope != nil {
			return empty, invalid("Lark task selection requires a Lark Todos source")
		}
		return empty, nil
	}
	if scope == nil || (!scope.AllAssigned && len(scope.SectionIDs) == 0) {
		return empty, invalid("Subscribe to at least one Lark task group")
	}
	if scope.AllAssigned && len(scope.SectionIDs) > 0 {
		return empty, invalid("Choose all assigned Lark tasks or specific groups")
	}
	if scope.ExcludedTaskIDs == nil {
		return empty, invalid("Confirm the existing Lark tasks to import")
	}
	for _, ids := range [][]string{scope.SectionIDs, scope.ExcludedTaskIDs} {
		for _, id := range ids {
			// Lark identifiers are opaque. Older tasks can have 32-character IDs without UUID separators.
			if id == "" || strings.TrimSpace(id) != id {
				return empty, invalid("Choose a valid Lark task or group")
			}
		}
	}
	unique := func(ids []string) []string {
		ids = append([]string{}, ids...)
		slices.Sort(ids)
		return slices.Compact(ids)
	}
	filters := scope.Filters
	if filters != nil {
		switch filters.DueWindow {
		case "", model.LarkTaskDueWindowOverdue, model.LarkTaskDueWindowWeek, model.LarkTaskDueWindowNone:
		default:
			return empty, invalid("Choose a valid Lark due date filter")
		}
		clean := *filters
		clean.TitleIncludes = normalizeLarkKeywords(clean.TitleIncludes)
		clean.TitleExcludes = normalizeLarkKeywords(clean.TitleExcludes)
		filters = &clean
		if clean.DueWindow == "" && len(clean.TitleIncludes) == 0 && len(clean.TitleExcludes) == 0 && !clean.SkipRecurring {
			filters = nil
		}
	}
	return model.LarkTaskScope{
		AllAssigned: scope.AllAssigned, SectionIDs: unique(scope.SectionIDs),
		ExcludedTaskIDs: unique(scope.ExcludedTaskIDs), Filters: filters,
	}, nil
}

func normalizeTaskSourceName(allowCustomName bool, name string) (string, error) {
	name = strings.TrimSpace(name)
	if !allowCustomName {
		return "", invalid("This task source cannot be renamed")
	}
	if name == "" || !validTaskLabel(name) {
		return "", invalid("Enter a source name up to 100 characters")
	}
	return name, nil
}

func normalizeLarkKeywords(terms []string) []string {
	var result []string
	seen := make(map[string]bool, len(terms))
	for _, term := range terms {
		term = strings.TrimSpace(term)
		key := strings.ToLower(term)
		if key != "" && !seen[key] {
			result = append(result, term)
			seen[key] = true
		}
	}
	return result
}

func (a *App) AddTaskSource(ctx context.Context, input model.TaskSourceCreate) (model.TaskSource, error) {
	pluginID, contributionID, kind := input.PluginID, input.ContributionID, input.SyncKind
	adapter := a.taskAdapters[[2]string{pluginID, contributionID}]
	var stdio plugin.StdioTaskSource
	var contrib model.TaskSourceContribution
	isExternal := false
	if adapter == nil {
		var enabled bool
		var err error
		stdio, contrib, enabled, err = a.resolveExternalTaskSource(ctx, a.Store.DB, pluginID, contributionID, "")
		if err != nil {
			return model.TaskSource{}, err
		}
		if stdio.Command == "" {
			return model.TaskSource{}, invalid("Unknown task source")
		}
		if !enabled {
			return model.TaskSource{}, conflict("Enable this plugin before adding a source")
		}
		isExternal = true
	}
	if kind == "" {
		kind = model.TaskSourceKindBoth
	}
	if err := validateTaskSourceKind(pluginID, kind); err != nil {
		return model.TaskSource{}, err
	}
	scope, err := normalizeLarkScope(pluginID, input.LarkScope)
	if err != nil {
		return model.TaskSource{}, err
	}

	configJSON := "null"
	var summary string
	var resolved plugin.TaskSourceTarget
	allowCustomName := pluginID == larktodos.PluginID

	if isExternal {
		allowCustomName = contrib.CustomName
		cleanCfg, err := normalizeTaskConfig(input.Config)
		if err != nil {
			return model.TaskSource{}, err
		}
		deadline, cancel := context.WithTimeout(ctx, 60*time.Second)
		inspected, err := stdio.Inspect(deadline, model.TaskSourceInspectRequest{
			PluginID:       pluginID,
			ContributionID: contributionID,
			Config:         json.RawMessage(cleanCfg),
		})
		cancel()
		if err != nil {
			return model.TaskSource{}, err
		}
		if !inspected.Ready || !inspected.CanSave {
			return model.TaskSource{}, invalid(firstNoticeMessage(inspected.Notices, "Complete the source configuration before saving"))
		}
		if len(bytes.TrimSpace(inspected.Config)) > 0 {
			cleanCfg, err = normalizeTaskConfig(inspected.Config)
			if err != nil {
				return model.TaskSource{}, err
			}
		}
		configJSON = cleanCfg
		summary = strings.TrimSpace(inspected.Summary)
		targetID := strings.TrimSpace(inspected.Target)
		if contrib.MultiInstance || targetID == "" {
			targetID = ID()
		}
		defaultName := strings.TrimSpace(inspected.SuggestedName)
		if defaultName == "" {
			defaultName = contrib.Name
		}
		resolved = plugin.TaskSourceTarget{ID: targetID, Name: defaultName}
	} else {
		if len(bytes.TrimSpace(input.Config)) > 0 && !bytes.Equal(bytes.TrimSpace(input.Config), []byte("null")) {
			return model.TaskSource{}, invalid("Custom configuration requires an external task source")
		}
		if pluginID == larktodos.PluginID && input.Target == "" {
			return model.TaskSource{}, invalid("Preview the Lark account before subscribing")
		}
		enabled, err := taskSourcePluginEnabled(ctx, a.Store.DB, pluginID)
		if err != nil {
			return model.TaskSource{}, err
		}
		if !enabled {
			return model.TaskSource{}, conflict("Enable this plugin before adding a source")
		}
		resolved, err = adapter.Resolve(ctx, input.Target)
		if err != nil {
			return model.TaskSource{}, err
		}
	}

	name := resolved.Name
	if strings.TrimSpace(input.Name) != "" {
		if name, err = normalizeTaskSourceName(allowCustomName, input.Name); err != nil {
			return model.TaskSource{}, err
		}
	}

	var source taskSubscription
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		enabled, err := taskSourcePluginEnabled(ctx, tx, pluginID)
		if err != nil {
			return err
		}
		if !enabled {
			return conflict("Enable this plugin before adding a source")
		}
		var id string
		err = tx.QueryRowContext(ctx, `
INSERT INTO task_sources(id,plugin_id,contribution_id,target_id,name,summary,sync_kind,lark_section_ids,lark_excluded_task_ids,lark_filters,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(plugin_id,contribution_id,target_id) DO UPDATE SET status='active',name=excluded.name,summary=excluded.summary,
  sync_kind=excluded.sync_kind,lark_section_ids=excluded.lark_section_ids,lark_excluded_task_ids=excluded.lark_excluded_task_ids,
  lark_filters=excluded.lark_filters,config_json=excluded.config_json,
  next_sync_at=CASE WHEN task_sources.error='rateLimit' THEN task_sources.next_sync_at ELSE 0 END
WHERE task_sources.status='removed' RETURNING id`, ID(), pluginID, contributionID, resolved.ID, name, summary, kind,
			store.JSON(scope.SectionIDs), store.JSON(scope.ExcludedTaskIDs), store.JSON(scope.Filters), configJSON).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return conflict("This task source already exists")
		}
		if err != nil {
			return err
		}
		if pluginID == larktodos.PluginID || isExternal {
			// Re-adding a source must not expose rows from its previous subscription before the first pull.
			if _, err := tx.ExecContext(ctx, "UPDATE external_tasks SET in_scope=0 WHERE source_id=? AND in_scope=1", id); err != nil {
				return err
			}
		}
		source, err = taskSource(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := store.Event(tx, model.Event{Type: "external-tasks"}); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-sources"})
	})
	if err != nil {
		return model.TaskSource{}, err
	}
	a.wakeTaskSources()
	return source.TaskSource, nil
}

func (a *App) UpdateTaskSource(ctx context.Context, id string, update model.TaskSourceUpdate) error {
	// Resolve external plugin configuration outside locks so CLI I/O never holds a.mu or SQLite tx.
	var nextConfigJSON string
	var nextSummary string
	hasConfigUpdate := len(bytes.TrimSpace(update.Config)) > 0
	var allowCustomName bool

	existing, err := taskSource(ctx, a.Store.DB, id)
	if err != nil {
		return err
	}
	allowCustomName = existing.PluginID == larktodos.PluginID
	stdio, contrib, _, err := a.resolveExternalTaskSource(ctx, a.Store.DB, existing.PluginID, existing.ContributionID, id)
	if err != nil {
		return err
	}
	isExternal := stdio.Command != ""
	if isExternal {
		allowCustomName = contrib.CustomName
	}

	if hasConfigUpdate {
		if !isExternal {
			return invalid("Custom configuration requires an external task source")
		}
		cleanCfg, err := normalizeTaskConfig(update.Config)
		if err != nil {
			return err
		}
		deadline, cancel := context.WithTimeout(ctx, 60*time.Second)
		inspected, err := stdio.Inspect(deadline, model.TaskSourceInspectRequest{
			PluginID:       existing.PluginID,
			ContributionID: existing.ContributionID,
			SourceID:       id,
			Config:         json.RawMessage(cleanCfg),
		})
		cancel()
		if err != nil {
			return err
		}
		if !inspected.Ready || !inspected.CanSave {
			return invalid(firstNoticeMessage(inspected.Notices, "Complete the source configuration before saving"))
		}
		if len(bytes.TrimSpace(inspected.Config)) > 0 {
			cleanCfg, err = normalizeTaskConfig(inspected.Config)
			if err != nil {
				return err
			}
		}
		nextConfigJSON = cleanCfg
		nextSummary = strings.TrimSpace(inspected.Summary)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	var changed, scopeChanged, enabled bool
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		current, err := taskSource(ctx, tx, id)
		if err != nil {
			return err
		}
		name := current.Name
		if update.Name != nil {
			if name, err = normalizeTaskSourceName(allowCustomName, *update.Name); err != nil {
				return err
			}
		}
		enabled = current.Enabled
		if update.Enabled != nil {
			enabled = *update.Enabled
		}
		kind := current.SyncKind
		if update.SyncKind != nil {
			if err := validateTaskSourceKind(current.PluginID, *update.SyncKind); err != nil {
				return err
			}
			kind = *update.SyncKind
		}
		scope := model.LarkTaskScope{SectionIDs: []string{}, ExcludedTaskIDs: []string{}}
		if current.LarkScope != nil {
			scope = *current.LarkScope
		}
		scopeChanged = current.SyncKind != kind
		if update.LarkScope != nil {
			updated, err := normalizeLarkScope(current.PluginID, update.LarkScope)
			if err != nil {
				return err
			}
			scopeChanged = scopeChanged || !slices.Equal(scope.SectionIDs, updated.SectionIDs) ||
				!slices.Equal(scope.ExcludedTaskIDs, updated.ExcludedTaskIDs) || store.JSON(scope.Filters) != store.JSON(updated.Filters)
			scope = updated
		}
		configJSON := "null"
		if len(bytes.TrimSpace(current.Config)) > 0 {
			if cleanCurrent, err := normalizeTaskConfig(current.Config); err == nil {
				configJSON = cleanCurrent
			}
		}
		summary := current.Summary
		if hasConfigUpdate {
			scopeChanged = scopeChanged || configJSON != nextConfigJSON
			configJSON = nextConfigJSON
			summary = nextSummary
		}

		syncRequested := (update.LarkScope != nil || hasConfigUpdate) && enabled && current.NextSyncAt != 0 && current.Error != "rateLimit"
		// The name labels imported tasks. Renaming refreshes them without a sync.
		renamed := current.Name != name
		changed = scopeChanged || current.Enabled != enabled || syncRequested
		if !changed && !renamed && summary == current.Summary {
			return nil
		}
		next := current.NextSyncAt
		status := "paused"
		if enabled {
			status = "active"
		}
		if changed && (enabled || scopeChanged) && current.Error != "rateLimit" {
			next = 0
		}
		if _, err := tx.ExecContext(ctx, `UPDATE task_sources SET name=?,summary=?,status=?,sync_kind=?,lark_section_ids=?,lark_excluded_task_ids=?,lark_filters=?,config_json=?,next_sync_at=? WHERE id=?`,
			name, summary, status, kind, store.JSON(scope.SectionIDs), store.JSON(scope.ExcludedTaskIDs), store.JSON(scope.Filters), configJSON, next, id); err != nil {
			return err
		}
		if scopeChanged || renamed {
			if err := store.Event(tx, model.Event{Type: "external-tasks"}); err != nil {
				return err
			}
		}
		return store.Event(tx, model.Event{Type: "task-sources"})
	})
	if err == nil && changed {
		if (!enabled || scopeChanged) && a.taskSync != nil && a.taskSync.sourceID == id {
			a.taskSync.cancel()
			a.taskSync = nil
		}
		if enabled {
			a.wakeTaskSources()
		}
	}
	return err
}

func (a *App) RequestTaskSync(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		source, err := taskSource(ctx, tx, id)
		if err != nil {
			return err
		}
		if !source.Enabled || !source.PluginEnabled {
			return conflict("Enable this source and its plugin before syncing")
		}
		if source.Error == "rateLimit" && source.NextSyncAt > time.Now().Unix() {
			return &plugin.TaskSourceError{Status: 429, Code: "rateLimit", Message: "The source is waiting for its rate limit to reset"}
		}
		if source.NextSyncAt == 0 || (a.taskSync != nil && a.taskSync.sourceID == id) {
			return nil
		}
		if _, err := tx.ExecContext(ctx, "UPDATE task_sources SET next_sync_at=0,error='' WHERE id=?", id); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-sources"})
	})
	if err == nil {
		a.wakeTaskSources()
	}
	return err
}

func (a *App) RemoveTaskSource(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		// Keep IDs addressable from existing Chats and when the source is re-added.
		if _, err := tx.ExecContext(ctx, "UPDATE task_sources SET status='removed' WHERE id=?", id); err != nil {
			return err
		}
		if err := store.Event(tx, model.Event{Type: "external-tasks"}); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-sources"})
	})
	if err == nil && a.taskSync != nil && a.taskSync.sourceID == id {
		a.taskSync.cancel()
		a.taskSync = nil
	}
	return err
}

func (a *App) wakeTaskSources() {
	select {
	case a.taskSyncWake <- struct{}{}:
	default:
	}
}

func (a *App) runTaskSourceSync() {
	defer a.wg.Done()
	for a.ctx.Err() == nil {
		source, err := store.Get[taskSubscription](a.ctx, a.Store.DB,
			taskSourceSelect+" WHERE s.status='active' AND "+taskPluginEnabled+" ORDER BY s.next_sync_at,s.rowid LIMIT 1")
		delay := time.Until(time.Unix(source.NextSyncAt, 0))
		if err == nil && delay <= 0 {
			err = a.syncTaskSource(source)
			if err == nil {
				continue
			}
		}
		var timer *time.Timer
		var ready <-chan time.Time
		if err != nil && !errors.Is(err, sql.ErrNoRows) && a.ctx.Err() == nil {
			slog.Error("Task source sync failed", "error", err)
			delay = 15 * time.Second
		}
		if !errors.Is(err, sql.ErrNoRows) && a.ctx.Err() == nil {
			timer = time.NewTimer(delay)
			ready = timer.C
		}
		select {
		case <-a.ctx.Done():
		case <-a.taskSyncWake:
		case <-ready:
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func (a *App) syncTaskSource(source taskSubscription) error {
	// Recheck the source and register cancellation under the same lock used by
	// edits, removal, and plugin disable. No network I/O holds the lock.
	a.mu.Lock()
	current, err := taskSource(a.ctx, a.Store.DB, source.ID)
	if err != nil || !current.Enabled || !current.PluginEnabled {
		a.mu.Unlock()
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	source = current
	if source.NextSyncAt > time.Now().Unix() {
		a.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.taskSync = &taskSourceSync{sourceID: source.ID, pluginID: source.PluginID, cancel: cancel}
	a.mu.Unlock()
	defer func() {
		cancel()
		a.mu.Lock()
		a.taskSync = nil
		a.mu.Unlock()
	}()
	deadline, stop := context.WithTimeout(ctx, 2*time.Minute)
	defer stop()
	adapter := a.taskAdapters[[2]string{source.PluginID, source.ContributionID}]
	if adapter == nil {
		stdio, _, enabled, err := a.resolveExternalTaskSource(deadline, a.Store.DB, source.PluginID, source.ContributionID, source.ID)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if enabled && stdio.Command != "" {
			adapter = stdio
		}
	}
	if adapter == nil {
		return a.saveTaskSync(ctx, source.ID, plugin.TaskSourceBatch{}, "adapter", time.Now().Add(taskSyncInterval))
	}
	open, err := store.List[plugin.TaskSourceRef](deadline, a.Store.DB, `
SELECT json_object('externalId',external_id,'reference',json_extract(data,'$.reference'))
FROM external_tasks WHERE source_id=? AND json_extract(data,'$.state')='open'
AND (?='both' OR json_extract(data,'$.kind')=?)`, source.ID, source.SyncKind, source.SyncKind)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	batch, pullErr := adapter.Pull(deadline, plugin.TaskSourceTarget{
		ID: source.TargetID, Name: source.Name, SyncKind: source.SyncKind, LarkScope: source.LarkScope, Config: source.Config,
	}, source.Cursor, open)
	next := time.Now().Add(taskSyncInterval)
	var code string
	if pullErr != nil {
		code = "response"
		var failure *plugin.TaskSourceError
		if errors.As(pullErr, &failure) {
			if failure.Code == "plugin" && strings.TrimSpace(failure.Message) != "" {
				code = strings.TrimSpace(failure.Message)
			} else {
				code = failure.Code
			}
			if failure.RetryAt.After(next) {
				next = failure.RetryAt
			}
		}
	}
	return a.saveTaskSync(ctx, source.ID, batch, code, next)
}

func (a *App) saveTaskSync(ctx context.Context, id string, batch plugin.TaskSourceBatch, failure string, next time.Time) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.taskSync = nil
	if ctx.Err() != nil {
		return nil
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		current, err := taskSource(ctx, tx, id)
		if err != nil {
			return err
		}
		if failure != "" {
			if _, err := tx.ExecContext(ctx, "UPDATE task_sources SET error=?,next_sync_at=? WHERE id=?", failure, next.Unix(), id); err != nil {
				return err
			}
			return store.Event(tx, model.Event{Type: "task-sources"})
		}
		changed := (batch.Name != "" && current.Name != batch.Name) || (batch.Summary != "" && current.Summary != batch.Summary)
		for _, item := range batch.Items {
			var result sql.Result
			var err error
			if item.State == "unavailable" {
				result, err = tx.ExecContext(ctx, `
UPDATE external_tasks SET data=json_set(data,'$.state','unavailable')
WHERE source_id=? AND external_id=? AND json_extract(data,'$.state')<>'unavailable'`, id, item.ExternalID)
			} else {
				result, err = tx.ExecContext(ctx, `
INSERT INTO external_tasks(id,source_id,external_id,data) VALUES(?,?,?,?)
ON CONFLICT(source_id,external_id) DO UPDATE SET data=excluded.data
WHERE external_tasks.data<>excluded.data`, ID(), id, item.ExternalID, store.JSON(item))
			}
			if err != nil {
				return err
			}
			count, err := result.RowsAffected()
			if err != nil {
				return err
			}
			changed = changed || count > 0
		}
		if batch.VisibleIDs != nil {
			result, err := tx.ExecContext(ctx, `
WITH visible(id) AS (SELECT value FROM json_each(?))
UPDATE external_tasks SET in_scope = (external_id IN visible)
WHERE source_id=? AND in_scope <> (external_id IN visible)`, store.JSON(batch.VisibleIDs), id)
			if err != nil {
				return err
			}
			count, err := result.RowsAffected()
			if err != nil {
				return err
			}
			changed = changed || count > 0
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE task_sources SET name=COALESCE(NULLIF(?,''),name),summary=COALESCE(NULLIF(?,''),summary),cursor=?,last_synced_at=?,next_sync_at=?,error='' WHERE id=?`,
			batch.Name, batch.Summary, batch.Cursor, time.Now().Unix(), next.Unix(), id); err != nil {
			return err
		}
		if changed {
			if err := store.Event(tx, model.Event{Type: "external-tasks"}); err != nil {
				return err
			}
		}
		return store.Event(tx, model.Event{Type: "task-sources"})
	})
	if err == nil && failure == "" {
		a.wakeTaskReminders()
	}
	return err
}
