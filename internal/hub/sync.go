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
	"github.com/hashicorp/yamux"
	p "lever/internal/remoteproto"
)

type link struct {
	checkpoint chan struct{}
	tunnelID   string
	ended      chan struct{}
	tunnel     *yamux.Session // protected by Hub.mu
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
	l := &link{checkpoint: make(chan struct{}, 1), conn: ws, tunnelID: p.NewID(), ended: make(chan struct{})}
	defer close(l.ended)
	hello := p.Frame{Features: []string{p.FeatureTunnel, p.FeatureHotCache}, TunnelID: l.tunnelID, Type: "hello", Protocol: p.Version, SpaceID: a.space, DeviceID: a.device}
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
	if a.role.Executes() {
		h.syncReadCursorsToHost(r.Context(), a, l)
		h.syncClearedCursorsToHost(r.Context(), a, l)
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
		case "node":
			if f.Node == nil || f.Node.NodeID != a.device || !f.Node.Supports(p.FeaturePeer) {
				return nil
			}
			result, err := h.db.ExecContext(ctx, "UPDATE devices SET node=? WHERE space_id=? AND id=? AND generation=? AND pub=? AND revoked=0", encoded(f.Node), k.space, k.device, l.generation, f.Node.PublicKey)
			if err != nil {
				return nil
			}
			if n, _ := result.RowsAffected(); n != 1 {
				return nil
			}
			if _, err = h.db.ExecContext(ctx, "DELETE FROM node_hot_pages WHERE space_id=? AND device_id=? AND epoch<>?", k.space, k.device, f.Node.CacheEpoch); err != nil {
				return nil
			}
			select {
			case l.checkpoint <- struct{}{}:
			default:
			}
			h.notify(a.space)
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
		case "desktop_presence":
			var until int64
			if f.DesktopActive {
				until = time.Now().Add(50 * time.Second).Unix()
			}
			var prevUntil int64
			_ = h.db.QueryRowContext(ctx, "SELECT desktop_active_until FROM devices WHERE space_id=? AND id=? AND generation=?", k.space, k.device, l.generation).Scan(&prevUntil)
			if _, err := h.db.ExecContext(ctx, "UPDATE devices SET desktop_active_until=? WHERE space_id=? AND id=? AND generation=?", until, k.space, k.device, l.generation); err == nil {
				nowUnix := time.Now().Unix()
				if (prevUntil > nowUnix) != f.DesktopActive {
					h.notify(k.space)
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
	rows, err := h.db.QueryContext(ctx, `SELECT id,digest,json_extract(data,'$.receipt.status'),coalesce(json_extract(data,'$.intent.originDeviceId'),''),
		(coalesce(json_type(data,'$.intent.delegation'),'')='object' OR EXISTS(SELECT 1 FROM archive a WHERE a.space_id=receipts.space_id AND a.device_id=receipts.device_id AND a.kind='chat' AND a.id=coalesce(json_extract(receipts.data,'$.intent.chatId'),'') AND json_extract(a.data,'$.type')='delegation'))
		FROM receipts WHERE space_id=? AND device_id=? AND (json_extract(data,'$.receipt.status') IN ('pending','reviewing') OR (json_extract(data,'$.receipt.status')='cancelled' AND json_extract(data,'$.receipt.detail') IS NULL))`, k.space, k.device)
	if err != nil {
		return err
	}
	defer rows.Close()
	var probes []p.Frame
	for rows.Next() {
		f := p.Frame{SpaceID: k.space, DeviceID: k.device, Type: "query_command"}
		var status, controller string
		var isDelegation bool
		if err = rows.Scan(&f.RPCID, &f.Digest, &status, &controller, &isDelegation); err != nil {
			return err
		}
		if status == "cancelled" {
			f.Type = "cancel_dispatch"
		}
		probes = append(probes, f)
		if status != "cancelled" {
			probes = append(probes, p.Frame{Type: "offer_command", SpaceID: k.space, DeviceID: k.device, RPCID: f.RPCID, ControllerID: controller, Delegation: isDelegation})
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
			if err := queueLiveActivity(tx, a.space, a.device, "", v.Record); err != nil {
				return err
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
func (h *Hub) archive(w http.ResponseWriter, r *http.Request, a principal) error {
	if r.URL.Query().Get("sync") == "1" {
		return h.archivePage(w, r, a)
	}
	space, host, chat := r.PathValue("space"), r.PathValue("device"), r.URL.Query().Get("chat")
	cursors, err := loadDeviceReadCursors(h.db, space, a.user, host)
	if err != nil {
		return err
	}
	rows, err := h.db.QueryContext(r.Context(), `SELECT kind,id,data FROM archive WHERE space_id=? AND device_id=? AND
((?='' AND kind IN ('agent','chat','session')) OR (?<>'' AND ((kind='chat' AND id=?) OR json_extract(data,'$.chatId')=?))) ORDER BY kind,coalesce(json_extract(data,'$.sequence'),0),id`, space, host, chat, chat, chat, chat)
	if err != nil {
		return err
	}
	defer rows.Close()
	records := []json.RawMessage{}
	for rows.Next() {
		var kind, id, raw string
		if err = rows.Scan(&kind, &id, &raw); err != nil {
			return err
		}
		if kind == "session" {
			if cur := cursors[id]; cur > 0 {
				var rec p.Record
				if json.Unmarshal([]byte(raw), &rec) == nil && cur > rec.ReadSequence {
					rec.ReadSequence = cur
					if b, err := json.Marshal(rec); err == nil {
						raw = string(b)
					}
				}
			}
		}
		records = append(records, json.RawMessage(raw))
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, records)
}

func loadDeviceReadCursors(q query, space, user, device string) (map[string]int64, error) {
	rows, err := q.Query("SELECT session_id,sequence FROM read_cursors WHERE space_id=? AND user_id=? AND device_id=?", space, user, device)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var seq int64
		if err := rows.Scan(&id, &seq); err != nil {
			return nil, err
		}
		out[id] = seq
	}
	return out, rows.Err()
}

func (h *Hub) readCursors(w http.ResponseWriter, r *http.Request, a principal) error {
	rows, err := h.db.QueryContext(r.Context(), "SELECT device_id,session_id,sequence FROM read_cursors WHERE space_id=? AND user_id=?", r.PathValue("space"), a.user)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := map[string]map[string]int64{}
	for rows.Next() {
		var dev, sess string
		var seq int64
		if err := rows.Scan(&dev, &sess, &seq); err != nil {
			return err
		}
		m := out[dev]
		if m == nil {
			m = map[string]int64{}
			out[dev] = m
		}
		m[sess] = seq
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, out)
}

func (h *Hub) markRead(w http.ResponseWriter, r *http.Request, a principal) error {
	var in p.ReadSync
	if err := read(r, &in); err != nil {
		return err
	}
	if in.DeviceID == "" || len(in.Items) > 500 {
		return invalid("invalid read sync")
	}
	space := r.PathValue("space")
	var advanced []p.ReadMark
	var pushToHost bool
	err := write(h.db, func(tx *sql.Tx) error {
		var hostUser, spaceKind string
		err := tx.QueryRow(`SELECT d.user_id,s.kind FROM devices d JOIN spaces s ON s.id=d.space_id WHERE d.space_id=? AND d.id=?`, space, in.DeviceID).Scan(&hostUser, &spaceKind)
		if err != nil {
			return err
		}
		pushToHost = spaceKind == "personal" && hostUser == a.user
		for _, item := range in.Items {
			if item.SessionID == "" || len(item.SessionID) > 160 || item.Sequence <= 0 {
				continue
			}
			var prev int64
			err := tx.QueryRow("SELECT sequence FROM read_cursors WHERE space_id=? AND user_id=? AND device_id=? AND session_id=?", space, a.user, in.DeviceID, item.SessionID).Scan(&prev)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if item.Sequence <= prev {
				continue
			}
			if _, err = tx.Exec(`INSERT INTO read_cursors(space_id,user_id,device_id,session_id,sequence) VALUES(?,?,?,?,?)
ON CONFLICT(space_id,user_id,device_id,session_id) DO UPDATE SET sequence=max(sequence,excluded.sequence)`, space, a.user, in.DeviceID, item.SessionID, item.Sequence); err != nil {
				return err
			}
			advanced = append(advanced, item)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(advanced) > 0 {
		h.notify(space)
		if pushToHost {
			h.mu.Lock()
			l := h.links[deviceKey{space, in.DeviceID}]
			h.mu.Unlock()
			if l != nil {
				_ = l.send(p.Frame{Type: "mark_read", SpaceID: space, DeviceID: in.DeviceID, ReadMarks: advanced})
			}
		}
	}
	return send(w, true)
}

func (h *Hub) syncReadCursorsToHost(ctx context.Context, a principal, l *link) {
	var spaceKind string
	if err := h.db.QueryRowContext(ctx, "SELECT kind FROM spaces WHERE id=?", a.space).Scan(&spaceKind); err != nil || spaceKind != "personal" {
		return
	}
	rows, err := h.db.QueryContext(ctx, "SELECT session_id,sequence FROM read_cursors WHERE space_id=? AND user_id=? AND device_id=?", a.space, a.user, a.device)
	if err != nil {
		return
	}
	defer rows.Close()
	var batch []p.ReadMark
	flush := func() {
		if len(batch) == 0 {
			return
		}
		_ = l.send(p.Frame{Type: "mark_read", SpaceID: a.space, DeviceID: a.device, ReadMarks: batch})
		batch = nil
	}
	for rows.Next() {
		var m p.ReadMark
		if rows.Scan(&m.SessionID, &m.Sequence) == nil && m.SessionID != "" && m.Sequence > 0 {
			batch = append(batch, m)
			if len(batch) >= 200 {
				flush()
			}
		}
	}
	flush()
}

func (h *Hub) clearedCursors(w http.ResponseWriter, r *http.Request, a principal) error {
	rows, err := h.db.QueryContext(r.Context(), "SELECT device_id,session_id,sequence FROM cleared_cursors WHERE space_id=? AND user_id=?", r.PathValue("space"), a.user)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := map[string]map[string]int64{}
	for rows.Next() {
		var dev, sess string
		var seq int64
		if err := rows.Scan(&dev, &sess, &seq); err != nil {
			return err
		}
		m := out[dev]
		if m == nil {
			m = map[string]int64{}
			out[dev] = m
		}
		m[sess] = seq
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, out)
}

func (h *Hub) markCleared(w http.ResponseWriter, r *http.Request, a principal) error {
	var in p.ClearSync
	if err := read(r, &in); err != nil {
		return err
	}
	if in.DeviceID == "" || len(in.Items) > 500 {
		return invalid("invalid cleared sync")
	}
	space := r.PathValue("space")
	var changed []p.ClearMark
	var pushToHost bool
	err := write(h.db, func(tx *sql.Tx) error {
		var hostUser, spaceKind string
		err := tx.QueryRow(`SELECT d.user_id,s.kind FROM devices d JOIN spaces s ON s.id=d.space_id WHERE d.space_id=? AND d.id=?`, space, in.DeviceID).Scan(&hostUser, &spaceKind)
		if err != nil {
			return err
		}
		pushToHost = spaceKind == "personal" && hostUser == a.user
		for _, item := range in.Items {
			if item.SessionID == "" || len(item.SessionID) > 160 {
				continue
			}
			if item.Sequence <= 0 {
				res, err := tx.Exec("DELETE FROM cleared_cursors WHERE space_id=? AND user_id=? AND device_id=? AND session_id=?", space, a.user, in.DeviceID, item.SessionID)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n > 0 || pushToHost {
					changed = append(changed, p.ClearMark{SessionID: item.SessionID, Sequence: 0})
				}
				continue
			}
			seq := max(item.Sequence, int64(1))
			if _, err = tx.Exec(`INSERT INTO cleared_cursors(space_id,user_id,device_id,session_id,sequence) VALUES(?,?,?,?,?)
ON CONFLICT(space_id,user_id,device_id,session_id) DO UPDATE SET sequence=max(sequence,excluded.sequence)`, space, a.user, in.DeviceID, item.SessionID, seq); err != nil {
				return err
			}
			changed = append(changed, p.ClearMark{SessionID: item.SessionID, Sequence: seq})
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(changed) > 0 {
		h.notify(space)
		if pushToHost {
			h.mu.Lock()
			l := h.links[deviceKey{space, in.DeviceID}]
			h.mu.Unlock()
			if l != nil {
				_ = l.send(p.Frame{Type: "mark_cleared", SpaceID: space, DeviceID: in.DeviceID, ClearMarks: changed})
			}
		}
	}
	return send(w, true)
}

func (h *Hub) syncClearedCursorsToHost(ctx context.Context, a principal, l *link) {
	var spaceKind string
	if err := h.db.QueryRowContext(ctx, "SELECT kind FROM spaces WHERE id=?", a.space).Scan(&spaceKind); err != nil || spaceKind != "personal" {
		return
	}
	rows, err := h.db.QueryContext(ctx, "SELECT session_id,sequence FROM cleared_cursors WHERE space_id=? AND user_id=? AND device_id=?", a.space, a.user, a.device)
	if err != nil {
		return
	}
	defer rows.Close()
	var batch []p.ClearMark
	flush := func() {
		if len(batch) == 0 {
			return
		}
		_ = l.send(p.Frame{Type: "mark_cleared", SpaceID: a.space, DeviceID: a.device, ClearMarks: batch})
		batch = nil
	}
	for rows.Next() {
		var m p.ClearMark
		if rows.Scan(&m.SessionID, &m.Sequence) == nil && m.SessionID != "" && m.Sequence > 0 {
			batch = append(batch, m)
			if len(batch) >= 200 {
				flush()
			}
		}
	}
	flush()
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
