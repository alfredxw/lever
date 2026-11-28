package hub

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	p "lever/internal/remoteproto"
)

func (h *Hub) taskRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/spaces/{space}/lan-receipts", h.handler("executor", h.reportLAN))
	m.HandleFunc("GET /api/spaces/{space}/tasks", h.handler("controller", h.tasks))
	m.HandleFunc("POST /api/spaces/{space}/tasks", h.handler("controller", h.createTask))
	m.HandleFunc("GET /api/spaces/{space}/tasks/{task}", h.handler("controller", h.task))
	m.HandleFunc("PATCH /api/spaces/{space}/tasks/{task}", h.handler("controller", h.updateTask))
	m.HandleFunc("POST /api/spaces/{space}/tasks/{task}/dispatch", h.handler("controller", h.dispatch))
	m.HandleFunc("POST /api/spaces/{space}/tasks/{task}/accept", h.handler("controller", h.acceptTask))
	m.HandleFunc("POST /api/spaces/{space}/commands", h.handler("controller", h.submit))
	m.HandleFunc("GET /api/spaces/{space}/commands/{device}/{id}", h.handler("controller", h.lookup))
	m.HandleFunc("GET /api/spaces/{space}/inbox", h.handler("executor", h.inbox))
	m.HandleFunc("GET /api/spaces/{space}/inbox/{id}", h.handler("executor", h.inboxItem))
	m.HandleFunc("POST /api/spaces/{space}/inbox/{id}", h.handler("executor", h.receive))
}

type query interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

