package httpapi_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
	"lever/internal/model"
)

func (f *fixture) answerRunApproval(runID string, allow bool) {
	f.t.Helper()
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	for _, req := range overview.Requests {
		if req.RunID == runID && req.Status == "pending" {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: allow}, 200, nil)
			return
		}
	}
	f.t.Fatalf("no pending approval for run %s", runID)
}

func TestRunDependenciesWaitForAllParallelTasksToSucceed(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)

	taskA := f.send(chat.ID, "topic", "", "Task A [approval]")
	taskB := f.send(chat.ID, "topic", "", "Task B [approval]")
	f.wait(taskA.ID, "waiting_user")
	f.wait(taskB.ID, "waiting_user")

	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	expectedRoot := agent.Profile.Roots[0].Path
	for _, id := range []string{taskA.ID, taskB.ID} {
		idx := slices.IndexFunc(overview.Runs, func(r model.Run) bool { return r.ID == id })
		if idx < 0 || !slices.Contains(overview.Runs[idx].ScopePaths, expectedRoot) {
			t.Fatalf("expected run %s to project scopePaths containing %s, got %+v", id, expectedRoot, overview.Runs)
		}
	}

	var follow model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "commit and push",
		AfterRunIDs: []string{taskA.ID, taskB.ID, taskA.ID},
	}, 200, &follow)

	if follow.Status != "queued" {
		t.Fatalf("expected queued waiting run, got %s", follow.Status)
	}
	if len(follow.AfterRunIDs) != 2 || follow.AfterRunIDs[0] != taskA.ID || follow.AfterRunIDs[1] != taskB.ID {
		t.Fatalf("expected deduplicated afterRunIds, got %+v", follow.AfterRunIDs)
	}
	if len(follow.WaitingOn) != 2 || follow.WaitingOn[0].Status != "waiting_user" || follow.WaitingOn[1].Status != "waiting_user" {
		t.Fatalf("expected live waitingOn projection, got %+v", follow.WaitingOn)
	}

	// Verify ChatPage and SessionView also include the waiting topic root with WaitingOn.
	var view model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
	idx := slices.IndexFunc(view.Runs, func(r model.Run) bool { return r.ID == follow.ID })
	if idx < 0 || len(view.Runs[idx].WaitingOn) != 2 {
		t.Fatalf("expected ChatView to include waitingOn, got %+v", view.Runs)
	}
	var sessionView model.SessionView
	f.request("GET", "/sessions/"+follow.SessionID, nil, 200, &sessionView)
	if sessionView.Root == nil || len(sessionView.Root.WaitingOn) != 2 {
		t.Fatalf("expected SessionView.Root to include waitingOn, got %+v", sessionView.Root)
	}

	// Complete Task A only; follow must remain queued and project Task A as completed.
	f.answerRunApproval(taskA.ID, true)
	f.wait(taskA.ID, "completed")
	time.Sleep(120 * time.Millisecond)

	var afterA model.Run
	f.request("GET", "/runs/"+follow.ID, nil, 200, &afterA)
	if afterA.Status != "queued" {
		t.Fatalf("downstream run launched before all dependencies finished: %s", afterA.Status)
	}
	if len(afterA.WaitingOn) != 2 || afterA.WaitingOn[0].Status != "completed" || afterA.WaitingOn[1].Status != "waiting_user" {
		t.Fatalf("unexpected waitingOn after Task A completed: %+v", afterA.WaitingOn)
	}

	// Complete Task B; follow must now automatically run and complete.
	f.answerRunApproval(taskB.ID, true)
	f.wait(taskB.ID, "completed")
	completed := f.wait(follow.ID, "completed")
	if len(completed.AfterRunIDs) != 2 {
		t.Fatalf("expected afterRunIds preserved after completion, got %+v", completed.AfterRunIDs)
	}
}

