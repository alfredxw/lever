package httpapi_test

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestChatTopicPagesKeepTheirPositionWhenANewTopicStarts(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	start := func(chatID, text string) string {
		run := f.send(chatID, "topic", "", text)
		f.wait(run.ID, "completed")
		return run.SessionID
	}
	first, second, third, fourth := start(chat.ID, "one"), start(chat.ID, "two"), start(chat.ID, "three"), start(chat.ID, "four")
	page := func(before int64) model.ChatTopicsPage {
		var result model.ChatTopicsPage
		f.request("GET", fmt.Sprintf("/chats/%s/topics/page?limit=2&before=%d", chat.ID, before), nil, 200, &result)
		return result
	}
	head := page(0)
	if len(head.Topics) != 2 || head.Topics[0].ID != fourth || head.Topics[1].ID != third || head.NextBefore == 0 {
		t.Fatalf("first page: %+v", head)
	}
	start(f.chat(agent).ID, "separate chat")
	start(chat.ID, "five")
	tail := page(head.NextBefore)
	if len(tail.Topics) != 2 || tail.Topics[0].ID != second || tail.Topics[1].ID != first || tail.NextBefore != 0 {
		t.Fatalf("continuation: %+v", tail)
	}
}

func TestCreateTopicFromCompletedChatTurn(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	f.wait(f.send(chat.ID, "main", "", "previous-main-turn").ID, "completed")
	file := f.upload(chat.ID, "topic-notes.txt", []byte("source notes"))
	var source model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main",
		Text: "source-topic-question [thinking]", AttachmentIDs: []string{file.ID},
	}, 200, &source)
	source = f.wait(source.ID, "completed")
	f.wait(f.send(chat.ID, "main", "", "later-main-turn").ID, "completed")

	path := "/chats/" + chat.ID + "/topics"
	request := map[string]string{"sourceRunId": source.ID}
	other := f.chat(agent)
	f.request("POST", "/chats/"+other.ID+"/topics", request, 404, nil)
	var topic, again model.SessionView
	f.request("POST", path, request, 200, &topic)
	f.request("POST", path, request, 200, &again)
	if topic.Root != nil || topic.Session.NativeID != "" || topic.Session.Kind != "topic" ||
		topic.Session.ID != again.Session.ID || topic.Session.ID == source.SessionID || topic.Session.SourceRunID != source.ID ||
		!slices.Equal(topic.Session.Roots, agent.Profile.Roots) {
		t.Fatalf("unexpected Topic created from the source turn: %+v", topic)
	}
	if topic.Source == nil || topic.Source.Message.Input != source.Input ||
		!slices.Equal(topic.Source.Message.Attachments, source.Attachments) ||
		len(topic.Source.Items) != 1 || topic.Source.Items[0].Text != "Done." {
		t.Fatalf("Topic source did not preserve the visible dialogue and attachments: %+v", topic.Source)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Runs) != 0 || !slices.ContainsFunc(overview.Conversations, func(item model.Conversation) bool {
		return item.ID == topic.Session.ID && item.Title != "" && item.MessageAt != ""
	}) {
		t.Fatalf("opening a Topic should add activity without starting a run: %+v", overview)
	}
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if len(view.Entries) != 3 || view.Entries[1].RunID != source.ID || view.Entries[1].SessionID != source.SessionID ||
		view.Entries[1].SourceTopicID != topic.Session.ID {
		t.Fatalf("Topic link did not appear on the original turn: %+v", view.Entries)
	}

	var replacement model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", ReplaceRunID: source.ID, Text: "edited-main-turn",
	}, 200, &replacement)
	f.wait(replacement.ID, "completed")
	var main model.SessionView
	f.request("GET", "/sessions/"+source.SessionID, nil, 200, &main)
	var reopened model.SessionView
	f.request("GET", "/sessions/"+topic.Session.ID, nil, 200, &reopened)
	if reopened.Source == nil || reopened.Source.Message.Input != source.Input {
		t.Fatalf("editing the Chat changed the source dialogue: %+v", reopened.Source)
	}
	f.request("POST", path, request, 200, &again)
	if again.Session.ID != topic.Session.ID {
		t.Fatal("retrying after a Chat edit replaced the Topic")
	}

	reply := f.wait(f.send(chat.ID, "reply", topic.Session.ID, "[wire] topic-follow-up").ID, "completed")
	var receipt struct{ Native, Input string }
	if err := json.Unmarshal([]byte(strings.TrimPrefix(reply.Items[0].Text, "wire:")), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Native == "" || receipt.Native == main.Session.NativeID || !reply.Handoff ||
		!strings.Contains(receipt.Input, source.Input) || !strings.Contains(receipt.Input, "Done.") ||
		!strings.Contains(receipt.Input, "topic-notes.txt") || !strings.Contains(receipt.Input, "topic-follow-up") {
		t.Fatalf("first reply did not start with the source dialogue in a new session: %+v", receipt)
	}
	for _, unrelated := range []string{"previous-main-turn", "later-main-turn", "edited-main-turn", "Alternate reasoning"} {
		if strings.Contains(receipt.Input, unrelated) {
			t.Fatalf("unexpected history in the Topic prompt: %q", unrelated)
		}
	}
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if len(view.Entries) != 2 || view.Entries[1].RunID != replacement.ID {
		t.Fatalf("Topic replies changed the main timeline: %+v", view.Entries)
	}
}
