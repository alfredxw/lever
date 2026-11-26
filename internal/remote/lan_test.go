package remote

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/lanclient"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func TestLANPrivateSelectionAndSharedReceipt(t *testing.T) {
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := &Host{App: &app.App{Store: s}}
	ctx := t.Context()
	hp, hk, _ := ed25519.GenerateKey(rand.Reader)
	cp, ck, _ := ed25519.GenerateKey(rand.Reader)
	m := p.Membership{Hub: p.Identity{ID: p.NewID(), PublicKey: hp}, DeviceID: s.DeviceID, SpaceID: p.NewID(), UserID: p.NewID(), Role: p.Workstation, Token: p.Token()}
	g := p.Grant{HubID: m.Hub.ID, SpaceID: m.SpaceID, Controller: p.Identity{ID: p.NewID(), PublicKey: cp}, Host: p.Identity{ID: s.DeviceID, PublicKey: hp}, UserID: m.UserID, Policy: 7, Expires: time.Now().Add(4 * time.Minute).Unix()}
	scope := model.SharedScope{HubID: m.Hub.ID, SpaceID: m.SpaceID}
	privateID, sharedID := p.NewID(), p.NewID()
	err = s.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO remote_memberships(hub,space,origin,credential,epoch,policy,lan) VALUES(?,?,?,?,?,7,1)", m.Hub.ID, m.SpaceID, "http://127.0.0.1", store.JSON(m), p.NewID()); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO agents(id,data) VALUES('test-agent',?)", store.JSON(model.Agent{ID: "test-agent", Name: "A"})); err != nil {
			return err
		}
		for _, c := range []model.Chat{{ID: privateID, Title: "offline-only"}, {ID: sharedID, Title: "shared", SharedScope: &scope}} {
			c.AgentID = "test-agent"
			if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", c.ID, c.AgentID, store.JSON(c)); err != nil {
				return err
			}
		}
		_, err := tx.Exec("INSERT INTO remote_private_chats VALUES(?,?,?,?)", m.Hub.ID, m.SpaceID, g.Controller.ID, privateID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	token := p.IssueGrant(g, hk)
	call := func(method, path string, body []byte, status int) []byte {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		p.Sign(r, token, ck, body)
		w := httptest.NewRecorder()
		h.ServeLAN(w, r)
		if w.Code != status {
			t.Fatalf("%s %d: %s", path, w.Code, w.Body.String())
		}
		return w.Body.Bytes()
	}
	if b := call("GET", "/private", nil, 200); !bytes.Contains(b, []byte(privateID)) || bytes.Contains(b, []byte(sharedID)) {
		t.Fatal("private index scope")
	}
	if b := call("GET", "/archive", nil, 200); bytes.Contains(b, []byte(privateID)) || !bytes.Contains(b, []byte(sharedID)) {
		t.Fatal("shared index scope")
	}
	submit := func(private bool, chat string) p.LANCommand {
		cmd := p.LANCommand{HubID: g.HubID, SpaceID: g.SpaceID, Intent: p.Intent{Private: private, ID: p.NewID(), Kind: "send", DeviceID: s.DeviceID, ActorUserID: m.UserID, OriginDeviceID: g.Controller.ID, ChatID: chat, Operation: "main", Text: "draft"}}
		cmd.Sign(ck)
		body, _ := json.Marshal(cmd)
		call("POST", "/commands", body, 200)
		call("POST", "/commands", body, 200)
		return cmd
	}
	priv := submit(true, privateID)
	shared := submit(false, sharedID)
	changed := shared
	changed.Intent.Text = "different"
	changed.Sign(ck)
	b, _ := json.Marshal(changed)
	call("POST", "/commands", b, 409)
	inbox, err := h.lanInbox(ctx, scope)
	if err != nil || len(inbox) != 2 {
		t.Fatal(inbox, err)
	}
	var sent []p.LANReport
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), privateID) || strings.Contains(string(body), priv.Intent.ID) {
			t.Error("private data published")
		}
		var report p.LANReport
		if err := json.Unmarshal(body, &report); err != nil {
			t.Error(err)
		}
		sent = append(sent, report)
		w.Write([]byte("true"))
	}))
	defer server.Close()
	if _, _, err = h.reviewLAN(ctx, Management{Scope: scope, ID: shared.Intent.ID, Action: "decline"}); err != nil {
		t.Fatal(err)
	}
	st := p.ClientState{Origin: server.URL, Key: hk, Membership: m}
	if err = h.publishLAN(ctx, st); err != nil {
		t.Fatal(err)
	}
	if err = h.publishLAN(ctx, st); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0].Command.Intent.ID != shared.Intent.ID || sent[0].Receipt.Status != "declined" {
		t.Fatal(sent)
	}
	if _, err = s.DB.Exec("UPDATE remote_memberships SET policy=8"); err != nil {
		t.Fatal(err)
	}
	call("GET", "/private", nil, 403)
	if _, _, err = h.reviewLAN(ctx, Management{Scope: scope, ID: priv.Intent.ID, Action: "accept"}); err == nil {
		t.Fatal("revoked local authorization accepted")
	}
	g.Policy = 8
	g.Expires = time.Now().Add(-24 * time.Hour).Unix()
	token = p.IssueGrant(g, hk)
	call("GET", "/archive", nil, 403)
	if _, err = s.DB.Exec("INSERT INTO remote_trusted_controllers VALUES(?,?,?,?,?)", m.Hub.ID, m.SpaceID, g.Controller.ID, []byte(cp), "phone"); err != nil {
		t.Fatal(err)
	}
	var first p.ArchivePage
	if err = json.Unmarshal(call("GET", "/archive?sync=1", nil, 200), &first); err != nil || !first.Full || first.Cursor.Stream != "lan" {
		t.Fatal(first, err)
	}
	path := "/archive?sync=1&stream=lan&epoch=" + first.Cursor.Epoch + "&version=" + strconv.FormatInt(first.Cursor.Version, 10)
	var next p.ArchivePage
	if err = json.Unmarshal(call("GET", path, nil, 200), &next); err != nil || next.Full || len(next.Changes) != 0 {
		t.Fatal(next, err)
	}
	topic := model.Session{ID: p.NewID(), ChatID: sharedID, Kind: "topic"}
	if _, err = s.DB.Exec("INSERT INTO sessions(id,chat_id,kind,data) VALUES(?,?,?,?)", topic.ID, sharedID, topic.Kind, store.JSON(topic)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("DELETE FROM sessions WHERE id=?", topic.ID); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(call("GET", path+"&chat="+p.NewID(), nil, 200), &next); err != nil || next.Full || len(next.Changes) != 0 {
		t.Fatal("a different chat received this topic deletion", next, err)
	}
	if err = json.Unmarshal(call("GET", path+"&chat="+sharedID, nil, 200), &next); err != nil || next.Full || len(next.Changes) != 1 || !next.Changes[0].Deleted || next.Changes[0].ID != topic.ID {
		t.Fatal("missing topic deletion", next, err)
	}
	path = "/archive?sync=1&stream=lan&epoch=" + next.Cursor.Epoch + "&version=" + strconv.FormatInt(next.Cursor.Version, 10)
	if _, err = s.DB.Exec("DELETE FROM chats WHERE id=?", sharedID); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(call("GET", path, nil, 200), &next); err != nil || next.Full || len(next.Changes) != 1 || !next.Changes[0].Deleted || next.Changes[0].ID != sharedID {
		t.Fatal(next, err)
	}
	r := httptest.NewRequest("GET", "/archive", nil)
	p.Sign(r, token, ck, nil)
	for _, want := range []int{200, 403} {
		w := httptest.NewRecorder()
		h.ServeLAN(w, r)
		if w.Code != want {
			t.Fatal("replayed proof", w.Code, want)
		}
	}
	if _, err = s.DB.Exec("DELETE FROM remote_trusted_controllers"); err != nil {
		t.Fatal(err)
	}
	call("GET", "/archive", nil, 403)
}

