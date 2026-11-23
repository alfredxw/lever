package httpapi_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
	"lever/internal/notes"
)

func TestTaskDispatchChatModes(t *testing.T) {
	t.Setenv("GH_TOKEN", "fixture")
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	const updated = "2026-11-13T06:00:00Z"
	http.DefaultTransport = githubFixture(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "api.github.com" {
			return original.RoundTrip(req)
		}
		h := http.Header{"Date": {time.Date(2026, time.November, 13, 6, 0, 0, 0, time.UTC).Format(http.TimeFormat)}}
		var body string
		switch req.URL.Path {
		case "/repos/example/mode", "/repositories/303":
			body = `{"id":303,"full_name":"example/mode"}`
		case "/repositories/303/issues":
			if req.URL.Query().Get("state") == "open" {
				body = `[{"node_id":"m1","number":1,"updated_at":"` + updated + `","state":"open","title":"Ext single"},` +
					`{"node_id":"m2","number":2,"updated_at":"` + updated + `","state":"open","title":"Ext bySource"},` +
					`{"node_id":"m3","number":3,"updated_at":"` + updated + `","state":"open","title":"Ext newChat"}]`
			} else {
				body = "[]"
			}
		default:
			return &http.Response{StatusCode: 404, Header: h, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		}
		return &http.Response{StatusCode: 200, Header: h, Body: io.NopCloser(strings.NewReader(body))}, nil
	})

	f := newFixture(t)
	agentA, agentB := f.agent("codex"), f.agent("claude")

	// Default setting is "single", and invalid values are rejected.
	var settings model.TaskDispatchSettings
	f.request("GET", "/settings/task-dispatch", nil, 200, &settings)
	if settings.ChatMode != model.TaskChatModeSingle {
		t.Fatalf("expected default task chat mode single, got %+v", settings)
	}
	f.request("PUT", "/settings/task-dispatch", model.TaskDispatchSettings{ChatMode: "bogus"}, 400, nil)

	// Prepare one note with 5 tasks and one external task source with 3 tasks.
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Sprint"}, 200, &note)
	noteTaskTitles := []string{"Note single", "Note pinned single", "Note bySource", "Note newChat", "Note pinned newChat"}
	noteTaskIDs := map[string]string{}
	blocks := make([]notes.Node, 0, len(noteTaskTitles))
	for _, title := range noteTaskTitles {
		id := app.ID()
		noteTaskIDs[title] = id
		blocks = append(blocks, notes.Node{
			Type:    "paragraph",
			Attrs:   []byte(fmt.Sprintf(`{"taskId":%q}`, id)),
			Content: []notes.Node{{Type: "text", Text: title}},
		})
	}
	var err error
	note.Content, err = notes.Content(blocks)
	if err != nil {
		t.Fatal(err)
	}
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)

	var source model.TaskSource
	f.request("POST", "/tasks/sources", map[string]string{
		"pluginId": "lever.github", "contributionId": "github", "target": "example/mode",
	}, 200, &source)
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		var sources []model.TaskSource
		f.request("GET", "/tasks/sources", nil, 200, &sources)
		if len(sources) == 1 && !sources[0].SyncPending && sources[0].LastSyncedAt > 0 && sources[0].Error == "" {
			break
		}
	}
	var extList []model.ExternalTask
	f.request("GET", "/tasks/external", nil, 200, &extList)
	extByTitle := map[string]model.ExternalTask{}
	for _, item := range extList {
		extByTitle[item.Title] = item
	}
	if len(extByTitle) != 3 {
		t.Fatalf("expected 3 external tasks, got %+v", extList)
	}

	// 1. Default "single" mode: workItem, note task, and external task on agentA share ONE "works" Chat with 3 Topics.
	var wiSingle, wiOther model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "WI single"}, 200, &wiSingle)
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "WI agentB"}, 200, &wiOther)

	var wiSingleRun, noteSingleRun, extSingleRun, wiOtherRun model.Run
	f.request("POST", "/tasks/work-items/"+wiSingle.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentA.ID,
	}, 200, &wiSingleRun)
	f.wait(wiSingleRun.ID, "completed")

	f.request("POST", "/tasks/dispatch", model.TaskDispatch{
		TaskID: noteTaskIDs["Note single"], NoteID: note.ID, Version: note.Version,
		CommandID: app.ID(), AgentID: agentA.ID, Title: "Note single", Text: "Note single body",
	}, 200, &noteSingleRun)
	f.wait(noteSingleRun.ID, "completed")

	f.request("POST", "/tasks/external/"+extByTitle["Ext single"].ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentA.ID,
	}, 200, &extSingleRun)
	f.wait(extSingleRun.ID, "completed")

	f.request("POST", "/tasks/work-items/"+wiOther.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentB.ID,
	}, 200, &wiOtherRun)
	f.wait(wiOtherRun.ID, "completed")

	if noteSingleRun.ChatID != wiSingleRun.ChatID || extSingleRun.ChatID != wiSingleRun.ChatID {
		t.Fatalf("single mode did not share one works Chat: wi=%s note=%s ext=%s", wiSingleRun.ChatID, noteSingleRun.ChatID, extSingleRun.ChatID)
	}
	if wiSingleRun.SessionID == noteSingleRun.SessionID || noteSingleRun.SessionID == extSingleRun.SessionID || wiSingleRun.SessionID == extSingleRun.SessionID {
		t.Fatal("single mode tasks did not open distinct Topics")
	}
	if wiOtherRun.ChatID == wiSingleRun.ChatID {
		t.Fatal("different Agents shared a works Chat")
	}
	var worksChat model.ChatView
	f.request("GET", "/chats/"+wiSingleRun.ChatID, nil, 200, &worksChat)
	if worksChat.Chat.Source != "works" || worksChat.Chat.Title != "Works" || len(worksChat.Sessions) != 3 {
		t.Fatalf("unexpected unified works Chat: %+v", worksChat)
	}

	// Explicit NoteHandover.ChatID still overrides "single" mode.
	pinnedChat := f.chat(agentA)
	f.request("PUT", "/tasks/notes/"+note.ID+"/handover", model.NoteHandover{
		AgentID: agentA.ID, ChatID: pinnedChat.ID,
	}, 200, nil)
	var pinnedSingleRun model.Run
	f.request("POST", "/tasks/dispatch", model.TaskDispatch{
		TaskID: noteTaskIDs["Note pinned single"], NoteID: note.ID, Version: note.Version,
		CommandID: app.ID(), AgentID: agentA.ID, Title: "Note pinned single", Text: "Pinned single body",
	}, 200, &pinnedSingleRun)
	f.wait(pinnedSingleRun.ID, "completed")
	if pinnedSingleRun.ChatID != pinnedChat.ID || pinnedSingleRun.Operation != "topic" {
		t.Fatalf("explicit note handover did not override single mode: %+v", pinnedSingleRun)
	}
	f.request("PUT", "/tasks/notes/"+note.ID+"/handover", model.NoteHandover{}, 200, nil)

	// 2. "bySource" mode: workItem, note, and external source each get their own dedicated Chat + Topic.
	f.request("PUT", "/settings/task-dispatch", model.TaskDispatchSettings{ChatMode: model.TaskChatModeBySource}, 200, &settings)
	if settings.ChatMode != model.TaskChatModeBySource {
		t.Fatalf("expected bySource mode, got %+v", settings)
	}
	var wiBySource model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "WI bySource"}, 200, &wiBySource)

	var wiBySourceRun, noteBySourceRun, extBySourceRun model.Run
	f.request("POST", "/tasks/work-items/"+wiBySource.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentA.ID,
	}, 200, &wiBySourceRun)
	f.wait(wiBySourceRun.ID, "completed")

	f.request("POST", "/tasks/dispatch", model.TaskDispatch{
		TaskID: noteTaskIDs["Note bySource"], NoteID: note.ID, Version: note.Version,
		CommandID: app.ID(), AgentID: agentA.ID, Title: "Note bySource", Text: "Note bySource body",
	}, 200, &noteBySourceRun)
	f.wait(noteBySourceRun.ID, "completed")

	f.request("POST", "/tasks/external/"+extByTitle["Ext bySource"].ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentA.ID,
	}, 200, &extBySourceRun)
	f.wait(extBySourceRun.ID, "completed")

	if wiBySourceRun.ChatID == wiSingleRun.ChatID || wiBySourceRun.ChatID == noteBySourceRun.ChatID ||
		noteBySourceRun.ChatID == extBySourceRun.ChatID || wiBySourceRun.ChatID == extBySourceRun.ChatID {
		t.Fatalf("bySource mode did not isolate per-source Chats: wi=%s note=%s ext=%s works=%s",
			wiBySourceRun.ChatID, noteBySourceRun.ChatID, extBySourceRun.ChatID, wiSingleRun.ChatID)
	}
	var wiChat, noteChat, extChat model.ChatView
	f.request("GET", "/chats/"+wiBySourceRun.ChatID, nil, 200, &wiChat)
	f.request("GET", "/chats/"+noteBySourceRun.ChatID, nil, 200, &noteChat)
	f.request("GET", "/chats/"+extBySourceRun.ChatID, nil, 200, &extChat)
	if wiChat.Chat.Source != "workItem" || wiChat.Chat.Title != "Work items" || wiChat.Sessions[0].Kind != "topic" {
		t.Fatalf("unexpected bySource workItem Chat: %+v", wiChat)
	}
	if noteChat.Chat.Source != "note" || noteChat.Chat.NoteID != note.ID || noteChat.Chat.Title != "Sprint" || noteChat.Sessions[0].Kind != "topic" {
		t.Fatalf("unexpected bySource note Chat: %+v", noteChat)
	}
	if extChat.Chat.Source != "taskSource" || extChat.Chat.TaskSourceID != source.ID || extChat.Chat.Title != "example/mode" || extChat.Sessions[0].Kind != "topic" {
		t.Fatalf("unexpected bySource external Chat: %+v", extChat)
	}

	// 3. "newChat" mode: each task creates a standalone source="task" Chat with main session,
	//    origin-linked work items remain non-intrusive with a conversation Reference,
	//    and explicit NoteHandover.ChatID still overrides "newChat".
	f.request("PUT", "/settings/task-dispatch", model.TaskDispatchSettings{ChatMode: model.TaskChatModeNewChat}, 200, &settings)
	if settings.ChatMode != model.TaskChatModeNewChat {
		t.Fatalf("expected newChat mode, got %+v", settings)
	}

	originChat := f.chat(agentA)
	originRun := f.wait(f.send(originChat.ID, "main", "", "origin context for newChat mode").ID, "completed")
	var wiNewChat model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{
		Title:       "WI newChat",
		OriginRunID: originRun.ID,
	}, 200, &wiNewChat)

	var wiNewRun, noteNewRun, extNewRun model.Run
	f.request("POST", "/tasks/work-items/"+wiNewChat.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentA.ID,
	}, 200, &wiNewRun)
	wiNewDone := f.wait(wiNewRun.ID, "completed")

	f.request("POST", "/tasks/dispatch", model.TaskDispatch{
		TaskID: noteTaskIDs["Note newChat"], NoteID: note.ID, Version: note.Version,
		CommandID: app.ID(), AgentID: agentA.ID, Title: "Note newChat", Text: "Note newChat body",
	}, 200, &noteNewRun)
	f.wait(noteNewRun.ID, "completed")

	f.request("POST", "/tasks/external/"+extByTitle["Ext newChat"].ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agentA.ID,
	}, 200, &extNewRun)
	f.wait(extNewRun.ID, "completed")

	if wiNewRun.ChatID == originChat.ID || wiNewRun.ChatID == noteNewRun.ChatID || noteNewRun.ChatID == extNewRun.ChatID {
		t.Fatalf("newChat mode did not create standalone Chats: wi=%s note=%s ext=%s origin=%s",
			wiNewRun.ChatID, noteNewRun.ChatID, extNewRun.ChatID, originChat.ID)
	}
	if len(wiNewDone.References) != 1 || wiNewDone.References[0].Kind != "chat" || wiNewDone.References[0].ID != originRun.SessionID {
		t.Fatalf("origin-linked work item in newChat mode lost its origin Reference: %+v", wiNewDone.References)
	}
	for label, check := range map[string]struct {
		chatID string
		taskID string
		title  string
	}{
		"workItem": {wiNewRun.ChatID, wiNewChat.ID, "WI newChat"},
		"note":     {noteNewRun.ChatID, noteTaskIDs["Note newChat"], "Note newChat"},
		"external": {extNewRun.ChatID, extByTitle["Ext newChat"].ID, "Ext newChat"},
	} {
		var view model.ChatView
		f.request("GET", "/chats/"+check.chatID, nil, 200, &view)
		if view.Chat.Source != "task" || view.Chat.TaskID != check.taskID || view.Chat.Title != check.title ||
			len(view.Sessions) != 1 || view.Sessions[0].Kind != "main" {
			t.Fatalf("unexpected newChat view for %s: %+v", label, view)
		}
	}

	// Explicit NoteHandover.ChatID still overrides "newChat" mode.
	f.request("PUT", "/tasks/notes/"+note.ID+"/handover", model.NoteHandover{
		AgentID: agentA.ID, ChatID: pinnedChat.ID,
	}, 200, nil)
	var pinnedNewRun model.Run
	f.request("POST", "/tasks/dispatch", model.TaskDispatch{
		TaskID: noteTaskIDs["Note pinned newChat"], NoteID: note.ID, Version: note.Version,
		CommandID: app.ID(), AgentID: agentA.ID, Title: "Note pinned newChat", Text: "Pinned newChat body",
	}, 200, &pinnedNewRun)
	f.wait(pinnedNewRun.ID, "completed")
	if pinnedNewRun.ChatID != pinnedChat.ID || pinnedNewRun.Operation != "topic" {
		t.Fatalf("explicit note handover did not override newChat mode: %+v", pinnedNewRun)
	}
}

