package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// A small parent fixture using the inbox and subagent records written by agy 1.5.12+.
type antigravityChildFixture struct {
	*testing.T
	store *antigravitySessionDB
	db    *sql.DB
	seq   int
}

func newAntigravityChildFixture(t *testing.T) *antigravityChildFixture {
	t.Helper()
	root := t.TempDir()
	store := &antigravitySessionDB{profile: root, dataDir: root, path: filepath.Join(root, "conversations", "test-session.db")}
	if err := os.MkdirAll(filepath.Dir(store.path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", store.path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)"); err != nil {
		t.Fatal(err)
	}
	return &antigravityChildFixture{T: t, db: db, store: store}
}

func (f *antigravityChildFixture) nextTimestamp() string {
	f.seq++
	return time.Date(2026, 11, 23, 5, 0, f.seq, 0, time.UTC).Format(time.RFC3339Nano)
}

func (f *antigravityChildFixture) writeJSON(path string, value any) {
	f.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		f.Fatal(err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		f.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		f.Fatal(err)
	}
}

func (f *antigravityChildFixture) step(idx, kind int, metadata, payload []byte) {
	f.Helper()
	if _, err := f.db.Exec("INSERT OR REPLACE INTO steps VALUES(?,?,3,?,?)", idx, kind, metadata, payload); err != nil {
		f.Fatal(err)
	}
}

func (f *antigravityChildFixture) declare(idx int, call, child, state string) {
	f.Helper()
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", "test-session", ".system_generated", "subagents", child+".json"),
		antigravityChildRecord{ConversationID: child, State: state},
	)
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", child, ".system_generated", "messages", fmt.Sprintf("%03d-launch.json", idx)),
		object{
			"sender":    "test-session",
			"recipient": child,
			"timestamp": f.nextTimestamp(),
			"content":   "Investigate",
			"sourceMetadata": object{
				"tool": object{
					"conversationId": "test-session",
					"stepIndex":      idx,
					"toolCall": object{
						"id":   call,
						"name": "invoke_subagent",
					},
				},
			},
		},
	)
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", child, ".system_generated", "messages", "read.json"),
		object{"launch": true},
	)
}

func (f *antigravityChildFixture) kill(child string) {
	f.Helper()
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", "test-session", ".system_generated", "subagents", child+".json"),
		antigravityChildRecord{ConversationID: child, State: "SUBAGENT_STATE_KILLED"},
	)
}

func (f *antigravityChildFixture) sendMessage(idx int, child, text string) {
	f.Helper()
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", child, ".system_generated", "messages", fmt.Sprintf("%03d-followup.json", idx)),
		object{
			"sender":    "test-session",
			"recipient": child,
			"timestamp": f.nextTimestamp(),
			"content":   text,
			"sourceMetadata": object{
				"tool": object{
					"conversationId": "test-session",
					"toolCall": object{
						"id":   fmt.Sprintf("msg-%d", idx),
						"name": "send_message",
					},
				},
			},
		},
	)
}

func (f *antigravityChildFixture) report(idx int, sender, recipient, text string) {
	f.Helper()
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", "test-session", ".system_generated", "messages", fmt.Sprintf("%03d-report.json", idx)),
		object{
			"sender":    sender,
			"recipient": recipient,
			"timestamp": f.nextTimestamp(),
			"content":   text,
		},
	)
}

func (f *antigravityChildFixture) reply(idx int, _ string) {
	f.Helper()
	f.step(idx, 15, nil, nil)
}

func (p *antigravityPromptPeer) message(text string) {
	p.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": text}})
	p.usage()
}

