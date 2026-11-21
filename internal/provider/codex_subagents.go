package provider

import (
	"cmp"
	"path"
	"strings"
)

type codexSubagent struct {
	*subagent
	turn   string
	answer string
}

type codexSubagents map[string]*codexSubagent

func (s codexSubagents) add(id string) *codexSubagent {
	if s[id] == nil {
		s[id] = &codexSubagent{subagent: newSubagent(id)}
	}
	return s[id]
}

// Activity items in the parent identify children. Their own turn frames supply
// progress and outcomes, and never enter the parent transcript.
func (s codexSubagents) lifecycle(item object, owner string, sink Sink) error {
	switch str(item["type"]) {
	case "subAgentActivity":
		id := str(item["agentThreadId"])
		if id == "" || id == owner {
			return nil
		}
		if str(item["kind"]) == "started" {
			agent := s.add(id)
			name := str(item["agentPath"])
			if name != "" && agent.item.Title == "" {
				agent.task(strings.ReplaceAll(path.Base(name), "_", " "), "")
			}
			return agent.publish(sink)
		}
		if agent := s[id]; agent != nil && agent.item.Status == "running" {
			if status := subagentTerminalStatus(str(item["kind"])); status != "" {
				agent.finish(status, agent.answer)
				return agent.publish(sink)
			}
		}
	case "collabAgentToolCall":
		states := obj(item["agentsStates"])
		for _, receiver := range arr(item["receiverThreadIds"]) {
			id := str(receiver)
			if id == "" || id == owner {
				continue
			}
			agent := s[id]
			if str(item["tool"]) == "spawnAgent" {
				agent = s.add(id)
				agent.task("", str(item["prompt"]))
			}
			if agent == nil {
				continue
			}
			state := obj(states[id])
			if status := subagentTerminalStatus(str(state["status"])); status != "" && (agent.item.Status == "running" || agent.item.Status == status) {
				agent.finish(status, cmp.Or(str(state["message"]), agent.answer))
			}
			if err := agent.publish(sink); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s codexSubagents) frame(agent *codexSubagent, method string, params object, sink Sink) error {
	turn := obj(params["turn"])
	id := cmp.Or(str(params["turnId"]), str(turn["id"]))
	if method != "turn/started" && agent.turn != "" && id != "" && id != agent.turn {
		return nil
	}
	item := obj(params["item"])
	switch method {
	case "turn/started":
		if id != "" && agent.turn != "" && agent.turn != id {
			agent.restart()
			agent.answer = ""
		}
		agent.turn = id
	case "item/started":
		return s.lifecycle(item, str(params["threadId"]), sink)
	case "item/completed":
		switch str(item["type"]) {
		case "userMessage":
			agent.task("", contentText(item["content"]))
		case "agentMessage":
			message := clip(str(item["text"]))
			if message == "" {
				return nil
			}
			agent.detail.Progress = message
			if str(item["phase"]) != "commentary" {
				agent.answer = message
			}
		default:
			return s.lifecycle(item, str(params["threadId"]), sink)
		}
	case "turn/completed":
		status := subagentTerminalStatus(str(turn["status"]))
		if status == "" {
			return nil
		}
		if status == "failed" {
			agent.finish(status, str(obj(turn["error"])["message"]))
		} else {
			agent.finish(status, agent.answer)
		}
	default:
		return nil
	}
	return agent.publish(sink)
}
