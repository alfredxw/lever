package hub

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	p "lever/internal/remoteproto"
)

func (h *Hub) pushDevice(w http.ResponseWriter, r *http.Request, a principal) error {
	if a.device == "" || a.role != p.Controller {
		return denied
	}
	var platform string
	if err := h.db.QueryRowContext(r.Context(), "SELECT platform FROM devices WHERE space_id=? AND id=? AND token=? AND revoked=0", a.space, a.device, a.token).Scan(&platform); err != nil {
		return err
	}
	state := p.PushSettings{Available: h.push.available(platform)}
	if state.Available && platform == "android" {
		state.Firebase = h.push.firebase
	}
	switch r.Method {
	case http.MethodPut:
		if !state.Available {
			return problem{503, "Hub 尚未配置此平台的系统推送"}
		}
		var in p.PushRegistration
		if err := read(r, &in); err != nil {
			return err
		}
		if len(in.Key) != 32 || len(in.Token) < 16 || len(in.Token) > 4096 || strings.ContainsAny(in.Token, " \t\n\r") {
			return invalid("invalid device push token")
		}
		if platform == "ios" {
			if _, err := hex.DecodeString(in.Token); err != nil {
				return invalid("invalid APNs token")
			}
		}
		if err := h.registerPush(r.Context(), a, platform, in); err != nil {
			return err
		}
		state.Enabled = true
		silence := true
		if in.SilenceWhenDesktopActive != nil {
			silence = *in.SilenceWhenDesktopActive
		} else {
			_ = h.db.QueryRowContext(r.Context(), "SELECT silence_when_desktop_active FROM push_devices WHERE space_id=? AND device_id=?", a.space, a.device).Scan(&silence)
		}
		state.SilenceWhenDesktopActive = silence
	case http.MethodPatch:
		var in p.PushPreferences
		if err := read(r, &in); err != nil {
			return err
		}
		if in.SilenceWhenDesktopActive != nil {
			val := 0
			if *in.SilenceWhenDesktopActive {
				val = 1
			}
			if _, err := h.db.ExecContext(r.Context(), "UPDATE push_devices SET silence_when_desktop_active=? WHERE space_id=? AND device_id=?", val, a.space, a.device); err != nil {
				return err
			}
		}
		var silence bool
		err := h.db.QueryRowContext(r.Context(), "SELECT silence_when_desktop_active FROM push_devices WHERE space_id=? AND device_id=?", a.space, a.device).Scan(&silence)
		if err == nil {
			state.Enabled = true
			state.SilenceWhenDesktopActive = silence
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		} else if in.SilenceWhenDesktopActive != nil {
			state.SilenceWhenDesktopActive = *in.SilenceWhenDesktopActive
		}
	case http.MethodDelete:
		if _, err := h.db.ExecContext(r.Context(), "DELETE FROM push_devices WHERE space_id=? AND device_id=?", a.space, a.device); err != nil {
			return err
		}
	default:
		var silence bool
		err := h.db.QueryRowContext(r.Context(), "SELECT silence_when_desktop_active FROM push_devices WHERE space_id=? AND device_id=?", a.space, a.device).Scan(&silence)
		if err == nil {
			state.Enabled = true
			state.SilenceWhenDesktopActive = silence
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		} else {
			state.SilenceWhenDesktopActive = true
		}
	}
	return send(w, state)
}

