package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

type antigravityPromptPeer struct {
	testing *testing.T
	peer    net.Conn
	request json.RawMessage
	result  <-chan error
	sink    *recordingSink
	runtime *acpRuntime
	stop    context.CancelFunc
}

func startAntigravityPrompt(t *testing.T) *antigravityPromptPeer {
	t.Helper()
	return startAntigravityPromptWithProbe(t, nil)
}

func startAntigravityPromptWithProbe(t *testing.T, probe func(context.Context) antigravityProbeState) *antigravityPromptPeer {
	t.Helper()
	return startConfiguredAntigravityPrompt(t, probe, nil)
}

func startConfiguredAntigravityPrompt(t *testing.T, probe func(context.Context) antigravityProbeState, configure func(*acpRuntime, *recordingSink) <-chan struct{}) *antigravityPromptPeer {
	t.Helper()
	client, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close(); _ = client.Close() })
	ctx, stop := context.WithCancel(t.Context())
	t.Cleanup(stop)
	runtime, sink := newTestACPRuntime("", true)
	runtime.ctx, runtime.cancel = ctx, stop
	runtime.session, runtime.active = "test-session", true
	runtime.background = newAntigravityBackground()
	runtime.background.probe = probe
	var steers <-chan struct{}
	if configure != nil {
		steers = configure(runtime, sink)
	}
	runtime.conn = acp.NewConnection(runtime.handle, client, client)
	result := make(chan error, 1)
	go func() {
		result <- runtime.prompt(ctx, []acp.ContentBlock{acp.TextBlock("test command")}, nil, steers)
	}()
	var frame struct {
		ID     json.RawMessage
		Method string
	}
	if err := json.NewDecoder(peer).Decode(&frame); err != nil || frame.Method != "session/prompt" {
		t.Fatalf("expected session/prompt, got %s: %v", frame.Method, err)
	}
	return &antigravityPromptPeer{testing: t, peer: peer, request: frame.ID, result: result, sink: sink, runtime: runtime, stop: stop}
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

func (peer *antigravityPromptPeer) tool(id, kind, title, status string) {
	peer.testing.Helper()
	peer.update(object{
		"sessionUpdate": "tool_call", "toolCallId": id, "kind": kind, "title": title, "status": status,
	})
}

func (peer *antigravityPromptPeer) completeTool(id string) {
	peer.testing.Helper()
	peer.update(object{
		"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed",
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

func (peer *antigravityPromptPeer) settle() {
	peer.testing.Helper()
	time.Sleep(antigravitySettleTimeout)
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
		peer.checkRunning()
		peer.settle()
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
		peer.settle()
		peer.checkResult(nil)
	})
}

func TestAntigravityBackgroundResolvedBeforeEndTurnDoesNotHold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		peer.command("test", "in_progress", false)
		peer.usage()
		peer.exitCommand("test")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Handled before end_turn."}})
		peer.usage()
		peer.endPrompt()
		peer.checkResult(nil)
	})
}

func TestAntigravityBackgroundWaitsForToolCallAfterCommentaryUsage(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		peer.command("e2e-1", "in_progress", false)
		peer.usage()
		peer.endPrompt()
		peer.checkRunning()

		// After the first background command finishes, AGY emits commentary text,
		// then usage_update, and ~10ms later emits the non-execute tool_call.
		peer.exitCommand("e2e-1")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "E2E failed, editing test file."}})
		peer.usage()
		time.Sleep(20 * time.Millisecond)
		peer.checkRunning()

		peer.tool("edit-1", "edit", "File web/tests/git-status.spec.ts", "in_progress")
		time.Sleep(2 * time.Second)
		peer.checkRunning()
		peer.completeTool("edit-1")
		time.Sleep(30 * time.Second)
		peer.checkRunning()

		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Fixed and verified."}})
		peer.usage()
		peer.settle()
		peer.checkResult(nil)

		if last := peer.sink.items[len(peer.sink.items)-1]; last.Text != "Fixed and verified." || last.Status != "completed" {
			t.Fatalf("missing final reply after edit tool: %+v", last)
		}
	})
}

