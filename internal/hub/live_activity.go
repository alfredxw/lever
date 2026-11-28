package hub

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/sideshow/apns2"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

// The only application fields allowed across APNs or the delivery relay.
// Lock screens derive all display strings locally.
type activityState struct {
	Phase   string `json:"phase"`
	Steps   int    `json:"stepCount"`
	Pending int    `json:"pendingCount"`
}

func (s activityState) valid() bool {
	return (s.Phase == "running" || s.Phase == "waitingUser" || s.Phase == "completed" || s.Phase == "failed") && s.Steps >= 0 && s.Pending >= 0
}
func (s activityState) ended() bool { return s.Phase == "completed" || s.Phase == "failed" }

func (h *Hub) liveActivity(w http.ResponseWriter, r *http.Request, a principal) error {
	if a.device == "" || a.role != p.Controller {
		return denied
	}
	var in struct{ ActivityID, DeviceID, SessionID, RunID, Token string }
	if err := read(r, &in); err != nil {
		return err
	}
	if in.ActivityID == "" || len(in.ActivityID) > 128 {
		return invalid("invalid activity")
	}
	if r.Method == http.MethodDelete {
		_, err := h.db.ExecContext(r.Context(), "DELETE FROM live_activities WHERE space=? AND recipient=? AND activity=?", a.space, a.device, in.ActivityID)
		if err != nil {
			return err
		}
		return send(w, true)
	}
	token, err := hex.DecodeString(in.Token)
	if err != nil || len(token) < 16 || len(token) > 256 || in.RunID == "" || in.SessionID == "" || len(in.RunID) > 128 || len(in.SessionID) > 128 {
		return invalid("invalid live activity registration")
	}
	if !h.push.available("ios") {
		return problem{503, "Hub 尚未配置 APNs"}
	}
	err = write(h.db, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(r.Context(), `INSERT INTO live_activities(space,recipient,activity,host,session,run,token,expires)
        SELECT ?,?,?,?,?,?,?,? FROM push_devices p JOIN devices controller ON (controller.space_id,controller.id)=(p.space_id,p.device_id)
        JOIN devices owner ON owner.space_id=p.space_id AND owner.id=? AND owner.user_id=controller.user_id
        WHERE p.space_id=? AND p.device_id=? AND p.platform='ios' AND controller.token=? AND controller.revoked=0 AND owner.revoked=0 AND owner.role!='controller'
        ON CONFLICT(space,recipient) DO UPDATE SET activity=excluded.activity,host=excluded.host,session=excluded.session,
        run=excluded.run,token=excluded.token,expires=excluded.expires,phase=CASE WHEN activity=excluded.activity AND run=excluded.run THEN phase ELSE '' END,
        revision=revision+1,due=CASE WHEN activity=excluded.activity THEN due ELSE 0 END`,
			a.space, a.device, in.ActivityID, in.DeviceID, in.SessionID, in.RunID, in.Token, time.Now().Add(8*time.Hour).Unix(),
			in.DeviceID, a.space, a.device, a.token)
		if err != nil {
			return err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return denied
		}
		// A short run may finish before ActivityKit provides the first push token.
		// Seed from the latest still-visible record in the same transaction.
		var raw []byte
		var page string
		err = tx.QueryRowContext(r.Context(), `SELECT data, '' FROM archive
        WHERE space_id=?1 AND device_id=?2 AND kind='run' AND id=?3 AND json_extract(data,'$.sessionId')=?4
        UNION ALL SELECT item.value,hp.path FROM node_hot_pages hp JOIN devices h
        ON (h.space_id,h.id)=(hp.space_id,hp.device_id), json_each(hp.data,'$.runs') item
        WHERE hp.space_id=?1 AND hp.device_id=?2 AND hp.epoch=json_extract(nullif(h.node,''),'$.cacheEpoch')
        AND json_extract(item.value,'$.id')=?3 AND json_extract(item.value,'$.sessionId')=?4
        AND json_extract(item.value,'$.status') IN ('completed','failed','interrupted','cancelled') LIMIT 1`,
			a.space, in.DeviceID, in.RunID, in.SessionID).Scan(&raw, &page)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		var run p.Record
		if err = json.Unmarshal(raw, &run); err != nil {
			return err
		}
		run.Kind = "run"
		return queueLiveActivity(tx, a.space, in.DeviceID, page, run)
	})
	if err != nil {
		return err
	}
	h.mu.Lock()
	if l := h.links[deviceKey{a.space, in.DeviceID}]; l != nil {
		select {
		case l.checkpoint <- struct{}{}:
		default:
		}
	}
	h.mu.Unlock()
	return send(w, true)
}

func queueLiveActivity(tx *sql.Tx, space, host, page string, r p.Record) error {
	if r.Private || r.Superseded || r.Kind != "run" || r.SessionID == "" {
		return nil
	}
	s := activityState{Steps: max(0, r.StepCount)}
	switch r.Status {
	case "starting", "running", "cancelling":
		s.Phase = "running"
		if r.PendingCount > 0 {
			s.Phase = "waitingUser"
			s.Pending = r.PendingCount
		}
	case "waiting_user", "paused":
		s.Phase = "waitingUser"
		s.Pending = max(1, r.PendingCount)
	case "completed":
		s.Phase = "completed"
	case "failed", "interrupted", "cancelled":
		s.Phase = "failed"
	default:
		return nil
	}
	_, err := tx.Exec(`UPDATE live_activities SET phase=?,steps=?,pending=?,source_page=?,revision=revision+1,due=unixepoch(),attempts=0
        WHERE space=? AND host=? AND session=? AND run=? AND expires>unixepoch()
        AND phase NOT IN ('failed','completed') AND (phase!=? OR steps/5!=?/5 OR pending!=?)`, s.Phase, s.Steps, s.Pending, page, space, host, r.SessionID, r.ID, s.Phase, s.Steps, s.Pending)
	return err
}

