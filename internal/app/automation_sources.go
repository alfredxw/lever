package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/store"
)

const automationPollInterval = time.Minute

// Passwords are kept in private files. SQLite stores the reference and the
// names of configured fields so clients can edit without receiving secrets.
func (a *App) prepareAutomationSource(ctx context.Context, tx *sql.Tx, id string, old, source *model.AutomationEventSource) (map[string]string, error) {
	if source == nil {
		return nil, nil
	}
	p, err := store.Get[model.Plugin](ctx, tx, "SELECT data FROM plugins WHERE id=?", source.PluginID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !p.Installed) {
		return nil, invalid("Choose an installed event source plugin")
	}
	if err != nil {
		return nil, err
	}
	key := [2]string{source.PluginID, source.ContributionID}
	index := slices.IndexFunc(p.Manifest.Contributes.EventSources, func(item model.EventSourceContribution) bool {
		return item.ID == source.ContributionID
	})
	if index < 0 || a.eventAdapters[key] == nil {
		return nil, invalid("Choose an available event type")
	}
	fields := p.Manifest.Contributes.EventSources[index].Fields
	input := source.Config
	source.Config = make(map[string]string)
	for _, field := range fields {
		if field.Kind == "secret" {
			continue
		}
		value := strings.TrimSpace(input[field.ID])
		if value == "" {
			value = field.Default
		}
		if err := validateEventField(field, value); err != nil {
			return nil, err
		}
		source.Config[field.ID] = value
	}
	var priorSecrets map[string]string
	if old != nil && old.PluginID == source.PluginID && old.ContributionID == source.ContributionID && maps.Equal(old.Config, source.Config) {
		secretID, err := automationSecretID(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		priorSecrets, err = a.readAutomationSecrets(secretID)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	secrets := make(map[string]string)
	for _, field := range fields {
		if field.Kind != "secret" {
			continue
		}
		value := input[field.ID]
		if value == "" {
			value = priorSecrets[field.ID]
		}
		if err := validateEventField(field, value); err != nil {
			return nil, err
		}
		if value != "" {
			secrets[field.ID] = value
		}
	}
	return secrets, nil
}

func validateEventField(field model.EventSourceField, value string) error {
	if field.Required && value == "" {
		return invalid("Enter " + field.Label)
	}
	if len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") {
		return invalid("Invalid value for " + field.Label)
	}
	return nil
}

type automationCredentialChange struct{ added, retired string }

func automationSecretID(ctx context.Context, q store.Queryer, id string) (string, error) {
	var secretID string
	err := q.QueryRowContext(ctx, "SELECT secret_id FROM automation_event_sources WHERE automation_id=?", id).Scan(&secretID)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return secretID, err
}

func (a *App) automationSecretPath(id string) string {
	return filepath.Join(a.Store.Dir, "automation-secrets", id)
}

func (a *App) readAutomationSecrets(id string) (map[string]string, error) {
	if id == "" {
		return nil, nil
	}
	content, err := os.ReadFile(a.automationSecretPath(id))
	if err != nil {
		return nil, err
	}
	var values map[string]string
	err = json.Unmarshal(content, &values)
	return values, err
}

func (a *App) saveAutomationSource(ctx context.Context, tx *sql.Tx, id string, secrets map[string]string, changed bool, credentials *automationCredentialChange) error {
	oldID, err := automationSecretID(ctx, tx, id)
	if err != nil {
		return err
	}
	if secrets == nil {
		credentials.retired = oldID
		_, err := tx.ExecContext(ctx, "DELETE FROM automation_event_sources WHERE automation_id=?", id)
		return err
	}
	oldValues, err := a.readAutomationSecrets(oldID)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	newID := oldID
	if !maps.Equal(oldValues, secrets) {
		credentials.retired = oldID
		newID = ""
		if len(secrets) > 0 {
			newID = ID()
			credentials.added = newID
			path := a.automationSecretPath(newID)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				return err
			}
			if err := os.WriteFile(path, []byte(store.JSON(secrets)), 0600); err != nil {
				return err
			}
		}
	}
	fields := slices.Sorted(maps.Keys(secrets))
	_, err = tx.ExecContext(ctx, `INSERT INTO automation_event_sources(automation_id,secret_id,secret_fields) VALUES(?,?,?)
ON CONFLICT(automation_id) DO UPDATE SET secret_id=excluded.secret_id,secret_fields=excluded.secret_fields,
cursor=CASE WHEN ? THEN '' ELSE automation_event_sources.cursor END,poll_at=0,error=''
WHERE automation_event_sources.secret_id<>excluded.secret_id OR ?`, id, newID, store.JSON(fields), changed, changed)
	return err
}