func TestAntigravityBackgroundWaitsForQueuedSystemMessageAfterWaitingReply(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var probeState atomic.Int32
		probeState.Store(int32(antigravityProbePending))
		peer := startAntigravityPromptWithProbe(t, func(context.Context) antigravityProbeState {
			return antigravityProbeState(probeState.Load())
		})

		// First background command puts Lever into background waiting mode.
		peer.command("e2e-1", "in_progress", false)
		peer.usage()
		peer.endPrompt()
		peer.checkRunning()

		// Second background command starts, then exits BEFORE the planner finishes
		// emitting its "Running E2E..." waiting message and usage_update.
		peer.exitCommand("e2e-1")
		peer.command("e2e-2", "in_progress", false)
		peer.exitCommand("e2e-2")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Running the git-status.spec.ts E2E tests on port 4798."}})
		peer.usage()

		// Settle timer fires and DB probe reports step_type=101 (SYSTEM_MESSAGE).
		// Lever must keep waiting through the next long thinking step.
		peer.settle()
		peer.checkRunning()
		time.Sleep(45 * time.Second)
		peer.checkRunning()

		// Now AGY responds to e2e-2's completion and goes idle.
		probeState.Store(int32(antigravityProbeIdle))
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "\n\nBoth E2E suites passed."}})
		peer.usage()
		peer.settle()
		peer.checkResult(nil)

		if last := peer.sink.items[len(peer.sink.items)-1]; !strings.Contains(last.Text, "Both E2E suites passed.") || last.Status != "completed" {
			t.Fatalf("missing post-wakeup reply: %+v", last)
		}
	})
}

func TestAntigravityBackgroundWaitsForApprovalAfterCommentaryUsage(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		approvalRelease := make(chan struct{})
		peer.runtime.sink = &blockingAskSink{recordingSink: peer.sink, release: approvalRelease}

		peer.command("e2e-1", "in_progress", false)
		peer.usage()
		peer.endPrompt()
		peer.checkRunning()

		peer.exitCommand("e2e-1")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Requesting permission to clean up."}})
		peer.usage()
		time.Sleep(20 * time.Millisecond)
		peer.checkRunning()

		peer.send(object{
			"id":     99,
			"method": "session/request_permission",
			"params": object{
				"sessionId": "test-session",
				"toolCall":  object{"toolCallId": "cleanup-1", "title": "Clean up files"},
				"options":   []object{{"optionId": "allow", "name": "Allow", "kind": "allow_once"}},
			},
		})
		// User takes 10 minutes to respond; run must stay active and not time out.
		time.Sleep(10 * time.Minute)
		peer.checkRunning()

		close(approvalRelease)
		var reply struct {
			ID json.RawMessage `json:"id"`
		}
		if err := json.NewDecoder(peer.peer).Decode(&reply); err != nil {
			t.Fatalf("missing permission response: %v", err)
		}
		peer.checkRunning()

		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Cleanup done."}})
		peer.usage()
		peer.settle()
		peer.checkResult(nil)
	})
}

type blockingAskSink struct {
	*recordingSink
	release <-chan struct{}
}

func (s *blockingAskSink) Ask(ctx context.Context, _ model.Request) (model.Answer, error) {
	select {
	case <-s.release:
		return model.Answer{Allow: true, OptionID: "allow"}, nil
	case <-ctx.Done():
		return model.Answer{}, ctx.Err()
	}
}

func TestAntigravityBackgroundRePollsWhileDBStillGenerating(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		peer := startAntigravityPromptWithProbe(t, func(context.Context) antigravityProbeState {
			if calls.Add(1) <= 2 {
				return antigravityProbeGenerating
			}
			return antigravityProbeIdle
		})
		peer.command("cmd-1", "in_progress", false)
		peer.usage()
		peer.endPrompt()
		peer.exitCommand("cmd-1")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Done."}})
		peer.usage()
		peer.settle()
		peer.checkRunning()
		peer.settle()
		peer.checkRunning()
		peer.settle()
		peer.checkResult(nil)
	})
}

func TestAntigravityBackgroundHoldsForSubagentAcrossEndTurn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		peer := startAntigravityPrompt(t)
		peer.tool("sub-1", "other", "Running invoke_subagent", "in_progress")
		peer.usage()
		peer.endPrompt()
		time.Sleep(5 * time.Minute)
		peer.checkRunning()

		peer.completeTool("sub-1")
		peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Subagent finished."}})
		peer.usage()
		peer.settle()
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

