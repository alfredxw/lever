package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/workspace"
)

type codexRequestError struct{ payload any }

func (e *codexRequestError) Error() string { return fail(e.payload).Error() }

func codexCommand(path string, config model.Provider) *exec.Cmd {
	cmd := device.Command(path, append([]string{"app-server"}, config.Args...)...)
	if os.Getenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE") == "" {
		cmd.Env = append(cmd.Env, "CODEX_INTERNAL_ORIGINATOR_OVERRIDE=lever")
	}
	return cmd
}

func codex(ctx context.Context, in Input, sink Sink) (err error) {
	checking := in.Recovery != nil
	defer func() {
		if checking && err != nil && !errors.Is(err, ErrUnconfirmed) {
			err = errors.Join(ErrUnconfirmed, err)
		}
	}()
	path, err := Executable(ctx, in.Provider)
	if err != nil {
		return err
	}
	cmd := codexCommand(path, in.Provider)
	cmd.Args = append(cmd.Args, codexSkillArguments(in.Skills)...)
	if err := applyProfile(cmd, in.Provider); err != nil {
		return err
	}
	cmd.Dir = workspace.CWD(in.Session.Scope)
	p, err := device.Start(cmd)
	if err != nil {
		return err
	}
	defer p.Close()
	var stateMu sync.Mutex
	threadID, turnID := in.Session.NativeID, ""
	goal := codexGoal{sink: sink}
	if in.Session.Runtime != nil {
		goal.value = in.Session.Runtime.Goal
	}
	name, argument := in.command()
	if in.Recovery != nil {
		name = ""
	}
	compacting := name == "compact"
	if name == "loop" {
		return errors.New("Codex does not provide /loop")
	}
	if compacting && argument != "" {
		return errors.New("Codex /compact takes no arguments")
	}
	if compacting && threadID == "" {
		return commandResult(sink, "compaction", "There is no conversation to compact yet.")
	}
	activating := false
	defer func() {
		if ctx.Err() != nil && threadID != "" && (activating || goal.active()) {
			goal.pauseOnStop(p, threadID)
		}
	}()
	p.Watch(ctx, func() {
		stateMu.Lock()
		defer stateMu.Unlock()
		if threadID != "" && turnID != "" {
			_ = p.Send(object{"id": "interrupt", "method": "turn/interrupt", "params": object{"threadId": threadID, "turnId": turnID}})
		}
	})
	items := map[string]model.Item{}
	rawText := map[string]string{}
	citations := codexCitationIndex{}
	reasoning := map[string]codexReasoning{}
	subagents := codexSubagents{}
	emit := func(item model.Item) error {
		items[item.ID] = item
		return sink.Item(item)
	}
	terminal := false
	var outcome error
	var initialTurnID string
	var lastUsage []model.UsageWindow
	// turn/start can deliver a patch or completion before it returns its turn
	// ID. Retain the latest of each until the response identifies our turn.
	var startingEvents map[[2]string]object
	var handle func(object) error
	handle = func(frame object) error {
		method := str(frame["method"])
		q := obj(frame["params"])
		stateMu.Lock()
		tid, turn := threadID, turnID
		stateMu.Unlock()
		owner := str(q["threadId"])
		if frame["id"] == nil && method == "account/rateLimits/updated" {
			if windows := codexUsage(q); len(windows) > 0 && !slices.Equal(windows, lastUsage) {
				lastUsage = windows
				return sink.Usage(windows)
			}
			return nil
		}
		if frame["id"] != nil && method != "" {
			if ctx.Err() != nil {
				return nil
			}
			request := model.Request{Kind: "approval", Title: method, Detail: pretty(q), Questions: []model.Question{}}
			switch method {
			case "item/commandExecution/requestApproval":
				request.Title = "Run command"
				request.Detail = str(q["command"])
				if q["availableDecisions"] == nil || slices.Contains(arr(q["availableDecisions"]), any("accept")) {
					request.AllowOnce = &model.Answer{Allow: true, Answers: map[string][]string{}}
				}
			case "item/fileChange/requestApproval":
				request.Title = "Apply file changes"
				request.AllowOnce = &model.Answer{Allow: true, Answers: map[string][]string{}}
			case "item/tool/requestUserInput":
				request.Kind = "question"
				request.Title = "Agent needs your input"
				for _, v := range arr(q["questions"]) {
					v := obj(v)
					question := model.Question{ID: str(v["id"]), Text: str(v["question"]), Options: []model.QuestionOption{}}
					for _, o := range arr(v["options"]) {
						o := obj(o)
						question.Options = append(question.Options, model.QuestionOption{ID: str(o["label"]), Label: str(o["label"]), Description: str(o["description"])})
					}
					request.Questions = append(request.Questions, question)
				}
			default:
				return p.Send(object{"id": frame["id"], "error": object{"code": -32601, "message": "Lever does not support this runtime request: " + method}})
			}
			if owner != "" && tid != "" && owner != tid {
				agent := subagents.add(owner)
				if err := agent.publish(sink); err != nil {
					return err
				}
				request.SubagentID = agent.item.ID
			}
			answer, err := sink.Ask(ctx, request)
			if err != nil {
				return err
			}
			result := object{"decision": "decline"}
			if answer.Allow {
				result["decision"] = "accept"
			}
			if request.Kind == "question" {
				answers := object{}
				for id, values := range answer.Answers {
					answers[id] = object{"answers": values}
				}
				result = object{"answers": answers}
			}
			return p.Send(object{"id": frame["id"], "result": result})
		}
		if owner != "" && owner != tid {
			if agent := subagents[owner]; agent != nil {
				return subagents.frame(agent, method, q, sink)
			}
			return nil
		}
		if owner != "" && owner == tid {
			switch method {
			case "thread/goal/updated":
				return goal.observe(q["goal"])
			case "thread/goal/cleared":
				return goal.observe(nil)
			case "turn/started":
				if (compacting && turn == "") || (terminal && (goal.active() || activating) && outcome == nil) {
					if next := str(obj(q["turn"])["id"]); next != "" && next != turn {
						stateMu.Lock()
						turnID = next
						stateMu.Unlock()
						terminal = false
						citations = codexCitationIndex{}
						return sink.BindTurn(next)
					}
				}
				return nil
			}
		}
		if id := str(q["turnId"]); id != "" && turn != "" && id != turn {
			return nil
		}
		if turn == "" && (method == "turn/diff/updated" || method == "turn/completed") {
			if startingEvents != nil && owner == tid {
				id := str(q["turnId"])
				if method == "turn/completed" {
					id = str(obj(q["turn"])["id"])
				}
				startingEvents[[2]string{id, method}] = frame
			}
			return nil
		}
		switch method {
		case "thread/tokenUsage/updated":
			usage := obj(q["tokenUsage"])
			return setContextUsage(sink, obj(usage["last"])["totalTokens"], usage["modelContextWindow"])
		case "thread/compacted":
			return sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = nil })
		case "turn/diff/updated":
			id := str(q["turnId"])
			patch, ok := q["diff"].(string)
			if !ok || owner == "" || owner != tid || id == "" {
				return nil
			}
			return sink.TurnDiff(patch)
		case "item/agentMessage/delta":
			id := str(q["itemId"])
			item := items[id]
			item.ID = id
			item.Kind = "text"
			item.Status = "running"
			rawText[id] += str(q["delta"])
			item.Text, item.Citations = resolveCodexCitations(rawText[id], citations, true)
			return emit(item)
		case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta":
			id, delta := str(q["itemId"]), str(q["delta"])
			if delta == "" {
				return nil
			}
			field, indexKey := "summary", "summaryIndex"
			if method == "item/reasoning/textDelta" {
				field, indexKey = "content", "contentIndex"
			}
			if reasoning[id] == nil {
				reasoning[id] = codexReasoning{}
			}
			parts := reasoning[id]
			if parts[field] == nil {
				parts[field] = map[int]string{}
			}
			index, _ := q[indexKey].(float64)
			parts[field][int(index)] += delta
			text := parts.text(nil)
			if text == "" {
				return nil
			}
			return emit(model.Item{ID: id, Kind: "reasoning", Text: text, Status: "running"})
		case "item/started", "item/completed":
			v := obj(q["item"])
			id := str(v["id"])
			kind := str(v["type"])
			item := items[id]
			item.ID = id
			item.Status = "running"
			if method == "item/completed" {
				item.Status = "completed"
			}
			switch kind {
			case "contextCompaction":
				item.Kind, item.Title = "tool", "Compact context"
				if method == "item/completed" {
					if err := sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = nil }); err != nil {
						return err
					}
				}
			case "subAgentActivity", "collabAgentToolCall":
				return subagents.lifecycle(v, tid, sink)
			case "agentMessage":
				item.Kind = "text"
				if text, ok := v["text"].(string); ok {
					rawText[id] = text
				}
				if raw, ok := rawText[id]; ok {
					item.Text, item.Citations = resolveCodexCitations(raw, citations, method != "item/completed")
				}
				if method == "item/completed" {
					delete(rawText, id)
				}
			case "commandExecution":
				item.Kind = "tool"
				if actions := arr(v["commandActions"]); len(actions) > 0 || item.ToolAction == "" {
					item.ToolAction = codexCommandAction(actions)
				}
				item.Title = str(v["command"])
				item.Text = clip(str(v["aggregatedOutput"]))
				applyCodexCommandOutcome(&item, v)
			case "fileChange":
				item.Kind = "tool"
				item.ToolAction = model.ToolActionEdit
				item.Title = "File changes"
				item.Text = clip(pretty(v["changes"]))
			case "mcpToolCall":
				item.Kind = "tool"
				item.Title = str(v["server"]) + " / " + str(v["tool"])
				item.Text = clip(pretty(v["arguments"]))
				if v["result"] != nil {
					citations.addMCPResult(v["result"])
					item.Text += "\n" + clip(pretty(v["result"]))
				}
				if v["error"] != nil {
					item.Status = "failed"
					item.Text += "\n" + pretty(v["error"])
				}
			case "webSearch":
				item.Kind = "tool"
				item.ToolAction = model.ToolActionSearch
				item.Title = "Web search"
				item.Text = pretty(v["action"])
			case "reasoning":
				item.Kind = "reasoning"
				if text := reasoning[id].text(v); text != "" {
					item.Text = text
				}
				if method == "item/completed" {
					delete(reasoning, id)
				}
				if item.Text == "" {
					return nil
				}
			default:
				return nil
			}
			if item.Kind == "tool" && (v["status"] == "failed" || v["status"] == "declined") {
				item.Status = "failed"
			}
			return emit(item)
		case "turn/completed":
			v := obj(q["turn"])
			if owner != tid || (turn != "" && str(v["id"]) != turn) {
				return nil
			}
			terminal = true
			switch str(v["status"]) {
			case "completed":
			case "interrupted":
				outcome = context.Canceled
			default:
				outcome = fail(v["error"])
			}
		}
		return nil
	}
	rpcCtx := ctx
	if in.Recovery != nil {
		var cancel context.CancelFunc
		rpcCtx, cancel = context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
	}
	next := 0
	call := func(method string, params object) (object, error) {
		if err := rpcCtx.Err(); err != nil {
			return nil, err
		}
		next++
		id := fmt.Sprintf("lever-%d", next)
		if err := p.Send(object{"id": id, "method": method, "params": params}); err != nil {
			return nil, err
		}
		for {
			select {
			case <-rpcCtx.Done():
				return nil, rpcCtx.Err()
			case b, ok := <-p.Frames:
				if !ok {
					return nil, errors.Join(ErrUnconfirmed, p.Error())
				}
				f, err := decode(b)
				if err != nil {
					return nil, err
				}
				if str(f["id"]) == id && f["method"] == nil {
					if payload := f["error"]; payload != nil {
						err := &codexRequestError{payload: payload}
						if method == "turn/steer" {
							return nil, errors.Join(ErrSteerRejected, err)
						}
						return nil, err
					}
					return obj(f["result"]), nil
				}
				if err := handle(f); err != nil {
					return nil, err
				}
			}
		}
	}
	defer func() {
		if !errors.Is(context.Cause(ctx), ErrPauseRequested) {
			return
		}
		// Read the remaining events before closing the native process. A pause
		// can lose a race to completion or arrive before the input was saved.
		pauseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Second)
		defer cancel()
		rpcCtx = pauseCtx
		for !terminal {
			select {
			case b, ok := <-p.Frames:
				if !ok {
					err = errors.Join(ErrUnconfirmed, p.Error())
					return
				}
				frame, readErr := decode(b)
				if readErr == nil {
					readErr = handle(frame)
				}
				if readErr != nil {
					err = errors.Join(ErrUnconfirmed, readErr)
					return
				}
			case <-pauseCtx.Done():
				err = errors.Join(ErrUnconfirmed, errors.New("Codex did not confirm the pause"))
				return
			}
		}
		err = outcome
		if !errors.Is(outcome, context.Canceled) {
			return
		}
		previous, readErr := latestCodexTurn(call, threadID, "full")
		if readErr != nil || !confirmedCodexInterruption(previous, turnID) {
			return
		}
		if turnID == initialTurnID && in.Recovery == nil && !hasCodexUserMessage(previous, in.RunID) {
			return
		}
		err = ErrPaused
	}()
	if _, err = call("initialize", object{"clientInfo": object{"name": "lever", "version": "0.1.0"}, "capabilities": object{"experimentalApi": true}}); err != nil {
		return err
	}
	if err = p.Send(object{"method": "initialized"}); err != nil {
		return err
	}
	var interruptedTurnID string
	if in.Recovery != nil {
		previous, err := codexRecoveryTurn(rpcCtx, call, in)
		if err != nil {
			return err
		}
		checking = false
		stateMu.Lock()
		threadID = in.Session.NativeID
		stateMu.Unlock()
		if !in.Recovery.SkipOutputReplay {
			for _, value := range arr(previous["items"]) {
				item := obj(value)
				if item["type"] == "mcpToolCall" && item["result"] != nil {
					citations.addMCPResult(item["result"])
				}
			}
			for _, value := range arr(previous["items"]) {
				item := obj(value)
				if item["type"] == "agentMessage" {
					if err := handle(object{"method": "item/completed", "params": object{"threadId": threadID, "item": item}}); err != nil {
						return err
					}
				}
			}
		}
		switch previous["status"] {
		case "completed":
			return nil
		case "failed":
			return fail(previous["error"])
		case "interrupted":
			if !in.Recovery.Continue {
				return context.Canceled
			}
			interruptedTurnID = str(previous["id"])
		}
		rpcCtx = ctx
	}
	if err = codexSkillRoots(call, in.Skills); err != nil {
		return err
	}
	if len(in.Skills.Disabled) > 0 {
		skills, err := codexSkillReferences(call, cmd.Dir, in.Provider.ID)
		if err != nil {
			return err
		}
		if err := verifySkillPolicy(in.Skills, skills); err != nil {
			return err
		}
	}
	profile := in.Profile
	approval, sandbox, reviewer := "on-request", "workspace-write", "user"
	switch in.Selection.Permission {
	case "auto_review":
		reviewer = "auto_review"
	case "read_only":
		approval = "never"
		sandbox = "read-only"
	case "full_access":
		approval = "never"
		sandbox = "danger-full-access"
	}
	config := object{"features.default_mode_request_user_input": true}
	roots := []string{}
	for _, r := range profile.Roots {
		roots = append(roots, r.Path)
	}
	config["sandbox_workspace_write.writable_roots"] = roots
	if in.MCPURL != "" {
		config["mcp_servers.lever"] = object{"url": in.MCPURL, "http_headers": object{"Authorization": "Bearer " + in.MCPToken}}
	}
	params := object{"cwd": cmd.Dir, "approvalPolicy": approval, "approvalsReviewer": reviewer, "sandbox": sandbox, "config": config}
	if in.Selection.Model != "" {
		params["model"] = in.Selection.Model
	}
	var result object
	if interruptedTurnID != "" {
		var cancel context.CancelFunc
		rpcCtx, cancel = context.WithTimeout(ctx, 90*time.Second)
		result, err = resumeInterruptedCodexThread(rpcCtx, call, params, in.Session.NativeID, interruptedTurnID)
		cancel()
		rpcCtx = ctx
	} else {
		result, err = openCodexThread(call, params, in.Session.NativeID)
	}
	if err != nil {
		return err
	}
	if reviewer == "auto_review" && str(result["approvalsReviewer"]) != reviewer {
		return errors.New("Codex did not enable Approve for me. Update Codex or choose another permission mode.")
	}
	id := str(obj(result["thread"])["id"])
	if id == "" {
		return errors.New("Codex did not return a thread id")
	}
	if in.Session.NativeID != "" && id != in.Session.NativeID {
		return errors.New("Codex resumed a different thread")
	}
	stateMu.Lock()
	threadID = id
	stateMu.Unlock()
	if name != "goal" && goal.active() {
		if err := goal.request(call, "get", id, nil); err != nil {
			return err
		}
	}
	if name == "goal" {
		if handled, err := goal.report(call, id, argument, "goal-"+in.RunID); handled {
			return err
		}
		if strings.EqualFold(argument, "resume") {
			if err := goal.request(call, "get", id, nil); err != nil {
				return err
			}
			if goal.value == nil {
				return commandResult(sink, "goal-"+in.RunID, "No goal set.")
			}
		} else if err := goal.request(call, "set", id, object{"objective": argument, "status": "paused"}); err != nil {
			return err
		}
		if goal.value == nil {
			return errors.New("Codex returned no thread goal")
		}
		in.Text = "Work toward the existing thread goal: " + goal.value.Objective
	}
	// A new thread with only a /goal status or clear has no resumable rollout.
	// Bind it when we are going to deliver actual work.
	if err = sink.Bind(id); err != nil {
		return err
	}
	turnParams := object{"threadId": id, "summary": "auto", "serviceTier": "default", "additionalContext": codexInstructions(profile.Instructions)}
	if in.Recovery == nil {
		turnParams["clientUserMessageId"] = in.RunID
		turnParams["input"] = codexContent(in)
	} else {
		// The original prompt is already in the thread. Record the delivery
		// boundary before sending a new turn with no user input.
		if err := sink.BindTurn(""); err != nil {
			return err
		}
		turnParams["input"] = []object{}
	}
	if in.Selection.Model != "" {
		turnParams["model"] = in.Selection.Model
	}
	if in.Selection.Effort != "" {
		turnParams["effort"] = in.Selection.Effort
	}
	if in.Selection.Fast {
		turnParams["serviceTier"] = "priority"
	}
	startingEvents = make(map[[2]string]object)
	if compacting {
		_, err = call("thread/compact/start", object{"threadId": id})
	} else {
		result, err = call("turn/start", turnParams)
	}
	if err != nil {
		return err
	}
	if !compacting {
		stateMu.Lock()
		turnID = str(obj(result["turn"])["id"])
		stateMu.Unlock()
		if turnID == "" {
			return errors.Join(ErrUnconfirmed, errors.New("Codex did not return a turn id"))
		}
		initialTurnID = turnID
		if err := sink.BindTurn(turnID); err != nil {
			return errors.Join(ErrUnconfirmed, err)
		}
	}
	for _, method := range []string{"turn/diff/updated", "turn/completed"} {
		if frame := startingEvents[[2]string{turnID, method}]; frame != nil {
			if err := handle(frame); err != nil {
				return err
			}
		}
	}
	startingEvents = nil
	if name == "goal" && outcome == nil && (goal.value == nil || goal.value.Status != "complete") {
		activating = true
		if err := goal.request(call, "set", id, object{"status": "active"}); err != nil {
			return err
		}
		activating = false
	}
	for !terminal || (goal.active() && outcome == nil && !compacting) {
		select {
		case <-in.Steers:
			for {
				message, err := sink.NextSteer()
				if err != nil {
					return err
				}
				if message == nil {
					break
				}
				var deliveryErr error
				command, arg := message.command()
				switch {
				case command == "goal":
					handled, err := goal.report(call, id, arg, "goal-"+message.RunID)
					deliveryErr = err
					if !handled {
						params := object{"status": "active"}
						if !strings.EqualFold(arg, "resume") {
							params["objective"] = arg
						}
						deliveryErr = goal.request(call, "set", id, params)
					}
				case command == "compact" || terminal || turnID == "":
					deliveryErr = ErrSteerRejected
				default:
					_, deliveryErr = call("turn/steer", object{"threadId": threadID, "expectedTurnId": turnID, "input": codexContent(*message)})
				}
				if err := sink.Steered(message.RunID, deliveryErr); err != nil {
					return err
				}
				var responseErr *codexRequestError
				if deliveryErr != nil && !errors.Is(deliveryErr, ErrSteerRejected) && !errors.As(deliveryErr, &responseErr) {
					return errors.Join(ErrUnconfirmed, deliveryErr)
				}
			}
		case <-ctx.Done():
			return ctx.Err()
		case b, ok := <-p.Frames:
			if !ok {
				return errors.Join(ErrUnconfirmed, p.Error())
			}
			var f object
			if err := json.Unmarshal(b, &f); err != nil {
				return err
			}
			if err := handle(f); err != nil {
				return err
			}
		}
	}
	if compacting && outcome == nil {
		return commandResult(sink, "compaction", "Context compacted.")
	}
	return outcome
}

