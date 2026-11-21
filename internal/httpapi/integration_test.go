package httpapi_test

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/cli"
	"lever/internal/httpapi"
	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/runhost"
	"lever/internal/store"
)

func TestMain(m *testing.M) {
	if runhost.Main() || provider.MCPStdioHelper() {
		return
	}
	if handled, err := cli.Run(os.Args[1:], os.Getenv("LEVER_DATA_DIR"), os.Stdout, os.Stderr); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	bin, err := os.MkdirTemp("", "lever-runtime-fixture-")
	if err != nil {
		panic(err)
	}
	extension := ""
	if runtime.GOOS == "windows" {
		extension = ".exe"
	}
	cmd := exec.Command("go", "build", "-o", filepath.Join(bin, "codex"+extension), "../testutil/fakeruntime")
	if output, err := cmd.CombinedOutput(); err != nil {
		panic(string(output) + err.Error())
	}
	if err = os.Link(filepath.Join(bin, "codex"+extension), filepath.Join(bin, "claude"+extension)); err != nil {
		panic(err)
	}
	if err = os.Link(filepath.Join(bin, "codex"+extension), filepath.Join(bin, "agy"+extension)); err != nil {
		panic(err)
	}
	acpName, harnessName := "agy_acp_server.par", "localharness_external"
	if runtime.GOOS == "windows" {
		acpName, harnessName = "agy_acp_server.exe", "localharness_external.exe"
	}
	for _, name := range []string{acpName, harnessName, "pi" + extension, "dsh" + extension} {
		if err = os.Link(filepath.Join(bin, "codex"+extension), filepath.Join(bin, name)); err != nil {
			panic(err)
		}
	}
	os.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	os.Setenv("LEVER_CODEX_PATH", filepath.Join(bin, "codex"+extension))
	os.Setenv("LEVER_CLAUDE_PATH", filepath.Join(bin, "claude"+extension))
	os.Setenv("LEVER_ANTIGRAVITY_PATH", filepath.Join(bin, "agy"+extension))
	os.Setenv("LEVER_PI_PATH", filepath.Join(bin, "pi"+extension))
	os.Setenv("LEVER_DSH_PATH", filepath.Join(bin, "dsh"+extension))
	home := filepath.Join(bin, "home")
	if err := os.Mkdir(home, 0700); err != nil {
		panic(err)
	}
	os.Setenv("HOME", home)
	os.Setenv("USERPROFILE", home)
	os.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	os.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	code := m.Run()
	os.RemoveAll(bin)
	os.Exit(code)
}

type fixture struct {
	t    *testing.T
	a    *app.App
	s    *httpapi.Server
	root string
}

func newFixture(t *testing.T) *fixture {
	return openFixture(t, app.Open).withLocalProviders()
}

func (f *fixture) withLocalProviders() *fixture {
	t := f.t
	t.Helper()
	// Most integration scenarios start with the fixture CLIs already connected.
	if _, err := f.a.Store.DB.Exec("DELETE FROM settings WHERE key=?", store.StarterAgentPending); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"codex", "claude", "antigravity", "pi", "dsh"} {
		if _, err := f.a.UseLocalProvider(t.Context(), "lever."+id, id); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func newUnconfiguredFixture(t *testing.T) *fixture {
	return openFixture(t, app.Open)
}

func openFixture(t *testing.T, open func(string) (*app.App, error)) *fixture {
	t.Helper()
	a, err := open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s, err := httpapi.New(a, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("Lever")}})
	if err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	t.Cleanup(func() { a.Close(); s.HTTP.Close() })
	return &fixture{t, a, s, t.TempDir()}
}

func (f *fixture) startLocalCLI() {
	f.t.Helper()
	if err := f.s.StartLocalCLI(nil); err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := f.s.CloseLocalCLI(ctx); err != nil {
			f.t.Error(err)
		}
	})
}

