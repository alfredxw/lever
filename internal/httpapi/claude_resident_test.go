package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestClaudeResidentProcessReuseAcrossTurns(t *testing.T) {
	type wire struct {
		Native       string
		PID          int
		Entrypoint   string
		Model        string
		Permission   string
		Instructions string
	}
	readWire := func(t *testing.T, run model.Run) wire {
		t.Helper()
		var got wire
		if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &got) != nil {
			t.Fatalf("unexpected wire receipt: %+v", run.Items)
		}
		return got
	}

	for _, tc := range []struct {
		mode string
		open func(string) (*app.App, error)
	}{
		{"embedded", app.Open},
		{"worker", app.OpenServer},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			f := openFixture(t, tc.open).withLocalProviders()
			agent := f.agent("claude")
			chat := f.chat(agent)

			send := func(text string, sel *model.Selection) (model.Run, wire) {
				t.Helper()
				var run model.Run
				f.request("POST", "/messages", model.SendInput{
					CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: text, Selection: sel,
				}, 200, &run)
				run = f.wait(run.ID, "completed")
				return run, readWire(t, run)
			}

			// Turn 1: cold start with CLAUDE_CODE_ENTRYPOINT=lever.
			_, w1 := send("[wire] turn 1", nil)
			if w1.Native == "" || w1.PID == 0 || w1.Entrypoint != "lever" {
				t.Fatalf("unexpected turn 1 wire: %+v", w1)
			}

			// Turn 2: identical selection reuses the exact same resident Claude PID.
			_, w2 := send("[wire] turn 2", nil)
			if w2.Native != w1.Native || w2.PID != w1.PID || w2.Entrypoint != "lever" {
				t.Fatalf("expected turn 2 to reuse resident PID %d (%s), got %+v", w1.PID, w1.Native, w2)
			}

			// Turn 3: permission mode change updates live via set_permission_mode without restarting.
			_, w3 := send("[wire] turn 3", &model.Selection{Provider: "claude", Permission: "plan"})
			if w3.Native != w1.Native || w3.PID != w1.PID || w3.Permission != "plan" {
				t.Fatalf("expected permission switch to reuse PID %d with plan mode, got %+v", w1.PID, w3)
			}

			// Turn 4: model change invalidates fingerprint and resumes on a fresh Claude process.
			_, w4 := send("[wire] turn 4", &model.Selection{Provider: "claude", Model: "claude-review", Permission: "plan"})
			if w4.Native != w1.Native || w4.PID == w1.PID || w4.Model != "claude-review" {
				t.Fatalf("expected model change to restart with --resume, got w1=%+v w4=%+v", w1, w4)
			}

			// Turn 5: next turn on the new model reuses the new resident PID.
			_, w5 := send("[wire] turn 5", nil)
			if w5.Native != w1.Native || w5.PID != w4.PID || w5.Model != "claude-review" {
				t.Fatalf("expected turn 5 to reuse PID %d, got %+v", w4.PID, w5)
			}

			// Turn 6: updating agent instructions invalidates fingerprint and restarts cleanly.
			agent.Profile.Instructions = "Updated instructions"
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			_, w6 := send("[wire] turn 6", nil)
			if w6.Native != w1.Native || w6.PID == w5.PID || w6.Instructions != "Updated instructions" {
				t.Fatalf("expected instruction update to restart Claude, got w5=%+v w6=%+v", w5, w6)
			}

			// Turn 7: switching the session to Codex must not be intercepted by an idle Claude worker.
			var handoff model.Run
			f.request("POST", "/messages", model.SendInput{
				CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] handoff to codex",
				Selection: &model.Selection{Provider: "codex"},
			}, 200, &handoff)
			handoff = f.wait(handoff.ID, "completed")
			if !strings.Contains(handoff.Items[0].Text, "handoff to codex") {
				t.Fatalf("codex handoff failed after resident claude session: %+v", handoff.Items)
			}
		})
	}
}

func TestClaudeEntrypointRespectsSettingsOverride(t *testing.T) {
	f := newFixture(t)
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(`{"env":{"CLAUDE_CODE_ENTRYPOINT":"custom-lever"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	config := model.Provider{
		Type:           "claude",
		PluginID:       "lever.claude",
		ContributionID: "claude",
		Name:           "Custom entrypoint",
		Enabled:        true,
		ConfigDir:      configDir,
	}
	f.request("POST", "/providers", config, 200, &config)
	chat := f.chat(f.agent(config.ID))
	run := f.wait(f.send(chat.ID, "main", "", "[wire] entrypoint check").ID, "completed")
	var got struct {
		Entrypoint string
	}
	if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &got) != nil {
		t.Fatalf("unexpected wire output: %+v", run.Items)
	}
	if got.Entrypoint != "custom-lever" {
		t.Fatalf("got entrypoint %q, want %q", got.Entrypoint, "custom-lever")
	}
}
