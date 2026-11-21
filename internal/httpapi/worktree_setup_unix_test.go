//go:build !windows

package httpapi_test

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"lever/internal/app"
	"lever/internal/model"
)

func TestWorktreeSetupGuardsCheckoutAndFirstSend(t *testing.T) {
	f := newFixture(t)
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	root := filepath.Join(f.root, "repo with spaces")
	shared := filepath.Join(f.root, "other repository")
	for _, dir := range []string{root, shared} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("setup-*\n"), 0600); err != nil {
			t.Fatal(err)
		}
		git(dir, "init", "-q")
		git(dir, "add", ".")
		git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initial")
	}
	borrowed := filepath.Join(f.root, "borrowed")
	git(shared, "worktree", "add", "--detach", borrowed)

	agent := f.agent("codex")
	agent.Profile.Roots = []model.Root{{ID: "root", Path: root}, {ID: "other", Path: shared}}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	copies := "/agents/" + agent.ID + "/working-copies"
	id := app.ID()
	var options model.CopyOptions
	f.request("GET", copies+"/options?requestId="+id, nil, 200, &options)
	primary, adopted := options.Groups[0], options.Groups[1]
	script := `set -e; printf '%s\n' "$$" >> setup-pids; echo SETUP_WAITING; until [ -f setup-release ]; do sleep 0.05; done; printf initialized > setup-marker; echo SETUP_FINISHED`
	agent.Profile.WorktreeSetup = map[string]string{primary.GitDir: script, adopted.GitDir: script}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.request("GET", copies+"/options?requestId="+id, nil, 200, &options)
	if got := options.Groups[0].Setup; got != script {
		t.Fatalf("preview setup command: %q", got)
	}
	var copy model.WorkingCopy
	f.request("POST", copies, model.CreateWorkingCopy{
		ID: id, Name: "Scoped setup", Scope: options.Scope,
		Choices: []model.CopyChoice{{Source: primary.Source, Base: primary.Head}, {Source: adopted.Source, Path: adopted.Existing[0].Path}},
	}, 200, &copy)
	if copy.State != "ready" {
		t.Fatalf("copy state: %s, %s", copy.State, copy.Error)
	}
	worktrees := "/agents/" + agent.ID + "/worktrees"
	setup := worktrees + "/" + copy.Checkouts[0].ID + "/setup/"
	path := copy.Checkouts[0].Path
	input := map[string]string{"path": path, "command": script}
	f.request("POST", setup+app.ID(), map[string]string{"path": path, "command": "true"}, 409, nil)
	f.request("POST", worktrees+"/"+copy.Checkouts[1].ID+"/setup/"+app.ID(), map[string]string{"path": copy.Checkouts[1].Path, "command": script}, 400, nil)
	other := f.agent("codex")
	f.request("POST", strings.Replace(setup, agent.ID, other.ID, 1)+app.ID(), input, 404, nil)
	git(path, "checkout", "--detach")
	f.request("POST", setup+app.ID(), input, 409, nil)
	git(path, "checkout", copy.Checkouts[0].Branch)
	attempt := setup + app.ID()
	f.request("POST", attempt, input, 200, nil)
	f.request("POST", attempt, input, 200, nil)
	f.request("POST", setup+app.ID(), input, 409, nil)

	socketURL := "ws" + strings.TrimPrefix(f.s.URL, "http") + "/api" + attempt + "?cols=90&rows=30"
	conn, _, err := websocket.DefaultDialer.Dial(socketURL, http.Header{"Authorization": {"Bearer " + f.s.Token}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	terminalUntil(t, conn, "SETUP_WAITING")
	chat := f.chat(agent)
	message := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "topic", Text: "[worktree-setup]", WorkingCopyID: copy.ID}
	f.request("POST", "/messages", message, 409, nil)
	f.request("DELETE", worktrees+"/"+copy.Checkouts[0].ID, nil, 409, nil)
	if err := os.WriteFile(filepath.Join(path, "setup-release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	terminalUntil(t, conn, "SETUP_FINISHED")
	_, frame, err := conn.ReadMessage()
	var result struct {
		Type string
		Code int
	}
	if err != nil || json.Unmarshal(frame, &result) != nil || result.Type != "exit" || result.Code != 0 {
		t.Fatalf("expected a successful exit, got %s (%v)", frame, err)
	}
	if pids, err := os.ReadFile(filepath.Join(path, "setup-pids")); err != nil || len(strings.Fields(string(pids))) != 1 {
		t.Fatalf("unexpected setup starts: %q (%v)", pids, err)
	}
	for _, dir := range []string{root, shared, borrowed} {
		if _, err := os.Stat(filepath.Join(dir, "setup-pids")); !os.IsNotExist(err) {
			t.Fatalf("setup touched %s: %v", dir, err)
		}
	}
	var run model.Run
	f.request("POST", "/messages", message, 200, &run)
	run = f.wait(run.ID, "completed")
	for _, item := range run.Items {
		if strings.Contains(item.Text, "Worktree setup: initialized") {
			return
		}
	}
	t.Fatalf("the first Topic did not see initialization output: %+v", run.Items)
}
