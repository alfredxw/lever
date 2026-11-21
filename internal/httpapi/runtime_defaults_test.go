package httpapi_test

import (
	"encoding/json"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestRuntimeDefaultsAndChatPermissionOverrides(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			agent := f.agent(runtime)
			defaultPermission, override, other, otherDefault, invalidPermission := "read_only", "full_access", "claude", "accept_edits", "accept_edits"
			if runtime == "claude" {
				defaultPermission, other, otherDefault, invalidPermission = "accept_edits", "codex", "auto_review", "read_only"
			}
			agent.Profile.Permission = defaultPermission
			agent.Profile.Model = "profile-model"
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			firstChat, secondChat := f.chat(agent), f.chat(agent)
			send := func(chat model.Chat, selection *model.Selection) model.Run {
				t.Helper()
				var run model.Run
				f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] runtime settings", Selection: selection}, 200, &run)
				return f.wait(run.ID, "completed")
			}
			wire := func(run model.Run) map[string]any {
				t.Helper()
				var value map[string]any
				if len(run.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "wire:")), &value) != nil {
					t.Fatalf("missing runtime receipt: %+v", run)
				}
				return value
			}
			assertPolicy := func(run model.Run, permission string) map[string]any {
				t.Helper()
				if run.Selection.Permission != permission {
					t.Fatalf("permission not persisted: %+v", run.Selection)
				}
				value := wire(run)
				if run.Selection.Provider == "codex" {
					approval, sandbox, reviewer := "on-request", "workspace-write", "user"
					if permission == "read_only" {
						approval, sandbox = "never", "read-only"
					} else if permission == "full_access" {
						approval, sandbox = "never", "danger-full-access"
					} else if permission == "auto_review" {
						reviewer = "auto_review"
					}
					if value["approval"] != approval || value["sandbox"] != sandbox || value["reviewer"] != reviewer {
						t.Fatalf("Codex received the wrong native policy: %+v", value)
					}
				} else {
					mode := map[string]string{"ask": "default", "accept_edits": "acceptEdits", "auto": "auto", "plan": "plan", "dont_ask": "dontAsk", "full_access": "bypassPermissions"}[permission]
					if value["permission"] != mode {
						t.Fatalf("Claude received the wrong native policy: %+v", value)
					}
				}
				return value
			}
			first := send(firstChat, nil)
			initial := assertPolicy(first, defaultPermission)
			if initial["model"] != "profile-model" {
				t.Fatal("new Chat did not inherit its model")
			}
			changed := send(firstChat, &model.Selection{Provider: runtime, Model: "chat-model", Permission: override})
			if value := assertPolicy(changed, override); value["native"] != initial["native"] || value["model"] != "chat-model" {
				t.Fatal("changing permissions/model should resume the same native session", value)
			}
			assertPolicy(send(firstChat, nil), override)
			// Old clients can omit permission without resetting an existing Chat.
			assertPolicy(send(firstChat, &model.Selection{Provider: runtime, Model: "chat-model"}), override)
			if value := assertPolicy(send(firstChat, &model.Selection{Provider: runtime, Model: "chat-model", Permission: defaultPermission}), defaultPermission); value["native"] != initial["native"] {
				t.Fatal("lowering permissions reset the native session")
			}
			assertPolicy(send(secondChat, nil), defaultPermission)
			// A provider switch cannot inherit an incompatible or elevated policy.
			switched := send(firstChat, &model.Selection{Provider: other, Model: "other-model"})
			assertPolicy(switched, otherDefault)
			if !switched.Handoff || switched.SessionID != first.SessionID {
				t.Fatal("provider change did not preserve the logical Chat")
			}
			if runtime == "claude" {
				for _, mode := range []string{"auto", "plan", "dont_ask"} {
					assertPolicy(send(secondChat, &model.Selection{Provider: runtime, Model: "profile-model", Permission: mode}), mode)
				}
				assertPolicy(send(secondChat, &model.Selection{Provider: runtime, Model: "profile-model", Permission: defaultPermission}), defaultPermission)
			}
			// Defaults only initialize new sessions; existing choices stay intact.
			agent.Profile.Permission = "ask"
			agent.Profile.Model = "new-default-model"
			agent.Profile.Instructions = strings.Repeat("规则", 800) + "updated instructions"
			agent.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "new-root", Path: t.TempDir()}}, PrimaryRootID: "new-root"}
			f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
			value := assertPolicy(send(secondChat, nil), defaultPermission)
			if value["instructions"] != agent.Profile.Instructions || value["cwd"] != initial["cwd"] || value["model"] != "profile-model" {
				t.Fatal("existing session did not combine current instructions with its own settings", value)
			}
			fresh := assertPolicy(send(f.chat(agent), nil), "ask")
			if fresh["model"] != "new-default-model" || fresh["cwd"] != agent.Profile.Roots[0].Path {
				t.Fatal("new session did not use current defaults", fresh)
			}
			var view model.ChatView
			f.request("GET", "/chats/"+secondChat.ID, nil, 200, &view)
			if view.Sessions[0].Selection.Permission != defaultPermission || view.Sessions[0].Selection.Model != "profile-model" {
				t.Fatal("Agent defaults changed the conversation's settings")
			}
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: secondChat.ID, Operation: "main", Text: "invalid", Selection: &model.Selection{Provider: runtime, Permission: invalidPermission}}, 400, nil)
			agent.Profile.Permission = invalidPermission
			f.request("PUT", "/agents/"+agent.ID, agent, 400, nil)
		})
	}
}

func TestPermissionChangesWaitForTheNextTurn(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent(runtime))
			active := f.send(chat.ID, "main", "", "[hang] keep current permissions")
			f.wait(active.ID, "running")
			input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] new permissions", Delivery: "steer", Selection: &model.Selection{Provider: runtime, Permission: "full_access"}}
			f.request("POST", "/messages", input, 409, nil)
			input.Delivery = "queue"
			var queued model.Run
			f.request("POST", "/messages", input, 200, &queued)
			if queued.Status != "queued" || queued.Selection.Permission != "full_access" {
				t.Fatal("permission change was not durably queued")
			}
			f.request("POST", "/runs/"+queued.ID+"/queue", map[string]string{"action": "send"}, 409, nil)
			var view model.ChatView
			f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
			if view.Sessions[0].Selection.Permission != "ask" {
				t.Fatal("queued permission change affected the active execution")
			}
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "finish now", Delivery: "steer"}, 200, nil)
			f.wait(active.ID, "completed")
			completed := f.wait(queued.ID, "completed")
			if completed.Selection.Permission != "full_access" || completed.Handoff {
				t.Fatal("queued permission change did not resume its native session")
			}
			var receipt map[string]any
			if len(completed.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(completed.Items[0].Text, "wire:")), &receipt) != nil {
				t.Fatal("queued run did not report native settings")
			}
			if (runtime == "codex" && receipt["sandbox"] != "danger-full-access") || (runtime == "claude" && receipt["permission"] != "bypassPermissions") {
				t.Fatal("queued run used the previous native permissions", receipt)
			}
		})
	}
}
