package httpapi_test

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func TestPersonalChannelOwnerRouting(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX stdio fixture")
	}
	f := newFixture(t)
	first, second := f.agent("codex"), f.agent("claude")
	first.Profile.Model = "gpt-test"
	f.request("PUT", "/agents/"+first.ID, first, 200, &first)
	dir := t.TempDir()
	write := func(name, contents string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), mode); err != nil {
			t.Fatal(err)
		}
	}
	manifest := `{"manifestVersion":1,"id":"example.personal","name":"Personal","version":"1","contributes":{"channels":[{"id":"personal","name":"Personal","driver":"personal-stdio-v1","command":"bridge"}]}}`
	write("lever-plugin.json", manifest, 0600)
	write("bridge", `#!/bin/sh
set -eu
printf '%s\n' started >> starts
mkdir -p "$LEVER_CHANNEL_CACHE"
if test ! -f "$LEVER_CHANNEL_CACHE/prepared"; then
  touch "$LEVER_CHANNEL_CACHE/prepared"
  sleep 60 &
  printf '%s\n' "$!" > setup-child
  printf '%s\n' '{"event":"connecting","phase":"preparing"}'
  wait
fi
printf '%s\n' '{"event":"online","account":"100","region":"feishu"}'
while test ! -f ready; do sleep .02; done
cat inbox
while IFS= read -r input; do
  printf '%s\n' "$input" >> calls
  id=$(printf '%s\n' "$input" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  case "$input" in
    *'"method":"context"'*'"message":"105"'*) (while test ! -f release; do sleep .02; done; printf '{"id":"%s","status":"ok","text":"slow history"}\n' "$id") & ;;
    *'"method":"reply"'*'"message":"108"'*) printf '{"id":"%s","status":"unknown"}\n' "$id";;
    *'"method":"react"'*'"message":"108"'*) printf '{"id":"%s","status":"failed"}\n' "$id";;
    *) printf '{"id":"%s","status":"ok","text":"fixture context","remoteId":"911"}\n' "$id";;
  esac
done
`, 0700)
	var manifestInput json.RawMessage = []byte(manifest)
	f.request("POST", "/plugins", map[string]any{"manifest": manifestInput}, 400, nil)
	var installed model.Plugin
	f.request("POST", "/plugins", map[string]string{"directory": dir}, 200, &installed)
	path := "/plugins/" + installed.ID + "/channel"
	var view model.PersonalChannelView
	f.request("GET", path, nil, 200, &view)
	if view.State != "signedOut" || view.Settings.ContextLimit != 20 || !view.Settings.ThreadReply {
		t.Fatal(view)
	}
	if _, err := os.Stat(filepath.Join(dir, "starts")); !os.IsNotExist(err) {
		t.Fatal("installation executed the adapter")
	}
	route := model.PersonalChannelRoute{AgentID: first.ID, Commands: []string{"/审查", "/ai"}, Enabled: true}
	settings := view.Settings
	settings.Routes = []model.PersonalChannelRoute{route, {AgentID: second.ID, Commands: []string{"/AI"}, Enabled: true}}
	f.request("PUT", path, settings, 400, nil)
	settings.Routes[1].Commands = []string{"/abc"}
	settings.Prompt = strings.Repeat("字", 4001)
	f.request("PUT", path, settings, 400, nil)
	settings.Prompt = "Keep replies short."
	settings.Routes[0].Selection = &model.Selection{Provider: "missing"}
	f.request("PUT", path, settings, 400, nil)
	settings.Routes[0].Selection = &model.Selection{Provider: "codex", Permission: "full_access"}
	f.request("PUT", path, settings, 400, nil)
	first.Profile.Permission = "read_only"
	f.request("PUT", "/agents/"+first.ID, first, 200, &first)
	settings.Routes[0].Selection = &model.Selection{Provider: "claude", Model: "claude-review"}
	f.request("PUT", path, settings, 400, nil)
	first.Profile.Permission = "ask"
	f.request("PUT", "/agents/"+first.ID, first, 200, &first)
	settings.Routes[0].Selection = nil
	settings.ChatIDs, settings.Reaction = []string{"300", "400"}, "THUMBSUP"
	f.request("PUT", path, settings, 200, nil)
	f.request("POST", path+"/connect", map[string]string{}, 409, nil)
	f.request("POST", path+"/login", map[string]string{"region": "feishu"}, 200, nil)
	waitUntil := func(description string, condition func() bool) {
		t.Helper()
		end := time.Now().Add(15 * time.Second)
		for time.Now().Before(end) {
			if condition() {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatal(description)
	}
	waitUntil("setup did not report progress", func() bool {
		f.request("GET", path, nil, 200, &view)
		return view.State == "preparing"
	})
	pid, err := os.ReadFile(filepath.Join(dir, "setup-child"))
	if err != nil {
		t.Fatal(err)
	}
	f.request("POST", path+"/logout", map[string]string{}, 200, nil)
	waitUntil("cancelling setup left a child process running", func() bool {
		return exec.Command("kill", "-0", strings.TrimSpace(string(pid))).Run() != nil
	})
	f.request("POST", path+"/login", map[string]string{"region": "feishu"}, 200, nil)
	waitUntil("account did not connect", func() bool {
		f.request("GET", path, nil, 200, &view)
		return view.State == "online" && view.Account == "100"
	})
	event := func(id, sender, chat, text, kind, thread, parent string) string {
		data, err := json.Marshal(map[string]any{"event": "message", "message": map[string]any{
			"id": id, "sender": sender, "chat": chat, "text": text, "kind": kind, "thread": thread,
			"parent": parent, "created": time.Now().Unix(),
		}})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	write("inbox", strings.Join([]string{
		event("101", "999", "300", "/ai spoof", "group", "", ""), event("102", "100", "900", "/ai scope", "group", "", ""),
		event("103", "100", "300", "/aim not a command", "group", "", ""), event("104", "100", "300", "quoted /ai", "group", "", ""),
		event("105", "100", "300", "/AI [wire] first", "group", "", ""), event("105", "100", "300", "/AI [wire] first", "group", "", ""),
		event("106", "100", "300", "/审查 second", "group", "105", "105"), event("107", "100", "300", "/abc third", "group", "105", "105"),
		event("108", "100", "400", "/ai fourth", "dm", "", ""),
	}, "\n")+"\n", 0600)
	write("ready", "", 0600)
	waitUntil("receipt waited for slow context", func() bool {
		data, _ := os.ReadFile(filepath.Join(dir, "calls"))
		return strings.Contains(string(data), `"method":"react","message":"105"`) && strings.Contains(string(data), `"method":"context","message":"105"`)
	})
	var status string
	var firstRunID string
	if err := f.a.Store.DB.QueryRow("SELECT r.id,r.status FROM runs r JOIN channel_deliveries d ON r.id=d.run_id WHERE d.message_id='105'").Scan(&firstRunID, &status); err != nil || status != "queued" {
		t.Fatalf("reaction must follow durable acceptance but not context: %q %v", status, err)
	}
	var overview model.Overview
	countRuns := func() int {
		var count int
		if err := f.a.Store.DB.QueryRow("SELECT COUNT(*) FROM runs").Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	waitUntil("the commands were not accepted", func() bool { return countRuns() == 4 })
	f.request("GET", "/overview", nil, 200, &overview)
	queuedIndex := slices.IndexFunc(overview.Runs, func(run model.Run) bool { return run.ID == firstRunID })
	if queuedIndex < 0 || overview.Runs[queuedIndex].Channel == nil {
		t.Fatal("overview did not identify a queued channel turn")
	}
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: overview.Runs[queuedIndex].ChatID,
		EditRunID: firstRunID, Operation: "main", Text: "attempt to edit a queued instruction"}, 409, nil)
	settings.Prompt = "Reply in Chinese."
	settings.Routes[0].Selection = &model.Selection{Provider: "claude", Model: "claude-review", Effort: "high", Fast: true}
	f.request("PUT", path, settings, 200, nil)
	write("release", "", 0600)
	waitUntil("answers were not routed", func() bool {
		var count int
		err := f.a.Store.DB.QueryRow("SELECT count(*) FROM channel_deliveries WHERE part='answer' AND status IN ('sent','unknown')").Scan(&count)
		return err == nil && count == 4
	})
	f.request("GET", "/overview", nil, 200, &overview)
	if countRuns() != 4 || len(overview.Chats) != 3 {
		t.Fatalf("expected four accepted turns in three isolated chats; got %d / %d", countRuns(), len(overview.Chats))
	}
	var firstInput string
	if err := f.a.Store.DB.QueryRow("SELECT json_extract(r.data,'$.input') FROM runs r JOIN channel_deliveries d ON r.id=d.run_id WHERE d.message_id='105'").Scan(&firstInput); err != nil || !strings.Contains(firstInput, "slow history") {
		t.Fatal("missing context in the accepted turn", firstInput, err)
	}
	checkWire := func(run model.Run, prompt string) {
		t.Helper()
		var receipt struct{ Instructions, Model, Effort string }
		for _, item := range run.Items {
			if wire, ok := strings.CutPrefix(item.Text, "wire:"); ok {
				if err := json.Unmarshal([]byte(wire), &receipt); err != nil {
					t.Fatal(err)
				}
			}
		}
		want := first.Profile.Instructions
		if prompt != "" {
			want += "\n\n" + prompt
		}
		if !strings.Contains(receipt.Instructions, want) || run.ChannelPrompt != prompt ||
			receipt.Model != run.Selection.Model || (run.Selection.Effort != "" && receipt.Effort != run.Selection.Effort) ||
			(prompt != "" && strings.Contains(run.Input, prompt)) {
			t.Fatalf("incorrect runtime prompt or model for %s: %+v", run.ID, receipt)
		}
	}
	deliveredRun := func(message string) model.Run {
		t.Helper()
		var id string
		if err := f.a.Store.DB.QueryRow("SELECT run_id FROM channel_deliveries WHERE part='answer' AND message_id=?", message).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return f.wait(id, "completed")
	}
	original := deliveredRun("105")
	checkWire(original, "Keep replies short.")
	if err := f.a.Store.DB.QueryRow("SELECT reaction_status FROM personal_channel_turns WHERE run_id=?", original.ID).Scan(&status); err != nil || status != "ok" {
		t.Fatal("missing confirmed reaction", status, err)
	}
	for _, chat := range overview.Chats {
		if chat.Channel != installed.ID || chat.Source != "channel" {
			t.Fatal(chat)
		}
	}
	f.request("GET", path, nil, 200, &view)
	if view.Last == nil || view.Last.Status != "unknown" || view.Last.AgentID != first.ID ||
		view.Last.RunStatus != "completed" || view.Last.Selection.Model != "gpt-test" || !view.Last.ContextReady ||
		view.Last.Reaction != "THUMBSUP" || view.Last.ReactionStatus != "failed" {
		t.Fatal(view.Last)
	}
	file, err := os.Open(filepath.Join(dir, "calls"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	counts := map[string]int{}
	for lines := bufio.NewScanner(file); lines.Scan(); {
		var call struct{ Method, Message, Chat, Thread, Reaction, Text string }
		if err := json.Unmarshal(lines.Bytes(), &call); err != nil {
			t.Fatal(err)
		}
		counts[call.Method]++
		if call.Method == "react" && call.Reaction != "THUMBSUP" {
			t.Fatal(call)
		}
		if call.Method == "reply" && (call.Chat == "300" && call.Thread != "105" || call.Chat == "400" && call.Thread != "" || !strings.Contains(call.Text, "AI · Test")) {
			t.Fatal(call)
		}
	}
	if counts["react"] != 4 || counts["reply"] != 4 || counts["context"] != 4 {
		t.Fatal(counts)
	}
	var unknownRun string
	if err := f.a.Store.DB.QueryRow("SELECT run_id FROM channel_deliveries WHERE status='unknown'").Scan(&unknownRun); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/runs/"+unknownRun+"/channel-reply/retry", map[string]string{}, 409, nil)
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	settings.ThreadReply, settings.Reaction, settings.ContextLimit = false, "", 0
	f.request("PUT", path, settings, 200, nil)
	write("inbox", strings.Join([]string{
		event("105", "100", "300", "/AI [wire] first", "group", "", ""),
		event("109", "100", "300", "/ai quote", "group", "", "911"),
		event("110", "100", "300", "/ai [wire] thread", "group", "105", "106"),
	}, "\n")+"\n", 0600)
	f.request("POST", path+"/connect", map[string]string{}, 200, nil)
	waitUntil("direct reply or thread follow-up not delivered", func() bool {
		var count int
		err := f.a.Store.DB.QueryRow("SELECT count(*) FROM channel_deliveries WHERE status='sent'").Scan(&count)
		return err == nil && count == 5
	})
	var directThread string
	if err := f.a.Store.DB.QueryRow("SELECT t.thread FROM personal_channel_turns t JOIN channel_deliveries d ON d.run_id=t.run_id WHERE d.message_id='109'").Scan(&directThread); err != nil || directThread != "" {
		t.Fatalf("direct reply opened a thread: %q %v", directThread, err)
	}
	f.request("GET", "/overview", nil, 200, &overview)
	if countRuns() != 6 || len(overview.Chats) != 3 {
		t.Fatal("replay was not idempotent or follow-up lost its conversation")
	}
	switched := deliveredRun("110")
	if switched.SessionID != original.SessionID || switched.Selection.Provider != "claude" ||
		switched.Selection.Model != "claude-review" || switched.Selection.Permission != "ask" || !switched.Selection.Fast {
		t.Fatal("channel override did not reach the existing thread", switched.Selection)
	}
	checkWire(switched, settings.Prompt)
	direct := f.wait(f.send(f.chat(first).ID, "main", "", "[wire] desktop").ID, "completed")
	checkWire(direct, "")
	if direct.Selection.Provider != "codex" || direct.Selection.Model != "gpt-test" || strings.Contains(direct.Items[0].Text, settings.Prompt) {
		t.Fatal("channel settings leaked into a desktop conversation")
	}
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: switched.ChatID,
		ReplaceRunID: switched.ID, Operation: "main", Text: "attempt to replace a delivered instruction"}, 409, nil)
	continued := f.wait(f.send(switched.ChatID, "main", "", "[wire] continue from Lever").ID, "completed")
	checkWire(continued, "")
	if continued.SessionID != switched.SessionID || continued.Handoff {
		t.Fatal("the Lever follow-up did not resume the channel conversation", continued)
	}
	var outbound bool
	if err := f.a.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM channel_deliveries WHERE run_id=?)", continued.ID).Scan(&outbound); err != nil || outbound {
		t.Fatal("the Lever follow-up must not be delivered to the channel", outbound, err)
	}
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	settings.Routes[0].Selection, settings.Prompt = nil, ""
	f.request("PUT", path, settings, 200, nil)
	write("inbox", event("111", "100", "300", "/ai [wire] follow profile", "group", "105", "110")+"\n", 0600)
	f.request("POST", path+"/connect", map[string]string{}, 200, nil)
	waitUntil("follow-profile turn was not delivered", func() bool {
		f.request("GET", path, nil, 200, &view)
		return view.Last != nil && view.Last.Status == "sent" && view.Last.Selection.Provider == "codex" && view.Last.ReactionStatus == "off"
	})
	inherited := deliveredRun("111")
	if inherited.SessionID != switched.SessionID || !inherited.Handoff || inherited.Selection.Model != first.Profile.Model {
		t.Fatal("returning to the profile lost the thread or retained the override")
	}
	checkWire(inherited, "")
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	write("inbox", event("112", "100", "300", "/ai [hang]", "group", "105", "111")+"\n", 0600)
	f.request("POST", path+"/connect", map[string]string{}, 200, nil)
	var activeID string
	waitUntil("channel turn did not start", func() bool {
		return f.a.Store.DB.QueryRow("SELECT r.id FROM runs r JOIN channel_deliveries d ON r.id=d.run_id WHERE d.message_id='112' AND r.status='running'").Scan(&activeID) == nil
	})
	f.waitNative(inherited.SessionID)
	f.request("GET", "/overview", nil, 200, &overview)
	if !slices.ContainsFunc(overview.Runs, func(run model.Run) bool { return run.ID == activeID && run.Channel != nil }) {
		t.Fatal("overview did not identify the active channel turn")
	}
	followUp := model.SendInput{CommandID: app.ID(), ChatID: inherited.ChatID, Operation: "main", Text: "Lever-only follow-up", Delivery: "steer"}
	f.request("POST", "/messages", followUp, 409, nil)
	followUp.CommandID, followUp.Delivery = app.ID(), "queue"
	var local model.Run
	f.request("POST", "/messages", followUp, 200, &local)
	f.wait(local.ID, "queued")
	f.request("POST", "/runs/"+local.ID+"/queue", map[string]string{"action": "send"}, 409, nil)
	f.request("POST", "/runs/"+activeID+"/stop", map[string]string{}, 200, nil)
	f.wait(activeID, "interrupted")
	f.request("POST", "/runs/"+activeID+"/retry", map[string]string{"commandId": app.ID()}, 409, nil)
	f.request("POST", "/sessions/"+inherited.SessionID+"/queue/resume", map[string]string{}, 200, nil)
	f.wait(local.ID, "completed")
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	if _, err := f.a.Store.DB.Exec("UPDATE channel_deliveries SET status='failed' WHERE message_id='109'"); err != nil {
		t.Fatal(err)
	}
	f.request("POST", path+"/logout", map[string]string{}, 200, nil)
	if err := f.a.Store.DB.QueryRow("SELECT status FROM channel_deliveries WHERE message_id='109'").Scan(&status); err != nil || status != "cancelled" {
		t.Fatal("sign-out did not revoke the old delivery", status, err)
	}
	f.request("GET", path, nil, 200, &view)
	if view.State != "signedOut" {
		t.Fatal(view)
	}
	f.request("DELETE", "/plugins/"+installed.ID, nil, 200, nil)
	f.request("GET", path, nil, 404, nil)
}
