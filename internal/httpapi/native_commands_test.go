package httpapi_test

import (
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func (f *fixture) sessionRuntime(id string) *model.SessionRuntime {
	f.t.Helper()
	var view model.SessionView
	f.request("GET", "/sessions/"+id, nil, 200, &view)
	return view.Session.Runtime
}

func TestCodexNativeGoalAndCompact(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	var catalog model.Catalog
	f.request("GET", "/providers/codex/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if !slices.ContainsFunc(catalog.Commands, func(c model.NativeCommand) bool { return c.Name == "goal" }) {
		t.Fatal(catalog.Commands)
	}
	query := f.wait(f.send(chat.ID, "main", "", "/goal").ID, "completed")
	var empty model.SessionView
	f.request("GET", "/sessions/"+query.SessionID, nil, 200, &empty)
	if empty.Session.NativeID != "" {
		t.Fatal("a status-only query bound a non-resumable empty thread")
	}
	run := f.wait(f.send(chat.ID, "main", "", "/goal verify the result").ID, "completed")
	state := f.sessionRuntime(run.SessionID)
	if run.NativeTurnID == nil || !strings.HasSuffix(*run.NativeTurnID, "-continuation") || run.TurnDiff != nil || state == nil || state.Goal == nil || *state.Goal != (model.SessionGoal{Objective: "verify the result", Status: "complete"}) ||
		state.Context == nil || *state.Context != (model.ContextUsage{Used: 710, Window: 10000}) {
		t.Fatalf("continuation: %+v, %+v", run, state)
	}
	status := f.wait(f.send(chat.ID, "main", "", "/goal").ID, "completed")
	if len(status.Items) != 1 || !strings.Contains(status.Items[0].Text, "verify the result") || status.NativeTurnID != nil {
		t.Fatal(status)
	}
	f.wait(f.send(chat.ID, "main", "", "/goal clear").ID, "completed")
	if f.sessionRuntime(run.SessionID).Goal != nil {
		t.Fatal("clear left a stale goal")
	}
	compacted := f.wait(f.send(chat.ID, "main", "", "/compact").ID, "completed")
	if compacted.NativeTurnID == nil || !strings.HasPrefix(*compacted.NativeTurnID, "compaction-") || f.sessionRuntime(run.SessionID).Context != nil {
		t.Fatal(compacted)
	}
}

func TestStopAndPauseNativeGoalBetweenTurns(t *testing.T) {
	for _, action := range []string{"stop", "pause"} {
		t.Run(action, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent("codex"))
			run := f.send(chat.ID, "main", "", "/goal wait for another turn")
			deadline := time.Now().Add(6 * time.Second)
			for {
				state := f.sessionRuntime(run.SessionID)
				if state != nil && state.Goal != nil && state.Goal.Status == "active" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("goal was never activated")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if action == "stop" {
				f.request("POST", "/runs/"+run.ID+"/stop", map[string]bool{}, 200, nil)
				f.wait(run.ID, "interrupted")
			} else {
				var steer model.Run
				f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "steer", Text: "/goal pause"}, 200, &steer)
				f.wait(steer.ID, "steered")
				f.wait(run.ID, "completed")
			}
			if g := f.sessionRuntime(run.SessionID).Goal; g == nil || g.Status != "paused" {
				t.Fatal(g)
			}
		})
	}
}

func TestClaudeNativeGoalAndLoop(t *testing.T) {
	t.Setenv("LEVER_FIXTURE_PLUGIN_COMMANDS", "1")
	f := newFixture(t)
	chat := f.chat(f.agent("claude"))
	var refs []model.Reference
	f.request("GET", "/chats/"+chat.ID+"/suggestions?provider=claude&kind=slash", nil, 200, &refs)
	if !slices.ContainsFunc(refs, func(r model.Reference) bool { return r.Kind == "command" && r.Name == "loop" }) ||
		!slices.ContainsFunc(refs, func(r model.Reference) bool { return r.Kind == "skill" && r.Name == "fixture-claude" }) {
		t.Fatal(refs)
	}
	if !slices.ContainsFunc(refs, func(r model.Reference) bool { return r.Kind == "command" && r.Name == "fixture-plugin:action" }) ||
		!slices.ContainsFunc(refs, func(r model.Reference) bool { return r.Kind == "skill" && r.Name == "fixture-plugin:skill" }) {
		t.Fatal(refs)
	}
	goal := f.wait(f.send(chat.ID, "main", "", "/goal finish").ID, "completed")
	if state := f.sessionRuntime(goal.SessionID); state == nil || state.Goal != nil || state.Context == nil || state.Context.Used != 2000 {
		t.Fatal(state)
	}
	loop := f.wait(f.send(chat.ID, "main", "", "/loop until done").ID, "completed")
	if !slices.ContainsFunc(loop.Items, func(i model.Item) bool { return i.Text == "The scheduled turn ran." }) {
		t.Fatal(loop.Items)
	}
	for _, action := range []string{"cancel", "stop"} {
		active := f.send(chat.ID, "main", "", "/loop fixed")
		f.wait(active.ID, "running")
		if action == "cancel" {
			var steer model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "steer", Text: "cancel the fixed loop"}, 200, &steer)
			f.wait(steer.ID, "steered")
			f.wait(active.ID, "completed")
		} else {
			f.request("POST", "/runs/"+active.ID+"/stop", map[string]bool{}, 200, nil)
			f.wait(active.ID, "interrupted")
		}
	}
}

