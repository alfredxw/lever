package provider

import (
	"cmp"
	"strings"
)

type claudeSubagents struct {
	calls map[string]*subagent
	tasks map[string]*subagent
	tools map[string]*subagent
}

func isClaudeAgentTool(block object) bool {
	name := str(block["name"])
	return str(block["type"]) == "tool_use" && (name == "Agent" || name == "Task")
}

func (s claudeSubagents) approvalSource(frame object) string {
	request := obj(frame["request"])
	call := cmp.Or(str(frame["parent_tool_use_id"]), str(request["parent_tool_use_id"]))
	for _, match := range []*subagent{s.calls[call], s.tasks[str(request["agent_id"])], s.tools[str(request["tool_use_id"])]} {
		if match != nil {
			return match.item.ID
		}
	}
	if call != "" {
		return "subagent:" + call
	}
	return ""
}

func (s claudeSubagents) launch(block object, sink Sink) error {
	call := str(block["id"])
	if call == "" {
		return nil
	}
	agent := s.calls[call]
	if agent == nil {
		agent = newSubagent(call)
		s.calls[call] = agent
	}
	input := obj(block["input"])
	agent.task(str(input["description"]), str(input["prompt"]))
	return agent.publish(sink)
}

func (s claudeSubagents) frame(frame object, sink Sink) error {
	parent := s.calls[str(frame["parent_tool_use_id"])]
	content := arr(obj(frame["message"])["content"])
	switch str(frame["type"]) {
	case "system":
		return s.lifecycle(frame, sink)
	case "stream_event":
		event := obj(frame["event"])
		block := obj(event["content_block"])
		if str(event["type"]) == "content_block_start" && parent != nil && str(block["type"]) == "tool_use" {
			s.tools[str(block["id"])] = parent
		}
	case "assistant":
		for _, value := range content {
			block := obj(value)
			if isClaudeAgentTool(block) {
				if err := s.launch(block, sink); err != nil {
					return err
				}
			}
			if parent != nil && str(block["type"]) == "tool_use" {
				s.tools[str(block["id"])] = parent
			}
		}
		if parent != nil && parent.item.Status == "running" {
			if text := contentText(content); text != "" {
				parent.detail.Progress = clip(text)
				return parent.publish(sink)
			}
		}
	case "user":
		for _, value := range content {
			block := obj(value)
			if agent := s.calls[str(block["tool_use_id"])]; str(block["type"]) == "tool_result" && agent != nil {
				var receipt object
				if len(content) == 1 {
					receipt = obj(frame["tool_use_result"])
				}
				if err := s.result(agent, block, receipt, sink); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (s claudeSubagents) lifecycle(frame object, sink Sink) error {
	call, task := str(frame["tool_use_id"]), str(frame["task_id"])
	known := cmp.Or(s.calls[call], s.tasks[task])
	switch str(frame["subtype"]) {
	case "task_started":
		if str(frame["task_type"]) != "local_agent" && known == nil {
			return nil
		}
		// A resumed task gets a new tool call but its child messages can still
		// carry the original call ID. Both references point to the same activity.
		agent := known
		if agent == nil {
			id := cmp.Or(call, task)
			if id == "" {
				return nil
			}
			agent = newSubagent(id)
		} else if call != "" && s.calls[call] == nil && agent.item.Status != "running" {
			agent.restart()
		}
		if call != "" {
			s.calls[call] = agent
		}
		if task != "" {
			s.tasks[task] = agent
		}
		agent.task(str(frame["description"]), str(frame["prompt"]))
		return agent.publish(sink)
	case "task_progress":
		if known != nil && known.item.Status == "running" {
			known.detail.Progress = clip(cmp.Or(str(frame["description"]), str(frame["last_tool_name"])))
			return known.publish(sink)
		}
	case "task_notification":
		if status := subagentTerminalStatus(str(frame["status"])); known != nil && status != "" && known.item.Status == "running" {
			summary := str(frame["summary"])
			if summary == known.item.Title {
				summary = ""
			}
			known.finish(status, summary)
			return known.publish(sink)
		}
	}
	return nil
}

func (s claudeSubagents) result(agent *subagent, block, receipt object, sink Sink) error {
	id := str(receipt["agentId"])
	if id != "" {
		s.tasks[id] = agent
	}
	text := cmp.Or(contentText(receipt["content"]), contentText(block["content"]))
	status := subagentTerminalStatus(str(receipt["status"]))
	if block["is_error"] == true {
		status = "failed"
	} else if receipt["isAsync"] == true || str(receipt["status"]) == "async_launched" || strings.HasPrefix(text, "Async agent launched successfully.") {
		return nil
	}
	if status == "" {
		status = agent.item.Status
		if status == "running" {
			status = "completed"
		}
	}
	if at := strings.LastIndex(text, "\nagentId: "); at >= 0 && strings.Contains(text[at:], " to continue this agent)") {
		text = strings.TrimSpace(text[:at])
	}
	agent.finish(status, text)
	return agent.publish(sink)
}