// Extract progress while the verified Owner page is live, before HotRun masks
// active state for later offline reads.
func liveRunRecords(runs []model.Run, requests []model.Request) []p.Record {
	pending := make(map[string]int)
	for _, q := range requests {
		if q.Status == "pending" {
			pending[q.RunID]++
		}
	}
	out := make([]p.Record, 0, len(runs))
	for _, r := range runs {
		steps := 0
		for _, it := range r.Items {
			if it.Kind != "text" && it.Kind != "user" {
				steps++
			}
		}
		out = append(out, p.Record{Kind: "run", ID: r.ID, SessionID: r.SessionID, ChatID: r.ChatID, Status: r.Status, StepCount: max(r.StepCount, steps), PendingCount: pending[r.ID], Superseded: r.Superseded})
	}
	return out
}

func (h *Hub) deliverLiveActivity(ctx context.Context) (bool, error) {
	now := time.Now().Unix()
	if _, err := h.db.ExecContext(ctx, "DELETE FROM live_activities WHERE expires<=?", now); err != nil {
		return false, err
	}
	var space, recipient, token string
	var revision, attempts int
	var activeUntil int64
	var visible bool
	var state activityState
	err := h.db.QueryRowContext(ctx, `SELECT l.space,l.recipient,l.token,l.revision,l.attempts,l.phase,l.steps,l.pending,
        CASE WHEN p.silence_when_desktop_active THEN h.desktop_active_until ELSE 0 END,
        h.revoked=0 AND c.revoked=0 AND h.user_id=c.user_id AND (
          (l.source_page='' AND EXISTS(SELECT 1 FROM archive ar WHERE (ar.space_id,ar.device_id,ar.kind,ar.id)=(l.space,l.host,'run',l.run)
            AND json_extract(ar.data,'$.sessionId')=l.session AND coalesce(json_extract(ar.data,'$.private'),0)=0 AND coalesce(json_extract(ar.data,'$.superseded'),0)=0))
          OR EXISTS(SELECT 1 FROM node_hot_pages hp,json_each(hp.data,'$.runs') item
            WHERE (hp.space_id,hp.device_id,hp.path)=(l.space,l.host,l.source_page)
            AND hp.epoch=json_extract(nullif(h.node,''),'$.cacheEpoch')
            AND json_extract(h.node,'$.accessLevel') IN ('chat','workspace','admin')
            AND json_extract(item.value,'$.id')=l.run AND json_extract(item.value,'$.sessionId')=l.session
            AND coalesce(json_extract(item.value,'$.superseded'),0)=0))
        FROM live_activities l JOIN push_devices p ON (p.space_id,p.device_id)=(l.space,l.recipient)
        JOIN devices h ON (h.space_id,h.id)=(l.space,l.host) JOIN devices c ON (c.space_id,c.id)=(l.space,l.recipient)
        WHERE l.due>0 AND l.due<=?1 AND l.last_sent<?1 AND l.phase!='' ORDER BY l.due LIMIT 1`, now).Scan(&space, &recipient, &token, &revision, &attempts, &state.Phase, &state.Steps, &state.Pending, &activeUntil, &visible)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	due, sentAt := int64(0), int64(0)
	remove := !visible
	if visible && activeUntil > now {
		due = activeUntil
	} else if visible {
		timeout, cancel := context.WithTimeout(ctx, 12*time.Second)
		err = h.push.sendActivity(timeout, token, state)
		cancel()
		if errors.Is(err, errInvalidPushToken) {
			remove = true
		} else if err != nil {
			due = now + int64(min(300, 5<<min(attempts, 6)))
		} else {
			sentAt = now
			remove = state.ended()
		}
	}
	if remove {
		_, err = h.db.ExecContext(ctx, "DELETE FROM live_activities WHERE space=? AND recipient=? AND token=? AND revision=?", space, recipient, token, revision)
	} else {
		_, err = h.db.ExecContext(ctx, "UPDATE live_activities SET due=?,last_sent=max(last_sent,?),attempts=attempts+1 WHERE space=? AND recipient=? AND token=? AND revision=?", due, sentAt, space, recipient, token, revision)
	}
	return true, err
}

func (d *pushProviders) sendActivity(ctx context.Context, token string, state activityState) error {
	if !d.available("ios") || !state.valid() {
		return errors.New("invalid live activity delivery")
	}
	if d.relay != nil {
		return d.relay.forward(ctx, relayDelivery{Platform: "ios", Token: token, Activity: &state})
	}
	now := time.Now()
	aps := map[string]any{"timestamp": now.Unix(), "event": "update", "content-state": state}
	if state.ended() {
		aps["event"] = "end"
		aps["dismissal-date"] = now.Add(5 * time.Minute).Unix()
	}
	return d.sendApple(ctx, &apns2.Notification{DeviceToken: token, Topic: d.topic + ".push-type.liveactivity", PushType: apns2.PushTypeLiveActivity,
		Priority: apns2.PriorityLow, Expiration: now.Add(5 * time.Minute), Payload: map[string]any{"aps": aps}})
}
