package main

// This fixture intentionally uses raw JSON rather than Lever's adapter or the
// ACP SDK. Its protocol and persisted sessions are an independent test oracle.
import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.yaml.in/yaml/v3"
)

func acpFixture() {
	identity := "fixture"
	nativeCLI := len(os.Args) > 1 && os.Args[1] == "acp"
	processPerSession := slices.Contains(os.Args, "--process-per-session")
	if nativeCLI && processPerSession && os.Getenv("LEVER_FIXTURE_AGY_LEGACY_ACP") == "1" {
		fmt.Fprintln(os.Stderr, "flag provided but not defined: -process-per-session")
		os.Exit(2)
	}
	dsh := len(os.Args) > 2 && os.Args[1] == "--profile" && os.Args[2] == "acp"
	defaultModel, otherModel := "acp-model", "acp-other"
	dshImages := false
	if dsh {
		if slices.Contains(os.Args, "--dump-config") {
			fmt.Print(`- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: {provider: deepseek-official, model: deepseek-flash}
- id: acp
  name: '@deepseek-ai/dsh-acp'
  config: {provider: deepseek-official, model: deepseek-v4-flash, sessionListPageSize: 17}
`)
			return
		}
		defaultModel, otherModel = `["deepseek-official","deepseek-v4-flash"]`, `["deepseek-official","deepseek-v4-pro"]`
		if len(os.Args) == 5 && os.Args[3] == "--patch" {
			data, err := os.ReadFile(os.Args[4])
			var patch []struct {
				ID     string
				Config struct {
					Provider, Model string
					PageSize        int `yaml:"sessionListPageSize"`
				}
			}
			if err != nil || yaml.Unmarshal(data, &patch) != nil || len(patch) != 1 ||
				patch[0].ID != "acp" || patch[0].Config.Provider != "deepseek-official" || patch[0].Config.PageSize != 17 {
				os.Exit(2)
			}
			if patch[0].Config.Model == "deepseek-flash" {
				defaultModel = `["deepseek-official","deepseek-flash"]`
				dshImages = os.Getenv("LEVER_FIXTURE_DSH_TEXT_ONLY") == ""
			}
		}
	}
	antigravity := nativeCLI || strings.HasPrefix(filepath.Base(os.Args[0]), "agy_acp_server")
	if antigravity {
		identity = "antigravity"
	}
	if len(os.Args) > 2 && !nativeCLI {
		identity = os.Args[2]
	}
	legacy := slices.Contains(os.Args, "--legacy")
	limited := slices.Contains(os.Args, "--limited")
	singleRoot := slices.Contains(os.Args, "--single-root")
	modelEfforts := slices.Contains(os.Args, "--model-efforts")
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 32<<20)
	var native, cwd, mode, model, effort string
	var directories, servers []any
	var history []string
	var promptID any
	var steerTarget any
	var receipt object
	waitingForMode := false
	var meta any
	authenticated := nativeCLI
	path := func() string { return filepath.Join(cwd, ".fixture-acp", identity, native+".json") }
	save := func() {
		_ = os.MkdirAll(filepath.Dir(path()), 0700)
		b, _ := json.Marshal(object{"history": history, "mode": mode, "model": model, "effort": effort})
		_ = os.WriteFile(path(), b, 0600)
	}
	state := func() object {
		result := object{"sessionId": native}
		if legacy {
			result["modes"] = object{"currentModeId": mode, "availableModes": []object{{"id": "review-mode", "name": "Review safely"}, {"id": "build-mode", "name": "Build changes"}}}
			result["models"] = object{"currentModelId": model, "availableModels": []object{{"modelId": "acp-model", "name": "ACP Model"}, {"modelId": "acp-other", "name": "ACP Other"}}}
		} else {
			result["configOptions"] = []object{
				{"id": "native-model-key", "name": "Model", "type": "select", "category": "model", "currentValue": model, "options": []object{{"value": defaultModel, "name": "ACP Model"}, {"value": otherModel, "name": "ACP Other"}}},
				{"id": "native-mode-key", "name": "Mode", "type": "select", "category": "mode", "currentValue": mode, "options": []object{{"value": "review-mode", "name": "Review safely"}, {"value": "build-mode", "name": "Build changes", "description": "Allows workspace edits."}}},
				{"id": "native-effort-key", "name": "Reasoning", "type": "select", "category": "thought_level", "currentValue": effort, "options": []object{{"value": "balanced", "name": "Balanced"}, {"value": "deep", "name": "Deep"}}},
			}
			if modelEfforts {
				options := result["configOptions"].([]object)
				options[0]["options"] = append(options[0]["options"].([]object), object{"value": "acp-plain", "name": "ACP Plain"})
				switch model {
				case "acp-plain":
					result["configOptions"] = options[:2]
				case "acp-other":
					options[2]["options"] = []object{{"value": "balanced", "name": "Balanced"}}
				}
			}
			if antigravity {
				options := result["configOptions"].([]object)
				options[0]["id"] = "model"
				delete(options[0], "category")
				if model == "acp-other" {
					options[2]["options"] = []object{{"value": "high", "name": "High"}, {"value": "ultra", "name": "Ultra"}}
				}
				if nativeCLI {
					options[1]["options"] = append(options[1]["options"].([]object),
						object{"value": "default", "name": "Default"},
						object{"value": "accept-edits", "name": "Accept edits"},
						object{"value": "auto", "name": "Auto"},
						object{"value": "plan", "name": "Plan"},
					)
				}
			}
		}
		return result
	}
	notify := func(update object) {
		send(object{"jsonrpc": "2.0", "method": "session/update", "params": object{"sessionId": native, "update": update}})
	}
	complete := func() {
		save()
		receipt["history"] = history
		data, _ := json.Marshal(receipt)
		notify(object{"sessionUpdate": "tool_call", "toolCallId": "native-tool", "title": "Inspect workspace", "status": "in_progress"})
		notify(object{"sessionUpdate": "tool_call_update", "toolCallId": "native-tool", "status": "completed"})
		notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": string(data)}})
		send(object{"jsonrpc": "2.0", "id": promptID, "result": object{"stopReason": "end_turn"}})
	}
	for scanner.Scan() {
		var frame object
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		params := obj(frame["params"])
		method := str(frame["method"])
		respond := func(result any) { send(object{"jsonrpc": "2.0", "id": frame["id"], "result": result}) }
		switch method {
		case "initialize":
			if slices.Contains(os.Args, "--hold-initialize") {
				fixtureSteerGate("[defer-steer]")
			}
			caps := object{"loadSession": !slices.Contains(os.Args, "--no-resume"), "promptCapabilities": object{"image": !limited && (!dsh || dshImages), "audio": slices.Contains(os.Args, "--audio"), "embeddedContext": !limited && !dsh}, "sessionCapabilities": object{}}
			if !limited && (!nativeCLI || processPerSession) {
				caps["mcpCapabilities"] = object{"http": true}
			}
			if !limited && !dsh && !singleRoot {
				obj(caps["sessionCapabilities"])["additionalDirectories"] = object{}
			}
			if modelEfforts {
				obj(caps["sessionCapabilities"])["close"] = object{}
			}
			version := "1.0.0"
			if antigravity {
				version = "1.4.5"
				if nativeCLI {
					version = "1.5.1"
				}
				caps["loadSession"] = false
				obj(caps["sessionCapabilities"])["resume"] = object{}
			}
			if dsh {
				caps["loadSession"] = false
				obj(caps["sessionCapabilities"])["resume"] = object{}
			}
			init := object{"protocolVersion": 1, "agentInfo": object{"name": "ACP fixture", "version": version}, "authMethods": []any{}, "agentCapabilities": caps}
			if slices.Contains(os.Args, "--steering-extension") {
				init["agentInfo"] = object{"name": "@agentclientprotocol/codex-acp", "version": "2.4.0"}
				init["_meta"] = object{"steering": object{"supported": true}}
			}
			respond(init)
		case "authenticate":
			if antigravity && !nativeCLI && params["methodId"] == "gemini-api-key" {
				if os.Getenv("GEMINI_API_KEY") != "fixture-gemini-key" || os.Getenv("GOOGLE_API_KEY") != "" {
					os.Exit(2)
				}
				authenticated = true
				respond(object{})
				continue
			}
			if !antigravity || nativeCLI || str(params["methodId"]) != "oauth-personal" {
				os.Exit(2)
			}
			token := filepath.Join(os.Getenv("GEMINI_HOME"), "antigravity-acp", "fixture-token")
			if _, err := os.Stat(token); err != nil {
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					os.Exit(2)
				}
				done := make(chan struct{}, 1)
				server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Query().Get("code") != "fixture" || r.URL.Query().Get("state") != "fixture" {
						http.Error(w, "invalid fixture callback", 400)
						return
					}
					done <- struct{}{}
				})}
				go server.Serve(listener)
				link := fmt.Sprintf("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture&redirect_uri=http%%3A%%2F%%2F127.0.0.1%%3A%d%%2F", listener.Addr().(*net.TCPAddr).Port)
				fmt.Println("Open the following link to authenticate the ACP server: " + link)
				<-done
				_ = server.Shutdown(context.Background())
				_ = os.WriteFile(token, []byte("fixture"), 0600)
			}
			authenticated = true
			respond(object{})
		case "session/new", "session/load", "session/resume":
			if antigravity && !authenticated {
				os.Exit(2)
			}
			meta = params["_meta"]
			cwd = str(params["cwd"])
			directories, _ = params["additionalDirectories"].([]any)
			servers, _ = params["mcpServers"].([]any)
			mode, model, effort = "review-mode", defaultModel, "balanced"
			if nativeCLI {
				mode = "default"
			}
			native = str(params["sessionId"])
			if native == "" {
				native = fmt.Sprintf("%s-%d", identity, time.Now().UnixNano())
				history = []string{}
			} else {
				if !strings.HasPrefix(native, identity+"-") {
					send(object{"jsonrpc": "2.0", "id": frame["id"], "error": object{"code": -32602, "message": "foreign instance session"}})
					continue
				}
				data, err := os.ReadFile(path())
				if err != nil {
					send(object{"jsonrpc": "2.0", "id": frame["id"], "error": object{"code": -32602, "message": "session not found"}})
					continue
				}
				var saved struct {
					History             []string
					Mode, Model, Effort string
				}
				_ = json.Unmarshal(data, &saved)
				history, mode, model, effort = saved.History, saved.Mode, saved.Model, saved.Effort
				if nativeCLI && len(history) != 0 && strings.HasPrefix(fixtureCommands(history[0]), "[agy-token-login]") {
					send(object{"jsonrpc": "2.0", "id": frame["id"], "error": object{"code": -32000, "message": "Authentication required", "data": "private-fixture-detail"}})
					continue
				}
				for _, text := range history {
					notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "REPLAY MUST NOT APPEAR: " + text}})
				}
			}
			save()
			commands := []object{{"name": "goal", "description": "Work toward an objective", "input": object{"hint": "objective"}}, {"name": "compact", "description": "Summarize the current conversation"}}
			if antigravity {
				for _, root := range append([]any{cwd}, directories...) {
					for _, skill := range fixtureSkills(filepath.Join(str(root), ".agents", "skills")) {
						commands = append(commands, object{"name": skill["name"], "description": skill["description"]})
					}
				}
			}
			notify(object{"sessionUpdate": "available_commands_update", "availableCommands": commands})
			respond(state())
		case "session/set_config_option":
			key := str(params["configId"])
			switch key {
			case "native-mode-key":
				mode = str(params["value"])
			case "native-model-key":
				model = str(params["value"])
				if modelEfforts {
					switch model {
					case "acp-plain":
						effort = ""
					case "acp-other":
						effort = "balanced"
					}
				}
			case "model":
				model = str(params["value"])
				if model == "acp-other" {
					effort = "high"
				} else {
					effort = "balanced"
				}
			case "native-effort-key":
				effort = str(params["value"])
			}
			save()
			respond(state())
			if waitingForMode && key == "native-mode-key" {
				waitingForMode = false
				receipt["mode"] = mode
				complete()
			}
		case "session/set_mode":
			mode = str(params["modeId"])
			save()
			respond(object{})
			if waitingForMode {
				waitingForMode = false
				receipt["mode"] = mode
				complete()
			}
		case "session/set_model":
			model = str(params["modelId"])
			save()
			respond(object{})
		case "session/prompt", "_session/steering":
			promptID = frame["id"]
			blocks, _ := params["prompt"].([]any)
			input := ""
			images, resources := 0, 0
			for _, block := range blocks {
				b := obj(block)
				switch str(b["type"]) {
				case "text":
					input += str(b["text"])
				case "image":
					images++
				case "resource":
					resources++
				}
			}
			history = append(history, input)
			if steerTarget != nil {
				if str(params["sessionId"]) != native {
					os.Exit(2)
				}
				if method == "_session/steering" {
					if obj(obj(params["_meta"])["steering"])["idleBehavior"] != "promptRequired" {
						os.Exit(2)
					}
					if strings.Contains(input, "[reject-steer]") {
						respond(object{"outcome": "promptRequired"})
					} else {
						respond(object{"outcome": "injected"})
					}
				} else {
					send(object{"jsonrpc": "2.0", "id": steerTarget, "result": object{"stopReason": "end_turn"}})
				}
				if strings.Contains(input, "[disconnect-steer]") {
					return
				}
				notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "after: " + input}})
				if method == "_session/steering" {
					promptID = steerTarget
				}
				send(object{"jsonrpc": "2.0", "id": promptID, "result": object{"stopReason": "end_turn"}})
				steerTarget = nil
				continue
			}
			if strings.Contains(fixtureCommands(input), "[steer-open]") {
				fixtureSteerGate(input)
				steerTarget = promptID
				notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "before steer"}})
				continue
			}
			if input == "/compact" {
				notify(object{"sessionUpdate": "available_commands_update", "availableCommands": []object{}})
				notify(object{"sessionUpdate": "usage_update", "used": 32, "size": 4096})
			}
			receipt = object{"native": native, "input": input, "mode": mode, "model": model, "effort": effort, "cwd": cwd, "directories": directories, "servers": servers, "images": images, "resources": resources, "args": os.Args[1:]}
			if singleRoot || limited || strings.Contains(input, "[audio-wire]") {
				receipt["prompt"] = blocks
			}
			if antigravity {
				receipt["meta"] = meta
				receipt["profile"] = os.Getenv("GEMINI_HOME")
				receipt["nativeConfigDir"] = os.Getenv("ANTIGRAVITY_CLI_CONFIG_DIR")
				receipt["fileStorage"] = os.Getenv("AGY_ACP_FORCE_FILE_STORAGE")
				receipt["ambientKey"] = os.Getenv("GEMINI_API_KEY")
				if i, j := slices.Index(os.Args, "--gemini-dir"), slices.Index(os.Args, "--cli_dir_name"); i > 0 && j > 0 {
					data, err := os.ReadFile(filepath.Join(os.Args[i+1], "antigravity-cli", os.Args[j+1], "settings.json"))
					var settings object
					if err != nil || json.Unmarshal(data, &settings) != nil {
						os.Exit(2)
					}
					receipt["presetSettings"] = settings
				}
			}
			command := fixtureCommands(input)
			if nativeCLI && strings.HasPrefix(fixtureCommands(history[0]), "[agy-token-") {
				receipt["pid"] = os.Getpid()
				if strings.HasPrefix(command, "[agy-token-pending]") {
					notify(object{"sessionUpdate": "tool_call", "toolCallId": "unconfirmed", "title": "Unconfirmed tool", "status": "pending"})
				}
				if err := fixtureAntigravityFailure(native, history); err != nil {
					panic(err)
				}
			}
			switch {
			case strings.HasPrefix(command, "[chat-context]"):
				result, err := chatContextReceipt(acpContextTransport(servers), input, strings.TrimSpace(strings.TrimPrefix(command, "[chat-context]")))
				if err != nil {
					result = "context error: " + err.Error()
				}
				save()
				notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": result}})
				respond(object{"stopReason": "end_turn"})
			case strings.Contains(command, "[agy-live-thinking]"):
				notify(object{
					"sessionUpdate": "agent_thought_chunk",
					"messageId":     "thought-1",
					"content":       object{"type": "text", "text": "**Inspecting ACP adapter**\n\nChecking acp.go.\n\n**Checking tool payloads**\n\nNeed to verify rawInput and rawOutput."},
				})
				notify(object{
					"sessionUpdate": "tool_call",
					"toolCallId":    "read-acp",
					"title":         "Running view_file",
					"kind":          "read",
					"status":        "in_progress",
					"locations":     []object{{"path": filepath.Join(cwd, "internal", "provider", "acp.go")}},
				})
				notify(object{
					"sessionUpdate": "tool_call",
					"toolCallId":    "sub-1",
					"title":         "Run invoke_subagent",
					"kind":          "other",
					"status":        "in_progress",
					"rawInput":      object{"Role": "Codebase Researcher", "Prompt": "Trace RunActivity layout"},
				})
				if !strings.Contains(command, "[hang]") {
					notify(object{
						"sessionUpdate": "tool_call_update",
						"toolCallId":    "read-acp",
						"status":        "completed",
						"rawOutput":     "package provider\n",
					})
					notify(object{
						"sessionUpdate": "tool_call_update",
						"toolCallId":    "sub-1",
						"status":        "completed",
						"rawOutput":     "Traced RunActivity.",
					})
					notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Adjusted display."}})
					respond(object{"stopReason": "end_turn"})
				}
			case strings.Contains(command, "[thinking]"):
				for _, delta := range []string{"", "Review the **", "input**."} {
					notify(object{"sessionUpdate": "agent_thought_chunk", "content": object{"type": "text", "text": delta}})
				}
				if !strings.Contains(command, "[hang]") {
					notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Done."}})
					respond(object{"stopReason": "end_turn"})
				}
			case strings.Contains(command, "[disconnect]"):
				notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "partial before disconnect"}})
				os.Exit(0)
			case strings.Contains(command, "[approval]"):
				send(object{"jsonrpc": "2.0", "id": "permission-original-id", "method": "session/request_permission", "params": object{"sessionId": native, "toolCall": object{"toolCallId": "native-tool", "title": "ACP approval"}, "options": []object{{"optionId": "native:allow:once", "name": "Allow once", "kind": "allow_once"}, {"optionId": "native:reject:once", "name": "Reject once", "kind": "reject_once"}}}})
				if strings.Contains(command, "[drop-approval]") {
					time.Sleep(100 * time.Millisecond)
					os.Exit(0)
				}
			case strings.Contains(command, "[hang]"):
				notify(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "ACP waiting"}})
			case strings.Contains(command, "[mode-change]"):
				waitingForMode = true
			default:
				complete()
			}
		case "session/close":
			_ = os.Remove(path())
			respond(object{})
		case "session/cancel":
			if promptID != nil {
				send(object{"jsonrpc": "2.0", "id": promptID, "result": object{"stopReason": "cancelled"}})
				promptID = nil
			}
		case "":
			if frame["id"] == "permission-original-id" {
				receipt["permission"] = obj(obj(frame["result"])["outcome"])
				complete()
			}
		}
	}
}

func acpContextTransport(servers []any) mcp.Transport {
	for _, raw := range servers {
		server := obj(raw)
		if server["name"] != "lever" {
			continue
		}
		if server["type"] == "http" {
			headers, _ := server["headers"].([]any)
			for _, rawHeader := range headers {
				header := obj(rawHeader)
				if header["name"] == "Authorization" {
					return fixtureHTTPMCP(str(server["url"]), str(header["value"]))
				}
			}
		}
		if command := str(server["command"]); command != "" {
			rawArgs, _ := server["args"].([]any)
			args := make([]string, 0, len(rawArgs))
			for _, arg := range rawArgs {
				args = append(args, str(arg))
			}
			cmd := exec.Command(command, args...)
			cmd.Env = os.Environ()
			cmd.Stderr = os.Stderr
			env, _ := server["env"].([]any)
			for _, rawEntry := range env {
				entry := obj(rawEntry)
				cmd.Env = append(cmd.Env, str(entry["name"])+"="+str(entry["value"]))
			}
			return &mcp.CommandTransport{Command: cmd}
		}
	}
	return nil
}
