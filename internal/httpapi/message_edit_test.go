package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestEditSentMessageReplacesOnlyItsConversationSuffix(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	first := f.wait(f.send(chat.ID, "main", "", "retained-prefix").ID, "completed")
	file := f.upload(chat.ID, "edit-notes.txt", []byte("original attachment"))
	path := filepath.Join(f.root, "reference.txt")
	if err := os.WriteFile(path, []byte("current workspace file"), 0600); err != nil {
		t.Fatal(err)
	}
	command := model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "original-edit-target",
		AttachmentIDs: []string{file.ID},
		References:    []model.Reference{{Kind: "file", Name: "reference.txt", Path: path}},
		Quote:         &model.MessageQuote{RunID: first.ID, Role: "user"},
	}
	var original model.Run
	f.request("POST", "/messages", command, 200, &original)
	original = f.wait(original.ID, "completed")
	topic := f.wait(f.send(chat.ID, "topic", "", "independent-topic").ID, "completed")
	later := f.wait(f.send(chat.ID, "main", "", "[hang] superseded-suffix").ID, "running")
	queued := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "queued-draft", Delivery: "queue"}
	var pending model.Run
	f.request("POST", "/messages", queued, 200, &pending)
	edit := command
	edit.CommandID, edit.ReplaceRunID, edit.Text = app.ID(), original.ID, "[wire] revised-edit-target"
	f.request("POST", "/messages", edit, 409, nil)
	f.request("POST", "/runs/"+later.ID+"/stop", nil, 200, nil)
	f.wait(later.ID, "interrupted")
	badEdit := edit
	badEdit.AttachmentIDs = []string{app.ID()}
	f.request("POST", "/messages", badEdit, 404, nil)
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if len(view.Entries) != 4 || view.Entries[1].RunID != original.ID || view.Entries[3].RunID != later.ID {
		t.Fatalf("a rejected edit changed the conversation: %+v", view.Entries)
	}
	var before model.SessionView
	f.request("GET", "/sessions/"+first.SessionID, nil, 200, &before)

	var replacement model.Run
	f.request("POST", "/messages", edit, 200, &replacement)
	replacement = f.wait(replacement.ID, "completed")
	if replacement.ID == original.ID || replacement.Sequence != original.Sequence || replacement.SessionID != first.SessionID || replacement.CreatedAt == original.CreatedAt ||
		!replacement.Handoff || len(replacement.Attachments) != 1 || replacement.Attachments[0].ID != file.ID ||
		len(replacement.References) != 1 || replacement.References[0].Path != path || replacement.Quote == nil || *replacement.Quote != *original.Quote {
		t.Fatalf("replacement lost the prompt metadata or position: %+v", replacement)
	}
	var receipt struct{ Native, Input string }
	if err := json.Unmarshal([]byte(strings.TrimPrefix(replacement.Items[0].Text, "wire:")), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Native == "" || receipt.Native == before.Session.NativeID || !strings.Contains(receipt.Input, first.Input) ||
		!strings.Contains(receipt.Input, edit.Text) || strings.Contains(receipt.Input, original.Input) ||
		strings.Contains(receipt.Input, "superseded-suffix") || strings.Contains(receipt.Input, topic.Input) {
		t.Fatalf("replacement used the wrong native context: %+v", receipt)
	}
	history, err := os.ReadFile(filepath.Join(f.a.Store.Dir, "sessions", first.SessionID, "history-"+replacement.ID+".jsonl"))
	if err != nil || !bytes.Contains(history, []byte(first.Input)) || bytes.Count(bytes.TrimSpace(history), []byte("\n")) != 0 {
		t.Fatalf("handoff history did not contain only the retained turn: %s (%v)", history, err)
	}
	if content, err := os.ReadFile(path); err != nil || string(content) != "current workspace file" {
		t.Fatalf("editing modified the workspace: %q (%v)", content, err)
	}

	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if len(view.Entries) != 3 || view.Entries[0].RunID != first.ID || view.Entries[1].RunID != replacement.ID || view.Entries[2].RunID != topic.ID {
		t.Fatalf("edit changed the mixed timeline order: %+v", view.Entries)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Runs) != 1 || overview.Runs[0].ID != pending.ID || overview.Runs[0].Status != "queued" {
		t.Fatalf("edit changed the paused queue: %+v", overview.Runs)
	}
	var matches []model.MessageMatch
	f.request("GET", "/search/messages?query="+url.QueryEscape(original.Input), nil, 200, &matches)
	if len(matches) != 0 {
		t.Fatalf("search returned the original prompt: %+v", matches)
	}
	f.request("GET", "/search/messages?query=revised-edit-target", nil, 200, &matches)
	if len(matches) != 1 || matches[0].RunID != replacement.ID {
		t.Fatalf("search did not return the replacement: %+v", matches)
	}

	var replay model.Run
	f.request("POST", "/messages", edit, 200, &replay)
	if replay.ID != replacement.ID {
		t.Fatal("retry created another replacement")
	}
	f.request("POST", "/messages", command, 200, &replay)
	if replay.ID != original.ID || replay.Status != "completed" || !replay.Superseded {
		t.Fatal("retrying the original send resurrected its old turn")
	}
	edit.CommandID = app.ID()
	f.request("POST", "/messages", edit, 409, nil)
	f.request("POST", "/runs/"+later.ID+"/retry", map[string]string{"commandId": app.ID()}, 409, nil)
	f.request("POST", "/sessions/"+first.SessionID+"/queue/resume", nil, 200, nil)
	f.wait(pending.ID, "completed")
}
