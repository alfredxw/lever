package app

import (
	"context"
	"database/sql"
	"errors"

	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type remoteOrigin struct {
	scope  model.SharedScope
	intent p.Intent
	digest string
}

func checkExposed(tx *sql.Tx, scope model.SharedScope, agent string) error {
	var ok bool
	err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM agents a JOIN remote_memberships m ON m.hub=? AND m.space=?
WHERE a.id=? AND coalesce(json_extract(a.data,'$.archived'),0)=0
AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`, scope.HubID, scope.SpaceID, agent).Scan(&ok)
	if err == nil && !ok {
		return &Error{Status: 403, Message: "Agent is not shared with this space"}
	}
	return err
}
func (o *remoteOrigin) authorize(tx *sql.Tx, chat model.Chat) error {
	if o.intent.Private {
		if chat.SharedScope != nil || chat.ID == "" || o.intent.OriginDeviceID == "" {
			return invalid("invalid device-only target")
		}
		var allowed bool
		err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM remote_private_chats WHERE hub=? AND space=? AND controller=? AND chat=?)", o.scope.HubID, o.scope.SpaceID, o.intent.OriginDeviceID, chat.ID).Scan(&allowed)
		if err != nil {
			return err
		}
		if !allowed {
			return &Error{Status: 403, Message: "Device-only Chat is not shared with this controller"}
		}
		return nil
	}
	if chat.SharedScope == nil || *chat.SharedScope != o.scope || (o.intent.AgentID != "" && o.intent.AgentID != chat.AgentID) {
		return &Error{Status: 403, Message: "Chat belongs to a different scope"}
	}
	return checkExposed(tx, o.scope, chat.AgentID)
}
func (o *remoteOrigin) record(tx *sql.Tx, run model.Run) error {
	rec := p.Receipt{ID: o.intent.ID, Status: "accepted", RunID: run.ID, ChatID: run.ChatID, SessionID: run.SessionID}
	_, err := tx.Exec("INSERT INTO remote_commands VALUES(?,?,?,?,?)", o.scope.HubID, o.scope.SpaceID, o.intent.ID, o.digest, store.JSON(rec))
	return err
}
func (a *App) RemoteReceipt(ctx context.Context, scope model.SharedScope, i p.Intent) (p.Receipt, error) {
	var rec p.Receipt
	var digest string
	err := a.Store.DB.QueryRowContext(ctx, "SELECT digest FROM remote_commands WHERE hub=? AND space=? AND id=?", scope.HubID, scope.SpaceID, i.ID).Scan(&digest)
	if err != nil {
		return rec, err
	}
	if digest != hash(i) {
		return rec, errCommandConflict
	}
	return store.Get[p.Receipt](ctx, a.Store.DB, "SELECT receipt FROM remote_commands WHERE hub=? AND space=? AND id=?", scope.HubID, scope.SpaceID, i.ID)
}

// RememberRemoteDecision keeps a local operator's terminal decision across
// relay retries and restoration of an older Hub backup.
func (a *App) RememberRemoteDecision(ctx context.Context, scope model.SharedScope, i p.Intent, rec p.Receipt) (p.Receipt, error) {
	if _, err := a.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO remote_commands VALUES(?,?,?,?,?)", scope.HubID, scope.SpaceID, i.ID, hash(i), store.JSON(rec)); err != nil {
		return p.Receipt{}, err
	}
	return a.RemoteReceipt(ctx, scope, i)
}

// ReviewRemote applies an action after a Host operator reviewed the bound
// command. The remote transport cannot grant itself that local permission.
func (a *App) ReviewRemote(ctx context.Context, scope model.SharedScope, i p.Intent) (p.Receipt, error) {
	empty := p.Receipt{ID: i.ID}
	if rec, err := a.RemoteReceipt(ctx, scope, i); !errors.Is(err, sql.ErrNoRows) {
		return rec, err
	}
	o := remoteOrigin{scope: scope, intent: i, digest: hash(i)}
	if i.Kind == "send" || i.Kind == "dispatch_task" {
		in := model.SendInput{CommandID: "hub:" + hash([]string{scope.HubID, scope.SpaceID, i.ID}), AgentID: i.AgentID, ChatID: i.ChatID, SessionID: i.SessionID, Text: i.Text, WorkingCopyID: i.WorkingCopyID, Operation: i.Operation, Delivery: i.Delivery}
		if i.ChatID == "" {
			if i.Private {
				return empty, invalid("a device-only Chat must be selected locally")
			}
			in.SharedScope = &scope
		} else {
			in.AgentID = ""
		}
		a.mu.Lock()
		run, err := a.sendLocked(ctx, in, sendOrigin{remote: &o})
		a.mu.Unlock()
		if err != nil {
			return empty, err
		}
		return p.Receipt{ID: i.ID, Status: "accepted", ChatID: run.ChatID, SessionID: run.SessionID, RunID: run.ID}, nil
	}
	// Joined targets prevent substituting a private request, run, or Topic ID
	// into an otherwise permitted Chat.
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		chat, err := store.Get[model.Chat](ctx, tx, "SELECT data FROM chats WHERE id=?", i.ChatID)
		if err != nil {
			return err
		}
		if i.Private {
			if err = o.authorize(tx, chat); err != nil {
				return err
			}
		} else if chat.SharedScope == nil || *chat.SharedScope != scope {
			return &Error{Status: 403, Message: "Chat is not shared here"}
		}
		if !i.Private && i.Kind != "stop" {
			if err = checkExposed(tx, scope, chat.AgentID); err != nil {
				return err
			}
		}
		var id string
		switch i.Kind {
		case "answer":
			if i.Answer == nil {
				return invalid("missing answer")
			}
			return tx.QueryRow("SELECT id FROM requests WHERE id=? AND chat_id=?", i.RequestID, chat.ID).Scan(&id)
		case "allow_run", "stop", "resolve_unknown":
			return tx.QueryRow("SELECT id FROM runs WHERE id=? AND chat_id=?", i.RunID, chat.ID).Scan(&id)
		case "resume_queue":
			return tx.QueryRow("SELECT id FROM sessions WHERE id=? AND chat_id=?", i.SessionID, chat.ID).Scan(&id)
		default:
			return invalid("unsupported remote action")
		}
	})
	if err != nil {
		return empty, err
	}
	switch i.Kind {
	case "answer":
		if err = a.answer(ctx, i.RequestID, model.Answer{Allow: i.Answer.Allow, OptionID: i.Answer.OptionID, Answers: i.Answer.Answers}, &o); err != nil {
			return empty, err
		}
		return a.RemoteReceipt(ctx, scope, i)
	case "stop":
		err = a.Stop(ctx, i.RunID)
	case "allow_run":
		err = a.SetRunApprovals(ctx, i.RunID, true)
	case "resolve_unknown":
		err = a.Resolve(ctx, i.RunID)
	case "resume_queue":
		err = a.ResumeQueue(ctx, i.SessionID)
	}
	if err != nil {
		return empty, err
	}
	rec := p.Receipt{ID: i.ID, Status: "accepted", ChatID: i.ChatID, SessionID: i.SessionID, RunID: i.RunID}
	return a.RememberRemoteDecision(ctx, scope, i, rec)
}
func (a *App) SharedIdle(ctx context.Context, scope model.SharedScope, session, run string, completed bool) (bool, error) {
	var ok bool
	err := a.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sessions s JOIN chats c ON c.id=s.chat_id
WHERE s.id=? AND s.kind='main' AND json_extract(c.data,'$.sharedScope.hubId')=? AND json_extract(c.data,'$.sharedScope.spaceId')=?
AND (SELECT id FROM runs WHERE session_id=s.id AND coalesce(json_extract(data,'$.superseded'),0)=0 ORDER BY sequence DESC LIMIT 1)=?
AND EXISTS(SELECT 1 FROM runs WHERE id=? AND session_id=s.id AND (status='completed' OR (?=0 AND status IN ('failed','interrupted'))))
AND NOT EXISTS(SELECT 1 FROM runs WHERE session_id=s.id AND status IN ('starting','running','waiting_user','cancelling','unknown','queued','steering','paused')))`, session, scope.HubID, scope.SpaceID, run, run, completed).Scan(&ok)
	return ok, err
}