func TestAntigravityDetachedSubagentContinuesOriginalPrompt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newAntigravityChildFixture(t)
		p := startAntigravityPrompt(t)
		p.runtime.background.childProbe = f.store.watchSubagents("test-session")
		f.declare(2, "launch", "researcher", "SUBAGENT_STATE_ALIVE")
		p.tool("launch", "other", "Run invoke_subagent", "in_progress")
		p.completeTool("launch")
		p.message("Waiting for research.")
		p.endPrompt()
		time.Sleep(antigravityReplyTimeout + time.Second)
		p.checkRunning()
		child := p.sink.byID["subagent:launch"]
		if child.Status != "running" || child.Subagent.FinishedAt != "" {
			t.Fatalf("launch acknowledgement finished the child: %+v", child)
		}

		// Neither a message from someone else nor one addressed to a different
		// parent can finish this child.
		f.report(4, "someone-else", "test-session", "researcher")
		f.report(5, "researcher", "different-parent", "not our report")
		p.message("Still waiting.")
		p.settle()
		p.checkRunning()
		if child := p.sink.byID["subagent:launch"]; child.Status != "running" || child.Subagent.Progress != "" {
			t.Fatalf("unrelated message attributed to child: %+v", child)
		}

		// First report arrives; parent receives it and stays active waiting for
		// its synthesis (or follow-up send_message).
		f.report(7, "researcher", "test-session", "Research result.")
		p.settle()
		p.checkRunning()

		// Parent emits commentary, then calls send_message to ask the child
		// for more detail, which reactivates the child.
		p.message("Checking one detail.")
		time.Sleep(20 * time.Millisecond)
		p.tool("msg-9", "other", "Running send_message", "in_progress")
		f.sendMessage(9, "researcher", "Check one more file.")
		p.completeTool("msg-9")
		p.message("Waiting for the extra detail.")
		p.settle()
		p.checkRunning()
		if child := p.sink.byID["subagent:launch"]; child.Status != "running" {
			t.Fatalf("follow-up send_message did not reactivate child: %+v", child)
		}

		// Revised report arrives, then parent streams final synthesis.
		f.report(11, "researcher", "test-session", "Revised research result.")
		p.settle()
		p.checkRunning()
		p.message("\n\nFinal synthesis.")
		p.settle()
		p.checkResult(nil)
		child = p.sink.byID["subagent:launch"]
		if child.Status != "completed" || child.Text != "Revised research result." || child.Subagent.FinishedAt == "" {
			t.Fatalf("missing child report: %+v", child)
		}
		last := p.sink.items[len(p.sink.items)-1]
		if last.Status != "completed" || !strings.HasSuffix(last.Text, "Final synthesis.") {
			t.Fatalf("missing parent synthesis: %+v", last)
		}
	})
}

func TestAntigravityDetachedSubagentsAlreadyReportedAtEndTurn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newAntigravityChildFixture(t)
		p := startAntigravityPrompt(t)
		p.runtime.background.childProbe = f.store.watchSubagents("test-session")
		for i, id := range []string{"first", "second", "killed"} {
			state := "SUBAGENT_STATE_ALIVE"
			if id == "killed" {
				state = "SUBAGENT_STATE_KILLED"
			}
			f.declare(i+1, id, "child-"+id, state)
			p.tool(id, "other", "Run invoke_subagent", "in_progress")
			p.completeTool(id)
		}
		f.report(5, "child-second", "test-session", "second report")
		f.report(6, "child-first", "test-session", "first report")
		p.message("Both findings.")
		p.endPrompt()
		p.settle()
		p.checkResult(nil)
		for _, id := range []string{"first", "second"} {
			if child := p.sink.byID["subagent:"+id]; child.Status != "completed" || child.Text != id+" report" {
				t.Fatalf("incorrect child result: %+v", child)
			}
		}
		if p.sink.byID["subagent:killed"].Status != "interrupted" {
			t.Fatal("killed child should be interrupted")
		}
	})
}

