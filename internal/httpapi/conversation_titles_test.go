package httpapi_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/store"
)

func waitForTitle(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for conversation title")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestConversationTitleReachesListsAfterReply(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent(runtime))
			gate := filepath.Join(f.root, "hold-title")
			if err := os.WriteFile(gate, nil, 0600); err != nil {
				t.Fatal(err)
			}
			first := f.wait(f.send(chat.ID, "main", "", "Title fixture: 会话命名").ID, "completed")
			f.wait(f.send(chat.ID, "main", "", "A later unrelated message").ID, "completed")
			waitForTitle(t, func() bool { _, err := os.Stat(filepath.Join(f.root, "title-requested")); return err == nil })
			var before model.Overview
			f.request("GET", "/overview", nil, 200, &before)
			if before.Chats[0].Title != first.Input {
				t.Fatalf("pending title = %q", before.Chats[0].Title)
			}
			if err := os.Remove(gate); err != nil {
				t.Fatal(err)
			}
			waitForTitle(t, func() bool {
				var after model.Overview
				f.request("GET", "/overview", nil, 200, &after)
				if after.Chats[0].Title != "会话命名" || after.Conversations[0].Title != "会话命名" {
					return false
				}
				want := before.Conversations[0]
				want.Title = "会话命名"
				if after.Conversations[0] != want {
					t.Fatalf("title altered message activity: got %+v, want %+v", after.Conversations[0], want)
				}
				return true
			})
			topic := f.wait(f.send(chat.ID, "topic", "", "Title fixture: 子话题").ID, "completed")
			waitForTitle(t, func() bool {
				var topics []model.TopicSummary
				f.request("GET", "/chats/"+chat.ID+"/topics", nil, 200, &topics)
				return len(topics) == 1 && topics[0].Title == "子话题"
			})
			var view model.SessionView
			f.request("GET", "/sessions/"+topic.SessionID, nil, 200, &view)
			var overview model.Overview
			f.request("GET", "/overview", nil, 200, &overview)
			if view.Session.Title != "子话题" || overview.Chats[0].Title != "会话命名" {
				t.Fatalf("topic = %q, chat = %q", view.Session.Title, overview.Chats[0].Title)
			}
		})
	}
}

func TestConversationTitleProtectsEditedRootsAndExplicitNames(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	prefix := strings.Repeat("同", 40)
	first := f.wait(f.send(chat.ID, "topic", "", "Title fixture: "+prefix+"原稿").ID, "completed")
	sessionTitle := func() string {
		var view model.SessionView
		f.request("GET", "/sessions/"+first.SessionID, nil, 200, &view)
		return view.Session.Title
	}
	waitForTitle(t, func() bool { return sessionTitle() == prefix+"原稿" })
	gate := filepath.Join(f.root, "hold-title")
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	var replacement model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, ReplaceRunID: first.ID, Text: "Title fixture: " + prefix + "修订"}, 200, &replacement)
	f.wait(replacement.ID, "completed")
	// While the replacement is still being named, both roots have the exact
	// same placeholder. Only its originating run can change it.
	if err := f.a.Store.SaveConversationTitle(t.Context(), first, "Stale"); err != nil {
		t.Fatal(err)
	}
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if sessionTitle() != "" || view.Chat.Title != store.ChatTitle(first) || view.Chat.Title != store.ChatTitle(replacement) {
		t.Fatalf("stale title won, topic = %q, chat = %q", sessionTitle(), view.Chat.Title)
	}
	if err := os.Remove(gate); err != nil {
		t.Fatal(err)
	}
	waitForTitle(t, func() bool { return sessionTitle() == prefix+"修订" })
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if view.Chat.Title != prefix+"修订" {
		t.Fatalf("first topic did not name its chat: %q", view.Chat.Title)
	}
	for _, name := range []string{"New chat", "Title fixture: Explicit"} {
		var named model.Chat
		f.request("POST", "/chats", map[string]string{"agentId": agent.ID, "title": name}, 200, &named)
		run := f.wait(f.send(named.ID, "main", "", "Title fixture: Explicit").ID, "completed")
		if needed, err := f.a.Store.NeedsConversationTitle(t.Context(), run); err != nil || needed {
			t.Fatalf("explicit title %q requested naming: %t, %v", name, needed, err)
		}
		f.request("GET", "/chats/"+named.ID, nil, 200, &view)
		if view.Chat.Title != name {
			t.Fatalf("explicit title = %q, want %q", view.Chat.Title, name)
		}
	}
}

func TestRenameChatAndTopicAcrossLateTitleAndRootEdit(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	first := f.wait(f.send(chat.ID, "topic", "", "Title fixture: Original topic").ID, "completed")
	main := f.wait(f.send(chat.ID, "main", "", "Main message").ID, "completed")
	other := f.chat(agent)
	var before model.Overview
	f.request("GET", "/overview", nil, 200, &before)
	path := "/chats/" + chat.ID + "/title"
	f.request("PUT", path, map[string]string{"title": "  New chat  "}, 200, nil)
	f.request("PUT", path, map[string]string{"title": "自定话题", "topicId": first.SessionID}, 200, nil)
	f.request("PUT", path, map[string]string{"title": "  "}, 400, nil)
	f.request("PUT", path, map[string]string{"title": strings.Repeat("名", 121)}, 400, nil)
	f.request("PUT", path, map[string]string{"title": "wrong", "topicId": main.SessionID}, 404, nil)
	f.request("PUT", "/chats/"+other.ID+"/title", map[string]string{"title": "wrong", "topicId": first.SessionID}, 404, nil)
	if err := f.a.Store.SaveConversationTitle(t.Context(), first, "Late title"); err != nil {
		t.Fatal(err)
	}
	var after model.Overview
	f.request("GET", "/overview", nil, 200, &after)
	got := make(map[string]model.Conversation)
	for _, c := range after.Conversations {
		got[c.ID] = c
	}
	for _, want := range before.Conversations {
		if want.ID == first.SessionID {
			want.Title = "自定话题"
		} else {
			want.Title = "New chat"
		}
		if got[want.ID] != want {
			t.Fatalf("rename changed activity: got %+v, want %+v", got[want.ID], want)
		}
	}
	var replacement model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, ReplaceRunID: first.ID, Text: "Title fixture: Replacement"}, 200, &replacement)
	f.wait(replacement.ID, "completed")
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	var topics []model.TopicSummary
	f.request("GET", "/chats/"+chat.ID+"/topics", nil, 200, &topics)
	if view.Chat.Title != "New chat" || !view.Chat.TitleIsCustom || len(topics) != 1 || topics[0].Title != "自定话题" {
		t.Fatalf("unexpected titles after editing the root: chat=%+v topics=%+v", view.Chat, topics)
	}
}
