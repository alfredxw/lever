package provider

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

const (
	antigravityReplyTimeout       = 5 * time.Minute
	antigravityChildReplyTimeout  = 2 * time.Minute
	antigravityCommandHoldTimeout = 30 * time.Minute
	antigravitySettleTimeout      = time.Second
	antigravityChildIdleGrace     = 3 * time.Second
)

type antigravityProbeState int

const (
	antigravityProbeIdle antigravityProbeState = iota
	antigravityProbeGenerating
	antigravityProbePending
)

type antigravityBackground struct {
	changed          chan struct{}
	runningPastUsage map[string]bool
	requests         int
	waiting          bool
	replyPending     bool
	replyText        bool
	settling         bool
	generation       uint64
	probe            func(context.Context) antigravityProbeState
	childProbe       antigravityChildProbe
	childCalls       map[string]int
	childStates      map[string]string
}

func newAntigravityBackground() *antigravityBackground {
	return &antigravityBackground{
		changed:          make(chan struct{}, 1),
		runningPastUsage: map[string]bool{},
		childCalls:       map[string]int{},
		childStates:      map[string]string{},
	}
}

func (background *antigravityBackground) signal() {
	background.generation++
	select {
	case background.changed <- struct{}{}:
	default:
	}
}

func isAntigravityDaemon(tool *acpToolState) bool {
	if tool == nil {
		return false
	}
	daemon, _ := obj(tool.RawInput)["IsDaemon"].(bool)
	return daemon
}

func isAntigravitySchedule(tool *acpToolState) bool {
	return tool != nil && acpNormalizedToolName(tool.Title) == "schedule"
}

func isAntigravityBackgroundCommand(tool *acpToolState) bool {
	if tool == nil || isAntigravityDaemon(tool) || isAntigravitySchedule(tool) {
		return false
	}
	if tool.Kind == acp.ToolKindExecute {
		return true
	}
	if tool.Kind != "" {
		return false
	}
	input := obj(tool.RawInput)
	command := strings.TrimSpace(cmp.Or(
		str(input["CommandLine"]),
		str(input["command_line"]),
		str(input["commandLine"]),
		str(input["command"]),
	))
	return inferACPToolAction(tool.Title, command) == model.ToolActionCommand
}

func antigravityToolOutlivesPrompt(tool *acpToolState) bool {
	return isAntigravityBackgroundCommand(tool) || isAntigravitySchedule(tool) || isAntigravitySubagentCall(tool)
}

func (background *antigravityBackground) heldOnlyByCommands(tools map[string]*acpToolState) bool {
	if len(background.runningPastUsage) == 0 || background.requests > 0 || len(background.childCalls) > 0 {
		return false
	}
	for id := range background.runningPastUsage {
		if !isAntigravityBackgroundCommand(tools[id]) {
			return false
		}
	}
	return true
}

func (background *antigravityBackground) observe(update acp.SessionUpdate, tools map[string]*acpToolState) {
	switch {
	case update.ToolCall != nil:
		background.observeTool(tools[string(update.ToolCall.ToolCallId)], true)
	case update.ToolCallUpdate != nil:
		background.observeTool(tools[string(update.ToolCallUpdate.ToolCallId)], false)
	case update.AgentMessageChunk != nil:
		if hasACPMessageContent(update.AgentMessageChunk.Content) {
			if background.waiting {
				background.settling = false
				background.replyPending = true
				background.replyText = true
				background.signal()
			} else if background.replyPending {
				background.replyText = true
				background.signal()
			}
		}
	case update.AgentThoughtChunk != nil:
		if background.waiting {
			if background.settling {
				background.settling = false
				background.replyPending = true
				background.replyText = false
			}
			background.signal()
		} else if background.replyPending {
			background.signal()
		}
	case update.UsageUpdate != nil:
		for toolID := range background.runningPastUsage {
			background.runningPastUsage[toolID] = true
		}
		replyText := background.replyText
		background.replyText = false
		if background.waiting {
			if replyText {
				if len(background.runningPastUsage) == 0 && background.requests == 0 {
					background.settling = true
				} else {
					background.replyPending = false
				}
			}
			background.signal()
		} else if replyText {
			background.replyPending = false
			background.signal()
		}
	}
}