func (f *fixture) request(method, path string, value any, status int, out any) {
	f.t.Helper()
	var body io.Reader
	if value != nil {
		b, _ := json.Marshal(value)
		body = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, f.s.URL+"/api"+path, body)
	req.Header.Set("Authorization", "Bearer "+f.s.Token)
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	b, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		f.t.Fatalf("%s %s: got %d, want %d: %s", method, path, response.StatusCode, status, b)
	}
	if out != nil {
		if err = json.Unmarshal(b, out); err != nil {
			f.t.Fatal(err)
		}
	}
}
func (f *fixture) agent(provider string) model.Agent {
	f.t.Helper()
	v := model.Agent{Name: "Test " + provider, Profile: model.Profile{Provider: provider, Permission: "ask", Instructions: "profile-v1", Scope: model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"}, Skills: []string{}, Delegations: []model.DelegationRule{}}}
	var saved model.Agent
	f.request("POST", "/agents", v, 200, &saved)
	return saved
}
func (f *fixture) chat(agent model.Agent) model.Chat {
	var chat model.Chat
	f.request("POST", "/chats", map[string]string{"agentId": agent.ID}, 200, &chat)
	return chat
}
func (f *fixture) send(chat, op, session, text string) model.Run {
	f.t.Helper()
	var run model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat, Operation: op, SessionID: session, Text: text}, 200, &run)
	return run
}
func (f *fixture) wait(id, status string) model.Run {
	f.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		r, err := store.Get[model.Run](context.Background(), f.a.Store.DB, "SELECT data FROM runs WHERE id=?", id)
		if err != nil {
			f.t.Fatal(err)
		}
		if r.Status == status {
			return r
		}
		if !model.Active(r.Status) && r.Status != "queued" && r.Status != "steering" {
			f.t.Fatalf("run status %s, want %s: %s", r.Status, status, r.Error)
		}
		time.Sleep(15 * time.Millisecond)
	}
	f.t.Fatalf("run %s did not reach %s", id, status)
	return model.Run{}
}

func TestMixedChatUsesCurrentAgentInstructions(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "ordinary-1"}
	var first model.Run
	f.request("POST", "/messages", command, 200, &first)
	f.wait(first.ID, "completed")
	var retry model.Run
	f.request("POST", "/messages", command, 200, &retry)
	if retry.ID != first.ID {
		t.Fatal("retry created another run")
	}
	command.Text = "different"
	f.request("POST", "/messages", command, 409, nil)
	topic := f.send(chat.ID, "topic", "", "topic-root")
	f.wait(topic.ID, "completed")
	reply := f.send(chat.ID, "reply", topic.SessionID, "topic-reply")
	f.wait(reply.ID, "completed")
	main := f.send(chat.ID, "main", "", "ordinary-2")
	f.wait(main.ID, "completed")
	if main.SessionID != first.SessionID || reply.SessionID != topic.SessionID || topic.SessionID == main.SessionID {
		t.Fatal("mixed chat session ownership is broken")
	}
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if len(view.Entries) != 3 || view.Entries[0].Kind != "main" || view.Entries[1].Kind != "topic" || view.Entries[2].Kind != "main" || view.Entries[1].ReplyCount != 1 {
		t.Fatalf("incorrect mixed timeline: %+v", view.Entries)
	}
	for i, s := range view.Sessions {
		if s.NativeID == "" {
			t.Fatal("session was not bound")
		}
		for j, o := range view.Sessions {
			if i != j && s.NativeID == o.NativeID {
				t.Fatal("native sessions were shared")
			}
		}
	}
	agent.Profile.Instructions = "profile-v2"
	stale := agent
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.request("PUT", "/agents/"+agent.ID, stale, 409, nil)
	old := f.send(chat.ID, "main", "", "old-profile")
	old = f.wait(old.ID, "completed")
	if !strings.Contains(old.Items[0].Text, "profile-v2") {
		t.Fatal("existing main session did not use the updated instructions")
	}
	fresh := f.send(chat.ID, "topic", "", "new-profile")
	fresh = f.wait(fresh.ID, "completed")
	if !strings.Contains(fresh.Items[0].Text, "profile-v2") {
		t.Fatal("new topic did not use new profile")
	}
	// Reopening the database must preserve timeline order and native references.
	before, _ := json.Marshal(view.Entries)
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	after, _ := json.Marshal(view.Entries[:3])
	if string(before) != string(after) {
		t.Fatal("timeline entries moved")
	}
}

