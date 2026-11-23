package hub

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	p "lever/internal/remoteproto"
)

type link struct {
	conn       *websocket.Conn
	generation int64
	probes     sync.Map
	mu         sync.Mutex
}

func (l *link) send(f p.Frame) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return l.conn.WriteJSON(f)
}
func (h *Hub) online(k deviceKey) bool { h.mu.Lock(); defer h.mu.Unlock(); return h.links[k] != nil }
func (h *Hub) disconnect(k deviceKey) {
	h.mu.Lock()
	l := h.links[k]
	delete(h.links, k)
	h.mu.Unlock()
	if l != nil {
		l.conn.Close()
	}
}
func (h *Hub) connect(w http.ResponseWriter, r *http.Request, a principal) error {
	if a.device == "" {
		return denied
	}
	up := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	ws, err := up.Upgrade(w, r, nil)
	if err != nil {
		return nil
	}
	defer ws.Close()
	ws.SetReadLimit(p.MaxFrame)
	k := deviceKey{a.space, a.device}
	l := &link{conn: ws}
	hello := p.Frame{Type: "hello", Protocol: p.Version, SpaceID: a.space, DeviceID: a.device}
	err = h.db.QueryRow("UPDATE devices SET generation=generation+1,seen=? WHERE space_id=? AND id=? AND token=? AND revoked=0 RETURNING generation,epoch,version", time.Now().Unix(), a.space, a.device, a.token).Scan(&l.generation, &hello.Epoch, &hello.Version)
	if err != nil {
		return nil
	}
	h.mu.Lock()
	old := h.links[k]
	if old != nil && old.generation > l.generation {
		h.mu.Unlock()
		return nil
	}
	h.links[k] = l
	h.mu.Unlock()
	if old != nil {
		old.conn.Close()
	}
	h.notify(a.space)
	defer func() {
		h.mu.Lock()
		if h.links[k] == l {
			delete(h.links, k)
		}
		h.mu.Unlock()
		h.notify(a.space)
	}()
	if err = h.db.QueryRow("SELECT policy FROM spaces WHERE id=?", a.space).Scan(&hello.Policy); err != nil {
		return nil
	}
	if l.send(hello) != nil {
		return nil
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go h.pulse(ctx, k, l, a.role)
	ws.SetReadDeadline(time.Now().Add(90 * time.Second))
	ws.SetPongHandler(func(string) error {
		_, err := h.db.ExecContext(ctx, "UPDATE devices SET seen=? WHERE space_id=? AND id=? AND generation=?", time.Now().Unix(), k.space, k.device, l.generation)
		if err != nil {
			return err
		}
		return ws.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	var batch *batchFile
	defer func() {
		if batch != nil {
			batch.close()
		}
	}()
	for {
		var f p.Frame
		if ws.ReadJSON(&f) != nil || f.SpaceID != k.space || f.DeviceID != k.device || !a.role.Executes() {
			return nil
		}
		switch f.Type {
		case "command_state":
			if f.Receipt == nil || f.Receipt.ID != f.RPCID || len(f.Digest) != 64 {
				return nil
			}
			if f.Receipt.Status == "not_found" {
				continue
			}
			if f.Receipt.Status != "accepted" && f.Receipt.Status != "cancelled" && f.Receipt.Status != "declined" && f.Receipt.Status != "failed" {
				return nil
			}
			if err = h.recordReceipt(a, *f.Receipt, f.Digest); err == nil {
				h.notify(a.space)
			}
		case "idle":
			if ch, ok := l.probes.Load(f.RPCID); ok {
				select {
				case ch.(chan bool) <- f.Idle:
				default:
				}
			}
		case "start":
			if batch != nil || f.Epoch == "" || f.Version < 0 || f.Base < 0 || (!f.Full && f.Version < f.Base) {
				return nil
			}
			file, err := os.CreateTemp("", "lever-hub-batch-")
			if err != nil {
				return nil
			}
			batch = &batchFile{f, file, 0}
		case "chunk":
			if batch == nil {
				return nil
			}
			for _, change := range f.Changes {
				if !validRecord(change.Record) {
					return nil
				}
				raw, err := json.Marshal(change)
				if err != nil {
					return nil
				}
				batch.size += int64(len(raw) + 1)
				if batch.size > 512<<20 {
					return nil
				}
				if _, err = batch.file.Write(append(raw, '\n')); err != nil {
					return nil
				}
			}
		case "commit":
			if batch == nil {
				return nil
			}
			err := h.commitBatch(a, l.generation, batch)
			version, epoch := batch.start.Version, batch.start.Epoch
			batch.close()
			batch = nil
			if err != nil {
				return nil
			}
			h.notify(k.space)
			if err = l.send(p.Frame{Type: "ack", DeviceID: k.device, SpaceID: k.space, Version: version, Epoch: epoch}); err != nil {
				return nil
			}
		default:
			return nil
		}
	}
}

// A restored Hub can have an older receipt than the Host. Ask only about its
// own known command hashes. A query can never start an execution.
func (h *Hub) reconcile(ctx context.Context, k deviceKey, l *link) error {
	rows, err := h.db.QueryContext(ctx, `SELECT id,digest,json_extract(data,'$.receipt.status'),coalesce(json_extract(data,'$.intent.originDeviceId'),'') FROM receipts WHERE space_id=? AND device_id=? AND (json_extract(data,'$.receipt.status') IN ('pending','reviewing') OR (json_extract(data,'$.receipt.status')='cancelled' AND json_extract(data,'$.receipt.detail') IS NULL))`, k.space, k.device)
	if err != nil {
		return err
	}
	defer rows.Close()
	var probes []p.Frame
	for rows.Next() {
		f := p.Frame{SpaceID: k.space, DeviceID: k.device, Type: "query_command"}
		var status, controller string
		if err = rows.Scan(&f.RPCID, &f.Digest, &status, &controller); err != nil {
			return err
		}
		if status == "cancelled" {
			f.Type = "cancel_dispatch"
		}
		probes = append(probes, f)
		if status != "cancelled" && controller != "" {
			probes = append(probes, p.Frame{Type: "offer_command", SpaceID: k.space, DeviceID: k.device, RPCID: f.RPCID, ControllerID: controller})
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, f := range probes {
		if err = l.send(f); err != nil {
			return err
		}
	}
	return nil
}
func (h *Hub) pulse(ctx context.Context, k deviceKey, l *link, role p.Role) {
	tick := time.NewTicker(25 * time.Second)
	defer tick.Stop()
	if role.Executes() {
		if h.reconcile(ctx, k, l) != nil {
			return
		}
	}
	for {
		changed := h.watch(k.space)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if role.Executes() {
				if h.reconcile(ctx, k, l) != nil {
					return
				}
			}
			if err := l.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				l.conn.Close()
				return
			}
		case <-changed:
			var revision int64
			if err := h.db.QueryRowContext(ctx, "SELECT policy FROM spaces WHERE id=?", k.space).Scan(&revision); err != nil {
				return
			}
			if l.send(p.Frame{Type: "refresh", SpaceID: k.space, DeviceID: k.device, Policy: revision}) != nil {
				return
			}
		}
	}
}

type batchFile struct {
	start p.Frame
	file  *os.File
	size  int64
}

func (b *batchFile) close() { name := b.file.Name(); b.file.Close(); os.Remove(name) }
func validRecord(r p.Record) bool {
	if r.Private || r.ID == "" || len(r.ID) > 160 {
		return false
	}
	switch r.Kind {
	case "agent", "chat", "session", "run", "request":
		return true
	}
	return false
}
func (h *Hub) commitBatch(a principal, generation int64, b *batchFile) error {
	if _, err := b.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return write(h.db, func(tx *sql.Tx) error {
		var epoch string
		var version int64
		if err := tx.QueryRow("SELECT epoch,version FROM devices WHERE space_id=? AND id=? AND token=? AND generation=? AND revoked=0", a.space, a.device, a.token, generation).Scan(&epoch, &version); err != nil {
			return err
		}
		f := b.start
		if !f.Full && (f.Base != version || f.Epoch != epoch) {
			return conflict("sync base changed")
		}
		if f.Full {
			// Compare against the old rows before removing absent records so
			// replaying a full snapshot does not deliver old alerts again.
			if _, err := tx.Exec("CREATE TEMP TABLE snapshot_missing(kind TEXT,id TEXT,PRIMARY KEY(kind,id))"); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO snapshot_missing SELECT kind,id FROM archive WHERE space_id=? AND device_id=?", a.space, a.device); err != nil {
				return err
			}
			if _, err := tx.Exec("DELETE FROM archive_updates WHERE space_id=? AND device_id=?", a.space, a.device); err != nil {
				return err
			}
		}
		floor := max(int64(0), f.Version-p.ArchiveWindow)
		if f.Full {
			floor = f.Version
			if _, err := tx.Exec("INSERT OR REPLACE INTO archive_streams VALUES(?,?,?,?)", a.space, a.device, p.NewID(), floor); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec("INSERT INTO archive_streams VALUES(?,?,?,?) ON CONFLICT(space_id,device_id) DO UPDATE SET floor=max(floor,?)", a.space, a.device, p.NewID(), max(version, floor), floor); err != nil {
				return err
			}
		}
		dec := json.NewDecoder(bufio.NewReader(b.file))
		for {
			var v p.Change
			if err := dec.Decode(&v); errors.Is(err, io.EOF) {
				break
			} else if err != nil {
				return err
			}
			var oldChat, oldStatus string
			err := tx.QueryRow("SELECT coalesce(json_extract(data,'$.chatId'),''),coalesce(json_extract(data,'$.status'),'') FROM archive WHERE space_id=? AND device_id=? AND kind=? AND id=?", a.space, a.device, v.Kind, v.ID).Scan(&oldChat, &oldStatus)
			existed := err == nil
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if !f.Full {
				if existed && (v.Deleted || oldChat != v.ChatID) {
					if err := trackArchiveView(tx, a, f.Version, v.Kind, v.ID, oldChat); err != nil {
						return err
					}
				}
				if !v.Deleted {
					if err := trackArchiveView(tx, a, f.Version, v.Kind, v.ID, v.ChatID); err != nil {
						return err
					}
				}
			}
			if v.Deleted {
				if _, err := tx.Exec("DELETE FROM archive WHERE space_id=? AND device_id=? AND kind=? AND id=?", a.space, a.device, v.Kind, v.ID); err != nil {
					return err
				}
				continue
			}
			if f.Full {
				if _, err := tx.Exec("DELETE FROM snapshot_missing WHERE kind=? AND id=?", v.Kind, v.ID); err != nil {
					return err
				}
			}
			if v.Status != oldStatus && (!f.Full || existed || v.Kind == "request" || epoch != "") {
				if err := h.queuePush(tx, a, v.Record); err != nil {
					return err
				}
			}
			raw, err := json.Marshal(v.Record)
			if err != nil {
				return err
			}
			if _, err = tx.Exec("INSERT INTO archive VALUES(?,?,?,?,?) ON CONFLICT(space_id,device_id,kind,id) DO UPDATE SET data=excluded.data", a.space, a.device, v.Kind, v.ID, string(raw)); err != nil {
				return err
			}
		}
		if f.Full {
			if _, err := tx.Exec("DELETE FROM archive WHERE space_id=? AND device_id=? AND (kind,id) IN (SELECT kind,id FROM snapshot_missing)", a.space, a.device); err != nil {
				return err
			}
			if _, err := tx.Exec("DROP TABLE snapshot_missing"); err != nil {
				return err
			}
		} else if _, err := tx.Exec("DELETE FROM archive_updates WHERE space_id=? AND device_id=? AND version<=?", a.space, a.device, floor); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE devices SET epoch=?,version=?,seen=? WHERE space_id=? AND id=?", f.Epoch, f.Version, time.Now().Unix(), a.space, a.device)
		if err != nil {
			return err
		}
		return syncDispatches(tx, a.space, a.device)
	})
}
func (h *Hub) archive(w http.ResponseWriter, r *http.Request, _ principal) error {
	if r.URL.Query().Get("sync") == "1" {
		return h.archivePage(w, r)
	}
	chat := r.URL.Query().Get("chat")
	rows, err := h.db.QueryContext(r.Context(), `SELECT data FROM archive WHERE space_id=? AND device_id=? AND
((?='' AND kind IN ('agent','chat','session')) OR (?<>'' AND ((kind='chat' AND id=?) OR json_extract(data,'$.chatId')=?))) ORDER BY kind,coalesce(json_extract(data,'$.sequence'),0),id`, r.PathValue("space"), r.PathValue("device"), chat, chat, chat, chat)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := []json.RawMessage{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		records = append(records, json.RawMessage(raw))
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, records)
}

func (h *Hub) verifyIdle(ctx context.Context, k deviceKey, session, run string, completed bool) error {
	h.mu.Lock()
	l := h.links[k]
	h.mu.Unlock()
	if l == nil {
		return conflict("device went offline")
	}
	id := p.NewID()
	result := make(chan bool, 1)
	l.probes.Store(id, result)
	defer l.probes.Delete(id)
	if err := l.send(p.Frame{Type: "verify_idle", SpaceID: k.space, DeviceID: k.device, RPCID: id, SessionID: session, RunID: run, Completed: completed}); err != nil {
		return conflict("device went offline")
	}
	select {
	case idle := <-result:
		if !idle {
			return conflict("latest Host result changed or queue is busy")
		}
		return nil
	case <-time.After(8 * time.Second):
		return conflict("device verification timed out")
	case <-ctx.Done():
		return ctx.Err()
	}
}
