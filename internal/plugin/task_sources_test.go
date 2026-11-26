package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"lever/internal/model"
	"lever/internal/workspace"
)

func TestValidateTaskSourceManifest(t *testing.T) {
	base := func() model.PluginManifest {
		return model.PluginManifest{
			ManifestVersion: 1,
			ID:              "inhouse.meego",
			Name:            "Meego",
			Version:         "0.1.0",
			Contributes: model.PluginContributions{
				TaskSources: []model.TaskSourceContribution{{
					ID:            "meego",
					Name:          "Meego",
					Driver:        TaskSourceStdioDriver,
					Command:       "bin/bridge",
					MultiInstance: true,
					CustomName:    true,
				}},
			},
		}
	}
	if err := Validate(base()); err != nil {
		t.Fatalf("valid task source manifest rejected: %v", err)
	}
	combined := base()
	combined.Contributes.EventSources = []model.EventSourceContribution{{
		ID: "feed", Name: "Feed", Driver: EventSourcePollDriver, Command: "bin/poll",
	}}
	if err := Validate(combined); err != nil {
		t.Fatalf("task source + event source manifest rejected: %v", err)
	}

	cases := []struct {
		name   string
		mutate func(*model.PluginManifest)
	}{
		{"unsupported driver", func(m *model.PluginManifest) { m.Contributes.TaskSources[0].Driver = "http-v1" }},
		{"missing command", func(m *model.PluginManifest) { m.Contributes.TaskSources[0].Command = "" }},
		{"escaping command", func(m *model.PluginManifest) { m.Contributes.TaskSources[0].Command = "../outside" }},
		{"absolute command", func(m *model.PluginManifest) { m.Contributes.TaskSources[0].Command = "/bin/echo" }},
		{"duplicate id", func(m *model.PluginManifest) {
			m.Contributes.TaskSources = append(m.Contributes.TaskSources, m.Contributes.TaskSources[0])
		}},
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
		bridgePath := filepath.Join(dir, "bin", "bridge")
		if err := os.WriteFile(bridgePath, []byte("#!/bin/sh\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Read(dir); err == nil {
			t.Fatal("Read accepted non-executable task source command")
		}
		if err := os.Chmod(bridgePath, 0700); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Read(dir); err != nil {
			t.Fatalf("Read rejected valid task source package: %v", err)
		}
	}
}

func TestStdioTaskSourceInspectPreviewPullAndErrors(t *testing.T) {
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
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0700); err != nil {
			t.Fatal(err)
		}
		return name
	}

	okCmd := writeScript("ok.sh", `
input="$(cat)"
test -n "$LEVER_PLUGIN_DIR" || exit 2
test -n "$LEVER_TASK_SOURCE_CACHE" || exit 3
case "$input" in
  *'"action":"inspect"'*)
    printf '{"ready":true,"canSave":true,"suggestedName":"My Meego","summary":"My Todo","config":{"mode":"todo"},"fields":[{"key":"mode","label":"Mode","kind":"toggle"}]}'
    ;;
  *'"action":"preview"'*)
    printf '{"asOf":1700000000000,"total":1,"limit":200,"items":[{"externalId":"p:1","title":"Fix bug","badge":"P0","badgeTone":"danger"}]}'
    ;;
  *'"action":"pull"'*)
    printf '{"summary":"My Todo","items":[{"externalId":"p:1","reference":"#1","kind":"issue","state":"open","title":"Fix bug","url":"https://example.invalid/1","body":"Body"}],"visibleIds":["p:1"]}'
    ;;
  *)
    echo "unexpected action" >&2
    exit 1
    ;;
esac
`)

	src := StdioTaskSource{
		Directory:      dir,
		ContributionID: "meego",
		Command:        okCmd,
		CacheDir:       cacheDir,
		SourceID:       "src-1",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	inspected, err := src.Inspect(ctx, model.TaskSourceInspectRequest{Config: json.RawMessage(`{"mode":"todo"}`)})
	if err != nil || !inspected.Ready || !inspected.CanSave || inspected.SuggestedName != "My Meego" {
		t.Fatalf("unexpected inspect result: %+v, err=%v", inspected, err)
	}

	preview, err := src.Preview(ctx, model.TaskSourcePreviewRequest{Config: json.RawMessage(`{"mode":"todo"}`)})
	if err != nil || preview.Total != 1 || len(preview.Items) != 1 || preview.Items[0].ExternalID != "p:1" {
		t.Fatalf("unexpected preview result: %+v, err=%v", preview, err)
	}

	batch, err := src.Pull(ctx, TaskSourceTarget{ID: "t1", Config: json.RawMessage(`{"mode":"todo"}`)}, "", nil)
	if err != nil || len(batch.Items) != 1 || batch.Items[0].Kind != "issue" || len(batch.VisibleIDs) != 1 {
		t.Fatalf("unexpected pull result: %+v, err=%v", batch, err)
	}

	errCmd := writeScript("err.sh", `
printf '{"error":{"code":"rateLimit","status":429,"message":"slow down","retryAt":1900000000}}' >&2
exit 1
`)
	errSrc := src
	errSrc.Command = errCmd
	_, err = errSrc.Pull(ctx, TaskSourceTarget{ID: "t1"}, "", nil)
	var tsErr *TaskSourceError
	if !errors.As(err, &tsErr) || tsErr.Code != "rateLimit" || tsErr.Status != 429 || !strings.Contains(tsErr.Message, "slow down") || tsErr.RetryAt.Unix() != 1900000000 {
		t.Fatalf("expected structured TaskSourceError, got %#v (%v)", tsErr, err)
	}
}
