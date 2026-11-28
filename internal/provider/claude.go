package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/workspace"
)

func claudePermission(permission string) string {
	switch permission {
	case "accept_edits":
		return "acceptEdits"
	case "auto", "plan":
		return permission
	case "dont_ask":
		return "dontAsk"
	case "full_access":
		return "bypassPermissions"
	default:
		return "default"
	}
}

type claudePermissionChange struct {
	reqID string
	mode  string
	done  chan error
}

func validateClaudeCommandAndSkills(command string, plan SkillPlan, commands []model.Reference) error {
	if (command == "goal" || command == "loop" || command == "compact") && !slices.ContainsFunc(commands, func(c model.Reference) bool { return c.Name == command }) {
		return fmt.Errorf("This Claude runtime does not provide /%s", command)
	}
	return verifySkillPolicy(plan, commands)
}

func claude(ctx context.Context, in Input, sink Sink) (outcome error) {
	stateDir, _ := ctx.Value(stateDirKey{}).(string)
	prev := defaultClaudePool.take(stateDir, in.Session.ID)

	messageID := in.RunID
	if in.Recovery != nil {
		if prev != nil {
			prev.close()
			prev = nil
		}
		if err := checkClaudeContinuation(ctx, in); err != nil {
			return err
		}
		// An empty stream-json input starts generation from the saved conversation.
		// The receipt UUID identifies this request without resending any user data.
		messageID = uuid.NewString()
	}
	path, err := Executable(ctx, in.Provider)
	if err != nil {
		if prev != nil {
			prev.close()
		}
		return err
	}
	in.prepareSlashPrompt()
	command, _ := in.command()
	profile := in.Profile
	nativePermission := claudePermission(in.Selection.Permission)
	cwd := workspace.CWD(in.Session.Scope)
	entrypoint := claudeProcessEntrypoint(in.Provider)
	supportsResumeDialog := in.Recovery == nil && command != "compact" && (in.Provider.IdleCompaction == "onReturn" || in.Provider.IdleCompaction == "beforeCacheExpires")
	addDirs := []string{in.Assets}
	for _, root := range in.Session.Scope.Roots {
		if root.ID != in.Session.Scope.PrimaryRootID {
			addDirs = append(addDirs, root.Path)
		}
	}
	addDirs = append(addDirs, in.Skills.ClaudeDirectories...)
	for _, file := range in.Attachments {
		addDirs = append(addDirs, filepath.Dir(file.Path))
	}
	fingerprint := claudeLaunchFingerprint(in, path, cwd, entrypoint, addDirs, supportsResumeDialog)

	content := []object{}
	if in.Recovery == nil {
		content, err = claudeContent(in)
		if err != nil {
			if prev != nil {
				if prev.stopIdle() {
					defaultClaudePool.park(stateDir, in.Session.ID, prev)
				} else {
					prev.close()
				}
			}
			return err
		}
	}

	var r *claudeResident
	var reused bool
	if prev != nil {
		if in.Recovery == nil && in.Session.ID != "" && in.Session.NativeID != "" &&
			prev.nativeID == in.Session.NativeID && prev.fingerprint == fingerprint &&
			prev.stopIdle() {
			if err := validateClaudeCommandAndSkills(command, in.Skills, prev.commands); err != nil {
				defaultClaudePool.park(stateDir, in.Session.ID, prev)
				return err
			}
			if prev.permission != nativePermission {
				if err := setClaudePermissionMode(ctx, prev, nativePermission); err != nil {
					prev.close()
					if ctx.Err() != nil {
						return ctx.Err()
					}
					prev = nil
				}
			}
			if prev != nil {
				if prev.mcpRelay != nil {
					if err := prev.mcpRelay.set(in.MCPURL, in.MCPToken); err != nil {
						prev.close()
						return err
					}
				}
				r, reused = prev, true
			}
		} else {
			prev.close()
		}
	}

	if r == nil {
		args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-mode", nativePermission, "--allow-dangerously-skip-permissions", "--permission-prompt-tool", "stdio"}
		if in.Selection.Model != "" {
			args = append(args, "--model", in.Selection.Model)
		}
		if in.Selection.Effort != "" {
			args = append(args, "--effort", in.Selection.Effort)
		}
		settings := object{"fastMode": in.Selection.Fast}
		if in.Provider.IdleCompaction == "off" {
			settings["idleCompaction"] = false
		}
		args = append(args, claudeSkillArguments(in.Session.Scope, in.Skills, settings)...)
		if in.Session.NativeID != "" {
			args = append(args, "--resume", in.Session.NativeID)
		}
		args = append(args, "--add-dir", in.Assets)
		for _, file := range in.Attachments {
			args = append(args, "--add-dir", filepath.Dir(file.Path))
		}
		var relay *claudeMCPRelay
		if in.MCPURL != "" {
			relay, err = newClaudeMCPRelay(in.Assets, in.MCPURL, in.MCPToken)
			if err != nil {
				return err
			}
			args = append(args, "--mcp-config", relay.configPath)
		}
		cmd := device.Command(path, in.Provider.Args...)
		cmd.Args = append(cmd.Args, args...)
		if err := applyProfile(cmd, in.Provider); err != nil {
			if relay != nil {
				relay.close()
			}
			return err
		}
		cmd.Dir = cwd
		p, err := device.Start(cmd)
		if err != nil {
			if relay != nil {
				relay.close()
			}
			return err
		}
		r = &claudeResident{
			p:           p,
			fingerprint: fingerprint,
			permission:  nativePermission,
			mcpRelay:    relay,
		}
	}

	p := r.p
	interruptReqID := r.nextRequestID("interrupt")
	stopWatch, watchTriggered := watchClaudeTurn(ctx, p, interruptReqID)
	approvalCtx, stopApprovals := context.WithCancel(ctx)
	var approvals sync.WaitGroup
	var nativeID string
	var canPark bool
	defer func() {
		stopApprovals()
		stopWatch()
		if r.mcpRelay != nil {
			r.mcpRelay.clear()
		}
		if canPark && outcome == nil && ctx.Err() == nil && !watchTriggered.Load() &&
			in.Session.ID != "" && nativeID != "" && r.alive() {
			approvals.Wait()
			r.nativeID = nativeID
			defaultClaudePool.park(stateDir, in.Session.ID, r)
			return
		}
		r.close()
		approvals.Wait()
		if !errors.Is(outcome, ErrPaused) {
			return
		}
		proofCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		tip, err := claudeCheckpoint(proofCtx, in.Provider, nativeID, in.RunID)
		if err != nil || (in.Recovery != nil && tip == *in.Recovery.NativeTurnID) {
			outcome = context.Canceled
			return
		}
		if err := sink.BindTurn(tip); err != nil {
			outcome = errors.Join(ErrUnconfirmed, err)
		}
	}()

	var initReqID string
	if !reused {
		init := object{"subtype": "initialize", "hooks": object{}, "appendSystemPrompt": profile.Instructions}
		if supportsResumeDialog {
			init["supportedDialogKinds"] = []string{"resume_return"}
		}
		initReqID = r.nextRequestID("init")
		if err = p.Send(object{"type": "control_request", "request_id": initReqID, "request": init}); err != nil {
			return err
		}
	}
	items := map[string]model.Item{}
	toolItems := map[string]string{}
	subagents := claudeSubagents{calls: map[string]*subagent{}, tasks: map[string]*subagent{}, tools: map[string]*subagent{}}
	nextAssistantBlock := map[string]int{}
	currentMessage := ""
	sent := false
	accepted, pausable, turnBound := false, in.CanPauseTurn(), false
	bindTurn := func() error {
		if !turnBound && pausable && accepted && sharedUUID.MatchString(nativeID) {
			if err := sink.BindTurn(messageID); err != nil {
				return err
			}
			turnBound = true
		}
		return nil
	}
	loopEnabled := command == "loop"
	var loop claudeLoop
	goalActive := in.Session.Runtime != nil && in.Session.Runtime.Goal != nil && in.Session.Runtime.Goal.Status == "active"
	goalSawModel := false
	var lastModelMessage object
	var lastModelRequestedAt time.Time
	var streamModel, streamMessageID string
	var streamUsage object
	var streamRequestedAt time.Time
	var lastContextWindow int64
	if in.Session.Runtime != nil && in.Session.Runtime.Context != nil && in.Session.Runtime.Context.Window > 0 && in.Session.Selection.Model == in.Selection.Model {
		lastContextWindow = in.Session.Runtime.Context.Window
	}
	var lastUsage []model.UsageWindow
	var requestedAt time.Time
	refreshContext := command == "context" || command == "compact"
	pendingSteers := map[string]bool{}
	var receiptDeadline <-chan time.Time
	var receiptTimer *time.Timer
	defer func() {
		if receiptTimer != nil {
			receiptTimer.Stop()
		}
	}()
	var steering <-chan struct{}
	changes := make(chan claudePermissionChange)
	permissionChanges := (<-chan claudePermissionChange)(changes)
	var changing *claudePermissionChange
	approvalErr := make(chan error, 1)
	done := ctx.Done()
	var pauseDeadline context.Context
	interruptAcknowledged, interrupted := false, false
	emit := func(item model.Item) error {
		items[item.ID] = item
		if item.Kind == "reasoning" && strings.TrimSpace(item.Text) == "" {
			return nil
		}
		return sink.Item(item)
	}
	sendInitialPrompt := func() error {
		requestedAt = time.Now()
		if err = p.Send(object{"type": "user", "uuid": messageID, "message": object{"role": "user", "content": content}}); err != nil {
			return err
		}
		sent = true
		sink.EnablePermissionChanges(func(ctx context.Context, permission string) error {
			change := claudePermissionChange{mode: claudePermission(permission), done: make(chan error, 1)}
			select {
			case changes <- change:
			case <-approvalCtx.Done():
				return approvalCtx.Err()
			case <-ctx.Done():
				return ctx.Err()
			}
			select {
			case err := <-change.done:
				return err
			case <-approvalCtx.Done():
				select {
				case err := <-change.done:
					return err
				default:
					return approvalCtx.Err()
				}
			case <-ctx.Done():
				return errors.Join(ErrUnconfirmed, ctx.Err())
			}
		})
		return nil
	}
	if reused {
		nativeID = r.nativeID
		steering = in.Steers
		if err = sendInitialPrompt(); err != nil {
			return err
		}
	}
	for {
		select {
		case <-receiptDeadline:
			return errors.Join(ErrUnconfirmed, errors.New("Claude completed without acknowledging the follow-up input"))
		case change := <-permissionChanges:
			change.reqID = r.nextRequestID("permission")
			changing, permissionChanges = &change, nil
			if err := p.Send(object{"type": "control_request", "request_id": change.reqID, "request": object{"subtype": "set_permission_mode", "mode": change.mode}}); err != nil {
				change.done <- errors.Join(ErrUnconfirmed, err)
				return errors.Join(ErrUnconfirmed, err)
			}
		case err := <-approvalErr:
			if errors.Is(context.Cause(ctx), ErrPauseRequested) && errors.Is(err, context.Canceled) {
				continue
			}
			return err
		case <-steering:
			for {
				message, err := sink.NextSteer()
				if err != nil {
					return err
				}
				if message == nil {
					break
				}
				content, err := claudeContent(*message)
				if err != nil {
					if saveErr := sink.Steered(message.RunID, errors.Join(ErrSteerRejected, err)); saveErr != nil {
						return saveErr
					}
					continue
				}
				pendingSteers[message.RunID] = true
				loop.idle, loop.possibleWake = false, false
				if name, _ := message.command(); name == "loop" {
					loopEnabled = true
				}
				err = p.Send(object{"type": "user", "uuid": message.RunID, "priority": "next", "message": object{"role": "user", "content": content}})
				if err != nil {
					if saveErr := sink.Steered(message.RunID, err); saveErr != nil {
						return saveErr
					}
					return errors.Join(ErrUnconfirmed, err)
				}
			}
		case <-done:
			if !errors.Is(context.Cause(ctx), ErrPauseRequested) {
				return ctx.Err()
			}
			if pauseDeadline != nil {
				return errors.Join(ErrUnconfirmed, errors.New("Claude Code did not confirm the pause"))
			}
			var cancel context.CancelFunc
			pauseDeadline, cancel = context.WithTimeout(context.WithoutCancel(ctx), 4*time.Second)
			defer cancel()
			done, steering, permissionChanges = pauseDeadline.Done(), nil, nil
		case b, ok := <-p.Frames:
			if !ok {
				if sent {
					return errors.Join(ErrUnconfirmed, p.Error())
				}
				return errors.Join(errors.New("Claude exited during initialization"), p.Error())
			}
			f, err := decode(b)
			if err != nil {
				return err
			}
			if windows := claudeRateLimitEvent(f); len(windows) > 0 && !slices.Equal(windows, lastUsage) {
				lastUsage = windows
				if err := sink.Usage(windows); err != nil {
					return err
				}
			}
			if err := subagents.frame(f, sink); err != nil {
				return err
			}
			// Child-agent frames are activity, never the terminal event of the parent.
			if str(f["parent_tool_use_id"]) != "" && str(f["type"]) != "control_request" {
				continue
			}
			if loopEnabled {
				loop.observe(f)
			}
			if goal, ok := claudeGoalReply(f); ok {
				goalActive, goalSawModel = goal != nil, false
				if err := sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Goal = goal }); err != nil {
					return err
				}
			}
			switch str(f["type"]) {
			case "control_response":
				resp := obj(f["response"])
				if resp["request_id"] == interruptReqID && errors.Is(context.Cause(ctx), ErrPauseRequested) {
					if resp["subtype"] != "success" {
						return errors.Join(ErrUnconfirmed, fail(resp))
					}
					interruptAcknowledged = true
					if interrupted {
						return ErrPaused
					}
					continue
				}
				if changing != nil && str(resp["request_id"]) == changing.reqID {
					var changeErr error
					if str(resp["subtype"]) != "success" {
						changeErr = fail(resp)
					} else {
						r.permission = changing.mode
					}
					changing.done <- changeErr
					changing, permissionChanges = nil, changes
					continue
				}
				if initReqID == "" || str(resp["request_id"]) != initReqID {
					continue
				}
				if str(resp["subtype"]) != "success" {
					return fail(resp)
				}
				state := obj(resp["response"])
				if mode := str(state["current_permission_mode"]); mode != "" && mode != nativePermission {
					return fmt.Errorf("Claude Code could not enable permission mode %s (reported %s)", nativePermission, mode)
				}
				commands := claudeSkillReferences(state, in.Provider.ID)
				if err := validateClaudeCommandAndSkills(command, in.Skills, commands); err != nil {
					return err
				}
				if in.Selection.Fast {
					if reason := str(state["fast_mode_disabled_reason"]); reason != "" {
						return fmt.Errorf("Claude Fast is unavailable: %s", reason)
					}
					if str(state["fast_mode_state"]) != "on" {
						return errors.New("Claude did not enable Fast mode")
					}
				}
				r.commands = commands
				if !sent {
					if err = sendInitialPrompt(); err != nil {
						return err
					}
				}
			case "conversation_reset":
				lastModelMessage, streamUsage = nil, nil
				if err := sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = nil }); err != nil {
					return err
				}
			case "system":
				if f["subtype"] == "compact_boundary" {
					lastModelMessage, streamUsage = nil, nil
					if post, ok := nonNegativeInt(obj(f["compact_metadata"])["post_tokens"]); ok && post > 0 {
						if err := setClaudeContext(sink, in, time.Time{}, post, lastContextWindow, nil); err != nil {
							return err
						}
					} else if err := sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = nil }); err != nil {
						return err
					}
				}
				if str(f["subtype"]) == "init" {
					id := str(f["session_id"])
					if id == "" {
						return errors.New("Claude did not return a session id")
					}
					if in.Session.NativeID != "" && id != in.Session.NativeID {
						return errors.New("Claude resumed a different session")
					}
					if !reused || id != in.Session.NativeID {
						if err = sink.Bind(id); err != nil {
							return err
						}
					}
					nativeID = id
					if err := bindTurn(); err != nil {
						return errors.Join(ErrUnconfirmed, err)
					}
					steering = in.Steers
				}
			case "control_request":
				if ctx.Err() != nil {
					continue
				}
				// Keep reading control responses while a tool waits for the user.
				subagentID := subagents.approvalSource(f)
				approvals.Go(func() {
					if err := claudeApproval(approvalCtx, p, sink, f, subagentID); err != nil {
						select {
						case approvalErr <- err:
						case <-approvalCtx.Done():
						}
					}
				})
			case "stream_event":
				e := obj(f["event"])
				index := fmt.Sprint(e["index"])
				switch str(e["type"]) {
				case "message_start":
					msg := obj(e["message"])
					currentMessage = str(msg["id"])
					delete(nextAssistantBlock, currentMessage)
					streamModel, streamMessageID = str(msg["model"]), currentMessage
					streamRequestedAt = time.Now()
					streamUsage = maps.Clone(obj(msg["usage"]))
					if streamModel != "<synthetic>" {
						if input, used := claudeUsageCounts(streamUsage); input > 0 {
							window := claudeResolveContextWindow(nil, streamModel, r.contextWindows)
							if window == 0 {
								window = lastContextWindow
							}
							if err := setClaudeContext(sink, in, streamRequestedAt, used, window, streamUsage); err != nil {
								return err
							}
						}
					}
				case "message_delta":
					if streamModel != "<synthetic>" && e["usage"] != nil {
						streamUsage = mergeClaudeStreamUsage(streamUsage, obj(e["usage"]))
						if input, used := claudeUsageCounts(streamUsage); input > 0 {
							window := claudeResolveContextWindow(nil, streamModel, r.contextWindows)
							if window == 0 {
								window = lastContextWindow
							}
							if err := setClaudeContext(sink, in, streamRequestedAt, used, window, streamUsage); err != nil {
								return err
							}
						}
					}
				case "content_block_start":
					v := obj(e["content_block"])
					if isClaudeAgentTool(v) {
						continue
					}
					id := currentMessage + ":" + index
					item := model.Item{ID: id, Status: "running"}
					switch str(v["type"]) {
					case "text":
						item.Kind = "text"
						item.Text = str(v["text"])
						if sources := claudeCitations(v["citations"]); len(sources) > 0 {
							item.Citations = appendCitation(nil, utf16StringLen(item.Text), sources)
						}
					case "thinking":
						item.Kind = "reasoning"
						item.Text = str(v["thinking"])
					case "tool_use":
						item.Kind = "tool"
						item.Title = str(v["name"])
						toolItems[str(v["id"])] = id
					default:
						continue
					}
					if err = emit(item); err != nil {
						return err
					}
				case "content_block_delta":
					id := currentMessage + ":" + index
					item, exists := items[id]
					if !exists || item.Status == "completed" {
						continue
					}
					delta := obj(e["delta"])
					switch str(delta["type"]) {
					case "text_delta":
						item.Text += str(delta["text"])
					case "citations_delta":
						if sources := claudeCitations([]any{delta["citation"]}); len(sources) > 0 {
							item.Citations = appendCitation(item.Citations, utf16StringLen(item.Text), sources)
						}
					case "thinking_delta":
						item.Text += str(delta["thinking"])
					case "input_json_delta":
						item.Text += str(delta["partial_json"])
					default:
						continue
					}
					if err = emit(item); err != nil {
						return err
					}
				case "content_block_stop":
					id := currentMessage + ":" + index
					if item, exists := items[id]; exists {
						if item.Kind == "text" || item.Kind == "reasoning" {
							item.Status = "completed"
						}
						if err = emit(item); err != nil {
							return err
						}
					}
				}
			case "assistant":
				m := obj(f["message"])
				messageID := str(m["id"])
				if m["model"] != "<synthetic>" {
					if input, used := claudeUsageCounts(obj(m["usage"])); input > 0 {
						lastModelMessage = m
						lastModelRequestedAt = requestedAt
						if messageID != "" && messageID == streamMessageID && !streamRequestedAt.IsZero() {
							lastModelRequestedAt = streamRequestedAt
						}
						window := claudeResolveContextWindow(nil, str(m["model"]), r.contextWindows)
						if window == 0 {
							window = lastContextWindow
						}
						if err := setClaudeContext(sink, in, lastModelRequestedAt, used, window, obj(m["usage"])); err != nil {
							return err
						}
					}
				}
				if goalActive && str(m["model"]) != "" && m["model"] != "<synthetic>" {
					goalSawModel = true
				}
				content := arr(m["content"])
				// Claude Code can send one final assistant frame per block with the same message ID.
				offset := 0
				if len(content) == 1 {
					offset = nextAssistantBlock[messageID]
				}
				nextAssistantBlock[messageID] = offset + len(content)
				for i, v := range content {
					v := obj(v)
					if isClaudeAgentTool(v) {
						continue
					}
					id := fmt.Sprintf("%s:%d", messageID, offset+i)
					item := items[id]
					item.ID = id
					switch str(v["type"]) {
					case "text":
						item.Kind = "text"
						item.Text = str(v["text"])
						if sources := claudeCitations(v["citations"]); len(sources) > 0 {
							item.Citations = appendCitation(nil, utf16StringLen(item.Text), sources)
						}
						item.Status = "completed"
					case "thinking":
						item.Kind = "reasoning"
						item.Status = "completed"
						if text := str(v["thinking"]); strings.TrimSpace(text) != "" {
							item.Text = text
						}
					case "tool_use":
						item.Kind = "tool"
						item.Title = str(v["name"])
						toolItems[str(v["id"])] = id
						item.Text = clip(pretty(v["input"]))
						item.Status = "running"
					default:
						continue
					}
					if err = emit(item); err != nil {
						return err
					}
				}
			case "user":
				if f["uuid"] == messageID && f["isReplay"] == true && !accepted {
					accepted = true
					if err := bindTurn(); err != nil {
						return errors.Join(ErrUnconfirmed, err)
					}
				}
				if id := str(f["uuid"]); pendingSteers[id] {
					delete(pendingSteers, id)
					if receiptTimer != nil && len(pendingSteers) == 0 {
						receiptTimer.Stop()
						receiptDeadline = nil
					}
					if err := sink.Steered(id, nil); err != nil {
						return err
					}
				}
				for _, block := range arr(obj(f["message"])["content"]) {
					block := obj(block)
					id, ok := toolItems[str(block["tool_use_id"])]
					if !ok {
						continue
					}
					item := items[id]
					item.Status = "completed"
					if block["is_error"] == true {
						item.Status = "failed"
					}
					output := str(block["content"])
					if output == "" {
						output = pretty(block["content"])
					}
					item.Text += "\n" + clip(output)
					if err = emit(item); err != nil {
						return err
					}
				}
			case "result":
				aborted := f["terminal_reason"] == "aborted_streaming" || f["terminal_reason"] == "aborted_tools"
				if aborted && errors.Is(context.Cause(ctx), ErrPauseRequested) {
					interrupted = true
					if interruptAcknowledged {
						return ErrPaused
					}
					continue
				}
				if aborted {
					return context.Canceled
				}
				// The previous result can cross an input already written to stdin.
				// Wait until the CLI echoes that input before accepting its result.
				if len(pendingSteers) > 0 && f["is_error"] != true && str(f["subtype"]) == "success" {
					if receiptDeadline == nil {
						receiptTimer = time.NewTimer(30 * time.Second)
						receiptDeadline = receiptTimer.C
					}
					continue
				}
				if nativeID == "" {
					return errors.Join(ErrUnconfirmed, errors.New("Claude returned no bound session"))
				}
				if f["is_error"] == true || str(f["subtype"]) != "success" {
					if f["errors"] != nil {
						return fail(f["errors"])
					}
					return fail(f["result"])
				}
				hasText := false
				for _, item := range items {
					if item.Kind == "text" {
						hasText = true
					}
					if item.Status == "running" {
						item.Status = "completed"
						if err = emit(item); err != nil {
							return err
						}
					}
				}
				if !hasText && str(f["result"]) != "" {
					if err = emit(model.Item{ID: "result", Kind: "text", Text: str(f["result"]), Status: "completed"}); err != nil {
						return err
					}
				}
				modelUsage := obj(f["modelUsage"])
				if len(modelUsage) > 0 {
					if r.contextWindows == nil {
						r.contextWindows = map[string]int64{}
					}
					claudeRememberContextWindows(modelUsage, r.contextWindows)
				}
				if lastModelMessage != nil {
					usage := obj(lastModelMessage["usage"])
					if input, used := claudeUsageCounts(usage); input > 0 {
						window := claudeResolveContextWindow(modelUsage, str(lastModelMessage["model"]), r.contextWindows)
						if window == 0 {
							window = lastContextWindow
						} else {
							lastContextWindow = window
						}
						if err := setClaudeContext(sink, in, lastModelRequestedAt, used, window, usage); err != nil {
							return err
						}
					}
				} else if streamUsage != nil {
					if input, used := claudeUsageCounts(streamUsage); input > 0 {
						window := claudeResolveContextWindow(modelUsage, streamModel, r.contextWindows)
						if window == 0 {
							window = lastContextWindow
						} else {
							lastContextWindow = window
						}
						if err := setClaudeContext(sink, in, streamRequestedAt, used, window, streamUsage); err != nil {
							return err
						}
					}
				}
				if loopEnabled && loop.waiting() {
					loop.idle = true
					continue
				}
				finishReusable, err := finishClaude(ctx, r, sink, goalActive && goalSawModel, refreshContext, in.Provider.AutoCompactWindow)
				if err != nil {
					return err
				}
				canPark = finishReusable && !subagents.hasRunning() && !loop.waiting()
				return nil
			}
		}
	}
}