func TestAntigravityDetachedSubagentParallelLongSynthesisNeverAsksManualConfirm(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var probeState atomic.Int32
		probeState.Store(int32(antigravityProbePending))
		f := newAntigravityChildFixture(t)
		p := startAntigravityPromptWithProbe(t, func(context.Context) antigravityProbeState {
			return antigravityProbeState(probeState.Load())
		})
		p.runtime.background.childProbe = f.store.watchSubagents("test-session")

		analysts := []string{"provider", "core-model", "app-core", "backend", "frontend", "docs"}
		for i, name := range analysts {
			f.declare(i+1, "call-"+name, "child-"+name, "SUBAGENT_STATE_ALIVE")
			p.tool("call-"+name, "other", "Run invoke_subagent", "in_progress")
			p.completeTool("call-" + name)
		}
		p.message("Launched 6 analysts.")
		p.endPrompt()
		p.settle()
		p.checkRunning()

		// First 5 analysts report while the 6th is still running.
		for i, name := range analysts[:5] {
			f.report(10+i, "child-"+name, "test-session", name+" findings")
		}
		p.settle()
		p.checkRunning()
		for _, name := range analysts[:5] {
			if c := p.sink.byID["subagent:call-"+name]; c.Status != "completed" || c.Text != name+" findings" {
				t.Fatalf("reported analyst %s did not finish cleanly: %+v", name, c)
			}
		}
		if c := p.sink.byID["subagent:call-docs"]; c.Status != "running" {
			t.Fatalf("still-running analyst finished early: %+v", c)
		}

		// Last analyst reports; parent then thinks and streams for >6 minutes
		// (exceeding antigravityReplyTimeout) and runs a tool before finishing.
		f.report(20, "child-docs", "test-session", "docs findings")
		p.settle()
		p.checkRunning()
		for range 12 {
			time.Sleep(35 * time.Second)
			p.update(object{"sessionUpdate": "agent_thought_chunk", "content": object{"type": "text", "text": "Synthesizing..."}})
			p.checkRunning()
		}
		p.update(object{"sessionUpdate": "agent_message_chunk", "content": object{"type": "text", "text": "Combined analysis across all 6 areas."}})
		p.tool("read-1", "read", "Running read_file", "in_progress")
		p.completeTool("read-1")
		// Parent finishes cleanly without extra trailing text; DB goes idle.
		probeState.Store(int32(antigravityProbeIdle))
		time.Sleep(antigravityChildIdleGrace + 2*antigravitySettleTimeout)
		p.checkResult(nil)
		for _, name := range analysts {
			if c := p.sink.byID["subagent:call-"+name]; c.Status != "completed" || c.Text != name+" findings" {
				t.Fatalf("analyst %s missing final state: %+v", name, c)
			}
		}
	})
}

func TestAntigravityDetachedSubagentFailOpenAndLifecycle(t *testing.T) {
	t.Run("missing native evidence fails open", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			p := startAntigravityPrompt(t)
			p.runtime.background.childProbe = (*antigravitySessionDB)(nil).watchSubagents("test-session")
			p.tool("async", "other", "Run invoke_subagent", "in_progress")
			p.completeTool("async")
			p.endPrompt()
			p.settle()
			p.checkResult(nil)
			if child := p.sink.byID["subagent:async"]; child.Status != "completed" {
				t.Fatalf("unproven subagent should fail open as completed, got %+v", child)
			}
		})
	})

	t.Run("killed mid-wait settles without waiting for parent reply", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			f := newAntigravityChildFixture(t)
			p := startAntigravityPrompt(t)
			p.runtime.background.childProbe = f.store.watchSubagents("test-session")
			f.declare(1, "launch", "child-1", "SUBAGENT_STATE_ALIVE")
			p.tool("launch", "other", "Run invoke_subagent", "in_progress")
			p.completeTool("launch")
			p.message("Waiting.")
			p.endPrompt()
			p.settle()
			p.checkRunning()

			f.kill("child-1")
			p.settle()
			p.checkResult(nil)
			if child := p.sink.byID["subagent:launch"]; child.Status != "interrupted" {
				t.Fatalf("killed child should be interrupted, got %+v", child)
			}
		})
	})

	t.Run("silent parent after report completes cleanly", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			f := newAntigravityChildFixture(t)
			p := startAntigravityPrompt(t)
			p.runtime.background.childProbe = f.store.watchSubagents("test-session")
			f.declare(1, "launch", "child-1", "SUBAGENT_STATE_ALIVE")
			p.tool("launch", "other", "Run invoke_subagent", "in_progress")
			p.completeTool("launch")
			p.endPrompt()
			p.settle()
			p.checkRunning()

			f.report(2, "child-1", "test-session", "Done quietly.")
			time.Sleep(antigravityChildReplyTimeout + 2*antigravitySettleTimeout)
			p.checkResult(nil)
			if child := p.sink.byID["subagent:launch"]; child.Status != "completed" || child.Text != "Done quietly." {
				t.Fatalf("unexpected child state: %+v", child)
			}
		})
	})

	for _, tc := range []struct {
		name string
		end  func(*antigravityPromptPeer)
		want error
	}{
		{"stop", func(p *antigravityPromptPeer) { p.stop() }, context.Canceled},
		{"disconnect", func(p *antigravityPromptPeer) { _ = p.peer.Close() }, ErrUnconfirmed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newAntigravityChildFixture(t)
				p := startAntigravityPrompt(t)
				p.runtime.background.childProbe = f.store.watchSubagents("test-session")
				f.declare(1, "async", "child-async", "SUBAGENT_STATE_ALIVE")
				p.tool("async", "other", "Run invoke_subagent", "in_progress")
				p.completeTool("async")
				p.endPrompt()
				p.settle()
				p.checkRunning()
				tc.end(p)
				p.checkResult(tc.want)
			})
		})
	}
}

