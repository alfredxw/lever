package httpapi_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
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

func TestDelegationPolicyModesPermissionCeilingAndConcurrency(t *testing.T) {
	f := newFixture(t)

	// 1. Newly created Agent defaults to delegation OFF ("none").
	var initialSettings model.DelegationSettings
	f.request("GET", "/settings/delegation", nil, 200, &initialSettings)
	if initialSettings.DefaultPolicy != model.DelegationPolicyNone {
		t.Fatalf("expected default global delegation policy 'none', got %+v", initialSettings)
	}
	lead := f.agent("codex")
	worker := f.agent("codex")
	worker.Name = "Backend Worker"
	worker.Profile.Description = "Implements Go APIs"
	worker.Profile.Permission = "full_access"
	f.request("PUT", "/agents/"+worker.ID, worker, 200, &worker)

	chat := f.chat(lead)
	_, rOff := runMCPTurn(f, chat.ID, "main", "")
	if slices.Contains(rOff.Tools, "delegate_start") || slices.Contains(rOff.Tools, "delegate_targets") {
		t.Fatalf("newly created agent should not have delegation tools by default: %v", rOff.Tools)
	}

	// 2. Global DefaultPolicy = "all" enables unconfigured agents while honoring explicit "none".
	var updatedSettings model.DelegationSettings
	f.request("PUT", "/settings/delegation", model.DelegationSettings{DefaultPolicy: model.DelegationPolicyAll}, 200, &updatedSettings)
	if updatedSettings.DefaultPolicy != model.DelegationPolicyAll {
		t.Fatalf("unexpected saved settings: %+v", updatedSettings)
	}
	explicitOff := f.agent("codex")
	explicitOff.Profile.DelegationPolicy = model.DelegationPolicyNone
	f.request("PUT", "/agents/"+explicitOff.ID, explicitOff, 200, &explicitOff)
	offChat := f.chat(explicitOff)
	_, rExplicitOff := runMCPTurn(f, offChat.ID, "main", "")
	if slices.Contains(rExplicitOff.Tools, "delegate_start") {
		t.Fatalf("explicit delegationPolicy=none must override global default: %v", rExplicitOff.Tools)
	}

	// Reset global back to "none" and explicitly configure lead with delegationPolicy="all".
	f.request("PUT", "/settings/delegation", model.DelegationSettings{DefaultPolicy: model.DelegationPolicyNone}, 200, &updatedSettings)
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	lead.Profile.Permission = "ask"
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)

	// 3. Newly added Agent is auto-discovered by "all"; acceptDelegations=false is excluded.
	late := f.agent("codex")
	late.Name = "Late Joiner"
	late.Profile.Description = "Added after lead was configured"
	f.request("PUT", "/agents/"+late.ID, late, 200, &late)

	acceptFalse := false
	privateAgent := f.agent("codex")
	privateAgent.Name = "Private Vault"
	privateAgent.Profile.AcceptDelegations = &acceptFalse
	f.request("PUT", "/agents/"+privateAgent.ID, privateAgent, 200, &privateAgent)

	// Verify @mention of privateAgent is rejected, while @mention of late is allowed.
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "ask @" + privateAgent.Name,
		References: []model.Reference{{Kind: "agent", ID: privateAgent.ID, Name: privateAgent.Name}},
	}, 400, nil)

	_, rTargets := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_targets", Arguments: map[string]any{}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": privateAgent.ID, "requestKey": "blocked-private", "task": "should be rejected",
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "ceiling-check", "task": "check permission ceiling", "autoWake": false,
		}},
	)
	if !slices.Contains(rTargets.Tools, "delegate_targets") {
		t.Fatalf("missing delegate_targets tool in %v", rTargets.Tools)
	}
	var targetList struct {
		Targets []struct {
			ID          string `json:"id"`
			DeviceID    string `json:"deviceId"`
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"targets"`
	}
	if err := json.Unmarshal(rTargets.Results[0].Body, &targetList); err != nil {
		t.Fatalf("parse delegate_targets: %v", err)
	}
	foundLate, foundPrivate := false, false
	for _, item := range targetList.Targets {
		if item.ID == late.ID && item.DeviceID == "" {
			foundLate = true
		}
		if item.ID == privateAgent.ID {
			foundPrivate = true
		}
	}
	if !foundLate || foundPrivate {
		t.Fatalf("unexpected delegate_targets list: %+v", targetList.Targets)
	}
	if !strings.Contains(rTargets.Results[1].Error, "does not accept") {
		t.Fatalf("expected privateAgent delegation rejection, got %+v", rTargets.Results[1])
	}
	if rTargets.Results[2].Error != "" {
		t.Fatalf("worker delegation failed: %+v", rTargets.Results[2])
	}
	var dCeil model.Delegation
	_ = json.Unmarshal(rTargets.Results[2].Body, &dCeil)
	childRun := f.wait(dCeil.RunID, "completed")
	if childRun.Selection.Permission != "ask" {
		t.Fatalf("expected child full_access permission capped to parent's 'ask', got %q", childRun.Selection.Permission)
	}

	// 4. Explicit confirm: true asks on delegate_start but does NOT re-confirm on delegate_reply.
	lead.Profile.DelegationPolicy = model.DelegationPolicySelected
	lead.Profile.Delegations = []model.DelegationRule{{AgentID: worker.ID, Confirm: true}}
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)

	confirmPayload, _ := json.Marshal([]mcpCall{{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "confirm-once", "task": "round 1", "autoWake": false,
		},
	}})
	pRun := f.send(chat.ID, "main", "", "[chat-context] "+string(confirmPayload))
	f.wait(pRun.ID, "waiting_user")
	var ov model.Overview
	f.request("GET", "/overview", nil, 200, &ov)
	answeredConfirm := false
	for _, req := range ov.Requests {
		if req.RunID == pRun.ID && req.DelegationAgentID == worker.ID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
			answeredConfirm = true
		}
	}
	if !answeredConfirm {
		t.Fatal("expected confirmation request for confirm=true delegate_start")
	}
	pRun = f.wait(pRun.ID, "completed")
	var confirmTurn mcpTurnReceipt
	_ = json.Unmarshal([]byte(strings.TrimPrefix(pRun.Items[0].Text, "context:")), &confirmTurn)
	var dConfirmed model.Delegation
	_ = json.Unmarshal(confirmTurn.Results[0].Body, &dConfirmed)
	f.wait(dConfirmed.RunID, "completed")

	// Round 2 delegate_reply must complete immediately without prompting for confirmation.
	_, replyTurn := runMCPTurn(f, chat.ID, "main", "", mcpCall{
		Name: "delegate_reply",
		Arguments: map[string]any{
			"id": dConfirmed.ID, "requestKey": "confirm-round-2", "message": "round 2", "autoWake": false,
		},
	})
	if replyTurn.Results[0].Error != "" {
		t.Fatalf("delegate_reply failed: %+v", replyTurn.Results[0])
	}
	var dRound2 model.Delegation
	_ = json.Unmarshal(replyTurn.Results[0].Body, &dRound2)
	f.wait(dRound2.RunID, "completed")

	// 5. Concurrency cap (maxActiveDelegations = 5) blocks the 6th active delegation in a session.
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)
	capChat := f.chat(lead)
	var calls []mcpCall
	for i := range 6 {
		calls = append(calls, mcpCall{
			Name: "delegate_start",
			Arguments: map[string]any{
				"agentId": worker.ID, "requestKey": "cap-" + string(rune('a'+i)),
				"task": "[approval] hold slot", "autoWake": false,
			},
		})
	}
	_, capTurn := runMCPTurn(f, capChat.ID, "main", "", calls...)
	for i := range 5 {
		if capTurn.Results[i].Error != "" {
			t.Fatalf("expected slot %d to succeed, got error: %s", i+1, capTurn.Results[i].Error)
		}
	}
	if !strings.Contains(capTurn.Results[5].Error, "At most 5 active") {
		t.Fatalf("expected 6th concurrent delegation to be rejected by concurrency cap, got %+v", capTurn.Results[5])
	}
	// Cleanly answer the 5 waiting children so fixture shutdown is immediate.
	capChildren := make([]model.Delegation, 5)
	for i := range 5 {
		_ = json.Unmarshal(capTurn.Results[i].Body, &capChildren[i])
		f.wait(capChildren[i].RunID, "waiting_user")
	}
	f.request("GET", "/overview", nil, 200, &ov)
	for _, req := range ov.Requests {
		f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: false}, 200, nil)
	}
	for i := range 5 {
		f.wait(capChildren[i].RunID, "completed")
	}

	// 6. Non-MCP provider (pi --no-tools) is NOT blocked from normal chat when delegationPolicy="all".
	noMCP := model.Provider{
		PluginID: "lever.pi", ContributionID: "pi", Type: "pi",
		Name: "Pi No Tools", Command: "pi", Args: []string{"--no-tools"}, Enabled: true,
	}
	f.request("POST", "/providers", noMCP, 200, &noMCP)
	piAgent := f.piAgent()
	piAgent.ID = ""
	piAgent.Name = "Limited Pi"
	piAgent.Profile.Provider = noMCP.ID
	piAgent.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("POST", "/agents", piAgent, 200, &piAgent)
	piChat := f.chat(piAgent)
	normalRun := f.send(piChat.ID, "main", "", "ordinary chat without mentions")
	f.wait(normalRun.ID, "completed")
}

func TestDelegationStopParentKeepsChildAndExplicitStop(t *testing.T) {
	f := newFixture(t)
	lead := f.agent("codex")
	lead.Name = "Lead"
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)

	worker := f.agent("codex")
	worker.Name = "Worker"
	f.request("PUT", "/agents/"+worker.ID, worker, 200, &worker)

	chat := f.chat(lead)
	// Start a parent turn that spawns an approval-blocked child and then waits on its own approval.
	parentRun, _ := runMCPTurn(f, chat.ID, "main", "[approval]", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "keep-alive", "task": "[approval] background worker job", "autoWake": true,
		},
	})
	f.wait(parentRun.ID, "waiting_user")

	var delView model.ChatDelegations
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.request("GET", "/chats/"+chat.ID+"/delegations", nil, 200, &delView)
		if len(delView.Outgoing[parentRun.ID]) == 1 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if len(delView.Outgoing[parentRun.ID]) != 1 {
		t.Fatalf("expected 1 outgoing delegation, got %+v", delView.Outgoing)
	}
	child := delView.Outgoing[parentRun.ID][0]
	f.wait(child.RunID, "waiting_user")

	// Stop the parent turn ONLY — child must remain active (waiting_user).
	f.request("POST", "/runs/"+parentRun.ID+"/stop", map[string]any{}, 200, nil)
	f.wait(parentRun.ID, "interrupted")
	time.Sleep(150 * time.Millisecond)
	var childCheck model.Run
	f.request("GET", "/runs/"+child.RunID, nil, 200, &childCheck)
	if childCheck.Status != "waiting_user" {
		t.Fatalf("expected child to stay active after parent stop, got %q", childCheck.Status)
	}

	// Approve the child; it should finish and still wake the parent session with a receipt.
	var ov model.Overview
	f.request("GET", "/overview", nil, 200, &ov)
	answered := false
	for _, req := range ov.Requests {
		if req.RunID == child.RunID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
			answered = true
		}
	}
	if !answered {
		t.Fatal("expected pending approval for child run")
	}
	f.wait(child.RunID, "completed")

	var wakeRun *model.Run
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var view model.ChatView
		f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
		for i := range view.Runs {
			if len(view.Runs[i].DelegationReceipts) > 0 {
				r := view.Runs[i]
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
		t.Fatal("expected wake receipt run in parent session after child completed")
	}
	f.wait(wakeRun.ID, "completed")

	// Now start two new active children and test individual stop + stop-all-in-session.
	_, r2 := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "stop-one", "task": "[approval] stop one", "autoWake": true,
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "stop-all", "task": "[approval] stop all", "autoWake": true,
		}},
	)
	var dOne, dAll model.Delegation
	_ = json.Unmarshal(r2.Results[0].Body, &dOne)
	_ = json.Unmarshal(r2.Results[1].Body, &dAll)
	f.wait(dOne.RunID, "waiting_user")
	f.wait(dAll.RunID, "waiting_user")

	f.request("POST", "/delegations/"+dOne.ID+"/stop", map[string]any{}, 200, nil)
	f.wait(dOne.RunID, "interrupted")

	f.request("POST", "/sessions/"+parentRun.SessionID+"/delegations/stop", map[string]any{}, 200, nil)
	f.wait(dAll.RunID, "interrupted")

	// Neither explicitly stopped delegation should trigger a new wake run.
	time.Sleep(250 * time.Millisecond)
	var finalView model.ChatView
	f.request("GET", "/chats/"+chat.ID, nil, 200, &finalView)
	wakeCount := 0
	for _, r := range finalView.Runs {
		if len(r.DelegationReceipts) > 0 {
			wakeCount++
		}
	}
	if wakeCount != 1 {
		t.Fatalf("expected only the original wake run (1), got %d", wakeCount)
	}
}

func TestDelegationTypingYieldAndSiblingCoalescing(t *testing.T) {
	f := newFixture(t)
	lead := f.agent("codex")
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)
	worker := f.agent("codex")

	// 1. Typing yield defers receipt until typing stops.
	chat1 := f.chat(lead)
	t1, r1 := runMCPTurn(f, chat1.ID, "main", "", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "typing-yield", "task": "[approval] hold for typing", "autoWake": true,
		},
	})
	var d1 model.Delegation
	_ = json.Unmarshal(r1.Results[0].Body, &d1)
	f.wait(d1.RunID, "waiting_user")

	f.request("POST", "/sessions/"+t1.SessionID+"/typing", map[string]bool{"active": true}, 200, nil)
	var ov model.Overview
	f.request("GET", "/overview", nil, 200, &ov)
	for _, req := range ov.Requests {
		if req.RunID == d1.RunID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
		}
	}
	f.wait(d1.RunID, "completed")
	time.Sleep(250 * time.Millisecond)

	var v1 model.ChatView
	f.request("GET", "/chats/"+chat1.ID, nil, 200, &v1)
	for _, r := range v1.Runs {
		if len(r.DelegationReceipts) > 0 {
			t.Fatalf("expected receipt wake deferred while typing, but found %+v", r)
		}
	}

	// Clearing typing delivers the receipt immediately.
	f.request("POST", "/sessions/"+t1.SessionID+"/typing", map[string]bool{"active": false}, 200, nil)
	var wake1 *model.Run
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.request("GET", "/chats/"+chat1.ID, nil, 200, &v1)
		for i := range v1.Runs {
			if len(v1.Runs[i].DelegationReceipts) > 0 {
				r := v1.Runs[i]
				wake1 = &r
				break
			}
		}
		if wake1 != nil {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if wake1 == nil {
		t.Fatal("expected receipt wake immediately after typing cleared")
	}
	f.wait(wake1.ID, "completed")

	// 2. Sibling coalescing: two parallel children finishing ~150ms apart coalesce into ONE wake run.
	chat2 := f.chat(lead)
	_, r2 := runMCPTurn(f, chat2.ID, "main", "",
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "sib-a", "task": "[approval] sibling A", "autoWake": true,
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "sib-b", "task": "[approval] sibling B", "autoWake": true,
		}},
	)
	var dA, dB model.Delegation
	_ = json.Unmarshal(r2.Results[0].Body, &dA)
	_ = json.Unmarshal(r2.Results[1].Body, &dB)
	f.wait(dA.RunID, "waiting_user")
	f.wait(dB.RunID, "waiting_user")

	f.request("GET", "/overview", nil, 200, &ov)
	var reqA, reqB string
	for _, req := range ov.Requests {
		if req.RunID == dA.RunID {
			reqA = req.ID
		}
		if req.RunID == dB.RunID {
			reqB = req.ID
		}
	}
	f.request("POST", "/requests/"+reqA+"/answer", model.Answer{Allow: true}, 200, nil)
	f.wait(dA.RunID, "completed")
	time.Sleep(150 * time.Millisecond)

	// Should still be coalescing because sibling B is active.
	var v2 model.ChatView
	f.request("GET", "/chats/"+chat2.ID, nil, 200, &v2)
	for _, r := range v2.Runs {
		if len(r.DelegationReceipts) > 0 {
			t.Fatalf("expected first sibling receipt to coalesce while sibling B is active, got %+v", r)
		}
	}

	// Finish sibling B — both receipts must land together in ONE wake run.
	f.request("POST", "/requests/"+reqB+"/answer", model.Answer{Allow: true}, 200, nil)
	f.wait(dB.RunID, "completed")

	var wake2 *model.Run
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.request("GET", "/chats/"+chat2.ID, nil, 200, &v2)
		for i := range v2.Runs {
			if len(v2.Runs[i].DelegationReceipts) > 0 {
				r := v2.Runs[i]
				wake2 = &r
				break
			}
		}
		if wake2 != nil {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if wake2 == nil {
		t.Fatal("expected coalesced wake run")
	}
	f.wait(wake2.ID, "completed")
	if len(wake2.DelegationReceipts) != 2 {
		t.Fatalf("expected 2 coalesced receipts in 1 wake run, got %d: %+v", len(wake2.DelegationReceipts), wake2.DelegationReceipts)
	}
}

func TestDelegationReadChatContextAndLiveSnapshot(t *testing.T) {
	f := newFixture(t)
	lead := f.agent("codex")
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)
	worker := f.agent("codex")
	worker.Name = "Backend Worker"
	f.request("PUT", "/agents/"+worker.ID, worker, 200, &worker)

	unrelatedChat := f.chat(worker)
	unrelatedRun := f.send(unrelatedChat.ID, "main", "", "PRIVATE_UNRELATED_SECRET")
	f.wait(unrelatedRun.ID, "completed")

	chat := f.chat(lead)
	_, r1 := runMCPTurn(f, chat.ID, "main", "", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "ctx-read", "task": "WORKER_TRANSCRIPT_SECRET", "autoWake": false,
		},
	})
	var d model.Delegation
	_ = json.Unmarshal(r1.Results[0].Body, &d)
	f.wait(d.RunID, "completed")

	// Next turn on Lead: read_chat_context on owned delegated child must succeed,
	// unrelated session must be rejected, and <delegation-context> must be injected.
	_, r2 := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "read_chat_context", Arguments: map[string]any{"target": d.SessionID}},
		mcpCall{Name: "read_chat_context", Arguments: map[string]any{"target": unrelatedRun.SessionID}},
	)
	if !strings.Contains(r2.Input, "<delegation-context>") || !strings.Contains(r2.Input, d.ID) || !strings.Contains(r2.Input, d.SessionID) {
		t.Fatalf("expected live <delegation-context> snapshot in follow-up prompt, got %q", r2.Input)
	}
	if r2.Results[0].Error != "" {
		t.Fatalf("expected read_chat_context on owned delegated session to succeed, got %s", r2.Results[0].Error)
	}
	if !strings.Contains(string(r2.Results[0].Body), "WORKER_TRANSCRIPT_SECRET") {
		t.Fatalf("expected child transcript in read_chat_context body, got %s", string(r2.Results[0].Body))
	}
	if r2.Results[1].Error == "" {
		t.Fatalf("expected unrelated session read_chat_context to fail, got %s", string(r2.Results[1].Body))
	}
}

func TestDelegationNestedTwoLevelsAndCyclePrevention(t *testing.T) {
	f := newFixture(t)
	router := f.agent("codex")
	router.Name = "Main Router"
	router.Profile.DelegationPolicy = model.DelegationPolicyAll
	router.Profile.MaxDelegationDepth = 2
	f.request("PUT", "/agents/"+router.ID, router, 200, &router)

	lead := f.agent("codex")
	lead.Name = "Claude Lead"
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)

	worker := f.agent("codex")
	worker.Name = "Codex Worker"
	worker.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+worker.ID, worker, 200, &worker)

	extra := f.agent("codex")
	extra.Name = "Extra Worker"
	f.request("PUT", "/agents/"+extra.ID, extra, 200, &extra)

	// Depth-2 child inspects available MCP tools (delegate_start must NOT be registered).
	depth2Calls, _ := json.Marshal([]mcpCall{{
		Name:      "find_chat_context",
		Arguments: map[string]any{},
	}})
	// Depth-1 Lead prompt tries to cycle back to Router (must be rejected) and delegate to Worker (must succeed).
	depth1Calls, _ := json.Marshal([]mcpCall{
		{
			Name: "delegate_start",
			Arguments: map[string]any{
				"agentId": router.ID, "requestKey": "cycle-router", "task": "cycle back", "autoWake": false,
			},
		},
		{
			Name: "delegate_start",
			Arguments: map[string]any{
				"agentId": worker.ID, "requestKey": "depth-2", "task": "[chat-context] " + string(depth2Calls), "autoWake": false,
			},
		},
	})

	chat := f.chat(router)
	_, rRouter := runMCPTurn(f, chat.ID, "main", "", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": lead.ID, "requestKey": "depth-1", "task": "[chat-context] " + string(depth1Calls), "autoWake": false,
		},
	})
	if rRouter.Results[0].Error != "" {
		t.Fatalf("router -> lead delegation failed: %s", rRouter.Results[0].Error)
	}
	var dLead model.Delegation
	_ = json.Unmarshal(rRouter.Results[0].Body, &dLead)
	leadRun := f.wait(dLead.RunID, "completed")
	var leadReceipt mcpTurnReceipt
	if err := json.Unmarshal([]byte(strings.TrimPrefix(leadRun.Items[0].Text, "context:")), &leadReceipt); err != nil {
		t.Fatalf("parse lead receipt: %v (%+v)", err, leadRun.Items)
	}
	if leadReceipt.Results[0].Error == "" {
		t.Fatalf("expected cycle back to router to be rejected, got %s", string(leadReceipt.Results[0].Body))
	}
	if leadReceipt.Results[1].Error != "" {
		t.Fatalf("expected depth-2 delegation lead -> worker to succeed, got %s", leadReceipt.Results[1].Error)
	}
	var dWorker model.Delegation
	_ = json.Unmarshal(leadReceipt.Results[1].Body, &dWorker)
	workerRun := f.wait(dWorker.RunID, "completed")
	var workerReceipt mcpTurnReceipt
	if err := json.Unmarshal([]byte(strings.TrimPrefix(workerRun.Items[0].Text, "context:")), &workerReceipt); err != nil {
		t.Fatalf("parse worker receipt: %v (%+v)", err, workerRun.Items)
	}
	if slices.Contains(workerReceipt.Tools, "delegate_start") {
		t.Fatalf("depth-2 worker must not receive delegate_start tool, got %v", workerReceipt.Tools)
	}

	// Attempting to call delegate_start explicitly at depth 2 must be rejected as an unknown tool.
	depth3BlockedCalls, _ := json.Marshal([]mcpCall{{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": extra.ID, "requestKey": "depth-3", "task": "should fail", "autoWake": false,
		},
	}})
	depth1ReplyCalls, _ := json.Marshal([]mcpCall{{
		Name: "delegate_reply",
		Arguments: map[string]any{
			"id": dWorker.ID, "requestKey": "depth-3-probe", "message": "[chat-context] " + string(depth3BlockedCalls), "autoWake": false,
		},
	}})
	_, rReplyLead := runMCPTurn(f, chat.ID, "main", "", mcpCall{
		Name: "delegate_reply",
		Arguments: map[string]any{
			"id": dLead.ID, "requestKey": "reply-lead-probe", "message": "[chat-context] " + string(depth1ReplyCalls), "autoWake": false,
		},
	})
	var dLeadR2 model.Delegation
	_ = json.Unmarshal(rReplyLead.Results[0].Body, &dLeadR2)
	leadRun2 := f.wait(dLeadR2.RunID, "completed")
	var leadReceipt2 mcpTurnReceipt
	if err := json.Unmarshal([]byte(strings.TrimPrefix(leadRun2.Items[0].Text, "context:")), &leadReceipt2); err != nil {
		t.Fatalf("parse lead r2 receipt: %v", err)
	}
	var dWorkerR2 model.Delegation
	_ = json.Unmarshal(leadReceipt2.Results[0].Body, &dWorkerR2)
	workerRun2 := f.wait(dWorkerR2.RunID, "completed")
	if len(workerRun2.Items) == 0 || !strings.Contains(workerRun2.Items[0].Text, `unknown tool "delegate_start"`) {
		t.Fatalf("expected depth-3 delegate_start call to be rejected as unknown tool, got %+v", workerRun2.Items)
	}

	// Default depth=1 must NOT expose delegate_start at depth 1.
	shallow := f.agent("codex")
	shallow.Profile.DelegationPolicy = model.DelegationPolicyAll
	shallow.Profile.MaxDelegationDepth = 1
	f.request("PUT", "/agents/"+shallow.ID, shallow, 200, &shallow)
	shallowChat := f.chat(shallow)
	_, rShallow := runMCPTurn(f, shallowChat.ID, "main", "", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": lead.ID, "requestKey": "shallow-1", "task": "[chat-context] " + string(depth2Calls), "autoWake": false,
		},
	})
	var dShallowLead model.Delegation
	_ = json.Unmarshal(rShallow.Results[0].Body, &dShallowLead)
	shallowLeadRun := f.wait(dShallowLead.RunID, "completed")
	var shallowLeadReceipt mcpTurnReceipt
	if err := json.Unmarshal([]byte(strings.TrimPrefix(shallowLeadRun.Items[0].Text, "context:")), &shallowLeadReceipt); err != nil {
		t.Fatalf("parse shallow lead receipt: %v (%+v)", err, shallowLeadRun.Items)
	}
	if slices.Contains(shallowLeadReceipt.Tools, "delegate_start") {
		t.Fatalf("depth-1 child under maxDepth=1 must not receive delegate_start, got %v", shallowLeadReceipt.Tools)
	}
}

func TestDelegationLocalIdleWorktreeAutoSelectAndExplicit(t *testing.T) {
	f := newFixture(t)
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	repoDir := filepath.Join(f.root, "collab-repo")
	if err := os.Mkdir(repoDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("hello\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(repoDir, "init", "-q")
	git(repoDir, "add", ".")
	git(repoDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initial")

	lead := f.agent("codex")
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	lead.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "r", Path: repoDir}}, PrimaryRootID: "r"}
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)

	worker := f.agent("codex")
	worker.Name = "Repo Worker"
	worker.Profile.Scope = model.Scope{Roots: []model.Root{{ID: "r", Path: repoDir}}, PrimaryRootID: "r"}
	f.request("PUT", "/agents/"+worker.ID, worker, 200, &worker)

	// Pre-create ONE idle worktree on worker.
	wcID := app.ID()
	var opts model.CopyOptions
	f.request("GET", "/agents/"+worker.ID+"/working-copies/options?requestId="+wcID, nil, 200, &opts)
	var wc model.WorkingCopy
	f.request("POST", "/agents/"+worker.ID+"/working-copies", model.CreateWorkingCopy{
		ID: wcID, Name: "Idle WT", Scope: opts.Scope,
		Choices: []model.CopyChoice{{Source: opts.Groups[0].Source, Base: opts.Groups[0].Head}},
	}, 200, &wc)

	chat := f.chat(lead)
	// 1. delegate_targets exposes local pre-created workingCopies.
	// 2. workspace='agent' when default checkout is occupied (lead is running in repoDir) auto-picks Idle WT without creating a new worktree!
	// 3. workspace='inherit' keeps sharing lead's default checkout (workingCopyId == "").
	// 4. Explicit workingCopyId selects Idle WT.
	_, r := runMCPTurn(f, chat.ID, "main", "",
		mcpCall{Name: "delegate_targets", Arguments: map[string]any{"deviceId": "local"}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "auto-idle-wt", "task": "work in agent scope", "workspace": "agent", "autoWake": false,
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "inherit-same", "task": "tight collaboration", "workspace": "inherit", "autoWake": false,
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "explicit-wt", "task": "explicit worktree", "workingCopyId": wc.ID, "autoWake": false,
		}},
	)
	if !strings.Contains(string(r.Results[0].Body), wc.ID) {
		t.Fatalf("expected delegate_targets to expose local workingCopy %s, got %s", wc.ID, string(r.Results[0].Body))
	}
	var dAuto, dInherit, dExplicit model.Delegation
	_ = json.Unmarshal(r.Results[1].Body, &dAuto)
	_ = json.Unmarshal(r.Results[2].Body, &dInherit)
	_ = json.Unmarshal(r.Results[3].Body, &dExplicit)
	if r.Results[1].Error != "" || r.Results[2].Error != "" || r.Results[3].Error != "" {
		t.Fatalf("delegations failed: %+v", r.Results)
	}
	f.wait(dAuto.RunID, "completed")
	f.wait(dInherit.RunID, "completed")
	f.wait(dExplicit.RunID, "completed")

	if dAuto.WorkingCopyID != wc.ID {
		t.Fatalf("expected workspace='agent' on busy default repo to auto-pick idle worktree %s, got %+v", wc.ID, dAuto)
	}
	if dInherit.WorkingCopyID != "" {
		t.Fatalf("expected workspace='inherit' to stay on parent default checkout, got %+v", dInherit)
	}
	if dExplicit.WorkingCopyID != wc.ID {
		t.Fatalf("expected explicit workingCopyId %s, got %+v", wc.ID, dExplicit)
	}
	// Verify NO new worktree was auto-created (still exactly 1 working copy).
	var copiesAfter []model.WorkingCopy
	f.request("GET", "/agents/"+worker.ID+"/working-copies", nil, 200, &copiesAfter)
	if len(copiesAfter) != 1 {
		t.Fatalf("expected 0 auto-created worktrees (still 1), got %d", len(copiesAfter))
	}
}

func TestDelegationFeishuChannelAsyncReceiptLoop(t *testing.T) {
	f := newFixture(t)
	lead := f.agent("codex")
	lead.Profile.DelegationPolicy = model.DelegationPolicyAll
	f.request("PUT", "/agents/"+lead.ID, lead, 200, &lead)
	worker := f.agent("codex")

	// Start a normal chat and turn so we have a real delegated child, then bind the chat as a Feishu channel chat
	// with channel_deliveries + feishu_delivery_meta on the parent run.
	chat := f.chat(lead)
	parentRun, r1 := runMCPTurn(f, chat.ID, "main", "", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"agentId": worker.ID, "requestKey": "feishu-async", "task": "[approval] async feishu task", "autoWake": true,
		},
	})
	var d model.Delegation
	_ = json.Unmarshal(r1.Results[0].Body, &d)
	f.wait(d.RunID, "waiting_user")

	// Mark the chat as channel="feishu" and attach channel_deliveries + feishu_delivery_meta to parentRun.
	if err := f.a.Store.Write(t.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE chats SET data=json_set(data,'$.channel','feishu','$.source','channel') WHERE id=?", chat.ID); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO channel_deliveries(run_id,binding_id,message_id,part,status) VALUES(?,?,'om_orig_1','answer','sent')", parentRun.ID, "feishu:bot1"); err != nil {
			return err
		}
		meta := `{"chatType":"p2p","remoteChatId":"oc_123","replyTarget":"quote","replyStyle":"card","reactionAck":true,"reactionId":"rxn_orig"}`
		_, err := tx.Exec("INSERT INTO feishu_delivery_meta(run_id,data) VALUES(?,?)", parentRun.ID, meta)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	// Approve child; async wake must bypass checkDesktopChat and create outbound channel_deliveries + feishu_delivery_meta.
	var ov model.Overview
	f.request("GET", "/overview", nil, 200, &ov)
	for _, req := range ov.Requests {
		if req.RunID == d.RunID {
			f.request("POST", "/requests/"+req.ID+"/answer", model.Answer{Allow: true}, 200, nil)
		}
	}
	f.wait(d.RunID, "completed")

	var wakeRun *model.Run
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var view model.ChatView
		f.request("GET", "/chats/"+chat.ID, nil, 200, &view)
		for i := range view.Runs {
			if len(view.Runs[i].DelegationReceipts) > 0 {
				r := view.Runs[i]
				wakeRun = &r
				break
			}
		}
		if wakeRun != nil {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if wakeRun == nil {
		t.Fatal("expected async wake run for Feishu channel chat")
	}
	f.wait(wakeRun.ID, "completed")

	var bindingID, messageID, status string
	if err := f.a.Store.DB.QueryRow("SELECT binding_id, message_id, status FROM channel_deliveries WHERE run_id=? AND part='answer'", wakeRun.ID).Scan(&bindingID, &messageID, &status); err != nil {
		t.Fatalf("expected outbound channel_deliveries row for wake run %s: %v", wakeRun.ID, err)
	}
	if bindingID != "feishu:bot1" || messageID != "om_orig_1" {
		t.Fatalf("unexpected wake channel delivery binding=%q message=%q status=%q", bindingID, messageID, status)
	}
	var rawMeta string
	if err := f.a.Store.DB.QueryRow("SELECT data FROM feishu_delivery_meta WHERE run_id=?", wakeRun.ID).Scan(&rawMeta); err != nil {
		t.Fatalf("expected feishu_delivery_meta for wake run: %v", err)
	}
	var parsedMeta struct {
		ReplyStyle  string `json:"replyStyle"`
		ReactionAck bool   `json:"reactionAck"`
		ReactionID  string `json:"reactionId"`
	}
	if err := json.Unmarshal([]byte(rawMeta), &parsedMeta); err != nil {
		t.Fatal(err)
	}
	if parsedMeta.ReplyStyle != "card" || parsedMeta.ReactionAck || parsedMeta.ReactionID != "" {
		t.Fatalf("expected wake feishu meta with replyStyle=card and reaction cleared, got %+v", parsedMeta)
	}
}
