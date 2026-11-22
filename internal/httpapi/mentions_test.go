package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func readBoardMention(f *fixture, agent model.Agent, kind, id string) historyResult {
	f.t.Helper()
	var candidates []model.Reference
	f.request("GET", "/tasks/board/references", nil, 200, &candidates)
	i := slices.IndexFunc(candidates, func(ref model.Reference) bool { return ref.Kind == kind && ref.ID == id })
	if i < 0 {
		f.t.Fatal("missing board reference", kind)
	}
	_, got, _ := referencedHistoryTurn(f, f.chat(agent).ID, "main", []model.Reference{candidates[i]},
		historyCall{Name: "read_reference", Arguments: map[string]any{"kind": kind, "id": id}})
	return got[0]
}

func TestMentionedConversationReadsOnlySelectedDialogueForOneTurn(t *testing.T) {
	f := newFixture(t)
	source, dest := f.chat(f.agent("codex")), f.chat(f.agent("codex"))
	main := f.wait(f.send(source.ID, "main", "", "main-only decision").ID, "completed")
	sibling := f.wait(f.send(source.ID, "topic", "", "sibling-only decision").ID, "completed")
	opening := f.wait(f.send(source.ID, "main", "", "topic opening decision").ID, "completed")
	var topic model.SessionView
	f.request("POST", "/chats/"+source.ID+"/topics", map[string]string{"sourceRunId": opening.ID}, 200, &topic)
	read := func(id string) historyCall {
		return historyCall{Name: "read_chat_context", Arguments: map[string]any{"target": id}}
	}
	anchor := read(topic.Session.ID)
	anchor.Arguments["anchor"] = map[string]any{"runId": main.ID}
	refs := []model.Reference{{Kind: "topic", ID: topic.Session.ID, Name: "Selected topic"}}
	_, got, prompt := referencedHistoryTurn(f, dest.ID, "main", refs, read(topic.Session.ID), read(main.SessionID), read(sibling.SessionID), anchor,
		historyCall{Name: "find_chat_context", Arguments: map[string]any{"query": "sibling-only"}})
	if len(got[0].Body.Messages) != 2 || got[0].Body.Messages[0].Text != opening.Input ||
		got[0].Body.Messages[0].SessionID != topic.Session.ID || got[1].Error == "" || got[2].Error == "" || got[3].Error == "" || len(got[4].Body.Matches) != 0 {
		t.Fatalf("unexpected conversation access: %+v", got)
	}
	if !strings.Contains(prompt, "read_chat_context") || strings.Contains(prompt, opening.Input) {
		t.Fatalf("expected a lazy conversation reference in %q", prompt)
	}
	_, got, _ = referencedHistoryTurn(f, dest.ID, "main", []model.Reference{{Kind: "chat", ID: main.SessionID, Name: "Main"}},
		read(main.SessionID), read(sibling.SessionID), read(topic.Session.ID))
	if len(got[0].Body.Messages) != 4 || got[1].Error == "" || got[2].Error == "" {
		t.Fatalf("main and Topic grants were not independent: %+v", got)
	}
	_, got, _ = historyTurn(f, dest.ID, "main", read(main.SessionID))
	if got[0].Error == "" {
		t.Fatal("a later turn inherited the reference")
	}
}

