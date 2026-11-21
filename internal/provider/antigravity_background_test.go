package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"testing/synctest"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

type antigravityPromptPeer struct {
	testing *testing.T
	peer    net.Conn
	request json.RawMessage
	result  <-chan error
	sink    *recordingSink
	stop    context.CancelFunc
}

func startAntigravityPrompt(t *testing.T) *antigravityPromptPeer {
	t.Helper()
	client, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close(); _ = client.Close() })
	ctx, stop := context.WithCancel(t.Context())
	t.Cleanup(stop)
	runtime, sink := newTestACPRuntime("", true)
	runtime.ctx, runtime.cancel = ctx, stop
	runtime.session, runtime.active = "test-session", true
	runtime.background = newAntigravityBackground()
	runtime.conn = acp.NewConnection(runtime.handle, client, client)
	result := make(chan error, 1)
	go func() {
		result <- runtime.prompt(ctx, []acp.ContentBlock{acp.TextBlock("test command")}, nil)
	}()
	var frame struct {
		ID     json.RawMessage
		Method string
	}
	if err := json.NewDecoder(peer).Decode(&frame); err != nil || frame.Method != "session/prompt" {
		t.Fatalf("expected session/prompt, got %s: %v", frame.Method, err)
	}
	return &antigravityPromptPeer{testing: t, peer: peer, request: frame.ID, result: result, sink: sink, stop: stop}
}

func (peer *antigravityPromptPeer) send(frame object) {
	peer.testing.Helper()
	frame["jsonrpc"] = "2.0"
	if err := json.NewEncoder(peer.peer).Encode(frame); err != nil {
		peer.testing.Fatal(err)
	}
}

func (peer *antigravityPromptPeer) update(update object) {
	peer.testing.Helper()
	peer.send(object{"method": "session/update", "params": object{"sessionId": "test-session", "update": update}})
}

func (peer *antigravityPromptPeer) command(id, status string, daemon bool) {
	peer.testing.Helper()
	peer.update(object{
		"sessionUpdate": "tool_call", "toolCallId": id, "kind": "execute", "title": "Running run_command", "status": status,
		"rawInput": object{"CommandLine": "make test", "WaitMsBeforeAsync": 10000, "IsDaemon": daemon},
	})
}

func (peer *antigravityPromptPeer) exitCommand(id string) {
	peer.testing.Helper()
	peer.update(object{
		"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed",
		"rawOutput": object{"output": "Command exited with code 1.", "exit_code": 1},
	})
}

func (peer *antigravityPromptPeer) usage() {
	peer.testing.Helper()
	peer.update(object{"sessionUpdate": "usage_update", "used": 90, "size": 4000})
}

func (peer *antigravityPromptPeer) endPrompt() {
	peer.testing.Helper()
	peer.send(object{"id": peer.request, "result": object{"stopReason": "end_turn"}})
}

func (peer *antigravityPromptPeer) checkRunning() {
	peer.testing.Helper()
	synctest.Wait()
	select {
	case err := <-peer.result:
		peer.testing.Fatalf("run ended early: %v", err)
	default:
	}
}

func (peer *antigravityPromptPeer) checkResult(want error) {
	peer.testing.Helper()
	synctest.Wait()
	select {
	case err := <-peer.result:
		if !errors.Is(err, want) {
			peer.testing.Fatalf("got %v, want %v", err, want)
		}
	default:
		peer.testing.Fatal("run did not finish")
	}
}

func TestAntigravityBackgroundContinuesSamePrompt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		peer.command("test", "in_progress", false)
		peer.command("lint", "in_progress", false)
		peer.command("server", "in_progress", true)
		peer.usage()
		peer.endPrompt()
		time.Sleep(10 * time.Minute)
		peer.checkRunning()
		if tool := peer.sink.byID["tool-test"]; tool.Status != "running" || tool.ExitCode != nil {
			t.Fatalf("command ended before its result: %+v", tool)
		}

		peer.exitCommand("test")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Tests exited."}})
		peer.usage()
		peer.checkRunning()
		peer.exitCommand("lint")
		peer.usage()
		peer.checkRunning()
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Lint also exited."}})
		peer.checkRunning()
		peer.usage()
		peer.checkResult(nil)

		if tool := peer.sink.byID["tool-lint"]; tool.Status != "completed" || tool.ExitCode == nil || *tool.ExitCode != 1 {
			t.Fatalf("missing real command outcome: %+v", tool)
		}
		if last := peer.sink.items[len(peer.sink.items)-1]; last.Text != "Lint also exited." || last.Status != "completed" {
			t.Fatalf("missing final reply: %+v", last)
		}
	})
}

func TestAntigravityBackgroundDoesNotHoldOrdinaryPrompt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		peer.command("fast", "in_progress", false)
		peer.exitCommand("fast")
		peer.command("pending", "pending", false)
		peer.command("server", "in_progress", true)
		peer.endPrompt()
		peer.checkResult(nil)
	})
}

func TestAntigravityBackgroundCompletionAtPromptBoundary(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		peer.command("test", "in_progress", false)
		peer.usage()
		peer.exitCommand("test")
		peer.endPrompt()
		peer.checkRunning()
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "The test failed."}})
		peer.usage()
		peer.checkResult(nil)
	})
}

func TestAntigravityBackgroundNeverReportsUnconfirmedSuccess(t *testing.T) {
	for _, test := range []struct {
		name   string
		finish func(*antigravityPromptPeer)
		want   error
	}{
		{"disconnect", func(peer *antigravityPromptPeer) { _ = peer.peer.Close() }, ErrUnconfirmed},
		{"stop", func(peer *antigravityPromptPeer) { peer.stop() }, context.Canceled},
		{"no reply", func(peer *antigravityPromptPeer) {
			peer.exitCommand("test")
			time.Sleep(antigravityReplyTimeout + time.Second)
		}, ErrUnconfirmed},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				peer := startAntigravityPrompt(t)
				peer.command("test", "in_progress", false)
				peer.endPrompt()
				peer.checkRunning()
				test.finish(peer)
				peer.checkResult(test.want)
			})
		})
	}
}
