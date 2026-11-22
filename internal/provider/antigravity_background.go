package provider

import (
	"context"
	"errors"
	"maps"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

const (
	antigravityReplyTimeout  = 5 * time.Minute
	antigravitySettleTimeout = time.Second
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
}

func newAntigravityBackground() *antigravityBackground {
	return &antigravityBackground{changed: make(chan struct{}, 1), runningPastUsage: map[string]bool{}, childCalls: map[string]int{}}
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

func (background *antigravityBackground) observe(update acp.SessionUpdate, tools map[string]*acpToolState) {
	switch {
	case update.ToolCall != nil:
		background.observeTool(tools[string(update.ToolCall.ToolCallId)], true)
	case update.ToolCallUpdate != nil:
		background.observeTool(tools[string(update.ToolCallUpdate.ToolCallId)], false)
	case update.AgentMessageChunk != nil:
		if strings.TrimSpace(acpText(update.AgentMessageChunk.Content)) != "" {
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
			if replyText && len(background.runningPastUsage) == 0 && background.requests == 0 {
				background.settling = true
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
	if tool.Status == acp.ToolCallStatusInProgress && !daemon {
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

	var generatingSince, childUnconfirmedSince time.Time
	for c.err == nil && (len(background.runningPastUsage) > 0 || background.requests > 0 || background.replyPending || background.settling || len(background.childCalls) > 0) {
		background.waiting = true
		if queued && c.ctx.Err() == nil {
			return true, nil
		}
		var replyTimeout, settleTimeout <-chan time.Time
		if len(background.runningPastUsage) == 0 && background.requests == 0 {
			if background.settling || len(background.childCalls) > 0 {
				settleTimer.Reset(antigravitySettleTimeout)
				settleTimeout = settleTimer.C
			} else {
				generatingSince = time.Time{}
				replyTimer.Reset(antigravityReplyTimeout)
				replyTimeout = replyTimer.C
			}
		} else {
			generatingSince = time.Time{}
			childUnconfirmedSince = time.Time{}
		}
		c.mu.Unlock()
		var err error
		settled := false
		select {
		case <-wake:
			queued = true
		case <-background.changed:
		case <-c.ctx.Done():
			err = c.ctx.Err()
		case <-c.conn.Done():
			err = errors.Join(ErrUnconfirmed, errors.New("Antigravity disconnected while waiting for background work"))
		case <-settleTimeout:
			settled = true
		case <-replyTimeout:
			err = errors.Join(ErrUnconfirmed, errors.New("Antigravity did not report back after its background command exited"))
		}
		c.mu.Lock()
		replyTimer.Stop()
		settleTimer.Stop()
		if err != nil {
			return false, err
		}
		if !settled {
			continue
		}
		if c.err != nil || len(background.runningPastUsage) > 0 || background.requests > 0 {
			continue
		}
		if len(background.childCalls) > 0 {
			if err := c.checkAntigravityChildrenLocked(&childUnconfirmedSince); err != nil {
				return false, err
			}
			if len(background.childCalls) > 0 {
				continue
			}
		}
		if !background.settling {
			continue
		}
		gen := background.generation
		probe := background.probe
		state := antigravityProbeIdle
		if probe != nil {
			c.mu.Unlock()
			state = probe(c.ctx)
			c.mu.Lock()
		}
		if c.err != nil {
			return false, nil
		}
		if c.ctx.Err() != nil {
			return false, c.ctx.Err()
		}
		if background.generation != gen {
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
				return false, errors.Join(ErrUnconfirmed, errors.New("Antigravity did not report back after its background command exited"))
			}
		default:
			background.settling = false
			background.replyPending = false
			background.replyText = false
		}
	}
	return false, nil
}

// Called at a quiet prompt/response boundary. Leave the ACP reader free to
// receive the next tool, permission request or reply while reading the store.
func (c *acpRuntime) checkAntigravityChildrenLocked(unconfirmedSince *time.Time) error {
	bg := c.background
	gen := bg.generation
	calls := maps.Clone(bg.childCalls)
	reply := c.items[c.textID]
	if reply.Kind != "text" {
		reply.Text = ""
	}
	c.mu.Unlock()
	outcomes, err := bg.childProbe(c.ctx, calls, reply.Text)
	c.mu.Lock()
	if err := c.ctx.Err(); err != nil {
		return err
	}
	if bg.generation != gen || c.err != nil {
		return nil
	}
	if err != nil {
		return err
	}
	unconfirmed := false
	active := false
	for id := range calls {
		outcome, ok := outcomes[id]
		agent := c.subagents[id]
		switch {
		case !ok:
			unconfirmed = true
		case outcome.status == "running":
			active = true
		case outcome.status == "reported":
			unconfirmed = true // Wait for the parent's delivered reply.
			if progress := clip(outcome.report); agent.detail.Progress != progress {
				agent.detail.Progress = progress
				if err := agent.publish(c.sink); err != nil {
					return err
				}
			}
		default:
			agent.finish(outcome.status, outcome.report)
			if err := agent.publish(c.sink); err != nil {
				return err
			}
			delete(bg.childCalls, id)
		}
	}
	switch {
	case active || !unconfirmed:
		*unconfirmedSince = time.Time{}
	case unconfirmedSince.IsZero():
		*unconfirmedSince = time.Now()
	case time.Since(*unconfirmedSince) >= antigravityReplyTimeout:
		return errors.Join(ErrUnconfirmed, errors.New("Antigravity did not confirm the subagent result and parent reply"))
	}
	return nil
}