func (background *antigravityBackground) observeTool(tool *acpToolState, created bool) {
	if tool == nil {
		return
	}
	pastUsage, running := background.runningPastUsage[tool.ID]
	daemon := isAntigravityDaemon(tool)
	hold := !daemon && (background.waiting || antigravityToolOutlivesPrompt(tool))
	if tool.Status == acp.ToolCallStatusInProgress && hold {
		if !running {
			background.runningPastUsage[tool.ID] = false
		}
		if background.waiting {
			background.settling = false
			background.replyPending = true
			background.replyText = false
		}
		background.signal()
		return
	}
	if running {
		delete(background.runningPastUsage, tool.ID)
		if (background.waiting || pastUsage) && (tool.Status == acp.ToolCallStatusCompleted || tool.Status == acp.ToolCallStatusFailed) {
			background.settling = false
			background.replyPending = true
			background.replyText = false
		}
		background.signal()
		return
	}
	if background.waiting && (created || (!daemon && (tool.Status == acp.ToolCallStatusCompleted || tool.Status == acp.ToolCallStatusFailed))) {
		background.settling = false
		background.replyPending = true
		background.replyText = false
		background.signal()
	}
}

func (background *antigravityBackground) startRequest() {
	background.requests++
	if background.waiting {
		background.settling = false
		background.replyPending = true
		background.replyText = false
	}
	background.signal()
}

func (c *acpRuntime) finishAntigravityRequest() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.background.requests--
	if c.background.waiting {
		c.background.settling = false
		c.background.replyPending = true
		c.background.replyText = false
	}
	c.background.signal()
}

