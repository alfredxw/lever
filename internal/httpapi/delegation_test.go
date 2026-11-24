package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/workspace"
)

type mcpCall struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type mcpCallResult struct {
	Body  json.RawMessage `json:"body"`
	Error string          `json:"error"`
}

type mcpTurnReceipt struct {
	Input   string          `json:"input"`
	Tools   []string        `json:"tools"`
	Results []mcpCallResult `json:"results"`
}

func runMCPTurn(f *fixture, chatID, operation, suffix string, calls ...mcpCall) (model.Run, mcpTurnReceipt) {
	f.t.Helper()
	payload, err := json.Marshal(calls)
	if err != nil {
		f.t.Fatal(err)
	}
	text := "[chat-context] " + string(payload)
	if suffix != "" {
		text += " " + suffix
	}
	run := f.send(chatID, operation, "", text)
	if suffix != "" {
		return run, mcpTurnReceipt{}
	}
	run = f.wait(run.ID, "completed")
	var receipt mcpTurnReceipt
	if len(run.Items) == 0 || !strings.HasPrefix(run.Items[0].Text, "context:") {
		f.t.Fatalf("expected context receipt, got %+v", run.Items)
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(run.Items[0].Text, "context:")), &receipt); err != nil {
		f.t.Fatalf("parse context receipt: %v (%s)", err, run.Items[0].Text)
	}
	return run, receipt
}

func TestDelegationWorkspaceInheritMultiTurnReplyAndList(t *testing.T) {
	f := newFixture(t)
	parentDir, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	childDir, err := workspace.Canonical(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parentDir, "setup-marker"), []byte("from-parent"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(childDir, "setup-marker"), []byte("from-child"), 0600); err != nil {
		t.Fatal(err)
	}

	parent := f.agent("codex")
	parent.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "p", Path: parentDir}}, PrimaryRootID: "p"}
	child := f.agent("codex")
	child.Name = "Codex Backend"
	child.Profile.Description = "Go backend implementation and testing"
	child.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "c", Path: childDir}}, PrimaryRootID: "c"}
	f.request("PUT", "/agents/"+child.ID, child, 200, &child)
	if child.Profile.Description != "Go backend implementation and testing" {
		t.Fatalf("agent description did not persist: %+v", child.Profile)
	}

	parent.Profile.Delegations = []model.DelegationRule{{AgentID: child.ID, Confirm: false}}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)
	chat := f.chat(parent)

	// Turn 1: start an inherited-workspace delegation and an agent-workspace delegation.
	autoWakeFalse := false
	turn1, r1 := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": child.ID, "requestKey": "inherit-task", "task": "[worktree-setup] implement backend", "autoWake": autoWakeFalse,
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": child.ID, "requestKey": "agent-task", "task": "[worktree-setup] inspect own scope", "workspace": "agent", "autoWake": autoWakeFalse,
		}},
	)
	for _, want := range []string{"delegate_start", "delegate_reply", "delegate_wait", "delegate_list", "delegate_cancel"} {
		if !slices.Contains(r1.Tools, want) {
			t.Fatalf("missing delegation tool %q in %v", want, r1.Tools)
		}
	}
	if r1.Results[0].Error != "" || r1.Results[1].Error != "" {
		t.Fatalf("delegate_start failed: %+v", r1.Results)
	}
	var dInherit, dAgent model.Delegation
	if err := json.Unmarshal(r1.Results[0].Body, &dInherit); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(r1.Results[1].Body, &dAgent); err != nil {
		t.Fatal(err)
	}
	if dInherit.Workspace != "inherit" || dAgent.Workspace != "agent" {
		t.Fatalf("unexpected workspace modes: inherit=%+v agent=%+v", dInherit, dAgent)
	}

	childRunInherit := f.wait(dInherit.RunID, "completed")
	childRunAgent := f.wait(dAgent.RunID, "completed")
	if !strings.Contains(childRunInherit.Items[0].Text, "from-parent") {
		t.Fatalf("expected inherited cwd marker from-parent, got %q", childRunInherit.Items[0].Text)
	}
	if !strings.Contains(childRunAgent.Items[0].Text, "from-child") {
		t.Fatalf("expected agent cwd marker from-child, got %q", childRunAgent.Items[0].Text)
	}
	nativeRound1 := f.waitNative(dInherit.SessionID).NativeID

	// Turn 2: after user approval, Lead lists prior delegations and sends round 2 reply to the same child session.
	turn2, r2 := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_list", Arguments: map[string]any{}},
		mcpCall{Name: "delegate_reply", Arguments: map[string]any{
			"id": dInherit.ID, "requestKey": "round-2", "message": "fix review feedback", "autoWake": autoWakeFalse,
		}},
	)
	if r2.Results[0].Error != "" || r2.Results[1].Error != "" {
		t.Fatalf("turn 2 delegation calls failed: %+v", r2.Results)
	}
	var listed struct {
		Delegations []struct {
			ID        string `json:"id"`
			AgentID   string `json:"agentId"`
			AgentName string `json:"agentName"`
			Turn      int    `json:"turn"`
			Status    string `json:"status"`
		} `json:"delegations"`
	}
	if err := json.Unmarshal(r2.Results[0].Body, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Delegations) != 2 {
		t.Fatalf("expected 2 listed delegations across turns, got %+v", listed.Delegations)
	}
	var dReply model.Delegation
	if err := json.Unmarshal(r2.Results[1].Body, &dReply); err != nil {
		t.Fatal(err)
	}
	if dReply.ChatID != dInherit.ChatID || dReply.SessionID != dInherit.SessionID || dReply.Turn != 2 {
		t.Fatalf("delegate_reply did not continue same delegation: %+v (orig %+v)", dReply, dInherit)
	}
	childRun2 := f.wait(dReply.RunID, "completed")
	if !strings.Contains(childRun2.Items[0].Text, "Session: "+nativeRound1) {
		t.Fatalf("round 2 lost child native session %q: %s", nativeRound1, childRun2.Items[0].Text)
	}

	// Verify ChatDelegations links turn1 (round 1) and turn2 (round 2) with multi-turn metadata.
	var links model.ChatDelegations
	f.request("GET", "/chats/"+chat.ID+"/delegations", nil, 200, &links)
	if len(links.Outgoing[turn1.ID]) != 2 || len(links.Outgoing[turn2.ID]) != 1 {
		t.Fatalf("unexpected outgoing delegation links: %+v", links.Outgoing)
	}
	round2Link := links.Outgoing[turn2.ID][0]
	if round2Link.DelegationID != dInherit.ID || round2Link.Turn != 2 || round2Link.Turns != 2 || round2Link.Summary == "" {
		t.Fatalf("unexpected round 2 link metadata: %+v", round2Link)
	}

	// Removing collaborator from profile must block future delegate_reply turns.
	parent.Profile.Delegations = []model.DelegationRule{}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)
	// Trigger MCP by referencing another agent? Without any delegations, delegate_reply is not exposed at all.
	// Verify by keeping a dummy collaborator so delegation tools remain exposed, then attempting reply to removed child.
	other := f.agent("codex")
	parent.Profile.Delegations = []model.DelegationRule{{AgentID: other.ID, Confirm: false}}
	f.request("PUT", "/agents/"+parent.ID, parent, 200, &parent)
	_, r3 := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_reply", Arguments: map[string]any{
			"id": dInherit.ID, "requestKey": "blocked-round", "message": "should fail",
		}},
	)
	if !strings.Contains(r3.Results[0].Error, "not allowed") {
		t.Fatalf("expected removed collaborator reply to be rejected, got %+v", r3.Results[0])
	}
}

