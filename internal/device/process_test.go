package device

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestExecutableUsesChildEnvironment(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LEVER_CODEX_PATH", "")
	name := "codex"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	install := func(dir string) string {
		t.Helper()
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("fixture"), 0700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	old := install(filepath.Join(home, "old-node", "bin"))
	current := install(filepath.Join(home, ".local", "bin"))
	t.Setenv("PATH", filepath.Dir(old))
	if got, err := Executable("codex"); err != nil || got != current {
		t.Fatalf("expected user installation %q, got %q: %v", current, got, err)
	}
	t.Setenv("LEVER_CODEX_PATH", old)
	if got, err := Executable("codex"); err != nil || got != old {
		t.Fatalf("explicit runtime path was ignored: %q, %v", got, err)
	}
	t.Setenv("LEVER_CODEX_PATH", filepath.Join(home, "missing"))
	if _, err := Executable("codex"); err == nil {
		t.Fatal("invalid override silently fell back to another runtime")
	}
}