func TestRunDependenciesFailClosedEditAndRunNow(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)

	taskA := f.send(chat.ID, "topic", "", "Task A [approval]")
	taskB := f.send(chat.ID, "topic", "", "Task B [approval]")
	f.wait(taskA.ID, "waiting_user")
	f.wait(taskB.ID, "waiting_user")

	var follow model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "commit and push",
		AfterRunIDs: []string{taskA.ID, taskB.ID},
	}, 200, &follow)

	// Stop Task A -> interrupted. Complete Task B -> completed.
	f.request("POST", "/runs/"+taskA.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(taskA.ID, "interrupted")
	f.answerRunApproval(taskB.ID, true)
	f.wait(taskB.ID, "completed")
	time.Sleep(150 * time.Millisecond)

	// Follow must stay queued (fail-closed) and project Task A as interrupted.
	var blocked model.Run
	f.request("GET", "/runs/"+follow.ID, nil, 200, &blocked)
	if blocked.Status != "queued" {
		t.Fatalf("downstream run must not launch after upstream stopped: %s", blocked.Status)
	}
	if len(blocked.WaitingOn) != 2 || blocked.WaitingOn[0].Status != "interrupted" || blocked.WaitingOn[1].Status != "completed" {
		t.Fatalf("unexpected waitingOn on blocked run: %+v", blocked.WaitingOn)
	}

	// Submitting a new run waiting on a failed/interrupted run is rejected with 409.
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "should fail validation",
		AfterRunIDs: []string{taskA.ID},
	}, 409, nil)

	// Combining afterRunIds with steer is rejected with 400.
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Delivery:    "steer",
		Text:        "invalid steer",
		AfterRunIDs: []string{taskB.ID},
	}, 400, nil)

	// Self-dependency while editing is rejected with 400.
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		EditRunID:   follow.ID,
		Text:        "self cycle",
		AfterRunIDs: []string{follow.ID},
	}, 400, nil)

	// Editing out the failed dependency so only completed Task B remains launches it!
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		EditRunID:   follow.ID,
		Text:        "commit after task B",
		AfterRunIDs: []string{taskB.ID},
	}, 200, nil)
	f.wait(follow.ID, "completed")

	// Test action: "run_now" on another waiting run.
	taskC := f.send(chat.ID, "topic", "", "Task C [approval]")
	f.wait(taskC.ID, "waiting_user")
	var immediate model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "run immediately",
		AfterRunIDs: []string{taskC.ID},
	}, 200, &immediate)
	if immediate.Status != "queued" {
		t.Fatalf("expected queued, got %s", immediate.Status)
	}
	f.request("POST", "/runs/"+immediate.ID+"/queue", map[string]string{"action": "run_now"}, 200, nil)
	doneImmediate := f.wait(immediate.ID, "completed")
	if len(doneImmediate.AfterRunIDs) != 0 {
		t.Fatalf("expected run_now to clear afterRunIds, got %+v", doneImmediate.AfterRunIDs)
	}

	// Clean up taskC.
	f.answerRunApproval(taskC.ID, true)
	f.wait(taskC.ID, "completed")
}

