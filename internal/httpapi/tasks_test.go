package httpapi_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/notes"
)

func TestTaskDispatchUsesSavedNoteAndKeepsTopicLink(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	newNote := func(title string) model.TaskNote {
		t.Helper()
		input := model.TaskNoteSummary{ID: app.ID(), Title: title}
		var note model.TaskNote
		f.request("POST", "/tasks/notes", input, 200, &note)
		return note
	}
	note, other := newNote("Work"), newNote("Ideas")
	taskID := app.ID()
	content := func(title string, done bool) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","attrs":{"taskId":%q,"done":%t},"content":[{"type":"text","text":%q}]}]}`, taskID, done, title))
	}
	draft := note
	draft.Content = content("Check search", false)
	f.request("PUT", "/tasks/notes/"+note.ID, draft, 200, &note)
	f.request("PUT", "/tasks/notes/"+note.ID, draft, 200, nil)
	draft.Title = "Other window"
	f.request("PUT", "/tasks/notes/"+note.ID, draft, 409, nil)
	other.Content = note.Content
	f.request("PUT", "/tasks/notes/"+other.ID, other, 409, nil)

	input := model.TaskDispatch{
		TaskID: taskID, NoteID: note.ID, Version: draft.Version, CommandID: app.ID(),
		AgentID: agent.ID, Title: "Check search", Text: "Check search\n\nSteps to reproduce",
	}
	f.request("POST", "/tasks/dispatch", input, 409, nil)
	input.Version = note.Version
	var run model.Run
	f.request("POST", "/tasks/dispatch", input, 200, &run)
	f.wait(run.ID, "completed")

	note.Content = content("Search checklist", true)
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)
	var replay model.Run
	f.request("POST", "/tasks/dispatch", input, 200, &replay)
	if replay.ID != run.ID || replay.ChatID != run.ChatID {
		t.Fatalf("retry created a different execution: %#v", replay)
	}
	note.Content = content("Search checklist", false)
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)
	input.CommandID, input.Version = app.ID(), note.Version
	f.request("POST", "/tasks/dispatch", input, 409, nil)
	note.Content = content("Search checklist", true)
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)

	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 1 || executions[0].ChatID != run.ChatID ||
		!executions[0].Topic || executions[0].SessionID != run.SessionID ||
		executions[0].Status != "completed" || !executions[0].Done || executions[0].NoteID != note.ID {
		t.Fatalf("wrong task execution after acceptance: %#v", executions)
	}
	library := filepath.Join(f.a.Store.Dir, "notes")
	original := filepath.Join(library, filepath.FromSlash(note.Path))
	moved := filepath.Join(library, "Archive", "Renamed.xml")
	if err := os.Mkdir(filepath.Dir(moved), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(original, moved); err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(moved)
	if err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(string(onDisk), "Search checklist", "Edited externally", 1)
	if edited == string(onDisk) {
		t.Fatal("saved note text is missing from the XML")
	}
	if err := os.WriteFile(moved, []byte(edited), 0600); err != nil {
		t.Fatal(err)
	}
	stale := note
	stale.Title = "Stale draft"
	f.request("PUT", "/tasks/notes/"+note.ID, stale, 409, nil)
	f.request("GET", "/tasks/notes/"+note.ID, nil, 200, &note)
	if note.Path != "Archive/Renamed.xml" || !strings.Contains(string(note.Content), "Edited externally") {
		t.Fatalf("missing external note change: %#v", note)
	}

	var source model.TaskLocation
	f.request("GET", "/tasks/locate/"+taskID, nil, 200, &source)
	if source.NoteID != note.ID {
		t.Fatalf("task links to the wrong note: %#v", source)
	}
	var chat model.ChatView
	f.request("GET", "/chats/"+run.ChatID, nil, 200, &chat)
	if chat.Chat.Source != "works" || chat.Chat.Title != "Works" || len(chat.Sessions) != 1 ||
		chat.Sessions[0].Kind != "topic" || chat.Sessions[0].TaskID != taskID || chat.Sessions[0].Title != "Check search" ||
		len(chat.Runs) != 1 || chat.Runs[0].Input != input.Text {
		t.Fatalf("editing the note changed the Chat or its input: %#v", chat)
	}
	if chat.Runs[0].FinishedAt == "" || executions[0].DispatchedAt != chat.Sessions[0].CreatedAt ||
		executions[0].ActivityAt != chat.Runs[0].FinishedAt {
		t.Fatalf("task activity does not reflect the Chat and finished run: %#v", executions[0])
	}
}

