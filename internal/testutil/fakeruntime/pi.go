package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
)

func piFixture() {
	models := []object{
		{"provider": "local", "id": "plain", "name": "Plain", "input": []string{"text"}},
		{"provider": "gateway", "id": "org/reasoner", "name": "Reasoner", "input": []string{"text", "image"}, "reasoning": true, "thinkingLevelMap": object{"minimal": nil, "xhigh": "extra"}},
	}
	path, thinking, active := "", "off", models[0]
	var systemPrompt string
	for i, arg := range os.Args {
		if i+1 == len(os.Args) {
			break
		}
		switch arg {
		case "--session":
			path = os.Args[i+1]
		case "--model":
			for _, entry := range models {
				if str(entry["provider"])+"/"+str(entry["id"]) == os.Args[i+1] {
					active = entry
				}
			}
		case "--thinking":
			thinking = os.Args[i+1]
		case "--append-system-prompt":
			systemPrompt = os.Args[i+1]
		}
	}
	history := []string{}
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			os.Exit(2)
		}
		if len(data) == 0 {
			if err := os.WriteFile(path, []byte("[]"), 0600); err != nil {
				os.Exit(2)
			}
		} else if json.Unmarshal(data, &history) != nil {
			os.Exit(2)
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 32<<20)
	for scanner.Scan() {
		var frame object
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		command := str(frame["type"])
		reply := func(data object) {
			send(object{"type": "response", "id": frame["id"], "command": command, "success": true, "data": data})
		}
		switch command {
		case "get_commands":
			reply(object{"commands": []object{{"name": "fixture-command", "source": "extension"}}})
		case "get_session_stats":
			reply(object{"contextUsage": object{"tokens": 1500, "contextWindow": 10000}})
		case "compact":
			reply(object{"summary": "Compacted: " + str(frame["customInstructions"])})
		case "get_state":
			reply(object{"sessionFile": path, "model": active, "thinkingLevel": thinking, "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0})
		case "get_available_models":
			if !slices.Contains(os.Args, "--no-session") || !slices.Contains(os.Args, "--offline") {
				os.Exit(2)
			}
			reply(object{"models": models})
		case "extension_ui_response":
			if frame["id"] != "checkpoint-question" || frame["value"] != "continue" {
				os.Exit(3)
			}
			send(object{"type": "agent_settled"})
		case "prompt":
			input := str(frame["message"])
			if strings.Contains(input, "[pi-reject]") {
				send(object{"type": "response", "id": frame["id"], "command": command, "success": false, "error": "Pi fixture rejected prompt"})
				continue
			}
			if strings.Contains(input, "[pi-handled]") {
				reply(nil)
				continue
			}
			reply(object{"disposition": "started"})
			if strings.Contains(input, "[pi-question]") {
				send(object{"type": "extension_ui_request", "id": "checkpoint-question", "method": "input", "title": "Continue this turn?"})
				continue
			}
			if strings.Contains(input, "[pi-disconnect]") {
				return
			}
			history = append(history, input)
			data, _ := json.Marshal(history)
			if err := os.WriteFile(path, data, 0600); err != nil {
				os.Exit(2)
			}
			send(object{"type": "tool_execution_start", "toolCallId": "inspect-1", "toolName": "read", "args": object{"path": "hello.go"}})
			send(object{"type": "tool_execution_end", "toolCallId": "inspect-1", "toolName": "read", "result": object{"content": []object{{"type": "text", "text": "Tool result"}}}})
			send(object{"type": "message_start", "message": object{"role": "assistant"}})
			send(object{"type": "message_update", "assistantMessageEvent": object{"type": "thinking_delta", "contentIndex": 0, "delta": "Thinking"}})
			send(object{"type": "message_update", "assistantMessageEvent": object{"type": "text_delta", "contentIndex": 1, "delta": "Partial"}})
			if images, ok := frame["images"].([]any); ok {
				data, _ = json.Marshal(images)
			}
			if script, ok := strings.CutPrefix(fixtureCommands(input), "[pi-context] "); ok {
				result, err := piContextReceipt(systemPrompt, script)
				data = result
				if err != nil {
					data = []byte(err.Error())
				}
			}
			send(object{"type": "message_end", "message": object{"role": "assistant", "stopReason": "stop", "content": []object{{"type": "thinking", "thinking": "Thinking"}, {"type": "text", "text": string(data)}}}})
			send(object{"type": "agent_settled"})
		}
	}
}

func piContextReceipt(systemPrompt, script string) ([]byte, error) {
	exe := os.Getenv("LEVER_FIXTURE_PI_CLI")
	if exe == "" || !strings.Contains(systemPrompt, " context find") || !strings.Contains(systemPrompt, " context read") {
		return nil, errors.New("Pi did not receive Lever CLI context instructions")
	}
	var calls [][]string
	if err := json.Unmarshal([]byte(script), &calls); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	results := make([]object, 0, len(calls))
	for _, args := range calls {
		cmd := exec.CommandContext(ctx, exe, args...)
		output, err := cmd.CombinedOutput()
		if err != nil {
			results = append(results, object{"error": strings.TrimSpace(string(output))})
		} else {
			results = append(results, object{"body": json.RawMessage(output)})
		}
	}
	return json.Marshal(results)
}
