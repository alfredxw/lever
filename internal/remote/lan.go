package remote

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"strings"
	"time"

	"lever/internal/bonjour"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type lanServer struct {
	http *http.Server
	mdns io.Closer
}

func (l *lanServer) close() { l.mdns.Close(); l.http.Close() }
func (h *Host) listenLAN() (*lanServer, error) {
	var key []byte
	if err := h.App.Store.DB.QueryRow("SELECT key FROM remote_identity").Scan(&key); err != nil {
		return nil, err
	}
	if len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid Host identity")
	}
	priv := ed25519.PrivateKey(key)
	sn, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	leaf := x509.Certificate{SerialNumber: sn, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, &leaf, &leaf, priv.Public(), priv)
	if err != nil {
		return nil, err
	}
	l, err := net.Listen("tcp4", ":0")
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		l.Close()
		return nil, err
	}
	for _, addr := range addrs {
		if ip, _, err := net.ParseCIDR(addr.String()); err == nil && ip.To4() != nil && ip.IsPrivate() {
			ips = append(ips, ip)
		}
	}
	if len(ips) == 0 {
		l.Close()
		return nil, errors.New("no private LAN address")
	}
	ad, err := bonjour.Advertise(h.App.Store.DeviceID, l.Addr().(*net.TCPAddr).Port, ips)
	if err != nil {
		l.Close()
		return nil, err
	}
	s := &http.Server{Handler: http.HandlerFunc(h.ServeLAN), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 8 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10}
	go s.Serve(tls.NewListener(l, &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: priv}}}))
	return &lanServer{s, ad}, nil
}

// ServeLAN serves the Host's dedicated, authenticated TLS endpoint.
func (h *Host) ServeLAN(w http.ResponseWriter, r *http.Request) {
	commandID, lookup := strings.CutPrefix(r.URL.Path, "/commands/")
	lookup = lookup && len(commandID) == 36 && !strings.Contains(commandID, "/")
	if !(r.Method == http.MethodGet && (r.URL.Path == "/archive" || r.URL.Path == "/private" || lookup) || r.Method == http.MethodPost && r.URL.Path == "/commands") {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, p.MaxFrame))
	if err != nil {
		http.Error(w, "request too large", 413)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	grant, err := p.ParseGrant(token)
	if !ok || err != nil {
		http.Error(w, "invalid grant", 403)
		return
	}
	g := grant.Grant
	var m p.Membership
	err = h.App.Store.Write(r.Context(), func(tx *sql.Tx) error {
		var policy int64
		var raw string
		if err := tx.QueryRow("SELECT credential,policy FROM remote_memberships WHERE hub=? AND space=? AND lan=1", g.HubID, g.SpaceID).Scan(&raw, &policy); err != nil {
			return err
		}
		now := time.Now()
		if json.Unmarshal([]byte(raw), &m) != nil || !m.Role.Executes() || policy <= 0 || policy != g.Policy || !grant.Authentic(m.Hub, h.App.Store.DeviceID, m.SpaceID) || !p.Verify(r, g.Controller.PublicKey, body, now) {
			return errors.New("invalid LAN authorization")
		}
		if g.Expires <= now.Unix() {
			var trusted bool
			if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM remote_trusted_controllers WHERE hub=? AND space=? AND controller=? AND pub=?)", g.HubID, g.SpaceID, g.Controller.ID, g.Controller.PublicKey).Scan(&trusted); err != nil {
				return err
			}
			if !trusted || m.UserID != g.UserID {
				return errors.New("expired LAN grant")
			}
		} else if g.Expires > now.Add(5*time.Minute+5*time.Second).Unix() {
			return errors.New("invalid LAN expiry")
		}
		if _, err := tx.Exec("DELETE FROM remote_lan_nonces WHERE expires<?", now.Unix()); err != nil {
			return err
		}
		_, err := tx.Exec("INSERT INTO remote_lan_nonces VALUES(?,?)", r.Header.Get("X-Lever-Nonce"), now.Unix()+121)
		return err
	})
	if err != nil {
		http.Error(w, "LAN authorization expired or revoked", 403)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodPost {
		var cmd p.LANCommand
		if err = p.Decode(body, &cmd); err != nil {
			http.Error(w, "invalid command", 400)
			return
		}
		result, err := h.propose(r.Context(), g, cmd)
		if err != nil {
			status := 403
			var e *p.HTTPError
			if errors.As(err, &e) {
				status = e.Status
			}
			http.Error(w, err.Error(), status)
			return
		}
		json.NewEncoder(w).Encode(result)
		return
	}
	if lookup {
		item, err := store.Get[p.InboxItem](r.Context(), h.App.Store.DB, `SELECT json_object('intent',json_extract(command,'$.intent'),'receipt',json(receipt)) FROM lan_proposals WHERE hub=? AND space=? AND id=? AND json_extract(command,'$.intent.originDeviceId')=? AND (coalesce(json_extract(command,'$.intent.private'),0)=0 OR EXISTS(SELECT 1 FROM remote_private_chats g WHERE g.hub=lan_proposals.hub AND g.space=lan_proposals.space AND g.controller=? AND g.chat=json_extract(command,'$.intent.chatId')))`, g.HubID, g.SpaceID, commandID, g.Controller.ID, g.Controller.ID)
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "receipt unavailable", 500)
			return
		}
		json.NewEncoder(w).Encode(item)
		return
	}
	controller := ""
	if r.URL.Path == "/private" {
		controller = g.Controller.ID
	}
	if controller == "" && r.URL.Query().Get("sync") == "1" {
		page, err := h.archivePage(r.Context(), m, r.URL.Query().Get("chat"), p.ReadCursor(r.URL.Query()))
		if err != nil {
			http.Error(w, "archive unavailable", 500)
			return
		}
		json.NewEncoder(w).Encode(page)
		return
	}
	records, err := lanArchive(r.Context(), h.App.Store, m, r.URL.Query().Get("chat"), controller)
	if err != nil {
		http.Error(w, "archive unavailable", 500)
		return
	}
	json.NewEncoder(w).Encode(records)
}

func lanArchive(ctx context.Context, s *store.Store, m p.Membership, chat, controller string) ([]p.Record, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	return readLANArchive(ctx, tx, m, chat, controller)
}

func readLANArchive(ctx context.Context, tx *sql.Tx, m p.Membership, chat, controller string) ([]p.Record, error) {
	scope := sharedChatScope
	args := []any{m.Hub.ID, m.SpaceID}
	if controller != "" {
		scope = privateChatScope
		args = append(args, controller)
	}
	query := "WITH allowed AS (SELECT c.id FROM chats c WHERE " + scope + " AND (?='' OR c.id=?)) SELECT 'chat',id FROM allowed UNION ALL SELECT 'session',id FROM sessions WHERE chat_id IN allowed"
	args = append(args, chat, chat)
	if chat != "" {
		query += " UNION ALL SELECT 'run',id FROM runs WHERE chat_id IN allowed UNION ALL SELECT 'request',id FROM requests WHERE chat_id IN allowed"
	} else if controller == "" {
		query += " UNION ALL SELECT 'agent',agent_id FROM hub_exposed_agents WHERE hub=? AND space=?"
		args = append(args, m.Hub.ID, m.SpaceID)
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var keys []object
	for rows.Next() {
		var o object
		if err = rows.Scan(&o.kind, &o.id); err != nil {
			rows.Close()
			return nil, err
		}
		keys = append(keys, o)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	records := []p.Record{}
	for _, o := range keys {
		rec, err := project(ctx, tx, m, o, controller)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		records = append(records, rec)
	}
	return records, nil
}