func TestAntigravityBackgroundCommandHoldExpiryAndScope(t *testing.T) {
	t.Run("orphaned command finishes after silence timeout and resets on activity", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			peer := startAntigravityPrompt(t)
			peer.command("hung-rg", "in_progress", false)
			peer.command("vet", "in_progress", false)
			peer.usage()
			peer.endPrompt()
			peer.checkRunning()

			// Activity after 20m resets the silence window.
			time.Sleep(20 * time.Minute)
			peer.checkRunning()
			peer.exitCommand("vet")
			peer.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Final answer."}})
			peer.usage()

			// Still held until a full quiet window elapses after the last activity.
			time.Sleep(antigravityCommandHoldTimeout - time.Minute)
			peer.checkRunning()
			time.Sleep(2 * time.Minute)
			peer.checkResult(nil)

			if last := peer.sink.items[len(peer.sink.items)-1]; last.Text != "Final answer." || last.Status != "completed" {
				t.Fatalf("final reply not completed on command-hold expiry: %+v", last)
			}
		})
	})

	t.Run("schedule and foreground tools follow outliving rules", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			// Foreground read/edit tools left in_progress before end_turn must not hold the turn.
			peer := startAntigravityPrompt(t)
			peer.tool("read-1", "read", "Running read_file", "in_progress")
			peer.usage()
			peer.endPrompt()
			peer.checkResult(nil)

			// Schedule tools outlive end_turn and are not expired by the command-hold timeout.
			sched := startAntigravityPrompt(t)
			sched.tool("timer-1", "other", "Running schedule", "in_progress")
			sched.usage()
			sched.endPrompt()
			time.Sleep(antigravityCommandHoldTimeout + time.Minute)
			sched.checkRunning()
			sched.completeTool("timer-1")
			sched.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Timer fired."}})
			sched.usage()
			sched.settle()
			sched.checkResult(nil)
		})
	})
}

func TestAntigravitySessionDBBackgroundProbe(t *testing.T) {
	geminiHome := t.TempDir()
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", "")
	t.Setenv("GEMINI_HOME", geminiHome)
	dbPath := filepath.Join(geminiHome, "antigravity-cli", "conversations", "sess-123.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER);`); err != nil {
		t.Fatal(err)
	}

	config := model.Provider{ID: "antigravity", Type: "antigravity", Command: "agy"}
	sessionDB := openAntigravitySessionDB(context.Background(), config, "sess-123")
	if sessionDB == nil || sessionDB.path != dbPath {
		t.Fatalf("unexpected session DB path: %+v, want %s", sessionDB, dbPath)
	}
	probe := sessionDB.watchBackground()
	if probe == nil {
		t.Fatal("expected background probe")
	}

	cases := []struct {
		idx, stepType, status int
		want                  antigravityProbeState
	}{
		{0, 14, 3, antigravityProbePending},    // USER_INPUT
		{1, 15, 8, antigravityProbeGenerating}, // PLANNER_RESPONSE generating
		{2, 132, 2, antigravityProbePending},   // tool running
		{3, 15, 3, antigravityProbeIdle},       // PLANNER_RESPONSE done
		{4, 101, 3, antigravityProbePending},   // SYSTEM_MESSAGE wakeup
		{5, 132, 3, antigravityProbePending},   // tool done awaiting planner
		{6, 132, 6, antigravityProbeIdle},      // canceled tool
		{7, 17, 3, antigravityProbeIdle},       // provider error (handled by outcome)
		{8, 15, 3, antigravityProbeIdle},       // final PLANNER_RESPONSE done
	}
	for _, tc := range cases {
		if _, err := db.Exec("INSERT INTO steps(idx, step_type, status) VALUES(?, ?, ?)", tc.idx, tc.stepType, tc.status); err != nil {
			t.Fatal(err)
		}
		if got := probe(context.Background()); got != tc.want {
			t.Fatalf("step (%d, type=%d, status=%d): got %v, want %v", tc.idx, tc.stepType, tc.status, got, tc.want)
		}
	}
}
