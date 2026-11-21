package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
