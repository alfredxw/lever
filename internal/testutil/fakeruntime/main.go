// This executable is a protocol fixture used only by integration/browser tests.
// It is never linked into Lever or exposed as a production provider.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type object = map[string]any

func obj(v any) object { m, _ := v.(map[string]any); return m }
func str(v any) string { s, _ := v.(string); return s }

// Plain-text fixture commands may be escaped by the composer's Markdown
// serializer. Normalize only command detection; receipts retain the real input.
func fixtureCommands(text string) string {
	if strings.HasPrefix(text, "Agent instructions:\n") {
		if _, user, ok := strings.Cut(text, "\n\nUser message:\n"); ok {
			text = user
		}
	}
	if at := strings.LastIndex(text, "\n\nCurrent user message:\n"); at >= 0 {
		text = text[at+len("\n\nCurrent user message:\n"):]
	}
	return strings.NewReplacer(`\[`, "[", `\]`, "]").Replace(text)
}

func fixtureTitle(prompt string) string {
	title, ok := strings.CutPrefix(prompt, "Title fixture: ")
	if !ok {
		return ""
	}
	if _, err := os.Stat("hold-title"); err == nil {
		_ = os.WriteFile("title-requested", []byte(title), 0600)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat("hold-title"); err != nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	return title
}

func fixtureSteerGate(input string) {
	if !strings.Contains(fixtureCommands(input), "[defer-steer]") {
		return
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat("allow-steer"); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	os.Exit(2)
}

var outMu sync.Mutex

func send(v any) { outMu.Lock(); defer outMu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }

func loginMarker() string {
	if os.Getenv("LEVER_FIXTURE_PROFILE_LOGIN") == "" {
		return ""
	}
	variable := "CODEX_HOME"
	if strings.HasPrefix(filepath.Base(os.Args[0]), "claude") {
		variable = "CLAUDE_CONFIG_DIR"
	}
	return filepath.Join(os.Getenv(variable), "fixture-login")
}

func fixtureSignedIn() bool {
	path := loginMarker()
	if path == "" {
		return true
	}
	_, err := os.Stat(path)
	return err == nil
}

func main() {
	name := filepath.Base(os.Args[0])
	nativeAGY := strings.TrimSuffix(name, filepath.Ext(name)) == "agy"
	if arg := os.Getenv("LEVER_FIXTURE_LAUNCH_ARGUMENT"); arg != "" && (slices.Contains(os.Args, "app-server") || slices.Contains(os.Args, "-p") || slices.Contains(os.Args, "rpc")) {
		if !slices.Contains(os.Args, arg) {
			fmt.Fprintln(os.Stderr, "missing launch argument")
			os.Exit(2)
		}
		if strings.HasPrefix(name, "claude") && os.Getenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW") != "300000" {
			fmt.Fprintln(os.Stderr, "incorrect compaction window")
			os.Exit(2)
		}
	}
	// Configuration isolation tests exercise every launch path, including probes.
	if expected := os.Getenv("LEVER_FIXTURE_EXPECT_CONFIG_DIR"); expected != "" {
		variable := "CODEX_HOME"
		if strings.HasPrefix(filepath.Base(os.Args[0]), "claude") {
			variable = "CLAUDE_CONFIG_DIR"
		}
		if os.Getenv(variable) != expected {
			fmt.Fprintln(os.Stderr, "unexpected configuration directory")
			os.Exit(2)
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "acp" {
		acpFixture()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--acp" {
		acpFixture()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		if nativeAGY {
			version := os.Getenv("LEVER_FIXTURE_AGY_VERSION")
			if version == "" {
				version = "1.5.12"
			}
			fmt.Println(version)
		} else {
			fmt.Println("fixture 1.0.0")
		}
		return
	}
	if nativeAGY && slices.Equal(os.Args[1:], []string{"--print", "/usage", "--output-format", "json"}) {
		if os.Getenv("AGY_CLI_DISABLE_AUTO_UPDATE") != "true" {
			os.Exit(2)
		}
		reset := time.Now().UTC().Add(4 * time.Hour).Format(time.RFC3339)
		send(object{"status": "SUCCESS", "command": object{"name": "usage", "data": object{"groups": []object{
			{"name": "Gemini Models", "buckets": []object{
				{"id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.75},
				{"id": "gemini-5h", "window": "5h", "remaining_fraction": 1, "reset_time": reset},
			}},
			{"name": "Claude and GPT models", "buckets": []object{
				{"id": "3p-weekly", "window": "weekly", "remaining_fraction": 0.5},
			}},
		}}}})
		return
	}
	if slices.Equal(os.Args[1:], []string{"login"}) || slices.Equal(os.Args[1:], []string{"auth", "login"}) {
		if marker := loginMarker(); marker != "" {
			if err := os.WriteFile(marker, []byte("signed in"), 0600); err != nil {
				os.Exit(1)
			}
		}
		fmt.Println("fixture native login")
		return
	}
	if slices.Equal(os.Args[1:], []string{"auth", "status"}) {
		signedIn := fixtureSignedIn()
		send(object{"loggedIn": signedIn})
		if !signedIn {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 2 && os.Args[1] == "--mode" && os.Args[2] == "rpc" {
		piFixture()
		return
	}
	if len(os.Args) > 2 && os.Args[1] == "--profile" && os.Args[2] == "acp" {
		acpFixture()
		return
	}
	if strings.HasPrefix(filepath.Base(os.Args[0]), "agy_acp_server") {
		acpFixture()
		return
	}
	if strings.HasPrefix(filepath.Base(os.Args[0]), "claude") {
		claude()
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 2<<20)
	native, prompt, turn, input := "", "", "", ""
	var clientMessageID, partialReply string
	var titleThread bool
	var writerBusy bool
	var goal object
	config := object{}
	approval, sandbox, reviewer := "", "", ""
	approved := 0
	var extraRoots []any
	catalogModel := os.Getenv("LEVER_FIXTURE_CODEX_CATALOG_MODEL")
	disabledSkills := fixtureCodexDisabled()
	complete := func(text string) {
		send(object{"method": "item/started", "params": object{"threadId": native, "turnId": turn, "item": object{"id": "answer", "type": "agentMessage", "text": ""}}})
		send(object{"method": "item/agentMessage/delta", "params": object{"threadId": native, "turnId": turn, "itemId": "answer", "delta": text}})
		send(object{"method": "item/completed", "params": object{"threadId": native, "turnId": turn, "item": object{"id": "answer", "type": "agentMessage", "text": text}}})
		send(object{"method": "turn/completed", "params": object{"threadId": native, "turn": object{"id": turn, "status": "completed"}}})
	}
	for scanner.Scan() {
		var frame object
		_ = json.Unmarshal(scanner.Bytes(), &frame)
		p := obj(frame["params"])
		method := str(frame["method"])
		if method == "" && frame["result"] != nil {
			if frame["id"] == "subagent-approval" {
				finishCodexSubagent(native, turn)
				if task, ok := strings.CutPrefix(fixtureCommands(input), "[delegate:"); ok {
					target, _, _ := strings.Cut(task, "]")
					if _, err := delegate(config, target); err != nil {
						complete("Delegation error: " + err.Error())
						continue
					}
				}
				complete("Parent reply after subagents.")
				continue
			}
			if frame["id"] == "approval-fail-once" {
				send(object{"method": "turn/completed", "params": object{"threadId": native, "turn": object{"id": turn, "status": "failed", "error": "Fixture failed on the first attempt"}}})
				continue
			}
			if strings.Contains(fixtureCommands(input), "[approval-chain]") {
				if str(obj(frame["result"])["decision"]) == "accept" {
					approved++
				}
				if frame["id"] == "approval-1" {
					send(object{"id": "approval-2", "method": "item/commandExecution/requestApproval", "params": object{"threadId": native, "turnId": turn, "command": "echo second approval"}})
					continue
				}
				complete(fmt.Sprintf("Approvals accepted: %d", approved))
				continue
			}
			complete("Approval received: " + fmt.Sprint(frame["result"]))
			continue
		}
		switch method {
		case "config/read":
			send(object{"id": frame["id"], "result": object{"config": object{"mcp_servers": object{"fixture": object{"enabled": true}}}}})
		case "account/read":
			var account object
			if fixtureSignedIn() {
				account = object{"type": "chatgpt"}
			}
			send(object{"id": frame["id"], "result": object{"account": account, "requiresOpenaiAuth": true}})
		case "experimentalFeature/list":
			send(object{"id": frame["id"], "result": object{"data": []object{{"name": "goals", "enabled": true}}}})
		case "thread/goal/get", "thread/goal/set", "thread/goal/clear":
			if native == "" || str(p["threadId"]) != native {
				os.Exit(3)
			}
			path := filepath.Join(os.Getenv("CODEX_HOME"), "fixture-goal-"+native+".json")
			goal = nil
			if data, err := os.ReadFile(path); err == nil {
				_ = json.Unmarshal(data, &goal)
			}
			switch method {
			case "thread/goal/set":
				if goal == nil {
					goal = object{}
				}
				if value, ok := p["objective"]; ok {
					goal["objective"] = value
				}
				goal["status"] = p["status"]
			case "thread/goal/clear":
				goal = nil
			}
			save := func() {
				b, _ := json.Marshal(goal)
				_ = os.MkdirAll(filepath.Dir(path), 0700)
				_ = os.WriteFile(path, b, 0600)
			}
			save()
			continuing := method == "thread/goal/set" && goal["status"] == "active" && !strings.Contains(str(goal["objective"]), "wait")
			if continuing {
				turn += "-continuation"
				send(object{"method": "turn/started", "params": object{"threadId": native, "turn": object{"id": turn}}})
			}
			send(object{"id": frame["id"], "result": object{"goal": goal}})
			if continuing {
				goal["status"] = "complete"
				save()
				send(object{"method": "thread/goal/updated", "params": object{"threadId": native, "goal": goal}})
				send(object{"method": "thread/tokenUsage/updated", "params": object{"threadId": native, "turnId": turn, "tokenUsage": object{"last": object{"totalTokens": 710}, "modelContextWindow": 10000}}})
				complete("Finished the native continuation.")
			}
		case "thread/compact/start":
			turn = "compaction-" + native
			send(object{"method": "turn/started", "params": object{"threadId": native, "turn": object{"id": turn}}})
			send(object{"method": "thread/compacted", "params": object{"threadId": native, "turnId": turn}})
			send(object{"method": "turn/completed", "params": object{"threadId": native, "turn": object{"id": turn, "status": "completed"}}})
			send(object{"id": frame["id"], "result": object{}})
		case "initialize", "skills/extraRoots/set":
			if method == "skills/extraRoots/set" {
				extraRoots, _ = p["extraRoots"].([]any)
			}
			result := object{}
			if method == "initialize" && catalogModel != "" {
				result = object{"codexHome": os.Getenv("CODEX_HOME"), "userAgent": "fixture/1.0.0"}
			}
			send(object{"id": frame["id"], "result": result})
		case "account/rateLimits/read":
			limits := object{
				"limitId": "codex",
				"primary": object{"usedPercent": 0, "windowDurationMins": 300,
					"resetsAt": time.Now().Add(2 * time.Hour).Unix()},
				"secondary": object{"usedPercent": 22, "windowDurationMins": 10080,
					"resetsAt": time.Now().Add(3 * 24 * time.Hour).Unix()},
			}
			send(object{"id": frame["id"], "result": object{
				"rateLimits": limits, "rateLimitsByLimitId": object{"codex": limits},
			}})
		case "skills/list":
			cwds, _ := p["cwds"].([]any)
			skills := fixtureCodexSkills(str(cwds[0]), extraRoots, disabledSkills)
			send(object{"id": frame["id"], "result": object{"data": []object{{"skills": skills}}}})
		case "model/list":
			if os.Getenv("LEVER_FIXTURE_CODEX_CATALOG_ERROR") == "1" {
				send(object{"id": frame["id"], "error": object{"code": -32000, "message": "model catalog request timed out"}})
				continue
			}
			if catalogModel != "" {
				if version := os.Getenv("LEVER_FIXTURE_CODEX_CATALOG_VERSION"); version != "" {
					stamp, _ := json.Marshal(object{"fetched_at": time.Now(), "client_version": version})
					if err := os.WriteFile(filepath.Join(os.Getenv("CODEX_HOME"), "models_cache.json"), stamp, 0600); err != nil {
						os.Exit(4)
					}
				}
				send(object{"id": frame["id"], "result": object{"data": []object{{"model": catalogModel, "isDefault": true}}}})
				continue
			}
			id, name, cursor := "gpt-test", "GPT Test", "page-2"
			if str(p["cursor"]) != "" {
				id, name, cursor = "gpt-review", "GPT Review", ""
			}
			models := []object{{"model": id, "displayName": name, "isDefault": cursor != "", "defaultReasoningEffort": "low", "supportedReasoningEfforts": []object{{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}, {"reasoningEffort": "high"}, {"reasoningEffort": "xhigh"}}, "serviceTiers": []object{{"id": "priority", "name": "Fast"}}}}
			if cursor == "" {
				for i := 0; i < 6; i++ {
					models = append(models, object{"model": fmt.Sprintf("gpt-fixture-%d", i), "displayName": fmt.Sprintf("GPT Fixture %d", i), "defaultReasoningEffort": "low", "supportedReasoningEfforts": []object{{"reasoningEffort": "low"}}})
				}
			}
			send(object{"id": frame["id"], "result": object{"data": models, "nextCursor": cursor}})
		case "thread/start", "thread/resume":
			if method == "thread/resume" && writerBusy {
				writerBusy = false
				send(object{"id": frame["id"], "error": object{"code": -32600, "message": "thread " + str(p["threadId"]) + " already has an active writer"}})
				continue
			}
			titleThread = p["ephemeral"] == true
			if titleThread && (p["sandbox"] != "read-only" || obj(obj(obj(p["config"])["mcp_servers"])["fixture"])["enabled"] != false) {
				os.Exit(3)
			}
			// Give the browser time to stop before the runtime returns a native ID.
			if cwd, _ := os.Getwd(); filepath.Base(cwd) == "slow-native-binding" {
				time.Sleep(time.Second)
			}
			native = str(p["threadId"])
			if strings.HasPrefix(native, "claude-") {
				send(object{"id": frame["id"], "error": object{"message": "foreign native session"}})
				continue
			}
			if native == "" {
				native = fmt.Sprintf("native-%d", time.Now().UnixNano())
			}
			prompt = str(p["developerInstructions"])
			config = obj(p["config"])
			approval, sandbox, reviewer = str(p["approvalPolicy"]), str(p["sandbox"]), str(p["approvalsReviewer"])
			send(object{"id": frame["id"], "result": object{"thread": object{"id": native}, "approvalsReviewer": reviewer}})
		case "thread/turns/list":
			var history object
			data, err := os.ReadFile("codex-restart-history.json")
			if os.IsNotExist(err) {
				data, err = os.ReadFile(fixtureCodexTurnFile(str(p["threadId"])))
			}
			if err != nil || json.Unmarshal(data, &history) != nil || history["threadId"] != p["threadId"] {
				send(object{"id": frame["id"], "error": object{"code": -32601, "message": "No saved fixture thread history"}})
				continue
			}
			turns := history["turns"]
			if native == "" {
				writerBusy = history["writerBusy"] == true
			} else if history["turnsAfterResume"] != nil {
				turns = history["turnsAfterResume"]
			}
			send(object{"id": frame["id"], "result": object{"data": turns}})
		case "turn/start":
			clientMessageID = str(p["clientUserMessageId"])
			turn, partialReply = clientMessageID, ""
			messages, _ := p["input"].([]any)
			if len(messages) == 0 {
				if messages == nil || turn != "" || native == "" || p["threadId"] != native {
					os.Exit(3)
				}
				turn = "resumed-" + native
				send(object{"id": frame["id"], "result": object{"turn": object{"id": turn}}})
				complete("Continued from the saved native turn")
				continue
			}
			input = str(obj(messages[0])["text"])
			if titleThread {
				if p["outputSchema"] == nil {
					os.Exit(3)
				}
				title, _ := json.Marshal(object{"title": fixtureTitle(input)})
				complete(string(title))
				send(object{"id": frame["id"], "result": object{"turn": object{"id": turn}}})
				continue
			}
			if context := obj(p["additionalContext"]); len(context) > 0 {
				keys := make([]string, 0, len(context))
				for key := range context {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				var text strings.Builder
				for _, key := range keys {
					entry := obj(context[key])
					value := str(entry["value"])
					if len(value) > 4000 || entry["kind"] != "application" {
						os.Exit(2)
					}
					text.WriteString(value)
				}
				_, prompt, _ = strings.Cut(text.String(), "\n\n")
			}
			commands := fixtureCommands(input)
			if rest, ok := strings.CutPrefix(commands, "[turn-diff:"); ok {
				name, _, _ := strings.Cut(rest, "]")
				turn = "native-turn-" + turn
				patch := fmt.Sprintf("diff --git a/%[1]s b/%[1]s\n--- a/%[1]s\n+++ b/%[1]s\n@@ -1 +1 @@\n-old\n+native edit\n", name)
				diff := func(threadID, turnID, value string) {
					send(object{"method": "turn/diff/updated", "params": object{"threadId": threadID, "turnId": turnID, "diff": value}})
				}
				diff(native, turn, patch)
				diff(native, "previous-turn", "stale")
				send(object{"method": "turn/completed", "params": object{"threadId": native, "turn": object{"id": "previous-turn", "status": "completed"}}})
				send(object{"id": frame["id"], "result": object{"turn": object{"id": turn}}})
				diff("child-thread", turn, "child")
				diff(native, "previous-turn", "stale")
				if strings.Contains(commands, "[clear-diff]") {
					diff(native, turn, "")
				}
				if strings.Contains(commands, "[approval]") {
					send(object{"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": object{"threadId": native, "turnId": turn, "command": "echo fixture"}})
				} else {
					complete("Reviewed " + name)
				}
				continue
			}
			if strings.Contains(commands, "[fail-once]") {
				cwd, _ := os.Getwd()
				marker := filepath.Join(cwd, ".git", native+".failed-once")
				file, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if err == nil {
					file.Close()
					send(object{"id": frame["id"], "result": object{"turn": object{"id": turn}}})
					send(object{"method": "item/completed", "params": object{"threadId": native, "turnId": turn, "item": object{"id": "partial", "type": "agentMessage", "text": "Partial reply"}}})
					send(object{"id": "approval-fail-once", "method": "item/commandExecution/requestApproval", "params": object{"threadId": native, "turnId": turn, "command": "echo fixture"}})
					continue
				}
				if !errors.Is(err, os.ErrExist) {
					os.Exit(2)
				}
			}
			send(object{"id": frame["id"], "result": object{"turn": object{"id": turn}}})
			notify := func(method string, params object) {
				params["threadId"], params["turnId"] = native, turn
				send(object{"method": method, "params": params})
			}
			switch {
			case strings.Contains(commands, "[restart-checkpoint]"):
				receipt := fmt.Sprintf("%d %s %s", os.Getpid(), native, turn)
				suffix := ""
				if strings.Contains(commands, "[mcp]") {
					suffix = "-mcp"
				}
				f, err := os.OpenFile("provider-starts"+suffix, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					os.Exit(2)
				}
				fmt.Fprintln(f, receipt)
				f.Close()
				deadline := time.Now().Add(40 * time.Second)
				for {
					if _, err = os.Stat("continue-provider"); err == nil {
						break
					}
					if time.Now().After(deadline) {
						os.Exit(2)
					}
					time.Sleep(20 * time.Millisecond)
				}
				if err = os.WriteFile("provider-finished"+suffix, []byte(receipt), 0600); err != nil {
					os.Exit(2)
				}
				if suffix != "" {
					receipt, err = chatContextReceipt(fixtureMCP(config), input, `[{"name":"work_item_create","arguments":{"title":"Worker reconnected","requestKey":"restart-test"}}]`)
					if err != nil {
						receipt = err.Error()
					}
				}
				complete(receipt)
			case strings.Contains(commands, "[subagents]"):
				startCodexSubagents(native, turn)
			case strings.Contains(commands, "[command-exits]"):
				for _, item := range []object{
					{"id": "missing", "command": "ls -d node_modules", "exitCode": 1, "aggregatedOutput": "ls: node_modules: No such file or directory"},
					{"id": "no-match", "command": "rg NoMatch", "exitCode": 1},
					{"id": "launch-error", "command": "pwd", "exitCode": -1, "aggregatedOutput": "Failed to start shell"},
				} {
					item["type"], item["status"] = "commandExecution", "failed"
					notify("item/completed", object{"item": item})
				}
				complete("Done.")
			case strings.Contains(commands, "[tool-activity]"):
				notify("item/completed", object{"item": object{
					"id": "review", "type": "reasoning", "summary": []string{"**Review the workspace.** Then verify the edit."},
				}})
				notify("item/completed", object{"item": object{
					"id": "where", "type": "commandExecution", "command": "pwd", "exitCode": 0,
				}})
				notify("item/completed", object{"item": object{
					"id": "edit", "type": "fileChange", "status": "failed", "changes": []object{{"path": "hello.go"}},
				}})
				notify("item/completed", object{"item": object{
					"id": "verify", "type": "reasoning", "summary": []string{"Check the remaining references."},
				}})
				notify("item/started", object{"item": object{
					"id": "version", "type": "commandExecution", "command": "go version",
				}})
				notify("item/started", object{"item": object{
					"id": "search", "type": "commandExecution", "command": "rg Greeting",
					"commandActions": []object{{"type": "search", "query": "Greeting"}},
				}})
			case strings.Contains(commands, "[thinking]"):
				if p["summary"] != "auto" {
					os.Exit(2)
				}
				thought := object{"type": "reasoning", "id": "thought", "summary": []string{}, "content": []string{}}
				notify("item/started", object{"item": thought})
				notify("item/reasoning/textDelta", object{"itemId": "thought", "contentIndex": 0, "delta": "Alternate reasoning."})
				notify("item/reasoning/summaryTextDelta", object{"itemId": "thought", "summaryIndex": 0, "delta": "Review the **"})
				notify("item/reasoning/summaryTextDelta", object{"itemId": "thought", "summaryIndex": 1, "delta": "Compare the results."})
				notify("item/reasoning/summaryTextDelta", object{"itemId": "thought", "summaryIndex": 0, "delta": "input**."})
				if strings.Contains(commands, "[hang]") {
					continue
				}
				notify("item/completed", object{"item": thought})
				notify("item/completed", object{"item": object{"type": "reasoning", "id": "snapshot", "summary": []string{"Confirm the answer."}}})
				complete("Done.")
			case strings.Contains(commands, "[wire]"):
				images := 0
				skills := []object{}
				for _, message := range messages {
					m := obj(message)
					if str(m["type"]) == "skill" {
						data, err := os.ReadFile(str(m["path"]))
						if err != nil {
							os.Exit(2)
						}
						skills = append(skills, object{"name": m["name"], "path": m["path"], "content": string(data)})
					}
					if str(m["type"]) == "localImage" {
						data, err := os.ReadFile(str(m["path"]))
						if err != nil || len(data) == 0 {
							os.Exit(2)
						}
						images++
					}
				}
				cwd, _ := os.Getwd()
				available := fixtureVisibleSkills(fixtureCodexSkills(cwd, extraRoots, disabledSkills))
				b, _ := json.Marshal(object{"native": native, "model": p["model"], "effort": p["effort"], "tier": p["serviceTier"], "images": images, "input": input, "skills": skills, "approval": approval, "sandbox": sandbox, "reviewer": reviewer, "instructions": prompt, "cwd": cwd, "availableSkills": available})
				complete("wire:" + string(b))
			case strings.HasPrefix(commands, "[chat-context]"):
				result, err := chatContextReceipt(fixtureMCP(config), input, strings.TrimSpace(strings.TrimPrefix(commands, "[chat-context]")))
				if err != nil {
					complete("Chat context error: " + err.Error())
				} else if strings.HasSuffix(commands, "[approval]") || strings.HasSuffix(commands, "[approval-fail]") {
					id := "approval-1"
					if strings.HasSuffix(commands, "[approval-fail]") {
						id = "approval-fail-once"
					}
					send(object{"id": id, "method": "item/commandExecution/requestApproval", "params": object{"threadId": native, "turnId": turn, "command": "echo approval-fixture"}})
				} else {
					complete(result)
				}
			case strings.Contains(commands, "[worktree-setup]"):
				value, err := os.ReadFile("setup-marker")
				if err != nil {
					complete(err.Error())
				} else {
					complete("Worktree setup: " + string(value))
				}
			case strings.Contains(commands, "[approval]") || strings.Contains(commands, "[approval-chain]"):
				send(object{"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": object{"threadId": native, "turnId": turn, "command": "echo approval-fixture"}})
			case strings.Contains(commands, "[question]"):
				send(object{"id": "question-1", "method": "item/tool/requestUserInput", "params": object{"threadId": native, "questions": []object{{"id": "choice", "question": "Choose a color", "options": []object{{"label": "Green", "description": "Calm"}, {"label": "Blue", "description": "Cool"}}}}}})
			case strings.Contains(commands, "[pausable]"):
				partialReply = "Partial reply before the pause"
				send(object{"method": "item/agentMessage/delta", "params": object{"threadId": native, "turnId": turn, "itemId": "partial-answer", "delta": partialReply}})
			case strings.Contains(commands, "[hang]") || strings.Contains(commands, "[finish-on-steer]") || strings.Contains(commands, "[disconnect-steer]"):
				send(object{"method": "turn/completed", "params": object{"threadId": "different-child-thread", "turn": object{"id": turn, "status": "completed"}}})
			case strings.Contains(commands, "[disconnect]"):
				os.Exit(1)
			case strings.HasPrefix(commands, "[delegate:"):
				target, _, _ := strings.Cut(strings.TrimPrefix(commands, "[delegate:"), "]")
				result, err := delegate(config, target)
				if err != nil {
					complete("Delegation error: " + err.Error())
				} else {
					complete(result)
				}
			default:
				time.Sleep(60 * time.Millisecond)
				complete("Session: " + native + "\n\nProfile: " + prompt + "\n\n" + input + "\n\n**已完成。**")
			}
		case "turn/steer":
			if str(p["expectedTurnId"]) != turn || str(p["threadId"]) != native {
				os.Exit(3)
			}
			if strings.Contains(fixtureCommands(input), "[disconnect-steer]") {
				os.Exit(1)
			}
			if strings.Contains(fixtureCommands(input), "[finish-on-steer]") {
				complete("Finished before steer")
				send(object{"id": frame["id"], "error": object{"message": "No active turn"}})
				continue
			}
			messages, _ := p["input"].([]any)
			text := str(obj(messages[0])["text"])
			send(object{"id": frame["id"], "result": object{"turnId": turn}})
			if !strings.Contains(fixtureCommands(text), "[hang]") {
				complete("Steered: " + text + "\n\nProfile: " + prompt)
			}
		case "turn/interrupt":
			commands := fixtureCommands(input)
			if strings.Contains(commands, "[unconfirmed-pause]") {
				return
			}
			items := []object{}
			if !strings.Contains(commands, "[missing-pause-input]") {
				items = append(items, object{"type": "userMessage", "id": "original-user-message", "clientId": clientMessageID})
			}
			if partialReply != "" {
				items = append(items, object{"type": "agentMessage", "id": "saved-partial-answer", "text": partialReply})
			}
			ended := object{"id": turn, "status": "interrupted", "completedAt": time.Now().Unix(), "items": items}
			if home := os.Getenv("CODEX_HOME"); home != "" {
				data, _ := json.Marshal(object{"threadId": native, "turns": []object{ended}})
				_ = os.MkdirAll(home, 0700)
				_ = os.WriteFile(fixtureCodexTurnFile(native), data, 0600)
			}
			send(object{"id": frame["id"], "result": object{}})
			send(object{"method": "turn/completed", "params": object{"threadId": native, "turn": ended}})
		}
	}
}

func fixtureCodexTurnFile(threadID string) string {
	return filepath.Join(os.Getenv("CODEX_HOME"), "fixture-turn-"+filepath.Base(threadID)+".json")
}

type transport struct{ token string }

func (t transport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", t.token)
	return http.DefaultTransport.RoundTrip(r)
}
func fixtureMCP(config object) mcp.Transport {
	c := obj(config["mcp_servers.lever"])
	return fixtureHTTPMCP(str(c["url"]), str(obj(c["http_headers"])["Authorization"]))
}

func fixtureHTTPMCP(endpoint, authorization string) mcp.Transport {
	return &mcp.StreamableClientTransport{Endpoint: endpoint, HTTPClient: &http.Client{Transport: transport{authorization}}}
}

func connectFixtureMCP(ctx context.Context, transport mcp.Transport) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	return client.Connect(ctx, transport, nil)
}

func delegate(config object, target string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	session, err := connectFixtureMCP(ctx, fixtureMCP(config))
	if err != nil {
		return "", err
	}
	defer session.Close()
	in := object{"agentId": target, "requestKey": "fixture-task", "task": "Review the implementation"}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "delegate_start", Arguments: in})
	if err != nil {
		return "", err
	}
	if result.IsError {
		return "", errors.New(result.Content[0].(*mcp.TextContent).Text)
	}
	raw, _ := json.Marshal(result.StructuredContent)
	var d object
	_ = json.Unmarshal(raw, &d)
	// A retry must return the same execution, never start another child.
	again, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "delegate_start", Arguments: in})
	if err != nil {
		return "", err
	}
	againRaw, _ := json.Marshal(again.StructuredContent)
	if string(raw) != string(againRaw) {
		return "", fmt.Errorf("delegation was duplicated")
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "delegate_wait", Arguments: object{"id": d["id"]}})
	if err != nil {
		return "", err
	}
	raw, _ = json.Marshal(result.StructuredContent)
	return string(raw), nil
}

func claude() {
	native := fmt.Sprintf("claude-%d", time.Now().UnixNano())
	var resumed, pausable, toolInFlight bool
	modelName, effort, permission := "", "", ""
	instructions := ""
	settings := object{}
	cwd, _ := os.Getwd()
	dirs := []string{cwd}
	var plugins []string
	for i, arg := range os.Args {
		if arg == "--resume" && i+1 < len(os.Args) {
			native = os.Args[i+1]
			resumed = true
		}
		if i+1 < len(os.Args) {
			switch arg {
			case "--model":
				modelName = os.Args[i+1]
			case "--effort":
				effort = os.Args[i+1]
			case "--permission-mode":
				permission = os.Args[i+1]
			case "--settings":
				_ = json.Unmarshal([]byte(os.Args[i+1]), &settings)
			case "--add-dir":
				dirs = append(dirs, os.Args[i+1])
			case "--plugin-dir":
				plugins = append(plugins, os.Args[i+1])
			}
		}
	}
	if strings.HasPrefix(native, "native-") {
		os.Exit(2)
	}
	commands := fixtureClaudeSkills(dirs, plugins, obj(settings["skillOverrides"]))
	for _, name := range []string{"goal", "loop", "compact", "context"} {
		commands = append(commands, object{"name": name, "builtin": true})
	}
	if os.Getenv("LEVER_FIXTURE_PLUGIN_COMMANDS") == "1" {
		commands = append(commands, object{"name": "fixture-plugin:action"}, object{"name": "fixture-plugin:skill"})
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 32<<20)
	for scanner.Scan() {
		var f object
		_ = json.Unmarshal(scanner.Bytes(), &f)
		switch str(f["type"]) {
		case "control_request":
			r := obj(f["request"])
			if r["subtype"] == "interrupt" && pausable {
				writeClaudeFixtureMessage(native, "user", uuid.NewString())
				send(object{"type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_streaming", "session_id": native})
				send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f["request_id"]}})
				continue
			}
			if r["subtype"] == "get_skills_dialog" {
				var skills []object
				for _, c := range commands {
					if c["builtin"] != true && c["name"] != "fixture-plugin:action" {
						skills = append(skills, c)
					}
				}
				send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f["request_id"], "response": object{"skills": skills}}})
			}
			if r["subtype"] == "generate_session_title" {
				send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f["request_id"], "response": object{"title": fixtureTitle(str(r["description"]))}}})
			}
			if r["subtype"] == "get_context_usage" {
				send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f["request_id"], "response": object{"totalTokens": 2000, "maxTokens": 10000}}})
			}
			if str(r["subtype"]) == "get_usage" {
				usage := object{
					"rate_limits_available": true,
					"rate_limits": object{
						"five_hour": object{"utilization": 68.5,
							"resets_at": time.Now().UTC().Add(4 * time.Hour).Format(time.RFC3339)},
						"seven_day": object{"utilization": 24, "resets_at": nil},
					},
				}
				send(object{"type": "control_response", "response": object{
					"subtype": "success", "request_id": f["request_id"], "response": usage,
				}})
			}
			if str(r["subtype"]) == "initialize" {
				instructions = str(r["appendSystemPrompt"])
				fast := "off"
				if settings["fastMode"] == true {
					fast = "on"
				}
				send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f["request_id"], "response": object{"commands": commands, "fast_mode_state": fast, "models": []object{{"value": "default", "displayName": "Claude Sonnet", "supportsFastMode": true, "supportedEffortLevels": []string{"low", "medium", "high", "max"}}, {"value": "claude-review", "displayName": "Claude Opus", "supportsFastMode": true, "supportedEffortLevels": []string{"low", "high", "max"}}}}}})
			}
			if str(r["subtype"]) == "set_permission_mode" {
				permission = str(r["mode"])
				send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": f["request_id"], "response": object{}}})
			}
		case "control_response":
			r := obj(f["response"])
			if r["request_id"] == "subagent-approval" {
				finishClaudeSubagent(native)
			}
			if r["request_id"] == "claude-approval" {
				text := "Claude received " + permission + " and " + str(obj(r["response"])["behavior"])
				send(object{"type": "assistant", "message": object{"id": "msg-approval", "content": []object{{"type": "text", "text": text}}}})
				send(object{"type": "result", "subtype": "success", "session_id": native, "result": text})
			}
		case "user":
			if toolInFlight {
				toolInFlight = false
				if f["priority"] != "next" {
					send(object{"type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": "aborted_tools"})
					continue
				}
				send(object{"type": "user", "message": object{"content": []object{{"type": "tool_result", "tool_use_id": "original-tool", "content": "original tool finished"}}}})
			}
			if str(f["priority"]) == "now" {
				send(object{"type": "result", "terminal_reason": "aborted_streaming", "subtype": "success", "session_id": native})
			}
			send(object{"type": "user", "uuid": f["uuid"], "message": f["message"], "isReplay": true})
			content, _ := obj(f["message"])["content"].([]any)
			text := str(obj(f["message"])["content"])
			if len(content) > 0 {
				text = str(obj(content[0])["text"])
			}
			if content != nil && len(content) == 0 {
				if !resumed {
					os.Exit(3)
				}
				if _, err := os.Stat(claudeFixtureTranscript(native)); err != nil {
					os.Exit(3)
				}
				text = "Continued from the saved native turn"
			}
			if strings.Contains(fixtureCommands(text), "[pausable]") {
				if !resumed {
					native = uuid.NewString()
				}
				pausable = true
				writeClaudeFixtureMessage(native, "user", str(f["uuid"]))
				send(object{"type": "system", "subtype": "init", "session_id": native})
				send(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "claude-partial"}}})
				send(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": 0, "content_block": object{"type": "text", "text": "Partial reply before the pause"}}})
				continue
			}
			if strings.Contains(fixtureCommands(text), "[wire]") {
				images := 0
				for _, block := range content {
					m := obj(block)
					if str(m["type"]) == "image" {
						source := obj(m["source"])
						data, err := base64.StdEncoding.DecodeString(str(source["data"]))
						if err != nil || len(data) == 0 || str(source["media_type"]) != "image/png" {
							os.Exit(2)
						}
						images++
					}
				}
				b, _ := json.Marshal(object{"native": native, "model": modelName, "effort": effort, "fast": settings["fastMode"], "images": images, "input": text, "instructions": instructions, "permission": permission, "cwd": cwd, "availableSkills": fixtureVisibleSkills(commands)})
				text = "wire:" + string(b)
			}
			send(object{"type": "system", "subtype": "init", "session_id": native})
			if fixtureClaudeCommand(native, text) {
				continue
			}
			if strings.Contains(fixtureCommands(text), "[subagents]") {
				startClaudeSubagents(native)
				continue
			}
			if strings.Contains(fixtureCommands(text), "[claude-approval]") {
				send(object{"type": "control_request", "request_id": "claude-approval", "request": object{"subtype": "can_use_tool", "tool_name": "Bash", "input": object{"command": "echo claude-fixture"}}})
				continue
			}
			if strings.Contains(fixtureCommands(text), "[hang]") {
				continue
			}
			if strings.Contains(fixtureCommands(text), "[steer-tool]") {
				toolInFlight = true
				send(object{"type": "assistant", "message": object{"id": "before-steer", "content": []object{{"type": "text", "text": "before steer"}, {"type": "tool_use", "name": "Read", "id": "original-tool"}}}})
				continue
			}
			send(object{"type": "stream_event", "event": object{"type": "message_start", "message": object{"id": "msg-1"}}})
			index := 0
			if strings.Contains(fixtureCommands(text), "[thinking]") {
				thought := object{"type": "thinking", "thinking": ""}
				send(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": index, "content_block": thought}})
				for _, delta := range []string{"Review the **", "input**."} {
					send(object{"type": "stream_event", "event": object{"type": "content_block_delta", "index": index, "delta": object{"type": "thinking_delta", "thinking": delta}}})
				}
				send(object{"type": "assistant", "message": object{"id": "msg-1", "content": []object{thought}}})
				send(object{"type": "stream_event", "event": object{"type": "content_block_stop", "index": index}})
				index++
				text = "Done."
			}
			send(object{"type": "stream_event", "event": object{"type": "content_block_start", "index": index, "content_block": object{"type": "text", "text": ""}}})
			send(object{"type": "stream_event", "event": object{"type": "content_block_delta", "index": index, "delta": object{"type": "text_delta", "text": text}}})
			send(object{"type": "assistant", "message": object{"id": "msg-1", "content": []object{{"type": "text", "text": text}}}})
			send(object{"type": "result", "parent_tool_use_id": "child-1", "subtype": "success", "result": "child-only"})
			send(object{"type": "result", "subtype": "success", "session_id": native, "result": text})
		}
	}
}

func claudeFixtureTranscript(session string) string {
	return filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "projects", "fixture", filepath.Base(session)+".jsonl")
}

func writeClaudeFixtureMessage(session, kind, id string) {
	path := claudeFixtureTranscript(session)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		panic(err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(object{"uuid": id, "type": kind}); err != nil {
		panic(err)
	}
}