func TestApprovalsQuestionsCancellationAndUnknown(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	for _, text := range []string{"[approval]", "[question]"} {
		run := f.send(chat.ID, "main", "", text)
		f.wait(run.ID, "waiting_user")
		parallel := f.send(chat.ID, "topic", "", "work during a pending request")
		f.wait(parallel.ID, "completed")
		f.wait(run.ID, "waiting_user")
		var overview model.Overview
		f.request("GET", "/overview", nil, 200, &overview)
		if len(overview.Requests) != 1 {
			t.Fatalf("pending requests: %d", len(overview.Requests))
		}
		r := overview.Requests[0]
		answer := model.Answer{Allow: true, Answers: map[string][]string{"choice": {"Green"}}}
		f.request("POST", "/requests/"+r.ID+"/answer", answer, 200, nil)
		f.request("POST", "/requests/"+r.ID+"/answer", answer, 200, nil)
		f.request("POST", "/requests/"+r.ID+"/answer", model.Answer{Allow: false}, 409, nil)
		f.wait(run.ID, "completed")
	}
	hang := f.send(chat.ID, "main", "", "[hang]")
	f.wait(hang.ID, "running")
	time.Sleep(100 * time.Millisecond)
	parallel := f.send(chat.ID, "topic", "", "shared writable scope")
	f.wait(parallel.ID, "completed")
	f.wait(hang.ID, "running")
	f.request("POST", "/runs/"+hang.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(hang.ID, "interrupted")
	unknown := f.send(chat.ID, "main", "", "[disconnect]")
	f.wait(unknown.ID, "unknown")
	parallel = f.send(chat.ID, "topic", "", "work while main is unresolved")
	f.wait(parallel.ID, "completed")
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "must not run"}, 409, nil)
	f.request("POST", "/runs/"+unknown.ID+"/resolve", map[string]bool{"confirmedStopped": false}, 400, nil)
	f.request("POST", "/runs/"+unknown.ID+"/resolve", map[string]bool{"confirmedStopped": true}, 200, nil)
	final := f.send(chat.ID, "main", "", "after reconciliation")
	f.wait(final.ID, "completed")
}

func TestClaudeStreamDoesNotDuplicateFinalText(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("claude")
	chat := f.chat(agent)
	for i := 0; i < 2; i++ {
		run := f.send(chat.ID, "main", "", "one answer")
		run = f.wait(run.ID, "completed")
		if len(run.Items) != 1 || run.Items[0].Text != "one answer" {
			t.Fatalf("stream and wrapper duplicated: %+v", run.Items)
		}
	}
}

