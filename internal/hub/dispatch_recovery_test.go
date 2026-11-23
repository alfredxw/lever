package hub

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	p "lever/internal/remoteproto"
)

// The second Host can take over while the first is disconnected. Replies from
// the first Host must update only its pinned dispatch, even after an old backup.
func TestOfflineReassignmentAndAcceptance(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Setup("owner", "fixture-only password"); err != nil {
		t.Fatal(err)
	}
	var space, user string
	if err = h.db.QueryRow("SELECT space_id,user_id FROM memberships").Scan(&space, &user); err != nil {
		t.Fatal(err)
	}
	a, b, agent := p.NewID(), p.NewID(), p.NewID()
	for _, id := range []string{a, b} {
		if _, err = h.db.Exec("INSERT INTO devices(space_id,id,user_id,name,platform,role,pub,token) VALUES(?,?,?,'fixture','test','executor',zeroblob(32),?)", space, id, user, p.Token()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = h.db.Exec("INSERT INTO archive VALUES(?,?,?,?,?)", space, b, "agent", agent, encoded(p.Record{ID: agent, Kind: "agent"})); err != nil {
		t.Fatal(err)
	}
	h.links[deviceKey{space, b}] = &link{}
	defer delete(h.links, deviceKey{space, b})
	seed := func(status string) (p.Task, p.Dispatch, p.Intent) {
		t.Helper()
		d := p.Dispatch{ID: p.NewID(), DeviceID: a, TaskID: p.NewID(), Status: status}
		if status == "completed" {
			d.RunID = p.NewID()
			d.SessionID = p.NewID()
			d.ChatID = p.NewID()
		}
		task := p.Task{ID: d.TaskID, Title: "Task", Version: 1, Status: "running", DispatchID: d.ID}
		if status == "completed" {
			task.Status = "review"
		}
		i := p.Intent{ID: d.ID, Kind: "dispatch_task", ActorUserID: user, DeviceID: a, TaskID: task.ID}
		err := write(h.db, func(tx *sql.Tx) error {
			if _, err := tx.Exec("INSERT INTO tasks VALUES(?,?,?,?)", space, task.ID, "fixture", encoded(task)); err != nil {
				return err
			}
			if _, err := tx.Exec("INSERT INTO dispatches VALUES(?,?,?,?,?,?)", space, d.ID, task.ID, a, "fixture", encoded(d)); err != nil {
				return err
			}
			_, err := insertIntent(tx, space, i)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return task, d, i
	}
	call := func(id string, body any, action endpoint) error {
		r := httptest.NewRequest("POST", "/", bytes.NewBufferString(encoded(body)))
		r.Header.Set("Content-Type", "application/json")
		r.SetPathValue("space", space)
		r.SetPathValue("task", id)
		return action(httptest.NewRecorder(), r, principal{user: user, space: space, role: p.Controller})
	}
	mustConflict := func(err error) {
		t.Helper()
		var e problem
		if !errors.As(err, &e) || e.code != 409 {
			t.Fatalf("expected conflict, got %v", err)
		}
	}
	task, old, intent := seed("pending")
	next := dispatchInput{CommandID: p.NewID(), DeviceID: b, AgentID: agent, Version: task.Version}
	mustConflict(call(task.ID, next, h.dispatch))
	next.Force = true
	if err = call(task.ID, next, h.dispatch); err != nil {
		t.Fatal(err)
	}
	late := p.Receipt{ID: old.ID, Status: "accepted", RunID: p.NewID(), SessionID: p.NewID(), ChatID: p.NewID()}
	digest := p.Digest([]byte(encoded(intent)))
	if err = h.recordReceipt(principal{device: a, space: space}, late, digest); err != nil {
		t.Fatal(err)
	}
	err = write(h.db, func(tx *sql.Tx) error {
		r := p.Record{ID: late.RunID, Kind: "run", SessionID: late.SessionID, Status: "completed"}
		if _, err := tx.Exec("INSERT INTO archive VALUES(?,?,?,?,?)", space, a, r.Kind, r.ID, encoded(r)); err != nil {
			return err
		}
		return syncDispatches(tx, space, a)
	})
	if err != nil {
		t.Fatal(err)
	}
	history, err := get[p.Dispatch](h.db, "SELECT data FROM dispatches WHERE space_id=? AND id=?", space, old.ID)
	if err != nil || !history.Superseded || history.Status != "completed" || history.RunID != late.RunID {
		t.Fatal(history, err)
	}
	current, err := loadTask(h.db, space, task.ID)
	if err != nil || current.DispatchID != next.CommandID || current.Status != "running" {
		t.Fatal(current, err)
	}
	archived, complete, _ := seed("completed")
	accept := acceptance{Version: archived.Version, RunID: complete.RunID}
	mustConflict(call(archived.ID, accept, h.acceptTask))
	accept.ConfirmOffline = true
	if err = call(archived.ID, accept, h.acceptTask); err != nil {
		t.Fatal(err)
	}
	accepted, err := loadTask(h.db, space, archived.ID)
	if err != nil || !accepted.AcceptedOffline || accepted.AcceptedRunID != complete.RunID || accepted.Status != "done" {
		data, _ := json.Marshal(accepted)
		t.Fatal(string(data), err)
	}
}
