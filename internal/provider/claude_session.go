package provider

import (
	"context"
	"regexp"
	"strings"
	"time"

	"lever/internal/model"
)

// Claude exposes goals through its own local-command replies. Model-authored
// text with the same wording must never change the session state.
var claudeActiveGoal = regexp.MustCompile(`(?s)^Goal active: (.+?) \((?:not yet evaluated|[0-9]+ turns?)\)(?: Last check:.*)?$`)

func claudeGoalReply(frame object) (*model.SessionGoal, bool) {
	if str(frame["parent_tool_use_id"]) != "" {
		return nil, false
	}
	if frame["type"] == "system" && frame["subtype"] == "informational" &&
		strings.HasPrefix(str(frame["content"]), "Goal cleared after an unrecoverable error (") {
		return nil, true
	}
	message := obj(frame["message"])
	if frame["type"] != "assistant" || message["model"] != "<synthetic>" {
		return nil, false
	}
	var content strings.Builder
	for _, block := range arr(message["content"]) {
		if b := obj(block); b["type"] == "text" {
			content.WriteString(str(b["text"]))
		}
	}
	text := strings.TrimSpace(content.String())
	if strings.HasPrefix(text, "No goal set") || strings.HasPrefix(text, "Goal cleared: ") {
		return nil, true
	}
	objective, set := strings.CutPrefix(text, "Goal set: ")
	if !set {
		match := claudeActiveGoal.FindStringSubmatch(text)
		if match == nil {
			return nil, false
		}
		objective = match[1]
	}
	if objective = strings.TrimSpace(objective); objective == "" {
		return nil, false
	}
	return &model.SessionGoal{Objective: objective, Status: "active"}, true
}

// A scheduled turn is owned by the running CLI. Keep it alive only once its
// scheduler has acknowledged a wakeup or recurring job, including renewal.
type claudeLoop struct {
	calls        map[string]string
	recurring    map[string]bool
	monitors     map[string]bool
	wakeup       int64
	possibleWake bool
	idle         bool
}

func (l *claudeLoop) observe(f object) {
	m := obj(f["message"])
	switch f["type"] {
	case "assistant":
		for _, part := range arr(m["content"]) {
			b := obj(part)
			if b["type"] != "tool_use" {
				continue
			}
			switch name := str(b["name"]); name {
			case "ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "Monitor":
				if l.calls == nil {
					l.calls = map[string]string{}
				}
				l.calls[str(b["id"])] = name
			}
		}
	case "user":
		for _, part := range arr(m["content"]) {
			b := obj(part)
			if b["type"] != "tool_result" {
				continue
			}
			id := str(b["tool_use_id"])
			name := l.calls[id]
			delete(l.calls, id)
			result := obj(f["tool_use_result"])
			if name == "ScheduleWakeup" {
				l.possibleWake, l.wakeup = false, 0
				if at, ok := result["scheduledFor"].(float64); ok && b["is_error"] != true {
					l.wakeup = int64(at)
				}
			}
			if b["is_error"] == true {
				continue
			}
			job := str(result["id"])
			switch name {
			case "Monitor":
				if task := str(result["taskId"]); task != "" {
					if l.monitors == nil {
						l.monitors = map[string]bool{}
					}
					l.monitors[task] = true
				}
			case "CronCreate":
				if job != "" && result["recurring"] == true {
					if l.recurring == nil {
						l.recurring = map[string]bool{}
					}
					l.recurring[job] = true
				}
			case "CronDelete":
				delete(l.recurring, job)
			case "CronList":
				if jobs, ok := result["jobs"].([]any); ok {
					remaining := map[string]bool{}
					for _, j := range jobs {
						if id := str(obj(j)["id"]); l.recurring[id] {
							remaining[id] = true
						}
					}
					l.recurring = remaining
				}
			}
		}
	case "system":
		if f["subtype"] == "task_notification" {
			delete(l.monitors, str(f["task_id"]))
		}
		if f["subtype"] == "init" && l.idle {
			l.idle = false
			now := time.Now()
			if l.wakeup > 0 && now.UnixMilli() >= l.wakeup {
				l.wakeup = 0
			} else {
				// The CLI can wake before its rounded timestamp. A task notification
				// in this window can also start a turn, so wait for its origin.
				l.possibleWake = l.wakeup > 0 && now.Add(2*time.Minute).UnixMilli() >= l.wakeup
			}
		}
	case "result":
		if l.possibleWake && obj(f["origin"])["kind"] != "task-notification" {
			l.wakeup = 0
		}
		l.possibleWake = false
	}
}

func (l *claudeLoop) waiting() bool {
	return l.wakeup > 0 || len(l.recurring) != 0 || len(l.monitors) != 0
}

// After a real model turn, ask the native /goal command whether a goal is
// still active. A successful model result alone cannot establish that.
func finishClaude(ctx context.Context, r *claudeResident, sink Sink, checkGoal, refreshContext bool) (bool, error) {
	if !checkGoal && !refreshContext {
		return true, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	p := r.p
	waitGoalResult := checkGoal
	if checkGoal {
		if err := p.Send(object{"type": "user", "message": object{"role": "user", "content": "/goal"}}); err != nil {
			return false, nil
		}
	}
	var contextReqID string
	if refreshContext {
		contextReqID = r.nextRequestID("context")
		if err := p.Send(object{"type": "control_request", "request_id": contextReqID, "request": object{"subtype": "get_context_usage"}}); err != nil {
			return false, nil
		}
	}
	for refreshContext || checkGoal || waitGoalResult {
		select {
		case <-ctx.Done():
			return false, nil
		case data, ok := <-p.Frames:
			if !ok {
				return false, nil
			}
			f, err := decode(data)
			if err != nil {
				return false, err
			}
			if checkGoal {
				if goal, ok := claudeGoalReply(f); ok {
					if err := sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Goal = goal }); err != nil {
						return false, err
					}
					checkGoal = false
				}
			}
			if waitGoalResult && str(f["type"]) == "result" && str(f["parent_tool_use_id"]) == "" {
				waitGoalResult = false
			}
			if r := obj(f["response"]); refreshContext && f["type"] == "control_response" && r["request_id"] == contextReqID {
				refreshContext = false
				usage := obj(r["response"])
				if err := setContextUsage(sink, usage["totalTokens"], usage["maxTokens"]); err != nil {
					return false, err
				}
			}
		}
	}
	return true, nil
}
