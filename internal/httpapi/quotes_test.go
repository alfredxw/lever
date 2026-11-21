package httpapi_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestMessageQuotesPreserveReplyAndRuntimeContext(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	source := f.send(chat.ID, "main", "", "Original message to quote")
	source = f.wait(source.ID, "completed")
	command := model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] My separate reply",
		Quote: &model.MessageQuote{RunID: source.ID, Role: "assistant", Author: "Forged author", Text: "Forged text"},
	}
	var reply model.Run
	f.request("POST", "/messages", command, 200, &reply)
	reply = f.wait(reply.ID, "completed")
	if reply.Input != command.Text || reply.Quote == nil || reply.Quote.Author != agent.Name || reply.Quote.Text != source.Items[0].Text {
		t.Fatalf("reply text or authoritative quote was lost: %+v", reply)
	}
	var receipt struct {
		Input string `json:"input"`
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(reply.Items[0].Text, "wire:")), &receipt); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(receipt.Input, "Quoted message from "+agent.Name) || !strings.Contains(receipt.Input, "> Original message to quote") || !strings.HasSuffix(receipt.Input, command.Text) {
		t.Fatalf("runtime did not receive both quote and reply: %s", receipt.Input)
	}
	var retry model.Run
	f.request("POST", "/messages", command, 200, &retry)
	if retry.ID != reply.ID {
		t.Fatal("retry duplicated a quoted reply")
	}
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if view.Runs[1].Quote == nil || *view.Runs[1].Quote != *reply.Quote {
		t.Fatal("quote did not survive persistence and retrieval")
	}
	command.CommandID, command.Text = app.ID(), "[wire] Continue in Claude"
	command.Selection = &model.Selection{Provider: "claude"}
	command.Quote = &model.MessageQuote{RunID: source.ID, Role: "user"}
	var handoff model.Run
	f.request("POST", "/messages", command, 200, &handoff)
	handoff = f.wait(handoff.ID, "completed")
	if err := json.Unmarshal([]byte(strings.TrimPrefix(handoff.Items[0].Text, "wire:")), &receipt); err != nil {
		t.Fatal(err)
	}
	if !handoff.Handoff || !strings.Contains(receipt.Input, "Quoted message from User:\n> Original message to quote") {
		t.Fatal("runtime handoff dropped the current quote")
	}
	history, err := os.ReadFile(filepath.Join(f.a.Store.Dir, "sessions", reply.SessionID, "history-"+handoff.ID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, line := range bytes.Split(bytes.TrimSpace(history), []byte("\n")) {
		var entry struct {
			User  string              `json:"user"`
			Quote *model.MessageQuote `json:"quote"`
		}
		if err := json.Unmarshal(line, &entry); err != nil {
			t.Fatal(err)
		}
		if entry.User == reply.Input && entry.Quote != nil && *entry.Quote == *reply.Quote {
			found = true
		}
	}
	if !found {
		t.Fatal("runtime handoff dropped the historical quote")
	}
	// Forwarding with no note is valid; bad references fail before starting work.
	other := f.chat(agent)
	command = model.SendInput{CommandID: app.ID(), ChatID: other.ID, Operation: "main", Quote: &model.MessageQuote{RunID: source.ID, Role: "user"}}
	f.request("POST", "/messages", command, 200, &reply)
	reply = f.wait(reply.ID, "completed")
	if reply.Input != "" || reply.Quote.Text != source.Input {
		t.Fatal("quote-only forwarding changed the message")
	}
	for _, quote := range []*model.MessageQuote{{RunID: source.ID, Role: "invalid"}, {RunID: "missing", Role: "user"}} {
		command.CommandID, command.Quote = app.ID(), quote
		f.request("POST", "/messages", command, 400, nil)
	}
}
