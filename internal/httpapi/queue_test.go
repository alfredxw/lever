package httpapi_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/store"
)

func (f *fixture) waitNative(sessionID string) model.Session {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		session, err := store.Get[model.Session](context.Background(), f.a.Store.DB, "SELECT data FROM sessions WHERE id=?", sessionID)
		if err != nil {
			f.t.Fatal(err)
		}
		if session.NativeID != "" {
			return session
		}
		time.Sleep(15 * time.Millisecond)
	}
	f.t.Fatal("runtime did not bind its native session")
	return model.Session{}
}

func TestNegotiatedSteer(t *testing.T) {
	for _, kind := range []string{"antigravity", "pi", "acp"} {
		t.Run(kind, func(t *testing.T) {
			f := openFixture(t, app.OpenServer).withLocalProviders()
			var agent model.Agent
			switch kind {
			case "pi":
				agent = f.piAgent()
			case "antigravity":
				agent = f.acpAgent(model.Provider{ID: kind, Name: kind})
			case "acp":
				agent = f.acpAgent(f.acpProvider("with-extension", "--steering-extension"))
			}
			chat := f.chat(agent)
			for _, follow := range []string{"change direction", "[reject-steer]", "[disconnect-steer]"} {
				if kind == "antigravity" && follow == "[reject-steer]" || kind == "acp" && follow == "[disconnect-steer]" {
					continue
				}
				active := f.send(chat.ID, "topic", "", "[steer-open]")
				for deadline := time.Now().Add(8 * time.Second); ; time.Sleep(15 * time.Millisecond) {
					f.request("GET", "/runs/"+active.ID, nil, 200, &active)
					if active.CanSteer {
						break
					}
					if time.Now().After(deadline) || !model.Active(active.Status) {
						t.Fatalf("did not become steerable: %s: %s", active.Status, active.Error)
					}
				}
				var steer model.Run
				f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "reply", SessionID: active.SessionID, Delivery: "queue", Text: follow}, 200, &steer)
				f.request("POST", "/runs/"+steer.ID+"/queue", map[string]string{"action": "send"}, 200, nil)
				if follow == "[disconnect-steer]" {
					f.wait(active.ID, "unknown")
					if got := f.wait(steer.ID, "steered"); got.Error == "" {
						t.Fatal("ambiguous steer was confirmed")
					}
					continue
				}
				completed := f.wait(active.ID, "completed")
				if completed.CanSteer || !hasPauseTestOutput(completed, "before steer") {
					t.Fatal(completed)
				}
				if follow == "[reject-steer]" {
					if got := f.wait(steer.ID, "completed"); got.SteerRunID != "" {
						t.Fatal(got)
					}
					continue
				}
				if got := f.wait(steer.ID, "steered"); got.SteerRunID != active.ID || got.Error != "" || !hasPauseTestOutput(completed, "after: "+follow) {
					t.Fatal(got, completed)
				}
			}
		})
	}
}

