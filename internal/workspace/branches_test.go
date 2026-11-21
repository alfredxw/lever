package workspace_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"lever/internal/model"
	"lever/internal/workspace"
)

func TestBranchChoicesFollowRepositoryAndHEAD(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		if output, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, output, err)
		}
	}
	read := func(path string) model.GitBranches {
		t.Helper()
		branches, err := workspace.Branches(context.Background(), path)
		if err != nil {
			t.Fatal(err)
		}
		return branches
	}
	git("init", "-q", "-b", "trunk")
	empty := read(root)
	if len(empty.Branches) != 0 || empty.Current != "" || empty.DefaultBase != "" {
		t.Fatalf("unborn repository has selectable refs: %+v", empty)
	}
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "file.txt"), []byte("initial\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial")
	git("checkout", "-qb", "feature")
	git("update-ref", "refs/remotes/origin/trunk", "HEAD")
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
	branches := read(nested)
	if branches.Current != "refs/heads/feature" || branches.DefaultBase != "refs/remotes/origin/trunk" || len(branches.Branches) != 3 {
		t.Fatalf("incorrect branch choices for nested scope: %+v", branches)
	}
	for _, branch := range branches.Branches {
		if branch.Ref == "refs/remotes/origin/HEAD" || branch.Name == "" {
			t.Fatalf("invalid branch choice: %+v", branch)
		}
	}
	git("checkout", "--detach", "-q", "HEAD")
	branches = read(nested)
	if branches.Current != "HEAD" || len(branches.Branches) != 4 || branches.Branches[3].Ref != "HEAD" {
		t.Fatalf("detached HEAD is not selectable: %+v", branches)
	}
}
