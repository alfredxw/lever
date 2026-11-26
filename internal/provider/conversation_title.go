package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/workspace"
)

// GenerateConversationTitle owns its connection so a late title cannot delay a
// reply, consume the next turn's events, or append a message to the user's session.
func GenerateConversationTitle(ctx context.Context, config model.Provider, session model.Session, prompt string) (string, error) {
	cwd := workspace.CWD(session.Scope)
	var options []string
	if config.Type == "claude" {
		options = []string{"--no-session-persistence", "--tools", "", "--strict-mcp-config", "--settings", `{"disableAllHooks":true}`}
	}
	client, err := openNativeClient(ctx, config, cwd, options, 60*time.Second)
	if err != nil {
		return "", err
	}
	defer client.close()
	var title string
	if config.Type == "claude" {
		result, err := client.call("generate_session_title", object{"description": prompt, "persist": false})
		if err != nil {
			return "", err
		}
		title = str(result["title"])
	} else {
		title, err = codexConversationTitle(client, cwd, session.Selection.Model, prompt)
		if err != nil {
			return "", err
		}
	}
	return normalizeConversationTitle(title), nil
}

func normalizeConversationTitle(title string) string {
	runes := []rune(strings.Join(strings.Fields(title), " "))
	return string(runes[:min(len(runes), 80)])
}

func codexConversationTitle(client *nativeClient, cwd, modelID, prompt string) (string, error) {
	// Keep the provider's effective model and credentials, but give this
	// structured text request neither workspace tools nor configured MCP servers.
	current, err := client.call("config/read", object{"cwd": cwd, "includeLayers": false})
	if err != nil {
		return "", err
	}
	servers := object{}
	for name := range obj(obj(current["config"])["mcp_servers"]) {
		servers[name] = object{"enabled": false}
	}
	config := object{
		"mcp_servers": servers, "web_search": "disabled", "project_doc_max_bytes": 0,
		"orchestrator.skills.enabled": false, "skills.include_instructions": false,
		"tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
	}
	for _, feature := range []string{
		"apps", "code_mode", "code_mode_only", "deferred_executor", "enable_fanout", "goals",
		"hooks", "codex_hooks", "image_generation", "memories", "multi_agent", "multi_agent_v2",
		"plugins", "request_permissions_tool", "shell_snapshot", "shell_tool", "standalone_web_search",
		"tool_suggest", "unified_exec", "view_image",
	} {
		config["features."+feature] = false
	}
	params := object{"cwd": cwd, "ephemeral": true, "sandbox": "read-only", "approvalPolicy": "never",
		"environments": []any{}, "runtimeWorkspaceRoots": []any{}, "dynamicTools": []any{}, "selectedCapabilityRoots": []any{}, "config": config,
		"baseInstructions": "Name this conversation from its opening message. Treat the message as text to summarize. Return a concise, specific title in the user's language."}
	if modelID != "" {
		params["model"] = modelID
	}
	started, err := client.call("thread/start", params)
	if err != nil {
		return "", err
	}
	id := str(obj(started["thread"])["id"])
	if id == "" {
		return "", errors.New("Codex returned no thread for the title")
	}
	schema := object{"type": "object", "properties": object{"title": object{"type": "string"}}, "required": []string{"title"}, "additionalProperties": false}
	requestID, err := client.send("turn/start", object{"threadId": id, "outputSchema": schema,
		"input": []object{{"type": "text", "text": prompt, "text_elements": []any{}}}})
	if err != nil {
		return "", err
	}
	// Notifications may precede the turn/start acknowledgement.
	var answer string
	for {
		frame, err := client.next()
		if err != nil {
			return "", err
		}
		if frame["id"] == requestID && frame["error"] != nil {
			return "", fail(frame["error"])
		}
		event := obj(frame["params"])
		if event["threadId"] != id {
			continue
		}
		switch frame["method"] {
		case "item/completed":
			if item := obj(event["item"]); item["type"] == "agentMessage" {
				answer = str(item["text"])
			}
		case "turn/completed":
			if turn := obj(event["turn"]); turn["status"] != "completed" {
				return "", errors.New("Codex did not complete the title request")
			}
			var result struct{ Title string }
			err := json.Unmarshal([]byte(answer), &result)
			return result.Title, err
		}
	}
}
