package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"lever/internal/model"
	"lever/internal/plugin"
	"lever/internal/plugin/builtin/imap-mail"
	"lever/internal/store"
)

type eventSourceStub func(context.Context, map[string]string, string, int) (plugin.EventBatch, error)

func (s eventSourceStub) Poll(ctx context.Context, config map[string]string, cursor string, limit int) (plugin.EventBatch, error) {
	return s(ctx, config, cursor, limit)
}

func TestAutomationEmailSourcePersistsEventsAndRedactsCredentials(t *testing.T) {
	a, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ctx := t.Context()
	connection, err := a.SaveProvider(ctx, ProviderInput{Provider: model.Provider{PluginID: "lever.codex", ContributionID: "codex", Type: "codex", Name: "Mail runtime", Enabled: true}})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := a.SaveAgent(ctx, model.Agent{Name: "Mail Agent", Profile: model.Profile{
		Provider: connection.ID, Scope: model.Scope{Roots: []model.Root{{Path: t.TempDir()}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	const secret = "fixture-email-password"
	input := func(host, password string) model.AutomationInput {
		return model.AutomationInput{
			Name: "New email", Prompt: "Review metadata.",
			Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
			Trigger: model.AutomationTrigger{Kind: "event", BatchSize: 2, Source: &model.AutomationEventSource{
				PluginID: imapmail.PluginID, ContributionID: imapmail.ContributionID,
				Config: map[string]string{"server": host, "username": "fixture", "password": password},
			}},
		}
	}
	saved, err := a.SaveAutomation(ctx, "", input("imap.example.invalid", secret))
	if err != nil {
		t.Fatal(err)
	}
	if saved.EventToken != "" || strings.Contains(store.JSON(saved), secret) ||
		!slices.Contains(saved.SourceSecrets, "password") || saved.Trigger.Source.Config["mailbox"] != "INBOX" {
		t.Fatal("event source settings did not apply the schema or redact credentials")
	}
	key := [2]string{imapmail.PluginID, imapmail.ContributionID}
	a.eventAdapters[key] = eventSourceStub(func(_ context.Context, values map[string]string, cursor string, _ int) (plugin.EventBatch, error) {
		if values["password"] != secret {
			t.Fatal("adapter did not receive its password")
		}
		if cursor == "" {
			return plugin.EventBatch{Cursor: "inbox:1"}, nil
		}
		return plugin.EventBatch{Cursor: "inbox:2", Events: []plugin.SourceEvent{
			{Key: "inbox:2", Payload: json.RawMessage(`{"subject":"New message"}`)},
		}}, nil
	})
	selectSource := automationSourceSelect + " AND a.id=?"
	for range 3 {
		source, err := store.Get[automationSourceSync](ctx, a.Store.DB, selectSource, saved.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := a.pollAutomationSource(source); err != nil {
			t.Fatal(err)
		}
	}
	current, err := getAutomation(ctx, a.Store.DB, saved.ID)
	if err != nil || !current.SourceReady || current.PendingEvents != 1 {
		t.Fatalf("a repeated poll changed the number of pending events: %d, %v", current.PendingEvents, err)
	}
	if edited, err := a.SaveAutomation(ctx, saved.ID, input("imap.example.invalid", "")); err != nil || edited.PendingEvents != 1 || !edited.SourceReady {
		t.Fatalf("editing an unchanged source reset the mailbox: %v", err)
	}
	if _, err := a.SaveAutomation(ctx, saved.ID, input("other.example.invalid", "")); err == nil {
		t.Fatal("allowed a new server to inherit previous credentials")
	}
	if err := a.UpdatePlugin(ctx, imapmail.PluginID, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get[automationSourceSync](ctx, a.Store.DB, selectSource, saved.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a disabled plugin was still eligible to poll: %v", err)
	}
}

func TestExternalStdioEventSourceLifecycle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	a, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ctx := t.Context()
	connection, err := a.SaveProvider(ctx, ProviderInput{Provider: model.Provider{
		PluginID: "lever.codex", ContributionID: "codex", Type: "codex", Name: "Runtime", Enabled: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	agent, err := a.SaveAgent(ctx, model.Agent{Name: "Watcher", Profile: model.Profile{
		Provider: connection.ID, Scope: model.Scope{Roots: []model.Root{{Path: t.TempDir()}}},
	}})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	manifest := model.PluginManifest{
		ManifestVersion: 1,
		ID:              "example.stdio-events",
		Name:            "Local Alerts",
		Version:         "1.0.0",
		Contributes: model.PluginContributions{
			EventSources: []model.EventSourceContribution{
				{
					ID: "feed", Name: "Feed", Driver: plugin.EventSourcePollDriver, Command: "bin/poll",
					Fields: []model.EventSourceField{
						{ID: "channel", Label: "Channel", Kind: "text", Required: true},
						{ID: "secret", Label: "Secret", Kind: "secret", Required: true},
					},
				},
				{
					ID: "heartbeat", Name: "Heartbeat", Driver: plugin.EventSourcePollDriver, Command: "bin/poll",
				},
			},
		},
	}
	writeManifest := func() {
		t.Helper()
		b, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, plugin.ManifestFile), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeManifest()
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
set -eu
input=$(cat)
printf '%s' "$input" > "$LEVER_EVENT_SOURCE_CACHE/last-request.json"
case "$input" in
  *'"source":"heartbeat"'*)
    printf '{"cursor":"hb-1","events":[]}\n'
    ;;
  *'"cursor":""'*)
    printf '{"cursor":"c1","events":[]}\n'
    ;;
  *'"secret":"top-secret"'*)
    printf '{"cursor":"c2","events":[{"key":"k1","payload":{\n  "title": "deploy"\n}}]}\n'
    ;;
  *)
    echo "missing secret" >&2
    exit 1
    ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "bin", "poll"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}

	// Installing an event source plugin without a package directory must be rejected.
	if _, err := a.InstallPlugin(ctx, manifest, ""); err == nil {
		t.Fatal("installed event source plugin without a package directory")
	}
	installed, err := a.InstallPlugin(ctx, model.PluginManifest{}, dir)
	if err != nil {
		t.Fatal(err)
	}

	const secret = "top-secret"
	feedPlan, err := a.SaveAutomation(ctx, "", model.AutomationInput{
		Name: "Feed Alerts", Prompt: "Handle feed.",
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Trigger: model.AutomationTrigger{Kind: "event", BatchSize: 2, Source: &model.AutomationEventSource{
			PluginID: installed.ID, ContributionID: "feed",
			Config: map[string]string{"channel": "prod", "secret": secret},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if feedPlan.EventToken != "" || strings.Contains(store.JSON(feedPlan), secret) || !slices.Contains(feedPlan.SourceSecrets, "secret") {
		t.Fatalf("credentials were not redacted: %+v", feedPlan)
	}
	selectSource := automationSourceSelect + " AND a.id=?"
	pollOnce := func(id string) {
		t.Helper()
		src, err := store.Get[automationSourceSync](ctx, a.Store.DB, selectSource, id)
		if err != nil {
			t.Fatal(err)
		}
		if err := a.pollAutomationSource(src); err != nil {
			t.Fatal(err)
		}
	}
	pollOnce(feedPlan.ID) // baseline -> cursor c1
	pollOnce(feedPlan.ID) // batch -> cursor c2 + 1 event
	pollOnce(feedPlan.ID) // duplicate k1 deduplicated
	current, err := getAutomation(ctx, a.Store.DB, feedPlan.ID)
	if err != nil || !current.SourceReady || current.PendingEvents != 1 || current.SourceError != "" {
		t.Fatalf("unexpected feed automation state: %+v, %v", current, err)
	}
	var payload string
	if err := a.Store.DB.QueryRowContext(ctx, "SELECT payload FROM automation_events WHERE automation_id=? AND event_key='k1'", feedPlan.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload != `{"title":"deploy"}` {
		t.Fatalf("event payload was not compacted: %q", payload)
	}
	cacheFile := filepath.Join(a.eventSourceCacheDir(installed.ID), "last-request.json")
	if _, err := os.Stat(cacheFile); err != nil {
		t.Fatalf("plugin did not receive writable LEVER_EVENT_SOURCE_CACHE: %v", err)
	}

	// Fieldless event source: editing unrelated fields must preserve cursor and SourceReady.
	hbPlan, err := a.SaveAutomation(ctx, "", model.AutomationInput{
		Name: "Heartbeat", Prompt: "Check pulse.",
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Trigger: model.AutomationTrigger{Kind: "event", BatchSize: 1, Source: &model.AutomationEventSource{
			PluginID: installed.ID, ContributionID: "heartbeat",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	pollOnce(hbPlan.ID)
	hbEdited, err := a.SaveAutomation(ctx, hbPlan.ID, model.AutomationInput{
		Name: "Heartbeat", Prompt: "Updated prompt.",
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Trigger: model.AutomationTrigger{Kind: "event", BatchSize: 1, Source: &model.AutomationEventSource{
			PluginID: installed.ID, ContributionID: "heartbeat",
		}},
	})
	if err != nil || !hbEdited.SourceReady {
		t.Fatalf("editing fieldless event source reset cursor: %+v, %v", hbEdited, err)
	}

	// Disable and re-enable: re-enable must reset poll_at to 0.
	if err := a.UpdatePlugin(ctx, installed.ID, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get[automationSourceSync](ctx, a.Store.DB, selectSource, feedPlan.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("disabled plugin still polled: %v", err)
	}
	if err := a.UpdatePlugin(ctx, installed.ID, true, false); err != nil {
		t.Fatal(err)
	}
	var pollAt int64
	if err := a.Store.DB.QueryRowContext(ctx, "SELECT poll_at FROM automation_event_sources WHERE automation_id=?", feedPlan.ID).Scan(&pollAt); err != nil || pollAt != 0 {
		t.Fatalf("re-enabling plugin did not reset poll_at: %d, %v", pollAt, err)
	}

	// Compatible reload succeeds; breaking reload removing an in-use event source is blocked.
	manifest.Version = "1.1.0"
	writeManifest()
	if reloaded, err := a.ReloadPlugin(ctx, installed.ID); err != nil || reloaded.Manifest.Version != "1.1.0" {
		t.Fatalf("compatible reload failed: %+v, %v", reloaded, err)
	}
	manifest.Contributes.EventSources = manifest.Contributes.EventSources[:1]
	writeManifest()
	if _, err := a.ReloadPlugin(ctx, installed.ID); err == nil {
		t.Fatal("allowed reload that removed an in-use event source")
	}

	// Uninstall cleans up cache dir and marks automations disabled without touching source files.
	if err := a.UpdatePlugin(ctx, installed.ID, false, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a.eventSourceCacheDir(installed.ID)); !os.IsNotExist(err) {
		t.Fatalf("uninstall left event source cache behind: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, plugin.ManifestFile)); err != nil {
		t.Fatalf("uninstall removed local source files: %v", err)
	}
	afterUninstall, err := getAutomation(ctx, a.Store.DB, feedPlan.ID)
	if err != nil || !afterUninstall.SourceDisabled {
		t.Fatalf("uninstalled plugin did not mark automation sourceDisabled: %+v, %v", afterUninstall, err)
	}
}