func (f *fixture) upload(chatID, name string, data []byte) model.Attachment {
	f.t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", name)
	if err != nil {
		f.t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = w.Close()
	req, _ := http.NewRequest("POST", f.s.URL+"/api/chats/"+chatID+"/attachments", &body)
	req.Header.Set("Authorization", "Bearer "+f.s.Token)
	req.Header.Set("Content-Type", w.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		b, _ := io.ReadAll(response.Body)
		f.t.Fatalf("upload: %d %s", response.StatusCode, b)
	}
	var file model.Attachment
	if err = json.NewDecoder(response.Body).Decode(&file); err != nil {
		f.t.Fatal(err)
	}
	return file
}

func TestComposerRuntimeAndAttachments(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	for _, runtime := range []string{"codex", "claude"} {
		var catalog model.Catalog
		f.request("GET", "/providers/"+runtime+"/models", nil, 200, &catalog)
		count := 2
		if runtime == "codex" {
			count = 8
		}
		if len(catalog.Models) < count || !catalog.Models[0].Fast || len(catalog.Models[0].Efforts) == 0 {
			t.Fatalf("incomplete catalog: %+v", catalog)
		}
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	image := f.upload(chat.ID, "screen.png", png)
	file := f.upload(chat.ID, "requirements.md", []byte("Attachment requirement: keep the topic isolated."))
	command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] remember main-marker", Selection: &model.Selection{Provider: "codex", Model: "gpt-test", Effort: "high", Fast: true}, AttachmentIDs: []string{image.ID, file.ID}}
	var first model.Run
	f.request("POST", "/messages", command, 200, &first)
	first = f.wait(first.ID, "completed")
	wire := func(run model.Run) map[string]any {
		t.Helper()
		var v map[string]any
		if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &v) != nil {
			t.Fatalf("missing runtime wire receipt: %+v", run.Items)
		}
		return v
	}
	value := wire(first)
	if value["model"] != "gpt-test" || value["effort"] != "high" || value["tier"] != "priority" || value["images"] != float64(1) || !strings.Contains(value["input"].(string), "requirements.md") {
		t.Fatalf("Codex did not receive selection/attachments: %v", value)
	}
	if len(first.Attachments) != 2 || first.Attachments[0].MediaType != "image/png" {
		t.Fatal("attachments were not persisted")
	}
	var retry model.Run
	f.request("POST", "/messages", command, 200, &retry)
	if retry.ID != first.ID {
		t.Fatal("retry duplicated message")
	}
	command.Selection.Fast = false
	f.request("POST", "/messages", command, 409, nil)
	f.request("DELETE", "/attachments/"+image.ID, map[string]bool{}, 409, nil)
	other := f.chat(agent)
	bad := command
	bad.CommandID = app.ID()
	bad.ChatID = other.ID
	f.request("POST", "/messages", bad, 400, nil)
	// A same-runtime model/speed change resumes exactly the same native session.
	command.CommandID = app.ID()
	command.Text = "[wire] change model"
	command.Selection.Model = "gpt-review"
	command.Selection.Effort = "low"
	command.AttachmentIDs = nil
	var second model.Run
	f.request("POST", "/messages", command, 200, &second)
	second = f.wait(second.ID, "completed")
	v2 := wire(second)
	if v2["native"] != value["native"] || v2["tier"] != "default" || v2["model"] != "gpt-review" {
		t.Fatal("model switch reset session or retained Fast", v2)
	}
	topic := f.send(chat.ID, "topic", "", "topic-only-marker")
	f.wait(topic.ID, "completed")
	// A runtime switch starts a native session with portable history from this
	// logical session only. Both directions must avoid a foreign resume token.
	command.CommandID = app.ID()
	command.Selection = &model.Selection{Provider: "claude", Model: "default", Effort: "max", Fast: true}
	command.AttachmentIDs = []string{image.ID}
	command.Text = "[wire] continue in Claude"
	var third model.Run
	f.request("POST", "/messages", command, 200, &third)
	third = f.wait(third.ID, "completed")
	v3 := wire(third)
	contextText := v3["input"].(string)
	if third.SessionID != first.SessionID || !third.Handoff || !strings.HasPrefix(v3["native"].(string), "claude-") || v3["effort"] != "max" || v3["fast"] != true || v3["images"] != float64(1) || v3["instructions"] != "profile-v1" {
		t.Fatal("Claude handoff or payload incorrect", v3)
	}
	if !strings.Contains(contextText, "main-marker") || strings.Contains(contextText, "topic-only-marker") {
		t.Fatal("handoff lost context or leaked another topic")
	}
	history, err := os.ReadFile(filepath.Join(f.a.Store.Dir, "sessions", first.SessionID, "history-"+third.ID+".jsonl"))
	if err != nil || !bytes.Contains(history, []byte("requirements.md")) {
		t.Fatal("handoff transcript/attachments missing", err)
	}
	command.CommandID = app.ID()
	command.Selection = &model.Selection{Provider: "codex", Model: "gpt-test", Effort: "low"}
	command.Text = "[wire] back to Codex"
	command.AttachmentIDs = nil
	var fourth model.Run
	f.request("POST", "/messages", command, 200, &fourth)
	fourth = f.wait(fourth.ID, "completed")
	v4 := wire(fourth)
	if v4["native"] == value["native"] || !fourth.Handoff || fourth.SessionID != first.SessionID || !strings.Contains(v4["input"].(string), "continue in Claude") {
		t.Fatal("returning runtime reused stale native context")
	}
	// Attachment-only messages are legitimate, and unsent uploads are removable.
	only := f.upload(other.ID, "notes.txt", []byte("notes"))
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: other.ID, Operation: "main", AttachmentIDs: []string{only.ID}}, 200, &retry)
	f.wait(retry.ID, "completed")
	unused := f.upload(other.ID, "unused.txt", []byte("unused"))
	f.request("DELETE", "/attachments/"+unused.ID, map[string]bool{}, 200, nil)
	if _, err = os.Stat(f.a.AttachmentPath(unused)); !os.IsNotExist(err) {
		t.Fatal("removed upload left a file")
	}
	for _, name := range []string{"..", "/", "\\"} {
		if _, err = f.a.Upload(context.Background(), chat.ID, name, strings.NewReader("bad")); err == nil {
			t.Fatal("unsafe attachment name accepted", name)
		}
	}
	if _, err = os.Stat(f.a.AttachmentPath(image)); err != nil {
		t.Fatal("invalid filename damaged existing uploads", err)
	}
}

