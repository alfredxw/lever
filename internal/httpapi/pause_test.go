package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
)

func TestPauseReplyResumesSameRun(t *testing.T) {
	for _, tc := range []struct {
		runtime, mode string
		open          func(string) (*app.App, error)
	}{
		{"codex", "embedded", app.Open}, {"codex", "worker", app.OpenServer},
		{"claude", "embedded", app.Open}, {"claude", "worker", app.OpenServer},
	} {
		t.Run(tc.runtime+"/"+tc.mode, func(t *testing.T) {
			open := tc.open
			f := openFixture(t, open).withLocalProviders()
			chat := f.chat(f.agent(tc.runtime))
			first := f.send(chat.ID, "main", "", "[pausable] original prompt")
			bound := waitPausable(f, first.ID)
			queued := model.Run{}
			f.request("POST", "/messages", model.SendInput{
				CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "Queued follow-up", Delivery: "queue",
			}, 200, &queued)
			f.request("POST", "/runs/"+first.ID+"/pause", nil, 200, nil)
			paused := f.wait(first.ID, "paused")
			if paused.Error != "" || paused.FinishedAt != "" || !hasPauseTestOutput(paused, "Partial reply before the pause") {
				t.Fatalf("pause lost the original reply: %+v", paused)
			}
			f.wait(queued.ID, "queued")
			f.request("POST", "/runs/"+first.ID+"/retry", map[string]string{"commandId": app.ID()}, 409, nil)
			f.s.HTTP.Close()
			if err := f.a.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := open(f.a.Store.Dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			srv, err := httpapi.New(reopened, "127.0.0.1:0", "", fstest.MapFS{})
			if err != nil {
				t.Fatal(err)
			}
			go srv.Serve()
			defer srv.HTTP.Close()
			f = &fixture{t: t, a: reopened, s: srv}
			f.wait(first.ID, "paused")
			path := "/runs/" + first.ID + "/resume"
			f.request("POST", path, map[string]string{"nativeTurnId": "stale-turn"}, 409, nil)
			f.request("POST", path, map[string]string{"nativeTurnId": *paused.NativeTurnID}, 200, nil)
			continued := f.wait(first.ID, "completed")
			if continued.Sequence != first.Sequence || continued.StartedAt != bound.StartedAt ||
				len(continued.Items) != 2 || !hasPauseTestOutput(continued, "Partial reply before the pause") ||
				!hasPauseTestOutput(continued, "Continued from the saved native turn") {
				t.Fatalf("continuation did not extend the existing reply: %+v", continued)
			}
			var history model.SessionRuns
			f.request("GET", "/sessions/"+first.SessionID+"/runs", nil, 200, &history)
			if len(history.Runs) != 1 {
				t.Fatalf("continuation created a second message: %+v", history.Runs)
			}
			f.wait(queued.ID, "queued")
		})
	}
}

func TestSendingAndEditingAfterPauseStartNewRuns(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	first := waitPausable(f, f.send(chat.ID, "main", "", "[pausable] first prompt").ID)
	var queued, revised model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "Queued first", Delivery: "queue",
	}, 200, &queued)
	f.request("POST", "/runs/"+first.ID+"/pause", nil, 200, nil)
	f.wait(first.ID, "paused")
	second := waitPausable(f, f.send(chat.ID, "main", "", "[pausable] new prompt").ID)
	f.wait(first.ID, "interrupted")
	f.wait(queued.ID, "queued")
	f.request("POST", "/runs/"+first.ID+"/resume", map[string]string{"nativeTurnId": *first.NativeTurnID}, 409, nil)
	f.request("POST", "/runs/"+second.ID+"/pause", nil, 200, nil)
	f.wait(second.ID, "paused")
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, ReplaceRunID: second.ID, Text: "Edited prompt",
	}, 200, &revised)
	if revised.ID == second.ID || revised.SessionID != second.SessionID || revised.Sequence != second.Sequence {
		t.Fatalf("edit did not replace the intended reply: %+v", revised)
	}
	f.wait(revised.ID, "completed")
	if discarded := f.wait(second.ID, "interrupted"); !discarded.Superseded {
		t.Fatal("paused original is still in the active transcript")
	}
	f.wait(queued.ID, "queued")
}

func TestPauseReplyRequiresNativeConfirmation(t *testing.T) {
	for marker, status := range map[string]string{"[unconfirmed-pause]": "unknown", "[missing-pause-input]": "interrupted"} {
		t.Run(marker, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent("codex"))
			run := waitPausable(f, f.send(chat.ID, "main", "", "[pausable] "+marker).ID)
			f.request("POST", "/runs/"+run.ID+"/pause", nil, 200, nil)
			f.wait(run.ID, status)
			f.request("POST", "/runs/"+run.ID+"/resume", map[string]string{"nativeTurnId": *run.NativeTurnID}, 409, nil)
		})
	}
}

func TestClaudeContinuationRejectsChangedNativeConversation(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("claude"))
	run := waitPausable(f, f.send(chat.ID, "main", "", "[pausable]").ID)
	f.request("POST", "/runs/"+run.ID+"/pause", nil, 200, nil)
	paused := f.wait(run.ID, "paused")
	native := f.waitNative(run.SessionID).NativeID
	file, err := os.OpenFile(filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "projects", "fixture", native+".jsonl"), os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(file).Encode(map[string]string{"type": "user", "uuid": app.ID()}); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/runs/"+run.ID+"/resume", map[string]string{"nativeTurnId": *paused.NativeTurnID}, 200, nil)
	unknown := f.wait(run.ID, "unknown")
	if !hasPauseTestOutput(unknown, "Partial reply before the pause") || len(unknown.Items) != 1 {
		t.Fatalf("continuation used a different native history: %+v", unknown)
	}
}

func waitPausable(f *fixture, id string) model.Run {
	f.t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(15 * time.Millisecond) {
		var run model.Run
		f.request("GET", "/runs/"+id, nil, 200, &run)
		if run.CanPause && run.NativeTurnID != nil && hasPauseTestOutput(run, "Partial reply before the pause") {
			return run
		}
	}
	f.t.Fatalf("run %s did not become pausable", id)
	return model.Run{}
}

func hasPauseTestOutput(run model.Run, text string) bool {
	return slices.ContainsFunc(run.Items, func(item model.Item) bool { return item.Text == text })
}
