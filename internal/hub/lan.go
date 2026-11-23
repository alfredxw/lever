package hub

import (
	"database/sql"
	p "lever/internal/remoteproto"
	"net/http"
	"time"
)

// A headless executor may verify the named personal controller without
// acquiring permission to browse the space's device directory.
func (h *Hub) personalController(w http.ResponseWriter, r *http.Request, a principal) error {
	var d p.Device
	err := h.db.QueryRowContext(r.Context(), `SELECT d.id,d.pub,d.name FROM devices d JOIN spaces s ON s.id=d.space_id
WHERE s.kind='personal' AND s.id=? AND d.user_id=? AND d.id=? AND d.id<>? AND d.revoked=0 AND d.role IN ('controller','workstation')`,
		a.space, a.user, r.PathValue("id"), a.device).Scan(&d.ID, &d.PublicKey, &d.Name)
	if err != nil {
		return err
	}
	return send(w, d)
}

func (h *Hub) grant(w http.ResponseWriter, r *http.Request, a principal) error {
	if a.device == "" || !a.role.Controls() {
		return denied
	}
	g := p.Grant{HubID: h.identity.ID, SpaceID: a.space, UserID: a.user, Expires: time.Now().Add(5 * time.Minute).Unix()}
	g.Controller.ID = a.device
	g.Host.ID = r.PathValue("id")
	err := h.db.QueryRow(`SELECT src.pub,dest.pub,s.policy,dest.draining FROM devices src JOIN devices dest USING(space_id) JOIN spaces s ON s.id=src.space_id WHERE src.space_id=? AND src.id=? AND src.token=? AND src.revoked=0 AND dest.id=? AND dest.revoked=0 AND dest.role IN ('workstation','executor')`, a.space, a.device, a.token, g.Host.ID).Scan(&g.Controller.PublicKey, &g.Host.PublicKey, &g.Policy, &g.Draining)
	if err != nil {
		return err
	}
	return send(w, map[string]string{"grant": p.IssueGrant(g, h.key)})
}

// Reports carry the controller's signature in addition to the Host transport
// signature. A replay after relay fallback addresses the same receipt.
func (h *Hub) reportLAN(w http.ResponseWriter, r *http.Request, a principal) error {
	var report p.LANReport
	if err := read(r, &report); err != nil {
		return err
	}
	c, rec := report.Command, report.Receipt
	i := c.Intent
	if !validID(i.ID) || rec.ID != i.ID || c.HubID != h.identity.ID || c.SpaceID != a.space || i.DeviceID != a.device || i.Private || i.TaskID != "" {
		return denied
	}
	switch i.Kind {
	case "send", "answer", "stop", "allow_run", "resume_queue", "resolve_unknown":
	default:
		return denied
	}
	switch rec.Status {
	case "pending", "declined", "accepted", "failed":
	default:
		return invalid("invalid LAN receipt")
	}
	err := write(h.db, func(tx *sql.Tx) error {
		var pub []byte
		if err := tx.QueryRow("SELECT pub FROM devices WHERE space_id=? AND id=? AND user_id=? AND role IN ('controller','workstation') AND revoked=0", a.space, i.OriginDeviceID, i.ActorUserID).Scan(&pub); err != nil {
			return err
		}
		if !c.Verify(pub) {
			return denied
		}
		item, err := insertIntent(tx, a.space, i)
		if err != nil {
			return err
		}
		if rec.Status == "pending" || item.Receipt == rec {
			return nil
		}
		if item.Receipt.Status != "pending" && item.Receipt.Status != "reviewing" {
			return conflict("command already resolved")
		}
		item.Receipt = rec
		_, err = tx.Exec("UPDATE receipts SET data=? WHERE space_id=? AND device_id=? AND id=?", encoded(item), a.space, a.device, i.ID)
		return err
	})
	if err != nil {
		return err
	}
	h.notify(a.space)
	return send(w, rec)
}
