package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"lever/internal/model"
)

func TestSearchRanksAllRootsBeforeLimiting(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	write := func(root, path string) {
		t.Helper()
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 60 {
		write(first, fmt.Sprintf("a/%02d-composer-extra.ts", i))
	}
	write(first, "z/Composer.tsx")
	write(first, "z/ComposerInput.tsx")
	write(first, "docs/设计说明.md")
	write(first, "packages/@scope/file.ts")
	write(first, ".gitignore")
	if err := os.WriteFile(filepath.Join(first, ".gitignore"), []byte("ignored/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	write(first, "ignored/Composer.tsx")
	write(second, "Composer.tsx")
	write(second, "node_modules/Composer.tsx")
	if output, err := exec.Command("git", "-C", first, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %s: %v", output, err)
	}
	if err := os.Symlink(filepath.Join(second, "Composer.tsx"), filepath.Join(first, "linked-Composer.tsx")); err != nil {
		t.Fatal(err)
	}
	scope := model.Scope{Roots: []model.Root{{Path: first}, {Path: second}, {Path: filepath.Join(first, "z")}}}
	for _, query := range []string{"COMPOSER.TSX", "composer"} {
		matches, err := Search(context.Background(), scope, query)
		if err != nil || len(matches) < 2 || len(matches) > 40 {
			t.Fatalf("%q: %d matches, %v", query, len(matches), err)
		}
		if matches[0].Path != filepath.Join(second, "Composer.tsx") || matches[1].Path != filepath.Join(first, "z/Composer.tsx") {
			t.Fatalf("best filenames were lost behind earlier matches: %+v", matches[:2])
		}
		seen := map[string]bool{}
		for _, match := range matches {
			if seen[match.Path] || match.Name == "linked-Composer.tsx" || match.Name == "ignored/Composer.tsx" || match.Name == "node_modules/Composer.tsx" {
				t.Fatalf("invalid or duplicate match: %+v", match)
			}
			seen[match.Path] = true
		}
	}
	for query, want := range map[string]string{
		"cmpin":         "z/ComposerInput.tsx",
		"z\\cmpin":      "z/ComposerInput.tsx",
		"./z/ComposerI": "z/ComposerInput.tsx",
		"设说":            "docs/设计说明.md",
		"@scope/file":   "packages/@scope/file.ts",
	} {
		matches, err := Search(context.Background(), scope, query)
		if err != nil || len(matches) != 1 || matches[0].Name != want {
			t.Fatalf("%q: want %q, got %+v, %v", query, want, matches, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Search(ctx, scope, "composer"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled search: %v", err)
	}
}
