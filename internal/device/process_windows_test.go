package device

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestExecutableUsesSavedWindowsPath(t *testing.T) {
	systemDir := filepath.Join(os.Getenv("SystemRoot"), "System32")
	isSystemDir := func(dir string) bool {
		return strings.EqualFold(filepath.Clean(strings.TrimSpace(dir)), filepath.Clean(systemDir))
	}
	if !slices.ContainsFunc(filepath.SplitList(savedWindowsPath()), isSystemDir) {
		t.Skip("System32 is absent from the saved Windows PATH")
	}

	inherited := t.TempDir()
	t.Setenv("PATH", inherited)
	t.Setenv("USERPROFILE", t.TempDir())
	path, err := Executable("where")
	want := filepath.Join(systemDir, "where.exe")
	if err != nil || !strings.EqualFold(path, want) {
		t.Fatalf("expected %q from the saved Windows PATH, got %q: %v", want, path, err)
	}

	for _, entry := range Command(path).Env {
		if value, ok := strings.CutPrefix(entry, "PATH="); ok {
			dirs := filepath.SplitList(value)
			index := slices.Index(dirs, inherited)
			if index < 0 || slices.IndexFunc(dirs, isSystemDir) <= index {
				t.Fatal("child PATH should search inherited entries before saved Windows entries")
			}
			return
		}
	}
	t.Fatal("child PATH is missing")
}
