package main

import (
	"strings"
	"time"
)

func fixtureClaudeCommand(session, text string) bool {
	reply := func(id, model, text string) {
		send(object{"type": "assistant", "message": object{"id": id, "model": model, "content": []object{{"type": "text", "text": text}}, "usage": object{"input_tokens": 128, "cache_read_input_tokens": 1800, "cache_creation_input_tokens": 68, "output_tokens": 4}}})
	}
	result := func() {
		send(object{"type": "result", "subtype": "success", "session_id": session, "modelUsage": object{"claude-test": object{"inputTokens": 90000, "contextWindow": 10000}}})
	}
	tool := func(name, id string, data object) {
		send(object{"type": "assistant", "message": object{"id": "tool-" + id, "content": []object{{"type": "tool_use", "name": name, "id": id, "input": object{}}}}})
		send(object{"type": "user", "tool_use_result": data, "message": object{"content": []object{{"type": "tool_result", "tool_use_id": id, "content": "scheduler acknowledgement"}}}})
	}
	switch {
	case text == "/goal":
		reply("status", "<synthetic>", "No goal set. Usage: `/goal <condition>`")
	case strings.HasPrefix(text, "/goal "):
		reply("goal-set", "<synthetic>", "Goal set: "+strings.TrimPrefix(text, "/goal "))
		reply("goal-answer", "claude-test", "Finished the objective.")
	case text == "/compact":
		send(object{"type": "system", "subtype": "compact_boundary", "session_id": session})
		reply("compaction", "<synthetic>", "Conversation compacted.")
	case strings.HasPrefix(text, "/loop "):
		if strings.Contains(text, "fixed") {
			tool("CronCreate", "cron", object{"id": "job-7", "recurring": true})
		} else {
			tool("ScheduleWakeup", "wake", object{"scheduledFor": time.Now().Add(time.Second).UnixMilli()})
			time.AfterFunc(90*time.Millisecond, func() {
				send(object{"type": "system", "subtype": "init", "session_id": session})
				reply("wake-answer", "claude-test", "The scheduled turn ran.")
				result()
			})
		}
	case text == "cancel the fixed loop":
		tool("CronDelete", "delete", object{"id": "job-7"})
	default:
		return false
	}
	result()
	return true
}