func (c *acpRuntime) awaitPromptBoundary(result acp.PromptResponse, wake <-chan struct{}, queued bool) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	background := c.background
	if result.StopReason != acp.StopReasonEndTurn || background == nil {
		return false, nil
	}
	replyTimer := time.NewTimer(antigravityReplyTimeout)
	replyTimer.Stop()
	defer replyTimer.Stop()
	settleTimer := time.NewTimer(antigravitySettleTimeout)
	settleTimer.Stop()
	defer settleTimer.Stop()
	commandHoldTimer := time.NewTimer(antigravityCommandHoldTimeout)
	commandHoldTimer.Stop()
	defer commandHoldTimer.Stop()

	var generatingSince, childIdleSince, childReplySince time.Time
	for c.err == nil && (len(background.runningPastUsage) > 0 || background.requests > 0 || background.replyPending || background.settling || len(background.childCalls) > 0) {
		background.waiting = true
		if queued && c.ctx.Err() == nil {
			return true, nil
		}
		var replyTimeout, settleTimeout, commandHoldTimeout <-chan time.Time
		if len(background.runningPastUsage) == 0 && background.requests == 0 {
			if background.settling || len(background.childCalls) > 0 {
				settleTimer.Reset(antigravitySettleTimeout)
				settleTimeout = settleTimer.C
			} else {
				generatingSince = time.Time{}
				childIdleSince = time.Time{}
				childReplySince = time.Time{}
				replyTimer.Reset(antigravityReplyTimeout)
				replyTimeout = replyTimer.C
			}
		} else {
			generatingSince = time.Time{}
			childIdleSince = time.Time{}
			childReplySince = time.Time{}
			if background.heldOnlyByCommands(c.tools) {
				commandHoldTimer.Reset(antigravityCommandHoldTimeout)
				commandHoldTimeout = commandHoldTimer.C
			}
		}
		gen := background.generation
		c.mu.Unlock()
		var err error
		settled := false
		changed := false
		commandHoldExpired := false
		select {
		case <-wake:
			queued = true
		case <-background.changed:
			changed = true
		case <-c.ctx.Done():
			err = c.ctx.Err()
		case <-c.conn.Done():
			err = errors.Join(ErrUnconfirmed, errors.New("Antigravity disconnected while waiting for background work"))
		case <-settleTimeout:
			settled = true
		case <-replyTimeout:
			err = errors.Join(ErrUnconfirmed, errors.New("Antigravity did not report back after its background command exited"))
		case <-commandHoldTimeout:
			commandHoldExpired = true
		}
		c.mu.Lock()
		replyTimer.Stop()
		settleTimer.Stop()
		commandHoldTimer.Stop()
		if changed {
			generatingSince = time.Time{}
			childIdleSince = time.Time{}
			childReplySince = time.Time{}
		}
		if err != nil {
			return false, err
		}
		if commandHoldExpired {
			if c.err != nil || background.generation != gen || !background.heldOnlyByCommands(c.tools) {
				continue
			}
			clear(background.runningPastUsage)
			background.settling = false
			background.replyPending = false
			background.replyText = false
			continue
		}
		if !settled {
			continue
		}
		if c.err != nil || len(background.runningPastUsage) > 0 || background.requests > 0 {
			continue
		}
		if len(background.childCalls) > 0 {
			active, err := c.checkAntigravityChildrenLocked()
			if err != nil {
				return false, err
			}
			if active {
				generatingSince = time.Time{}
				childIdleSince = time.Time{}
				childReplySince = time.Time{}
				continue
			}
		}
		if !background.settling && background.replyPending && len(background.childCalls) > 0 {
			if background.probe != nil {
				state, ok, err := c.probeAntigravityBackgroundLocked()
				if err != nil {
					return false, err
				}
				if !ok {
					continue
				}
				switch state {
				case antigravityProbePending, antigravityProbeGenerating:
					childIdleSince = time.Time{}
					if childReplySince.IsZero() {
						childReplySince = time.Now()
					} else if time.Since(childReplySince) >= antigravityReplyTimeout {
						if err := c.finishRemainingAntigravityChildrenLocked(); err != nil {
							return false, err
						}
						return false, errors.New("Antigravity stopped responding after its subagent reported")
					}
				default:
					childReplySince = time.Time{}
					if childIdleSince.IsZero() {
						childIdleSince = time.Now()
					} else if time.Since(childIdleSince) >= antigravityChildIdleGrace {
						if err := c.finishRemainingAntigravityChildrenLocked(); err != nil {
							return false, err
						}
						background.replyPending = false
						background.replyText = false
					}
				}
			} else {
				if childReplySince.IsZero() {
					childReplySince = time.Now()
				} else if time.Since(childReplySince) >= antigravityChildReplyTimeout {
					if err := c.finishRemainingAntigravityChildrenLocked(); err != nil {
						return false, err
					}
					background.replyPending = false
					background.replyText = false
				}
			}
			continue
		}
		if !background.settling && len(background.childCalls) == 0 {
			continue
		}
		state, ok, err := c.probeAntigravityBackgroundLocked()
		if err != nil {
			return false, err
		}
		if !ok {
			continue
		}
		switch state {
		case antigravityProbePending:
			generatingSince = time.Time{}
			background.settling = false
			background.replyPending = true
			background.replyText = false
		case antigravityProbeGenerating:
			if generatingSince.IsZero() {
				generatingSince = time.Now()
			} else if time.Since(generatingSince) >= antigravityReplyTimeout {
				if len(background.childCalls) > 0 {
					if err := c.finishRemainingAntigravityChildrenLocked(); err != nil {
						return false, err
					}
					return false, errors.New("Antigravity stopped responding after its subagent reported")
				}
				return false, errors.Join(ErrUnconfirmed, errors.New("Antigravity did not report back after its background command exited"))
			}
		default:
			if err := c.finishRemainingAntigravityChildrenLocked(); err != nil {
				return false, err
			}
			background.settling = false
			background.replyPending = false
			background.replyText = false
		}
	}
	return false, nil
}

