package provider

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/synctest"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

type backgroundSteerSink struct {
	*recordingSink
	message  *Input
	states   []SteerState
	receipts []string
}

func (sink *backgroundSteerSink) SetSteerState(state SteerState) error {
	sink.states = append(sink.states, state)
	return nil
}

func (sink *backgroundSteerSink) NextSteer() (*Input, error) {
	message := sink.message
	sink.message = nil
	return message, nil
}

func (sink *backgroundSteerSink) Steered(id string, err error) error {
	sink.receipts = append(sink.receipts, id)
	return err
}

func TestAntigravitySteersAfterForegroundEnd(t *testing.T) {
	for _, kind := range []string{"command", "child", "continuation"} {
		t.Run(kind, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				wake := make(chan struct{}, 1)
				sink := &backgroundSteerSink{}
				peer := startConfiguredAntigravityPrompt(t, nil, func(runtime *acpRuntime, recording *recordingSink) <-chan struct{} {
					sink.recordingSink = recording
					runtime.sink, runtime.agyCLI = sink, true
					runtime.initial.AgentInfo = &acp.Implementation{Name: "agy", Version: "1.5.12"}
					return wake
				})
				var child *antigravityChildFixture
				if kind == "child" {
					child = newAntigravityChildFixture(t)
					peer.runtime.background.childProbe = child.store.watchSubagents("test-session")
					child.declare(2, "launch", "researcher", "SUBAGENT_STATE_ALIVE")
					peer.tool("launch", "other", "Run invoke_subagent", "in_progress")
					peer.completeTool("launch")
					child.reply(3, "Before steer.")
				} else {
					peer.command("original", "in_progress", false)
				}
				peer.message("Before steer.")
				peer.endPrompt()
				if kind == "continuation" {
					peer.completeTool("original")
				}
				peer.checkRunning()
				if !slices.Equal(sink.states, []SteerState{SteerReady}) || !peer.runtime.background.waiting {
					t.Fatal("Steer closed while waiting for", kind, sink.states)
				}
				sink.message = &Input{RunID: "follow", Text: "Change direction"}
				wake <- struct{}{}
				var next struct {
					ID     json.RawMessage
					Method string
					Params acp.PromptRequest
				}
				if err := json.NewDecoder(peer.peer).Decode(&next); err != nil || next.Method != "session/prompt" || next.Params.SessionId != "test-session" || acpText(next.Params.Prompt[0]) != "Change direction" {
					t.Fatalf("steer cancelled or replaced the session: %+v, %v", next, err)
				}
				peer.request = next.ID
				peer.endPrompt()
				peer.checkRunning()
				if !slices.Equal(sink.receipts, []string{"follow"}) {
					t.Fatal("missing steer receipt", sink.receipts)
				}
				if child != nil {
					child.report(4, "researcher", "test-session", "Child result.")
					child.reply(5, "Final synthesis.")
				} else if kind == "command" {
					peer.completeTool("original")
				}
				peer.message("Final synthesis.")
				peer.settle()
				peer.checkResult(nil)
				if !slices.Equal(sink.states, []SteerState{SteerReady, SteerUnavailable}) || !slices.ContainsFunc(sink.items, func(item model.Item) bool { return strings.Contains(item.Text, "Before steer.") }) || !slices.ContainsFunc(sink.items, func(item model.Item) bool { return strings.Contains(item.Text, "Final synthesis.") }) {
					t.Fatal(sink.states, sink.items)
				}
			})
		})
	}
}

func TestACPAudioFollowsHandshake(t *testing.T) {
	path := filepath.Join(t.TempDir(), "voice.wav")
	if err := os.WriteFile(path, []byte("audio"), 0600); err != nil {
		t.Fatal(err)
	}
	in := Input{Provider: model.Provider{Type: "antigravity"}, Attachments: []Attachment{{Attachment: model.Attachment{Name: "voice.wav", MediaType: "audio/wave"}, Path: path}}}
	for _, advertised := range []bool{true, false} {
		runtime := &acpRuntime{}
		runtime.initial.AgentCapabilities.PromptCapabilities.EmbeddedContext = true
		runtime.initial.AgentCapabilities.PromptCapabilities.Audio = advertised
		blocks, err := acpPrompt(in, runtime.capabilities(), nil)
		if err != nil || len(blocks) != 2 {
			t.Fatal(blocks, err)
		}
		if advertised && (blocks[1].Audio == nil || blocks[1].Audio.Data != "YXVkaW8=" || blocks[1].Audio.MimeType != "audio/wav") || !advertised && blocks[1].ResourceLink == nil {
			t.Fatal(blocks[1])
		}
	}
}

func TestACPSteeringContract(t *testing.T) {
	supported := object{"supported": true}
	hostOwned := object{"supported": true, "idleBehaviors": []any{"promptRequired"}}
	for _, tc := range []struct {
		name, version string
		cli           bool
		capability    object
		method        string
	}{
		{"agy", "1.5.0", true, nil, "session/prompt"}, {"agy", "1.5.0-beta.1", true, nil, ""},
		{"antigravity-acp", "1.5.12", false, nil, ""}, {"deepseek-harness-acp", "0.0.1", false, nil, ""},
		{"codex-acp", "2.4.0", false, nil, ""}, {"codex-acp", "2.3.9", false, supported, ""},
		{"@agentclientprotocol/codex-acp", "2.4.0", false, supported, acpSteeringExtension},
		{"@zed-industries/claude-agent-acp", "0.65.0", false, supported, acpSteeringExtension},
		{"other", "99.0.0", false, supported, ""}, {"other", "1.0.0", false, hostOwned, acpSteeringExtension},
		{"other", "1.0.0", false, object{"supported": false, "idleBehaviors": []any{"promptRequired"}}, ""},
	} {
		client := acpRuntime{agyCLI: tc.cli, initial: acp.InitializeResponse{AgentInfo: &acp.Implementation{Name: tc.name, Version: tc.version}, Meta: object{"steering": tc.capability}}}
		if got := client.steerMethod(); got != tc.method {
			t.Errorf("%s %s %v: got %q, want %q", tc.name, tc.version, tc.capability, got, tc.method)
		}
	}
	if err := acpSteerFailure(&acp.RequestError{Code: -32000}); !errors.Is(err, ErrUnconfirmed) || errors.Is(err, ErrSteerRejected) {
		t.Fatalf("agent errors must not automatically replay input: %v", err)
	}
}

func TestPiSteerWaitsForReceipt(t *testing.T) {
	resp := object{"type": "response", "id": "current", "command": "steer", "success": true}
	echo := func(text string) object {
		return object{"type": "message_start", "message": object{"role": "user", "content": []any{object{"type": "text", "text": text}}}}
	}
	for _, frames := range [][]object{{resp, echo("different"), echo("exact")}, {echo("exact"), resp}} {
		delivery := piSteer{id: "current", text: "exact"}
		for index, frame := range frames {
			if done, err := delivery.observe(frame); err != nil || done != (index == len(frames)-1) {
				t.Fatalf("frame %d: done=%t err=%v", index, done, err)
			}
		}
	}
	resp["data"] = object{"disposition": "handled"}
	if done, err := (&piSteer{id: "current"}).observe(resp); !done || err != nil {
		t.Fatalf("native handled receipt: done=%t err=%v", done, err)
	}
}