func TestRunDependenciesRejectPausedAndTreatMidwayPauseAsBlocked(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)

	pausable := f.send(chat.ID, "topic", "", "[pausable] midway task")
	for deadline := time.Now().Add(8 * time.Second); ; time.Sleep(15 * time.Millisecond) {
		f.request("GET", "/runs/"+pausable.ID, nil, 200, &pausable)
		if pausable.CanPause {
			break
		}
		if time.Now().After(deadline) || !model.Active(pausable.Status) {
			t.Fatalf("run did not become pausable: %s: %s", pausable.Status, pausable.Error)
		}
	}

	var follow model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		SessionID:   pausable.SessionID,
		Operation:   "reply",
		Delivery:    "queue",
		Text:        "commit after pausable",
		AfterRunIDs: []string{pausable.ID},
	}, 200, &follow)
	if follow.Status != "queued" {
		t.Fatalf("expected queued, got %s", follow.Status)
	}

	// Pause the upstream task mid-way -> downstream stays queued and projects paused.
	f.request("POST", "/runs/"+pausable.ID+"/pause", map[string]bool{}, 200, nil)
	paused := f.wait(pausable.ID, "paused")
	time.Sleep(120 * time.Millisecond)

	var afterPause model.Run
	f.request("GET", "/runs/"+follow.ID, nil, 200, &afterPause)
	if afterPause.Status != "queued" {
		t.Fatalf("downstream must not run while upstream is paused: %s", afterPause.Status)
	}
	if len(afterPause.WaitingOn) != 1 || afterPause.WaitingOn[0].Status != "paused" {
		t.Fatalf("expected waitingOn to reflect paused status, got %+v", afterPause.WaitingOn)
	}

	// Paused runs cannot be selected as new dependencies.
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "cannot wait on paused",
		AfterRunIDs: []string{pausable.ID},
	}, 409, nil)

	f.request("POST", "/runs/"+pausable.ID+"/resume", map[string]string{"nativeTurnId": *paused.NativeTurnID}, 200, nil)
	f.wait(pausable.ID, "completed")
	f.wait(follow.ID, "completed")
}

func TestRunDependenciesSurviveServerRestartWithLiveHost(t *testing.T) {
	f := openFixture(t, app.OpenServer).withLocalProviders()
	agent := f.agent("codex")
	chat := f.chat(agent)

	taskA := f.send(chat.ID, "topic", "", "Task A [approval]")
	f.wait(taskA.ID, "waiting_user")

	var follow model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "commit after restart",
		AfterRunIDs: []string{taskA.ID},
	}, 200, &follow)
	if follow.Status != "queued" {
		t.Fatalf("expected queued, got %s", follow.Status)
	}

	// Simulate backend restart while Task A is hosted in its independent worker.
	dir, root := f.a.Store.Dir, f.root
	_ = f.s.Close(context.Background())
	_ = f.a.Close()

	a2, err := app.OpenServer(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a2.Close() })
	s2, err := httpapi.New(a2, "127.0.0.1:0", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	go s2.Serve()
	t.Cleanup(func() { _ = s2.Close(context.Background()) })
	reopened := &fixture{t: t, a: a2, s: s2, root: root}

	reopened.answerRunApproval(taskA.ID, true)
	reopened.wait(taskA.ID, "completed")
	reopened.wait(follow.ID, "completed")
}

