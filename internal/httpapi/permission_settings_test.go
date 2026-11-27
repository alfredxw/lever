package httpapi_test

import (
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestPermissionSettingsAPIAndCatalogDefaults(t *testing.T) {
	f := newFixture(t)

	// Fresh database starts with Auto and needsSetup=true in both overview and settings endpoint.
	var ov model.Overview
	f.request("GET", "/overview", nil, 200, &ov)
	if ov.PermissionSettings.DefaultMode != model.DefaultPermissionAuto || !ov.PermissionSettings.NeedsSetup {
		t.Fatalf("unexpected initial overview permissionSettings: %+v", ov.PermissionSettings)
	}
	var current model.PermissionSettings
	f.request("GET", "/settings/permissions", nil, 200, &current)
	if current.DefaultMode != model.DefaultPermissionAuto || !current.NeedsSetup {
		t.Fatalf("unexpected initial GET /settings/permissions: %+v", current)
	}

	// Reject invalid default mode.
	f.request("PUT", "/settings/permissions", map[string]string{"defaultMode": "invalid"}, 400, nil)

	// Catalog defaults under Auto mode.
	assertCatalogDefault := func(providerID, want string) {
		t.Helper()
		var cat model.Catalog
		f.request("GET", "/providers/"+providerID+"/models", nil, 200, &cat)
		if cat.DefaultPermission != want {
			t.Fatalf("%s catalog defaultPermission = %q, want %q (permissions=%+v)", providerID, cat.DefaultPermission, want, cat.Permissions)
		}
	}
	assertCatalogDefault("codex", "auto_review")
	assertCatalogDefault("claude", "auto")
	assertCatalogDefault("pi", "accept_edits")

	// Switch to YOLO via HTTP API; needsSetup clears and cached catalogs immediately flip to YOLO equivalents.
	var saved model.PermissionSettings
	f.request("PUT", "/settings/permissions", model.PermissionSettings{DefaultMode: model.DefaultPermissionYOLO}, 200, &saved)
	if saved.DefaultMode != model.DefaultPermissionYOLO || saved.NeedsSetup {
		t.Fatalf("unexpected saved YOLO settings: %+v", saved)
	}
	ov = model.Overview{}
	f.request("GET", "/overview", nil, 200, &ov)
	if ov.PermissionSettings.DefaultMode != model.DefaultPermissionYOLO || ov.PermissionSettings.NeedsSetup {
		t.Fatalf("unexpected overview after saving YOLO: %+v", ov.PermissionSettings)
	}

	// Cached catalogs reflect YOLO without requiring refresh=true.
	assertCatalogDefault("codex", "full_access")
	assertCatalogDefault("claude", "full_access")
	assertCatalogDefault("pi", "full_access")

	// Creating an agent with omitted permission under YOLO runs with full_access and switches providers under YOLO.
	var yoloAgent model.Agent
	f.request("POST", "/agents", model.Agent{
		Name: "YOLO Codex",
		Profile: model.Profile{
			Provider:    "codex",
			Scope:       model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"},
			Skills:      []string{},
			Delegations: []model.DelegationRule{},
		},
	}, 200, &yoloAgent)

	chat := f.chat(yoloAgent)
	firstRun := f.wait(f.send(chat.ID, "main", "", "hello under yolo").ID, "completed")
	if firstRun.Selection.Permission != "full_access" {
		t.Fatalf("expected new codex session under YOLO to resolve full_access, got %q", firstRun.Selection.Permission)
	}

	var switched model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(),
		ChatID:    chat.ID,
		Operation: "main",
		Text:      "hello after provider switch",
		Selection: &model.Selection{Provider: "claude", Model: "claude-sonnet-4-6"},
	}, 200, &switched)
	switched = f.wait(switched.ID, "completed")
	if switched.Selection.Permission != "full_access" {
		t.Fatalf("expected provider switch to claude under YOLO to resolve full_access, got %q", switched.Selection.Permission)
	}

	// Flipping back to Auto restores Auto catalog defaults immediately and applies to new sessions inheriting global defaults.
	f.request("PUT", "/settings/permissions", model.PermissionSettings{DefaultMode: model.DefaultPermissionAuto}, 200, &saved)
	if saved.DefaultMode != model.DefaultPermissionAuto || saved.NeedsSetup {
		t.Fatalf("unexpected saved Auto settings: %+v", saved)
	}
	assertCatalogDefault("codex", "auto_review")
	assertCatalogDefault("claude", "auto")
	assertCatalogDefault("pi", "accept_edits")

	autoChat := f.chat(yoloAgent)
	autoRun := f.wait(f.send(autoChat.ID, "main", "", "hello under auto").ID, "completed")
	if autoRun.Selection.Permission != "auto_review" {
		t.Fatalf("expected new codex session after switching back to Auto to resolve auto_review, got %q", autoRun.Selection.Permission)
	}
}
