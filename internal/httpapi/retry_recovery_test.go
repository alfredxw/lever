package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/provider"
)

func TestRetryWithoutOutputReplacesInPlacePreservingSession(t *testing.T) {
	f := newFixture(t)
	agent := f.acpAgent(f.acpProvider("retry-acp"))
	chat := f.chat(agent)

	// 1. First turn fails before producing output while already bound to a native session.
	first := f.wait(f.send(chat.ID, "main", "", "[fail-before-output-once] first prompt").ID, "failed")
	if len(first.Items) != 0 {
		t.Fatalf("expected no items on pre-output failure: %+v", first.Items)
	}
	nativeBefore := f.waitNative(first.SessionID).NativeID
	if nativeBefore == "" {
		t.Fatal("expected ACP native session binding before prompt failure")
	}

	// Queue a dependent run waiting on the failed turn so we verify dependency repointing.
	other := f.chat(f.agent("codex"))
	var waiter model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: other.ID, Operation: "main", Text: "wait for retry",
		Delivery: "queue", AfterRunIDs: []string{first.ID},
	}, 409, nil) // Cannot wait on a failed run directly; verify with active turn below.

	cmdID := app.ID()
	var retried model.Run
	f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": cmdID}, 200, &retried)
	retried = f.wait(retried.ID, "completed")
	if retried.ID == first.ID {
		t.Fatalf("pre-output retry should replace with a fresh run ID: %+v", retried)
	}
	if retried.Sequence != first.Sequence || retried.Handoff {
		t.Fatalf("in-place retry changed sequence or triggered handoff: first=%+v retried=%+v", first, retried)
	}
	if gotNative := f.waitNative(first.SessionID).NativeID; gotNative != nativeBefore {
		t.Fatalf("in-place retry dropped native session: got %q, want %q", gotNative, nativeBefore)
	}
	var history model.SessionRuns
	f.request("GET", "/sessions/"+first.SessionID+"/runs", nil, 200, &history)
	if len(history.Runs) != 1 || history.Runs[0].ID != retried.ID {
		t.Fatalf("in-place retry left duplicate turns in session: %+v", history.Runs)
	}
	var oldRun model.Run
	f.request("GET", "/runs/"+first.ID, nil, 200, &oldRun)
	if !oldRun.Superseded {
		t.Fatalf("original failed run was not superseded: %+v", oldRun)
	}
	// Idempotent replay with same commandId returns the replacement run; a new commandId is rejected.
	var replay model.Run
	f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": cmdID}, 200, &replay)
	if replay.ID != retried.ID {
		t.Fatalf("idempotent retry replay returned %s, want %s", replay.ID, retried.ID)
	}
	f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": app.ID()}, 409, nil)

	// 2. Subsequent turn fails before output on the bound session, then user moves on -> old failed turn cannot be retried.
	second := f.wait(f.send(chat.ID, "main", "", "[fail-before-output] second prompt").ID, "failed")
	third := f.wait(f.send(chat.ID, "main", "", "third prompt moves conversation forward").ID, "completed")
	if third.Sequence <= second.Sequence {
		t.Fatalf("unexpected sequence order: %d <= %d", third.Sequence, second.Sequence)
	}
	f.request("POST", "/runs/"+second.ID+"/retry", map[string]string{"commandId": app.ID()}, 409, nil)

	// 3. First turn stopped before native binding does not trigger a spurious Handoff on retry,
	//    and an /after dependent queued while it ran automatically follows the replacement run.
	slowScope := filepath.Join(f.root, "slow-native-binding")
	if err := os.MkdirAll(slowScope, 0700); err != nil {
		t.Fatal(err)
	}
	slowAgent := model.Agent{
		Name: "Slow Codex",
		Profile: model.Profile{
			Provider: "codex", Permission: "ask", Instructions: "slow-bind",
			Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: slowScope}}, PrimaryRootID: "root"},
			Skills: []string{}, Delegations: []model.DelegationRule{},
		},
	}
	f.request("POST", "/agents", slowAgent, 200, &slowAgent)
	slowChat := f.chat(slowAgent)
	unbound := f.send(slowChat.ID, "main", "", "first unbound prompt")
	f.wait(unbound.ID, "running")
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: other.ID, Operation: "main", Text: "run after unbound retry",
		Delivery: "queue", AfterRunIDs: []string{unbound.ID},
	}, 200, &waiter)
	f.request("POST", "/runs/"+unbound.ID+"/stop", nil, 200, nil)
	unbound = f.wait(unbound.ID, "interrupted")
	var sessionView model.SessionView
	f.request("GET", "/sessions/"+unbound.SessionID, nil, 200, &sessionView)
	if sessionView.Session.NativeID != "" {
		t.Fatalf("expected unbound session before retry, got %q", sessionView.Session.NativeID)
	}
	var retriedUnbound model.Run
	f.request("POST", "/runs/"+unbound.ID+"/retry", map[string]string{"commandId": app.ID()}, 200, &retriedUnbound)
	retriedUnbound = f.wait(retriedUnbound.ID, "completed")
	if retriedUnbound.Handoff {
		t.Fatalf("retrying an unbound first turn triggered a spurious handoff: %+v", retriedUnbound)
	}
	if retriedUnbound.Sequence != unbound.Sequence {
		t.Fatalf("unbound retry changed sequence: got %d, want %d", retriedUnbound.Sequence, unbound.Sequence)
	}
	f.request("GET", "/sessions/"+unbound.SessionID+"/runs", nil, 200, &history)
	if len(history.Runs) != 1 || history.Runs[0].ID != retriedUnbound.ID {
		t.Fatalf("unbound retry left duplicate turns: %+v", history.Runs)
	}
	f.wait(waiter.ID, "completed")
}