func (h *Hub) registerPush(ctx context.Context, a principal, platform string, in p.PushRegistration) error {
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// A reinstall may preserve the OS token while pairing creates a new device.
	var space, device, owner string
	err = tx.QueryRowContext(ctx, `SELECT p.space_id,p.device_id,d.user_id FROM push_devices p JOIN devices d ON (p.space_id,p.device_id)=(d.space_id,d.id) WHERE p.platform=? AND p.token=?`, platform, in.Token).Scan(&space, &device, &owner)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return err
	case space != a.space || owner != a.user:
		return conflict("此推送设备已绑定其他账号或空间")
	case device != a.device:
		if _, err = tx.ExecContext(ctx, "DELETE FROM push_devices WHERE space_id=? AND device_id=?", space, device); err != nil {
			return err
		}
	}
	silenceVal := 1
	if in.SilenceWhenDesktopActive != nil {
		if *in.SilenceWhenDesktopActive {
			silenceVal = 1
		} else {
			silenceVal = 0
		}
	} else {
		var existing int
		if tx.QueryRowContext(ctx, "SELECT silence_when_desktop_active FROM push_devices WHERE space_id=? AND device_id=?", a.space, a.device).Scan(&existing) == nil {
			silenceVal = existing
		}
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO push_devices(space_id,device_id,platform,token,seal_key,silence_when_desktop_active)
		SELECT space_id,id,platform,?,?,? FROM devices WHERE space_id=? AND id=? AND token=? AND revoked=0
		ON CONFLICT(space_id,device_id) DO UPDATE SET token=excluded.token,seal_key=excluded.seal_key,silence_when_desktop_active=excluded.silence_when_desktop_active`,
		in.Token, in.Key, silenceVal, a.space, a.device, a.token)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		return denied
	}
	return tx.Commit()
}

func noticeKind(r p.Record) string {
	if r.Private || r.Superseded || r.ChatID == "" {
		return ""
	}
	if r.Kind == "request" && r.Status == "pending" {
		return "request"
	}
	if r.Kind == "run" {
		switch r.Status {
		case "failed", "interrupted":
			return "failure"
		case "completed":
			return "result"
		}
	}
	return ""
}

func (h *Hub) queuePush(tx *sql.Tx, a principal, r p.Record) error {
	return h.queuePagePush(tx, a, r, "")
}

func (h *Hub) queuePagePush(tx *sql.Tx, a principal, r p.Record, path string) error {
	if noticeKind(r) == "" {
		return nil
	}
	now := time.Now()
	_, err := tx.Exec(`INSERT INTO push_outbox(space_id,recipient,host,kind,object,status,due,expires,source_page)
		SELECT p.space_id,p.device_id,?,?,?,?,?,?,? FROM push_devices p JOIN devices d ON d.space_id=p.space_id AND d.id=p.device_id
		WHERE p.space_id=? AND d.user_id=? AND d.revoked=0 AND d.role='controller'
		ON CONFLICT(space_id,recipient,host,kind,object) DO UPDATE SET status=excluded.status,due=excluded.due,expires=excluded.expires,source_page=excluded.source_page,attempts=0`,
		a.device, r.Kind, r.ID, r.Status, now.Unix(), now.Add(24*time.Hour).Unix(), path, a.space, a.user)
	return err
}

type delivery struct {
	id                                 int64
	attempts                           int
	status, platform, token, recipient string
	notice                             p.PushNotice
}

func (h *Hub) deliverNext(ctx context.Context) (bool, error) {
	var d delivery
	var sourcePage, kind, object string
	var raw sql.NullString
	var expires int64
	var active bool
	var silenceWhenDesktopActive bool
	var desktopActiveUntil int64
	var sealKey []byte
	nowUnix := time.Now().Unix()
	err := h.db.QueryRowContext(ctx, `SELECT q.id,q.attempts,q.status,q.expires,p.platform,p.token,p.seal_key,p.silence_when_desktop_active,host.desktop_active_until,q.recipient,q.space_id,q.host,q.source_page,q.kind,q.object,a.data,(host.revoked=0 AND dest.revoked=0)
		FROM push_outbox q JOIN push_devices p ON p.space_id=q.space_id AND p.device_id=q.recipient
		JOIN devices host ON host.space_id=q.space_id AND host.id=q.host JOIN devices dest ON dest.space_id=q.space_id AND dest.id=q.recipient
		LEFT JOIN archive a ON (a.space_id,a.device_id,a.kind,a.id)=(q.space_id,q.host,q.kind,q.object)
		WHERE q.due<=? ORDER BY q.due,q.id LIMIT 1`, nowUnix).Scan(&d.id, &d.attempts, &d.status, &expires, &d.platform, &d.token, &sealKey, &silenceWhenDesktopActive, &desktopActiveUntil, &d.recipient, &d.notice.SpaceID, &d.notice.DeviceID, &sourcePage, &kind, &object, &raw, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var r p.Record
	if sourcePage != "" {
		field := "$.runs"
		if kind == "request" {
			field = "$.requests"
		}
		err = h.db.QueryRowContext(ctx, `SELECT item.value FROM node_hot_pages hp JOIN devices host ON (host.space_id,host.id)=(hp.space_id,hp.device_id),json_each(hp.data,?) item
			WHERE hp.space_id=? AND hp.device_id=? AND hp.path=? AND hp.epoch=json_extract(nullif(host.node,''),'$.cacheEpoch') AND host.revoked=0 AND json_extract(item.value,'$.id')=?`, field, d.notice.SpaceID, d.notice.DeviceID, sourcePage, object).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			raw = sql.NullString{}
		} else if err != nil {
			return false, err
		}
	}
	if raw.Valid {
		if err = json.Unmarshal([]byte(raw.String), &r); err != nil {
			return false, err
		}
	}
	if sourcePage != "" && raw.Valid {
		r.Kind = kind
	}
	d.notice.Kind = noticeKind(r)
	silenced := silenceWhenDesktopActive && desktopActiveUntil > nowUnix
	if active && !silenced && expires > nowUnix && d.notice.Kind != "" && r.Status == d.status {
		d.notice.HubID = h.identity.ID
		d.notice.ChatID, d.notice.SessionID, d.notice.RunID = r.ChatID, r.SessionID, r.RunID
		if r.Kind == "request" {
			d.notice.RequestID = r.ID
		} else {
			d.notice.RunID = r.ID
		}
		if d.notice.SessionID != "" {
			var main bool
			err = h.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM archive WHERE space_id=? AND device_id=? AND kind='session' AND id=? AND json_extract(data,'$.type')='main')`, d.notice.SpaceID, d.notice.DeviceID, d.notice.SessionID).Scan(&main)
			if err != nil {
				return false, err
			}
			if main || strings.HasPrefix(sourcePage, "chats/") {
				d.notice.SessionID = ""
			}
		}
		envelope, err := p.SealPush(d.notice, sealKey)
		if err != nil {
			return false, err
		}
		timeout, cancel := context.WithTimeout(ctx, 12*time.Second)
		err = h.push.send(timeout, d.platform, d.token, envelope)
		cancel()
		if errors.Is(err, errInvalidPushToken) {
			_, err = h.db.ExecContext(ctx, "DELETE FROM push_devices WHERE space_id=? AND device_id=? AND token=?", d.notice.SpaceID, d.recipient, d.token)
			// A simultaneous token rotation should retry this job using the new token.
			return true, err
		}
		if err != nil {
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			slog.Warn("Mobile push deferred", "platform", d.platform, "attempt", d.attempts+1, "error", err)
			delay := min(3600, 5<<min(d.attempts, 10))
			_, err = h.db.ExecContext(ctx, "UPDATE push_outbox SET attempts=attempts+1,due=? WHERE id=? AND status=?", time.Now().Unix()+int64(delay), d.id, d.status)
			return true, err
		}
	}
	_, err = h.db.ExecContext(ctx, "DELETE FROM push_outbox WHERE id=? AND status=?", d.id, d.status)
	return true, err
}

// RunPush owns delivery for the lifetime of the single Hub process. The
// outbox and the archive change that created it commit together.
func (h *Hub) RunPush(ctx context.Context) {
	if h.push == nil {
		return
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for ctx.Err() == nil {
		more, err := h.deliverNext(ctx)
		if err != nil && ctx.Err() == nil {
			slog.Error("Mobile push queue", "error", err)
		}
		if more && err == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