func TestDeferredSteerIsBoundToOneRun(t *testing.T) {
	for _, kind := range []string{"antigravity", "pi"} {
		t.Run(kind, func(t *testing.T) {
			f := openFixture(t, app.OpenServer).withLocalProviders()
			var agent model.Agent
			if kind == "pi" {
				agent = f.piAgent()
			} else {
				agent = f.acpAgent(model.Provider{ID: kind, Name: kind})
			}
			chat := f.chat(agent)
			first := f.send(chat.ID, "main", "", "[defer-steer] [steer-open]")
			if !first.SteerPending || first.CanSteer {
				t.Fatal(first)
			}
			var queued, deferred model.Run
			input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Delivery: "queue", Text: "next turn only"}
			f.request("POST", "/messages", input, 200, &queued)
			input.CommandID, input.Text, input.Delivery, input.SteerRunID = app.ID(), "change direction", "steer", first.ID
			f.request("POST", "/messages", input, 200, &deferred)
			if deferred.Status != "queued" || deferred.SteerRunID != first.ID {
				t.Fatal(deferred)
			}
			var taken bool
			if err := f.a.Store.DB.QueryRow(`SELECT EXISTS(SELECT 1 FROM runtime_commands WHERE kind='steer' AND run_id=?)`, first.ID).Scan(&taken); err != nil || taken {
				t.Fatal("delivery before native readiness", taken, err)
			}
			if err := os.WriteFile(filepath.Join(f.root, "allow-steer"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			completed := f.wait(first.ID, "completed")
			if completed.SteerPending || !hasPauseTestOutput(completed, "after: change direction") || hasPauseTestOutput(completed, "next turn only") {
				t.Fatal(completed)
			}
			if got := f.wait(deferred.ID, "steered"); got.Error != "" {
				t.Fatal(got)
			}
			if got := f.wait(queued.ID, "completed"); got.SteerRunID != "" {
				t.Fatal(got)
			}
			input.CommandID = app.ID()
			f.request("POST", "/messages", input, 409, nil)
		})
	}
}

func TestClaudeSteerPreservesInFlightTool(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("claude"))
	first := f.send(chat.ID, "main", "", "[steer-tool]")
	f.waitNative(first.SessionID)
	var follow model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "new instruction", Delivery: "steer", SteerRunID: first.ID}, 200, &follow)
	got := f.wait(first.ID, "completed")
	if !hasPauseTestOutput(got, "before steer") || !hasPauseTestOutput(got, "new instruction") {
		t.Fatal(got)
	}
	if ack := f.wait(follow.ID, "steered"); ack.Error != "" {
		t.Fatal(ack)
	}
	for _, item := range got.Items {
		if item.Kind == "tool" && item.Status == "completed" && strings.Contains(item.Text, "original tool finished") {
			return
		}
	}
	t.Fatal("no successful receipt from the original tool", got.Items)
}

func TestDeferredSteerFallsBackAfterChangedHandshake(t *testing.T) {
	f := openFixture(t, app.OpenServer).withLocalProviders()
	config := f.acpProvider("changed-handshake", "--hold-initialize")
	chat := f.chat(f.acpAgent(config))
	gate := filepath.Join(f.root, "allow-steer")
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	f.request("GET", "/providers/"+config.ID+"/models?cwd="+url.QueryEscape(f.root), nil, 200, nil)
	if _, err := f.a.Store.DB.Exec(`UPDATE provider_catalogs SET data=json_set(data,'$.capabilities.steering',json('true')) WHERE provider_id=?`, config.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(gate); err != nil {
		t.Fatal(err)
	}
	first := f.send(chat.ID, "main", "", "[steer-open]")
	var follow model.Run
	f.request("POST", "/messages", model.SendInput{ChatID: chat.ID, CommandID: app.ID(), Operation: "main", Text: "next turn if unsupported", Delivery: "steer", SteerRunID: first.ID}, 200, &follow)
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	f.waitNative(first.SessionID)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(15 * time.Millisecond) {
		var current model.Run
		f.request("GET", "/runs/"+follow.ID, nil, 200, &current)
		if current.Status == "queued" && current.Delivery == "queue" && current.SteerRunID == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(current)
		}
	}
	f.request("POST", "/runs/"+first.ID+"/stop", map[string]bool{}, 200, nil)
}

