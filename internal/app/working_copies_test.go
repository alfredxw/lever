package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

func TestMigrateDirectoryGroupsKeepsSharedCheckoutAndSessionScope(t *testing.T) {
	ctx := context.Background()
	root, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source, target := filepath.Join(root, "repo"), filepath.Join(root, "checkout")
	oldNotes, newNotes := filepath.Join(root, "old-notes"), filepath.Join(root, "new-notes")
	for _, dir := range []string{source, oldNotes, newNotes} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", source}, args...)...)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
		return strings.TrimSpace(string(output))
	}
	git("init", "-q")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Initial")
	git("worktree", "add", "-qb", "legacy", target)
	common, err := workspace.GitDir(ctx, source)
	if err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(root, "data")
	s, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	open := true
	t.Cleanup(func() {
		if open {
			_ = s.Close()
		}
	})
	agent := model.Agent{ID: ID(), Name: "Migrated Agent", Profile: model.Profile{Scope: model.Scope{
		Roots: []model.Root{{ID: "repo", Path: source}, {ID: "notes", Path: newNotes}}, PrimaryRootID: "repo",
	}}}
	chat := model.Chat{ID: ID(), AgentID: agent.ID}
	ownerID, borrowerID := ID(), ID()
	session := model.Session{
		ID: ID(), ChatID: chat.ID, AgentID: agent.ID, Kind: "topic", WorkingCopyID: ownerID,
		Scope: model.Scope{Roots: []model.Root{{ID: "repo", Path: target}, {ID: "notes", Path: oldNotes}}, PrimaryRootID: "repo"},
	}
	execSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := s.DB.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	execSQL("INSERT INTO agents(id,data) VALUES(?,?)", agent.ID, store.JSON(agent))
	execSQL("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, agent.ID, store.JSON(chat))
	execSQL("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,?,?)", session.ID, chat.ID, session.Kind, store.JSON(session))
	checkout := model.CopyCheckout{Source: source, Path: target, GitDir: common, Branch: "legacy", Ready: true}
	for _, id := range []string{borrowerID, ownerID} {
		name := "Borrowed"
		if id == ownerID {
			checkout.Base = git("rev-parse", "HEAD")
			name = "Original group"
		}
		data := map[string]any{
			"id": id, "agentId": agent.ID, "name": name, "state": "ready",
			"checkouts": []model.CopyCheckout{checkout}, "roots": session.Roots, "primaryRootId": session.PrimaryRootID,
		}
		execSQL("INSERT INTO working_copies(id,agent_id,data) VALUES(?,?,?)", id, agent.ID, store.JSON(data))
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	open = false

	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	copies, err := a.WorkingCopies(ctx, agent.ID)
	if err != nil || len(copies) != 2 {
		t.Fatalf("groups: %+v, %v", copies, err)
	}
	if !slices.Equal(copies[0].WorktreeIDs, copies[1].WorktreeIDs) || len(copies[0].WorktreeIDs) != 1 {
		t.Fatalf("expected one shared checkout: %+v", copies)
	}
	checkouts, err := a.Worktrees(ctx, agent.ID)
	if err != nil || len(checkouts) != 1 || checkouts[0].Base == "" || checkouts[0].Path != target {
		t.Fatalf("expected an owned checkout at the original path: %+v, %v", checkouts, err)
	}
	future, err := a.selectGroup(ctx, a.Store.DB, agent, ownerID)
	if err != nil || future.Roots[0].Path != target || future.Roots[1].Path != newNotes {
		t.Fatalf("expected the current default notes in a new topic: %+v, %v", future.Scope, err)
	}
	if err := a.DeleteWorkingCopy(ctx, agent.ID, ownerID); err != nil {
		t.Fatal(err)
	}
	saved, err := store.Get[model.Session](ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", session.ID)
	if err != nil || saved.WorkingCopyID != ownerID || saved.WorkingCopyName != "Original group" {
		t.Fatalf("historical binding: %+v, %v", saved, err)
	}
	scope, _, err := a.UseScope(ctx, agent.ID, session.ID, "", false)
	if err != nil || !slices.Equal(scope.Roots, session.Roots) {
		t.Fatalf("historical scope: %+v, %v", scope, err)
	}
	if err := a.DeleteWorktree(ctx, agent.ID, checkouts[0].ID); err == nil || !strings.Contains(err.Error(), "Borrowed") {
		t.Fatalf("expected the other group's reference to protect the checkout, got %v", err)
	}
}