func TestDirectLANPairingWithoutHub(t *testing.T) {
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := &Host{App: &app.App{Store: s}, configChanged: make(chan struct{}, 1), lanTickets: map[string]int64{}}
	defer func() { _, _ = h.syncLAN(false) }()
	ctx := t.Context()

	// Create an existing local Agent and an existing local (non-shared) desktop Chat before pairing.
	if err := s.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO agents(id,data) VALUES('agent-local',?)", store.JSON(model.Agent{ID: "agent-local", Name: "Local Coder"})); err != nil {
			return err
		}
		chat := model.Chat{ID: "chat-local", AgentID: "agent-local", Title: "MacBook 本地历史对话"}
		_, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES(?,?,?)", chat.ID, chat.AgentID, store.JSON(chat))
		return err
	}); err != nil {
		t.Fatal(err)
	}

	// 1. Issue a direct LAN pairing ticket with ZERO Hub configured.
	rawTicket, err := h.Manage(ctx, Management{Action: "lan_ticket"})
	if err != nil {
		t.Fatal(err)
	}
	ticket := rawTicket.(LANTicketResult)
	if ticket.Link == "" || ticket.LAN == "" || ticket.Code == "" {
		t.Fatalf("incomplete direct LAN ticket: %+v", ticket)
	}

	// 2. Parse the QR link and pair directly over TLS 1.3 without any Hub.
	params, isDirect, err := p.ParseDirectPairLink(ticket.Link)
	if err != nil || !isDirect {
		t.Fatalf("ParseDirectPairLink failed: isDirect=%v err=%v", isDirect, err)
	}
	phonePub, phoneKey, _ := ed25519.GenerateKey(rand.Reader)
	phoneID := p.NewID()
	st, receipt, err := p.PairDirect(ctx, params, p.PairInput{
		Identity: p.Identity{ID: phoneID, PublicKey: phonePub},
		Name:     "iPhone 16",
		Platform: "ios",
		Role:     p.Controller,
	}, phoneKey)
	if err != nil {
		t.Fatalf("PairDirect failed: %v", err)
	}
	if !st.IsDirect() || receipt.Grant == "" || receipt.Host.ID != s.DeviceID {
		t.Fatalf("unexpected direct pairing result: st=%+v receipt=%+v", st, receipt)
	}

	// 3. Reusing the one-time code must be rejected.
	if _, _, err := p.PairDirect(ctx, params, p.PairInput{
		Identity: p.Identity{ID: p.NewID(), PublicKey: phonePub},
		Name:     "Replay",
		Platform: "ios",
		Role:     p.Controller,
	}, phoneKey); err == nil {
		t.Fatal("reused direct LAN ticket was accepted")
	}

	// 4. Read host info, shared archive (exposed agents), and local desktop private chats directly over LAN.
	grants := map[string]string{
		st.Membership.Hub.ID + "/" + st.Membership.SpaceID + "/" + st.Membership.DeviceID + "/" + s.DeviceID: receipt.Grant,
	}
	client := &lanclient.Client{
		LoadGrant: func(key string) string { return grants[key] },
	}
	hostDev, err := client.HostInfo(ctx, st, s.DeviceID)
	if err != nil || !hostDev.Online || hostDev.ID != s.DeviceID {
		t.Fatalf("HostInfo failed: %+v err=%v", hostDev, err)
	}
	archRaw, ok, err := client.Local(ctx, st, "GET", st.SpacePath()+"/archive/"+s.DeviceID, nil)
	if err != nil || !ok || !bytes.Contains(archRaw, []byte("agent-local")) {
		t.Fatalf("direct archive missing auto-exposed agent: ok=%v err=%v body=%s", ok, err, archRaw)
	}
	privRaw, ok, err := client.Local(ctx, st, "GET", st.SpacePath()+"/private-archive/"+s.DeviceID, nil)
	if err != nil || !ok || !bytes.Contains(privRaw, []byte("chat-local")) {
		t.Fatalf("direct private archive missing local desktop chat: ok=%v err=%v body=%s", ok, err, privRaw)
	}

	// 5. Revoking trust on the Host immediately revokes direct LAN access with no Hub needed.
	if _, err := h.Manage(ctx, Management{Action: "untrust", Scope: ticket.Scope, ControllerID: phoneID}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.HostInfo(ctx, st, s.DeviceID); err == nil {
		t.Fatal("revoked direct controller was still allowed")
	}
}

