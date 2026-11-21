package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/cli"
	"lever/internal/model"
)

func TestWorkItemsWithLocalCLIAndUnavailableNotes(t *testing.T) {
	f := newFixture(t)
	if err := f.s.StartLocalCLI(nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := f.s.CloseLocalCLI(ctx); err != nil {
			t.Error(err)
		}
	})
	creator, assignee := f.agent("codex"), f.agent("codex")
	archived := f.agent("codex")
	archived.Archived = true
	f.request("PUT", "/agents/"+archived.ID, archived, 200, nil)
	command := func(args []string, out any) error {
		t.Helper()
		var result, diagnostic bytes.Buffer
		handled, err := cli.Run(args, f.a.Store.Dir, &result, &diagnostic)
		if !handled {
			t.Fatalf("CLI did not handle %q", args)
		}
		if err == nil && out != nil {
			err = json.Unmarshal(result.Bytes(), out)
		}
		return err
	}
	var agents []struct{ ID, Name string }
	if err := command([]string{"agent", "list"}, &agents); err != nil {
		t.Fatal(err)
	}
	listed := map[string]string{}
	for _, agent := range agents {
		listed[agent.ID] = agent.Name
	}
	if len(listed) != 2 || listed[creator.ID] != creator.Name || listed[assignee.ID] != assignee.Name {
		t.Fatalf("unexpected CLI Agent list: %+v", agents)
	}
	if err := command([]string{"work-items", "create", "--agent", archived.ID, "--title", "Archived"}, nil); err == nil {
		t.Fatal("CLI allowed a Work Item for an archived Agent")
	}
	const path = "/tasks/work-items"
	f.request("POST", path, model.WorkItemInput{Title: "Follow up"}, http.StatusMethodNotAllowed, nil)
	flags := []string{"work-items", "create", "--agent", creator.ID, "--title", "Follow up", "--body", "Add a timeout check", "--request-key", "follow-up"}
	var item, replay model.WorkItem
	if err := command(flags, &item); err != nil {
		t.Fatal(err)
	}
	if item.AssigneeAgentID != creator.ID || item.CreatedByAgentID != creator.ID || item.Done || item.Origin != nil {
		t.Fatalf("unexpected CLI item: %+v", item)
	}
	if err := command(flags, &replay); err != nil || replay.ID != item.ID {
		t.Fatalf("creation retry made a different item: %+v, %v", replay, err)
	}
	flags[5] = "Different title"
	if err := command(flags, nil); err == nil {
		t.Fatal("CLI allowed reusing a request key with a different title")
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Chats) != 0 {
		t.Fatal("creating a Work Item started a Chat")
	}
	library := filepath.Join(f.a.Store.Dir, "notes")
	if err := os.Rename(library, library+"-unavailable"); err != nil {
		t.Fatal(err)
	}
	f.request("GET", "/tasks/notes", nil, 404, nil)
	var location model.TaskLocation
	f.request("GET", "/tasks/locate/"+item.ID, nil, 200, &location)
	if location.Record != model.TaskRecordWorkItem || location.NoteID != "" {
		t.Fatalf("unexpected work item location: %+v", location)
	}
	var run model.Run
	f.request("POST", path+"/"+item.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: assignee.ID, Note: "[hang]",
	}, 200, &run)
	f.wait(run.ID, "running")
	f.request("PATCH", path+"/"+item.ID, map[string]bool{"done": true}, 409, nil)
	f.request("POST", "/runs/"+run.ID+"/stop", nil, 200, nil)
	f.wait(run.ID, "interrupted")
	f.request("PATCH", path+"/"+item.ID, map[string]bool{"done": true}, 200, nil)
	var items []model.WorkItem
	f.request("GET", path, nil, 200, &items)
	if len(items) != 1 || !items[0].Done || items[0].AssigneeAgentID != assignee.ID || items[0].CreatedByAgentID != creator.ID {
		t.Fatalf("unexpected work items after completion: %+v", items)
	}
	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 1 || executions[0].Record != model.TaskRecordWorkItem || executions[0].RunID != run.ID || !executions[0].Done {
		t.Fatalf("unexpected work item execution: %+v", executions)
	}
}

func TestAgentWorkItemRetainsOriginRun(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	call := historyCall{Name: "work_item_create", Arguments: map[string]any{
		"title": "Add monitoring", "body": "Cover timeouts", "requestKey": "monitoring",
	}}
	run, results, _ := historyTurn(f, chat.ID, "topic", call, call)
	for _, result := range results {
		if result.Error != "" {
			t.Fatal(result.Error)
		}
	}
	var list []model.WorkItem
	f.request("GET", "/tasks/work-items", nil, 200, &list)
	if len(list) != 1 || list[0].CreatedByAgentID != agent.ID || list[0].AssigneeAgentID != agent.ID || list[0].Done {
		t.Fatalf("unexpected Agent work items: %+v", list)
	}
	if origin := list[0].Origin; origin == nil || origin.ChatID != chat.ID || origin.RunID != run.ID || origin.SessionID != run.SessionID || !origin.Topic {
		t.Fatalf("unexpected origin: %+v", origin)
	}
	var readOnly model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "topic",
		Text:      `[chat-context] [{"name":"work_item_create","arguments":{"title":"Do not create","requestKey":"read-only"}}]`,
		Selection: &model.Selection{Provider: "codex", Permission: "read_only"},
	}, 200, &readOnly)
	f.wait(readOnly.ID, "completed")
	f.request("GET", "/tasks/work-items", nil, 200, &list)
	if len(list) != 1 {
		t.Fatal("a read-only execution created a Work Item")
	}
}
