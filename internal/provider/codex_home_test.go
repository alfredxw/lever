package provider

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"lever/internal/device"
	"lever/internal/model"
)

func TestCodexShadowHomeSeparatesLoginAndSharesSessions(t *testing.T) {
	shared, shadow := t.TempDir(), t.TempDir()
	if runtime.GOOS == "windows" {
		if err := os.Symlink(shared, filepath.Join(t.TempDir(), "link")); err != nil {
			t.Skip("Windows account cannot create symbolic links")
		}
	}
	config := model.Provider{Type: "codex", ConfigDir: shared, ShadowHome: shadow}
	t.Setenv("CODEX_SQLITE_HOME", "")
	t.Setenv("OPENAI_API_KEY", "host-key")
	for range 2 {
		cmd := device.Command("codex")
		if err := applyProfile(cmd, config); err != nil {
			t.Fatal(err)
		}
		env := cmd.Environ()
		if !slices.Contains(env, "CODEX_HOME="+shadow) || !slices.Contains(env, "CODEX_SQLITE_HOME="+shared) || slices.Contains(env, "OPENAI_API_KEY=host-key") {
			t.Fatal("unexpected shadow profile environment")
		}
	}
	src, _ := os.Stat(filepath.Join(shared, "sessions"))
	dst, err := os.Stat(filepath.Join(shadow, "sessions"))
	if err != nil || !os.SameFile(src, dst) {
		t.Fatal("sessions not shared")
	}
	// Never follow or replace a private login belonging to the shared account.
	secret := filepath.Join(shared, "auth.json")
	if err := os.WriteFile(secret, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(shadow, "auth.json")); err != nil {
		t.Fatal(err)
	}
	if err := applyProfile(device.Command("codex"), config); err == nil {
		t.Fatal("accepted a linked login")
	}
}