func TestRunDependenciesChainOnWaitingTaskAndSidebarActivity(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)

	taskA := f.send(chat.ID, "topic", "", "Task A [approval]")
	f.wait(taskA.ID, "waiting_user")

	var waitW model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "Run tests after A [approval]",
		AfterRunIDs: []string{taskA.ID},
	}, 200, &waitW)
	if waitW.Status != "queued" {
		t.Fatalf("expected waitW queued, got %s", waitW.Status)
	}

	// Waiting on another waiting task is allowed and chains execution.
	var waitC model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "Commit after tests",
		AfterRunIDs: []string{waitW.ID},
	}, 200, &waitC)
	if waitC.Status != "queued" || len(waitC.WaitingOn) != 1 || waitC.WaitingOn[0].Blocked {
		t.Fatalf("unexpected waitC initial state: %+v", waitC)
	}

	// Brand-new waiting Topics must immediately appear in Overview.Conversations without marking unread.
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	for _, want := range []struct {
		sessionID string
		title     string
	}{
		{waitW.SessionID, "Run tests after A [approval]"},
		{waitC.SessionID, "Commit after tests"},
	} {
		idx := slices.IndexFunc(overview.Conversations, func(c model.Conversation) bool { return c.ID == want.sessionID })
		if idx < 0 {
			t.Fatalf("expected waiting session %s in overview.conversations, got %+v", want.sessionID, overview.Conversations)
		}
		conv := overview.Conversations[idx]
		if conv.Title != want.title || conv.UnreadSequence != 0 {
			t.Fatalf("unexpected waiting conversation projection: %+v", conv)
		}
	}

	// Complete A -> W starts and awaits approval, while C remains queued.
	f.answerRunApproval(taskA.ID, true)
	f.wait(taskA.ID, "completed")
	f.wait(waitW.ID, "waiting_user")
	var midC model.Run
	f.request("GET", "/runs/"+waitC.ID, nil, 200, &midC)
	if midC.Status != "queued" || len(midC.WaitingOn) != 1 || midC.WaitingOn[0].Status != "waiting_user" || midC.WaitingOn[0].Blocked {
		t.Fatalf("unexpected midC while waitW is running: %+v", midC)
	}

	// Complete W -> C automatically launches and completes.
	f.answerRunApproval(waitW.ID, true)
	f.wait(waitW.ID, "completed")
	f.wait(waitC.ID, "completed")

	// Transitive block propagation: A2 -> W2 -> C2, stop A2.
	taskA2 := f.send(chat.ID, "topic", "", "Task A2 [approval]")
	f.wait(taskA2.ID, "waiting_user")
	var waitW2 model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "Wait W2",
		AfterRunIDs: []string{taskA2.ID},
	}, 200, &waitW2)
	var waitC2 model.Run
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "Wait C2",
		AfterRunIDs: []string{waitW2.ID},
	}, 200, &waitC2)

	var beforeStop int64
	f.request("GET", "/overview", nil, 200, &overview)
	beforeStop = overview.Cursor

	f.request("POST", "/runs/"+taskA2.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(taskA2.ID, "interrupted")

	var blockedC2 model.Run
	f.request("GET", "/runs/"+waitC2.ID, nil, 200, &blockedC2)
	if blockedC2.Status != "queued" || len(blockedC2.WaitingOn) != 1 || !blockedC2.WaitingOn[0].Blocked {
		t.Fatalf("expected waitC2 transitively blocked after A2 stopped, got %+v", blockedC2)
	}

	// Verify SSE replay emitted an update event for transitive dependent waitC2.
	events, err := f.a.Store.Events(context.Background(), beforeStop)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(events, func(e model.Event) bool { return e.Run != nil && e.Run.ID == waitC2.ID }) {
		t.Fatalf("expected transitive dependent event for %s after %s stopped", waitC2.ID, taskA2.ID)
	}

	// Submitting a new run waiting on blocked W2 is rejected with 409.
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		Operation:   "topic",
		Text:        "Wait on blocked W2",
		AfterRunIDs: []string{waitW2.ID},
	}, 409, nil)

	// Editing an unstarted waiting Topic updates its activity title.
	f.request("POST", "/messages", model.SendInput{
		CommandID:   app.ID(),
		ChatID:      chat.ID,
		SessionID:   waitW2.SessionID,
		Operation:   "reply",
		EditRunID:   waitW2.ID,
		Text:        "Renamed Wait W2",
		AfterRunIDs: []string{taskA2.ID},
	}, 409, nil) // still blocked on taskA2!

	// Cancelling unstarted waiting Topic C2 removes it from Overview.Conversations.
	f.request("POST", "/runs/"+waitC2.ID+"/queue", map[string]string{"action": "remove"}, 200, nil)
	f.request("GET", "/overview", nil, 200, &overview)
	if slices.ContainsFunc(overview.Conversations, func(c model.Conversation) bool { return c.ID == waitC2.SessionID }) {
		t.Fatalf("expected cancelled unstarted waiting session %s removed from overview.conversations", waitC2.SessionID)
	}
	// Clean up W2 as well.
	f.request("POST", "/runs/"+waitW2.ID+"/queue", map[string]string{"action": "remove"}, 200, nil)
	f.request("GET", "/overview", nil, 200, &overview)
	if slices.ContainsFunc(overview.Conversations, func(c model.Conversation) bool { return c.ID == waitW2.SessionID }) {
		t.Fatalf("expected cancelled unstarted waiting session %s removed from overview.conversations", waitW2.SessionID)
	}
}
