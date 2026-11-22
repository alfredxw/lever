package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"lever/internal/model"
	"lever/internal/workspace"
)

func TestValidateEventSourceManifest(t *testing.T) {
	base := func() model.PluginManifest {
		return model.PluginManifest{
			ManifestVersion: 1,
			ID:              "example.events",
			Name:            "Example Events",
			Version:         "1.0.0",
			Contributes: model.PluginContributions{
				EventSources: []model.EventSourceContribution{{
					ID:      "feed",
					Name:    "Feed item",
					Driver:  EventSourcePollDriver,
					Command: "bin/poll",
					Fields: []model.EventSourceField{
						{ID: "url", Label: "Feed URL", Kind: "text", Required: true, Placeholder: "https://example.com/feed"},
						{ID: "token", Label: "API token", Kind: "secret", Required: true},
					},
				}},
			},
		}
	}
	if err := Validate(base()); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	combined := base()
	combined.Contributes.Providers = []model.ProviderContribution{{
		ID: "agent", Name: "Agent", Driver: "acp", Command: "bin/agent",
	}}
	if err := Validate(combined); err != nil {
		t.Fatalf("provider + event source manifest rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*model.PluginManifest)
	}{
		{"unsupported driver", func(m *model.PluginManifest) { m.Contributes.EventSources[0].Driver = "webhook-v1" }},
		{"escaping command", func(m *model.PluginManifest) { m.Contributes.EventSources[0].Command = "../outside" }},
		{"absolute command", func(m *model.PluginManifest) { m.Contributes.EventSources[0].Command = "/bin/echo" }},
		{"duplicate source id", func(m *model.PluginManifest) {
			m.Contributes.EventSources = append(m.Contributes.EventSources, m.Contributes.EventSources[0])
		}},
		{"duplicate field id", func(m *model.PluginManifest) {
			m.Contributes.EventSources[0].Fields = append(m.Contributes.EventSources[0].Fields, m.Contributes.EventSources[0].Fields[0])
		}},
		{"invalid field kind", func(m *model.PluginManifest) { m.Contributes.EventSources[0].Fields[0].Kind = "number" }},
		{"secret default", func(m *model.PluginManifest) { m.Contributes.EventSources[0].Fields[1].Default = "leaked" }},
		{"mixed channel", func(m *model.PluginManifest) {
			m.Contributes.Channels = []model.ChannelContribution{{ID: "ch", Name: "Channel", Driver: PersonalChannelDriver, Command: "bin/ch"}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := base()
			tc.mutate(&m)
			if err := Validate(m); err == nil {
				t.Fatalf("expected validation failure for %s", tc.name)
			}
		})
	}

	if runtime.GOOS != "windows" {
		dir, err := workspace.Canonical(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(base())
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ManifestFile), data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dir, "bin"), 0700); err != nil {
			t.Fatal(err)
		}
		pollPath := filepath.Join(dir, "bin", "poll")
		if err := os.WriteFile(pollPath, []byte("#!/bin/sh\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Read(dir); err == nil {
			t.Fatal("Read accepted non-executable event source command")
		}
		if err := os.Chmod(pollPath, 0700); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Read(dir); err != nil {
			t.Fatalf("Read rejected valid event source package: %v", err)
		}
	}
}

func TestStdioPollEventSource(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	dir, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cacheDir := filepath.Join(t.TempDir(), "cache")
	writeScript := func(name, body string) string {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
		return name
	}

	stdinFile := filepath.Join(t.TempDir(), "stdin.json")
	envFile := filepath.Join(t.TempDir(), "env.txt")
	cmd := writeScript("bin/ok", `
set -eu
cat > "$TEST_STDIN_FILE"
printf '%s\n%s\n%s\n' "$(pwd)" "$LEVER_PLUGIN_DIR" "$LEVER_EVENT_SOURCE_CACHE" > "$TEST_ENV_FILE"
printf '{"cursor":"c2","more":true,"events":[{"key":"e1","payload":{"hello":"world"}}]}\n'
`)
	t.Setenv("TEST_STDIN_FILE", stdinFile)
	t.Setenv("TEST_ENV_FILE", envFile)

	source := StdioPollEventSource{
		Directory:      dir,
		ContributionID: "feed",
		Command:        cmd,
		CacheDir:       cacheDir,
		AutomationID:   "auto-1",
	}
	batch, err := source.Poll(t.Context(), map[string]string{"url": "https://example.com", "token": "s3cr3t"}, "c1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if batch.Cursor != "c2" || !batch.More || len(batch.Events) != 1 || batch.Events[0].Key != "e1" || string(batch.Events[0].Payload) != `{"hello":"world"}` {
		t.Fatalf("unexpected batch: %+v", batch)
	}
	gotStdin, err := os.ReadFile(stdinFile)
	if err != nil {
		t.Fatal(err)
	}
	var req eventPollRequest
	if err := json.Unmarshal(gotStdin, &req); err != nil {
		t.Fatal(err)
	}
	if req.ProtocolVersion != 1 || req.Source != "feed" || req.AutomationID != "auto-1" ||
		req.Cursor != "c1" || req.Limit != 10 || req.Config["token"] != "s3cr3t" {
		t.Fatalf("unexpected stdin request: %+v", req)
	}
	gotEnv, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(gotEnv)), "\n")
	if len(lines) != 3 || lines[1] != dir || lines[2] != cacheDir {
		t.Fatalf("unexpected plugin env: %q", string(gotEnv))
	}
	if info, err := os.Stat(cacheDir); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("cache dir not created with 0700: %v, %v", info, err)
	}

	source.Command = writeScript("bin/fail", "echo '  token   expired\nretry soon  ' >&2\nexit 1\n")
	if _, err := source.Poll(t.Context(), nil, "", 5); err == nil || err.Error() != "token expired retry soon" {
		t.Fatalf("unexpected stderr error: %v", err)
	}

	source.Command = writeScript("bin/badjson", "printf 'not-json'\n")
	if _, err := source.Poll(t.Context(), nil, "", 5); err == nil || !strings.Contains(err.Error(), "invalid JSON") {
		t.Fatalf("expected invalid JSON error, got: %v", err)
	}

	source.Command = writeScript("bin/trailing", "printf '{\"cursor\":\"1\"}{\"cursor\":\"2\"}'\n")
	if _, err := source.Poll(t.Context(), nil, "", 5); err == nil || !strings.Contains(err.Error(), "single JSON object") {
		t.Fatalf("expected trailing JSON error, got: %v", err)
	}

	source.Command = writeScript("bin/huge", "dd if=/dev/zero bs=1024 count=1100 2>/dev/null | tr '\\0' 'a'\n")
	if _, err := source.Poll(t.Context(), nil, "", 5); err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("expected 1 MiB overflow error, got: %v", err)
	}

	source.Command = writeScript("bin/hang", "sleep 30\n")
	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()
	if _, err := source.Poll(ctx, nil, "", 5); err == nil || ctx.Err() == nil {
		t.Fatalf("expected timeout error, got: %v", err)
	}
}
