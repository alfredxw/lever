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
