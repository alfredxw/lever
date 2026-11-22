package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestWorkItemDispatchUsesDedicatedChatTopicAndOriginReference(t *testing.T) {
	f := newFixture(t)
	owner, other := f.agent("codex"), f.agent("claude")

	// 1. Multiple standalone work items on the same Agent share one dedicated "workItem" Chat with separate Topics.
	var firstItem, secondItem, otherItem model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "First board item", Body: "Detail one"}, 200, &firstItem)
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Second board item", Body: "Detail two"}, 200, &secondItem)
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Other agent item"}, 200, &otherItem)

	var firstRun model.Run
	f.request("POST", "/tasks/work-items/"+firstItem.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: owner.ID,
	}, 200, &firstRun)
	f.wait(firstRun.ID, "completed")

	f.request("POST", "/tasks/queue", model.TaskQueueInput{
		Record: model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{
			TaskID: secondItem.ID, AgentID: owner.ID, CommandID: app.ID(),
		},
	}, 200, nil)
	secondExec := f.waitForTask(secondItem.ID, "completed")

	var otherRun model.Run
	f.request("POST", "/tasks/work-items/"+otherItem.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: other.ID,
	}, 200, &otherRun)
	f.wait(otherRun.ID, "completed")

	if !secondExec.Topic || secondExec.ChatID != firstRun.ChatID || secondExec.SessionID == firstRun.SessionID {
		t.Fatalf("work items on the same Agent did not share one Chat with distinct Topics: first=%+v second=%+v", firstRun, secondExec)
	}
	if otherRun.ChatID == firstRun.ChatID {
		t.Fatal("different Agents shared a workItem Chat")
	}
	var ownerChat model.ChatView
	f.request("GET", "/chats/"+firstRun.ChatID, nil, 200, &ownerChat)
	if ownerChat.Chat.Source != "workItem" || ownerChat.Chat.Title != "Work items" || ownerChat.Chat.TaskID != "" || len(ownerChat.Sessions) != 2 {
		t.Fatalf("unexpected dedicated workItem Chat: %+v", ownerChat)
	}
	titles := map[string]string{}
	for _, s := range ownerChat.Sessions {
		if s.Kind != "topic" || s.TaskID == "" {
			t.Fatalf("expected task Topic session: %+v", s)
		}
		titles[s.TaskID] = s.Title
	}
	if titles[firstItem.ID] != firstItem.Title || titles[secondItem.ID] != secondItem.Title {
		t.Fatalf("unexpected Topic titles: %+v", titles)
	}

	// 2. Origin-linked work items (from main or topic) do not disturb the origin Chat,
	//    and instead attach a conversation Reference readable via read_chat_context.
	originChat := f.chat(owner)
	mainSeed := f.wait(f.send(originChat.ID, "main", "", "main origin secret context").ID, "completed")
	topicSeed := f.wait(f.send(originChat.ID, "topic", "", "topic origin secret context").ID, "completed")

	var topicOriginItem, mainOriginItem model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{
		Title:       "[chat-context]",
		OriginRunID: topicSeed.ID,
	}, 200, &topicOriginItem)
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{
		Title:       "[chat-context]",
		OriginRunID: mainSeed.ID,
	}, 200, &mainOriginItem)

	var beforeOrigin model.ChatView
	f.request("GET", "/chats/"+originChat.ID, nil, 200, &beforeOrigin)

	readPair := func(allowID, denyID string) string {
		calls, err := json.Marshal([]historyCall{
			{Name: "read_chat_context", Arguments: map[string]any{"target": allowID}},
			{Name: "read_chat_context", Arguments: map[string]any{"target": denyID}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return string(calls)
	}

	var topicOriginRun model.Run
	f.request("POST", "/tasks/work-items/"+topicOriginItem.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: owner.ID, Note: readPair(topicSeed.SessionID, mainSeed.SessionID),
	}, 200, &topicOriginRun)
	topicOriginRun = f.wait(topicOriginRun.ID, "completed")

	var mainOriginRun model.Run
	f.request("POST", "/tasks/work-items/"+mainOriginItem.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: owner.ID, Note: readPair(mainSeed.SessionID, topicSeed.SessionID),
	}, 200, &mainOriginRun)
	mainOriginRun = f.wait(mainOriginRun.ID, "completed")

	if topicOriginRun.ChatID != firstRun.ChatID || mainOriginRun.ChatID != firstRun.ChatID {
		t.Fatalf("origin work items should land in the Agent's dedicated workItem Chat, not originChat=%s: topic=%s main=%s",
			originChat.ID, topicOriginRun.ChatID, mainOriginRun.ChatID)
	}
	var afterOrigin model.ChatView
	f.request("GET", "/chats/"+originChat.ID, nil, 200, &afterOrigin)
	if afterOrigin.Chat.UpdatedAt != beforeOrigin.Chat.UpdatedAt || len(afterOrigin.Entries) != len(beforeOrigin.Entries) {
		t.Fatalf("dispatching origin work items disturbed originChat: before=(%s,%d) after=(%s,%d)",
			beforeOrigin.Chat.UpdatedAt, len(beforeOrigin.Entries), afterOrigin.Chat.UpdatedAt, len(afterOrigin.Entries))
	}

	checkOriginRef := func(run model.Run, wantKind, wantSessionID, wantText string) {
		t.Helper()
		if len(run.References) != 1 || run.References[0].Kind != wantKind || run.References[0].ID != wantSessionID || run.References[0].Name == "" {
			t.Fatalf("expected %s reference to %s, got %+v", wantKind, wantSessionID, run.References)
		}
		var receipt struct {
			Input   string
			Results []historyResult
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "context:")), &receipt); err != nil {
			t.Fatalf("runtime did not return a history receipt: %s", run.Items[0].Text)
		}
		if !strings.Contains(receipt.Input, "read_chat_context") || len(receipt.Results) != 2 {
			t.Fatalf("unexpected receipt: %+v", receipt)
		}
		if len(receipt.Results[0].Body.Messages) == 0 || !strings.Contains(receipt.Results[0].Body.Messages[0].Text, wantText) {
			t.Fatalf("origin reference did not grant access to %q: %+v", wantText, receipt.Results[0])
		}
		if receipt.Results[1].Error == "" {
			t.Fatalf("sibling session in origin Chat was unexpectedly readable: %+v", receipt.Results[1])
		}
	}
	checkOriginRef(topicOriginRun, "topic", topicSeed.SessionID, "topic origin secret context")
	checkOriginRef(mainOriginRun, "chat", mainSeed.SessionID, "main origin secret context")

	// 3. Cross-provider compatibility: dispatching an origin-linked work item to a non-MCP runtime
	//    still succeeds cleanly and omits the MCP-only conversation reference.
	limitedConfig := model.Provider{
		PluginID: "lever.pi", ContributionID: "pi", Type: "pi",
		Name: "Pi no-tools for work items", Command: "pi", Args: []string{"--no-tools"}, Enabled: true,
	}
	f.request("POST", "/providers", limitedConfig, 200, &limitedConfig)
	var catalog model.Catalog
	f.request("GET", "/providers/"+limitedConfig.ID+"/models", nil, 200, &catalog)
	if catalog.Capabilities.MCP {
		t.Fatal("disabled Pi tools advertised MCP")
	}
	limited := f.piAgent()
	limited.ID = ""
	limited.Name = "Limited Pi"
	limited.Profile.Provider = limitedConfig.ID
	f.request("POST", "/agents", limited, 200, &limited)

	var nonMCPItem model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{
		Title:       "Non-MCP origin item",
		Body:        "Should run without MCP reference",
		OriginRunID: topicSeed.ID,
	}, 200, &nonMCPItem)
	var nonMCPRun model.Run
	f.request("POST", "/tasks/work-items/"+nonMCPItem.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: limited.ID,
	}, 200, &nonMCPRun)
	nonMCPRun = f.wait(nonMCPRun.ID, "completed")
	if len(nonMCPRun.References) != 0 {
		t.Fatalf("expected non-MCP runtime to omit conversation reference, got %+v", nonMCPRun.References)
	}
}

