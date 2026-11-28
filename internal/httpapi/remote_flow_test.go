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
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/hub"
	"lever/internal/model"
	"lever/internal/remote"
	p "lever/internal/remoteproto"
)

func TestRemoteTaskAndArchive(t *testing.T) {
	h, err := hub.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Setup("owner", "a test-only password"); err != nil {
		t.Fatal(err)
	}
	var dropAcceptance atomic.Bool
	handler := h.Handler(fstest.MapFS{"hub.html": {Data: []byte("Lever Hub")}})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.Contains(r.URL.Path, "/inbox/") && dropAcceptance.Load() {
			raw, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "read error", 500)
				return
			}
			r.Body.Close()
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var rec p.Receipt
			_ = json.Unmarshal(raw, &rec)
			if rec.Status == "accepted" && dropAcceptance.CompareAndSwap(true, false) {
				http.Error(w, "simulated disconnect before receipt commit", 503)
				return
			}
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	request := func(method, path string, input any, status int, out any) {
		t.Helper()
		b, _ := json.Marshal(input)
		r, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != status {
			t.Fatalf("%s %s: %d: %s", method, path, resp.StatusCode, raw)
		}
		if out != nil {
			if err = json.Unmarshal(raw, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	request("POST", "/api/login", map[string]string{"name": "owner", "password": "a test-only password"}, 200, nil)
	var account struct{ Spaces []p.Space }
	request("GET", "/api/me", nil, 200, &account)
	space := account.Spaces[0].ID
	root := "/api/spaces/" + space
	ticket := func(role p.Role) string {
		var v struct{ Code string }
		request("POST", root+"/tickets", map[string]p.Role{"role": role}, 200, &v)
		return v.Code
	}
	f := newFixture(t)
	defer func() { f.s.Remote.Close() }()
	agent := f.agent("codex")
	private := f.chat(agent)
	var scope model.SharedScope
	f.request("POST", "/remote", remote.Management{Action: "pair", Pair: remote.PairConfig{Hub: server.URL, Code: ticket(p.Workstation), Role: p.Workstation, Name: "Workstation A"}}, 200, &scope)
	ctx := t.Context()
	manage := func(in remote.Management) {
		t.Helper()
		if _, err := f.s.Remote.Manage(ctx, in); err != nil {
			t.Fatal(err)
		}
	}
	// This recovery scenario exercises a Host that requires local approval.
	requireApproval := true
	manage(remote.Management{Action: "access", Scope: scope, RequireApproval: &requireApproval})
	manage(remote.Management{Action: "expose_all", Scope: scope, Enabled: false})
	manage(remote.Management{Action: "expose", Scope: scope, AgentID: agent.ID})
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pi := p.PairInput{Code: ticket(p.Executor), Role: p.Executor, Identity: p.Identity{ID: p.NewID(), PublicKey: pub}, Name: "Headless C", Platform: "test"}
	c, err := p.Pair(ctx, server.URL, pi, priv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Pair(ctx, server.URL, pi, priv); err == nil {
		t.Fatal("pairing ticket reused")
	}
	if err = c.Do(ctx, "GET", root+"/devices", nil, nil); err == nil {
		t.Fatal("executor read directory")
	}
	request("GET", "/api/spaces/"+p.NewID()+"/tasks", nil, 403, nil)
	archive := root + "/archive/" + f.a.Store.DeviceID
	wait := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			time.Sleep(30 * time.Millisecond)
		}
		t.Fatal("timed out waiting for shared state")
	}
	wait(func() bool {
		var rec []p.Record
		request("GET", archive, nil, 200, &rec)
		return len(rec) == 1 && rec[0].ID == agent.ID
	})
	archiveBytes := func() string { var v json.RawMessage; request("GET", archive, nil, 200, &v); return string(v) }
	if raw := archiveBytes(); strings.Contains(raw, "profile-v1") || strings.Contains(raw, f.root) || strings.Contains(raw, private.ID) {
		t.Fatal("private data in archive", raw)
	}
	var task p.Task
	request("POST", root+"/tasks", map[string]any{"id": p.NewID(), "title": "Shared task", "body": "fixture text"}, 200, &task)
	dID := p.NewID()
	dispatch := map[string]any{"commandId": dID, "version": task.Version, "agentId": agent.ID, "deviceId": f.a.Store.DeviceID}
	target := root + "/tasks/" + task.ID
	// Independent controllers race the same task version. Only the winner
	// can advance the task, and it can safely resend the exact dispatch.
	type attempt struct {
		id     string
		status int
		err    error
	}
	completed := make(chan attempt, 2)
	for _, id := range []string{dID, p.NewID()} {
		go func() {
			input := map[string]any{"commandId": id, "version": task.Version, "agentId": agent.ID, "deviceId": f.a.Store.DeviceID}
			body, _ := json.Marshal(input)
			resp, err := client.Post(server.URL+target+"/dispatch", "application/json", bytes.NewReader(body))
			if err != nil {
				completed <- attempt{id: id, err: err}
				return
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			completed <- attempt{id: id, status: resp.StatusCode}
		}()
	}
	wins := 0
	for range 2 {
		v := <-completed
		if v.err != nil {
			t.Fatal(v.err)
		}
		switch v.status {
		case 200:
			wins++
			dID = v.id
		case 409:
		default:
			t.Fatal(v)
		}
	}
	if wins != 1 {
		t.Fatalf("concurrent dispatches accepted: %d", wins)
	}
	dispatch["commandId"] = dID
	request("POST", target+"/dispatch", dispatch, 200, nil)
	dispatch["text"] = "changed"
	request("POST", target+"/dispatch", dispatch, 409, nil)
	dropAcceptance.Store(true)
	_, err = f.s.Remote.Manage(ctx, remote.Management{Scope: scope, Action: "accept", ID: dID})
	if err == nil || dropAcceptance.Load() {
		t.Fatal("failed to simulate lost receipt")
	}
	f.s.Remote.Close()
	f.s.Remote = remote.Start(f.a)
	type detail struct {
		Task    p.Task
		History []p.Dispatch
	}
	var state detail
	wait(func() bool { request("GET", target, nil, 200, &state); return state.Task.Status == "review" })
	d := state.History[0]
	if len(state.History) != 1 || d.RunID == "" {
		t.Fatal(state)
	}
	var n int
	if err = f.a.Store.DB.QueryRow("SELECT count(*) FROM runs WHERE chat_id=?", d.ChatID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("run count %d: %v", n, err)
	}
	request("POST", target+"/accept", map[string]any{"version": state.Task.Version, "runId": p.NewID()}, 409, nil)
	request("POST", target+"/accept", map[string]any{"version": state.Task.Version, "runId": d.RunID}, 200, nil)
	t.Run("personal phone sends and answers without a second operator", func(t *testing.T) {
		phonePub, phoneKey, _ := ed25519.GenerateKey(rand.Reader)
		phone, err := p.Pair(ctx, server.URL, p.PairInput{Code: ticket(p.Controller), Role: p.Controller, Name: "Phone", Platform: "ios", Identity: p.Identity{ID: p.NewID(), PublicKey: phonePub}}, phoneKey)
		if err != nil {
			t.Fatal(err)
		}
		manage(remote.Management{Action: "trust", Scope: scope, ControllerID: phone.Membership.DeviceID})
		for _, kind := range []string{"send", "answer"} {
			manage(remote.Management{Action: "permission", Scope: scope, ControllerID: phone.Membership.DeviceID, AgentID: agent.ID, Operation: kind, Enabled: true})
		}
		submit := func(intent p.Intent) {
			t.Helper()
			if err := phone.Do(ctx, "POST", root+"/commands", intent, nil); err != nil {
				t.Fatal(err)
			}
		}
		receipt := func(id, status string) p.Receipt {
			t.Helper()
			var item p.InboxItem
			wait(func() bool {
				return phone.Do(ctx, "GET", root+"/commands/"+f.a.Store.DeviceID+"/"+id, nil, &item) == nil && item.Receipt.Status == status
			})
			return item.Receipt
		}
		send := p.Intent{ID: p.NewID(), Kind: "send", Operation: "main", DeviceID: f.a.Store.DeviceID, AgentID: agent.ID, Text: "[approval] from phone"}
		manage(remote.Management{Action: "lan", Scope: scope, Enabled: true})
		var grant struct{ Grant string }
		if err := phone.Do(ctx, "GET", root+"/devices/"+send.DeviceID+"/lan", nil, &grant); err != nil {
			t.Fatal(err)
		}
		lan := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			accepted := httptest.NewRecorder()
			f.s.Remote.ServeLAN(accepted, r)
			var item p.InboxItem
			if accepted.Code != 200 || json.Unmarshal(accepted.Body.Bytes(), &item) != nil || item.Receipt.Status != "accepted" {
				t.Errorf("LAN did not commit before disconnect: %d %s", accepted.Code, accepted.Body.String())
			}
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
		}))
		defer lan.Close()
		wire := p.LANCommand{HubID: scope.HubID, SpaceID: space, Intent: send}
		wire.Intent.ActorUserID = phone.Membership.UserID
		wire.Intent.OriginDeviceID = phone.Membership.DeviceID
		wire.Sign(phone.Key)
		raw, _ := json.Marshal(wire)
		req, _ := http.NewRequestWithContext(ctx, "POST", lan.URL+"/commands", bytes.NewReader(raw))
		p.Sign(req, grant.Grant, phone.Key, raw)
		if err := p.Exchange(lan.Client(), req, nil); err == nil {
			t.Fatal("expected lost LAN reply")
		}
		// Retry over the authenticated Hub route with the original intent ID.
		submit(send)
		sent := receipt(send.ID, "accepted")
		submit(send)
		if dup := receipt(send.ID, "accepted"); dup.RunID != sent.RunID {
			t.Fatalf("duplicate run: %v", dup)
		}
		waitRequest := func(run p.Receipt, status string) p.Record {
			t.Helper()
			var record p.Record
			wait(func() bool {
				var rows []p.Record
				request("GET", archive+"?chat="+run.ChatID, nil, 200, &rows)
				for _, r := range rows {
					if r.Kind == "request" && r.RunID == run.RunID && r.Status == status {
						record = r
						return true
					}
				}
				return false
			})
			return record
		}
		approval := waitRequest(sent, "pending")
		answer := p.Intent{ID: p.NewID(), Kind: "answer", DeviceID: send.DeviceID, ChatID: sent.ChatID, RunID: sent.RunID, RequestID: approval.ID, Answer: &p.Answer{Allow: true}}
		for _, o := range approval.Options {
			if o.Allow {
				answer.Answer.OptionID = o.ID
				break
			}
		}
		submit(answer)
		receipt(answer.ID, "accepted")
		submit(answer)
		receipt(answer.ID, "accepted")
		stale := answer
		stale.ID = p.NewID()
		stale.Answer = &p.Answer{Allow: false}
		submit(stale)
		receipt(stale.ID, "failed")
		if r := waitRequest(sent, "answered"); r.AnsweredByUserID != phone.Membership.UserID || r.Answer == nil || !r.Answer.Allow {
			t.Fatal("phone answer changed after retry", r)
		}
		if err := f.a.Store.DB.QueryRow("SELECT count(*) FROM runs WHERE chat_id=?", sent.ChatID).Scan(&n); err != nil || n != 1 {
			t.Fatal(n, err)
		}
		send.ID = p.NewID()
		submit(send)
		second := receipt(send.ID, "accepted")
		card := waitRequest(second, "pending")
		if err := f.a.Answer(ctx, card.ID, model.Answer{Allow: false}); err != nil {
			t.Fatal(err)
		}
		late := answer
		late.ID, late.RequestID, late.RunID, late.ChatID = p.NewID(), card.ID, second.RunID, second.ChatID
		submit(late)
		receipt(late.ID, "failed")
		if r := waitRequest(second, "answered"); r.AnsweredByUserID != "" || r.Answer == nil || r.Answer.Allow {
			t.Fatal("old phone notification replaced the desktop answer", r)
		}
		manage(remote.Management{Action: "untrust", Scope: scope, ControllerID: phone.Membership.DeviceID})
		send.ID = p.NewID()
		submit(send)
		receipt(send.ID, "pending")
		var count int
		if err := f.a.Store.DB.QueryRow("SELECT count(*) FROM remote_control_permissions WHERE controller=?", phone.Membership.DeviceID).Scan(&count); err != nil || count != 0 {
			t.Fatal("permissions survived revocation", count, err)
		}
	})
	t.Run("expose_all and device wildcard scope include newly created agents automatically", func(t *testing.T) {
		phonePub, phoneKey, _ := ed25519.GenerateKey(rand.Reader)
		phone, err := p.Pair(ctx, server.URL, p.PairInput{Code: ticket(p.Controller), Role: p.Controller, Name: "Lever", Platform: "ios", Identity: p.Identity{ID: p.NewID(), PublicKey: phonePub}}, phoneKey)
		if err != nil {
			t.Fatal(err)
		}
		manage(remote.Management{Action: "expose_all", Scope: scope, Enabled: true})
		manage(remote.Management{Action: "trust", Scope: scope, ControllerID: phone.Membership.DeviceID})
		manage(remote.Management{Action: "set_permissions", Scope: scope, ControllerID: phone.Membership.DeviceID, AllAgents: true, Operations: []string{"send", "answer"}})
		// Create a brand new Agent AFTER configuring expose_all and device wildcard permissions.
		fresh := f.agent("codex")
		wait(func() bool {
			var rec []p.Record
			request("GET", archive, nil, 200, &rec)
			for _, v := range rec {
				if v.Kind == "agent" && v.ID == fresh.ID {
					return true
				}
			}
			return false
		})
		// Phone can immediately send to the new Agent without touching settings again.
		cmd := p.Intent{ID: p.NewID(), Kind: "send", Operation: "main", DeviceID: f.a.Store.DeviceID, AgentID: fresh.ID, Text: "auto exposed hello"}
		if err := phone.Do(ctx, "POST", root+"/commands", cmd, nil); err != nil {
			t.Fatal(err)
		}
		wait(func() bool {
			var item p.InboxItem
			return phone.Do(ctx, "GET", root+"/commands/"+f.a.Store.DeviceID+"/"+cmd.ID, nil, &item) == nil && item.Receipt.Status == "accepted"
		})
		// Narrow phone scope to ONLY original `agent.ID`; `fresh.ID` must require manual confirmation.
		manage(remote.Management{Action: "set_permissions", Scope: scope, ControllerID: phone.Membership.DeviceID, AllAgents: false, AgentIDs: []string{agent.ID}, Operations: []string{"send"}})
		cmd2 := p.Intent{ID: p.NewID(), Kind: "send", Operation: "main", DeviceID: f.a.Store.DeviceID, AgentID: fresh.ID, Text: "should stay pending"}
		if err := phone.Do(ctx, "POST", root+"/commands", cmd2, nil); err != nil {
			t.Fatal(err)
		}
		wait(func() bool {
			var item p.InboxItem
			return phone.Do(ctx, "GET", root+"/commands/"+f.a.Store.DeviceID+"/"+cmd2.ID, nil, &item) == nil && item.Receipt.Status == "pending"
		})
		// Turn off expose_all: `fresh` (not in hub_exposed_agents) disappears from archive while `agent` remains.
		manage(remote.Management{Action: "expose_all", Scope: scope, Enabled: false})
		wait(func() bool {
			var rec []p.Record
			request("GET", archive, nil, 200, &rec)
			hasOrig, hasFresh := false, false
			for _, v := range rec {
				if v.Kind == "agent" && v.ID == agent.ID {
					hasOrig = true
				}
				if v.Kind == "agent" && v.ID == fresh.ID {
					hasFresh = true
				}
			}
			return hasOrig && !hasFresh
		})
		manage(remote.Management{Action: "untrust", Scope: scope, ControllerID: phone.Membership.DeviceID})
	})
	manage(remote.Management{Scope: scope, Action: "hide", AgentID: agent.ID})
	wait(func() bool {
		var rec []p.Record
		request("GET", archive, nil, 200, &rec)
		for _, v := range rec {
			if v.Kind == "agent" {
				return false
			}
		}
		return true
	})
	if strings.Contains(archiveBytes(), private.ID) {
		t.Fatal("private chat appeared")
	}
	request("DELETE", root+"/devices/"+c.Membership.DeviceID, nil, 200, nil)
	if err = c.Do(ctx, "GET", "/api/me", nil, nil); err == nil {
		t.Fatal("revoked token accepted")
	}
}