func TestDocumentMentionsResolveCurrentContentAndKeepCardsIsolated(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	taskID, otherID := app.ID(), app.ID()
	doc := func(title string) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"taskId":%q},"content":[{"type":"text","text":%q}]},{"type":"paragraph","content":[{"type":"text","text":"selected detail"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"taskId":%q},"content":[{"type":"text","text":"private sibling task"}]}]}]}]}]}]}`, taskID, title, otherID))
	}
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNote{ID: app.ID(), Title: "Decisions", Content: doc("original title")}, 200, &note)
	var candidates []model.Reference
	f.request("GET", "/tasks/notes/references", nil, 200, &candidates)
	match := slices.IndexFunc(candidates, func(ref model.Reference) bool { return ref.ID == taskID && ref.Kind == "noteTask" })
	if match < 0 || candidates[match].Description != note.Title {
		t.Fatal(candidates)
	}
	note.Content = doc("current title")
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)
	item, err := f.a.CreateWorkItem(context.Background(), agent.ID, nil, model.WorkItemInput{Title: "Review", Body: strings.Repeat("明细", 300)})
	if err != nil {
		t.Fatal(err)
	}
	f.request("GET", "/tasks/board/references", nil, 200, &candidates)
	if !slices.ContainsFunc(candidates, func(ref model.Reference) bool { return ref.ID == item.ID && ref.Kind == "workItem" }) {
		t.Fatal(candidates)
	}
	read := func(kind, id string, offset int) historyCall {
		return historyCall{Name: "read_reference", Arguments: map[string]any{"kind": kind, "id": id, "offset": offset}}
	}
	refs := []model.Reference{{Kind: "noteTask", ID: taskID, Name: "original title"}, {Kind: "workItem", ID: item.ID, Name: item.Title}}
	_, got, prompt := referencedHistoryTurn(f, chat.ID, "main", refs, read("noteTask", taskID, 0), read("note", note.ID, 0),
		read("noteTask", otherID, 0), read("workItem", item.ID, 0), read("workItem", item.ID, 1023), read("workItem", item.ID, 1))
	if got[0].Body.Title != "current title" || got[0].Body.Text != "current title\nselected detail" || got[1].Error == "" || got[2].Error == "" ||
		got[3].Body.NextOffset != 1023 || got[3].Body.Text+got[4].Body.Text != item.Body || got[5].Error == "" || strings.Contains(prompt, "selected detail") {
		t.Fatalf("unexpected reference pages: %+v", got)
	}
	var after model.WorkItem
	f.request("GET", "/tasks/work-items/"+item.ID, nil, 200, &after)
	if after.Done || after.AssigneeAgentID != agent.ID {
		t.Fatal(after)
	}
	ref := model.Reference{Kind: "note", ID: note.ID, Name: note.Title}
	turn, got, _ := referencedHistoryTurn(f, chat.ID, "main", []model.Reference{ref}, read("note", note.ID, 0))
	if !strings.Contains(got[0].Body.Text, "private sibling task") {
		t.Fatal(got)
	}
	f.request("PATCH", "/tasks/notes/"+note.ID, map[string]string{"state": "deleted", "directory": note.Directory}, 200, nil)
	var key string
	if err := f.a.Store.DB.QueryRow("SELECT command_id FROM runs WHERE id=?", turn.ID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	command := model.SendInput{CommandID: key, ChatID: chat.ID, Operation: "main", Text: turn.Input, References: []model.Reference{ref}}
	var replay model.Run
	f.request("POST", "/messages", command, 200, &replay)
	if replay.ID != turn.ID {
		t.Fatal("lost-response retry duplicated the run")
	}
	command.CommandID = app.ID()
	f.request("POST", "/messages", command, 400, nil)
}

func TestAgentMentionsRespectDelegationAndCannotSteer(t *testing.T) {
	f := newFixture(t)
	parent, child := f.agent("codex"), f.agent("codex")
	chat := f.chat(parent)
	ref := model.Reference{Kind: "agent", Name: child.Name, ID: child.ID}
	command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] review", References: []model.Reference{ref}}
	f.request("POST", "/messages", command, 400, nil)
	parent.Profile.Delegations = []model.DelegationRule{{AgentID: child.ID, Confirm: true}}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, nil)
	active := f.wait(f.send(chat.ID, "main", "", "[hang]").ID, "running")
	command.Delivery = "steer"
	f.request("POST", "/messages", command, 409, nil)
	command.Delivery = "queue"
	var queued model.Run
	f.request("POST", "/messages", command, 200, &queued)
	f.request("POST", "/runs/"+queued.ID+"/queue", map[string]string{"action": "send"}, 409, nil)
	if queued.Status != "queued" || queued.SteerRunID != "" {
		t.Fatal(queued)
	}
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "steer", Text: "Finish this turn"}, 200, nil)
	f.wait(active.ID, "completed")
	finished := f.wait(queued.ID, "completed")
	if !strings.Contains(finished.Items[0].Text, "delegate_start") || !strings.Contains(finished.Items[0].Text, child.ID) {
		t.Fatal("missing collaborator instruction in runtime input")
	}
}

func TestMentionChecksRuntimeCapabilityBeforeAcceptingMessagesAndComparisons(t *testing.T) {
	f := newFixture(t)
	owner := f.agent("codex")
	main := f.wait(f.send(f.chat(owner).ID, "main", "", "original discussion").ID, "completed")
	refs := []model.Reference{{Kind: "chat", ID: main.SessionID, Name: "Discussion"}}
	pi := f.piAgent()
	var accepted model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), AgentID: pi.ID, Operation: "main", Text: "Read this", References: refs}, 200, &accepted)
	f.wait(accepted.ID, "completed")
	limitedConfig := model.Provider{PluginID: "lever.pi", ContributionID: "pi", Type: "pi", Name: "Pi without tools", Command: "pi", Args: []string{"--no-tools"}, Enabled: true}
	f.request("POST", "/providers", limitedConfig, 200, &limitedConfig)
	var catalog model.Catalog
	f.request("GET", "/providers/"+limitedConfig.ID+"/models", nil, 200, &catalog)
	if catalog.Capabilities.MCP {
		t.Fatal("disabled Pi tools advertised MCP")
	}
	limited := pi
	limited.ID = ""
	limited.Name = "Limited"
	limited.Profile.Provider = limitedConfig.ID
	f.request("POST", "/agents", limited, 200, &limited)
	input := model.SendInput{CommandID: app.ID(), AgentID: limited.ID, Operation: "main", Text: "Read this", References: refs}
	var rejected map[string]string
	f.request("POST", "/messages", input, 400, &rejected)
	if !strings.Contains(rejected["error"], "MCP support") {
		t.Fatal(rejected)
	}
	f.request("POST", "/comparisons", model.ComparisonInput{CommandID: app.ID(), AgentID: owner.ID, AgentIDs: []string{owner.ID, limited.ID}, Text: "Compare this", References: refs}, 400, nil)
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Chats) != 2 || len(overview.Conversations) != 2 {
		t.Fatal("rejected send created a Chat or Topic")
	}
}