func TestSessionsExecuteAndQueueIndependently(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			agent := f.agent(runtime)
			chat := f.chat(agent)
			roots := []model.Run{
				f.send(chat.ID, "main", "", "[hang] main"),
				f.send(chat.ID, "topic", "", "[hang] topic A"),
				f.send(chat.ID, "topic", "", "[hang] topic B"),
			}
			queued := make([]model.Run, len(roots))
			natives := map[string]bool{}
			for i, root := range roots {
				f.wait(root.ID, "running")
				// Wait for actual provider identity, not just the launch status.
				session := f.waitNative(root.SessionID)
				if session.NativeID == "" || natives[session.NativeID] {
					t.Fatal("parallel sessions must own distinct native identities", session)
				}
				natives[session.NativeID] = true
				op := "reply"
				if i == 0 {
					op = "main"
				}
				f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, SessionID: root.SessionID, Operation: op, Text: "finish this session's queue", Delivery: "queue"}, 200, &queued[i])
				f.wait(queued[i].ID, "queued")
			}
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "cannot start a second main run"}, 409, nil)
			// Agent and writable Scope are not execution locks either.
			otherChat := f.chat(agent)
			other := f.send(otherChat.ID, "main", "", "same Agent and directory")
			f.wait(other.ID, "completed")
			otherChat = f.chat(f.agent(runtime))
			other = f.send(otherChat.ID, "main", "", "another Agent sharing the directory")
			f.wait(other.ID, "completed")

			f.request("POST", "/runs/"+roots[1].ID+"/stop", map[string]bool{}, 200, nil)
			f.wait(roots[1].ID, "interrupted")
			f.wait(queued[1].ID, "queued")
			f.wait(roots[0].ID, "running")
			f.wait(roots[2].ID, "running")
			f.request("POST", "/sessions/"+roots[1].SessionID+"/queue/resume", map[string]bool{}, 200, nil)
			f.wait(queued[1].ID, "completed")
			f.wait(queued[0].ID, "queued")
			f.wait(queued[2].ID, "queued")
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "finish main", Delivery: "steer"}, 200, nil)
			f.wait(roots[0].ID, "completed")
			f.wait(queued[0].ID, "completed")
			f.wait(roots[2].ID, "running")
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, SessionID: roots[2].SessionID, Operation: "reply", Text: "finish topic B", Delivery: "steer"}, 200, nil)
			f.wait(roots[2].ID, "completed")
			f.wait(queued[2].ID, "completed")
		})
	}
}

func TestQueueSteerAndRuntimeSwitch(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent(runtime))
			first := f.send(chat.ID, "main", "", "[hang]")
			f.wait(first.ID, "running")
			command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "queued one", Delivery: "queue"}
			var queued, retry model.Run
			f.request("POST", "/messages", command, 200, &queued)
			f.request("POST", "/messages", command, 200, &retry)
			if queued.ID != retry.ID || queued.Status != "queued" {
				t.Fatal("queue acceptance was duplicated", queued, retry)
			}
			other := "claude"
			if runtime == "claude" {
				other = "codex"
			}
			var switched model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "queued switch", Delivery: "queue", Selection: &model.Selection{Provider: other}}, 200, &switched)
			command.CommandID, command.Delivery, command.Text = app.ID(), "steer", "please finish now"
			var steer model.Run
			f.request("POST", "/messages", command, 200, &steer)
			f.request("POST", "/messages", command, 200, &retry)
			if steer.ID != retry.ID {
				t.Fatal("steer acceptance was duplicated")
			}
			completed := f.wait(first.ID, "completed")
			f.wait(queued.ID, "completed")
			last := f.wait(switched.ID, "completed")
			if !last.Handoff {
				t.Fatal("queued runtime switch did not carry history")
			}
			messages := 0
			for _, item := range completed.Items {
				if item.Kind == "user" && item.Message.ID == steer.ID {
					messages++
				}
			}
			if messages != 1 {
				t.Fatalf("steer appears %d times in current run", messages)
			}
			var view model.ChatView
			f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
			if len(view.Runs) != 3 {
				t.Fatalf("steer became an extra turn: %+v", view.Runs)
			}
			if !strings.Contains(last.Items[len(last.Items)-1].Text, "please finish now") {
				t.Fatal("steering input missing from handoff history")
			}
		})
	}
}

