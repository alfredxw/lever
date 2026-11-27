package hub

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	p "lever/internal/remoteproto"
)

func TestDesktopActiveSilencesPushAndClearedSync(t *testing.T) {
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

	var sentCount atomic.Int32
	fcm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sentCount.Add(1)
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"name":"ok"}`))
	}))
	defer fcm.Close()
	h.push = &pushProviders{android: fcm.Client(), fcmURL: fcm.URL, firebase: &p.FirebaseClient{ProjectID: "test"}}

	api := httptest.NewServer(h.Handler(nil))
	defer api.Close()

	makeDevice := func(role p.Role, platform string) p.ClientState {
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		m := p.Membership{Hub: h.identity, SpaceID: space, UserID: user, Role: role, DeviceID: p.NewID(), Token: p.Token()}
		_, err := h.db.Exec("INSERT INTO devices(space_id,id,user_id,name,platform,role,pub,token,generation) VALUES(?,?,?,'fixture',?,?,?,?,1)", space, m.DeviceID, user, platform, role, []byte(pub), p.Digest([]byte(m.Token)))
		if err != nil {
			t.Fatal(err)
		}
		return p.ClientState{Membership: m, Key: priv, Origin: api.URL}
	}

	phone := makeDevice(p.Controller, "android")
	host := makeDevice(p.Executor, "darwin")
	sub := p.PushRegistration{Token: p.Token(), Key: make([]byte, 32)}
	rand.Read(sub.Key)
	var settings p.PushSettings
	if err := phone.Do(t.Context(), "PUT", phone.SpacePath()+"/push", sub, &settings); err != nil {
		t.Fatal(err)
	}
	if !settings.Enabled || !settings.SilenceWhenDesktopActive {
		t.Fatalf("expected push enabled and silenceWhenDesktopActive=true by default, got %+v", settings)
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

	// Mark Desktop active on Host -> push should be silenced
	if _, err := h.db.Exec("UPDATE devices SET desktop_active_until=? WHERE space_id=? AND id=?", time.Now().Add(time.Minute).Unix(), space, host.Membership.DeviceID); err != nil {
		t.Fatal(err)
	}
	chatID := p.NewID()
	topicID := p.NewID()
	commit(0, 2, true,
		p.Change{Record: p.Record{Kind: "chat", ID: chatID, Title: "c1"}},
		p.Change{Record: p.Record{Kind: "session", Type: "topic", ID: topicID, ChatID: chatID}},
	)
	run1 := p.NewID()
	commit(2, 3, false,
		p.Change{Record: p.Record{Kind: "run", ID: run1, ChatID: chatID, SessionID: topicID, Status: "completed"}},
	)
	if more, err := h.deliverNext(t.Context()); err != nil || !more {
		t.Fatalf("deliverNext silenced: more=%v err=%v", more, err)
	}
	if got := sentCount.Load(); got != 0 {
		t.Fatalf("expected 0 pushes while desktop active, got %d", got)
	}

	// Simulate screen lock (desktop_active_until = 0) -> push should resume
	if _, err := h.db.Exec("UPDATE devices SET desktop_active_until=0 WHERE space_id=? AND id=?", space, host.Membership.DeviceID); err != nil {
		t.Fatal(err)
	}
	run2 := p.NewID()
	commit(3, 4, false,
		p.Change{Record: p.Record{Kind: "run", ID: run2, ChatID: chatID, SessionID: topicID, Status: "completed"}},
	)
	if more, err := h.deliverNext(t.Context()); err != nil || !more {
		t.Fatalf("deliverNext locked: more=%v err=%v", more, err)
	}
	if got := sentCount.Load(); got != 1 {
		t.Fatalf("expected 1 push after screen lock, got %d", got)
	}

	// Disable silenceWhenDesktopActive via PATCH -> push fires even while Desktop is active
	off := false
	if err := phone.Do(t.Context(), "PATCH", phone.SpacePath()+"/push", p.PushPreferences{SilenceWhenDesktopActive: &off}, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.SilenceWhenDesktopActive {
		t.Fatalf("expected silenceWhenDesktopActive=false after PATCH, got %+v", settings)
	}
	if _, err := h.db.Exec("UPDATE devices SET desktop_active_until=? WHERE space_id=? AND id=?", time.Now().Add(time.Minute).Unix(), space, host.Membership.DeviceID); err != nil {
		t.Fatal(err)
	}
	run3 := p.NewID()
	commit(4, 5, false,
		p.Change{Record: p.Record{Kind: "run", ID: run3, ChatID: chatID, SessionID: topicID, Status: "completed"}},
	)
	if more, err := h.deliverNext(t.Context()); err != nil || !more {
		t.Fatalf("deliverNext unsilenced: more=%v err=%v", more, err)
	}
	if got := sentCount.Load(); got != 2 {
		t.Fatalf("expected 2 pushes when silence disabled, got %d", got)
	}

	// Cleared sync round-trip (clear then restore)
	if err := phone.Do(t.Context(), "POST", phone.SpacePath()+"/cleared", p.ClearSync{
		DeviceID: host.Membership.DeviceID,
		Items:    []p.ClearMark{{SessionID: topicID, Sequence: 7}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	var cleared map[string]map[string]int64
	if err := phone.Do(t.Context(), "GET", phone.SpacePath()+"/cleared", nil, &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared[host.Membership.DeviceID][topicID] != 7 {
		t.Fatalf("unexpected cleared cursors: %+v", cleared)
	}
	if err := phone.Do(t.Context(), "POST", phone.SpacePath()+"/cleared", p.ClearSync{
		DeviceID: host.Membership.DeviceID,
		Items:    []p.ClearMark{{SessionID: topicID, Sequence: 0}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	cleared = nil
	if err := phone.Do(t.Context(), "GET", phone.SpacePath()+"/cleared", nil, &cleared); err != nil {
		t.Fatal(err)
	}
	if _, still := cleared[host.Membership.DeviceID][topicID]; still {
		t.Fatalf("expected restored topic to be removed from cleared cursors, got %+v", cleared)
	}
}
