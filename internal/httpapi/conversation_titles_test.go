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

func TestAntigravityNativeConversationTitles(t *testing.T) {
	for _, mode := range []struct {
		name string
		open func(string) (*app.App, error)
	}{
		{"embedded", app.Open},
		{"worker", app.OpenServer},
	} {
		t.Run(mode.name, func(t *testing.T) {
			f := openFixture(t, mode.open).withLocalProviders()
			agent := f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"})

			// 1. Live session_info_update names both main chats and topics, and later
			// turns do not overwrite an already-applied title.
			chat := f.chat(agent)
			f.wait(f.send(chat.ID, "main", "", "Title fixture: 实时会话标题").ID, "completed")
			var overview model.Overview
			f.request("GET", "/overview", nil, 200, &overview)
			if overview.Chats[0].Title != "实时会话标题" || overview.Conversations[0].Title != "实时会话标题" {
				t.Fatalf("live native title missing: chats=%+v convs=%+v", overview.Chats, overview.Conversations)
			}
			f.wait(f.send(chat.ID, "main", "", "Title fixture: 后续不覆盖").ID, "completed")
			f.request("GET", "/overview", nil, 200, &overview)
			if overview.Chats[0].Title != "实时会话标题" {
				t.Fatalf("follow-up turn overwrote chat title: %q", overview.Chats[0].Title)
			}

			topic := f.wait(f.send(chat.ID, "topic", "", "Title fixture: 子话题摘要").ID, "completed")
			var topics []model.TopicSummary
			f.request("GET", "/chats/"+chat.ID+"/topics", nil, 200, &topics)
			var sessionView model.SessionView
			f.request("GET", "/sessions/"+topic.SessionID, nil, 200, &sessionView)
			if len(topics) != 1 || topics[0].Title != "子话题摘要" || sessionView.Session.Title != "子话题摘要" {
				t.Fatalf("topic native title mismatch: topics=%+v session=%+v", topics, sessionView.Session)
			}
			f.request("GET", "/overview", nil, 200, &overview)
			if overview.Chats[0].Title != "实时会话标题" {
				t.Fatalf("topic changed main chat title: %q", overview.Chats[0].Title)
			}

			// Editing the topic root starts a fresh native session and applies its new title.
			var replacement model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, ReplaceRunID: topic.ID, Text: "Title fixture: 修订话题"}, 200, &replacement)
			f.wait(replacement.ID, "completed")
			f.request("GET", "/sessions/"+topic.SessionID, nil, 200, &sessionView)
			if sessionView.Session.Title != "修订话题" {
				t.Fatalf("edited topic title = %q, want 修订话题", sessionView.Session.Title)
			}

			// 2. When turn 1 ends before a title arrives, session_info_update emitted
			// before activation on turn 2 resume backfills the unnamed placeholder.
			resumedChat := f.chat(agent)
			first := f.wait(f.send(resumedChat.ID, "main", "", "Resume title fixture: 恢复补全标题").ID, "completed")
			var chatView model.ChatView
			f.request("GET", "/chats/"+resumedChat.ID, nil, 200, &chatView)
			if chatView.Chat.Title != store.ChatTitle(first) {
				t.Fatalf("unexpected title before resume: %q", chatView.Chat.Title)
			}
			f.wait(f.send(resumedChat.ID, "main", "", "Follow up on resumed session").ID, "completed")
			f.request("GET", "/chats/"+resumedChat.ID, nil, 200, &chatView)
			if chatView.Chat.Title != "恢复补全标题" {
				t.Fatalf("resume did not backfill chat title: %q", chatView.Chat.Title)
			}

			// 3. A chat seeded by a topic must not be hijacked by a main-session update,
			// and resuming that topic backfills both the topic and the chat.
			topicFirstChat := f.chat(agent)
			firstTopic := f.wait(f.send(topicFirstChat.ID, "topic", "", "Resume title fixture: 话题归属").ID, "completed")
			f.wait(f.send(topicFirstChat.ID, "main", "", "Title fixture: 主对话不抢占").ID, "completed")
			f.request("GET", "/chats/"+topicFirstChat.ID, nil, 200, &chatView)
			if chatView.Chat.Title != store.ChatTitle(firstTopic) {
				t.Fatalf("main turn hijacked topic-owned chat title: %q", chatView.Chat.Title)
			}
			f.wait(f.send(topicFirstChat.ID, "reply", firstTopic.SessionID, "Continue topic").ID, "completed")
			f.request("GET", "/chats/"+topicFirstChat.ID, nil, 200, &chatView)
			f.request("GET", "/sessions/"+firstTopic.SessionID, nil, 200, &sessionView)
			if chatView.Chat.Title != "话题归属" || sessionView.Session.Title != "话题归属" {
				t.Fatalf("topic resume did not backfill chat/topic: chat=%q topic=%q", chatView.Chat.Title, sessionView.Session.Title)
			}

			// 4. Explicit names and manual renames are never overwritten by native titles.
			var explicit model.Chat
			f.request("POST", "/chats", map[string]string{"agentId": agent.ID, "title": "自定名称"}, 200, &explicit)
			f.wait(f.send(explicit.ID, "main", "", "Title fixture: 忽略标题").ID, "completed")
			f.request("GET", "/chats/"+explicit.ID, nil, 200, &chatView)
			if chatView.Chat.Title != "自定名称" || !chatView.Chat.TitleIsCustom {
				t.Fatalf("explicit title overwritten: %+v", chatView.Chat)
			}

			renamed := f.chat(agent)
			f.wait(f.send(renamed.ID, "main", "", "Resume title fixture: 待重命名").ID, "completed")
			f.request("PUT", "/chats/"+renamed.ID+"/title", map[string]string{"title": "手动改名"}, 200, nil)
			f.wait(f.send(renamed.ID, "main", "", "Continue after rename").ID, "completed")
			f.request("GET", "/chats/"+renamed.ID, nil, 200, &chatView)
			if chatView.Chat.Title != "手动改名" || !chatView.Chat.TitleIsCustom {
				t.Fatalf("manual rename overwritten on resume: %+v", chatView.Chat)
			}
		})
	}
}