func TestSteerUsesActiveModelAndSavesNextSelection(t *testing.T) {
	for _, runtime := range []string{"codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent(runtime))
			current := model.Selection{Provider: runtime, Model: "active-model", Permission: "ask", Effort: "low"}
			first := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[hang] keep the active turn", Selection: &current}
			var active model.Run
			f.request("POST", "/messages", first, 200, &active)
			f.wait(active.ID, "running")
			native := f.waitNative(active.SessionID).NativeID

			next := model.Selection{Provider: runtime, Model: "review-model", Permission: "ask", Effort: "high", Fast: true}
			input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[hang] steer directly with different settings", Delivery: "steer", Selection: &next}
			var direct model.Run
			f.request("POST", "/messages", input, 200, &direct)
			if delivered := f.wait(direct.ID, "steered"); delivered.SteerRunID != active.ID || delivered.Selection != current || delivered.Error != "" {
				t.Fatalf("steer changed or missed the live turn: %+v", delivered)
			}
			if session := f.waitNative(active.SessionID); session.Selection != next || session.NativeID != native {
				t.Fatalf("steer lost the next-turn settings or native identity: %+v", session)
			}

			queuedSelection := next
			queuedSelection.Model, queuedSelection.Effort = "queued-model", "medium"
			var queued model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "finish with a queued steer", Delivery: "queue", Selection: &queuedSelection}, 200, &queued)
			f.request("POST", "/runs/"+queued.ID+"/queue", map[string]string{"action": "send"}, 200, nil)
			if delivered := f.wait(queued.ID, "steered"); delivered.SteerRunID != active.ID || delivered.Selection != current || delivered.Error != "" {
				t.Fatalf("queued steer changed or missed the live turn: %+v", delivered)
			}
			if completed := f.wait(active.ID, "completed"); completed.Selection != current {
				t.Fatalf("completed turn lost its original selection: %+v", completed.Selection)
			}

			// Replaying the first steer must preserve the latest selection.
			f.request("POST", "/messages", input, 200, nil)
			var followUp model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[wire] new turn using session defaults"}, 200, &followUp)
			followUp = f.wait(followUp.ID, "completed")
			if followUp.Selection != queuedSelection || followUp.Handoff {
				t.Fatalf("new turn did not inherit the queued steer's selection: %+v", followUp)
			}
			var receipt map[string]any
			if len(followUp.Items) != 1 || json.Unmarshal([]byte(strings.TrimPrefix(followUp.Items[0].Text, "wire:")), &receipt) != nil {
				t.Fatalf("new turn did not report native settings: %+v", followUp.Items)
			}
			if receipt["native"] != native || receipt["model"] != queuedSelection.Model || receipt["effort"] != queuedSelection.Effort ||
				(runtime == "codex" && receipt["tier"] != "priority") || (runtime == "claude" && receipt["fast"] != true) {
				t.Fatal("runtime did not receive next-turn settings", receipt)
			}
		})
	}
}