func claudeApproval(ctx context.Context, p *device.Process, sink Sink, frame object, subagentID string) error {
	r := obj(frame["request"])
	if str(r["subtype"]) == "request_user_dialog" {
		response := object{"behavior": "cancelled"}
		if r["dialog_kind"] == "resume_return" {
			answer, err := sink.Ask(ctx, model.Request{Kind: "question", Title: "Claude Code", Questions: []model.Question{{
				ID: "resume", Header: "Claude Code", Text: "Compact this idle conversation before continuing?", AllowCustom: boolPtr(false), Options: []model.QuestionOption{
					{ID: "continue", Label: "Continue"}, {ID: "compact", Label: "Compact and continue"},
				},
			}}})
			if err != nil {
				return err
			}
			if answer.Allow {
				result := "continue"
				if slices.Contains(answer.Answers["resume"], "compact") {
					result = "compact"
				}
				response = object{"behavior": "completed", "result": result}
			}
		}
		return p.Send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": frame["request_id"], "response": response}})
	}
	if str(r["subtype"]) == "elicitation" {
		schemaVal := r["requested_schema"]
		if schemaVal == nil {
			schemaVal = r["requestedSchema"]
		}
		if str(r["mode"]) != "form" || schemaVal == nil {
			return p.Send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": frame["request_id"], "response": object{"action": "cancel"}}})
		}
		rawSchema, err := json.Marshal(schemaVal)
		if err != nil {
			return p.Send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": frame["request_id"], "response": object{"action": "cancel"}}})
		}
		form, ok := parseElicitationForm(rawSchema, str(r["message"]), elicitationOptions{})
		if !ok {
			return p.Send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": frame["request_id"], "response": object{"action": "cancel"}}})
		}
		var req model.Request
		if form.empty {
			title := form.title
			if title == "" {
				title = strings.TrimSpace(str(r["title"]))
			}
			if title == "" {
				title = strings.TrimSpace(str(r["server_name"]))
			}
			if title == "" {
				title = "MCP confirmation"
			}
			req = model.Request{
				Kind:       "approval",
				Title:      title,
				Detail:     strings.TrimSpace(str(r["message"])),
				Questions:  []model.Question{},
				SubagentID: subagentID,
				AllowOnce:  &model.Answer{Allow: true, Answers: map[string][]string{}},
			}
		} else {
			title := form.title
			if title == "" {
				title = "Agent needs your input"
			}
			req = model.Request{
				Kind:       "question",
				Title:      title,
				Detail:     strings.TrimSpace(str(r["message"])),
				Questions:  form.questions,
				SubagentID: subagentID,
			}
		}
		answer, err := sink.Ask(ctx, req)
		if err != nil {
			return err
		}
		response := object{"action": "cancel"}
		if form.empty {
			if answer.Allow {
				response = object{"action": "accept", "content": object{}}
			} else {
				response = object{"action": "decline"}
			}
		} else if answer.Allow {
			if content, ok := form.content(answer.Answers); ok {
				response = object{"action": "accept", "content": content}
			}
		}
		return p.Send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": frame["request_id"], "response": response}})
	}
	if str(r["subtype"]) != "can_use_tool" {
		return fmt.Errorf("unsupported Claude request: %s", str(r["subtype"]))
	}
	name := str(r["tool_name"])
	input := obj(r["input"])
	request := model.Request{Kind: "approval", Title: name, Detail: clip(pretty(input)), Questions: []model.Question{}, SubagentID: subagentID}
	if name == "AskUserQuestion" {
		request.Kind = "question"
		request.Title = "Agent needs your input"
		rawQuestions := arr(input["questions"])
		for i, q := range rawQuestions {
			q := obj(q)
			text := strings.TrimSpace(str(q["question"]))
			if text == "" {
				continue
			}
			header := strings.TrimSpace(str(q["header"]))
			if header == "" && len(rawQuestions) > 1 {
				header = fmt.Sprintf("Question %d", i+1)
			}
			question := model.Question{
				ID:      str(q["question"]),
				Header:  header,
				Text:    text,
				Options: []model.QuestionOption{},
			}
			question.Multiple, _ = q["multiSelect"].(bool)
			for _, o := range arr(q["options"]) {
				o := obj(o)
				label := strings.TrimSpace(str(o["label"]))
				if label == "" {
					continue
				}
				question.Options = append(question.Options, model.QuestionOption{
					ID:          str(o["label"]),
					Label:       label,
					Description: strings.TrimSpace(str(o["description"])),
					Preview:     str(o["preview"]),
				})
			}
			request.Questions = append(request.Questions, question)
		}
	} else if r["requires_user_interaction"] != true && r["server_policy_ask_only"] != true {
		request.AllowOnce = &model.Answer{Allow: true, Answers: map[string][]string{}}
	}
	answer, err := sink.Ask(ctx, request)
	if err != nil {
		return err
	}
	response := object{"behavior": "deny", "message": "The user declined this action."}
	if answer.Allow {
		response = object{"behavior": "allow", "updatedInput": input}
		if request.Kind == "question" {
			answers := object{}
			for key, v := range answer.Answers {
				answers[key] = strings.Join(v, ", ")
			}
			input["answers"] = answers
		}
	}
	return p.Send(object{"type": "control_response", "response": object{"subtype": "success", "request_id": frame["request_id"], "response": response}})
}