func get[T any](q query, sql string, args ...any) (T, error) {
	var v T
	var b string
	if err := q.QueryRow(sql, args...).Scan(&b); err != nil {
		return v, err
	}
	err := json.Unmarshal([]byte(b), &v)
	return v, err
}
func list[T any](q query, sql string, args ...any) ([]T, error) {
	rows, err := q.Query(sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []T{}
	for rows.Next() {
		var raw string
		var v T
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}
func encoded(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
func validID(id string) bool { _, err := uuid.Parse(id); return len(id) == 36 && err == nil }
func loadTask(q query, space, id string) (p.Task, error) {
	return get[p.Task](q, "SELECT data FROM tasks WHERE space_id=? AND id=?", space, id)
}
func saveTask(tx *sql.Tx, space string, t p.Task) error {
	_, err := tx.Exec("UPDATE tasks SET data=? WHERE space_id=? AND id=?", encoded(t), space, t.ID)
	return err
}
func (h *Hub) tasks(w http.ResponseWriter, r *http.Request, _ principal) error {
	out, err := list[p.Task](h.db, "SELECT data FROM tasks WHERE space_id=? ORDER BY rowid DESC", r.PathValue("space"))
	if err != nil {
		return err
	}
	return send(w, out)
}
func (h *Hub) task(w http.ResponseWriter, r *http.Request, _ principal) error {
	space, id := r.PathValue("space"), r.PathValue("task")
	t, err := loadTask(h.db, space, id)
	if err != nil {
		return err
	}
	history, err := list[p.Dispatch](h.db, "SELECT data FROM dispatches WHERE space_id=? AND task_id=? ORDER BY rowid DESC", space, id)
	if err != nil {
		return err
	}
	return send(w, map[string]any{"task": t, "history": history})
}

type taskInput struct {
	Project *string    `json:"project,omitempty"`
	Source  *p.ChatRef `json:"source,omitempty"`
	Close   bool       `json:"close,omitempty"`
	ID      string     `json:"id,omitempty"`
	Title   string     `json:"title"`
	Body    string     `json:"body"`
	Version int64      `json:"version,omitempty"`
}

func (v taskInput) valid() bool {
	return (v.Project == nil || len(*v.Project) <= 160) && strings.TrimSpace(v.Title) != "" && len(v.Title) <= 512 && len(v.Body) <= 256<<10
}
func (h *Hub) createTask(w http.ResponseWriter, r *http.Request, a principal) error {
	var in taskInput
	if err := read(r, &in); err != nil {
		return err
	}
	if !validID(in.ID) || !in.valid() {
		return invalid("provide a task UUID, title and body (up to 256 KiB)")
	}
	space := r.PathValue("space")
	digest := p.Digest([]byte(encoded(in) + a.user))
	t := p.Task{ID: in.ID, Title: in.Title, Body: in.Body, Version: 1, Status: "todo"}
	t.Source = in.Source
	if in.Close {
		return invalid("create the task before closing it")
	}
	if in.Project != nil {
		t.Project = strings.TrimSpace(*in.Project)
	}
	// The authoritative Owner supplies unshared personal chat IDs. An offline
	// Owner may still have an access-scoped index in the hot cache.
	var native, linked bool
	var viewErr error
	if src := in.Source; src != nil {
		var view *p.NodeOverview
		view, viewErr = h.taskOwnerView(r.Context(), a, space, src.DeviceID, "chat", src.ChatID)
		if view != nil {
			native = true
			for _, c := range view.Chats {
				if c.ID == src.ChatID {
					linked = true
					break
				}
			}
			if linked && src.SessionID != "" {
				linked = false
				for _, c := range view.Conversations {
					if c.ID == src.SessionID && c.ChatID == src.ChatID {
						linked = true
						break
					}
				}
			}
		}
	}
	err := write(h.db, func(tx *sql.Tx) error {
		res, err := tx.Exec("INSERT OR IGNORE INTO tasks VALUES(?,?,?,?)", space, t.ID, digest, encoded(t))
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n != 0 {
			if viewErr != nil {
				return viewErr
			}
			if native && !linked {
				return invalid("select a visible conversation in this space")
			}
			if src := in.Source; src != nil && !native {
				var visible bool
				if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM archive WHERE space_id=? AND device_id=? AND kind='chat' AND id=?) AND (?='' OR EXISTS(SELECT 1 FROM archive WHERE space_id=? AND device_id=? AND kind='session' AND id=? AND json_extract(data,'$.chatId')=?))`, space, src.DeviceID, src.ChatID, src.SessionID, space, src.DeviceID, src.SessionID, src.ChatID).Scan(&visible); err != nil {
					return err
				}
				if !visible {
					return invalid("select a shared conversation in this space")
				}
			}
			return nil
		}
		var old string
		if err = tx.QueryRow("SELECT create_hash FROM tasks WHERE space_id=? AND id=?", space, t.ID).Scan(&old); err != nil {
			return err
		}
		if old != digest {
			return conflict("task ID already used with different content")
		}
		t, err = loadTask(tx, space, t.ID)
		return err
	})
	if err != nil {
		return err
	}
	h.notify(space)
	return send(w, t)
}
func (h *Hub) updateTask(w http.ResponseWriter, r *http.Request, _ principal) error {
	var in taskInput
	if err := read(r, &in); err != nil {
		return err
	}
	if !in.valid() {
		return invalid("invalid task title or body")
	}
	space := r.PathValue("space")
	var t p.Task
	err := write(h.db, func(tx *sql.Tx) error {
		var err error
		t, err = loadTask(tx, space, r.PathValue("task"))
		if err != nil {
			return err
		}
		if t.Version != in.Version {
			return conflict("task changed; refresh")
		}
		if in.Source != nil {
			return invalid("task source is fixed at creation")
		}
		if in.Project != nil {
			t.Project = strings.TrimSpace(*in.Project)
		}
		if in.Close {
			if t.Status == "done" {
				return conflict("task is already accepted")
			}
			if t.DispatchID != "" {
				d, err := get[p.Dispatch](tx, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, t.DispatchID)
				if err != nil {
					return err
				}
				switch d.Status {
				case "completed", "interrupted", "failed", "declined", "cancelled":
				default:
					return conflict("finish or stop the active dispatch first")
				}
			}
			t.Status = "closed"
		}
		t.Title = in.Title
		t.Body = in.Body
		t.Version++
		return saveTask(tx, space, t)
	})
	if err != nil {
		return err
	}
	h.notify(space)
	return send(w, t)
}

type dispatchInput struct {
	CommandID     string `json:"commandId"`
	DeviceID      string `json:"deviceId"`
	AgentID       string `json:"agentId"`
	WorkingCopyID string `json:"workingCopyId,omitempty"`
	Text          string `json:"text,omitempty"`
	Version       int64  `json:"version"`
	Force         bool   `json:"force,omitempty"`
}

func (h *Hub) target(tx *sql.Tx, space, device, agent, group string, view *p.NodeOverview) error {
	var active bool
	err := tx.QueryRow("SELECT role IN ('workstation','executor') AND revoked=0 AND draining=0 FROM devices WHERE space_id=? AND id=?", space, device).Scan(&active)
	if err != nil {
		return err
	}
	if !active || !h.online(deviceKey{space, device}) {
		return conflict("target is offline, paused or revoked")
	}
	if view != nil {
		visible := false
		for _, a := range view.Agents {
			if a.ID == agent {
				visible = true
				break
			}
		}
		if !visible {
			return denied
		}
		if group == "" {
			return nil
		}
		// A named worktree is still validated by the legacy directory and by
		// the Owner when it accepts the command.
	}
	rec, err := get[p.Record](tx, "SELECT data FROM archive WHERE space_id=? AND device_id=? AND kind='agent' AND id=?", space, device, agent)
	if err != nil {
		return err
	}
	if group != "" {
		for _, v := range rec.Groups {
			if v.ID == group && v.State != "unavailable" {
				return nil
			}
		}
		return invalid("directory group unavailable")
	}
	return nil
}
func (h *Hub) dispatch(w http.ResponseWriter, r *http.Request, a principal) error {
	var in dispatchInput
	if err := read(r, &in); err != nil {
		return err
	}
	if !validID(in.CommandID) || len(in.Text) > 256<<10 {
		return invalid("invalid dispatch")
	}
	space, id := r.PathValue("space"), r.PathValue("task")
	digest := p.Digest([]byte(encoded(in) + id + a.user))
	var d p.Dispatch
	var verifiedRun string
	previousTask, err := loadTask(h.db, space, id)
	if err != nil {
		return err
	}
	if previousTask.DispatchID != "" && previousTask.DispatchID != in.CommandID {
		old, err := get[p.Dispatch](h.db, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, previousTask.DispatchID)
		if err != nil {
			return err
		}
		k := deviceKey{space, old.DeviceID}
		if old.SessionID != "" && h.online(k) {
			if err = h.verifyIdle(r.Context(), k, old.SessionID, old.RunID, false); err != nil {
				return err
			}
			verifiedRun = old.RunID
		}
	}
	view, viewErr := h.taskOwnerView(r.Context(), a, space, in.DeviceID, "agent", in.AgentID)
	err = write(h.db, func(tx *sql.Tx) error {
		var previous string
		err := tx.QueryRow("SELECT digest FROM dispatches WHERE space_id=? AND id=?", space, in.CommandID).Scan(&previous)
		if err == nil {
			if digest != previous {
				return conflict("command ID already used")
			}
			d, err = get[p.Dispatch](tx, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, in.CommandID)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		t, err := loadTask(tx, space, id)
		if err != nil {
			return err
		}
		if t.Version != in.Version || t.Status == "done" || t.Status == "closed" {
			return conflict("task changed; refresh")
		}
		if viewErr != nil {
			return viewErr
		}
		if err = h.target(tx, space, in.DeviceID, in.AgentID, in.WorkingCopyID, view); err != nil {
			return err
		}
		if t.DispatchID != "" {
			old, err := get[p.Dispatch](tx, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, t.DispatchID)
			if err != nil {
				return err
			}
			switch old.Status {
			case "completed", "interrupted", "failed":
				if h.online(deviceKey{space, old.DeviceID}) && (verifiedRun == "" || verifiedRun != old.RunID) {
					return conflict("original device result changed")
				}
			case "pending":
				if !h.online(deviceKey{space, old.DeviceID}) && !in.Force {
					return conflict("confirm reassignment of the offline device")
				}
			case "declined":
			default:
				if h.online(deviceKey{space, old.DeviceID}) || !in.Force {
					return conflict("stop the original execution, or confirm force reassignment while its device is offline")
				}
			}
			if old.Status == "pending" || old.Status == "reviewing" {
				old.Status = "cancelled"
			}
			old.Superseded = true
			if _, err = tx.Exec("UPDATE dispatches SET data=? WHERE space_id=? AND id=?", encoded(old), space, old.ID); err != nil {
				return err
			}
			if _, err = tx.Exec("UPDATE receipts SET data=json_set(data,'$.receipt.status','cancelled') WHERE space_id=? AND device_id=? AND id=? AND json_extract(data,'$.receipt.status') IN ('pending','reviewing')", space, old.DeviceID, old.ID); err != nil {
				return err
			}
		}
		msg := strings.TrimSpace(strings.Join([]string{t.Title, t.Body, in.Text}, "\n\n"))
		d = p.Dispatch{ID: in.CommandID, TaskID: id, DeviceID: in.DeviceID, AgentID: in.AgentID, WorkingCopyID: in.WorkingCopyID, Instruction: msg, ActorUserID: a.user, OriginDeviceID: a.device, Status: "pending"}
		if _, err = tx.Exec("INSERT INTO dispatches VALUES(?,?,?,?,?,?)", space, d.ID, id, d.DeviceID, digest, encoded(d)); err != nil {
			return err
		}
		i := p.Intent{ID: d.ID, Kind: "dispatch_task", DeviceID: d.DeviceID, AgentID: d.AgentID, WorkingCopyID: d.WorkingCopyID, TaskID: id, Text: msg, Operation: "main", ActorUserID: a.user, OriginDeviceID: a.device}
		if _, err = insertIntent(tx, space, i); err != nil {
			return err
		}
		t.DeviceID = d.DeviceID
		t.DispatchID = d.ID
		t.Status = "running"
		t.Version++
		return saveTask(tx, space, t)
	})
	if err != nil {
		return err
	}
	h.notify(space)
	h.offer(space, d.DeviceID, d.OriginDeviceID, d.ID, false)
	return send(w, d)
}

func (h *Hub) offer(space, host, controller, id string, delegation bool) {
	h.mu.Lock()
	l := h.links[deviceKey{space, host}]
	h.mu.Unlock()
	if l != nil && l.conn != nil {
		_ = l.send(p.Frame{Type: "offer_command", SpaceID: space, DeviceID: host, ControllerID: controller, Delegation: delegation, RPCID: id})
	}
}
func insertIntent(tx *sql.Tx, space string, i p.Intent) (p.InboxItem, error) {
	item := p.InboxItem{Intent: i, Receipt: p.Receipt{ID: i.ID, Status: "pending"}}
	hash := p.Digest([]byte(encoded(i)))
	res, err := tx.Exec("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)", space, i.DeviceID, i.ID, hash, encoded(item))
	if err != nil {
		return item, err
	}
	n, _ := res.RowsAffected()
	if n != 0 {
		return item, nil
	}
	var prev, raw string
	if err = tx.QueryRow("SELECT digest,data FROM receipts WHERE space_id=? AND device_id=? AND id=?", space, i.DeviceID, i.ID).Scan(&prev, &raw); err != nil {
		return item, err
	}
	if hash != prev {
		return item, conflict("command ID is bound to different input")
	}
	err = json.Unmarshal([]byte(raw), &item)
	return item, err
}
func (h *Hub) submit(w http.ResponseWriter, r *http.Request, a principal) error {
	var i p.Intent
	if err := read(r, &i); err != nil {
		return err
	}
	if i.Private || !validID(i.ID) || i.TaskID != "" || len(i.Text) > 256<<10 {
		return invalid("invalid command")
	}
	i.ActorUserID = a.user
	i.OriginDeviceID = a.device
	if i.Delegation != nil {
		if i.Kind != "send" || a.device == "" || i.Delegation.DeviceID != a.device || i.Delegation.AgentID == "" || i.Delegation.RunID == "" || i.Delegation.DelegationID == "" {
			return invalid("invalid delegation origin")
		}
	}
	space := r.PathValue("space")
	var item p.InboxItem
	isDelegation := i.Delegation != nil
	var view *p.NodeOverview
	var viewErr error
	if i.Kind == "send" && i.ChatID == "" {
		view, viewErr = h.taskOwnerView(r.Context(), a, space, i.DeviceID, "agent", i.AgentID)
	}
	err := write(h.db, func(tx *sql.Tx) error {
		if old, err := get[p.InboxItem](tx, "SELECT data FROM receipts WHERE space_id=? AND device_id=? AND id=?", space, i.DeviceID, i.ID); err == nil {
			if encoded(old.Intent) != encoded(i) {
				return conflict("command ID is bound to different input")
			}
			item = old
			return nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if !h.online(deviceKey{space, i.DeviceID}) {
			return conflict("device offline")
		}
		if i.Kind == "send" && i.ChatID == "" {
			if viewErr != nil {
				return viewErr
			}
			if err := h.target(tx, space, i.DeviceID, i.AgentID, i.WorkingCopyID, view); err != nil {
				return err
			}
			if i.Delegation != nil {
				rec, err := get[p.Record](tx, "SELECT data FROM archive WHERE space_id=? AND device_id=? AND kind='agent' AND id=?", space, i.DeviceID, i.AgentID)
				if err != nil {
					return err
				}
				if rec.AcceptDelegations != nil && !*rec.AcceptDelegations {
					return denied
				}
			}
		} else {
			chat, err := get[p.Record](tx, "SELECT data FROM archive WHERE space_id=? AND device_id=? AND kind='chat' AND id=?", space, i.DeviceID, i.ChatID)
			if err != nil {
				return err
			}
			if i.AgentID != "" && i.AgentID != chat.AgentID {
				return denied
			}
			if chat.Type == "delegation" {
				isDelegation = true
			}
		}
		switch i.Kind {
		case "send":
			if strings.TrimSpace(i.Text) == "" || (i.Operation != "main" && i.Operation != "topic" && i.Operation != "reply") {
				return invalid("invalid message")
			}
		case "answer":
			if i.Answer == nil || i.RequestID == "" {
				return invalid("answer required")
			}
		case "stop", "resolve_unknown", "allow_run":
			if i.RunID == "" {
				return invalid("run required")
			}
		case "resume_queue":
			if i.SessionID == "" {
				return invalid("session required")
			}
		default:
			return invalid("unknown command")
		}
		var err error
		item, err = insertIntent(tx, space, i)
		return err
	})
	if err != nil {
		return err
	}
	h.notify(space)
	h.offer(space, i.DeviceID, a.device, i.ID, isDelegation)
	return send(w, item)
}
func (h *Hub) lookup(w http.ResponseWriter, r *http.Request, _ principal) error {
	v, err := get[p.InboxItem](h.db, "SELECT data FROM receipts WHERE space_id=? AND device_id=? AND id=?", r.PathValue("space"), r.PathValue("device"), r.PathValue("id"))
	if err != nil {
		return err
	}
	return send(w, v)
}
func (h *Hub) inbox(w http.ResponseWriter, r *http.Request, a principal) error {
	v, err := list[p.InboxItem](h.db, "SELECT data FROM receipts WHERE space_id=? AND device_id=? AND json_extract(data,'$.receipt.status') IN ('pending','reviewing') ORDER BY rowid LIMIT 250", a.space, a.device)
	if err != nil {
		return err
	}
	return send(w, v)
}
func (h *Hub) inboxItem(w http.ResponseWriter, r *http.Request, a principal) error {
	item, err := get[p.InboxItem](h.db, "SELECT data FROM receipts WHERE space_id=? AND device_id=? AND id=?", a.space, a.device, r.PathValue("id"))
	if err != nil {
		return err
	}
	return send(w, item)
}
func (h *Hub) receive(w http.ResponseWriter, r *http.Request, a principal) error {
	var rec p.Receipt
	if err := read(r, &rec); err != nil {
		return err
	}
	if rec.ID != r.PathValue("id") {
		return invalid("receipt target mismatch")
	}
	switch rec.Status {
	case "reviewing", "accepted", "declined", "failed":
	default:
		return invalid("invalid receipt")
	}
	if err := h.recordReceipt(a, rec, ""); err != nil {
		return err
	}
	h.notify(a.space)
	return send(w, true)
}
func (h *Hub) recordReceipt(a principal, rec p.Receipt, digest string) error {
	recovery := digest != ""
	return write(h.db, func(tx *sql.Tx) error {
		item, err := get[p.InboxItem](tx, "SELECT data FROM receipts WHERE space_id=? AND device_id=? AND id=?", a.space, a.device, rec.ID)
		if err != nil {
			return err
		}
		old := item.Receipt
		if rec.Status == "reviewing" && item.Intent.OriginDeviceID != "" {
			var active bool
			if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM devices WHERE space_id=? AND id=? AND user_id=? AND revoked=0 AND role IN ('workstation','controller'))", a.space, item.Intent.OriginDeviceID, item.Intent.ActorUserID).Scan(&active); err != nil {
				return err
			}
			if !active {
				return denied
			}
		}
		if old.Status == rec.Status && encoded(old) == encoded(rec) {
			return nil
		}
		if recovery {
			var expected string
			if err := tx.QueryRow("SELECT digest FROM receipts WHERE space_id=? AND device_id=? AND id=?", a.space, a.device, rec.ID).Scan(&expected); err != nil {
				return err
			}
			if expected != digest {
				return conflict("command input changed")
			}
		}
		if old.Status != "pending" && old.Status != "reviewing" && !(recovery && old.Status == "cancelled" && item.Intent.Kind == "dispatch_task") {
			return conflict("command already resolved")
		}
		if !recovery && old.Status == "pending" && rec.Status == "accepted" {
			return conflict("command not claimed")
		}
		item.Receipt = rec
		if _, err = tx.Exec("UPDATE receipts SET data=? WHERE space_id=? AND device_id=? AND id=?", encoded(item), a.space, a.device, rec.ID); err != nil {
			return err
		}
		if item.Intent.Kind == "dispatch_task" {
			d, err := get[p.Dispatch](tx, "SELECT data FROM dispatches WHERE space_id=? AND id=?", a.space, rec.ID)
			if err != nil {
				return err
			}
			d.ChatID, d.SessionID, d.RunID, d.Status = rec.ChatID, rec.SessionID, rec.RunID, rec.Status
			if _, err = tx.Exec("UPDATE dispatches SET data=? WHERE space_id=? AND id=?", encoded(d), a.space, d.ID); err != nil {
				return err
			}
			return syncDispatches(tx, a.space, a.device)
		}
		return nil
	})
}
func syncDispatches(tx *sql.Tx, space, device string) error {
	// Follow late progress on a superseded execution by its pinned Run ID.
	// Subsequent turns in its Chat cannot replace the historical result.
	if _, err := tx.Exec(`UPDATE dispatches AS d SET data=json_set(d.data,'$.status',json_extract(a.data,'$.status')) FROM archive AS a WHERE d.space_id=? AND d.device_id=? AND json_extract(d.data,'$.superseded')=1 AND a.space_id=d.space_id AND a.device_id=d.device_id AND a.kind='run' AND a.id=json_extract(d.data,'$.runId') AND json_extract(d.data,'$.status')<>json_extract(a.data,'$.status')`, space, device); err != nil {
		return err
	}
	ds, err := list[p.Dispatch](tx, `SELECT d.data FROM dispatches d JOIN tasks t ON t.space_id=d.space_id AND t.id=d.task_id WHERE d.space_id=? AND d.device_id=? AND json_extract(t.data,'$.dispatchId')=d.id AND json_extract(t.data,'$.status') NOT IN ('done','closed')`, space, device)
	if err != nil {
		return err
	}
	for _, d := range ds {
		r, err := get[p.Record](tx, `SELECT data FROM archive WHERE space_id=? AND device_id=? AND kind='run' AND json_extract(data,'$.sessionId')=? AND coalesce(json_extract(data,'$.superseded'),0)=0 ORDER BY json_extract(data,'$.sequence') DESC LIMIT 1`, space, device, d.SessionID)
		if err == nil {
			d.RunID = r.ID
			d.Status = r.Status
		} else if errors.Is(err, sql.ErrNoRows) && d.SessionID != "" && d.Status != "accepted" {
			d.Status = "unknown"
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err = tx.Exec("UPDATE dispatches SET data=? WHERE space_id=? AND id=?", encoded(d), space, d.ID); err != nil {
			return err
		}
		t, err := loadTask(tx, space, d.TaskID)
		if err != nil {
			return err
		}
		status := "running"
		switch d.Status {
		case "completed":
			status = "review"
		case "unknown", "failed", "interrupted", "waiting_user", "declined":
			status = "attention"
		}
		if t.Status != status {
			t.Status = status
			t.Version++
			if err = saveTask(tx, space, t); err != nil {
				return err
			}
		}
	}
	return nil
}

type acceptance struct {
	Version        int64  `json:"version"`
	RunID          string `json:"runId"`
	ConfirmOffline bool   `json:"confirmOffline"`
}

func (h *Hub) acceptTask(w http.ResponseWriter, r *http.Request, _ principal) error {
	var in acceptance
	if err := read(r, &in); err != nil {
		return err
	}
	space, id := r.PathValue("space"), r.PathValue("task")
	t, err := loadTask(h.db, space, id)
	if err != nil {
		return err
	}
	d, err := get[p.Dispatch](h.db, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, t.DispatchID)
	if err != nil {
		return err
	}
	if t.Status == "done" && t.AcceptedRunID == in.RunID {
		return send(w, t)
	}
	k := deviceKey{space, d.DeviceID}
	online := h.online(k)
	if online {
		if err = h.verifyIdle(r.Context(), k, d.SessionID, in.RunID, true); err != nil {
			return err
		}
	} else if !in.ConfirmOffline {
		return conflict("confirm acceptance against the last offline snapshot")
	}
	err = write(h.db, func(tx *sql.Tx) error {
		var err error
		t, err = loadTask(tx, space, id)
		if err != nil {
			return err
		}
		if t.Status == "done" && t.AcceptedRunID == in.RunID {
			return nil
		}
		if t.Version != in.Version || t.DispatchID != d.ID || t.Status != "review" || in.RunID == "" {
			return conflict("task changed; refresh")
		}
		d, err = get[p.Dispatch](tx, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, d.ID)
		if err != nil {
			return err
		}
		if d.RunID != in.RunID || d.Status != "completed" {
			return conflict("latest result changed")
		}
		t.AcceptedRunID = in.RunID
		t.AcceptedOffline = !online
		t.Status = "done"
		t.Version++
		return saveTask(tx, space, t)
	})
	if err != nil {
		return err
	}
	h.notify(space)
	return send(w, t)
}
