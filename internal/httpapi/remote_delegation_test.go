package httpapi_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/hub"
	"lever/internal/model"
	"lever/internal/remote"
	p "lever/internal/remoteproto"
)

func TestCrossDeviceDelegationEndToEnd(t *testing.T) {
	h, err := hub.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Setup("owner", "a test-only password"); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h.Handler(fstest.MapFS{"hub.html": {Data: []byte("Lever Hub")}}))
	defer server.Close()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	hubReq := func(method, path string, input any, status int, out any) {
		t.Helper()
		b, _ := json.Marshal(input)
		r, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != status {
			t.Fatalf("%s %s: %d: %s", method, path, resp.StatusCode, raw)
		}
		if out != nil {
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	hubReq("POST", "/api/login", map[string]string{"name": "owner", "password": "a test-only password"}, 200, nil)
	var account struct{ Spaces []p.Space }
	hubReq("GET", "/api/me", nil, 200, &account)
	spaceID := account.Spaces[0].ID
	spaceRoot := "/api/spaces/" + spaceID
	ticket := func(role p.Role) string {
		var v struct{ Code string }
		hubReq("POST", spaceRoot+"/tickets", map[string]p.Role{"role": role}, 200, &v)
		return v.Code
	}

	// Workstation A (caller) and Workstation B (remote executor).
	hostA := newFixture(t)
	defer hostA.s.Remote.Close()
	hostB := newFixture(t)
	defer hostB.s.Remote.Close()

	var scopeA, scopeB model.SharedScope
	hostA.request("POST", "/remote", remote.Management{
		Action: "pair",
		Pair:   remote.PairConfig{Hub: server.URL, Code: ticket(p.Workstation), Role: p.Workstation, Name: "MacBook-A"},
	}, 200, &scopeA)
	hostB.request("POST", "/remote", remote.Management{
		Action: "pair",
		Pair:   remote.PairConfig{Hub: server.URL, Code: ticket(p.Workstation), Role: p.Workstation, Name: "Linux-B"},
	}, 200, &scopeB)

	// Executor C cannot list devices or reverse-delegate.
	pubC, privC, _ := ed25519.GenerateKey(rand.Reader)
	execClient, err := p.Pair(t.Context(), server.URL, p.PairInput{
		Code: ticket(p.Executor), Role: p.Executor,
		Identity: p.Identity{ID: p.NewID(), PublicKey: pubC}, Name: "Executor-C", Platform: "linux",
	}, privC)
	if err != nil {
		t.Fatal(err)
	}
	if err := execClient.Do(t.Context(), "GET", spaceRoot+"/devices", nil, nil); err == nil {
		t.Fatal("executor node should not be able to enumerate space devices")
	}

	// Configure exposed agents on Host B: workerB (accepts delegations, full_access) and privateB (acceptDelegations=false).
	workerB := hostB.agent("codex")
	workerB.Name = "GPU Builder"
	workerB.Profile.Description = "Runs Linux builds and tests"
	workerB.Profile.Permission = "full_access"
	hostB.request("PUT", "/agents/"+workerB.ID, workerB, 200, &workerB)

	acceptFalse := false
	privateB := hostB.agent("codex")
	privateB.Name = "Private B"
	privateB.Profile.AcceptDelegations = &acceptFalse
	hostB.request("PUT", "/agents/"+privateB.ID, privateB, 200, &privateB)

	if _, err := hostB.s.Remote.Manage(t.Context(), remote.Management{
		Action: "expose_all", Scope: scopeB, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	// Configure Lead on Host A with permission="ask" and delegationPolicy="all".
	leadA := hostA.agent("codex")
	leadA.Name = "Lead A"
	leadA.Profile.Permission = "ask"
	leadA.Profile.DelegationPolicy = model.DelegationPolicyAll
	hostA.request("PUT", "/agents/"+leadA.ID, leadA, 200, &leadA)
	// Private local chat on Host A (SharedScope == nil).
	chatA := hostA.chat(leadA)

	// Wait until Host A discovers workerB via Hub archive.
	waitCond := func(msg string, check func() bool) {
		t.Helper()
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("timed out: " + msg)
	}

	var remoteTargets []model.RemoteAgentTarget
	waitCond("discover workerB from Host A", func() bool {
		hostA.request("GET", "/delegation/remote-targets?chatId="+chatA.ID+"&agentId="+leadA.ID, nil, 200, &remoteTargets)
		for _, rt := range remoteTargets {
			if rt.DeviceID == hostB.a.Store.DeviceID && rt.AgentID == workerB.ID && rt.Online {
				return true
			}
		}
		return false
	})
	for _, rt := range remoteTargets {
		if rt.AgentID == privateB.ID {
			t.Fatalf("privateB (acceptDelegations=false) must not appear in remote targets: %+v", remoteTargets)
		}
	}

	// 1. Verify delegate_targets, reject workspace="inherit", and start cross-device delegation with [approval].
	parentTurn1, r1 := runMCPTurn(hostA, chatA.ID, "main", "",
		mcpCall{Name: "delegate_targets", Arguments: map[string]any{}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"deviceId": hostB.a.Store.DeviceID, "agentId": workerB.ID,
			"requestKey": "bad-inherit", "workspace": "inherit", "task": "should fail",
		}},
		mcpCall{Name: "delegate_start", Arguments: map[string]any{
			"deviceId": hostB.a.Store.DeviceID, "agentId": workerB.ID,
			"requestKey": "remote-build-1", "task": "[approval] build release artifact",
		}},
	)
	if r1.Results[0].Error != "" {
		t.Fatalf("delegate_targets failed: %s", r1.Results[0].Error)
	}
	var listedTargets struct {
		Targets []struct {
			ID          string `json:"id"`
			DeviceID    string `json:"deviceId"`
			DeviceName  string `json:"deviceName"`
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"targets"`
	}
	if err := json.Unmarshal(r1.Results[0].Body, &listedTargets); err != nil {
		t.Fatalf("parse delegate_targets: %v", err)
	}
	foundWorkerB, foundPrivateB := false, false
	for _, item := range listedTargets.Targets {
		if item.DeviceID == hostB.a.Store.DeviceID && item.ID == workerB.ID && item.Description == "Runs Linux builds and tests" {
			foundWorkerB = true
		}
		if item.ID == privateB.ID {
			foundPrivateB = true
		}
	}
	if !foundWorkerB || foundPrivateB {
		t.Fatalf("unexpected remote delegate_targets result: %+v", listedTargets.Targets)
	}
	if !strings.Contains(r1.Results[1].Error, "workspace='inherit'") {
		t.Fatalf("expected workspace='inherit' rejection for remote target, got %+v", r1.Results[1])
	}
	if r1.Results[2].Error != "" {
		t.Fatalf("remote delegate_start failed: %+v", r1.Results[2])
	}
	var dRemote model.Delegation
	if err := json.Unmarshal(r1.Results[2].Body, &dRemote); err != nil {
		t.Fatal(err)
	}
	if dRemote.DeviceID != hostB.a.Store.DeviceID || dRemote.ChatID == "" || dRemote.RunID == "" {
		t.Fatalf("expected auto-accepted remote delegation with remote chatId/runId, got %+v", dRemote)
	}

	// Verify Host A's private chat was NOT synced to Hub archive.
	var archiveA []p.Record
	hubReq("GET", spaceRoot+"/archive/"+hostA.a.Store.DeviceID, nil, 200, &archiveA)
	for _, rec := range archiveA {
		if rec.Kind == "chat" && rec.ID == chatA.ID {
			t.Fatalf("private parent chatA leaked to Hub archive: %+v", rec)
		}
	}

	// Verify Host B's child run got capped permission ("ask", NOT "full_access") and remote source metadata.
	remoteRunB := hostB.wait(dRemote.RunID, "waiting_user")
	if remoteRunB.Selection.Permission != "ask" {
		t.Fatalf("expected remote child permission capped to 'ask', got %q", remoteRunB.Selection.Permission)
	}
	var linksB model.ChatDelegations
	hostB.request("GET", "/chats/"+dRemote.ChatID+"/delegations", nil, 200, &linksB)
	if linksB.Source == nil || linksB.Source.DeviceID != hostA.a.Store.DeviceID || linksB.Source.AgentID != leadA.ID {
		t.Fatalf("unexpected remote source on Host B: %+v", linksB.Source)
	}

	// 2. Wait for Host A's follower to bubble Host B's pending approval into ChatDelegations.Outgoing.
	var linksA model.ChatDelegations
	var remoteRowID, remoteReqID string
	waitCond("bubble remote pending request to Host A", func() bool {
		hostA.request("GET", "/chats/"+chatA.ID+"/delegations", nil, 200, &linksA)
		runs := linksA.Outgoing[parentTurn1.ID]
		if len(runs) != 1 || runs[0].Status != "waiting_user" || len(runs[0].RemoteRequests) == 0 {
			return false
		}
		remoteRowID = runs[0].RemoteRowID
		remoteReqID = runs[0].RemoteRequests[0].ID
		return remoteRowID != "" && remoteReqID != ""
	})

	// 3. Approve remote request from Host A -> Host B finishes -> autoWake delivers receipt to Host A!
	hostA.request("POST", "/delegations/remote/"+remoteRowID+"/answer", map[string]any{
		"requestId": remoteReqID,
		"answer":    model.Answer{Allow: true},
	}, 200, nil)
	hostB.wait(dRemote.RunID, "completed")

	var pageA model.ChatView
	var wakeRun *model.Run
	waitCond("autoWake remote delegation receipt on Host A", func() bool {
		hostA.request("GET", "/chats/"+chatA.ID, nil, 200, &pageA)
		for i := range pageA.Runs {
			if len(pageA.Runs[i].DelegationReceipts) > 0 {
				r := pageA.Runs[i]
				wakeRun = &r
				return true
			}
		}
		return false
	})
	hostA.wait(wakeRun.ID, "completed")
	if wakeRun.DelegationReceipts[0].DeviceID != hostB.a.Store.DeviceID ||
		wakeRun.DelegationReceipts[0].AgentName != "GPU Builder" ||
		wakeRun.DelegationReceipts[0].Status != "completed" {
		t.Fatalf("unexpected remote delegation receipt: %+v", wakeRun.DelegationReceipts[0])
	}

	// 4. Multi-turn delegate_reply continues the same remote chat & session on Host B,
	//    and verifies cross-device depth = 1 (workerB's delegated session has NO delegation tools even with policy="all").
	workerB.Profile.DelegationPolicy = model.DelegationPolicyAll
	hostB.request("PUT", "/agents/"+workerB.ID, workerB, 200, &workerB)
	_, r2 := runMCPTurn(hostA, chatA.ID, "main", "", mcpCall{
		Name: "delegate_reply",
		Arguments: map[string]any{
			"id": dRemote.ID, "requestKey": "remote-round-2", "message": "[chat-context] []", "autoWake": false,
		},
	})
	if r2.Results[0].Error != "" {
		t.Fatalf("remote delegate_reply failed: %+v", r2.Results[0])
	}
	var dRemote2 model.Delegation
	_ = json.Unmarshal(r2.Results[0].Body, &dRemote2)
	if dRemote2.ChatID != dRemote.ChatID || dRemote2.SessionID != dRemote.SessionID || dRemote2.Turn != 2 {
		t.Fatalf("remote delegate_reply did not continue same remote session: %+v vs %+v", dRemote2, dRemote)
	}
	run2B := hostB.wait(dRemote2.RunID, "completed")
	if len(run2B.Items) > 0 && strings.HasPrefix(run2B.Items[0].Text, "context:") {
		var nestedReceipt mcpTurnReceipt
		if err := json.Unmarshal([]byte(strings.TrimPrefix(run2B.Items[0].Text, "context:")), &nestedReceipt); err != nil {
			t.Fatalf("parse nested receipt: %v", err)
		}
		for _, tool := range nestedReceipt.Tools {
			if strings.HasPrefix(tool, "delegate_") {
				t.Fatalf("remote delegated child must enforce depth=1 and expose no delegation tools, got %v", nestedReceipt.Tools)
			}
		}
	}

	// 5. Turning off allow_delegation on Host B stops auto-accept and leaves new delegations pending in Inbox.
	if _, err := hostB.s.Remote.Manage(t.Context(), remote.Management{
		Action: "allow_delegation", Scope: scopeB, Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}
	var bindingsB []remote.Binding
	hostB.request("POST", "/remote", remote.Management{Action: "status"}, 200, &bindingsB)
	if len(bindingsB) != 1 || bindingsB[0].AllowDelegation {
		t.Fatalf("expected allowDelegation=false after toggle, got %+v", bindingsB)
	}
	_, rPending := runMCPTurn(hostA, chatA.ID, "main", "", mcpCall{
		Name: "delegate_start",
		Arguments: map[string]any{
			"deviceId": hostB.a.Store.DeviceID, "agentId": workerB.ID,
			"requestKey": "pending-when-disabled", "task": "needs manual review", "autoWake": false,
		},
	})
	if rPending.Results[0].Error != "" {
		t.Fatalf("delegate_start with allow_delegation=false failed unexpectedly: %+v", rPending.Results[0])
	}
	var dPending model.Delegation
	_ = json.Unmarshal(rPending.Results[0].Body, &dPending)
	if dPending.RunID != "" {
		t.Fatalf("expected delegation to stay pending (not auto-accepted) when allow_delegation=false, got %+v", dPending)
	}
	var inboxB []p.InboxItem
	waitCond("pending delegation visible in Host B inbox", func() bool {
		hostB.request("POST", "/remote", remote.Management{Action: "inbox", Scope: scopeB}, 200, &inboxB)
		for _, item := range inboxB {
			if item.Intent.Delegation != nil && item.Intent.Delegation.DelegationID == dPending.ID && item.Receipt.Status == "pending" {
				return true
			}
		}
		return false
	})
}