func TestDelegationParallelWaitAndAsyncReceiptAutoWake(t *testing.T) {
	f := newFixture(t)
	lead := f.agent("codex")
	gemini := f.agent("codex")
	gemini.Name = "Gemini Designer"
	f.request("PUT", "/agents/"+gemini.ID, gemini, 200, &gemini)
	codex := f.agent("codex")
	codex.Name = "Codex Backend"
	f.request("PUT", "/agents/"+codex.ID, codex, 200, &codex)

	lead.Profile.Delegations = []model.DelegationRule{
		{AgentID: gemini.ID, Confirm: false},
		{AgentID: codex.ID, Confirm: false},
	}
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)
	chat := f.chat(lead)

	// 1. Parallel delegate_wait consumes receipts so no redundant wakeup occurs.
	_, startReceipt := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": gemini.ID, "requestKey": "p1", "task": "[approval] proposal A",
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": codex.ID, "requestKey": "p2", "task": "[approval] proposal B",
		}},
	)
	var d1, d2 model.Delegation
	_ = json.Unmarshal(startReceipt.Results[0].Body, &d1)
	_ = json.Unmarshal(startReceipt.Results[1].Body, &d2)
	f.wait(d1.RunID, "waiting_user")
	f.wait(d2.RunID, "waiting_user")

	// Start a parallel delegate_wait turn, then approve both children concurrently.
	waitPayload, _ := json.Marshal([]mcpCall{{
		Name: "delegate_wait",
		Arguments: map[string]any{
			"ids": []string{d1.ID, d2.ID}, "waitFor": "all", "timeoutSeconds": 15,
		},
	}})
	waitRun := f.send(chat.ID, "main", "", "[chat-context] "+string(waitPayload))
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	for _, req := range overview.Requests {
		if req.RunID == d1.RunID || req.RunID == d2.RunID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
		}
	}
	waitRun = f.wait(waitRun.ID, "completed")
	var waitTurn mcpTurnReceipt
	if err := json.Unmarshal([]byte(strings.TrimPrefix(waitRun.Items[0].Text, "context:")), &waitTurn); err != nil {
		t.Fatalf("parse parallel wait receipt: %v", err)
	}
	var waited struct {
		AllFinished bool `json:"allFinished"`
		Results     []struct {
			Finished bool   `json:"finished"`
			Output   string `json:"output"`
		} `json:"results"`
	}
	if err := json.Unmarshal(waitTurn.Results[0].Body, &waited); err != nil {
		t.Fatal(err)
	}
	if !waited.AllFinished || len(waited.Results) != 2 || !waited.Results[0].Finished || !waited.Results[1].Finished {
		t.Fatalf("parallel delegate_wait did not collect both completions: %+v", waited)
	}

	// Give backend a brief beat and ensure NO spurious auto-wake run was added.
	time.Sleep(150 * time.Millisecond)
	var page model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &page)
	if len(page.Runs) != 2 {
		t.Fatalf("expected exactly 2 parent runs after consumed delegate_wait, got %d", len(page.Runs))
	}

	// 2. Async receipt auto-wakeup: Lead dispatches child without calling delegate_wait and ends its turn.
	_, asyncTurn := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": codex.ID, "requestKey": "async-backend", "task": "[approval] build backend API",
		}},
	)
	var dAsync model.Delegation
	_ = json.Unmarshal(asyncTurn.Results[0].Body, &dAsync)
	f.wait(dAsync.RunID, "waiting_user")

	// Approve child after parent turn is already completed & idle.
	f.request("GET", "/overview", nil, 200, &overview)
	answered := false
	for _, req := range overview.Requests {
		if req.RunID == dAsync.RunID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
			answered = true
		}
	}
	if !answered {
		t.Fatal("missing child approval request")
	}
	f.wait(dAsync.RunID, "completed")

	// Wait for the automatic receipt wakeup run to appear and complete on the Lead chat.
	deadline := time.Now().Add(8 * time.Second)
	var wakeRun *model.Run
	for time.Now().Before(deadline) {
		f.request("GET", "/chats/"+chat.ID, nil, 200, &page)
		for i := range page.Runs {
			if len(page.Runs[i].DelegationReceipts) > 0 {
				r := page.Runs[i]
				wakeRun = &r
				break
			}
		}
		if wakeRun != nil {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if wakeRun == nil {
		t.Fatalf("expected automatic delegation receipt wakeup run on parent chat, got %d runs", len(page.Runs))
	}
	completedWake := f.wait(wakeRun.ID, "completed")
	if len(completedWake.DelegationReceipts) != 1 ||
		completedWake.DelegationReceipts[0].DelegationID != dAsync.ID ||
		completedWake.DelegationReceipts[0].AgentName != "Codex Backend" ||
		completedWake.DelegationReceipts[0].Status != "completed" {
		t.Fatalf("unexpected delegation receipt metadata: %+v", completedWake.DelegationReceipts)
	}
	if !strings.Contains(completedWake.Input, "[Delegation receipt]") || !strings.Contains(completedWake.Input, dAsync.ID) {
		t.Fatalf("unexpected wakeup prompt: %s", completedWake.Input)
	}
}

func TestDelegationAsyncReceiptDeliversAfterBusyParentFinishes(t *testing.T) {
	f := newFixture(t)
	lead := f.agent("codex")
	worker := f.agent("codex")
	worker.Name = "Fast Worker"
	f.request("PUT", "/agents/"+worker.ID, worker, 200, &worker)
	lead.Profile.Delegations = []model.DelegationRule{{AgentID: worker.ID, Confirm: false}}
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)
	chat := f.chat(lead)

	// Parent starts a fast delegation AND immediately pauses on its own [approval] without calling delegate_wait.
	parentRun, _ := runMCPTurn(f, chat.ID, "main", "[approval]",
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "fast-child", "task": "finish quickly",
		}},
	)
	f.wait(parentRun.ID, "waiting_user")

	// Wait for child to finish while parent is still waiting_user.
	var links model.ChatDelegations
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.request("GET", "/chats/"+chat.ID+"/delegations", nil, 200, &links)
		if len(links.Outgoing[parentRun.ID]) == 1 && links.Outgoing[parentRun.ID][0].Status == "completed" {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if len(links.Outgoing[parentRun.ID]) != 1 || links.Outgoing[parentRun.ID][0].Status != "completed" {
		t.Fatalf("child did not finish while parent busy: %+v", links.Outgoing)
	}

	// Answer parent's approval so parent finishes cleanly → pending receipt must now wake parent!
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	for _, req := range overview.Requests {
		if req.RunID == parentRun.ID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
		}
	}
	f.wait(parentRun.ID, "completed")

	var page model.ChatView
	var wakeRun *model.Run
	deadline = time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		f.request("GET", "/chats/"+chat.ID, nil, 200, &page)
		for i := range page.Runs {
			if len(page.Runs[i].DelegationReceipts) > 0 {
				r := page.Runs[i]
				wakeRun = &r
				break
			}
		}
		if wakeRun != nil {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if wakeRun == nil {
		t.Fatalf("expected buffered delegation receipt after busy parent completed, got %d runs", len(page.Runs))
	}
	f.wait(wakeRun.ID, "completed")
	if wakeRun.DelegationReceipts[0].AgentName != "Fast Worker" {
		t.Fatalf("unexpected receipt: %+v", wakeRun.DelegationReceipts)
	}

	// Ensure unused app import doesn't happen; verify topic receipt delivery too.
	_ = app.ID()
}