func TestQueueEditsStopAndRestart(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	first := f.send(chat.ID, "main", "", "[hang]")
	f.wait(first.ID, "running")
	f.waitNative(first.SessionID)
	var queued, removed model.Run
	command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "before edit", Delivery: "queue"}
	f.request("POST", "/messages", command, 200, &queued)
	command.CommandID, command.EditRunID, command.Text = app.ID(), queued.ID, "after edit"
	f.request("POST", "/messages", command, 200, &queued)
	command.CommandID, command.EditRunID, command.Text = app.ID(), "", "remove me"
	f.request("POST", "/messages", command, 200, &removed)
	f.request("POST", "/runs/"+removed.ID+"/queue", map[string]string{"action": "remove"}, 200, nil)
	f.request("POST", "/runs/"+first.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(first.ID, "interrupted")
	time.Sleep(100 * time.Millisecond)
	if run := f.wait(queued.ID, "queued"); run.Input != "after edit" {
		t.Fatal("edit not persisted")
	}
	// The same database reopens with the queue intact and still paused.
	dir := f.a.Store.Dir
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	f.s.HTTP.Close()
	// Model an accepted Topic whose process had not started when the backend
	// stopped. It must remain visible and paused independently of the main queue.
	db, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	topicSession, err := store.Get[model.Session](ctx, db.DB, "SELECT data FROM sessions WHERE id=?", first.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	topicSession.ID, topicSession.Kind, topicSession.NativeID = app.ID(), "topic", ""
	topicSession.QueuePaused = false
	topic := model.Run{ID: app.ID(), ChatID: chat.ID, AgentID: chat.AgentID, SessionID: topicSession.ID, Operation: "topic", Input: "accepted topic", Status: "queued", Selection: first.Selection, Items: []model.Item{}, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	err = db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,?,?)", topicSession.ID, chat.ID, "topic", store.JSON(topicSession)); err != nil {
			return err
		}
		return store.InsertRun(tx, &topic, app.ID(), "accepted-topic")
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := app.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	view, err := reopened.Store.View(ctx, chat.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Runs) != 2 || !view.Sessions[0].QueuePaused || !view.Sessions[1].QueuePaused || reopened.RunningCount() != 0 {
		t.Fatal("restart replayed queued work", view)
	}
	if view.Entries[1].Kind != "topic" || view.Entries[1].ReplyCount != 0 || view.Runs[1].Status != "queued" {
		t.Fatal("accepted topic disappeared on restart", view)
	}
	if err := reopened.ResumeQueue(ctx, queued.SessionID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		run, err := store.Get[model.Run](ctx, reopened.Store.DB, "SELECT data FROM runs WHERE id=?", queued.ID)
		if err != nil {
			t.Fatal(err)
		}
		if run.Status == "completed" {
			pending, err := store.Get[model.Run](ctx, reopened.Store.DB, "SELECT data FROM runs WHERE id=?", topic.ID)
			if err != nil || pending.Status != "queued" {
				t.Fatal("resuming main also resumed the topic", pending, err)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("resumed queue did not finish")
}

func TestSteerCompletionRaceAndDisconnect(t *testing.T) {
	for _, marker := range []string{"[finish-on-steer]", "[disconnect-steer]"} {
		t.Run(marker, func(t *testing.T) {
			f := newFixture(t)
			chat := f.chat(f.agent("codex"))
			first := f.send(chat.ID, "main", "", marker)
			f.wait(first.ID, "running")
			var queued model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "ordinary follow-up", Delivery: "queue"}, 200, &queued)
			var steer model.Run
			command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "follow-up", Delivery: "steer"}
			f.request("POST", "/messages", command, 200, &steer)
			if marker == "[finish-on-steer]" {
				f.wait(first.ID, "completed")
				f.wait(steer.ID, "completed")
				f.wait(queued.ID, "completed")
			} else {
				f.wait(first.ID, "unknown")
				delivered := f.wait(steer.ID, "steered")
				if delivered.Error == "" {
					t.Fatal("ambiguous delivery was reported as confirmed")
				}
				f.wait(queued.ID, "queued")
				var view model.ChatView
				f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
				if !view.Sessions[0].QueuePaused {
					t.Fatal("unknown execution did not pause its queue")
				}
			}
			var retry model.Run
			f.request("POST", "/messages", command, 200, &retry)
			if retry.ID != steer.ID {
				t.Fatal("retried steer was duplicated")
			}
		})
	}
}

func TestQueuedMainCanStartIndependentTopic(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	main := f.send(chat.ID, "main", "", "[hang] main")
	f.wait(main.ID, "running")
	var first, second, changed model.Run
	command := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "[hang] become topic", Delivery: "queue"}
	f.request("POST", "/messages", command, 200, &first)
	command.CommandID, command.Text = app.ID(), "stay in main"
	f.request("POST", "/messages", command, 200, &second)
	command.CommandID, command.EditRunID, command.Operation, command.Text = app.ID(), first.ID, "topic", first.Input
	f.request("POST", "/messages", command, 200, &changed)
	if changed.ID != first.ID || changed.Sequence != first.Sequence || changed.SessionID == main.SessionID || changed.Operation != "topic" {
		t.Fatal("queued Chat did not become a Topic", changed)
	}
	f.wait(first.ID, "running")
	f.wait(second.ID, "queued")
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "reply", SessionID: changed.SessionID, Text: "finish topic", Delivery: "steer"}, 200, nil)
	f.wait(first.ID, "completed")
	f.wait(main.ID, "running")
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "finish main", Delivery: "steer"}, 200, nil)
	f.wait(main.ID, "completed")
	f.wait(second.ID, "completed")
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	if len(view.Entries) != 3 || view.Entries[1].Kind != "topic" || view.Entries[2].Kind != "main" {
		t.Fatal("queue routed to the wrong conversations", view.Entries)
	}
	command.CommandID = app.ID()
	f.request("POST", "/messages", command, 409, nil)
}
