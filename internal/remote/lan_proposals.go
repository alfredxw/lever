package remote

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"lever/internal/app"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func (h *Host) propose(ctx context.Context, g p.Grant, cmd p.LANCommand) (p.InboxItem, error) {
	i := cmd.Intent
	var out p.InboxItem
	if _, err := uuid.Parse(i.ID); err != nil || cmd.HubID != g.HubID || cmd.SpaceID != g.SpaceID || i.ActorUserID != g.UserID || i.OriginDeviceID != g.Controller.ID || i.DeviceID != g.Host.ID || !cmd.Verify(g.Controller.PublicKey) || i.TaskID != "" {
		return out, errors.New("invalid signed action")
	}
	switch i.Kind {
	case "send", "answer", "stop", "resolve_unknown", "resume_queue", "allow_run":
	default:
		return out, errors.New("unsupported LAN action")
	}
	if len(i.Text) > 256<<10 || (i.Kind == "send" && (i.Operation != "main" && i.Operation != "reply" && i.Operation != "topic")) {
		return out, errors.New("invalid message")
	}
	scope := model.SharedScope{HubID: g.HubID, SpaceID: g.SpaceID}
	err := h.App.Store.Write(ctx, func(tx *sql.Tx) error {
		var visible bool
		if i.ChatID == "" {
			if i.Private || g.Draining || i.Kind != "send" {
				return errors.New("chat required")
			}
			if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM agents a JOIN remote_memberships m ON m.hub=? AND m.space=?
WHERE a.id=? AND coalesce(json_extract(a.data,'$.archived'),0)=0
AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`, g.HubID, g.SpaceID, i.AgentID).Scan(&visible); err != nil {
				return err
			}
		} else {
			cond := sharedChatScope
			args := []any{i.ChatID, g.HubID, g.SpaceID}
			if i.Private {
				cond = privateChatCond("?2", "?3", "?4")
				args = append(args, i.OriginDeviceID)
			}
			if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM chats c WHERE c.id=?1 AND "+cond+")", args...).Scan(&visible); err != nil {
				return err
			}
		}
		if !visible {
			return errors.New("target is not shared with this controller")
		}
		rec := p.Receipt{ID: i.ID, Status: "pending"}
		if _, err := tx.Exec("INSERT INTO lan_proposals(hub,space,id,command,receipt,expires,policy) VALUES(?,?,?,?,?,?,?) ON CONFLICT(hub,space,id) DO UPDATE SET expires=excluded.expires,policy=excluded.policy WHERE command=excluded.command", scope.HubID, scope.SpaceID, i.ID, store.JSON(cmd), store.JSON(rec), g.Expires, g.Policy); err != nil {
			return err
		}
		var saved, receipt string
		if err := tx.QueryRow("SELECT command,receipt FROM lan_proposals WHERE hub=? AND space=? AND id=?", scope.HubID, scope.SpaceID, i.ID).Scan(&saved, &receipt); err != nil {
			return err
		}
		if saved != store.JSON(cmd) {
			return &p.HTTPError{Status: 409, Message: "command ID is bound to a different input"}
		}
		out.Intent = i
		return json.Unmarshal([]byte(receipt), &out.Receipt)
	})
	if err == nil && out.Receipt.Status == "pending" {
		h.configMu.Lock()
		defer h.configMu.Unlock()
		allowed, checkErr := h.permitted(ctx, scope, i)
		if checkErr != nil {
			return out, checkErr
		}
		if allowed {
			out.Receipt, _, err = h.reviewLAN(ctx, Management{Action: "accept", Scope: scope, ID: i.ID})
		}
	}
	return out, err
}
func (h *Host) lanInbox(ctx context.Context, scope model.SharedScope) ([]p.InboxItem, error) {
	return store.List[p.InboxItem](ctx, h.App.Store.DB, `SELECT json_object('intent',json_extract(command,'$.intent'),'receipt',json(receipt)) FROM lan_proposals WHERE hub=? AND space=? AND json_extract(receipt,'$.status')='pending' ORDER BY rowid`, scope.HubID, scope.SpaceID)
}
func (h *Host) reviewLAN(ctx context.Context, in Management) (p.Receipt, bool, error) {
	var out p.Receipt
	cmd, err := store.Get[p.LANCommand](ctx, h.App.Store.DB, "SELECT command FROM lan_proposals WHERE hub=? AND space=? AND id=?", in.Scope.HubID, in.Scope.SpaceID, in.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return out, false, nil
	}
	if err != nil {
		return out, true, err
	}
	out, err = store.Get[p.Receipt](ctx, h.App.Store.DB, "SELECT receipt FROM lan_proposals WHERE hub=? AND space=? AND id=?", in.Scope.HubID, in.Scope.SpaceID, in.ID)
	if err != nil || out.Status != "pending" {
		return out, true, err
	}
	if in.Action == "decline" {
		out, err = h.App.RememberRemoteDecision(ctx, in.Scope, cmd.Intent, p.Receipt{ID: in.ID, Status: "declined"})
		if err != nil {
			return out, true, err
		}
	} else {
		var authorized bool
		err = h.App.Store.DB.QueryRowContext(ctx, `SELECT m.lan=1 AND m.policy=q.policy AND (q.expires>? OR EXISTS(SELECT 1 FROM remote_trusted_controllers t WHERE t.hub=q.hub AND t.space=q.space AND t.controller=json_extract(q.command,'$.intent.originDeviceId') AND json_extract(q.command,'$.intent.actorUserId')=json_extract(m.credential,'$.userId'))) FROM lan_proposals q JOIN remote_memberships m USING(hub,space) WHERE q.hub=? AND q.space=? AND q.id=?`, time.Now().Unix(), in.Scope.HubID, in.Scope.SpaceID, in.ID).Scan(&authorized)
		if err != nil {
			return out, true, err
		}
		if !authorized {
			return out, true, errors.New("LAN authorization expired or changed; ask the controller to retry")
		}
		out, err = h.App.ReviewRemote(ctx, in.Scope, cmd.Intent)
		if err != nil {
			var rejected *app.Error
			if !errors.As(err, &rejected) && !errors.Is(err, sql.ErrNoRows) {
				return out, true, err
			}
			out, err = h.App.RememberRemoteDecision(ctx, in.Scope, cmd.Intent, p.Receipt{ID: in.ID, Status: "failed", Detail: "Host rejected this command"})
			if err != nil {
				return out, true, err
			}
		}
	}
	err = h.App.Store.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE lan_proposals SET receipt=?,published=0 WHERE hub=? AND space=? AND id=?", store.JSON(out), in.Scope.HubID, in.Scope.SpaceID, in.ID)
		return err
	})
	return out, true, err
}
func (h *Host) publishLAN(ctx context.Context, st p.ClientState) error {
	if st.Origin == "" {
		return nil
	}
	m := st.Membership
	all, err := store.List[p.LANReport](ctx, h.App.Store.DB, `SELECT json_object('command',json(command),'receipt',json(receipt)) FROM lan_proposals WHERE hub=? AND space=? AND published=0 AND coalesce(json_extract(command,'$.intent.private'),0)=0 ORDER BY rowid LIMIT 64`, m.Hub.ID, m.SpaceID)
	if err != nil {
		return err
	}
	for _, r := range all {
		published := 1
		if err = st.Do(ctx, http.MethodPost, st.SpacePath()+"/lan-receipts", r, nil); err != nil {
			var failure *p.HTTPError
			if !errors.As(err, &failure) || (failure.Status != http.StatusForbidden && failure.Status != http.StatusNotFound && failure.Status != http.StatusConflict) {
				return err
			}
			// The Hub rejected this signed report. Keep it for local audit;
			// one revoked controller must not block other users' receipts.
			published = -1
		}
		if _, err = h.App.Store.DB.ExecContext(ctx, "UPDATE lan_proposals SET published=? WHERE hub=? AND space=? AND id=? AND receipt=?", published, m.Hub.ID, m.SpaceID, r.Receipt.ID, store.JSON(r.Receipt)); err != nil {
			return err
		}
	}
	return nil
}