func TestNoteHandoverReusesChatAndKeepsQueuedDestination(t *testing.T) {
	f := newFixture(t)
	agent, other := f.agent("codex"), f.agent("claude")
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Release"}, 200, &note)
	path := "/tasks/notes/" + note.ID
	titles := []string{"First", "Queued", "Follow-up", "Other Agent"}
	ids := make(map[string]string)
	blocks := make([]notes.Node, 0, len(titles))
	for _, title := range titles {
		id := app.ID()
		ids[title] = id
		blocks = append(blocks, notes.Node{Type: "paragraph", Attrs: []byte(fmt.Sprintf(`{"taskId":%q}`, id)), Content: []notes.Node{{Type: "text", Text: title}}})
	}
	var err error
	note.Content, err = notes.Content(blocks)
	if err != nil {
		t.Fatal(err)
	}
	f.request("PUT", path, note, 200, &note)
	queue := func(agentID, title, text string) {
		t.Helper()
		f.request("POST", "/tasks/queue", model.TaskQueueInput{
			Record: model.TaskRecordNote, TaskDispatch: model.TaskDispatch{
				TaskID: ids[title], NoteID: note.ID, Version: note.Version, AgentID: agentID,
				CommandID: app.ID(), Title: title, Text: text,
			},
		}, 200, nil)
	}
	queue(agent.ID, "First", "[approval]")
	first := f.waitForTask(ids["First"], "waiting_user")
	existing := f.chat(agent)
	settings := model.NoteHandover{AgentID: other.ID, ChatID: existing.ID, OneClick: true}
	f.request("PUT", path+"/handover", settings, 400, nil)
	settings.AgentID = agent.ID
	f.request("PUT", path+"/handover", settings, 200, nil)
	var saved model.NoteHandover
	f.request("GET", path+"/handover", nil, 200, &saved)
	if saved != settings {
		t.Fatalf("saved handover settings: %+v", saved)
	}
	queue(agent.ID, "Queued", "Queued for the existing Chat")
	if f.taskWorkflow(ids["Queued"]).Queue == nil {
		t.Fatal("queued task started before the first task left the queue slot")
	}
	queue(other.ID, "Other Agent", "Use the selected Agent's own Chat")
	separate := f.waitForTask(ids["Other Agent"], "completed")
	if !separate.Topic || separate.ChatID == existing.ID || separate.ChatID == first.ChatID || separate.AgentID != other.ID {
		t.Fatalf("Agent override did not resolve its own Chat: %+v", separate)
	}

	f.request("PUT", path+"/handover", model.NoteHandover{}, 200, nil)
	queue(agent.ID, "Follow-up", "Use the dedicated Chat again")
	f.request("POST", "/runs/"+first.RunID+"/stop", nil, 200, nil)
	pinned := f.waitForTask(ids["Queued"], "completed")
	again := f.waitForTask(ids["Follow-up"], "completed")
	if !pinned.Topic || pinned.ChatID != existing.ID {
		t.Fatalf("queued handover changed destination: %+v", pinned)
	}
	if !first.Topic || !again.Topic || again.ChatID != first.ChatID || again.SessionID == first.SessionID {
		t.Fatalf("handover did not reuse the note Chat with a new Topic: %+v and %+v", first, again)
	}
	reply := f.send(again.ChatID, "reply", again.SessionID, deliverTask)
	if delivered := f.wait(reply.ID, "completed"); delivered.Task == nil || delivered.Task.ID != ids["Follow-up"] || !delivered.TaskCompletionRequested {
		t.Fatalf("Topic follow-up lost its task binding: %+v", delivered)
	}
	// The Note writeback runs after the completed run is persisted.
	for deadline := time.Now().Add(2 * time.Second); ; {
		f.request("GET", path, nil, 200, &note)
		_, markers, err := notes.ParseContent(note.Content)
		if err != nil || markers[ids["First"]].Done {
			t.Fatalf("Topic completion changed the wrong note block: %v, %v", markers, err)
		}
		if markers[ids["Follow-up"]].Done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Topic completion did not reach the assigned note block")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTaskDispatchSendsOwnedImages(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Screenshots"}, 200, &note)
	path := "/tasks/notes/" + note.ID
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	picture := func(asset app.NoteAsset) notes.Node {
		t.Helper()
		attrs, err := json.Marshal(asset)
		if err != nil {
			t.Fatal(err)
		}
		return notes.Node{Type: "noteAsset", Attrs: attrs}
	}
	upload := func(name string, data []byte) app.NoteAsset {
		t.Helper()
		asset, err := f.a.SaveNoteAsset(t.Context(), note.ID, name, data)
		if err != nil || !asset.Image {
			t.Fatalf("save %s: %#v, %v", name, asset, err)
		}
		return asset
	}
	first, second := upload("before.png", png), upload("after.png", png)
	outside, nested := upload("unrelated.png", png), upload("subtask.png", png)
	tooLarge := make([]byte, (5<<20)+1)
	copy(tooLarge, png)
	large := upload("too-large.png", tooLarge)
	taskID, subtaskID := app.ID(), app.ID()
	title := func(text, id string) notes.Node {
		return notes.Node{Type: "paragraph", Attrs: []byte(fmt.Sprintf(`{"taskId":%q}`, id)), Content: []notes.Node{{Type: "text", Text: text}}}
	}
	child := notes.Node{Type: "bulletList", Content: []notes.Node{{Type: "listItem", Content: []notes.Node{title("Subtask", subtaskID), picture(nested)}}}}
	save := func(extra ...notes.Node) {
		t.Helper()
		body := []notes.Node{title("Compare the screenshots", taskID), picture(first), picture(second), child}
		list := notes.Node{Type: "bulletList", Content: []notes.Node{{Type: "listItem", Content: append(body, extra...)}}}
		note.Content, err = notes.Content([]notes.Node{list, picture(outside)})
		if err != nil {
			t.Fatal(err)
		}
		f.request("PUT", path, note, 200, &note)
	}
	input := model.TaskDispatch{
		TaskID: taskID, NoteID: note.ID, CommandID: app.ID(), AgentID: agent.ID,
		Title: "Compare the screenshots", Text: "[wire] Compare the screenshots",
	}
	for _, rejected := range []app.NoteAsset{
		{Path: ".assets/" + strings.Repeat("0", 64), Name: "missing.png", Image: true},
		large,
	} {
		save(picture(rejected))
		input.Version = note.Version
		var failure map[string]string
		f.request("POST", "/tasks/dispatch", input, 400, &failure)
		if !strings.Contains(failure["error"], rejected.Name) {
			t.Fatalf("dispatch did not identify the rejected image: %v", failure)
		}
		entries, err := os.ReadDir(filepath.Join(f.a.Store.Dir, "attachments"))
		if err != nil && !errors.Is(err, os.ErrNotExist) || len(entries) != 0 {
			t.Fatalf("dispatch left attachment files after rejection: %v, %v", entries, err)
		}
	}

	save()
	input.Version = note.Version
	var run model.Run
	f.request("POST", "/tasks/dispatch", input, 200, &run)
	run = f.wait(run.ID, "completed")
	if len(run.Attachments) != 2 || run.Attachments[0].Name != first.Name || run.Attachments[1].Name != second.Name {
		t.Fatalf("wrong task attachments: %#v", run.Attachments)
	}
	var receipt struct {
		Images int    `json:"images"`
		Input  string `json:"input"`
	}
	if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &receipt) != nil ||
		receipt.Images != 2 || !strings.Contains(receipt.Input, input.Text) {
		t.Fatalf("runtime did not receive the text and both images: %#v", run.Items)
	}
	if err := os.Remove(filepath.Join(f.a.Store.Dir, "notes", filepath.FromSlash(first.Path))); err != nil {
		t.Fatal(err)
	}
	var replay model.Run
	f.request("POST", "/tasks/dispatch", input, 200, &replay)
	if replay.ID != run.ID || len(replay.Attachments) != 2 {
		t.Fatalf("dispatch replay did not return the accepted run: %#v", replay)
	}
	for i, file := range replay.Attachments {
		data, err := os.ReadFile(f.a.AttachmentPath(file))
		if err != nil || !bytes.Equal(data, png) || file.ID != run.Attachments[i].ID || file.ChatID != run.ChatID {
			t.Fatalf("missing Chat snapshot %s: %#v, %v", file.Name, file, err)
		}
	}
}
