package workspace

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestCodexPatchSectionsPreserveContentsAndPaths(t *testing.T) {
	rename := "diff --git a/旧 name b/new name\n--- a/旧 name\n+++ b/new name\n@@ -1 +1 @@\n--- old\n+++ new\n"
	deleted := "diff --git a/nested/file b/nested/file\ndeleted file mode 100644\n--- a/nested/file\n+++ /dev/null\n@@ -1 +0,0 @@\n-content\n\\ No newline at end of file\n"
	empty := "diff --git a/empty b/file b/empty b/file\nnew file mode 100644\nindex 0000000..e69de29\n"
	patch := rename + deleted + empty
	want := []model.DiffFile{
		{Path: "new name", Status: "R", Additions: 1, Deletions: 1},
		{Path: "nested/file", Status: "D", Deletions: 1},
		{Path: "empty b/file", Status: "A"},
	}
	for path, body := range map[string]string{"": patch, "new name": rename, "nested/file": deleted, "empty b/file": empty} {
		got, err := CodexTurnDiff(patch, path)
		if err != nil || !slices.Equal(got.Files, want) || got.Patch != body {
			t.Fatalf("path %q: %+v, %v", path, got, err)
		}
	}
}

func TestLargeCodexPatchCanBeReadOneFileAtATime(t *testing.T) {
	var patch strings.Builder
	for i := range 51 {
		fmt.Fprintf(&patch, "diff --git a/%[1]d b/%[1]d\n--- a/%[1]d\n+++ b/%[1]d\n@@ -1 +1 @@\n-old\n+new\n", i)
	}
	summary, err := CodexTurnDiff(patch.String(), "")
	if err != nil || !summary.SingleFile || len(summary.Files) != 51 || summary.Patch != "" {
		t.Fatal(summary, err)
	}
	file, err := CodexTurnDiff(patch.String(), "50")
	if err != nil || !strings.HasPrefix(file.Patch, "diff --git a/50 b/50\n") || strings.Count(file.Patch, "diff --git ") != 1 {
		t.Fatal(file.Patch, err)
	}
}