func claudeContent(in Input) ([]object, error) {
	if name, arg := in.command(); name == "goal" {
		switch strings.ToLower(arg) {
		case "pause", "resume", "edit":
			return nil, errors.New("Claude /goal supports an objective, status, or clear")
		case "show", "status":
			in.Text = "/goal"
		}
	}
	content := []object{{"type": "text", "text": in.Message()}}
	for _, file := range in.Attachments {
		if !file.Image() {
			continue
		}
		data, err := os.ReadFile(file.Path)
		if err != nil {
			return nil, err
		}
		content = append(content, object{"type": "image", "source": object{"type": "base64", "media_type": file.MediaType, "data": base64.StdEncoding.EncodeToString(data)}})
	}
	return content, nil
}

// Claude caps the auto-compact window at the model's context and triggers
// compaction 33,000 tokens below the configured window.
const claudeAutoCompactReserveTokens int64 = 33_000

func claudeAutoCompactThreshold(autoCompactWindow int, window int64) int64 {
	limit := int64(autoCompactWindow)
	if limit <= claudeAutoCompactReserveTokens {
		return 0
	}
	if window > 0 && limit >= window {
		return 0
	}
	return limit - claudeAutoCompactReserveTokens
}

func claudeUsageSample(usage object) object {
	if iterations := arr(usage["iterations"]); len(iterations) > 0 {
		for i := len(iterations) - 1; i >= 0; i-- {
			sample := obj(iterations[i])
			if str(sample["type"]) == "message" {
				return sample
			}
		}
	}
	return usage
}