func TestScopedFilesDiffAndHTTPBoundary(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	secret := filepath.Join(t.TempDir(), "outside.txt")
	os.WriteFile(secret, []byte("private-outside"), 0600)
	os.Symlink(secret, filepath.Join(f.root, "escape"))
	os.WriteFile(filepath.Join(f.root, "hello.txt"), []byte("hello\n"), 0600)
	var content model.FileContent
	f.request("GET", "/agents/"+agent.ID+"/file?root=root&path=hello.txt", nil, 200, &content)
	if content.Content != "hello\n" {
		t.Fatal("incorrect content")
	}
	input := model.FileWrite{Content: "saved 中文\n", Version: content.Version, RootPath: agent.Profile.Roots[0].Path}
	f.request("PUT", "/agents/"+agent.ID+"/file?root=root&path=hello.txt", input, 200, &content)
	if content.Content != input.Content || content.Version == input.Version {
		t.Fatal("file was not saved")
	}
	input.Content = "stale draft"
	fileURL := "/agents/" + agent.ID + "/file?root=root&path=hello.txt"
	var failure map[string]string
	f.request("PUT", fileURL, input, 409, &failure)
	if failure["code"] != "file_conflict" {
		t.Fatalf("unexpected file conflict: %v", failure)
	}
	input.Version = content.Version
	input.RootPath = t.TempDir()
	failure = nil
	f.request("PUT", fileURL, input, 409, &failure)
	if failure["code"] == "file_conflict" {
		t.Fatalf("scope change reported as a file conflict: %v", failure)
	}
	f.request("GET", fileURL+"&rootPath="+url.QueryEscape(input.RootPath), nil, 409, nil)
	f.request("GET", fileURL+"&rootPath="+url.QueryEscape(agent.Profile.Roots[0].Path), nil, 200, &content)
	f.request("GET", "/agents/"+agent.ID+"/file?root=root&path=hello.txt", nil, 200, &content)
	if content.Content != "saved 中文\n" {
		t.Fatal("conflicting write changed the file")
	}
	for _, path := range []string{"escape", "../outside.txt"} {
		response := func() int {
			req, _ := http.NewRequest("GET", f.s.URL+"/api/agents/"+agent.ID+"/file?root=root&path="+path, nil)
			req.Header.Set("Authorization", "Bearer "+f.s.Token)
			r, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Body.Close()
			b, _ := io.ReadAll(r.Body)
			if strings.Contains(string(b), "private-outside") {
				t.Fatal("scope escaped")
			}
			return r.StatusCode
		}()
		if response == 200 {
			t.Fatal("scope escape allowed")
		}
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "hello.txt"}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"}} {
		cmd := exec.Command("git", append([]string{"-C", f.root}, args...)...)
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatal(string(b), err)
		}
	}
	os.WriteFile(filepath.Join(f.root, "hello.txt"), []byte("hello changed\n"), 0600)
	var diff model.DiffResult
	f.request("GET", "/agents/"+agent.ID+"/diff?root=root&mode=working", nil, 200, &diff)
	if !strings.Contains(diff.Patch, "+hello changed") {
		t.Fatal("missing Git change")
	}
	response, err := http.Get(f.s.URL + "/api/overview")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("API was unauthenticated")
	}
	req, _ := http.NewRequest("GET", f.s.URL+"/api/overview", nil)
	req.Header.Set("Authorization", "Bearer "+f.s.Token)
	req.Header.Set("Origin", "https://untrusted.example")
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cross-origin request allowed")
	}
	// Replay is durable and ordered even when the browser was disconnected.
	req, _ = http.NewRequest("GET", f.s.URL+"/api/events?after=0", nil)
	req.Header.Set("Authorization", "Bearer "+f.s.Token)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response, err = http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	found := false
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("no durable events replayed")
	}
}