func TestTaskDispatchModelSelection(t *testing.T) {
	f := newFixture(t)
	var agent model.Agent
	f.request("POST", "/agents", model.Agent{
		Name: "Custom Codex",
		Profile: model.Profile{
			Provider:     "codex",
			Model:        "gpt-5.3-codex",
			Permission:   "full_access",
			Instructions: "profile-v1",
			Scope:        model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"},
			Skills:       []string{},
			Delegations:  []model.DelegationRule{},
		},
	}, 200, &agent)

	// 1. Direct dispatch with same-provider model/effort override inherits Profile permission (full_access).
	var item1 model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Same provider model override"}, 200, &item1)
	cmd1 := app.ID()
	sameProviderSel := &model.Selection{Provider: "codex", Model: "gpt-5.4", Effort: "high", Fast: true}
	var run1 model.Run
	f.request("POST", "/tasks/work-items/"+item1.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: cmd1, AgentID: agent.ID, Selection: sameProviderSel,
	}, 200, &run1)
	done1 := f.wait(run1.ID, "completed")
	if done1.Selection.Provider != "codex" || done1.Selection.Model != "gpt-5.4" ||
		done1.Selection.Effort != "high" || !done1.Selection.Fast || done1.Selection.Permission != "full_access" {
		t.Fatalf("unexpected same-provider selection resolution: %+v", done1.Selection)
	}

	// Idempotency: identical retry returns the same run, changing Selection returns 409.
	var replay model.Run
	f.request("POST", "/tasks/work-items/"+item1.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: cmd1, AgentID: agent.ID, Selection: sameProviderSel,
	}, 200, &replay)
	if replay.ID != run1.ID {
		t.Fatalf("idempotent retry returned different run: %s vs %s", replay.ID, run1.ID)
	}
	f.request("POST", "/tasks/work-items/"+item1.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: cmd1, AgentID: agent.ID, Selection: &model.Selection{Provider: "codex", Model: "gpt-5.3-codex"},
	}, 409, nil)

	// 2. Direct dispatch switching provider uses the new provider's safe default permission (accept_edits), not full_access.
	var item2 model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Cross provider override"}, 200, &item2)
	var run2 model.Run
	f.request("POST", "/tasks/work-items/"+item2.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: agent.ID,
		Selection: &model.Selection{Provider: "claude", Model: "claude-opus-4-6", Effort: "medium"},
	}, 200, &run2)
	done2 := f.wait(run2.ID, "completed")
	if done2.Selection.Provider != "claude" || done2.Selection.Model != "claude-opus-4-6" ||
		done2.Selection.Effort != "medium" || done2.Selection.Permission != "accept_edits" || done2.Handoff {
		t.Fatalf("unexpected cross-provider task selection: %+v handoff=%v", done2.Selection, done2.Handoff)
	}

	// 3. Direct note dispatch also honors Selection.
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Models"}, 200, &note)
	noteTaskID := app.ID()
	note.Content = json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","attrs":{"taskId":%q},"content":[{"type":"text","text":"Note model task"}]}]}`, noteTaskID))
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)
	var noteRun model.Run
	f.request("POST", "/tasks/dispatch", model.TaskDispatch{
		TaskID: noteTaskID, NoteID: note.ID, Version: note.Version, CommandID: app.ID(),
		AgentID: agent.ID, Title: "Note model task", Text: "Run with chosen model",
		Selection: &model.Selection{Provider: "claude", Model: "claude-sonnet-4-6"},
	}, 200, &noteRun)
	noteDone := f.wait(noteRun.ID, "completed")
	if noteDone.Selection.Provider != "claude" || noteDone.Selection.Model != "claude-sonnet-4-6" || noteDone.Selection.Permission != "accept_edits" {
		t.Fatalf("note dispatch did not honor selection: %+v", noteDone.Selection)
	}

	// 4. Queued task validates Selection at enqueue time and preserves it across restart.
	paused := true
	f.request("PATCH", "/agents/"+agent.ID+"/task-queue", model.AgentTaskQueueSettings{TaskQueuePaused: &paused}, 200, nil)

	var badItem, queuedItem model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Bad provider"}, 200, &badItem)
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Queued model survival"}, 200, &queuedItem)

	f.request("POST", "/tasks/queue", model.TaskQueueInput{
		Record: model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{
			TaskID: badItem.ID, AgentID: agent.ID, CommandID: app.ID(),
			Selection: &model.Selection{Provider: "nonexistent-provider", Model: "foo"},
		},
	}, 400, nil)

	f.request("POST", "/tasks/queue", model.TaskQueueInput{
		Record: model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{
			TaskID: queuedItem.ID, AgentID: agent.ID, CommandID: app.ID(),
			Selection: &model.Selection{Provider: "claude", Model: "claude-opus-4-6", Effort: "high"},
		},
	}, 200, nil)

	// Restart App to confirm queued Selection survives SQLite persistence.
	dataDir := f.a.Store.Dir
	_ = f.s.HTTP.Close()
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := app.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	server, err := httpapi.New(reopened, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("Lever")}})
	if err != nil {
		t.Fatal(err)
	}
	go server.Serve()
	t.Cleanup(func() { server.HTTP.Close() })
	next := &fixture{t: t, a: reopened, s: server, root: f.root}

	paused = false
	next.request("PATCH", "/agents/"+agent.ID+"/task-queue", model.AgentTaskQueueSettings{TaskQueuePaused: &paused}, 200, nil)
	exec := next.waitForTask(queuedItem.ID, "completed")
	var view model.ChatView
	next.request("GET", "/chats/"+exec.ChatID, nil, 200, &view)
	var queuedRun *model.Run
	for i := range view.Runs {
		if view.Runs[i].ID == exec.RunID {
			queuedRun = &view.Runs[i]
			break
		}
	}
	if queuedRun == nil || queuedRun.Selection.Provider != "claude" ||
		queuedRun.Selection.Model != "claude-opus-4-6" || queuedRun.Selection.Effort != "high" ||
		queuedRun.Selection.Permission != "accept_edits" {
		t.Fatalf("queued task lost its selection after restart: %+v", queuedRun)
	}
}
