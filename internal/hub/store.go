// Package hub owns spaces, device memberships, tasks and read-only Host archives.
package hub

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
	"golang.org/x/crypto/argon2"
	p "lever/internal/remoteproto"
	_ "modernc.org/sqlite"
)

type Hub struct {
	db        *sql.DB
	dir       string
	lock      *flock.Flock
	identity  p.Identity
	key       ed25519.PrivateKey
	mu        sync.Mutex
	links     map[deviceKey]*link
	wakes     map[string]chan struct{}
	limits    map[string]attempts
	hashSlots chan struct{}
	push      *pushProviders
}
type deviceKey struct{ space, device string }
type attempts struct {
	count int
	until time.Time
}

func database(dir string) (*sql.DB, error) {
	path, err := filepath.Abs(filepath.Join(dir, "hub.db"))
	if err != nil {
		return nil, err
	}
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"}
	db, err := sql.Open("sqlite", u.String())
	if err == nil {
		db.SetMaxOpenConns(1)
	}
	return db, err
}
func directoryLock(dir string) (*flock.Flock, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	l := flock.New(filepath.Join(dir, "hub.lock"))
	ok, err := l.TryLock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("Hub data directory is in use")
	}
	return l, nil
}
func Open(dir string) (*Hub, error) {
	l, err := directoryLock(dir)
	if err != nil {
		return nil, err
	}
	if err = finishRestore(dir); err != nil {
		l.Unlock()
		return nil, err
	}
	db, err := database(dir)
	if err != nil {
		l.Unlock()
		return nil, err
	}
	h := &Hub{db: db, dir: dir, lock: l, links: make(map[deviceKey]*link), wakes: make(map[string]chan struct{}), limits: make(map[string]attempts), hashSlots: make(chan struct{}, 4)}
	if err = h.init(); err != nil {
		h.Close()
		return nil, err
	}
	return h, nil
}
func (h *Hub) init() error {
	if _, err := h.db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return err
	}
	var v int
	if err := h.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil {
		return err
	}
	if v > 1 {
		return fmt.Errorf("Hub schema version %d is newer than this binary", v)
	}
	if err := write(h.db, func(tx *sql.Tx) error {
		if _, err := tx.Exec(schema); err != nil {
			return err
		}
		if err := ensureColumn(tx, "devices", "desktop_active_until", "INTEGER NOT NULL DEFAULT 0"); err != nil {
			return err
		}
		if err := ensureColumn(tx, "push_devices", "silence_when_desktop_active", "INTEGER NOT NULL DEFAULT 1"); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return err
	}
	path := filepath.Join(h.dir, "identity", "hub.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		var count int
		if err = h.db.QueryRow("SELECT count(*) FROM users").Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return errors.New("Hub identity missing; restore the database and identity together")
		}
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		raw, err = json.Marshal(diskIdentity{p.NewID(), key})
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(path+".tmp", raw, 0600); err != nil {
			return err
		}
		if err = os.Rename(path+".tmp", path); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	id, err := parseIdentity(raw)
	if err != nil {
		return err
	}
	h.identity = p.Identity{ID: id.ID, PublicKey: id.Key.Public().(ed25519.PublicKey)}
	h.key = id.Key
	if _, err = h.db.Exec("INSERT OR IGNORE INTO hub_identity VALUES(1,?)", id.ID); err != nil {
		return err
	}
	var stored string
	if err = h.db.QueryRow("SELECT id FROM hub_identity WHERE singleton=1").Scan(&stored); err != nil {
		return err
	}
	if stored != id.ID {
		return errors.New("Hub identity does not match its database")
	}
	return nil
}

type diskIdentity struct {
	ID  string
	Key ed25519.PrivateKey
}

func parseIdentity(raw []byte) (diskIdentity, error) {
	var id diskIdentity
	if err := json.Unmarshal(raw, &id); err != nil || id.ID == "" || len(id.Key) != ed25519.PrivateKeySize {
		return id, errors.New("invalid Hub identity")
	}
	return id, nil
}
func (h *Hub) Close() error {
	h.mu.Lock()
	for _, l := range h.links {
		l.conn.Close()
	}
	h.mu.Unlock()
	return errors.Join(h.db.Close(), h.lock.Unlock())
}
func write(db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}
func credentials(password string) (salt, verifier []byte, err error) {
	if len(password) < 12 || len(password) > 1024 {
		return nil, nil, errors.New("password must be between 12 and 1024 bytes")
	}
	salt = make([]byte, 16)
	rand.Read(salt)
	return salt, argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32), nil
}
func matches(password string, salt, verifier []byte) bool {
	return subtle.ConstantTimeCompare(argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32), verifier) == 1
}
func (h *Hub) Setup(user, password string) error {
	user = strings.TrimSpace(user)
	if user == "" || len(user) > 120 {
		return errors.New("invalid administrator name")
	}
	salt, verifier, err := credentials(password)
	if err != nil {
		return err
	}
	return write(h.db, func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRow("SELECT count(*) FROM users").Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("administrator already initialized")
		}
		uid, sid := p.NewID(), p.NewID()
		if _, err := tx.Exec("INSERT INTO users VALUES(?,?,?,?)", uid, user, salt, verifier); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO spaces(id,name,kind) VALUES(?, 'Personal','personal')", sid); err != nil {
			return err
		}
		_, err := tx.Exec("INSERT INTO memberships VALUES(?,?,'owner')", sid, uid)
		return err
	})
}
func ResetPassword(dir, user, password string) error {
	salt, verifier, err := credentials(password)
	if err != nil {
		return err
	}
	db, err := database(dir)
	if err != nil {
		return err
	}
	defer db.Close()
	return write(db, func(tx *sql.Tx) error {
		var uid string
		if err := tx.QueryRow("SELECT id FROM users WHERE name=?", user).Scan(&uid); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE users SET salt=?, verifier=? WHERE id=?", salt, verifier, uid); err != nil {
			return err
		}
		_, err := tx.Exec("DELETE FROM sessions WHERE user_id=?", uid)
		return err
	})
}
func (h *Hub) watch(space string) <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch := h.wakes[space]
	if ch == nil {
		ch = make(chan struct{})
		h.wakes[space] = ch
	}
	return ch
}
func (h *Hub) notify(space string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ch := h.wakes[space]; ch != nil {
		close(ch)
		delete(h.wakes, space)
	}
}