func TestAntigravityDetachedBatchWaitsForAllReports(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newAntigravityChildFixture(t)
		p := startAntigravityPrompt(t)
		p.runtime.background.childProbe = f.store.watchSubagents("test-session")
		f.declare(1, "batch", "child-a", "SUBAGENT_STATE_ALIVE")
		f.declare(2, "batch", "child-b", "SUBAGENT_STATE_ALIVE")
		p.update(object{"sessionUpdate": "tool_call", "toolCallId": "batch", "kind": "other", "title": "Running invoke_subagent", "status": "in_progress",
			"rawInput": object{"Subagents": []object{{"Role": "A"}, {"Role": "B"}}}})
		p.completeTool("batch")
		f.report(3, "child-a", "test-session", "A")
		p.message("Waiting for B.")
		p.endPrompt()
		time.Sleep(antigravityReplyTimeout + 2*time.Second)
		p.checkRunning()
		f.report(5, "child-b", "test-session", "B")
		p.message("A and B.")
		p.settle()
		p.checkResult(nil)
		if c := p.sink.byID["subagent:batch"]; c.Text != "A\n\nB" || c.Status != "completed" {
			t.Fatalf("batch finished without both results: %+v", c)
		}
	})
}

func TestAntigravityDetachedSubagentProviderFailure(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newAntigravityChildFixture(t)
		p := startAntigravityPrompt(t)
		p.runtime.background.childProbe = f.store.watchSubagents("test-session")
		f.declare(1, "launch", "researcher", "SUBAGENT_STATE_ALIVE")
		p.tool("launch", "other", "Run invoke_subagent", "in_progress")
		p.completeTool("launch")
		f.step(2, 17, nil, nil)
		p.endPrompt()
		p.settle()
		p.checkResult(errAntigravityProvider)
	})
}

func TestAntigravityDetachedSubagentRejectsSymlinkedInbox(t *testing.T) {
	f := newAntigravityChildFixture(t)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.json")
	f.writeJSON(secret, object{
		"sender":    "test-session",
		"recipient": "child-1",
		"sourceMetadata": object{
			"tool": object{"toolCall": object{"id": "launch", "name": "invoke_subagent"}},
		},
	})
	f.writeJSON(
		filepath.Join(f.store.dataDir, "brain", "test-session", ".system_generated", "subagents", "child-1.json"),
		antigravityChildRecord{ConversationID: "child-1", State: "SUBAGENT_STATE_ALIVE"},
	)
	inboxDir := filepath.Join(f.store.dataDir, "brain", "child-1", ".system_generated", "messages")
	if err := os.MkdirAll(inboxDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(inboxDir, "launch.json")); err != nil {
		t.Fatal(err)
	}
	probe := f.store.watchSubagents("test-session")
	outcomes, err := probe(context.Background(), map[string]int{"launch": 1})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(outcomes) != 0 {
		t.Fatalf("symlinked inbox file should be ignored, got %+v", outcomes)
	}
}
