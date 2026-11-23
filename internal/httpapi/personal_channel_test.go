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
	if view.State != "signedOut" || view.Settings.ChatMode != model.PersonalChannelChatSingle || view.Settings.ContextLimit != 20 || !view.Settings.ThreadReply {
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
	settings.ChatMode = "invalid"
	f.request("PUT", path, settings, 400, nil)
	settings.ChatMode = model.PersonalChannelChatSingle
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
			"id": id, "sender": sender, "chat": chat, "chatName": map[string]string{"300": "研发群", "400": "张三"}[chat],
			"text": text, "kind": kind, "thread": thread, "parent": parent, "created": time.Now().Unix(),
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
	if countRuns() != 4 || len(overview.Chats) != 2 {
		t.Fatalf("expected four accepted turns in two per-agent chats; got %d / %d", countRuns(), len(overview.Chats))
	}
	var sessionCount int
	if err := f.a.Store.DB.QueryRow("SELECT COUNT(*) FROM sessions WHERE kind='topic'").Scan(&sessionCount); err != nil || sessionCount != 3 {
		t.Fatalf("expected three isolated topic sessions; got %d (%v)", sessionCount, err)
	}
	var firstInput, firstContext string
	if err := f.a.Store.DB.QueryRow("SELECT json_extract(r.data,'$.input'),COALESCE(json_extract(r.data,'$.channelContext'),'') FROM runs r JOIN channel_deliveries d ON r.id=d.run_id WHERE d.message_id='105'").Scan(&firstInput, &firstContext); err != nil || strings.Contains(firstInput, "slow history") || !strings.Contains(firstContext, "slow history") {
		t.Fatalf("expected context separated from visible input: input=%q context=%q err=%v", firstInput, firstContext, err)
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
		view.Last.SessionID == "" || view.Last.RunID == "" || !view.Last.Topic || view.Last.ChatName != "张三" ||
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
	if countRuns() != 6 || len(overview.Chats) != 2 {
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
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: switched.ChatID, SessionID: switched.SessionID,
		ReplaceRunID: switched.ID, Operation: "reply", Text: "attempt to replace a delivered instruction"}, 409, nil)
	continued := f.wait(f.send(switched.ChatID, "reply", switched.SessionID, "[wire] continue from Lever").ID, "completed")
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
	followUp := model.SendInput{CommandID: app.ID(), ChatID: inherited.ChatID, SessionID: inherited.SessionID, Operation: "reply", Text: "Lever-only follow-up", Delivery: "steer"}
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

func TestPersonalChannelChatModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX stdio fixture")
	}
	f := newFixture(t)
	agent := f.agent("codex")
	dir := t.TempDir()
	write := func(name, contents string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), mode); err != nil {
			t.Fatal(err)
		}
	}
	manifest := `{"manifestVersion":1,"id":"example.personal-modes","name":"Larkx","version":"1","contributes":{"channels":[{"id":"personal","name":"Larkx","driver":"personal-stdio-v1","command":"bridge"}]}}`
	write("lever-plugin.json", manifest, 0600)
	write("account", "100", 0600)
	write("bridge", `#!/bin/sh
set -eu
acct=$(cat account)
printf '{"event":"online","account":"%s","region":"feishu"}\n' "$acct"
if test -f inbox; then
  cat inbox
fi
while IFS= read -r input; do
  id=$(printf '%s\n' "$input" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  printf '{"id":"%s","status":"ok","remoteId":"999"}\n' "$id"
done
`, 0700)
	var installed model.Plugin
	f.request("POST", "/plugins", map[string]string{"directory": dir}, 200, &installed)
	path := "/plugins/" + installed.ID + "/channel"
	var view model.PersonalChannelView
	f.request("GET", path, nil, 200, &view)
	settings := view.Settings
	settings.ContextLimit = 0
	settings.Routes = []model.PersonalChannelRoute{{AgentID: agent.ID, Commands: []string{"/ai"}, Enabled: true}}
	f.request("PUT", path, settings, 200, nil)
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
	waitUntil("account did not connect", func() bool {
		f.request("GET", path, nil, 200, &view)
		return view.State == "online" && view.Account == "100"
	})
	event := func(id, sender, chat, chatName, text, kind, thread string) string {
		data, err := json.Marshal(map[string]any{"event": "message", "message": map[string]any{
			"id": id, "sender": sender, "chat": chat, "chatName": chatName, "text": text,
			"kind": kind, "thread": thread, "parent": "", "created": time.Now().Unix(),
		}})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	runByMessage := func(message string) model.Run {
		t.Helper()
		var id string
		if err := f.a.Store.DB.QueryRow("SELECT run_id FROM channel_deliveries WHERE part='answer' AND message_id=?", message).Scan(&id); err != nil {
			t.Fatal(message, err)
		}
		return f.wait(id, "completed")
	}
	deliveredCount := func() int {
		var count int
		_ = f.a.Store.DB.QueryRow("SELECT count(*) FROM channel_deliveries WHERE part='answer' AND status='sent'").Scan(&count)
		return count
	}

	// 1. Default single mode: 2 independent group triggers + 1 DM share one Chat with 3 Topics.
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	write("inbox", strings.Join([]string{
		event("201", "100", "300", "研发群", "/ai 排查构建失败", "group", ""),
		event("202", "100", "300", "研发群", "/ai 看下发布计划", "group", ""),
		event("203", "100", "400", "张三", "/ai 整理会议纪要", "dm", ""),
	}, "\n")+"\n", 0600)
	f.request("POST", path+"/connect", map[string]string{}, 200, nil)
	waitUntil("single mode turns not delivered", func() bool { return deliveredCount() == 3 })

	r201, r202, r203 := runByMessage("201"), runByMessage("202"), runByMessage("203")
	if r201.ChatID != r202.ChatID || r201.ChatID != r203.ChatID {
		t.Fatalf("single mode should share one Chat per Agent: %s %s %s", r201.ChatID, r202.ChatID, r203.ChatID)
	}
	if r201.SessionID == r202.SessionID || r201.SessionID == r203.SessionID || r202.SessionID == r203.SessionID {
		t.Fatalf("single mode should isolate independent conversations as distinct Topics: %s %s %s", r201.SessionID, r202.SessionID, r203.SessionID)
	}
	var singleChat model.ChatView
	f.request("GET", "/chats/"+r201.ChatID, nil, 200, &singleChat)
	if singleChat.Chat.Title != "Larkx" {
		t.Fatalf("unexpected single chat title: %q", singleChat.Chat.Title)
	}
	var s201, s203 model.SessionView
	f.request("GET", "/sessions/"+r201.SessionID, nil, 200, &s201)
	f.request("GET", "/sessions/"+r203.SessionID, nil, 200, &s203)
	if s201.Session.Kind != "topic" || s201.Session.Title != "研发群 · 排查构建失败" ||
		s201.Session.Channel == nil || s201.Session.Channel.ChatName != "研发群" || s201.Session.Channel.Command != "/ai" {
		t.Fatalf("unexpected group topic metadata: %+v", s201.Session)
	}
	if s203.Session.Kind != "topic" || s203.Session.Title != "张三" ||
		s203.Session.Channel == nil || s203.Session.Channel.Kind != "dm" {
		t.Fatalf("unexpected dm topic metadata: %+v", s203.Session)
	}

	// 2. Switch to byChat: existing single-mode Topic still continues in-place;
	// new group triggers share one Chat per Feishu group; new DM uses main session in its own Chat.
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	settings.ChatMode = model.PersonalChannelChatByChat
	f.request("PUT", path, settings, 200, nil)
	write("inbox", strings.Join([]string{
		event("204", "100", "300", "研发群", "/ai 继续追问", "group", "201"),
		event("205", "100", "300", "研发群", "/ai 新群话题一", "group", ""),
		event("206", "100", "300", "研发群", "/ai 新群话题二", "group", ""),
		event("207", "100", "500", "李四", "/ai 私聊第一句", "dm", ""),
		event("208", "100", "500", "李四", "/ai 私聊第二句", "dm", ""),
	}, "\n")+"\n", 0600)
	f.request("POST", path+"/connect", map[string]string{}, 200, nil)
	waitUntil("byChat turns not delivered", func() bool { return deliveredCount() == 8 })

	r204, r205, r206, r207, r208 := runByMessage("204"), runByMessage("205"), runByMessage("206"), runByMessage("207"), runByMessage("208")
	if r204.ChatID != r201.ChatID || r204.SessionID != r201.SessionID {
		t.Fatalf("existing single-mode topic lost continuity after switching to byChat: got (%s,%s) want (%s,%s)", r204.ChatID, r204.SessionID, r201.ChatID, r201.SessionID)
	}
	if r205.ChatID == r201.ChatID || r205.ChatID != r206.ChatID || r205.SessionID == r206.SessionID {
		t.Fatalf("byChat group should share one dedicated Chat with separate Topics: r205=(%s,%s) r206=(%s,%s)", r205.ChatID, r205.SessionID, r206.ChatID, r206.SessionID)
	}
	var groupChat, dmChat model.ChatView
	f.request("GET", "/chats/"+r205.ChatID, nil, 200, &groupChat)
	f.request("GET", "/chats/"+r207.ChatID, nil, 200, &dmChat)
	if groupChat.Chat.Title != "Larkx · 研发群" || dmChat.Chat.Title != "Larkx · 李四" {
		t.Fatalf("unexpected byChat titles: group=%q dm=%q", groupChat.Chat.Title, dmChat.Chat.Title)
	}
	if r207.ChatID == r205.ChatID || r207.ChatID != r208.ChatID || r207.SessionID != r208.SessionID {
		t.Fatalf("byChat DM should continue in the same Chat and main session: r207=(%s,%s) r208=(%s,%s)", r207.ChatID, r207.SessionID, r208.ChatID, r208.SessionID)
	}
	var s207 model.SessionView
	f.request("GET", "/sessions/"+r207.SessionID, nil, 200, &s207)
	if s207.Session.Kind != "main" {
		t.Fatalf("expected byChat DM to use main session, got %q", s207.Session.Kind)
	}
	f.request("GET", path, nil, 200, &view)
	if view.Last == nil || view.Last.Topic || view.Last.ChatID != r208.ChatID || view.Last.ChatName != "李四" {
		t.Fatalf("unexpected receipt for byChat DM: %+v", view.Last)
	}

	// 3. Switch to newChat: existing byChat Topic still continues in-place;
	// new group triggers each create an independent Chat with a main session.
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	settings.ChatMode = model.PersonalChannelChatNewChat
	f.request("PUT", path, settings, 200, nil)
	write("inbox", strings.Join([]string{
		event("209", "100", "300", "研发群", "/ai 续聊群话题一", "group", "205"),
		event("210", "100", "300", "研发群", "/ai 独立对话一", "group", ""),
		event("211", "100", "300", "研发群", "/ai 独立对话二", "group", ""),
	}, "\n")+"\n", 0600)
	f.request("POST", path+"/connect", map[string]string{}, 200, nil)
	waitUntil("newChat turns not delivered", func() bool { return deliveredCount() == 11 })

	r209, r210, r211 := runByMessage("209"), runByMessage("210"), runByMessage("211")
	if r209.ChatID != r205.ChatID || r209.SessionID != r205.SessionID {
		t.Fatalf("existing byChat topic lost continuity after switching to newChat")
	}
	if r210.ChatID == r211.ChatID || r210.ChatID == r205.ChatID || r210.ChatID == r201.ChatID {
		t.Fatalf("newChat mode must isolate each new conversation in its own Chat: r210=%s r211=%s", r210.ChatID, r211.ChatID)
	}
	var s210 model.SessionView
	f.request("GET", "/sessions/"+r210.SessionID, nil, 200, &s210)
	if s210.Session.Kind != "main" {
		t.Fatalf("expected newChat to use main session, got %q", s210.Session.Kind)
	}

	// 4. Switching accounts in single mode isolates the unified Chat by binding.
	f.request("POST", path+"/logout", map[string]string{}, 200, nil)
	settings.ChatMode = model.PersonalChannelChatSingle
	f.request("PUT", path, settings, 200, nil)
	write("account", "200", 0600)
	write("inbox", event("212", "200", "300", "研发群", "/ai 另一个账号", "group", "")+"\n", 0600)
	f.request("POST", path+"/login", map[string]string{"region": "feishu"}, 200, nil)
	waitUntil("second account turn not delivered", func() bool { return deliveredCount() == 12 })

	r212 := runByMessage("212")
	if r212.ChatID == r201.ChatID {
		t.Fatalf("second account must not reuse first account's unified Chat: %s", r212.ChatID)
	}
}