func TestRetryWithPartialOutputContinuesSameRunAcrossProviders(t *testing.T) {
	type providerCase struct {
		name  string
		mode  string
		open  func(string) (*app.App, error)
		setup func(*fixture) model.Agent
		check func(*testing.T, model.Run, string)
	}
	cases := []providerCase{
		{
			name: "codex/embedded", mode: "embedded", open: app.Open,
			setup: func(f *fixture) model.Agent { return f.agent("codex") },
			check: checkNativeEmptyContinuation,
		},
		{
			name: "codex/worker", mode: "worker", open: app.OpenServer,
			setup: func(f *fixture) model.Agent { return f.agent("codex") },
			check: checkNativeEmptyContinuation,
		},
		{
			name: "claude/embedded", mode: "embedded", open: app.Open,
			setup: func(f *fixture) model.Agent { return f.agent("claude") },
			check: checkNativeEmptyContinuation,
		},
		{
			name: "claude/worker", mode: "worker", open: app.OpenServer,
			setup: func(f *fixture) model.Agent { return f.agent("claude") },
			check: checkNativeEmptyContinuation,
		},
		{
			name: "antigravity/embedded", mode: "embedded", open: app.Open,
			setup: func(f *fixture) model.Agent { return f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"}) },
			check: checkACPContinuation,
		},
		{
			name: "antigravity/worker", mode: "worker", open: app.OpenServer,
			setup: func(f *fixture) model.Agent { return f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"}) },
			check: checkACPContinuation,
		},
		{
			name: "acp/embedded", mode: "embedded", open: app.Open,
			setup: func(f *fixture) model.Agent { return f.acpAgent(f.acpProvider("acp-continue")) },
			check: checkACPContinuation,
		},
		{
			name: "pi/embedded", mode: "embedded", open: app.Open,
			setup: func(f *fixture) model.Agent { return f.piAgent() },
			check: checkPiContinuation,
		},
		{
			name: "pi/worker", mode: "worker", open: app.OpenServer,
			setup: func(f *fixture) model.Agent { return f.piAgent() },
			check: checkPiContinuation,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := openFixture(t, tc.open).withLocalProviders()
			agent := tc.setup(f)
			chat := f.chat(agent)

			first := f.wait(f.send(chat.ID, "main", "", "[fail-after-partial] complete the task").ID, "failed")
			if !hasRunText(first, "Partial reply before failure") {
				t.Fatalf("expected partial reply before failure: %+v", first.Items)
			}
			nativeBefore := f.waitNative(first.SessionID).NativeID
			if nativeBefore == "" {
				t.Fatal("expected native session ID before continuation")
			}

			cmdID := app.ID()
			var continued model.Run
			f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": cmdID}, 200, &continued)
			if continued.ID != first.ID {
				t.Fatalf("mid-output retry created a new run %s instead of continuing %s", continued.ID, first.ID)
			}
			continued = f.wait(first.ID, "completed")
			if continued.Sequence != first.Sequence || continued.StartedAt != first.StartedAt || !continued.Continued {
				t.Fatalf("continuation altered run metadata: before=%+v after=%+v", first, continued)
			}
			if !hasRunText(continued, "Partial reply before failure") {
				t.Fatalf("continuation overwrote partial output: %+v", continued.Items)
			}
			if len(continued.Items) < 2 {
				t.Fatalf("expected continuation to append items after partial output: %+v", continued.Items)
			}
			if gotNative := f.waitNative(first.SessionID).NativeID; gotNative != nativeBefore {
				t.Fatalf("continuation changed native session: got %q, want %q", gotNative, nativeBefore)
			}
			tc.check(t, continued, nativeBefore)

			var history model.SessionRuns
			f.request("GET", "/sessions/"+first.SessionID+"/runs", nil, 200, &history)
			if len(history.Runs) != 1 || history.Runs[0].ID != first.ID {
				t.Fatalf("continuation created duplicate messages in session: %+v", history.Runs)
			}

			// Same commandId replays idempotently; a new commandId on the completed run returns 409.
			var replay model.Run
			f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": cmdID}, 200, &replay)
			if replay.ID != first.ID {
				t.Fatalf("idempotent continuation replay returned %s, want %s", replay.ID, first.ID)
			}
			f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": app.ID()}, 409, nil)
		})
	}
}

func TestRetryInterruptedWithPartialOutputContinuesSameRun(t *testing.T) {
	for _, tc := range []struct {
		name    string
		prompt  string
		partial string
		setup   func(*fixture) model.Agent
		check   func(*testing.T, model.Run, string)
	}{
		{
			name:    "antigravity",
			prompt:  "[hang] work in progress",
			partial: "ACP waiting",
			setup:   func(f *fixture) model.Agent { return f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"}) },
			check:   checkACPContinuation,
		},
		{
			name:    "pi",
			prompt:  "[partial-hang] work in progress",
			partial: "Partial reply before stop",
			setup:   func(f *fixture) model.Agent { return f.piAgent() },
			check:   checkPiContinuation,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(tc.setup(f))
			run := f.send(chat.ID, "main", "", tc.prompt)
			waitForPartialItem(f, run.ID, tc.partial)
			f.request("POST", "/runs/"+run.ID+"/stop", nil, 200, nil)
			stopped := f.wait(run.ID, "interrupted")
			nativeBefore := f.waitNative(stopped.SessionID).NativeID
			if nativeBefore == "" {
				t.Fatal("expected bound native session after partial output")
			}

			var continued model.Run
			f.request("POST", "/runs/"+stopped.ID+"/retry", map[string]string{"commandId": app.ID()}, 200, &continued)
			if continued.ID != stopped.ID {
				t.Fatalf("expected same run ID %s, got %s", stopped.ID, continued.ID)
			}
			continued = f.wait(stopped.ID, "completed")
			if !hasRunText(continued, tc.partial) {
				t.Fatalf("continuation lost prior output %q: %+v", tc.partial, continued.Items)
			}
			tc.check(t, continued, nativeBefore)
		})
	}
}

func TestRetryWithoutNativeSessionFallsBackToInPlaceRetry(t *testing.T) {
	f := newFixture(t)
	agent := f.acpAgent(f.acpProvider("no-resume-acp", "--no-resume"))
	chat := f.chat(agent)

	first := f.wait(f.send(chat.ID, "main", "", "[fail-after-partial] stateless acp").ID, "failed")
	if !hasRunText(first, "Partial reply before failure") {
		t.Fatalf("expected partial reply: %+v", first.Items)
	}
	var sessionView model.SessionView
	f.request("GET", "/sessions/"+first.SessionID, nil, 200, &sessionView)
	if sessionView.Session.NativeID != "" {
		t.Fatalf("non-resumable ACP should have no nativeId, got %q", sessionView.Session.NativeID)
	}

	var retried model.Run
	f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": app.ID()}, 200, &retried)
	if retried.ID == first.ID {
		t.Fatalf("stateless ACP without nativeId should replace in-place rather than resume same run: %+v", retried)
	}
	if retried.Sequence != first.Sequence {
		t.Fatalf("fallback in-place retry changed sequence: got %d, want %d", retried.Sequence, first.Sequence)
	}
	f.wait(retried.ID, "failed")
	var history model.SessionRuns
	f.request("GET", "/sessions/"+first.SessionID+"/runs", nil, 200, &history)
	if len(history.Runs) != 1 || history.Runs[0].ID != retried.ID {
		t.Fatalf("fallback in-place retry left duplicate turns: %+v", history.Runs)
	}
}

func checkNativeEmptyContinuation(t *testing.T, run model.Run, _ string) {
	t.Helper()
	if !hasRunText(run, "Continued from the saved native turn") {
		t.Fatalf("expected native empty-input continuation output: %+v", run.Items)
	}
}

func checkACPContinuation(t *testing.T, run model.Run, nativeID string) {
	t.Helper()
	var receipt map[string]any
	for _, item := range run.Items {
		if item.Kind == "text" && strings.HasPrefix(item.Text, "{") {
			if err := json.Unmarshal([]byte(item.Text), &receipt); err == nil {
				break
			}
		}
	}
	if receipt == nil {
		t.Fatalf("missing ACP continuation receipt in items: %+v", run.Items)
	}
	if receipt["native"] != nativeID {
		t.Fatalf("ACP continuation used wrong native session: got %v, want %q", receipt["native"], nativeID)
	}
	input, _ := receipt["input"].(string)
	if !strings.Contains(input, provider.ContinueInterruptedPrompt) || strings.Contains(input, "[fail-after-partial]") {
		t.Fatalf("ACP continuation sent unexpected prompt: %q", input)
	}
}

func checkPiContinuation(t *testing.T, run model.Run, _ string) {
	t.Helper()
	var history []string
	for _, item := range run.Items {
		if item.Kind == "text" && strings.HasPrefix(item.Text, "[") {
			if err := json.Unmarshal([]byte(item.Text), &history); err == nil {
				break
			}
		}
	}
	if len(history) != 2 {
		t.Fatalf("expected 2 entries in resumed Pi session history (original + continuation), got %+v (items=%+v)", history, run.Items)
	}
	if !strings.Contains(history[1], provider.ContinueInterruptedPrompt) || strings.Contains(history[1], "[fail-after-partial]") {
		t.Fatalf("Pi continuation sent unexpected prompt: %+v", history)
	}
}

func hasRunText(run model.Run, text string) bool {
	return slices.ContainsFunc(run.Items, func(item model.Item) bool { return item.Kind == "text" && item.Text == text })
}

func waitForPartialItem(f *fixture, id, text string) {
	f.t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(15 * time.Millisecond) {
		var run model.Run
		f.request("GET", "/runs/"+id, nil, 200, &run)
		if hasRunText(run, text) {
			return
		}
		if !model.Active(run.Status) {
			f.t.Fatalf("run %s ended (%s: %s) before emitting %q", id, run.Status, run.Error, text)
		}
	}
	f.t.Fatalf("run %s did not emit %q", id, text)
}