func claudeUsageCounts(usage object) (input, total int64) {
	sample := claudeUsageSample(usage)
	for _, key := range []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"} {
		if n, ok := nonNegativeInt(sample[key]); ok {
			input += n
		}
	}
	output, _ := nonNegativeInt(sample["output_tokens"])
	return input, input + output
}

func mergeClaudeStreamUsage(current, delta object) object {
	merged := maps.Clone(current)
	if merged == nil {
		merged = object{}
	}
	for _, key := range []string{"iterations", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "cache_creation"} {
		if value, ok := delta[key]; ok && value != nil {
			merged[key] = value
		}
	}
	return merged
}

func stripClaudeModelSuffix(model string) string {
	if i := strings.IndexByte(model, '['); i > 0 {
		return model[:i]
	}
	return model
}

func claudeRememberContextWindows(modelUsage object, cache map[string]int64) {
	for name, raw := range modelUsage {
		entry := obj(raw)
		if w, ok := nonNegativeInt(entry["contextWindow"]); ok && w > 0 {
			cache[name] = w
			if canonical := str(entry["canonicalModel"]); canonical != "" {
				cache[canonical] = w
			}
		}
	}
}

func claudeResolveContextWindow(modelUsage object, model string, cache map[string]int64) int64 {
	if w, ok := nonNegativeInt(obj(modelUsage[model])["contextWindow"]); ok && w > 0 {
		return w
	}
	base := stripClaudeModelSuffix(model)
	for name, raw := range modelUsage {
		entry := obj(raw)
		w, ok := nonNegativeInt(entry["contextWindow"])
		if !ok || w <= 0 {
			continue
		}
		if str(entry["canonicalModel"]) == model || (base != "" && (stripClaudeModelSuffix(name) == base || stripClaudeModelSuffix(str(entry["canonicalModel"])) == base)) {
			return w
		}
	}
	if len(modelUsage) == 1 {
		for _, raw := range modelUsage {
			if w, ok := nonNegativeInt(obj(raw)["contextWindow"]); ok && w > 0 {
				return w
			}
		}
	}
	if w := cache[model]; w > 0 {
		return w
	}
	if base != "" {
		if w := cache[base]; w > 0 {
			return w
		}
		for name, w := range cache {
			if w > 0 && stripClaudeModelSuffix(name) == base {
				return w
			}
		}
	}
	return 0
}

