package workspace

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestListGitIgnored(t *testing.T) {
	root := t.TempDir()
	for _, directory := range []string{"ignored", "partial/drop", "partial/keep/local-cache", "tracked-dir"} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for path, content := range map[string]string{
		".gitignore":              "/ignored/\n/partial/*\n!/partial/keep/\n/tracked-dir/\n*.log\n",
		"partial/keep/.gitignore": "/local-cache/\n",
		"tracked-dir/keep.txt":    "tracked",
		"tracked-dir/local.txt":   "ignored",
		"file1.log":               "tracked",
		"file[1].log":             "ignored",
	} {
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	check := func(scope, path string, want map[string]bool) {
		t.Helper()
		entries, err := List(context.Background(), scope, path)
		if err != nil {
			t.Fatal(err)
		}
		got := make(map[string]bool)
		for _, entry := range entries {
			got[entry.Name] = entry.GitIgnored
		}
		for name, ignored := range want {
			if value, ok := got[name]; !ok || value != ignored {
				t.Errorf("%s/%s: gitIgnored = %t, present = %t; want %t", path, name, value, ok, ignored)
			}
		}
	}
	check(root, ".", map[string]bool{"ignored": false, "file[1].log": false})
	for _, args := range [][]string{{"init", "-q"}, {"add", "-f", "tracked-dir/keep.txt", "file1.log"}} {
		if output, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
	}
	check(root, ".", map[string]bool{
		"ignored": true, "partial": false, "tracked-dir": false,
		"file1.log": false, "file[1].log": true,
	})
	check(root, "tracked-dir", map[string]bool{"keep.txt": false, "local.txt": true})
	check(root, "partial", map[string]bool{"drop": true, "keep": false})
	check(filepath.Join(root, "partial", "keep"), ".", map[string]bool{"local-cache": true})
}

func TestWriteFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "hello.sh")
	if err := os.WriteFile(path, []byte("echo original\r\n"), 0755); err != nil {
		t.Fatal(err)
	}
	original, err := Read(root, "hello.sh")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := Write(root, "hello.sh", "echo 中文\r\n", original.Version)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := Read(root, "hello.sh")
	if err != nil || actual != saved || saved.Version == original.Version {
		t.Fatalf("save: %+v, %v", actual, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0755 {
		t.Fatalf("permissions: %v, %v", info, err)
	}
	// A retry after a lost response is safe, but a stale different draft conflicts.
	if _, err = Write(root, "hello.sh", saved.Content, original.Version); err != nil {
		t.Fatal(err)
	}
	if _, err = Write(root, "hello.sh", "stale draft", original.Version); !errors.Is(err, ErrFileConflict) {
		t.Fatalf("stale write: %v", err)
	}
	if _, err = Write(root, "hello.sh", "", saved.Version); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) != 0 {
		t.Fatalf("empty file: %q, %v", data, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v, %v", entries, err)
	}
}

func TestWriteBoundaries(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "text"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	original, err := Read(root, "text")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "dirlink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../secret", outside, "link", "dirlink/secret", "directory", "missing"} {
		t.Run(path, func(t *testing.T) {
			if _, err := Write(root, path, "changed", original.Version); err == nil {
				t.Fatal("invalid target accepted")
			}
		})
	}
	for _, content := range []string{"nul\x00byte", string([]byte{0xff}), strings.Repeat("x", MaxFileBytes+1)} {
		if _, err := Write(root, "text", content, original.Version); !errors.Is(err, ErrInvalidFile) {
			t.Fatalf("invalid content: %v", err)
		}
	}
	if _, err := Write(root, "text", "changed", ""); !errors.Is(err, ErrInvalidFile) {
		t.Fatalf("missing version: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "text"))
	if err != nil || string(data) != "original" {
		t.Fatalf("original changed: %q, %v", data, err)
	}
	data, err = os.ReadFile(outside)
	if err != nil || string(data) != "outside" {
		t.Fatalf("scope escaped: %q, %v", data, err)
	}
	if err := os.Chmod(filepath.Join(root, "text"), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(root, "text", "changed", original.Version); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("read-only file: %v", err)
	}
}

func TestFileSizeAndConcurrentWrites(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "text")
	// The limit bisects a multibyte character; preview remains valid UTF-8.
	large := strings.Repeat("x", MaxFileBytes-1) + "中文"
	if err := os.WriteFile(path, []byte(large), 0600); err != nil {
		t.Fatal(err)
	}
	preview, err := Read(root, "text")
	if err != nil || !preview.Truncated || preview.Version != "" || len(preview.Content) != MaxFileBytes-1 {
		t.Fatalf("preview: length=%d truncated=%v version=%s err=%v", len(preview.Content), preview.Truncated, preview.Version, err)
	}
	if _, err := Write(root, "text", "short", "fake-version"); !errors.Is(err, ErrInvalidFile) {
		t.Fatalf("truncated write: %v", err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("x", MaxFileBytes)), 0600); err != nil {
		t.Fatal(err)
	}
	full, err := Read(root, "text")
	if err != nil || full.Truncated || full.Version == "" {
		t.Fatalf("exact limit: %v", err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, value := range []string{"first", "second"} {
		wg.Go(func() { _, err := Write(root, "text", value, full.Version); results <- err })
	}
	wg.Wait()
	close(results)
	succeeded, conflicts := 0, 0
	for err := range results {
		if err == nil {
			succeeded++
		} else if errors.Is(err, ErrFileConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if succeeded != 1 || conflicts != 1 {
		t.Fatalf("concurrent writes: %d succeeded, %d conflicted", succeeded, conflicts)
	}
}

func TestCreateEmptyEntries(t *testing.T) {
	root := t.TempDir()
	folder, err := Create(root, "notes", true)
	if err != nil || !folder.Directory || folder.Path != "notes" {
		t.Fatalf("create folder: %+v, %v", folder, err)
	}
	entry, err := Create(root, "notes/empty.md", false)
	if err != nil || entry.Directory || entry.Size != 0 {
		t.Fatalf("create file: %+v, %v", entry, err)
	}
	content, err := Read(root, entry.Path)
	if err != nil || content.Content != "" || content.Version == "" {
		t.Fatalf("new file cannot be edited: %+v, %v", content, err)
	}
	if _, err := Write(root, entry.Path, "preserve me", content.Version); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []bool{false, true} {
		for _, path := range []string{"notes", "notes/empty.md"} {
			if _, err := Create(root, path, directory); !errors.Is(err, os.ErrExist) {
				t.Fatalf("existing entry %s replaced: %v", path, err)
			}
		}
	}
	content, err = Read(root, entry.Path)
	if err != nil || content.Content != "preserve me" {
		t.Fatalf("existing content changed: %+v, %v", content, err)
	}
}

func TestCreateScopeBoundaries(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []bool{false, true} {
		for _, path := range []string{"", ".", "..", "../outside", "a/../outside", "a//b", "a\\b", "escape/new", filepath.Join(outside, "absolute"), "missing/child"} {
			if _, err := Create(root, path, directory); err == nil {
				t.Fatalf("invalid create accepted: %q, directory=%v", path, directory)
			}
		}
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("wrote outside scope: %v, %v", entries, err)
	}
	// Exclusive creation must also hold when clients race.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() { _, err := Create(root, "same", false); results <- err })
	}
	wg.Wait()
	close(results)
	succeeded, conflicts := 0, 0
	for err := range results {
		if err == nil {
			succeeded++
		} else if errors.Is(err, os.ErrExist) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if succeeded != 1 || conflicts != 1 {
		t.Fatalf("concurrent create: %d successes, %d conflicts", succeeded, conflicts)
	}
}