func TestDelegationIsScopedAndIdempotent(t *testing.T) {
	f := newFixture(t)
	parent := f.agent("codex")
	child := f.agent("codex")
	child.Name = "Reviewer"
	child.Profile.Permission = "read_only"
	f.request("PUT", "/agents/"+child.ID, child, 200, &child)
	chat := f.chat(parent)
	initial := f.send(chat.ID, "main", "", "before enabling delegation")
	f.wait(initial.ID, "completed")
	parent.Profile.Delegations = []model.DelegationRule{{AgentID: child.ID, Confirm: true}}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)
	var run model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main",
		Text: fmt.Sprintf("[delegate:%s] review", child.ID), References: []model.Reference{{Kind: "agent", ID: child.ID, Name: child.Name}}}, 200, &run)
	f.wait(run.ID, "waiting_user")
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Requests) != 1 || overview.Requests[0].DelegationAgentID != child.ID {
		t.Fatal("delegation confirmation missing")
	}
	// Saving during an execution must not replace its delegation policy.
	parent.Profile.Delegations = []model.DelegationRule{}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	run = f.wait(run.ID, "completed")
	if !strings.Contains(run.Items[0].Text, "Review the implementation") {
		t.Fatalf("delegation failed: %s", run.Items[0].Text)
	}
	var count int
	if err := f.a.Store.DB.QueryRow("SELECT COUNT(*) FROM delegations WHERE parent_run_id=?", run.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("duplicate delegation")
	}
	f.request("GET", "/overview", nil, 200, &overview)
	childChats := 0
	for _, c := range overview.Chats {
		if c.AgentID == child.ID && c.Source == "delegation" {
			childChats++
		}
	}
	if childChats != 1 {
		t.Fatal("duplicate child chat")
	}
	var links model.ChatDelegations
	f.request("GET", "/chats/"+chat.ID+"/delegations", nil, 200, &links)
	delegated := links.Outgoing[run.ID]
	if len(delegated) != 1 || delegated[0].AgentID != child.ID || delegated[0].Status != "completed" {
		t.Fatalf("delegated run was not linked to its source: %+v", links)
	}
	var receiver model.ChatDelegations
	f.request("GET", "/chats/"+delegated[0].ChatID+"/delegations", nil, 200, &receiver)
	if receiver.Source == nil || receiver.Source.RunID != run.ID || receiver.Source.ChatID != chat.ID {
		t.Fatalf("delegated chat has no source link: %+v", receiver)
	}
	followup := f.send(delegated[0].ChatID, "main", "", "[hang]")
	f.wait(followup.ID, "running")
	f.request("GET", "/chats/"+chat.ID+"/delegations", nil, 200, &links)
	if link := links.Outgoing[run.ID][0]; link.RunID != delegated[0].RunID || link.Status != "completed" {
		t.Fatalf("a later message replaced the original delegation: %+v", link)
	}
	f.request("POST", "/runs/"+followup.ID+"/stop", struct{}{}, 200, nil)
	f.wait(followup.ID, "interrupted")
	next := f.send(chat.ID, "main", "", fmt.Sprintf("[delegate:%s] no longer allowed", child.ID))
	next = f.wait(next.ID, "completed")
	if !strings.Contains(next.Items[0].Text, "Delegation error:") {
		t.Fatal("removed delegation remained enabled for the next execution")
	}
}

