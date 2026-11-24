package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
	"lever/internal/store"
	"lever/internal/workspace"
)

func initTestGitRepo(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-q")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Initial")
	return git("rev-parse", "HEAD")
}

func openProjectTestApp(t *testing.T, dir string) *App {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEVER_CLAUDE_PATH", executable)
	a, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	if _, err := a.UseLocalProvider(t.Context(), "lever.claude", "claude"); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestProjectCRUDAndLinkedAgentSync(t *testing.T) {
	ctx := t.Context()
	root, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repoA := filepath.Join(root, "repo-a")
	repoB := filepath.Join(root, "repo-b")
	initTestGitRepo(t, repoA)
	if err := os.MkdirAll(repoB, 0700); err != nil {
		t.Fatal(err)
	}
	gitDirA, err := workspace.GitDir(ctx, repoA)
	if err != nil {
		t.Fatal(err)
	}

	a := openProjectTestApp(t, filepath.Join(root, "data"))

	proj, err := a.SaveProject(ctx, model.Project{
		Name: "Core Platform",
		Scope: model.Scope{
			Roots:         []model.Root{{ID: "r1", Path: repoA}},
			PrimaryRootID: "r1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if proj.ID == "" || proj.Name != "Core Platform" || len(proj.Roots) != 1 || proj.Roots[0].Path != repoA {
		t.Fatalf("unexpected project: %+v", proj)
	}

	// Create an Agent linked to the project: its scope must sync from the project.
	agent, err := a.SaveAgent(ctx, model.Agent{
		Name: "Backend",
		Profile: model.Profile{
			Provider:  "claude",
			ProjectID: proj.ID,
			Scope: model.Scope{
				Roots:         []model.Root{{ID: "ignored", Path: repoB}},
				PrimaryRootID: "ignored",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if agent.Profile.ProjectID != proj.ID || len(agent.Profile.Roots) != 1 || agent.Profile.Roots[0].Path != repoA {
		t.Fatalf("expected agent scope synced from project, got %+v", agent.Profile)
	}

	// Editing the project must atomically sync directories and worktreeSetup to linked Agents.
	stale := proj
	proj.Name = "Core Platform v2"
	proj.Roots = append(proj.Roots, model.Root{ID: "r2", Path: repoB})
	proj.WorktreeSetup = map[string]string{gitDirA: "go test ./..."}
	updated, err := a.SaveProject(ctx, proj)
	if err != nil {
		t.Fatal(err)
	}

	// Stale update must fail with 409 conflict.
	stale.Name = "Stale Name"
	if _, err := a.SaveProject(ctx, stale); err == nil {
		t.Fatal("expected optimistic lock conflict on stale project update")
	} else {
		var appErr *Error
		if !errors.As(err, &appErr) || appErr.Status != 409 {
			t.Fatalf("expected 409 conflict, got %v", err)
		}
	}

	findAgent := func(agents []model.Agent, id string) model.Agent {
		t.Helper()
		for _, item := range agents {
			if item.ID == id {
				return item
			}
		}
		t.Fatalf("agent %s not found in %+v", id, agents)
		return model.Agent{}
	}

	ov, err := a.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ov.Projects) != 1 || ov.Projects[0].Name != "Core Platform v2" {
		t.Fatalf("overview projects: %+v", ov.Projects)
	}
	synced := findAgent(ov.Agents, agent.ID)
	if len(synced.Profile.Roots) != 2 || synced.Profile.WorktreeSetup[gitDirA] != "go test ./..." {
		t.Fatalf("linked agent was not synced: %+v", synced)
	}

	// Deleting the project unlinks Agents while preserving their Scope snapshot.
	if err := a.DeleteProject(ctx, updated.ID); err != nil {
		t.Fatal(err)
	}
	ov, err = a.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ov.Projects) != 0 {
		t.Fatalf("expected 0 projects after delete, got %+v", ov.Projects)
	}
	unlinked := findAgent(ov.Agents, agent.ID)
	if unlinked.Profile.ProjectID != "" || len(unlinked.Profile.Roots) != 2 {
		t.Fatalf("expected unlinked agent keeping scope snapshot, got %+v", unlinked.Profile)
	}
}

func TestProjectSharedWorktreesAndDeleteGuard(t *testing.T) {
	ctx := t.Context()
	root, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "app")
	baseHash := initTestGitRepo(t, repo)

	a := openProjectTestApp(t, filepath.Join(root, "data"))
	proj, err := a.SaveProject(ctx, model.Project{
		Name: "App",
		Scope: model.Scope{
			Roots:         []model.Root{{ID: "app", Path: repo}},
			PrimaryRootID: "app",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	agent1, err := a.SaveAgent(ctx, model.Agent{
		Name:    "Builder",
		Profile: model.Profile{Provider: "claude", ProjectID: proj.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	agent2, err := a.SaveAgent(ctx, model.Agent{
		Name:    "Reviewer",
		Profile: model.Profile{Provider: "claude", ProjectID: proj.ID},
	})
	if err != nil {
		t.Fatal(err)
	}

	copyID := ID()
	group, err := a.SaveProjectWorkingCopy(ctx, proj.ID, "", model.CreateWorkingCopy{
		ID:    copyID,
		Name:  "Feature X",
		Scope: proj.Scope,
		Choices: []model.CopyChoice{
			{Source: repo, Base: baseHash},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if group.State != "ready" || len(group.WorktreeIDs) != 1 {
		t.Fatalf("unexpected group: %+v", group)
	}

	// Both linked Agents must see the shared project working copy.
	for _, ag := range []model.Agent{agent1, agent2} {
		copies, err := a.WorkingCopies(ctx, ag.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(copies) != 1 || copies[0].ID != group.ID {
			t.Fatalf("agent %s did not see shared project group: %+v", ag.Name, copies)
		}
	}

	// DeleteProject must be blocked while a managed worktree exists.
	if err := a.DeleteProject(ctx, proj.ID); err == nil {
		t.Fatal("expected DeleteProject to fail while managed worktree exists")
	} else {
		var appErr *Error
		if !errors.As(err, &appErr) || appErr.Status != 409 {
			t.Fatalf("expected 409 conflict, got %v", err)
		}
	}

	// Removing group + worktree allows DeleteProject to succeed.
	if err := a.DeleteProjectWorkingCopy(ctx, proj.ID, group.ID); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteProjectWorktree(ctx, proj.ID, group.WorktreeIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := a.DeleteProject(ctx, proj.ID); err != nil {
		t.Fatalf("expected DeleteProject to succeed after removing worktrees, got %v", err)
	}
}

func TestExistingStandaloneAgentsStayIndependent(t *testing.T) {
	ctx := context.Background()
	root, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "monorepo")
	initTestGitRepo(t, repo)

	dataDir := filepath.Join(root, "data")
	s, err := store.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	repoScope := model.Scope{Roots: []model.Root{{ID: "r1", Path: repo}}, PrimaryRootID: "r1"}
	agent := model.Agent{ID: ID(), Name: "Solo", Profile: model.Profile{Provider: "claude", Scope: repoScope}}
	if _, err := s.DB.ExecContext(ctx, "INSERT INTO agents(id,data) VALUES(?,?)", agent.ID, store.JSON(agent)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	a, err := Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	ov, err := a.Overview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ov.Projects) != 0 {
		t.Fatalf("expected opt-in projects only, got %+v", ov.Projects)
	}
	for _, ag := range ov.Agents {
		if ag.ID == agent.ID && ag.Profile.ProjectID != "" {
			t.Fatalf("expected standalone agent to remain independent, got projectId=%q", ag.Profile.ProjectID)
		}
	}
}
