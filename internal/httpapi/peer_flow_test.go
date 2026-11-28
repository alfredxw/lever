package httpapi_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"

	"lever/internal/eventstream"
	"lever/internal/hub"
	"lever/internal/lanclient"
	"lever/internal/model"
	"lever/internal/multinode"
	"lever/internal/remote"
	p "lever/internal/remoteproto"
)

// A real xterm connection must belong to the remote Owner. Downgrading the
// Owner must close the already-upgraded socket and reject a fresh handshake.
func checkRemoteTerminal(t *testing.T, owner *fixture, scope model.SharedScope, base string, headers http.Header, jar http.CookieJar) {
	t.Helper()
	grant := func(level p.AccessLevel) {
		t.Helper()
		_, err := owner.s.Remote.Manage(t.Context(), remote.Management{Action: "access", Scope: scope, AccessLevel: level})
		if err != nil {
			t.Fatal(err)
		}
	}
	grant(p.AccessAdmin)
	dialer := websocket.Dialer{Jar: jar, HandshakeTimeout: 4 * time.Second}
	target := "ws" + strings.TrimPrefix(base, "http") + "?cols=80&rows=24&start=1&terminalId=" + p.NewID()
	conn, reply, err := dialer.Dial(target, headers)
	if err != nil {
		if reply != nil {
			defer reply.Body.Close()
			t.Fatalf("terminal handshake %s: %v", reply.Status, err)
		}
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(8 * time.Second))
	for {
		kind, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.BinaryMessage {
			_ = conn.WriteJSON(map[string]string{"type": "ack"})
			continue
		}
		var frame struct{ Type, Cwd string }
		if err = json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == "error" {
			t.Fatalf("terminal refused: %s", raw)
		}
		if frame.Type == "ready" {
			canonical, _ := filepath.EvalSymlinks(owner.root)
			if frame.Cwd != canonical {
				t.Fatalf("terminal cwd %q want %q", frame.Cwd, owner.root)
			}
			break
		}
	}
	grant(p.AccessWorkspace)
	_ = conn.SetReadDeadline(time.Now().Add(7 * time.Second))
	for {
		_, _, err = conn.ReadMessage()
		if err != nil {
			var timeout interface{ Timeout() bool }
			if errors.As(err, &timeout) && timeout.Timeout() {
				t.Fatal("live terminal survived permission downgrade")
			}
			break
		}
	}
	other, res, err := dialer.Dial(target, headers)
	if other != nil {
		other.Close()
	}
	if err == nil || res == nil || res.StatusCode != 403 {
		t.Fatalf("downgraded terminal handshake: %v %v", res, err)
	}
	res.Body.Close()
}