func (a *App) finishAutomationCredentials(change automationCredentialChange, err error) {
	id := change.retired
	if err != nil {
		id = change.added
	}
	if id != "" {
		if err := os.Remove(a.automationSecretPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("Could not remove automation credentials", "error", err)
		}
	}
}

type automationSourceSync struct {
	ID       string                      `json:"id"`
	Source   model.AutomationEventSource `json:"source"`
	SecretID string                      `json:"secretId"`
	Cursor   string                      `json:"cursor"`
	Error    string                      `json:"error"`
	Pending  int                         `json:"pending"`
}

const automationSourceSelect = `SELECT json_object(
  'id',a.id,'source',json_extract(a.data,'$.trigger.source'),'secretId',src.secret_id,
  'cursor',src.cursor,'error',src.error,
  'pending',(SELECT COUNT(*) FROM automation_events e WHERE e.automation_id=a.id AND e.payload IS NOT NULL)
) AS source FROM automation_event_sources src JOIN automations a ON a.id=src.automation_id` +
	automationPluginJoin + ` WHERE a.state='active' AND ` + automationPluginEnabled

func (a *App) pollAutomationSources() {
	defer a.wg.Done()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for a.ctx.Err() == nil {
		source, err := store.Get[automationSourceSync](a.ctx, a.Store.DB, automationSourceSelect+`
AND src.poll_at<=? AND (SELECT COUNT(*) FROM automation_events e WHERE e.automation_id=a.id AND e.payload IS NOT NULL) < ?
ORDER BY src.poll_at,a.rowid LIMIT 1`, time.Now().Unix(), maxAutomationPending)
		if err == nil {
			err = a.pollAutomationSource(source)
			if err == nil {
				continue
			}
		}
		if !errors.Is(err, sql.ErrNoRows) && a.ctx.Err() == nil {
			slog.Error("Poll automation event source", "error", err)
		}
		select {
		case <-a.ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (a *App) pollAutomationSource(source automationSourceSync) error {
	ctx, cancel := context.WithTimeout(a.ctx, 12*time.Second)
	defer cancel()
	config := maps.Clone(source.Source.Config)
	if config == nil {
		config = make(map[string]string)
	}
	secrets, secretErr := a.readAutomationSecrets(source.SecretID)
	maps.Copy(config, secrets)
	adapter := a.eventAdapters[[2]string{source.Source.PluginID, source.Source.ContributionID}]
	batch, failure := plugin.EventBatch{}, "The event source adapter is unavailable"
	limit := min(32, maxAutomationPending-source.Pending)
	if secretErr != nil {
		failure = "Event source credentials could not be read. Edit the automation to save them again"
	} else if adapter != nil {
		var err error
		batch, err = adapter.Poll(ctx, config, source.Cursor, limit)
		switch {
		case ctx.Err() != nil:
			failure = "The event source request timed out"
		case err != nil:
			failure = err.Error()
		default:
			failure = ""
		}
	}
	if failure == "" {
		if len(batch.Events) > limit || batch.Cursor == "" {
			failure = "The event source returned an invalid batch"
		}
		for _, event := range batch.Events {
			if event.Key == "" || len(event.Key) > 200 || len(event.Payload) > MaxAutomationEventBytes || !json.Valid(event.Payload) {
				failure = "The event source returned an invalid event"
				break
			}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ctx.Err() != nil {
		return nil
	}
	return a.Store.Write(a.ctx, func(tx *sql.Tx) error {
		current, err := store.Get[automationSourceSync](a.ctx, tx, automationSourceSelect+" AND a.id=?", source.ID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		// A result from an older mailbox or credential must not move the current cursor.
		if current.Source.PluginID != source.Source.PluginID || current.Source.ContributionID != source.Source.ContributionID ||
			!maps.Equal(current.Source.Config, source.Source.Config) || current.SecretID != source.SecretID || current.Cursor != source.Cursor {
			return nil
		}
		cursor := current.Cursor
		next := time.Now().Add(automationPollInterval)
		if failure == "" {
			cursor = batch.Cursor
			if batch.More {
				next = time.Now()
			}
			for _, event := range batch.Events {
				if _, err := tx.ExecContext(a.ctx, `INSERT INTO automation_events(automation_id,event_key,payload) VALUES(?,?,?)
ON CONFLICT(automation_id,event_key) DO NOTHING`, source.ID, event.Key, string(event.Payload)); err != nil {
					return err
				}
			}
		}
		if _, err := tx.ExecContext(a.ctx, "UPDATE automation_event_sources SET cursor=?,poll_at=?,error=? WHERE automation_id=?", cursor, next.Unix(), failure, source.ID); err != nil {
			return err
		}
		if (failure == "" && len(batch.Events) > 0) || failure != current.Error || (cursor != "" && current.Cursor == "") {
			return store.Event(tx, model.Event{Type: "automations"})
		}
		return nil
	})
}
