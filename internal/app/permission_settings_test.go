package app

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"lever/internal/model"
)

func TestPermissionSetupFirstLaunchAndStarterSync(t *testing.T) {
	dir := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEVER_CODEX_PATH", executable)
	t.Setenv("LEVER_CLAUDE_PATH", executable)
	t.Setenv("LEVER_PI_PATH", executable)
	t.Setenv("LEVER_ANTIGRAVITY_PATH", executable)
	t.Setenv("LEVER_DSH_PATH", filepath.Join(dir, "missing-dsh"))

	ctx := t.Context()
	t.Run("fresh install prompts once and applies Auto or YOLO across runtimes", func(t *testing.T) {
		a := openForStarterAgentTest(t, dir)
		if _, err := a.ConnectLocalProviders(ctx); err != nil {
			t.Fatal(err)
		}
		if err := a.InitStarterAgent(); err != nil {
			t.Fatal(err)
		}
		ov, err := a.Overview(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !ov.PermissionSettings.NeedsSetup || ov.PermissionSettings.DefaultMode != model.DefaultPermissionAuto {
			t.Fatalf("unexpected initial permission settings: %+v", ov.PermissionSettings)
		}
		if len(ov.Agents) != 1 {
			t.Fatalf("expected starter agent, got %+v", ov.Agents)
		}
		starterBefore, err := agentDefaultSelection(ctx, a.Store.DB, ov.Agents[0])
		if err != nil {
			t.Fatal(err)
		}
		if starterBefore.Permission != "auto_review" {
			t.Fatalf("expected starter agent effective permission auto_review before setup, got %q", starterBefore.Permission)
		}

		// User chooses YOLO on first launch.
		saved, err := a.SavePermissionSettings(ctx, model.PermissionSettings{DefaultMode: model.DefaultPermissionYOLO})
		if err != nil {
			t.Fatal(err)
		}
		if saved.NeedsSetup || saved.DefaultMode != model.DefaultPermissionYOLO {
			t.Fatalf("unexpected saved settings: %+v", saved)
		}

		ov, err = a.Overview(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if ov.PermissionSettings.NeedsSetup || ov.PermissionSettings.DefaultMode != model.DefaultPermissionYOLO {
			t.Fatalf("overview did not reflect saved permission settings: %+v", ov.PermissionSettings)
		}
		starterAfter, err := agentDefaultSelection(ctx, a.Store.DB, ov.Agents[0])
		if err != nil {
			t.Fatal(err)
		}
		if starterAfter.Permission != "full_access" {
			t.Fatalf("starter agent effective permission = %q after YOLO setup, want full_access", starterAfter.Permission)
		}

		// New agents created under YOLO resolve to each runtime's full-access equivalent.
		for _, tc := range []struct {
			provider, want string
		}{
			{"codex", "full_access"},
			{"claude", "full_access"},
			{"pi", "full_access"},
			{"antigravity", "turbo"},
		} {
			created, err := a.SaveAgent(ctx, model.Agent{
				Name: "YOLO " + tc.provider,
				Profile: model.Profile{
					Scope:       model.Scope{Roots: []model.Root{{Path: "~"}}},
					Provider:    tc.provider,
					Skills:      []string{},
					Delegations: []model.DelegationRule{},
				},
			})
			if err != nil {
				t.Fatalf("create %s agent: %v", tc.provider, err)
			}
			sel, err := agentDefaultSelection(ctx, a.Store.DB, created)
			if err != nil {
				t.Fatalf("resolve %s agent default selection: %v", tc.provider, err)
			}
			if sel.Permission != tc.want {
				t.Fatalf("%s agent effective permission = %q, want %q", tc.provider, sel.Permission, tc.want)
			}
		}

		// Explicit per-agent permission stays intact when global settings change later.
		explicitAgent, err := a.SaveAgent(ctx, model.Agent{
			Name: "Pinned YOLO",
			Profile: model.Profile{
				Scope:       model.Scope{Roots: []model.Root{{Path: "~"}}},
				Provider:    "codex",
				Permission:  "full_access",
				Skills:      []string{},
				Delegations: []model.DelegationRule{},
			},
		})
		if err != nil {
			t.Fatal(err)
		}

		// Changing back to Auto in Settings leaves explicit agent pinned and switches default resolution to Auto.
		if _, err := a.SavePermissionSettings(ctx, model.PermissionSettings{DefaultMode: model.DefaultPermissionAuto}); err != nil {
			t.Fatal(err)
		}
		explicitSel, err := agentDefaultSelection(ctx, a.Store.DB, explicitAgent)
		if err != nil {
			t.Fatal(err)
		}
		if explicitSel.Permission != "full_access" {
			t.Fatalf("changing settings later must not override explicit agent permission: %+v", explicitSel)
		}
		for _, tc := range []struct {
			provider, want string
		}{
			{"codex", "auto_review"},
			{"claude", "auto"},
			{"pi", "accept_edits"},
			{"antigravity", "auto"},
		} {
			created, err := a.SaveAgent(ctx, model.Agent{
				Name: "Auto " + tc.provider,
				Profile: model.Profile{
					Scope:       model.Scope{Roots: []model.Root{{Path: "~"}}},
					Provider:    tc.provider,
					Skills:      []string{},
					Delegations: []model.DelegationRule{},
				},
			})
			if err != nil {
				t.Fatalf("create %s agent: %v", tc.provider, err)
			}
			sel, err := agentDefaultSelection(ctx, a.Store.DB, created)
			if err != nil {
				t.Fatalf("resolve %s agent default selection: %v", tc.provider, err)
			}
			if sel.Permission != tc.want {
				t.Fatalf("%s agent effective permission = %q, want %q", tc.provider, sel.Permission, tc.want)
			}
		}
	})

	// Reopening preserves the persisted setting and never re-prompts.
	a := openForStarterAgentTest(t, dir)
	ov, err := a.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if ov.PermissionSettings.NeedsSetup || ov.PermissionSettings.DefaultMode != model.DefaultPermissionAuto {
		t.Fatalf("reopened settings mismatch: %+v", ov.PermissionSettings)
	}
}

func TestPermissionSetupSkipsExistingDatabase(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "lever.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
	if err := errors.Join(err, db.Close()); err != nil {
		t.Fatal(err)
	}
	a := openForStarterAgentTest(t, dir)
	ov, err := a.Overview(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if ov.PermissionSettings.NeedsSetup || ov.PermissionSettings.DefaultMode != model.DefaultPermissionAuto {
		t.Fatalf("existing database should not trigger first-launch setup: %+v", ov.PermissionSettings)
	}
}
