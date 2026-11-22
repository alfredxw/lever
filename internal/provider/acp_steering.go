package provider

import (
	"errors"
	"fmt"
	"strings"

	acp "github.com/coder/acp-go-sdk"
)

const acpSteeringExtension = "_session/steering"

func (c *acpRuntime) steerMethod() string {
	info := c.initial.AgentInfo
	atLeast := func(minimum string) bool {
		if info == nil {
			return false
		}
		release := runtimeVersion(strings.TrimPrefix(info.Version, "v"))
		return versionAtLeast(release, minimum) && !(release == minimum && strings.Contains(info.Version, release+"-"))
	}
	if c.agyCLI && atLeast("1.5.0") {
		return "session/prompt"
	}
	capability := obj(c.initial.Meta["steering"])
	if capability["supported"] != true {
		return ""
	}
	for _, behavior := range arr(capability["idleBehaviors"]) {
		if behavior == "promptRequired" {
			return acpSteeringExtension
		}
	}
	if info == nil {
		return ""
	}
	switch strings.TrimPrefix(strings.TrimPrefix(info.Name, "@agentclientprotocol/"), "@zed-industries/") {
	case "codex-acp":
		if atLeast("2.4.0") {
			return acpSteeringExtension
		}
	case "claude-agent-acp", "claude-code-acp":
		if atLeast("0.65.0") {
			return acpSteeringExtension
		}
	}
	return ""
}

type acpPromptReply struct {
	method, id string
	sequence   int
	response   acp.PromptResponse
	err        error
}

func (c *acpRuntime) sendPrompt(blocks []acp.ContentBlock) (acp.PromptResponse, error) {
	return acp.SendRequest[acp.PromptResponse](c.conn, c.ctx, "session/prompt", acp.PromptRequest{SessionId: c.session, Prompt: blocks})
}

func (c *acpRuntime) injectPrompt(blocks []acp.ContentBlock) error {
	result, err := acp.SendRequest[struct{ Outcome string }](c.conn, c.ctx, acpSteeringExtension, acp.PromptRequest{
		SessionId: c.session, Prompt: blocks, Meta: object{"steering": object{"idleBehavior": "promptRequired"}},
	})
	if err != nil {
		return err
	}
	switch result.Outcome {
	case "injected":
		return nil
	case "promptRequired":
		return ErrSteerRejected
	default:
		return fmt.Errorf("unexpected ACP steering outcome %q", result.Outcome)
	}
}

func acpSteerFailure(err error) error {
	var request *acp.RequestError
	if errors.As(err, &request) {
		switch request.Code {
		case -32600, -32601, -32602:
			return errors.Join(ErrSteerRejected, err)
		}
	}
	if errors.Is(err, ErrSteerRejected) {
		return err
	}
	return errors.Join(ErrUnconfirmed, err)
}

func (c *acpRuntime) runPrompts(blocks []acp.ContentBlock, steers <-chan struct{}) (result acp.PromptResponse, err error) {
	method := c.steerMethod()
	if method == "" || steers == nil {
		result, err = c.sendPrompt(blocks)
		if err == nil {
			_, err = c.awaitPromptBoundary(result, nil, false)
		}
		return result, err
	}
	started := make(chan struct{})
	c.mu.Lock()
	c.promptStarted = started
	c.mu.Unlock()
	replies := make(chan acpPromptReply, 2)
	launch := func(call, id string, sequence int, prompt []acp.ContentBlock) {
		go func() {
			reply := acpPromptReply{method: call, id: id, sequence: sequence}
			if call == acpSteeringExtension {
				reply.err = c.injectPrompt(prompt)
			} else {
				reply.response, reply.err = c.sendPrompt(prompt)
			}
			replies <- reply
		}()
	}
	launch("session/prompt", "", 0, blocks)
	var wake <-chan struct{}
	arm := func() error {
		started, wake = nil, steers
		return c.sink.SetSteerState(SteerReady)
	}
	defer func() {
		if wake != nil && c.ctx.Err() == nil {
			err = errors.Join(err, c.sink.SetSteerState(SteerUnavailable))
		}
	}()
	open, prompts, sequence, latest := 1, 1, 0, -1
	queued := false
	for {
		if open == 0 {
			select {
			case <-started:
				if err := arm(); err != nil {
					return result, err
				}
			default:
			}
			var backgroundWake <-chan struct{}
			if method == "session/prompt" {
				backgroundWake = wake
			}
			queued, err = c.awaitPromptBoundary(result, backgroundWake, queued && backgroundWake != nil)
			if err != nil || !queued {
				return result, err
			}
		}
		var reply acpPromptReply
		select {
		case reply = <-replies:
		default:
			if queued && open == prompts && open <= 1 && c.ctx.Err() == nil {
				message, err := c.sink.NextSteer()
				if err != nil {
					return result, err
				}
				if message != nil {
					message.Profile.Instructions = ""
					prompt, buildErr := acpPrompt(*message, c.capabilities(), nil)
					if buildErr != nil {
						if err := c.sink.Steered(message.RunID, errors.Join(ErrSteerRejected, buildErr)); err != nil {
							return result, err
						}
						continue
					}
					c.mu.Lock()
					err = c.finishMessage()
					c.mu.Unlock()
					if err != nil {
						return result, err
					}
					sequence++
					open++
					if method == "session/prompt" {
						prompts++
					}
					launch(method, message.RunID, sequence, prompt)
					continue
				}
				queued = false
				if open == 0 {
					continue
				}
			}
			select {
			case <-started:
				if err := arm(); err != nil {
					return result, err
				}
				continue
			case <-wake:
				queued = true
				continue
			case <-c.ctx.Done():
				return result, c.ctx.Err()
			case reply = <-replies:
			}
		}
		open--
		if reply.method == "session/prompt" {
			prompts--
		}
		if reply.id != "" {
			delivery := reply.err
			if delivery != nil {
				delivery = acpSteerFailure(delivery)
			} else if reply.method == "session/prompt" && reply.response.StopReason != acp.StopReasonEndTurn && reply.response.StopReason != acp.StopReasonRefusal {
				delivery = fmt.Errorf("%w: ACP steer stopped with %q", ErrUnconfirmed, reply.response.StopReason)
			}
			if err := c.sink.Steered(reply.id, delivery); err != nil {
				return result, err
			}
			if errors.Is(delivery, ErrSteerRejected) {
				continue
			}
			if delivery != nil {
				return result, delivery
			}
		}
		if reply.err != nil {
			return result, reply.err
		}
		if reply.method == "session/prompt" && reply.sequence > latest {
			result, latest = reply.response, reply.sequence
		}
	}
}
