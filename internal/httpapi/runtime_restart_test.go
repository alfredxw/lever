package httpapi_test

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
	"lever/internal/store"
)

// TestMain gives native CLIs an isolated HOME. Build Lever using the same Go
// environment that compiled the test, then launch it with the fixture CLIs.
var buildEnvironment = os.Environ()

func TestProviderSurvivesBackendExit(t *testing.T) {
	dir, root := t.TempDir(), t.TempDir()
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("init test scope: %v %s", err, out)
	}
	file := filepath.Join(t.TempDir(), "lever")
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	build := exec.Command("go", "build", "-tags", "dev", "-o", file, "../../cmd/lever")
	build.Env = buildEnvironment
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build Lever: %v\n%s", err, out)
	}
	var backend *exec.Cmd
	var log bytes.Buffer
	f := &fixture{t: t, root: root}
	start := func() {
		t.Helper()
		backend = exec.Command(file, "--data-dir", dir, "--listen", "127.0.0.1:0")
		output, err := backend.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		backend.Stderr = &log
		if err = backend.Start(); err != nil {
			t.Fatal(err)
		}
		line, err := bufio.NewReader(output).ReadString('\n')
		if err != nil {
			backend.Wait()
			t.Fatalf("start server: %v\n%s", err, &log)
		}
		u, err := url.Parse(strings.TrimPrefix(strings.TrimSpace(line), "Lever: "))
		if err != nil {
			t.Fatal(err)
		}
		f.s = &httpapi.Server{URL: u.Scheme + "://" + u.Host, Token: strings.TrimPrefix(u.Fragment, "token=")}
	}
	killBackend := func() {
		if backend.ProcessState == nil {
			_ = backend.Process.Kill()
			_ = backend.Wait()
		}
	}
	start()
	db, err := store.OpenConnection(dir)
	if err != nil {
		t.Fatal(err)
	}
	f.a = &app.App{Store: &store.Store{DB: db, Dir: dir}}
	t.Cleanup(func() {
		_, _ = db.Exec("UPDATE runtime_hosts SET stop=1")
		_ = os.WriteFile(filepath.Join(root, "continue-provider"), nil, 0600)
		killBackend()
		db.Close()
	})
	for _, id := range []string{"codex", "claude", "antigravity", "pi", "dsh"} {
		f.request("POST", "/provider-candidates/lever."+id+"/"+id, nil, 200, nil)
	}
	agent := f.agent("codex")
	chat := f.chat(agent)
	background := f.send(chat.ID, "main", "", "[restart-checkpoint]")
	mcpRun := f.send(chat.ID, "topic", "", "[restart-checkpoint] [mcp]")
	approval := f.send(chat.ID, "topic", "", "[approval]")
	queued := model.Run{}
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "reply", SessionID: approval.SessionID, Delivery: "queue", Text: "After approval"}, 200, &queued)
	f.wait(queued.ID, "queued")
	steer := f.send(chat.ID, "topic", "", "[hang]")
	stop := f.send(chat.ID, "topic", "", "[hang]")
	claude := f.send(f.chat(f.agent("claude")).ID, "main", "", "[claude-approval]")
	for _, runtime := range []struct{ id, permission, input string }{
		{"antigravity", "request-review", "[approval]"},
		{"dsh", "", "[approval]"},
		{"pi", "", "[pi-question]"},
	} {
		profile := agent.Profile
		profile.Provider, profile.Permission = runtime.id, runtime.permission
		var saved model.Agent
		f.request("POST", "/agents", model.Agent{Name: runtime.id, Profile: profile}, 200, &saved)
		r := f.send(f.chat(saved).ID, "main", "", runtime.input)
		f.wait(r.ID, "waiting_user")
	}
	f.wait(approval.ID, "waiting_user")
	f.wait(claude.ID, "waiting_user")
	f.waitNative(steer.SessionID)
	f.waitNative(stop.SessionID)
	before, err := os.ReadFile(filepath.Join(root, "provider-starts"))
	if err != nil {
		t.Fatal(err)
	}
	var beforeView model.Overview
	f.request("GET", "/overview", nil, 200, &beforeView)
	if len(beforeView.Requests) != 5 {
		t.Fatalf("pending requests before exit: %v", beforeView.Requests)
	}
	oldPID := backend.Process.Pid
	killBackend()
	// A detached worker from an earlier build can still have this standalone
	// event in front of its final output when the backend reattaches.
	if _, err := db.Exec(`INSERT INTO runtime_events(run_id,kind,data) VALUES(?,'steerState','"unavailable"')`, background.ID); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "continue-provider"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	var phase string
	for time.Now().Before(deadline) {
		err = db.QueryRow("SELECT phase FROM runtime_hosts WHERE run_id=?", background.ID).Scan(&phase)
		if err == nil && phase == "completed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	after, err := os.ReadFile(filepath.Join(root, "provider-finished"))
	if err != nil || phase != "completed" || strings.TrimSpace(string(before)) != string(after) {
		t.Fatalf("offline provider: phase %s, started %s, finished %s, err %v", phase, before, after, err)
	}
	if err = os.WriteFile(filepath.Join(root, "later-external-edit"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	start()
	if backend.Process.Pid == oldPID {
		t.Fatal("expected a replacement backend")
	}
	finished := f.wait(background.ID, "completed")
	starts, _ := os.ReadFile(filepath.Join(root, "provider-starts"))
	if string(starts) != string(before) || len(strings.Fields(string(after))) != 3 || finished.NativeTurnID == nil || *finished.NativeTurnID != strings.Fields(string(after))[2] || !strings.Contains(fmt.Sprint(finished.Items), string(after)) {
		t.Fatalf("replayed or lost native turn: %s %+v", starts, finished)
	}
	if len(finished.Changes) != 1 || !strings.Contains(fmt.Sprint(finished.Changes[0].Files), "provider-finished") || strings.Contains(fmt.Sprint(finished.Changes[0].Files), "later-external-edit") {
		t.Fatalf("completion captured outside the native turn: %+v", finished.Changes)
	}
	mcpResult := f.wait(mcpRun.ID, "completed")
	var workItems int
	if err = db.QueryRow("SELECT COUNT(*) FROM work_items WHERE request_scope=? AND request_key='restart-test'", "run:"+mcpRun.ID).Scan(&workItems); err != nil || workItems != 1 {
		t.Fatalf("MCP across backend replacement: %v, %d, %+v", err, workItems, mcpResult.Items)
	}
	f.request("POST", "/runs/"+claude.ID+"/permission", map[string]string{"permission": "accept_edits"}, 200, nil)
	if r := f.wait(claude.ID, "waiting_user"); r.Selection.Permission != "accept_edits" {
		t.Fatal("native permission change lost", r.Selection)
	}
	var view model.Overview
	f.request("GET", "/overview", nil, 200, &view)
	if len(view.Requests) != len(beforeView.Requests) {
		t.Fatalf("pending requests after exit: %v", view.Requests)
	}
	for _, r := range beforeView.Requests {
		answer := r.AllowOnce
		if r.Kind == "question" {
			answer = &model.Answer{Allow: true, Answers: map[string][]string{"value": {"continue"}}}
		}
		if answer == nil {
			t.Fatalf("expected native one-time approval for %s", r.RunID)
		}
		f.request("POST", "/requests/"+r.ID+"/answer", answer, 200, nil)
		f.request("POST", "/requests/"+r.ID+"/answer", answer, 200, nil)
		f.wait(r.RunID, "completed")
	}
	f.wait(queued.ID, "completed")
	var message model.Run
	f.request("POST", "/messages", model.SendInput{ChatID: chat.ID, SessionID: steer.SessionID, Operation: "reply", Delivery: "steer", CommandID: app.ID(), Text: "finish after restart"}, 200, &message)
	f.wait(message.ID, "steered")
	f.wait(steer.ID, "completed")
	f.request("POST", "/runs/"+stop.ID+"/stop", struct{}{}, 200, nil)
	f.wait(stop.ID, "interrupted")
	var hosts int
	if err = db.QueryRowContext(context.Background(), "SELECT count(*) FROM runtime_hosts").Scan(&hosts); err != nil || hosts != 0 {
		t.Fatalf("remaining run hosts: %d %v", hosts, err)
	}
}
