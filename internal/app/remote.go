package app

import (
	"context"
	"database/sql"
	"errors"

	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

const PeerCommandSpace = "peer/v1"

func commandDigest(scope model.SharedScope, i p.Intent) string {
	if scope.SpaceID == PeerCommandSpace {
		i.ActorUserID = ""
	} // The same paired device has a different account ID on LAN and Hub.
	return hash(i)
}

type remoteOrigin struct {
	receipts model.SharedScope
	peer     bool
	scope    model.SharedScope
	intent   p.Intent
	digest   string
}

func checkExposed(tx *sql.Tx, scope model.SharedScope, agent string) error {
	var ok bool
	err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM agents a JOIN remote_memberships m ON m.hub=? AND m.space=?
WHERE a.id=? AND coalesce(json_extract(a.data,'$.archived'),0)=0 AND coalesce(json_extract(a.data,'$.localOnly'),0)=0
AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`, scope.HubID, scope.SpaceID, agent).Scan(&ok)
	if err == nil && !ok {
		return &Error{Status: 403, Message: "Agent is not shared with this space"}
	}
	return err
}
func (o *remoteOrigin) authorize(tx *sql.Tx, chat model.Chat) error {
	if o.peer {
		var id string
		if o.intent.ChatID == "" {
			return tx.QueryRow("SELECT agent_id FROM peer_agents WHERE hub=? AND space=? AND agent_id=?", o.scope.HubID, o.scope.SpaceID, chat.AgentID).Scan(&id)
		}
		return tx.QueryRow("SELECT chat_id FROM peer_chats WHERE hub=? AND space=? AND chat_id=? AND agent_id=?", o.scope.HubID, o.scope.SpaceID, chat.ID, chat.AgentID).Scan(&id)
	}
	if chat.LocalOnly {
		return &Error{Status: 403, Message: "Chat is only available locally"}
	}
	if o.intent.Private {
		var localOnly bool
		if err := tx.QueryRow("SELECT coalesce(json_extract(data,'$.localOnly'),0) FROM agents WHERE id=?", chat.AgentID).Scan(&localOnly); err != nil {
			return err
		}
		if localOnly {
			return &Error{Status: 403, Message: "Agent is only available locally"}
		}
		if chat.SharedScope != nil || chat.ID == "" || o.intent.OriginDeviceID == "" {
			return invalid("invalid device-only target")
		}
		var allowed bool
		err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM remote_private_chats WHERE hub=?1 AND space=?2 AND controller=?3 AND chat=?4)
			OR EXISTS(SELECT 1 FROM remote_memberships m
				JOIN remote_trusted_controllers t USING(hub,space)
				JOIN agents a ON a.id=?5
				WHERE m.hub=?1 AND m.space=?2 AND m.origin='' AND t.controller=?3
				AND coalesce(json_extract(a.data,'$.archived'),0)=0
				AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
			o.scope.HubID, o.scope.SpaceID, o.intent.OriginDeviceID, chat.ID, chat.AgentID).Scan(&allowed)
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
	_, err := tx.Exec("INSERT INTO remote_commands VALUES(?,?,?,?,?)", o.receipts.HubID, o.receipts.SpaceID, o.intent.ID, o.digest, store.JSON(rec))
	return err
}
func (a *App) RemoteReceipt(ctx context.Context, scope model.SharedScope, i p.Intent) (p.Receipt, error) {
	var rec p.Receipt
	var digest string
	err := a.Store.DB.QueryRowContext(ctx, "SELECT digest FROM remote_commands WHERE hub=? AND space=? AND id=?", scope.HubID, scope.SpaceID, i.ID).Scan(&digest)
	if err != nil {
		return rec, err
	}
	if digest != commandDigest(scope, i) {
		return rec, errCommandConflict
	}
	return store.Get[p.Receipt](ctx, a.Store.DB, "SELECT receipt FROM remote_commands WHERE hub=? AND space=? AND id=?", scope.HubID, scope.SpaceID, i.ID)
}

// RememberRemoteDecision keeps a local operator's terminal decision across
// relay retries and restoration of an older Hub backup.
func (a *App) RememberRemoteDecision(ctx context.Context, scope model.SharedScope, i p.Intent, rec p.Receipt) (p.Receipt, error) {
	if _, err := a.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO remote_commands VALUES(?,?,?,?,?)", scope.HubID, scope.SpaceID, i.ID, commandDigest(scope, i), store.JSON(rec)); err != nil {
		return p.Receipt{}, err
	}
	return a.RemoteReceipt(ctx, scope, i)
}

// ReviewRemote applies an action after a Host operator reviewed the bound
// command. The remote transport cannot grant itself that local permission.
func (a *App) ReviewRemote(ctx context.Context, scope model.SharedScope, i p.Intent) (p.Receipt, error) {
	return a.reviewRemote(ctx, scope, i, false)
}

// ApplyPeer runs an authenticated personal owner's command on the owning Node.
func (a *App) ApplyPeer(ctx context.Context, scope model.SharedScope, i p.Intent) (p.Receipt, error) {
	return a.reviewRemote(ctx, scope, i, true)
}

func (a *App) reviewRemote(ctx context.Context, scope model.SharedScope, i p.Intent, peer bool) (p.Receipt, error) {
	empty := p.Receipt{ID: i.ID}
	receiptScope := scope
	if peer {
		receiptScope = model.SharedScope{HubID: a.Store.DeviceID, SpaceID: PeerCommandSpace}
	}
	if rec, err := a.RemoteReceipt(ctx, receiptScope, i); !errors.Is(err, sql.ErrNoRows) {
		return rec, err
	}
	o := remoteOrigin{scope: scope, receipts: receiptScope, intent: i, digest: commandDigest(receiptScope, i), peer: peer}
	if i.Kind == "send" || i.Kind == "dispatch_task" {
		in := model.SendInput{
			CommandID:     "hub:" + hash([]string{receiptScope.HubID, receiptScope.SpaceID, i.ID}),
			AgentID:       i.AgentID,
			ChatID:        i.ChatID,
			SessionID:     i.SessionID,
			Text:          i.Text,
			WorkingCopyID: i.WorkingCopyID,
			Operation:     i.Operation,
			Delivery:      i.Delivery,
			AttachmentIDs: i.AttachmentIDs,
		}
		if len(i.References) > 0 {
			in.References = make([]model.Reference, 0, len(i.References))
			for _, ref := range i.References {
				in.References = append(in.References, model.Reference{
					Kind:         ref.Kind,
					Name:         ref.Name,
					ID:           ref.ID,
					Path:         ref.Path,
					Provider:     ref.Provider,
					Description:  ref.Description,
					ArgumentHint: ref.ArgumentHint,
					Start:        ref.Start,
					End:          ref.End,
				})
			}
		}
		if i.Selection != nil && (i.Selection.Provider != "" || i.Selection.Model != "" || i.Selection.Effort != "" || i.Selection.Fast || i.Selection.Permission != "") {
			in.Selection = &model.Selection{
				Provider:   i.Selection.Provider,
				Model:      i.Selection.Model,
				Effort:     i.Selection.Effort,
				Fast:       i.Selection.Fast,
				Permission: i.Selection.Permission,
			}
		}
		if i.ChatID == "" {
			if i.Private {
				return empty, invalid("a device-only Chat must be selected locally")
			}
			if !peer {
				in.SharedScope = &scope
			}
		} else {
			in.AgentID = ""
		}
		origin := sendOrigin{remote: &o}
		if i.Delegation != nil {
			origin.remoteDelegation = i.Delegation
			origin.maxPermissionMode = i.Delegation.MaxPermissionMode
		}
		a.mu.Lock()
		run, err := a.sendLocked(ctx, in, origin)
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
		if i.Private || peer {
			if err = o.authorize(tx, chat); err != nil {
				return err
			}
		} else if chat.LocalOnly || chat.SharedScope == nil || *chat.SharedScope != scope {
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
		case "allow_run", "stop", "resolve_unknown", "retry", "resume", "pause":
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
		return a.RemoteReceipt(ctx, receiptScope, i)
	case "retry":
		var run model.Run
		run, err = a.Retry(ctx, i.RunID, i.ID)
		if err == nil {
			rec := p.Receipt{ID: i.ID, Status: "accepted", ChatID: run.ChatID, SessionID: run.SessionID, RunID: run.ID}
			return a.RememberRemoteDecision(ctx, receiptScope, i, rec)
		}
	case "resume":
		var paused model.Run
		paused, err = store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=? AND chat_id=?", i.RunID, i.ChatID)
		if err == nil {
			if paused.NativeTurnID == nil {
				return empty, conflict("This reply is no longer paused")
			}
			err = a.Resume(ctx, i.RunID, *paused.NativeTurnID)
		}
	case "pause":
		err = a.Pause(ctx, i.RunID)
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
	return a.RememberRemoteDecision(ctx, receiptScope, i, rec)
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

// SavePeerAgent makes creation and exposure atomic, including for a whitelist.
func (a *App) SavePeerAgent(ctx context.Context, agent model.Agent, scope model.SharedScope) (model.Agent, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	creating := agent.ID == ""
	return a.saveAgentLocked(ctx, agent, func(tx *sql.Tx, saved model.Agent) error {
		if creating {
			_, err := tx.Exec("INSERT INTO hub_exposed_agents(hub,space,agent_id) SELECT hub,space,? FROM remote_memberships WHERE hub=? AND space=? AND expose_all=0", saved.ID, scope.HubID, scope.SpaceID)
			return err
		}
		return nil
	})
}
