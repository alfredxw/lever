package provider

import (
	"fmt"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

type codexCall = func(string, object) (object, error)

func codexGoalsEnabled(call codexCall) bool {
	params := object{"limit": 200}
	for {
		page, err := call("experimentalFeature/list", params)
		if err != nil {
			return false
		}
		for _, value := range arr(page["data"]) {
			if feature := obj(value); feature["name"] == "goals" {
				return feature["enabled"] == true
			}
		}
		next := str(page["nextCursor"])
		if next == "" || next == params["cursor"] {
			return false
		}
		params["cursor"] = next
	}
}

type codexGoal struct {
	value *model.SessionGoal
	sink  Sink
}

func (g *codexGoal) observe(value any) error {
	var goal *model.SessionGoal
	if data := obj(value); data != nil {
		goal = &model.SessionGoal{Objective: str(data["objective"]), Status: str(data["status"])}
	}
	g.value = goal
	return g.sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Goal = goal })
}

func (g *codexGoal) active() bool { return g.value != nil && g.value.Status == "active" }

func (g *codexGoal) request(call codexCall, verb, thread string, fields object) error {
	if fields == nil {
		fields = object{}
	}
	fields["threadId"] = thread
	result, err := call("thread/goal/"+verb, fields)
	if err != nil {
		return err
	}
	return g.observe(result["goal"])
}

// Status and stop controls do not start a model turn.
func (g *codexGoal) report(call codexCall, thread, argument, messageID string) (bool, error) {
	switch strings.ToLower(argument) {
	case "", "show", "status", "edit":
		if err := g.request(call, "get", thread, nil); err != nil {
			return true, err
		}
	case "clear":
		if err := g.request(call, "clear", thread, nil); err != nil {
			return true, err
		}
		return true, commandResult(g.sink, messageID, "Goal cleared.")
	case "pause":
		if err := g.request(call, "get", thread, nil); err != nil {
			return true, err
		}
		if g.value != nil {
			if err := g.request(call, "set", thread, object{"status": "paused"}); err != nil {
				return true, err
			}
		}
	default:
		return false, nil
	}
	text := "No goal set."
	if g.value != nil {
		text = fmt.Sprintf("Goal (%s) · %s", g.value.Status, g.value.Objective)
	}
	return true, commandResult(g.sink, messageID, text)
}

// Stop interrupts the turn and pauses autonomous continuations. Only persist
// the pause once the still-owned app-server acknowledges it.
func (g *codexGoal) pauseOnStop(p *device.Process, thread string) {
	if err := p.Send(object{"id": "stop-goal", "method": "thread/goal/set", "params": object{"threadId": thread, "status": "paused"}}); err != nil {
		return
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case frame, ok := <-p.Frames:
			if !ok {
				return
			}
			f, _ := decode(frame)
			if f["id"] == "stop-goal" {
				if v := obj(f["result"])["goal"]; v != nil {
					_ = g.observe(v)
				}
				return
			}
		case <-timer.C:
			return
		}
	}
}
