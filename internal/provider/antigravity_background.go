package provider

import (
	"errors"
	"strings"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

const antigravityReplyTimeout = 2 * time.Minute

type antigravityBackground struct {
	changed          chan struct{}
	runningPastUsage map[string]bool
	requests         int
	waiting          bool
	replyPending     bool
	replyText        bool
}

func newAntigravityBackground() *antigravityBackground {
	return &antigravityBackground{changed: make(chan struct{}, 1), runningPastUsage: map[string]bool{}}
}

func (background *antigravityBackground) signal() {
	select {
	case background.changed <- struct{}{}:
	default:
	}
}

func (background *antigravityBackground) observe(update acp.SessionUpdate, tools map[string]*acpToolState) {
	switch {
	case update.ToolCall != nil:
		background.observeCommand(tools[string(update.ToolCall.ToolCallId)])
	case update.ToolCallUpdate != nil:
		background.observeCommand(tools[string(update.ToolCallUpdate.ToolCallId)])
	case update.AgentMessageChunk != nil:
		if background.replyPending && strings.TrimSpace(acpText(update.AgentMessageChunk.Content)) != "" {
			background.replyText = true
			background.signal()
		}
	case update.AgentThoughtChunk != nil:
		if background.replyPending {
			background.signal()
		}
	case update.UsageUpdate != nil:
		for toolID := range background.runningPastUsage {
			background.runningPastUsage[toolID] = true
		}
		if background.replyText {
			background.replyPending, background.replyText = false, false
			background.signal()
		}
	}
}

func (background *antigravityBackground) observeCommand(tool *acpToolState) {
	if tool == nil {
		return
	}
	pastUsage, running := background.runningPastUsage[tool.ID]
	daemon, _ := obj(tool.RawInput)["IsDaemon"].(bool)
	if tool.Kind == acp.ToolKindExecute && tool.Status == acp.ToolCallStatusInProgress && !daemon {
		if !running {
			background.runningPastUsage[tool.ID] = false
		}
		background.signal()
	} else if running {
		delete(background.runningPastUsage, tool.ID)
		if (background.waiting || pastUsage) && (tool.Status == acp.ToolCallStatusCompleted || tool.Status == acp.ToolCallStatusFailed) {
			background.replyPending, background.replyText = true, false
		}
		background.signal()
	}
}

func (c *acpRuntime) finishAntigravityRequest() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.background.requests--
	c.background.signal()
}

func (c *acpRuntime) waitForAntigravityBackgroundLocked() error {
	background := c.background
	if len(background.runningPastUsage) == 0 && !background.replyPending {
		return nil
	}
	background.waiting = true
	timer := time.NewTimer(antigravityReplyTimeout)
	timer.Stop()
	defer timer.Stop()
	for c.err == nil && (len(background.runningPastUsage) > 0 || background.requests > 0 || background.replyPending) {
		var timeout <-chan time.Time
		if len(background.runningPastUsage) == 0 && background.requests == 0 {
			timer.Reset(antigravityReplyTimeout)
			timeout = timer.C
		}
		c.mu.Unlock()
		var err error
		select {
		case <-background.changed:
		case <-c.ctx.Done():
			err = c.ctx.Err()
		case <-c.conn.Done():
			err = errors.Join(ErrUnconfirmed, errors.New("Antigravity disconnected while waiting for its background command result"))
		case <-timeout:
			err = errors.Join(ErrUnconfirmed, errors.New("Antigravity did not report back after its background command exited"))
		}
		c.mu.Lock()
		timer.Stop()
		if err != nil {
			return err
		}
	}
	return nil
}