func TestUserWorkItemsCreateAndUpdate(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	other := f.agent("codex")
	archived := f.agent("codex")
	archived.Archived = true
	f.request("PUT", "/agents/"+archived.ID, archived, 200, nil)

	const path = "/tasks/work-items"
	f.request("POST", path, model.UserWorkItemCreate{Title: "   "}, 400, nil)
	f.request("POST", path, model.UserWorkItemCreate{Title: "Bad prio", Priority: "extreme"}, 400, nil)
	f.request("POST", path, model.UserWorkItemCreate{Title: "Archived", AssigneeAgentID: archived.ID}, 409, nil)

	var item model.WorkItem
	f.request("POST", path, model.UserWorkItemCreate{
		Title:           "Quick board item",
		Body:            "Created directly from Works",
		Project:         "lever",
		Priority:        model.WorkItemPriorityHigh,
		AssigneeAgentID: agent.ID,
	}, 200, &item)
	if item.ID == "" || item.CreatedByAgentID != "" || item.AssigneeAgentID != agent.ID || item.Project != "lever" || item.Priority != model.WorkItemPriorityHigh || item.Done {
		t.Fatalf("unexpected user work item: %+v", item)
	}

	// Update metadata before dispatch.
	newTitle := "Renamed work item"
	newProject := "desktop"
	newPriority := model.WorkItemPriorityUrgent
	f.request("PATCH", path+"/"+item.ID, model.WorkItemUpdate{
		Title:           &newTitle,
		Project:         &newProject,
		Priority:        &newPriority,
		AssigneeAgentID: &other.ID,
	}, 200, &item)
	if item.Title != newTitle || item.Project != newProject || item.Priority != newPriority || item.AssigneeAgentID != other.ID {
		t.Fatalf("unexpected updated work item: %+v", item)
	}

	// Empty update is rejected.
	f.request("PATCH", path+"/"+item.ID, model.WorkItemUpdate{}, 400, nil)

	// Once dispatched, assignee cannot be reassigned directly via PATCH.
	var run model.Run
	f.request("POST", path+"/"+item.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(), AgentID: other.ID, Note: "[hang]",
	}, 200, &run)
	f.wait(run.ID, "running")
	f.request("PATCH", path+"/"+item.ID, model.WorkItemUpdate{AssigneeAgentID: &agent.ID}, 409, nil)
	f.request("POST", "/runs/"+run.ID+"/stop", nil, 200, nil)
	f.wait(run.ID, "interrupted")
}