func ensureColumn(tx *sql.Tx, table, column, def string) error {
	rows, err := tx.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = tx.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + def)
	return err
}

const schema = `
CREATE TABLE IF NOT EXISTS hub_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,salt BLOB NOT NULL,verifier BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('personal','team')),policy INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS memberships(space_id TEXT REFERENCES spaces(id),user_id TEXT REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(space_id,user_id));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,agent TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(digest TEXT PRIMARY KEY,space_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,expires INTEGER NOT NULL,FOREIGN KEY(space_id,user_id) REFERENCES memberships);
CREATE TABLE IF NOT EXISTS devices(space_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,platform TEXT NOT NULL,role TEXT NOT NULL,pub BLOB NOT NULL,token TEXT UNIQUE,draining INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,seen INTEGER NOT NULL DEFAULT 0,epoch TEXT NOT NULL DEFAULT '',generation INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(space_id,id),FOREIGN KEY(space_id,user_id) REFERENCES memberships);
CREATE TRIGGER IF NOT EXISTS drain_policy AFTER UPDATE OF draining ON devices WHEN NEW.draining<>OLD.draining BEGIN UPDATE spaces SET policy=policy+1 WHERE id=NEW.space_id; END;
CREATE TRIGGER IF NOT EXISTS device_policy AFTER UPDATE OF revoked,role,token ON devices BEGIN UPDATE spaces SET policy=policy+1 WHERE id=NEW.space_id; END;
CREATE TABLE IF NOT EXISTS nonces(token TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(token,nonce));
CREATE INDEX IF NOT EXISTS nonce_expiry ON nonces(expires);
CREATE TABLE IF NOT EXISTS archive(space_id TEXT NOT NULL,device_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(space_id,device_id,kind,id),FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE TABLE IF NOT EXISTS archive_streams(space_id TEXT NOT NULL,device_id TEXT NOT NULL,stream TEXT NOT NULL,floor INTEGER NOT NULL,PRIMARY KEY(space_id,device_id),FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE TABLE IF NOT EXISTS archive_updates(space_id TEXT NOT NULL,device_id TEXT NOT NULL,view TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(space_id,device_id,view,kind,id),FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE INDEX IF NOT EXISTS archive_updates_version ON archive_updates(space_id,device_id,view,version);
CREATE TABLE IF NOT EXISTS push_devices(space_id TEXT NOT NULL,device_id TEXT NOT NULL,platform TEXT NOT NULL,token TEXT NOT NULL,seal_key BLOB NOT NULL,PRIMARY KEY(space_id,device_id),UNIQUE(platform,token),FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE TABLE IF NOT EXISTS push_outbox(id INTEGER PRIMARY KEY,space_id TEXT NOT NULL,recipient TEXT NOT NULL,host TEXT NOT NULL,kind TEXT NOT NULL,object TEXT NOT NULL,status TEXT NOT NULL,due INTEGER NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(space_id,recipient,host,kind,object),FOREIGN KEY(space_id,recipient) REFERENCES push_devices ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS push_due ON push_outbox(due,id);
CREATE TRIGGER IF NOT EXISTS revoke_push AFTER UPDATE OF revoked,token ON devices WHEN NEW.revoked OR NEW.token IS NOT OLD.token BEGIN DELETE FROM push_devices WHERE space_id=NEW.space_id AND device_id=NEW.id; END;
CREATE TABLE IF NOT EXISTS tasks(space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, create_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(space_id,id));
CREATE TABLE IF NOT EXISTS dispatches(space_id TEXT NOT NULL, id TEXT NOT NULL,task_id TEXT NOT NULL,device_id TEXT NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(space_id,id),FOREIGN KEY(space_id,task_id) REFERENCES tasks,FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE INDEX IF NOT EXISTS task_dispatches ON dispatches(space_id,task_id);
CREATE TABLE IF NOT EXISTS receipts(space_id TEXT NOT NULL,device_id TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL, data TEXT NOT NULL,PRIMARY KEY(space_id,device_id,id),FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE TABLE IF NOT EXISTS read_cursors(space_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(space_id,user_id,device_id,session_id),FOREIGN KEY(space_id,device_id) REFERENCES devices);
CREATE TABLE IF NOT EXISTS cleared_cursors(space_id TEXT NOT NULL,user_id TEXT NOT NULL,device_id TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(space_id,user_id,device_id,session_id),FOREIGN KEY(space_id,device_id) REFERENCES devices);
PRAGMA user_version=1;`
