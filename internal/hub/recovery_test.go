package hub

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	p "lever/internal/remoteproto"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScopedSnapshotRollbackAndRestore(t *testing.T) {
	dir := t.TempDir()
	h, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if h != nil {
			h.Close()
		}
	})
	if err = h.Setup("owner", "test-only long password"); err != nil {
		t.Fatal(err)
	}
	var space, user string
	if err = h.db.QueryRow("SELECT space_id,user_id FROM memberships").Scan(&space, &user); err != nil {
		t.Fatal(err)
	}
	other := p.NewID()
	if _, err = h.db.Exec("INSERT INTO spaces(id,name,kind) VALUES(?,'Team','team')", other); err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec("INSERT INTO memberships VALUES(?,?,'owner')", other, user); err != nil {
		t.Fatal(err)
	}
	seed := func(s, id string) principal {
		t.Helper()
		pub, _, _ := ed25519.GenerateKey(rand.Reader)
		a := principal{user: user, space: s, device: id, role: p.Executor, token: p.Token()}
		_, err := h.db.Exec("INSERT INTO devices(space_id,id,user_id,name,platform,role,pub,token,generation) VALUES(?,?,?,'fixture','test','executor',?,?,1)", s, id, user, []byte(pub), a.token)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	a := seed(space, "A")
	b := seed(space, "B")
	team := seed(other, "A")
	put := func(a principal, ver int64, ids ...string) {
		t.Helper()
		f, err := os.CreateTemp(t.TempDir(), "snapshot")
		if err != nil {
			t.Fatal(err)
		}
		pack := &batchFile{file: f, start: p.Frame{Epoch: "epoch", Version: ver, Full: true}}
		defer pack.close()
		for _, id := range ids {
			if err = json.NewEncoder(f).Encode(p.Change{Record: p.Record{ID: id, Kind: "chat"}}); err != nil {
				t.Fatal(err)
			}
		}
		if err = h.commitBatch(a, 1, pack); err != nil {
			t.Fatal(err)
		}
	}
	put(a, 7, "removed", "kept")
	put(b, 3, "other-device")
	put(team, 2, "other-space")
	snapshot := filepath.Join(t.TempDir(), "snapshot.tar.gz")
	if err = Backup(dir, snapshot); err != nil {
		t.Fatal(err)
	}
	if err = Restore(dir, snapshot); err == nil {
		t.Fatal("restore accepted a live Hub")
	}
	put(a, 2, "kept")
	var n int
	if err = h.db.QueryRow("SELECT count(*) FROM archive").Scan(&n); err != nil || n != 3 {
		t.Fatal(n, err)
	}
	if _, err = h.db.Exec("DELETE FROM archive WHERE space_id=?", space); err != nil {
		t.Fatal(err)
	}
	identity := h.identity.ID
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	h = nil
	if err = Restore(dir, snapshot); err != nil {
		t.Fatal(err)
	}
	h, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if h.identity.ID != identity {
		t.Fatal("Hub identity changed")
	}
	if err = h.db.QueryRow("SELECT count(*) FROM archive").Scan(&n); err != nil || n != 4 {
		t.Fatal(n, err)
	}
	put(a, 8, "after-hub-restore")
	if err = h.db.QueryRow("SELECT count(*) FROM archive").Scan(&n); err != nil || n != 3 {
		t.Fatal(n, err)
	}
	if _, err = h.db.Exec("INSERT INTO sessions VALUES('id','hash',?,?,'browser')", user, time.Now().Add(time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	if err = ResetPassword(dir, "owner", "changed test password"); err != nil {
		t.Fatal(err)
	}
	if err = h.db.QueryRowContext(context.Background(), "SELECT id FROM sessions LIMIT 1").Scan(new(string)); err != sql.ErrNoRows {
		t.Fatal("old session survived", err)
	}
}