func openCodexThread(call func(string, object) (object, error), params object, threadID string) (object, error) {
	if threadID == "" {
		return call("thread/start", params)
	}
	params["threadId"] = threadID
	archived := "session " + threadID + " is archived"
	restored := false
	for {
		result, err := call("thread/resume", params)
		var requestErr *codexRequestError
		if !errors.As(err, &requestErr) {
			return result, err
		}
		payload := obj(requestErr.payload)
		message := str(payload["message"])
		if payload["code"] == float64(-32600) && message == "thread "+threadID+" already has an active writer" {
			return nil, errCodexThreadBusy
		}
		if restored || (message != archived && !strings.HasPrefix(message, archived+".")) {
			return result, err
		}
		if _, err := call("thread/unarchive", object{"threadId": threadID}); err != nil {
			return nil, err
		}
		restored = true
	}
}

func applyCodexCommandOutcome(item *model.Item, command object) {
	item.ExitCode = nil
	exit, ok := command["exitCode"].(float64)
	code := int(exit)
	if !ok || float64(code) != exit {
		return
	}
	if code != 0 {
		item.Status = "failed"
	}
	// Codex uses -1 for tool errors that did not produce a process exit code.
	if code >= 0 && !strings.EqualFold(str(command["status"]), "declined") {
		item.ExitCode = &code
	}
}

