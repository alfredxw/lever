package remote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"os"
	"runtime"
	"time"

	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func savePeer(tx *sql.Tx, r p.DirectPairReceipt) error {
	m := r.Membership
	result, err := tx.Exec(`INSERT INTO remote_peers VALUES(?,?,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET
		membership=excluded.membership,grant=excluded.grant,address=excluded.address,name=excluded.name,platform=excluded.platform
		WHERE json_extract(remote_peers.membership,'$.hub.publicKey')=json_extract(excluded.membership,'$.hub.publicKey')`, m.Hub.ID, store.JSON(m), r.Grant, r.LANAddr, r.Host.Name, r.Host.Platform)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return errors.New("paired peer public key changed")
	}
	return nil
}

func (h *Host) returnGrant(ctx context.Context, controller p.Identity) (*p.DirectPairReceipt, error) {
	scope, pub, err := h.ensureDirectScope(ctx, true)
	if err != nil {
		return nil, err
	}
	addr, err := h.syncLAN(true)
	if err != nil {
		return nil, err
	}
	var key []byte
	var policy int64
	err = h.App.Store.DB.QueryRowContext(ctx, "SELECT key,policy FROM remote_identity,remote_memberships WHERE hub=? AND space=?", scope.HubID, scope.SpaceID).Scan(&key, &policy)
	if err != nil {
		return nil, err
	}
	host := p.Identity{ID: h.App.Store.DeviceID, PublicKey: pub}
	name, _ := os.Hostname()
	return &p.DirectPairReceipt{
		Membership: p.Membership{Hub: host, SpaceID: scope.SpaceID, SpaceKind: "personal", UserID: "local", Role: p.Controller, DeviceID: controller.ID},
		Host:       p.Device{Identity: host, Name: name, Platform: runtime.GOOS, Role: p.Workstation, SpaceID: scope.SpaceID},
		LANAddr:    addr, Grant: p.IssueGrant(p.Grant{HubID: host.ID, SpaceID: scope.SpaceID, Host: host, Controller: controller, UserID: "local", Policy: policy, Expires: time.Now().Unix() - 1}, ed25519.PrivateKey(key)),
	}, nil
}

func validateReturnGrant(r *p.DirectPairReceipt, sender, local p.Identity) error {
	if r == nil {
		return nil
	}
	m := r.Membership
	g, err := p.ParseGrant(r.Grant)
	_, _, addrErr := net.SplitHostPort(r.LANAddr)
	if err != nil || addrErr != nil || !g.Authentic(sender, sender.ID, sender.ID) || !bytes.Equal(g.Grant.Controller.PublicKey, local.PublicKey) || g.Grant.Controller.ID != local.ID || g.Grant.UserID != "local" ||
		m.Hub.ID != sender.ID || !bytes.Equal(m.Hub.PublicKey, sender.PublicKey) || m.SpaceID != sender.ID || m.Role != p.Controller || m.DeviceID != local.ID || m.Token != "" || m.UserID != "local" || r.Host.ID != sender.ID || !bytes.Equal(r.Host.PublicKey, sender.PublicKey) {
		return errors.New("invalid reciprocal workstation grant")
	}
	return nil
}

func approveReturnPeer(tx *sql.Tx, hub, space, controller string) error {
	var raw string
	err := tx.QueryRow("SELECT receipt FROM remote_pending_peers WHERE hub=? AND space=? AND controller=?", hub, space, controller).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var receipt p.DirectPairReceipt
	if err = json.Unmarshal([]byte(raw), &receipt); err != nil {
		return err
	}
	return savePeer(tx, receipt)
}
