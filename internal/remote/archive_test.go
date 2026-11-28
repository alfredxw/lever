package remote

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func TestProjectRunItemsPreservesFinalTextAfterVerboseTools(t *testing.T) {
	var items []model.Item
	hugeTool := strings.Repeat("tool-output-line\n", 1500) // ~25 KB per tool item
	for i := 0; i < 60; i++ {
		items = append(items, model.Item{
			ID:    fmt.Sprintf("tool-%d", i),
			Kind:  "tool",
			Title: fmt.Sprintf("Command step %d", i),
			Text:  hugeTool,
		})
	}
	finalReply := "### 最终总结\n\n已完成方案同步、本地校验、分组提交并推送至 `origin/main`。"
	items = append(items, model.Item{
		ID:   "text-final",
		Kind: "text",
		Text: finalReply,
	})

	projected, stepCount, _ := projectRunItems(items, false, true)
	if len(projected) != len(items) || stepCount != 60 {
		t.Fatalf("expected all %d items preserved (stepCount=60), got %d (stepCount=%d)", len(items), len(projected), stepCount)
	}
	last := projected[len(projected)-1]
	if last.ID != "text-final" || last.Kind != "text" || last.Text != finalReply || last.Truncated {
		t.Fatalf("final text item not preserved intact: %+v", last)
	}

	// Verify two-stage lazy projection omits all 60 tool steps while reporting stepCount=60 and full final text.
	lazyItems, lazyStepCount, _ := projectRunItems(items, false, false)
	if len(lazyItems) != 1 || lazyStepCount != 60 || lazyItems[0].Text != finalReply {
		t.Fatalf("expected lazy projection to contain only final text + stepCount=60, got len=%d stepCount=%d", len(lazyItems), lazyStepCount)
	}
	steps := projectRunSteps(items)
	if len(steps) != 60 {
		t.Fatalf("expected projectRunSteps to return all 60 tool steps on demand, got %d", len(steps))
	}
	peerCopy := model.Run{ID: "run-peer", Items: append([]model.Item(nil), items...)}
	stripLazySteps(&peerCopy)
	if len(peerCopy.Items) != 1 || peerCopy.StepCount != 60 || peerCopy.Items[0].Text != finalReply {
		t.Fatalf("expected peer stripLazySteps to keep only prose + stepCount=60, got len=%d stepCount=%d", len(peerCopy.Items), peerCopy.StepCount)
	}
}