func TestDirectLANReadStateBidirectionalSync(t *testing.T) {
	s, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := &app.App{Store: s}
	h := &Host{App: a}
	ctx := t.Context()
	defer h.syncLAN(false)

	err = s.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec("INSERT INTO agents(id,data) VALUES('agent-sync',?)", store.JSON(model.Agent{ID: "agent-sync", Name: "代码搭档"})); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO chats(id,agent_id,data) VALUES('chat-sync','agent-sync',?)", store.JSON(model.Chat{ID: "chat-sync", AgentID: "agent-sync", Title: "主对话"})); err != nil {
			return err
		}
		mainActivity := store.JSON(model.Conversation{ID: "sess-main", ChatID: "chat-sync", AgentID: "agent-sync", Kind: "main", Title: "主对话", Preview: "桌面已读的回复", MessageAt: "2026-11-26T10:00:00Z", UnreadSequence: 42})
		topicActivity := store.JSON(model.Conversation{ID: "sess-topic", ChatID: "chat-sync", AgentID: "agent-sync", Kind: "topic", Title: "修复导出冲突", Preview: "等待审批命令", MessageAt: "2026-11-26T10:01:00Z", UnreadSequence: 55})
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data,activity) VALUES('sess-main','chat-sync','main',?,?)",
			store.JSON(model.Session{ID: "sess-main", ChatID: "chat-sync", AgentID: "agent-sync", Kind: "main"}), mainActivity); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO sessions(id,chat_id,kind,data,activity) VALUES('sess-topic','chat-sync','topic',?,?)",
			store.JSON(model.Session{ID: "sess-topic", ChatID: "chat-sync", AgentID: "agent-sync", Kind: "topic", Title: "修复导出冲突"}), topicActivity); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO runs(id,session_id,chat_id,agent_id,command_id,input_hash,status,data) VALUES('run-t1','sess-topic','chat-sync','agent-sync','cmd-1','h1','waiting_user',?)",
			store.JSON(model.Run{ID: "run-t1", SessionID: "sess-topic", ChatID: "chat-sync", AgentID: "agent-sync", Status: "waiting_user", Input: "跑 race 测试"})); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO requests(id,run_id,chat_id,status,data) VALUES('req-1','run-t1','chat-sync','pending',?)",
			store.JSON(model.Request{ID: "req-1", RunID: "run-t1", ChatID: "chat-sync", SessionID: "sess-topic", Status: "pending", Kind: "approval", Title: "go test -race"})); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Desktop reads main session -> persisted in Host SQLite.
	if err := a.MarkSessionsRead(ctx, []model.ReadMark{{SessionID: "sess-main", Sequence: 42}}); err != nil {
		t.Fatal(err)
	}

	ticket, err := h.IssueLANTicket(ctx)
	if err != nil {
		t.Fatal(err)
	}
	params, _, err := p.ParseDirectPairLink(ticket.Link)
	if err != nil {
		t.Fatal(err)
	}
	phonePub, phoneKey, _ := ed25519.GenerateKey(rand.Reader)
	st, receipt, err := p.PairDirect(ctx, params, p.PairInput{
		Identity: p.Identity{ID: p.NewID(), PublicKey: phonePub},
		Name:     "iPhone",
		Platform: "ios",
		Role:     p.Controller,
	}, phoneKey)
	if err != nil {
		t.Fatal(err)
	}
	grants := map[string]string{
		st.Membership.Hub.ID + "/" + st.Membership.SpaceID + "/" + st.Membership.DeviceID + "/" + s.DeviceID: receipt.Grant,
	}
	client := &lanclient.Client{LoadGrant: func(key string) string { return grants[key] }}

	// 1. Mobile fetches private archive: main session must already be read (42==42), topic must carry enriched fields.
	privRaw, ok, err := client.Local(ctx, st, "GET", st.SpacePath()+"/private-archive/"+s.DeviceID, nil)
	if err != nil || !ok {
		t.Fatalf("private archive failed: ok=%v err=%v", ok, err)
	}
	var records []p.Record
	if err := json.Unmarshal(privRaw, &records); err != nil {
		t.Fatal(err)
	}
	byID := map[string]p.Record{}
	for _, r := range records {
		if r.Kind == "session" {
			byID[r.ID] = r
		}
	}
	if byID["sess-main"].ReadSequence != 42 || byID["sess-main"].Preview != "桌面已读的回复" {
		t.Fatalf("desktop read state did not propagate to mobile: %+v", byID["sess-main"])
	}
	topicRec := byID["sess-topic"]
	if topicRec.ReadSequence != 0 || topicRec.PendingCount != 1 || topicRec.ActiveStatus != "waiting_user" || topicRec.ReplyCount != 1 {
		t.Fatalf("unexpected enriched topic projection: %+v", topicRec)
	}

	// 2. Mobile marks topic read (sending oversized cursor) -> Host clamps to unreadSequence (55) and syncs back to desktop.
	body, _ := json.Marshal(p.ReadSync{DeviceID: s.DeviceID, Items: []p.ReadMark{{SessionID: "sess-topic", Sequence: 999999}}})
	if _, ok, err := client.Local(ctx, st, "POST", st.SpacePath()+"/read", body); err != nil || !ok {
		t.Fatalf("mobile LAN read sync failed: ok=%v err=%v", ok, err)
	}
	var syncedSeq int64
	if err := s.DB.QueryRow("SELECT coalesce(json_extract(activity,'$.readSequence'),0) FROM sessions WHERE id='sess-topic'").Scan(&syncedSeq); err != nil {
		t.Fatal(err)
	}
	if syncedSeq != 55 {
		t.Fatalf("expected Host readSequence clamped to 55, got %d", syncedSeq)
	}
}