func setClaudeContext(sink Sink, in Input, requestedAt time.Time, used, window int64, usageMap object) error {
	if used < 0 || (used == 0 && window <= 0) {
		return nil
	}
	if window < 0 {
		window = 0
	}
	usage := &model.ContextUsage{
		Used:                 used,
		Window:               window,
		AutoCompactThreshold: claudeAutoCompactThreshold(in.Provider.AutoCompactWindow, window),
	}
	if !requestedAt.IsZero() && usageMap != nil {
		// Start at submission, so a slow response cannot extend a cache's lifetime.
		cache := obj(usageMap["cache_creation"])
		hour, _ := nonNegativeInt(cache["ephemeral_1h_input_tokens"])
		short, _ := nonNegativeInt(cache["ephemeral_5m_input_tokens"])
		cacheRead, _ := nonNegativeInt(usageMap["cache_read_input_tokens"])
		var ttl time.Duration
		switch {
		case hour > 0:
			ttl = time.Hour
		case short > 0:
			ttl = 5 * time.Minute
		case cacheRead > 0:
			ttl = 5 * time.Minute
		}
		if ttl != 0 {
			usage.PromptCacheExpiresAt, usage.CacheRunID = requestedAt.Add(ttl).UnixMilli(), in.RunID
		}
	}
	return sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = usage })
}