func TestPersonalNodeTunnel(t *testing.T) {
	hubDir := t.TempDir()
	h, err := hub.Open(hubDir)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Setup("owner", "personal fixture password"); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(h.Handler(nil))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	call := func(method, path string, body any) (int, []byte) {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(t.Context(), method, server.URL+path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, data
	}
	expect := func(method, path string, body, out any) {
		t.Helper()
		status, data := call(method, path, body)
		if status != 200 {
			t.Fatalf("%s %s: %d %s", method, path, status, data)
		}
		if out != nil {
			if err := json.Unmarshal(data, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	expect("POST", "/api/login", map[string]string{"name": "owner", "password": "personal fixture password"}, nil)
	var account struct{ Spaces []p.Space }
	expect("GET", "/api/me", nil, &account)
	var ticket struct{ Code string }
	expect("POST", "/api/spaces/"+account.Spaces[0].ID+"/tickets", map[string]string{"role": "workstation"}, &ticket)
	f := newFixture(t)
	agent := f.agent("codex")
	older := f.chat(agent)
	scope, err := remote.PairStore(t.Context(), f.a.Store, remote.PairConfig{Link: "leverdevice://pair?hub=" + url.QueryEscape(server.URL) + "&code=" + ticket.Code, Role: p.Workstation})
	if err != nil {
		t.Fatal(err)
	}
	// Wake the local supervisor as the management entry point normally does.
	f.s.Remote.Close()
	f.s.Remote = remote.Start(f.a)
	base := "/api/nodes/" + f.a.Store.DeviceID + "/"
	deadline := time.Now().Add(8 * time.Second)
	for {
		status, data := call("GET", base+"overview", nil)
		if status == 200 && strings.Contains(string(data), older.ID) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("owner overview: %d %s", status, data)
		}
		time.Sleep(30 * time.Millisecond)
	}
	checkRemoteTerminal(t, f, scope, server.URL+base+"agents/"+agent.ID+"/terminal", http.Header{"Origin": {server.URL}}, jar)
	t.Run("create and manage an agent on its Owner", func(t *testing.T) {
		manage := func(in remote.Management) {
			t.Helper()
			in.Scope = scope
			if _, err := f.s.Remote.Manage(t.Context(), in); err != nil {
				t.Fatal(err)
			}
		}
		if status, _ := call("POST", base+"agents", map[string]string{"name": "Unauthorized"}); status != 403 {
			t.Fatalf("workspace creation returned %d", status)
		}
		manage(remote.Management{Action: "access", AccessLevel: p.AccessAdmin})
		defer manage(remote.Management{Action: "access", AccessLevel: p.AccessWorkspace})
		manage(remote.Management{Action: "add_browse_root", Path: f.root})
		var roots []p.BrowseRootInfo
		expect("GET", base+"fs/browse", nil, &roots)
		if len(roots) != 1 || roots[0].ID == "" {
			t.Fatal(roots)
		}
		skill, err := f.a.CreateSkill("peer-test")
		if err != nil {
			t.Fatal(err)
		}
		creation := map[string]any{"name": "Remote agent", "provider": "codex", "rootId": roots[0].ID, "skillIds": []string{skill.ID}}
		var created model.Agent
		expect("POST", base+"agents", creation, &created)
		if created.ID == "" || created.Name != "Remote agent" {
			t.Fatal(created)
		}
		var choices []struct {
			ID       string
			Selected bool
		}
		expect("GET", base+"skills?agent="+created.ID, nil, &choices)
		selected := false
		for _, c := range choices {
			if c.ID == skill.ID && c.Selected {
				selected = true
			}
		}
		if !selected {
			t.Fatal("saved skill missing from remote configuration")
		}
		resource := base + "agents/" + created.ID
		if status, _ := call("PUT", resource, map[string]any{"updatedAt": created.UpdatedAt, "skillIds": []string{p.NewID()}}); status != 400 {
			t.Fatalf("unknown skill returned %d", status)
		}
		if status, _ := call("PUT", resource, map[string]string{"updatedAt": "stale", "name": "Lost edit"}); status != 409 {
			t.Fatalf("stale profile returned %d", status)
		}
		var archived model.Agent
		expect("PUT", resource, map[string]any{"updatedAt": created.UpdatedAt, "name": "Renamed", "archived": true}, &archived)
		if !archived.Archived || archived.Name != "Renamed" {
			t.Fatal(archived)
		}
	})
	var gateway struct {
		Nodes []p.NodeDescriptor
		Chats []model.Chat
	}
	expect("GET", "/api/overview", nil, &gateway)
	if len(gateway.Nodes) != 1 || len(gateway.Chats) != 1 || gateway.Chats[0].NodeID != f.a.Store.DeviceID {
		t.Fatalf("Hub aggregate returned %+v", gateway)
	}
	var view model.ChatView
	expect("GET", base+"chats/"+older.ID+"?limit=1", nil, &view)
	if view.Chat.ID != older.ID {
		t.Fatal(view.Chat)
	}
	send := map[string]string{"commandId": p.NewID(), "chatId": older.ID, "operation": "main", "text": "personal tunnel test"}
	var first, again p.Receipt
	expect("POST", base+"messages", send, &first)
	expect("POST", base+"messages", send, &again)
	if first.RunID == "" || again.RunID != first.RunID {
		t.Fatal(first, again)
	}
	expect("GET", base+"commands/"+send["commandId"], nil, &again)
	f.wait(first.RunID, "completed")
	t.Run("scoped previews and live read cursors", func(t *testing.T) {
		const page = "<p>Owner workspace preview</p>"
		if err := os.WriteFile(filepath.Join(f.root, "preview.html"), []byte(page), 0600); err != nil {
			t.Fatal(err)
		}
		resp, err := client.Get(server.URL + base + "runs/" + first.RunID + "/preview?kind=html&path=preview.html")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/html" || !strings.HasPrefix(resp.Header.Get("Content-Security-Policy"), "sandbox;") || string(body) != page {
			t.Fatalf("scoped preview %d type=%q policy=%q %s", resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("Content-Security-Policy"), body)
		}
		var index p.NodeOverview
		expect("GET", base+"overview", nil, &index)
		var mark model.ReadMark
		for _, c := range index.Conversations {
			if c.ChatID == older.ID && c.Kind == "main" {
				mark = model.ReadMark{SessionID: c.ID, Sequence: c.UnreadSequence}
			}
		}
		if mark.Sequence <= 0 {
			t.Fatal("completed run did not produce an unread cursor")
		}
		stream, err := client.Get(fmt.Sprintf("%s%sevents?chat=%s&after=%d", server.URL, base, older.ID, index.Cursor))
		if err != nil {
			t.Fatal(err)
		}
		defer stream.Body.Close()
		expect("POST", base+"read", map[string]any{"items": []model.ReadMark{mark}}, nil)
		seen := false
		_ = eventstream.Consume(t.Context(), stream.Body, func(record eventstream.Record) error {
			var event model.Event
			if json.Unmarshal(record.Data, &event) == nil && event.Type == "conversation-read" && event.ChatID == older.ID && event.SessionID == mark.SessionID && event.ReadSequence == mark.Sequence {
				seen = true
				return io.EOF
			}
			return nil
		})
		if !seen {
			t.Fatal("the second viewer missed the read cursor")
		}
	})
	yes := true
	if _, err = f.s.Remote.Manage(t.Context(), remote.Management{Scope: scope, Action: "access", RequireApproval: &yes}); err != nil {
		t.Fatal(err)
	}
	if status, _ := call("GET", base+"chats/"+older.ID, nil); status != 403 {
		t.Fatal("unapproved browser read a chat", status)
	}
	manual := false
	if _, err = f.s.Remote.Manage(t.Context(), remote.Management{Scope: scope, Action: "access", RequireApproval: &manual}); err != nil {
		t.Fatal(err)
	}
	// Read back the independently committed native hot window before removing the owner.
	cache, err := sql.Open("sqlite", "file:"+filepath.Join(hubDir, "hub.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	until := time.Now().Add(12 * time.Second)
	for {
		var count int
		err = cache.QueryRow(`SELECT count(*) FROM node_hot_pages p JOIN devices d ON p.space_id=d.space_id AND p.device_id=d.id WHERE p.path=? AND p.epoch=json_extract(d.node,'$.cacheEpoch') AND instr(p.data,?)>0`, "chats/"+older.ID, first.RunID).Scan(&count)
		if err == nil && count == 1 {
			break
		}
		if time.Now().After(until) {
			t.Fatalf("hot window not ready: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	f.s.Remote.Close()
	until = time.Now().Add(5 * time.Second)
	for {
		var off struct{ Node p.NodeDescriptor }
		status, raw := call("GET", base+"overview", nil)
		if status == 200 && json.Unmarshal(raw, &off) == nil && !off.Node.Online {
			break
		}
		if time.Now().After(until) {
			t.Fatalf("offline directory %d %s", status, raw)
		}
		time.Sleep(35 * time.Millisecond)
	}
	expect("GET", base+"chats/"+older.ID, nil, &view)
	found := false
	for _, r := range view.Runs {
		if r.ID == first.RunID {
			found = true
		}
	}
	if !found {
		t.Fatal("offline cache lost the accepted run")
	}
	if status, _ := call("POST", base+"messages", send); status != 503 {
		t.Fatalf("offline write returned %d", status)
	}
	if status, _ := call("GET", base+"chats/"+older.ID+"?before=1", nil); status != 503 {
		t.Fatalf("older offline page returned %d", status)
	}

}

func TestTwoWorkstationsWithoutHub(t *testing.T) {
	owner := newFixture(t)
	controller := newFixture(t)
	source := controller.agent("codex")
	sourceChat := controller.chat(source)
	agent := owner.agent("codex")
	chat := owner.chat(agent)
	raw, err := owner.s.Remote.Manage(t.Context(), remote.Management{Action: "lan_ticket"})
	if err != nil {
		t.Fatal(err)
	}
	ticket := raw.(remote.LANTicketResult)
	_, err = controller.s.Remote.Manage(t.Context(), remote.Management{Action: "pair", Pair: remote.PairConfig{Link: ticket.Link, Role: p.Workstation}})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(12 * time.Second)
	for {
		nodes := controller.s.Remote.Nodes()
		if len(nodes) == 1 && nodes[0].Route == "lan" && len(nodes[0].Chats) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("direct node was not visible: %+v", nodes)
		}
		time.Sleep(40 * time.Millisecond)
	}
	// The single confirmed workstation link authorizes the reverse route too.
	for {
		views := owner.s.Remote.Nodes()
		if len(views) == 1 && len(views[0].Chats) > 0 && views[0].Chats[0].ID == sourceChat.ID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reciprocal workstation route missing: %+v", views)
		}
		time.Sleep(40 * time.Millisecond)
	}
	targets, err := controller.s.Remote.ListRemoteTargets(t.Context(), nil)
	if err != nil || len(targets) != 1 || targets[0].AgentID != agent.ID {
		t.Fatalf("direct delegation target: %+v %v", targets, err)
	}
	dscope := model.SharedScope{HubID: targets[0].HubID, SpaceID: targets[0].SpaceID}
	intent := p.Intent{ID: p.NewID(), Kind: "send", DeviceID: owner.a.Store.DeviceID, AgentID: agent.ID, Operation: "main", Text: "read back delegation", Delegation: &p.DelegationOrigin{Depth: 1, MaxDepth: 3, DeviceID: controller.a.Store.DeviceID, AgentID: source.ID, ChatID: sourceChat.ID, SessionID: p.NewID(), RunID: p.NewID(), DelegationID: p.NewID(), Chain: []string{controller.a.Store.DeviceID + ":" + source.ID}}}
	item, err := controller.s.Remote.SubmitRemoteIntent(t.Context(), dscope, intent)
	if err != nil || item.Receipt.RunID == "" {
		t.Fatalf("LAN delegation: %+v %v", item, err)
	}
	turn, used, err := controller.s.Remote.ReadRemoteRun(t.Context(), dscope, owner.a.Store.DeviceID, item.Receipt.RunID)
	if !used || err != nil || turn.Run.Input != intent.Text {
		t.Fatalf("native delegate result: %+v %v", turn, err)
	}
	var view model.ChatView
	controller.request("GET", "/nodes/"+owner.a.Store.DeviceID+"/chats/"+chat.ID, nil, 200, &view)
	if view.Chat.ID != chat.ID {
		t.Fatal(view.Chat)
	}
	var receipt p.Receipt
	var aggregate struct{ Nodes []p.NodeDescriptor }
	controller.request("GET", "/overview", nil, 200, &aggregate)
	if len(aggregate.Nodes) != 2 {
		t.Fatalf("aggregated owners %d", len(aggregate.Nodes))
	}
	controller.request("POST", "/nodes/"+owner.a.Store.DeviceID+"/messages", map[string]string{"chatId": chat.ID, "commandId": p.NewID(), "operation": "main", "text": "over LAN"}, 200, &receipt)
	if receipt.ChatID != chat.ID || receipt.RunID == "" {
		t.Fatal(receipt)
	}
	controller.request("GET", "/nodes/"+p.NewID()+"/chats/"+chat.ID, nil, 404, nil)
	scope := model.SharedScope{HubID: owner.a.Store.DeviceID, SpaceID: owner.a.Store.DeviceID}
	base := "/nodes/" + owner.a.Store.DeviceID + "/agents/" + agent.ID + "/"
	checkRemoteTerminal(t, owner, scope, controller.s.URL+"/api"+base+"terminal", http.Header{"Origin": {controller.s.URL}, "Cookie": {"lever_session=" + controller.s.Token}}, nil)
	if err = os.WriteFile(filepath.Join(owner.root, "example.txt"), []byte("available"), 0600); err != nil {
		t.Fatal(err)
	}
	var file model.FileContent
	controller.request("GET", base+"file?root=root&path=example.txt", nil, 200, &file)
	controller.request("PUT", base+"file?root=root&path=example.txt", model.FileWrite{RootPath: agent.Profile.Scope.Roots[0].Path, Version: file.Version, Content: "new"}, 200, &file)
	if file.Content != "new" {
		t.Fatal(file)
	}
	yes := true
	if _, err = owner.s.Remote.Manage(t.Context(), remote.Management{Action: "access", Scope: scope, ReadOnlyFS: &yes}); err != nil {
		t.Fatal(err)
	}
	controller.request("PUT", base+"file?root=root&path=example.txt", model.FileWrite{RootPath: agent.Profile.Scope.Roots[0].Path, Version: file.Version, Content: "forbidden"}, 403, nil)
	if _, err = owner.s.Remote.Manage(t.Context(), remote.Management{Action: "local_only", Operation: "chat", ID: chat.ID, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	controller.request("GET", "/nodes/"+owner.a.Store.DeviceID+"/chats/"+chat.ID, nil, 404, nil)

	recent := owner.chat(agent)
	final := owner.send(recent.ID, "main", "", "available offline")
	owner.wait(final.ID, "completed")
	resource := "/nodes/" + owner.a.Store.DeviceID + "/chats/" + recent.ID
	deadline = time.Now().Add(12 * time.Second)
	for {
		controller.request("GET", resource, nil, 200, &view)
		var warmed bool
		if err := controller.a.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM peer_local_pages p JOIN peer_local_index i USING(node_id,epoch) WHERE path=? AND node_id=? AND json_extract(i.data,'$.node.cacheEpoch')=epoch AND NOT EXISTS (SELECT 1 FROM json_each(i.data,'$.chats') WHERE json_extract(value,'$.id')=?))", "chats/"+recent.ID, owner.a.Store.DeviceID, chat.ID).Scan(&warmed); err != nil {
			t.Fatal(err)
		}
		if warmed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no authorized recent LAN page was cached")
		}
		time.Sleep(100 * time.Millisecond)
	}
	owner.s.Remote.Close()
	// Reopen the controller with the same paired database and no live Owner.
	controller.s.Remote.Close()
	controller.s.Remote = remote.Start(controller.a)
	defer controller.s.Remote.Close()
	deadline = time.Now().Add(10 * time.Second)
	for {
		views := controller.s.Remote.Nodes()
		if len(views) == 1 && len(views[0].Chats) > 0 && views[0].Route == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("controller did not recover its offline directory")
		}
		time.Sleep(50 * time.Millisecond)
	}
	view = model.ChatView{}
	controller.request("GET", resource+"?limit=1", nil, 200, &view)
	if len(view.Runs) != 1 || view.Runs[0].ID != final.ID || view.Runs[0].Status != "completed" {
		t.Fatal("lost native offline history")
	}
	controller.request("GET", "/nodes/"+owner.a.Store.DeviceID+"/chats/"+chat.ID, nil, 503, nil)
	controller.request("POST", "/nodes/"+owner.a.Store.DeviceID+"/messages", map[string]string{"chatId": recent.ID, "commandId": p.NewID(), "operation": "main", "text": "must not queue"}, 503, nil)

}

func TestPhonePairsTwoWorkstations(t *testing.T) {
	var slots multinode.Accounts
	var lan lanclient.Client
	hosts := map[string]model.Chat{}
	for i := 0; i < 2; i++ {
		f := newFixture(t)
		agent := f.agent("codex")
		chat := f.chat(agent)
		hosts[f.a.Store.DeviceID] = chat
		raw, err := f.s.Remote.Manage(t.Context(), remote.Management{Action: "lan_ticket"})
		if err != nil {
			t.Fatal(err)
		}
		if err = slots.Pair(t.Context(), raw.(remote.LANTicketResult).Link, "phone", "ios"); err != nil {
			t.Fatal(err)
		}
	}
	var directory multinode.MobileDirectory
	devices := directory.Refresh(t.Context(), slots, &lan, nil)
	if len(devices) != 2 {
		t.Fatal(devices)
	}
	for _, d := range devices {
		if !d.Online {
			t.Fatal("offline", d.ID)
		}
		body, _ := json.Marshal(map[string]string{"commandId": p.NewID(), "chatId": hosts[d.ID].ID, "operation": "main", "text": fmt.Sprintf("from phone to %s", d.ID)})
		raw, ok, err := directory.Request(t.Context(), slots.SpacePath(), "POST", "/api/nodes/"+d.ID+"/messages", string(body))
		var receipt p.Receipt
		if err != nil || !ok || json.Unmarshal(raw, &receipt) != nil || receipt.ChatID != hosts[d.ID].ID {
			t.Fatal(receipt, err)
		}
		checkMobileWorkspace(t, &directory, d.ID, hosts[d.ID])

	}
	peer, err := slots.SelectForRemoval(slots.DirectIDs()[1])
	if err != nil {
		t.Fatal(err)
	}
	if err = multinode.Revoke(t.Context(), &lan, peer); err != nil {
		t.Fatal(err)
	}
	if removed, remaining := slots.Remove(peer); !removed || !remaining || len(slots.DirectIDs()) != 1 || slots.DirectIDs()[0] == peer.Membership.Hub.ID {
		t.Fatal("lost another phone pairing")
	}
	if _, err = lan.HostInfo(t.Context(), peer, peer.Membership.Hub.ID); err == nil {
		t.Fatal("forgotten pairing still authorized by owner")
	}
	if _, err = lan.HostInfo(t.Context(), slots.ClientState, slots.Membership.Hub.ID); err != nil {
		t.Fatal("remaining pairing", err)
	}
	if slots.RemovePrimary() || len(slots.DirectIDs()) != 0 {
		t.Fatal("unpair removed other independent host")
	}
}

func TestManualLANPairRequiresOwnerApproval(t *testing.T) {
	f := newFixture(t)
	yes := true
	_, err := f.s.Remote.Manage(t.Context(), remote.Management{Action: "access", RequireApproval: &yes})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := f.s.Remote.Manage(t.Context(), remote.Management{Action: "lan_ticket"})
	if err != nil {
		t.Fatal(err)
	}
	ticket := raw.(remote.LANTicketResult)
	candidate, err := p.ProbeLANIdentity(t.Context(), ticket.LAN)
	if err != nil || candidate.ID != f.a.Store.DeviceID || ticket.Fingerprint != p.Fingerprint(candidate.PublicKey) || len(ticket.Code) != 6 {
		t.Fatalf("manual identity probe: %v", err)
	}
	var phone multinode.Accounts
	if err = phone.Pair(t.Context(), p.DirectPairLink(ticket.LAN, candidate.ID, candidate.PublicKey, ticket.Code, candidate.Name), "phone", "ios"); err != nil {
		t.Fatal(err)
	}
	var lan lanclient.Client
	if _, err = lan.HostInfo(t.Context(), phone.ClientState, candidate.ID); err == nil {
		t.Fatal("pending controller immediately obtained access")
	}
	_, err = f.s.Remote.Manage(t.Context(), remote.Management{Action: "trust", Scope: ticket.Scope, ControllerID: phone.Membership.DeviceID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = lan.HostInfo(t.Context(), phone.ClientState, candidate.ID); err != nil {
		t.Fatalf("approved controller: %v", err)
	}
}

func checkMobileWorkspace(t *testing.T, directory *multinode.MobileDirectory, node string, chat model.Chat) {
	t.Helper()
	var gateway multinode.MobileWorkspace
	defer gateway.Close()
	link, err := gateway.Open(directory, fstest.MapFS{"hub.html": {Data: []byte("<!doctype html>")}}, node, chat.AgentID, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := url.ParseQuery(u.Fragment)
	base := u.Scheme + "://" + u.Host
	jar, _ := cookiejar.New(nil)
	client := http.Client{Jar: jar, Timeout: 3 * time.Second}
	call := func(method, path, origin string, body any, want int, out any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, err := http.NewRequestWithContext(t.Context(), method, base+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("%s %s: %s", method, path, res.Status)
		}
		if out != nil {
			if err = json.NewDecoder(res.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
	}
	params := map[string]string{"token": secret.Get("token")}
	path := "/api/nodes/" + node + "/overview"
	call("GET", path, "", nil, 403, nil)
	call("POST", "/api/pair", "https://other.invalid", params, 403, nil)
	call("POST", "/api/pair", base, params, 200, nil)
	call("POST", "/api/pair", base, params, 403, nil)
	var view p.NodeOverview
	call("GET", path, "", nil, 200, &view)
	if view.Node.NodeID != node || len(view.Chats) != 1 || view.Chats[0].ID != chat.ID {
		t.Fatal("workspace routed to a different device")
	}
	call("GET", "/api/nodes/"+p.NewID()+"/overview", "", nil, 403, nil)
}

func TestMobileTerminalSession(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	result, err := f.s.Remote.Manage(t.Context(), remote.Management{Action: "lan_ticket"})
	if err != nil {
		t.Fatal(err)
	}
	ticket := result.(remote.LANTicketResult)
	var accounts multinode.Accounts
	if err = accounts.Pair(t.Context(), ticket.Link, "fixture phone", "ios"); err != nil {
		t.Fatal(err)
	}
	var directory multinode.MobileDirectory
	var lan lanclient.Client
	var gateway multinode.MobileTerminal
	defer gateway.Close()
	args := multinode.TerminalRequest{Node: f.a.Store.DeviceID, Agent: agent.ID, TerminalID: p.NewID(), Cols: 80, Rows: 24}
	grant := func(level p.AccessLevel) {
		t.Helper()
		if _, err := f.s.Remote.Manage(t.Context(), remote.Management{Scope: ticket.Scope, Action: "access", AccessLevel: level}); err != nil {
			t.Fatal(err)
		}
		directory.Refresh(t.Context(), accounts, &lan, nil)
	}
	grant(p.AccessChat)
	if _, err = gateway.Open(&directory, args); err == nil {
		t.Fatal("chat-only node offered a terminal")
	}
	grant(p.AccessAdmin)
	target, err := gateway.Open(&directory, args)
	if err != nil {
		t.Fatal(err)
	}
	dialer := websocket.Dialer{HandshakeTimeout: 4 * time.Second}
	rejected := func(header http.Header) {
		t.Helper()
		conn, resp, err := dialer.DialContext(t.Context(), target, header)
		if conn != nil {
			conn.Close()
		}
		if err == nil || resp == nil || resp.StatusCode != 403 {
			t.Fatalf("unexpected handshake %v", err)
		}
		resp.Body.Close()
	}
	rejected(http.Header{"Origin": {"http://localhost"}})
	conn, _, err := dialer.DialContext(t.Context(), target, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(6 * time.Second))
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.BinaryMessage {
			if err = conn.WriteJSON(map[string]string{"type": "ack"}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		var control struct{ Type, Cwd string }
		if err = json.Unmarshal(data, &control); err != nil {
			t.Fatal(err)
		}
		if control.Type == "error" {
			t.Fatalf("terminal not ready: %s", data)
		}
		if control.Type == "ready" {
			root, _ := filepath.EvalSymlinks(f.root)
			if control.Cwd != root {
				t.Fatal("terminal opened outside the intended agent")
			}
			break
		}
	}
	rejected(nil)
	// A burst larger than the eight-frame window must drain through ACKs.
	if err = conn.WriteMessage(websocket.BinaryMessage, []byte("seq 1 50000; printf '\\nLEVER%s\\n' COMPLETE\r")); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(12 * time.Second))
	var transcript bytes.Buffer
	frames := 0
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind != websocket.BinaryMessage {
			continue
		}
		start := max(0, transcript.Len()-24)
		transcript.Write(data)
		frames++
		if err = conn.WriteJSON(map[string]string{"type": "ack"}); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(transcript.Bytes()[start:], []byte("LEVERCOMPLETE")) {
			break
		}
	}
	if frames <= 8 || transcript.Len() < 250000 {
		t.Fatalf("incomplete PTY output: %d frames, %d bytes", frames, transcript.Len())
	}
	u, _ := url.Parse(target)
	gateway.CloseHost(u.Host)
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, _, err = conn.ReadMessage()
		if err != nil {
			var timeout interface{ Timeout() bool }
			if errors.As(err, &timeout) && timeout.Timeout() {
				t.Fatal("closing native proxy left socket open")
			}
			break
		}
	}
	// The binary path must return the original bytes under the same node grant.
	raw := []byte("native attachment fixture")
	attachment := f.upload(chat.ID, "fixture.txt", raw)
	got, _, err := directory.Attachment(t.Context(), args.Node, attachment.ID)
	if err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("attachment round trip: %v", err)
	}
}
