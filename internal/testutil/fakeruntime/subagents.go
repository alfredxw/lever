package main

func startCodexSubagents(parent, turn string) {
	child := parent + "-child"
	send(object{"method": "item/completed", "params": object{"threadId": parent, "turnId": turn, "item": object{
		"id": "spawn-new", "type": "subAgentActivity", "kind": "started", "agentThreadId": child, "agentPath": "/root/check_sources",
	}}})
	send(object{"method": "item/completed", "params": object{"threadId": parent, "turnId": turn, "item": object{
		"id": "spawn-old", "type": "collabAgentToolCall", "tool": "spawnAgent", "status": "completed", "receiverThreadIds": []string{parent + "-unfinished"},
		"prompt": "Compare schedules", "agentsStates": object{parent + "-unfinished": object{"status": "running"}},
	}}})
	send(object{"method": "turn/started", "params": object{"threadId": child, "turn": object{"id": turn + "-child"}}})
	send(object{"method": "item/completed", "params": object{"threadId": child, "turnId": turn + "-child", "item": object{
		"id": "child-prompt", "type": "userMessage", "content": []object{{"type": "text", "text": "Inspect the source references."}},
	}}})
	send(object{"id": "subagent-approval", "method": "item/commandExecution/requestApproval", "params": object{"threadId": child, "turnId": turn + "-child", "command": "echo read-only fixture"}})
}

func finishCodexSubagent(parent, turn string) {
	child := parent + "-child"
	send(object{"method": "item/completed", "params": object{"threadId": child, "turnId": turn + "-child", "item": object{
		"id": "child-output", "type": "agentMessage", "phase": "final_answer", "text": "Checked both source references.",
	}}})
	send(object{"method": "turn/completed", "params": object{"threadId": child, "turn": object{"id": turn + "-child", "status": "completed"}}})
	send(object{"method": "item/completed", "params": object{"threadId": parent, "turnId": turn, "item": object{
		"id": "child-completed", "type": "subAgentActivity", "kind": "completed", "agentThreadId": child,
	}}})
}

func startClaudeSubagents(session string) {
	for _, work := range []struct{ call, task, title string }{
		{"call-1", "task-1", "Check sources"}, {"call-2", "task-2", "Compare schedules"},
	} {
		send(object{"type": "assistant", "message": object{"id": work.call, "content": []object{{
			"type": "tool_use", "id": work.call, "name": "Agent", "input": object{"description": work.title, "prompt": work.title, "run_in_background": true},
		}}}})
		send(object{"type": "system", "subtype": "task_started", "session_id": session, "task_type": "local_agent", "tool_use_id": work.call, "task_id": work.task, "description": work.title})
		send(object{"type": "user", "tool_use_result": object{"isAsync": true, "status": "async_launched", "agentId": work.task}, "message": object{"content": []object{{
			"type": "tool_result", "tool_use_id": work.call, "content": "Async agent launched successfully.",
		}}}})
	}
	send(object{"type": "result", "parent_tool_use_id": "call-1", "subtype": "success", "result": "child-only"})
	send(object{"type": "system", "subtype": "task_progress", "session_id": session, "task_id": "task-1", "description": "Reading the sources"})
	send(object{"type": "control_request", "request_id": "subagent-approval", "parent_tool_use_id": "call-1", "request": object{"subtype": "can_use_tool", "tool_name": "Bash", "input": object{"command": "echo read-only fixture"}}})
}

func finishClaudeSubagent(session string) {
	send(object{"type": "system", "subtype": "task_notification", "session_id": session, "task_id": "task-1", "status": "completed", "summary": "Checked both source references."})
	send(object{"type": "result", "subtype": "success", "session_id": session, "result": "Parent reply after subagents."})
}
