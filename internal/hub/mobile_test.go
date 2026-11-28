package hub

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/sideshow/apns2"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

func TestMobileArchiveAndPush(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err := h.Setup("owner", "a fixture password"); err != nil {
		t.Fatal(err)
	}
	var space, user string
	if err := h.db.QueryRow("SELECT space_id,user_id FROM memberships").Scan(&space, &user); err != nil {
		t.Fatal(err)
	}
	var posted []byte
	status := 503
	fcm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posted, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
		if status == 404 {
			_, _ = io.WriteString(w, `{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}`)
		}
	}))
	defer fcm.Close()
	h.push = &pushProviders{android: fcm.Client(), fcmURL: fcm.URL, firebase: &p.FirebaseClient{ProjectID: "test"}}
	api := httptest.NewServer(h.Handler(nil))
	defer api.Close()
	device := func(role p.Role, platform string) p.ClientState {
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		m := p.Membership{Hub: h.identity, SpaceID: space, UserID: user, Role: role, DeviceID: p.NewID(), Token: p.Token()}
		_, err := h.db.Exec("INSERT INTO devices(space_id,id,user_id,name,platform,role,pub,token,generation) VALUES(?,?,?,'fixture',?,?,?,?,1)", space, m.DeviceID, user, platform, role, []byte(pub), p.Digest([]byte(m.Token)))
		if err != nil {
			t.Fatal(err)
		}
		return p.ClientState{Membership: m, Key: priv, Origin: api.URL}
	}
	phone, host := device(p.Controller, "android"), device(p.Executor, "linux")
	pushPath := phone.SpacePath() + "/push"
	sub := p.PushRegistration{Token: p.Token(), Key: make([]byte, 32)}
	rand.Read(sub.Key)
	if err := host.Do(t.Context(), "PUT", pushPath, sub, nil); err == nil {
		t.Fatal("executor registered for phone alerts")
	}
	if err := phone.Do(t.Context(), "PUT", pushPath, sub, nil); err != nil {
		t.Fatal(err)
	}
	a := principal{device: host.Membership.DeviceID, user: user, space: space, token: p.Digest([]byte(host.Membership.Token))}
	epoch := p.NewID()
	commit := func(base, version int64, full bool, changes ...p.Change) {
		t.Helper()
		file, err := os.CreateTemp(t.TempDir(), "batch")
		if err != nil {
			t.Fatal(err)
		}
		b := batchFile{start: p.Frame{Epoch: epoch, Base: base, Version: version, Full: full}, file: file}
		defer b.close()
		for _, c := range changes {
			if err := json.NewEncoder(file).Encode(c); err != nil {
				t.Fatal(err)
			}
		}
		if err := h.commitBatch(a, 1, &b); err != nil {
			t.Fatal(err)
		}
	}
	readPage := func(chat string, cur p.ArchiveCursor) p.ArchivePage {
		t.Helper()
		q := url.Values{"sync": {"1"}, "chat": {chat}, "epoch": {cur.Epoch}, "stream": {cur.Stream}, "version": {strconv.FormatInt(cur.Version, 10)}}
		var result p.ArchivePage
		if err := phone.Do(t.Context(), "GET", phone.SpacePath()+"/archive/"+a.device+"?"+q.Encode(), nil, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	chat := p.Change{Record: p.Record{Kind: "chat", ID: p.NewID(), Title: "private fixture title"}}
	topic := p.Change{Record: p.Record{Kind: "session", Type: "topic", ID: p.NewID(), ChatID: chat.ID}}
	run := p.Change{Record: p.Record{Kind: "run", ID: p.NewID(), ChatID: chat.ID, SessionID: topic.ID, Status: "running"}}
	request := p.Change{Record: p.Record{Kind: "request", ID: p.NewID(), ChatID: chat.ID, SessionID: topic.ID, RunID: run.ID, Status: "pending", Text: "secret command and local path"}}
	commit(0, 4, true, chat, topic, run)
	first := readPage(chat.ID, p.ArchiveCursor{})
	if !first.Full || len(first.Changes) != 3 {
		t.Fatal(first)
	}
	commit(4, 5, false, request)
	delta := readPage(chat.ID, first.Cursor)
	if delta.Full || len(delta.Changes) != 1 || delta.Changes[0].ID != request.ID {
		t.Fatal(delta)
	}
	if empty := readPage(p.NewID(), first.Cursor); empty.Full || len(empty.Changes) != 0 {
		t.Fatal("escaped chat view", empty)
	}
	lag := url.Values{"sync": {"1"}, "epoch": {epoch}, "stream": {"lan"}, "version": {"6"}}
	var httpErr *p.HTTPError
	if err := phone.Do(t.Context(), "GET", phone.SpacePath()+"/archive/"+a.device+"?"+lag.Encode(), nil, nil); !errors.As(err, &httpErr) || httpErr.Status != 409 {
		t.Fatal("lagging Hub replaced a newer LAN cursor", err)
	}
	next := func(want bool) {
		t.Helper()
		more, err := h.deliverNext(t.Context())
		if err != nil || more != want {
			t.Fatal(more, err)
		}
	}
	next(true) // provider failure is durably deferred
	next(false)
	if _, err := h.db.Exec("UPDATE push_outbox SET due=0"); err != nil {
		t.Fatal(err)
	}
	status = 200
	next(true)
	next(false)
	var msg struct {
		Message struct {
			Token        string
			Data         struct{ Lever string }
			Notification map[string]string
		}
	}
	if err := json.Unmarshal(posted, &msg); err != nil {
		t.Fatal(err)
	}
	n, err := p.OpenPush(msg.Message.Data.Lever, sub.Key)
	if err != nil || n.ChatID != chat.ID || n.SessionID != topic.ID || n.RequestID != request.ID || n.RunID != run.ID || n.HubID != h.identity.ID || n.SpaceID != space || msg.Message.Token != sub.Token || msg.Message.Notification["body"] == "" {
		t.Fatal(n, err)
	}
	for _, s := range []string{request.ID, request.Text, chat.Title, chat.ID} {
		if bytes.Contains(posted, []byte(s)) {
			t.Fatal("private routing or content in push")
		}
	}
	if _, err := p.OpenPush(msg.Message.Data.Lever, make([]byte, 32)); err == nil {
		t.Fatal("different phone opened alert")
	}
	t.Run("native hot page and revoked visibility", func(t *testing.T) {
		native := model.Run{ID: p.NewID(), ChatID: p.NewID(), SessionID: p.NewID(), Status: "completed"}
		source := "chats/" + native.ChatID
		data, err := json.Marshal(model.ChatView{Runs: []model.Run{native}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = h.db.Exec("UPDATE devices SET node=json_object('cacheEpoch',?) WHERE space_id=? AND id=?", epoch, space, a.device); err != nil {
			t.Fatal(err)
		}
		if _, err = h.db.Exec("INSERT INTO node_hot_pages(space_id,device_id,path,epoch,revision,data) VALUES(?,?,?,?,1,?)", space, a.device, source, epoch, string(data)); err != nil {
			t.Fatal(err)
		}
		enqueue := func() {
			t.Helper()
			if err := write(h.db, func(tx *sql.Tx) error {
				return h.queuePagePush(tx, a, p.Record{Kind: "run", ID: native.ID, ChatID: native.ChatID, Status: native.Status}, source)
			}); err != nil {
				t.Fatal(err)
			}
		}
		enqueue()
		posted = nil
		if more, err := h.deliverNext(t.Context()); err != nil || !more {
			t.Fatal(more, err)
		}
		if err := json.Unmarshal(posted, &msg); err != nil {
			t.Fatal(err)
		}
		notice, err := p.OpenPush(msg.Message.Data.Lever, sub.Key)
		if err != nil || notice.RunID != native.ID || notice.ChatID != native.ChatID {
			t.Fatal(notice, err)
		}
		enqueue()
		if _, err := h.db.Exec("UPDATE devices SET node='' WHERE space_id=? AND id=?", space, a.device); err != nil {
			t.Fatal(err)
		}
		posted = nil
		if more, err := h.deliverNext(t.Context()); err != nil || !more {
			t.Fatal(more, err)
		}
		if len(posted) != 0 {
			t.Fatal("delivered after Owner revoked access")
		}
	})
	commit(0, 5, true, chat, topic, run, request)
	next(false)
	if page := readPage(chat.ID, delta.Cursor); !page.Full {
		t.Fatal("replayed cursor across snapshot replacement")
	}
	cursor := readPage(chat.ID, p.ArchiveCursor{}).Cursor
	request.Status = "answered"
	commit(5, 6, false, request)
	gone := request
	gone.Deleted = true
	commit(6, 7, false, gone)
	if page := readPage(chat.ID, cursor); page.Full || len(page.Changes) != 1 || !page.Changes[0].Deleted || page.Changes[0].ID != request.ID {
		t.Fatal(page)
	}
	request.Status = "pending"
	commit(7, 8, false, request)
	request.Status = "answered"
	commit(8, 9, false, request)
	posted = nil
	next(true)
	next(false)
	if len(posted) != 0 {
		t.Fatal("answered card was delivered")
	}
	run.Status = "completed"
	commit(9, 10, false, run)
	status = 404
	next(true)
	next(false)
	var settings p.PushSettings
	if err := phone.Do(t.Context(), "GET", pushPath, nil, &settings); err != nil || settings.Enabled {
		t.Fatal(settings, err)
	}
	commit(10, 10+p.ArchiveWindow+1, false, run)
	if page := readPage(chat.ID, cursor); !page.Full || len(page.Changes) != 4 {
		t.Fatal("expired cursor did not receive the current snapshot", page)
	}
	if err := phone.Do(t.Context(), "PUT", pushPath, sub, nil); err != nil {
		t.Fatal(err)
	}
	reinstalled := device(p.Controller, "android")
	if err := reinstalled.Do(t.Context(), "PUT", pushPath, sub, nil); err != nil {
		t.Fatal("phone could not re-register after reinstall", err)
	}
	if err := phone.Do(t.Context(), "GET", pushPath, nil, &settings); err != nil || settings.Enabled {
		t.Fatal("old pairing retained the transferred token", err)
	}
}

func TestPushRelayDeliversOpaqueAPNsAlert(t *testing.T) {
	var received []byte
	apns := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ = io.ReadAll(r.Body)
		if r.Header.Get("apns-push-type") != "alert" || r.Header.Get("apns-topic") != "app.lever.mobile" {
			t.Error("missing APNs alert headers")
		}
	}))
	defer apns.Close()
	key := p.Token()
	publisher := &Hub{push: &pushProviders{relayKey: key, topic: "app.lever.mobile", apple: &apns2.Client{Host: apns.URL, HTTPClient: apns.Client()}}}
	relay := httptest.NewServer(publisher.Handler(nil))
	defer relay.Close()
	tenant := &pushProviders{relay: &relayConfig{Origin: relay.URL, key: key, IOS: true}}
	n := p.PushNotice{Kind: "request", DeviceID: p.NewID(), ChatID: p.NewID(), RequestID: p.NewID()}
	envelope, err := p.SealPush(n, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := tenant.send(t.Context(), "ios", strings.Repeat("ab", 32), envelope); err != nil {
		t.Fatal(err)
	}
	var packet struct {
		Lever string
		Aps   struct{ Alert map[string]string }
	}
	if err := json.Unmarshal(received, &packet); err != nil || packet.Lever != envelope.Payload || packet.Aps.Alert["body"] == "" {
		t.Fatal(packet, err)
	}
	tenant.relay.key = p.Token()
	if err := tenant.send(t.Context(), "ios", strings.Repeat("ab", 32), envelope); err == nil {
		t.Fatal("unauthenticated relay delivery")
	}
}

func TestHubReadCursorsSyncAndMerge(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err := h.Setup("owner", "a fixture password"); err != nil {
		t.Fatal(err)
	}
	var space, user string
	if err := h.db.QueryRow("SELECT space_id,user_id FROM memberships").Scan(&space, &user); err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(h.Handler(nil))
	defer api.Close()
	makeDevice := func(role p.Role, platform string) p.ClientState {
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		m := p.Membership{Hub: h.identity, SpaceID: space, UserID: user, Role: role, DeviceID: p.NewID(), Token: p.Token()}
		if _, err := h.db.Exec("INSERT INTO devices(space_id,id,user_id,name,platform,role,pub,token,generation) VALUES(?,?,?,'fixture',?,?,?,?,1)", space, m.DeviceID, user, platform, role, []byte(pub), p.Digest([]byte(m.Token))); err != nil {
			t.Fatal(err)
		}
		return p.ClientState{Membership: m, Key: priv, Origin: api.URL}
	}
	phone, host := makeDevice(p.Controller, "ios"), makeDevice(p.Workstation, "darwin")
	a := principal{device: host.Membership.DeviceID, user: user, space: space, token: p.Digest([]byte(host.Membership.Token))}

	file, err := os.CreateTemp(t.TempDir(), "batch")
	if err != nil {
		t.Fatal(err)
	}
	b := batchFile{start: p.Frame{Epoch: p.NewID(), Base: 0, Version: 1, Full: true}, file: file}
	defer b.close()
	for _, rec := range []p.Record{
		{Kind: "chat", ID: "c1", AgentID: "a1", Title: "Chat"},
		{Kind: "session", ID: "s1", ChatID: "c1", AgentID: "a1", Type: "topic", Title: "T1", UnreadSequence: 80, ReadSequence: 20},
	} {
		_ = json.NewEncoder(file).Encode(p.Change{Record: rec})
	}
	if err := h.commitBatch(a, 1, &b); err != nil {
		t.Fatal(err)
	}

	// Phone marks s1 read up to 80, then sends a stale 30 (must remain monotonic 80).
	if err := phone.Do(t.Context(), "POST", phone.SpacePath()+"/read", p.ReadSync{
		DeviceID: host.Membership.DeviceID,
		Items:    []p.ReadMark{{SessionID: "s1", Sequence: 80}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := phone.Do(t.Context(), "POST", phone.SpacePath()+"/read", p.ReadSync{
		DeviceID: host.Membership.DeviceID,
		Items:    []p.ReadMark{{SessionID: "s1", Sequence: 30}},
	}, nil); err != nil {
		t.Fatal(err)
	}

	var cursors map[string]map[string]int64
	if err := phone.Do(t.Context(), "GET", phone.SpacePath()+"/read", nil, &cursors); err != nil {
		t.Fatal(err)
	}
	if cursors[host.Membership.DeviceID]["s1"] != 80 {
		t.Fatalf("expected Hub read cursor 80, got %+v", cursors)
	}

	// Archive page must merge Hub read_cursors into session.readSequence.
	var page p.ArchivePage
	if err := phone.Do(t.Context(), "GET", phone.SpacePath()+"/archive/"+host.Membership.DeviceID+"?sync=1", nil, &page); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ch := range page.Changes {
		if ch.Kind == "session" && ch.ID == "s1" {
			found = true
			if ch.ReadSequence != 80 {
				t.Fatalf("expected merged readSequence 80 on archive page, got %+v", ch.Record)
			}
		}
	}
	if !found {
		t.Fatal("session s1 missing from archive page")
	}
}