func (c *acpRuntime) probeAntigravityBackgroundLocked() (antigravityProbeState, bool, error) {
	bg := c.background
	gen := bg.generation
	probe := bg.probe
	state := antigravityProbeIdle
	if probe != nil {
		c.mu.Unlock()
		state = probe(c.ctx)
		c.mu.Lock()
	}
	if c.err != nil {
		return antigravityProbeIdle, false, nil
	}
	if err := c.ctx.Err(); err != nil {
		return antigravityProbeIdle, false, err
	}
	if bg.generation != gen {
		return antigravityProbeIdle, false, nil
	}
	return state, true, nil
}

// Called at a quiet prompt/response boundary. Leave the ACP reader free to
// receive the next tool, permission request or reply while reading the store.
func (c *acpRuntime) checkAntigravityChildrenLocked() (bool, error) {
	bg := c.background
	gen := bg.generation
	calls := maps.Clone(bg.childCalls)
	c.mu.Unlock()
	outcomes, err := bg.childProbe(c.ctx, calls)
	c.mu.Lock()
	if err := c.ctx.Err(); err != nil {
		return false, err
	}
	if bg.generation != gen || c.err != nil {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	active := false
	for id := range calls {
		agent := c.subagents[id]
		if agent == nil {
			delete(bg.childCalls, id)
			delete(bg.childStates, id)
			continue
		}
		prev := bg.childStates[id]
		outcome, ok := outcomes[id]
		switch {
		case !ok:
			// Fail open: nothing proves this child is still running.
			if agent.item.Status == "running" {
				agent.finish("completed", "")
				if err := agent.publish(c.sink); err != nil {
					return false, err
				}
			}
			delete(bg.childCalls, id)
			delete(bg.childStates, id)
		case outcome.status == "running":
			active = true
			bg.childStates[id] = "running"
			if agent.item.Status != "running" {
				agent.restart()
				if err := agent.publish(c.sink); err != nil {
					return false, err
				}
			}
			if progress := clip(outcome.report); progress != "" && agent.detail.Progress != progress {
				agent.detail.Progress = progress
				if err := agent.publish(c.sink); err != nil {
					return false, err
				}
			}
		case outcome.status == "interrupted":
			bg.childStates[id] = "interrupted"
			if agent.item.Status != "interrupted" {
				agent.finish("interrupted", outcome.report)
				if err := agent.publish(c.sink); err != nil {
					return false, err
				}
			}
		default:
			bg.childStates[id] = "reported"
			if prev == "running" && !bg.settling {
				bg.replyPending = true
			}
			imgs := extractExistingImagePaths(outcome.report, c.cwd)
			prevImgCount := len(agent.item.ImageFiles)
			if len(imgs) > 0 {
				agent.addImages(imgs)
				if agent.imageGenerator {
					c.recordGeneratedImages(id, imgs)
				}
			}
			report := clip(outcome.report)
			if agent.item.Status != "completed" || (report != "" && agent.item.Text != report) || len(agent.item.ImageFiles) != prevImgCount {
				agent.finish("completed", outcome.report)
				if err := agent.publish(c.sink); err != nil {
					return false, err
				}
			}
		}
	}
	if active && bg.settling {
		bg.settling = false
		bg.replyPending = false
	}
	return active, nil
}

func (c *acpRuntime) finishRemainingAntigravityChildrenLocked() error {
	bg := c.background
	for id := range bg.childCalls {
		if agent := c.subagents[id]; agent != nil && agent.item.Status == "running" {
			agent.finish("completed", "")
			if err := agent.publish(c.sink); err != nil {
				return err
			}
		}
		delete(bg.childCalls, id)
		delete(bg.childStates, id)
	}
	return nil
}
