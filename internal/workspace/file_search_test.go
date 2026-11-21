package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestSearchFilesScopesAndText(t *testing.T) {
	root, ordinary, outside := t.TempDir(), t.TempDir(), t.TempDir()
	write := func(dir, path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, path), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(root, "docs/notes.md", "Heading\r\n中文😀 Needle.* here\r\nneedle.* again\n")
	write(root, ".gitignore", "ignored/\n")
	write(root, "ignored/private.md", "Needle.*")
	write(root, "binary", "\x00Needle.*")
	write(root, "invalid", "\xffNeedle.*")
	write(root, "large", "Needle.*"+strings.Repeat("x", MaxFileBytes))
	write(ordinary, "plain.txt", "Needle.* outside Git")
	write(ordinary, "node_modules/dependency.txt", "Needle.*")
	write(outside, "secret.txt", "Needle.* secret")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape-dir")); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %s: %v", output, err)
	}
	profile := model.Scope{Roots: []model.Root{{ID: "git", Path: root}, {ID: "plain", Path: ordinary}, {ID: "overlap", Path: filepath.Join(root, "docs")}}}
	result, err := SearchFiles(context.Background(), profile, "needle.*", true)
	if err != nil || result.Truncated || len(result.Matches) != 3 {
		t.Fatalf("search: %+v, %v", result, err)
	}
	first := result.Matches[0]
	if first.RootID != "git" || first.Path != "docs/notes.md" || first.Line != 2 || first.Column != 6 || first.EndColumn != 14 || first.Text != "中文😀 Needle.* here" {
		t.Fatalf("wrong UTF-16 location: %+v", first)
	}
	if result.Matches[2].RootID != "plain" {
		t.Fatalf("ordinary scope missing: %+v", result)
	}
	paths, err := SearchFiles(context.Background(), profile, "NOTES.MD", false)
	if err != nil || len(paths.Matches) != 1 || paths.Matches[0].Line != 0 {
		t.Fatalf("filename search: %+v, %v", paths, err)
	}
	// Filename filtering must not accidentally become content search.
	paths, err = SearchFiles(context.Background(), profile, "needle.*", false)
	if err != nil || len(paths.Matches) != 0 {
		t.Fatalf("path/content modes crossed: %+v, %v", paths, err)
	}
}

func TestSearchFilesBoundsAndCancellation(t *testing.T) {
	root := t.TempDir()
	profile := model.Scope{Roots: []model.Root{{ID: "root", Path: root}}}
	path := filepath.Join(root, "long.txt")
	if err := os.WriteFile(path, []byte(strings.Repeat("文", 500)+"FIND"+strings.Repeat("字", 500)), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := SearchFiles(context.Background(), profile, "find", true)
	if err != nil || len(result.Matches) != 1 || result.Matches[0].Column != 501 || len([]rune(result.Matches[0].Text)) > 206 {
		t.Fatalf("long line: %+v, %v", result, err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("find\n", 201)), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = SearchFiles(context.Background(), profile, "find", true)
	if err != nil || !result.Truncated || len(result.Matches) != 200 {
		t.Fatalf("unbounded result: %d, %v, %v", len(result.Matches), result.Truncated, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := SearchFiles(ctx, profile, "find", true); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled search: %v", err)
	}
	if _, err := SearchFiles(context.Background(), profile, "\xff", true); err == nil {
		t.Fatal("invalid UTF-8 query accepted")
	}
}