func TestAntigravityNativeConversationTitlesToggle(t *testing.T) {
	for _, mode := range []struct {
		name string
		open func(string) (*app.App, error)
	}{
		{"embedded", app.Open},
		{"worker", app.OpenServer},
	} {
		t.Run(mode.name, func(t *testing.T) {
			f := openFixture(t, mode.open).withLocalProviders()

			var providers []model.ProviderInfo
			f.request("GET", "/providers", nil, 200, &providers)
			findProvider := func(id string) model.Provider {
				for _, item := range providers {
					if item.ID == id {
						return item.Provider
					}
				}
				t.Fatalf("provider %q not found", id)
				return model.Provider{}
			}

			// Non-ACP runtimes reject nativeTitles configuration; ACP runtimes accept it.
			for _, id := range []string{"codex", "claude", "pi"} {
				p := findProvider(id)
				p.NativeTitles = new(false)
				f.request("POST", "/providers", p, 400, nil)
			}
			dsh := findProvider("dsh")
			dsh.NativeTitles = new(false)
			f.request("POST", "/providers", dsh, 200, &dsh)
			if dsh.UsesNativeTitles() {
				t.Fatalf("acp provider nativeTitles did not save as disabled: %+v", dsh)
			}

			// Disabling nativeTitles on Antigravity is a mutable preference (no 409)
			// and keeps the opening-message placeholder for both live and resume updates.
			agy := findProvider("antigravity")
			agy.NativeTitles = new(false)
			f.request("POST", "/providers", agy, 200, &agy)
			if agy.UsesNativeTitles() {
				t.Fatalf("antigravity nativeTitles did not save as disabled: %+v", agy)
			}

			agent := f.acpAgent(model.Provider{ID: "antigravity", Name: "Antigravity"})
			chat := f.chat(agent)
			first := f.wait(f.send(chat.ID, "main", "", "Title fixture: English Summary").ID, "completed")
			var chatView model.ChatView
			f.request("GET", "/chats/"+chat.ID, nil, 200, &chatView)
			if chatView.Chat.Title != store.ChatTitle(first) {
				t.Fatalf("disabled native titles overwrote chat title: got %q, want %q", chatView.Chat.Title, store.ChatTitle(first))
			}

			topic := f.wait(f.send(chat.ID, "topic", "", "Title fixture: English Topic").ID, "completed")
			var sessionView model.SessionView
			f.request("GET", "/sessions/"+topic.SessionID, nil, 200, &sessionView)
			if sessionView.Session.Title != "" {
				t.Fatalf("disabled native titles overwrote topic title: %q", sessionView.Session.Title)
			}

			resumedChat := f.chat(agent)
			resumedFirst := f.wait(f.send(resumedChat.ID, "main", "", "Resume title fixture: English Resume").ID, "completed")
			followUpDisabled := f.wait(f.send(resumedChat.ID, "main", "", "Continue while disabled").ID, "completed")
			if followUpDisabled.Handoff {
				t.Fatalf("unexpected handoff while disabled: %+v", followUpDisabled)
			}
			f.request("GET", "/chats/"+resumedChat.ID, nil, 200, &chatView)
			if chatView.Chat.Title != store.ChatTitle(resumedFirst) {
				t.Fatalf("disabled native titles backfilled on resume: got %q, want %q", chatView.Chat.Title, store.ChatTitle(resumedFirst))
			}

			// Re-enabling nativeTitles preserves existing sessions and resumes applying native titles.
			agy.NativeTitles = nil
			f.request("POST", "/providers", agy, 200, &agy)
			if !agy.UsesNativeTitles() {
				t.Fatalf("antigravity nativeTitles did not re-enable: %+v", agy)
			}
			followUpEnabled := f.wait(f.send(resumedChat.ID, "main", "", "Continue after re-enabling").ID, "completed")
			if followUpEnabled.Handoff {
				t.Fatalf("toggling nativeTitles broke native session binding: %+v", followUpEnabled)
			}
			f.request("GET", "/chats/"+resumedChat.ID, nil, 200, &chatView)
			if chatView.Chat.Title != "English Resume" {
				t.Fatalf("re-enabled native titles did not backfill on resume: %q", chatView.Chat.Title)
			}
		})
	}
}