func TestProjectClearedPausedSessionAndAggregateDiff(t *testing.T) {
	dir := t.TempDir()
	a, err := app.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ctx := context.Background()

	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		ag := model.Agent{ID: "ag-1", Name: "Agent"}
		if _, err := tx.Exec("INSERT INTO agents(id,data) VALUES(?,?)", ag.ID, store.JSON(ag)); err != nil {
			return err
		}
		ch := model.Chat{ID: "ch-1", AgentID: ag.ID, Title: "Chat", SharedScope: &model.SharedScope{HubID: "h1", SpaceID: "s1"}}
		if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", ch.ID, ch.AgentID, store.JSON(ch)); err != nil {
			return err
		}
		sess := model.Session{ID: "sess-1", ChatID: ch.ID, AgentID: ag.ID, Kind: "topic", Title: "Paused Cleared", QueuePaused: true}
		act := model.Conversation{ID: sess.ID, ChatID: ch.ID, AgentID: ag.ID, Kind: "topic", Title: "Paused Cleared", UnreadSequence: 50, ReadSequence: 50, ClearedSequence: 50}
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data,activity) VALUES(?,?,?,?,?)", sess.ID, sess.ChatID, sess.Kind, store.JSON(sess), store.JSON(act)); err != nil {
			return err
		}
		run := model.Run{
			ID:        "run-1",
			SessionID: sess.ID,
			ChatID:    ch.ID,
			AgentID:   ag.ID,
			Status:    "paused",
			Sequence:  1,
			Input:     "do work",
			TurnDiff: &model.TurnPatch{
				Reported: true,
				Files: []model.DiffFile{
					{Path: "a.go", Additions: 100, Deletions: 20},
					{Path: "b.go", Additions: 144, Deletions: 260},
				},
			},
			Items: []model.Item{{ID: "i1", Kind: "text", Text: "partial reply"}},
		}
		if _, err := tx.Exec("INSERT INTO runs(id,session_id,chat_id,agent_id,command_id,input_hash,status,data) VALUES(?,?,?,?,?,?,?,?)",
			run.ID, run.SessionID, run.ChatID, run.AgentID, "c1", "h1", run.Status, store.JSON(run)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	m := p.Membership{Hub: p.Identity{ID: "h1"}, SpaceID: "s1"}
	tx, err := a.Store.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	sessRec, err := project(ctx, tx, m, object{kind: "session", id: "sess-1"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if sessRec.ActiveStatus != "" || sessRec.QueuePaused {
		t.Fatalf("expected cleared paused session to project idle/not-paused, got activeStatus=%q queuePaused=%v", sessRec.ActiveStatus, sessRec.QueuePaused)
	}

	runRec, err := project(ctx, tx, m, object{kind: "run", id: "run-1"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if runRec.Status != "interrupted" {
		t.Fatalf("expected paused run on cleared session to project as stopped (interrupted), got %q", runRec.Status)
	}
	if len(runRec.Files) != 0 {
		t.Fatalf("expected per-file Files list to be omitted in favor of aggregate Diff, got %d files", len(runRec.Files))
	}
	if runRec.Diff == nil || runRec.Diff.Files != 2 || runRec.Diff.Additions != 244 || runRec.Diff.Deletions != 280 {
		t.Fatalf("unexpected aggregate Diff: %+v", runRec.Diff)
	}
}

func TestMarkSessionsClearedStopsPausedRuns(t *testing.T) {
	dir := t.TempDir()
	a, err := app.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	ctx := context.Background()

	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		ag := model.Agent{ID: "ag-1", Name: "Agent"}
		if _, err := tx.Exec("INSERT INTO agents(id,data) VALUES(?,?)", ag.ID, store.JSON(ag)); err != nil {
			return err
		}
		ch := model.Chat{ID: "ch-1", AgentID: ag.ID, Title: "Chat"}
		if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", ch.ID, ch.AgentID, store.JSON(ch)); err != nil {
			return err
		}
		sess := model.Session{ID: "sess-p", ChatID: ch.ID, AgentID: ag.ID, Kind: "topic", Title: "Paused", QueuePaused: true}
		act := model.Conversation{ID: sess.ID, ChatID: ch.ID, AgentID: ag.ID, Kind: "topic", Title: "Paused", UnreadSequence: 10, ReadSequence: 10}
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data,activity) VALUES(?,?,?,?,?)", sess.ID, sess.ChatID, sess.Kind, store.JSON(sess), store.JSON(act)); err != nil {
			return err
		}
		run := model.Run{ID: "run-p", SessionID: sess.ID, ChatID: ch.ID, AgentID: ag.ID, Status: "paused", Sequence: 1, Input: "work"}
		if _, err := tx.Exec("INSERT INTO runs(id,session_id,chat_id,agent_id,command_id,input_hash,status,data) VALUES(?,?,?,?,?,?,?,?)",
			run.ID, run.SessionID, run.ChatID, run.AgentID, "c1", "h1", run.Status, store.JSON(run)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := a.MarkSessionsCleared(ctx, []model.ClearMark{{SessionID: "sess-p", Sequence: 10}}); err != nil {
		t.Fatal(err)
	}

	run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id='run-p'")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "interrupted" {
		t.Fatalf("expected paused run to be marked interrupted on clear, got %q", run.Status)
	}
	sess, err := store.Get[model.Session](ctx, a.Store.DB, "SELECT data FROM sessions WHERE id='sess-p'")
	if err != nil {
		t.Fatal(err)
	}
	if sess.QueuePaused {
		t.Fatalf("expected queuePaused to be cleared when clearing idle session")
	}
}
