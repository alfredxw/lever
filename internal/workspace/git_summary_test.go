package workspace_test

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"lever/internal/model"
	"lever/internal/workspace"
)

func TestGitSummaryReadOnlyAndEdgeCases(t *testing.T) {
	ctx := context.Background()
	nonRepo := t.TempDir()
	if _, err := workspace.GitSummary(ctx, model.Root{ID: "plain", Path: nonRepo}); !errors.Is(err, workspace.ErrNotRepository) {
		t.Fatalf("expected ErrNotRepository for non-git dir, got %v", err)
	}

	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
	}
	write := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	countObjects := func() int {
		t.Helper()
		count := 0
		_ = filepath.WalkDir(filepath.Join(root, ".git", "objects"), func(_ string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				count++
			}
			return nil
		})
		return count
	}

	// Unborn repository with staged, unstaged-over-staged, untracked text/binary/empty files.
	git(root, "init", "-q", "-b", "main")
	write("staged.txt", "line1\nline2\n")
	git(root, "add", "staged.txt")
	write("staged.txt", "line1\nline2\nline3")
	write("nested/new.txt", "alpha\nbeta\n")
	write("empty.txt", "")
	write("img.bin", "\x00\x01\x02\n\n")
	objectsBefore := countObjects()

	unborn, err := workspace.GitSummary(ctx, model.Root{ID: "r", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if unborn.Branch != "main" || unborn.Head != "" {
		t.Fatalf("unexpected unborn branch/head: %+v", unborn)
	}
	if unborn.Files != 4 || unborn.Additions != 5 || unborn.Deletions != 0 {
		t.Fatalf("unexpected unborn summary: %+v", unborn)
	}
	if after := countObjects(); after != objectsBefore {
		t.Fatalf("GitSummary wrote objects to .git/objects: before=%d after=%d", objectsBefore, after)
	}

	// Commit everything and verify clean state + RecentCommits timestamp.
	write(".gitignore", "ignored.log\n")
	git(root, "add", ".")
	git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial commit")

	commits, err := workspace.RecentCommits(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(commits) != 1 || commits[0].Subject != "initial commit" || commits[0].CommittedAt == "" {
		t.Fatalf("unexpected commits: %+v", commits)
	}
	if _, err := time.Parse(time.RFC3339, commits[0].CommittedAt); err != nil {
		t.Fatalf("invalid committedAt %q: %v", commits[0].CommittedAt, err)
	}

	clean, err := workspace.GitSummary(ctx, model.Root{ID: "r", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if clean.Branch != "main" || clean.Head == "" || clean.Files != 0 || clean.Additions != 0 || clean.Deletions != 0 {
		t.Fatalf("expected clean repo summary, got %+v", clean)
	}

	// Mix of rename, staged+unstaged modification, deletion, untracked dir, ignored file.
	write("staged.txt", "line1\nchanged\nline3\nline4\n")
	git(root, "add", "staged.txt")
	write("staged.txt", "line1\nchanged\nline3\nline4\nline5\n")
	git(root, "mv", "nested/new.txt", "nested/renamed.txt")
	write("nested/extra.txt", "one\ntwo")
	write("ignored.log", "should not count\n")
	if err := os.Remove(filepath.Join(root, "empty.txt")); err != nil {
		t.Fatal(err)
	}
	objectsBefore = countObjects()

	dirty, err := workspace.GitSummary(ctx, model.Root{ID: "r", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if dirty.Files != 4 {
		t.Fatalf("expected 4 changed files, got %+v", dirty)
	}
	if after := countObjects(); after != objectsBefore {
		t.Fatalf("GitSummary wrote objects to .git/objects on dirty repo: before=%d after=%d", objectsBefore, after)
	}

	// Verify subdirectory scope only counts files under nested/.
	nestedSummary, err := workspace.GitSummary(ctx, model.Root{ID: "nested", Path: filepath.Join(root, "nested")})
	if err != nil {
		t.Fatal(err)
	}
	if nestedSummary.Files != 2 || nestedSummary.Additions != 4 || nestedSummary.Deletions != 2 {
		t.Fatalf("unexpected nested scope summary: %+v", nestedSummary)
	}

	// Verify line counts agree with workspace.Diff working mode on root.
	workingDiff, err := workspace.Diff(ctx, root, "working", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var diffAdd, diffDel int
	for _, f := range workingDiff.Files {
		diffAdd += f.Additions
		diffDel += f.Deletions
	}
	if dirty.Additions != diffAdd || dirty.Deletions != diffDel {
		t.Fatalf("summary (+%d -%d) diverged from working diff (+%d -%d)", dirty.Additions, dirty.Deletions, diffAdd, diffDel)
	}

	// Verify upstream ahead/behind tracking.
	bare := t.TempDir()
	git(bare, "init", "--bare", "-q")
	git(root, "reset", "--hard", "-q", "HEAD")
	git(root, "clean", "-fdq")
	git(root, "remote", "add", "origin", bare)
	git(root, "push", "-qu", "origin", "main")
	write("ahead.txt", "ahead\n")
	git(root, "add", "ahead.txt")
	git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "ahead commit")

	aheadSummary, err := workspace.GitSummary(ctx, model.Root{ID: "r", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if aheadSummary.Upstream != "origin/main" || aheadSummary.Ahead != 1 || aheadSummary.Behind != 0 {
		t.Fatalf("unexpected upstream tracking: %+v", aheadSummary)
	}

	// Verify detached HEAD.
	git(root, "checkout", "--detach", "-q", "HEAD")
	detached, err := workspace.GitSummary(ctx, model.Root{ID: "r", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if detached.Branch != "" || detached.Head == "" {
		t.Fatalf("unexpected detached summary: %+v", detached)
	}

	// Verify large untracked file triggers Truncated without error.
	large := bytes.Repeat([]byte("a\n"), 600_000) // ~1.2 MiB > 1 MiB limit
	if err := os.WriteFile(filepath.Join(root, "huge.txt"), large, 0600); err != nil {
		t.Fatal(err)
	}
	trunc, err := workspace.GitSummary(ctx, model.Root{ID: "r", Path: root})
	if err != nil {
		t.Fatal(err)
	}
	if !trunc.Truncated || trunc.Files != 1 {
		t.Fatalf("expected truncated summary for >1MiB untracked file, got %+v", trunc)
	}
}
