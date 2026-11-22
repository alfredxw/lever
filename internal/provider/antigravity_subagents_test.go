package provider

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/segmentio/encoding/proto"
)

// A small parent trajectory using the wire fields written by agy 1.5.12.
// The launch receipt, the message delivered to the planner, and the planner
// response are independent steps.
type antigravityChildFixture struct {
	*testing.T
	store *antigravitySessionDB
	db    *sql.DB
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

func (f *antigravityChildFixture) step(idx, kind int, metadata, payload []byte) {
	f.Helper()
	if _, err := f.db.Exec("INSERT INTO steps VALUES(?,?,3,?,?)", idx, kind, metadata, payload); err != nil {
		f.Fatal(err)
	}
}

func (f *antigravityChildFixture) declare(idx int, call, child, state string) {
	f.Helper()
	record := antigravityChildRecord{ConversationID: child, SpawnStepIndex: &idx, State: state}
	directory := filepath.Join(f.store.dataDir, "brain", "test-session", ".system_generated", "subagents")
	if err := os.MkdirAll(directory, 0700); err != nil {
		f.Fatal(err)
	}
	raw, err := json.Marshal(record)
	if err != nil {
		f.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, child+".json"), raw, 0600); err != nil {
		f.Fatal(err)
	}
	tool := proto.AppendVarlen(nil, 1, []byte(call))
	tool = proto.AppendVarlen(tool, 2, []byte("invoke_subagent"))
	f.step(idx, 132, proto.AppendVarlen(nil, 4, tool), nil)
}

func (f *antigravityChildFixture) report(idx int, sender, recipient, text string) {
	f.Helper()
	message := proto.AppendVarlen(nil, 2, []byte(recipient))
	message = proto.AppendVarlen(message, 3, []byte(sender))
	message = proto.AppendVarlen(message, 4, []byte(text))
	f.step(idx, 101, nil, proto.AppendVarlen(nil, 114, proto.AppendVarlen(nil, 4, message)))
}

func (f *antigravityChildFixture) reply(idx int, text string) {
	f.Helper()
	f.step(idx, 15, nil, proto.AppendVarlen(nil, 20, proto.AppendVarlen(nil, 1, []byte(text))))
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
		f.reply(3, "Waiting for research.")
		p.message("Waiting for research.")
		p.endPrompt()
		time.Sleep(antigravityReplyTimeout + time.Second)
		p.checkRunning()
		child := p.sink.byID["subagent:launch"]
		if child.Status != "running" || child.Subagent.FinishedAt != "" {
			t.Fatalf("launch acknowledgement finished the child: %+v", child)
		}

		// Neither a message merely mentioning our child nor one addressed to a
		// different parent can finish it.
		f.report(4, "someone-else", "test-session", "researcher")
		f.report(5, "researcher", "different-parent", "not our report")
		f.reply(6, "Still waiting.")
		p.message("Still waiting.")
		p.settle()
		p.checkRunning()
		if child := p.sink.byID["subagent:launch"]; child.Subagent.Progress != "" {
			t.Fatalf("unrelated message attributed to child: %+v", child)
		}

		f.report(7, "researcher", "test-session", "Research result.")
		p.settle()
		p.checkRunning()
		// A planner step with a tool call can carry visible commentary too.
		planner := proto.AppendVarlen(nil, 1, []byte("Checking one detail."))
		planner = proto.AppendVarlen(planner, 7, proto.AppendVarlen(nil, 1, []byte("follow-up")))
		f.step(8, 15, nil, proto.AppendVarlen(nil, 20, planner))
		p.message("Checking one detail.")
		p.settle()
		p.checkRunning()
		send := proto.AppendVarlen(nil, 2, []byte("send_message"))
		send = proto.AppendVarlen(send, 3, []byte(`{"Recipient":"researcher"}`))
		f.step(9, 132, proto.AppendVarlen(nil, 4, send), nil)
		f.reply(10, "Waiting for the extra detail.")
		p.message("Waiting for the extra detail.")
		p.settle()
		p.checkRunning()
		f.report(11, "researcher", "test-session", "Revised research result.")
		// The native database can commit the final answer before its ACP chunk
		// arrives. The user must get the answer in this same prompt.
		f.reply(12, "Final synthesis.")
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
		f.reply(7, "Both findings.")
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

func TestAntigravityDetachedSubagentUnconfirmed(t *testing.T) {
	for _, tc := range []struct {
		name string
		end  func(*antigravityPromptPeer)
		want error
	}{
		{"stop", func(p *antigravityPromptPeer) { p.stop() }, context.Canceled},
		{"disconnect", func(p *antigravityPromptPeer) { _ = p.peer.Close() }, ErrUnconfirmed},
		{"missing native evidence", func(p *antigravityPromptPeer) { time.Sleep(antigravityReplyTimeout + 2*time.Second) }, ErrUnconfirmed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p := startAntigravityPrompt(t)
				p.runtime.background.childProbe = (*antigravitySessionDB)(nil).watchSubagents("test-session")
				p.tool("async", "other", "Run invoke_subagent", "in_progress")
				p.completeTool("async")
				p.endPrompt()
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
		f.reply(4, "Waiting for B.")
		p.message("Waiting for B.")
		p.endPrompt()
		time.Sleep(antigravityReplyTimeout + 2*time.Second)
		p.checkRunning()
		f.report(5, "child-b", "test-session", "B")
		f.reply(6, "A and B.")
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
