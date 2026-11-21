package app

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

func TestStarterAgentKeepsUserChangesOnReopen(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LEVER_CODEX_PATH", filepath.Join(dir, "missing-codex"))
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEVER_CLAUDE_PATH", executable)
	home, err := workspace.Canonical("~")
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	var edited model.Agent
	if !t.Run("initialize and customize", func(t *testing.T) {
		a := openForStarterAgentTest(t, dir)
		if err := a.InitStarterAgent(); err != nil {
			t.Fatal(err)
		}
		if _, err := a.UseLocalProvider(ctx, "lever.claude", "claude"); err != nil {
			t.Fatal(err)
		}
		state, err := a.Overview(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(state.Agents) != 1 || len(state.Chats) != 0 {
			t.Fatalf("got %d Agents and %d Chats", len(state.Agents), len(state.Chats))
		}
		agent := state.Agents[0]
		p := agent.Profile
		if agent.Name != "Lever" || agent.Archived || p.Provider != "claude" ||
			len(p.Roots) != 1 || p.Roots[0].ID != p.PrimaryRootID || p.Roots[0].Path != home {
			t.Fatalf("unexpected starter Agent: %+v", agent)
		}
		agent.Name = "My Agent"
		agent.Archived = true
		agent.Profile.Roots[0].Path = t.TempDir()
		edited, err = a.SaveAgent(ctx, agent)
		if err != nil {
			t.Fatal(err)
		}
	}) {
		return
	}
	a := openForStarterAgentTest(t, dir)
	if err := a.InitStarterAgent(); err != nil {
		t.Fatal(err)
	}
	state, err := a.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Agents) != 1 || store.JSON(state.Agents[0]) != store.JSON(edited) {
		t.Fatalf("expected the customized Agent, got %+v", state.Agents)
	}
}

func TestStarterAgentWaitsForFirstConnection(t *testing.T) {
	dir := t.TempDir()
	for _, runtime := range []string{"CODEX", "CLAUDE", "ANTIGRAVITY", "PI", "DSH"} {
		t.Setenv("LEVER_"+runtime+"_PATH", filepath.Join(dir, runtime))
	}
	a := openForStarterAgentTest(t, dir)
	if err := a.InitStarterAgent(); err != nil {
		t.Fatal(err)
	}
	state, err := a.Overview(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Agents) != 0 {
		t.Fatalf("unexpected Agent before connecting a runtime: %+v", state.Agents)
	}
}

func TestStarterAgentSkipsExistingEmptyDatabase(t *testing.T) {
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
	if err := a.InitStarterAgent(); err != nil {
		t.Fatal(err)
	}
	state, err := a.Overview(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Agents) != 0 {
		t.Fatalf("expected an empty Agent list, got %+v", state.Agents)
	}
}

func openForStarterAgentTest(t *testing.T, dir string) *App {
	t.Helper()
	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Close(); err != nil {
			t.Error(err)
		}
	})
	return a
}