func TestNativeSubagentsKeepTheirOwnResultsAndStatus(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent(runtime))
			run := f.send(chat.ID, "main", "", "[subagents]")
			run = f.wait(run.ID, "waiting_user")
			var overview model.Overview
			f.request("GET", "/overview", nil, 200, &overview)
			if len(overview.Requests) != 1 || overview.Requests[0].SubagentID == "" {
				t.Fatalf("child approval did not retain its source: %+v", overview.Requests)
			}
			request := overview.Requests[0]
			f.request("POST", "/requests/"+request.ID+"/answer", model.Answer{Allow: true}, 200, nil)
			run = f.wait(run.ID, "completed")
			var done, unknown, parentReplies int
			for _, item := range run.Items {
				switch {
				case item.Kind == "subagent" && item.ID == request.SubagentID && item.Status == "completed" && item.Text == "Checked both source references.":
					done++
				case item.Kind == "subagent" && item.Status == "unknown" && item.Text == "":
					unknown++
				case item.Kind == "text" && item.Text == "Parent reply after subagents.":
					parentReplies++
				default:
					t.Fatalf("unexpected activity or reply: %+v", item)
				}
			}
			if done != 1 || unknown != 1 || parentReplies != 1 {
				t.Fatalf("wrong timeline: %+v", run.Items)
			}
		})
	}
}

func TestRestartPreservesBindingsAndDoesNotReplayWork(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	run := f.send(chat.ID, "main", "", "durable input")
	run = f.wait(run.ID, "completed")
	ctx := context.Background()
	session, err := store.Get[model.Session](ctx, f.a.Store.DB, "SELECT data FROM sessions WHERE id=?", run.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce a durable execution whose final acknowledgement was never
	// committed, as happens when the backend exits unexpectedly.
	err = f.a.Store.Write(ctx, func(tx *sql.Tx) error {
		run.Status = "running"
		if err := store.SaveRun(tx, run); err != nil {
			return err
		}
		return store.SaveRequest(tx, model.Request{ID: "orphan-request", RunID: run.ID, ChatID: chat.ID, SessionID: session.ID, Kind: "approval", Status: "pending"})
	})
	if err != nil {
		t.Fatal(err)
	}
	f.s.HTTP.Close()
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := app.Open(f.a.Store.Dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	recovered, err := store.Get[model.Run](ctx, reopened.Store.DB, "SELECT data FROM runs WHERE id=?", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Status != "unknown" {
		t.Fatalf("recovered status: %s", recovered.Status)
	}
	bound, err := store.Get[model.Session](ctx, reopened.Store.DB, "SELECT data FROM sessions WHERE id=?", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if bound.NativeID != session.NativeID {
		t.Fatal("restart lost native binding")
	}
	request, err := store.Get[model.Request](ctx, reopened.Store.DB, "SELECT data FROM requests WHERE id='orphan-request'")
	if err != nil {
		t.Fatal(err)
	}
	if request.Status != "expired" {
		t.Fatal("orphan approval was still actionable")
	}
	var count int
	if err := reopened.Store.DB.QueryRow("SELECT COUNT(*) FROM runs").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 || reopened.RunningCount() != 0 {
		t.Fatal("restart replayed work")
	}
}

func TestSkillsRefreshBetweenRuns(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	skill := t.TempDir()
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("version one"), 0600); err != nil {
		t.Fatal(err)
	}
	agent.Profile.Skills = []string{skill}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	chat := f.chat(agent)
	first := f.send(chat.ID, "main", "", "[hang] load skill")
	f.waitNative(first.SessionID)
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("version two"), 0600); err != nil {
		t.Fatal(err)
	}
	pinned := filepath.Join(f.a.Store.Dir, "sessions", first.SessionID, "skills", filepath.Base(skill), "SKILL.md")
	content, err := os.ReadFile(pinned)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "version one" {
		t.Fatal("source mutation changed the running execution's skill")
	}
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "finish current run", Delivery: "steer"}, 200, nil)
	f.wait(first.ID, "completed")
	next := f.send(chat.ID, "main", "", "reload skill")
	f.wait(next.ID, "completed")
	content, err = os.ReadFile(pinned)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "version two" {
		t.Fatal("existing session did not reload current skills")
	}
	agent.Profile.Skills = []string{}
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	next = f.send(chat.ID, "main", "", "remove skill")
	f.wait(next.ID, "completed")
	if _, err := os.Stat(pinned); !os.IsNotExist(err) {
		t.Fatal("removed skill remained in the runtime bundle", err)
	}
}