func TestPiCompactAndACPSessionCommands(t *testing.T) {
	f := newFixture(t)
	pi := model.Agent{Name: "Pi", Profile: model.Profile{Provider: "pi", Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"}}}
	f.request("POST", "/agents", pi, 200, &pi)
	compacted := f.wait(f.send(f.chat(pi).ID, "main", "", "/compact keep paths").ID, "completed")
	if len(compacted.Items) != 1 || compacted.Items[0].Text != "Compacted: keep paths" {
		t.Fatal(compacted)
	}
	if state := f.sessionRuntime(compacted.SessionID); state == nil || state.Context == nil || state.Context.Window != 10000 {
		t.Fatal(state)
	}
	config := f.acpProvider("native-commands")
	chat := f.chat(f.acpAgent(config))
	var catalog model.Catalog
	f.request("GET", "/providers/"+config.ID+"/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
	if !slices.ContainsFunc(catalog.Commands, func(c model.NativeCommand) bool { return c.Name == "goal" && c.ArgumentHint == "objective" }) {
		t.Fatal(catalog.Commands)
	}
	run := f.wait(f.send(chat.ID, "main", "", "/goal count the files").ID, "completed")
	if r := acpReceipt(t, run); r["input"] != "/goal count the files" {
		t.Fatal(r["input"])
	}
	if state := f.sessionRuntime(run.SessionID); state == nil || state.Commands == nil || !slices.Equal(*state.Commands, catalog.Commands) {
		t.Fatal(state)
	}
	f.wait(f.send(chat.ID, "main", "", "/compact").ID, "completed")
	state := f.sessionRuntime(run.SessionID)
	if state.Commands == nil || len(*state.Commands) != 0 || state.Context == nil || state.Context.Used != 32 {
		t.Fatalf("ACP command revocation and context update: %+v", state)
	}
}

func TestFreshTopicHandoffAndClaudeCatalogCompact(t *testing.T) {
	f := newFixture(t)
	var claudeCatalog model.Catalog
	f.request("GET", "/providers/claude/models?cwd="+url.QueryEscape(f.root), nil, 200, &claudeCatalog)
	if !slices.ContainsFunc(claudeCatalog.Commands, func(c model.NativeCommand) bool {
		return c.Name == "compact" && c.ArgumentHint != ""
	}) {
		t.Fatalf("expected Claude catalog to advertise compact with argument hint, got %+v", claudeCatalog.Commands)
	}

	chat := f.chat(f.agent("claude"))
	first := f.wait(f.send(chat.ID, "main", "", "first decision: keep SQLite schema").ID, "completed")
	second := f.wait(f.send(chat.ID, "main", "", "second decision: expose context meter").ID, "completed")

	var handoffRun model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:            app.ID(),
		ChatID:               chat.ID,
		Operation:            "topic",
		HandoffFromSessionID: first.SessionID,
		Text:                 "continue implementation in fresh topic",
	}, 200, &handoffRun)
	handoffRun = f.wait(handoffRun.ID, "completed")
	if !handoffRun.Handoff || handoffRun.SessionID == first.SessionID {
		t.Fatalf("expected fresh topic handoff run, got %+v", handoffRun)
	}
	var view model.SessionView
	f.request("GET", "/sessions/"+handoffRun.SessionID, nil, 200, &view)
	if view.Session.HandoffFrom == nil ||
		view.Session.HandoffFrom.SessionID != first.SessionID ||
		view.Session.HandoffFrom.Kind != "main" ||
		view.Session.HandoffFrom.UpToSequence != second.Sequence ||
		view.Session.HandoffFrom.UpToRunID != second.ID {
		t.Fatalf("unexpected handoff metadata: %+v", view.Session.HandoffFrom)
	}
	history, err := os.ReadFile(filepath.Join(f.a.Store.Dir, "sessions", handoffRun.SessionID, "history-"+handoffRun.ID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(history)
	if !strings.Contains(content, "first decision: keep SQLite schema") || !strings.Contains(content, "second decision: expose context meter") {
		t.Fatalf("handoff JSONL missing upstream turns: %s", content)
	}

	// Later messages in the original session must not leak into the handoff topic if it switches providers.
	f.wait(f.send(chat.ID, "main", "", "unrelated later main turn").ID, "completed")
	var switched model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(),
		ChatID:    chat.ID,
		Operation: "reply",
		SessionID: handoffRun.SessionID,
		Text:      "follow up on codex",
		Selection: &model.Selection{Provider: "codex"},
	}, 200, &switched)
	switched = f.wait(switched.ID, "completed")
	switchedHistory, err := os.ReadFile(filepath.Join(f.a.Store.Dir, "sessions", handoffRun.SessionID, "history-"+switched.ID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(switchedHistory), "unrelated later main turn") ||
		!strings.Contains(string(switchedHistory), "continue implementation in fresh topic") {
		t.Fatalf("switched handoff history violated boundary: %s", string(switchedHistory))
	}
}