func codexCommandAction(actions []any) model.ToolAction {
	if len(actions) == 0 {
		return model.ToolActionCommand
	}
	kind := str(obj(actions[0])["type"])
	for _, action := range actions[1:] {
		if str(obj(action)["type"]) != kind {
			return model.ToolActionCommand
		}
	}
	switch kind {
	case "read":
		return model.ToolActionRead
	case "listFiles":
		return model.ToolActionList
	case "search":
		return model.ToolActionSearch
	default:
		return model.ToolActionCommand
	}
}

// Codex identifies each paragraph by index. Prefer the summary and reconcile
// streamed paragraphs with the completed item when it carries a snapshot.
type codexReasoning map[string]map[int]string

func (r codexReasoning) text(snapshot object) string {
	for _, field := range []string{"summary", "content"} {
		var paragraphs []string
		for _, paragraph := range arr(snapshot[field]) {
			paragraphs = append(paragraphs, str(paragraph))
		}
		if text := strings.Join(paragraphs, "\n\n"); strings.TrimSpace(text) != "" {
			return text
		}
		paragraphs = paragraphs[:0]
		for _, index := range slices.Sorted(maps.Keys(r[field])) {
			paragraphs = append(paragraphs, r[field][index])
		}
		if text := strings.Join(paragraphs, "\n\n"); strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

// Resume preserves instructions already in native history. Send the current
// definition as developer-level application context on every turn, including
// an empty definition to withdraw earlier Agent instructions. Codex caps each
// context value at 4,000 UTF-8 bytes, so keep ordered fragments below that cap.
func codexInstructions(instructions string) object {
	text := "Current Lever Agent instructions replace all previous Lever Agent instructions. An empty section means no Agent-specific instructions apply:\n\n" + instructions
	context := object{}
	for part := 0; text != ""; part++ {
		end := min(len(text), 4000)
		for end < len(text) && !utf8.RuneStart(text[end]) {
			end--
		}
		context[fmt.Sprintf("lever_agent_%08d", part)] = object{"kind": "application", "value": text[:end]}
		text = text[end:]
	}
	return context
}

func codexContent(in Input) []object {
	content := []object{{"type": "text", "text": in.Message(), "text_elements": []any{}}}
	for _, ref := range in.References {
		if ref.Kind == "skill" && ref.Provider == in.Provider.ID {
			content = append(content, object{"type": "skill", "name": ref.Name, "path": in.skillPath(ref)})
		}
	}
	for _, file := range in.Attachments {
		if file.Image() {
			content = append(content, object{"type": "localImage", "path": file.Path})
		}
	}
	return content
}
