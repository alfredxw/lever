package remote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"lever/internal/bonjour"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type lanServer struct {
	http *http.Server
	mdns io.Closer
	addr string
}

type LANTicketResult struct {
	Code     string            `json:"code"`
	Expires  int64             `json:"expires"`
	HostID   string            `json:"hostId"`
	HostName string            `json:"hostName"`
	LAN      string            `json:"lan"`
	Link     string            `json:"link"`
	Scope    model.SharedScope `json:"scope"`
}

func (l *lanServer) close() {
	if l.mdns != nil {
		l.mdns.Close()
	}
	l.http.Close()
}
func isLANIPv4(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil || v4.IsLoopback() || v4.IsLinkLocalUnicast() {
		return false
	}
	if v4.IsPrivate() {
		return true
	}
	// RFC 6598 CGNAT (100.64.0.0/10) is widely used by corporate Wi-Fi and overlay LANs.
	return v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}

func collectLANIPs() []net.IP {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var primary, secondary, fallback []net.IP
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		name := strings.ToLower(iface.Name)
		isVirtual := strings.HasPrefix(name, "utun") ||
			strings.HasPrefix(name, "awdl") ||
			strings.HasPrefix(name, "llw") ||
			strings.HasPrefix(name, "bridge") ||
			strings.HasPrefix(name, "docker") ||
			strings.HasPrefix(name, "veth") ||
			strings.HasPrefix(name, "anpi")
		isBroadcast := iface.Flags&net.FlagBroadcast != 0 && iface.Flags&net.FlagPointToPoint == 0
		isPhysicalName := strings.HasPrefix(name, "en") || strings.HasPrefix(name, "eth") || strings.HasPrefix(name, "wl") || strings.HasPrefix(name, "wi-fi")
		for _, addr := range addrs {
			ip, _, err := net.ParseCIDR(addr.String())
			if err != nil || !isLANIPv4(ip) {
				continue
			}
			v4 := ip.To4()
			switch {
			case isBroadcast && !isVirtual && isPhysicalName:
				primary = append(primary, v4)
			case isBroadcast && !isVirtual:
				secondary = append(secondary, v4)
			default:
				fallback = append(fallback, v4)
			}
		}
	}
	if len(primary) > 0 {
		return append(primary, secondary...)
	}
	if len(secondary) > 0 {
		return secondary
	}
	return fallback
}

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
	ips := collectLANIPs()
	if len(ips) == 0 {
		l.Close()
		return nil, errors.New("no private LAN address")
	}
	port := l.Addr().(*net.TCPAddr).Port
	ad, err := bonjour.Advertise(h.App.Store.DeviceID, port, ips)
	if err != nil {
		l.Close()
		return nil, err
	}
	addr := net.JoinHostPort(ips[0].String(), strconv.Itoa(port))
	s := &http.Server{Handler: http.HandlerFunc(h.ServeLAN), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 8 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10}
	go s.Serve(tls.NewListener(l, &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: priv}}}))
	return &lanServer{http: s, mdns: ad, addr: addr}, nil
}

const lanTicketAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

func randomTicketCode() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, len(buf))
	for i, b := range buf {
		out[i] = lanTicketAlphabet[int(b)%len(lanTicketAlphabet)]
	}
	return string(out), nil
}

func (h *Host) IssueLANTicket(ctx context.Context) (LANTicketResult, error) {
	var out LANTicketResult
	scope, pub, err := h.ensureDirectScope(ctx, true)
	if err != nil {
		return out, err
	}
	addr, err := h.syncLAN(true)
	if err != nil {
		return out, err
	}
	h.reload()
	code, err := randomTicketCode()
	if err != nil {
		return out, err
	}
	expires := time.Now().Add(10 * time.Minute).Unix()
	digest := p.Digest([]byte(code))
	h.mu.Lock()
	if h.lanTickets == nil {
		h.lanTickets = map[string]int64{}
	}
	now := time.Now().Unix()
	for k, exp := range h.lanTickets {
		if exp <= now {
			delete(h.lanTickets, k)
		}
	}
	h.lanTickets[digest] = expires
	h.mu.Unlock()
	hostName, _ := os.Hostname()
	if hostName == "" {
		hostName = "Lever"
	}
	return LANTicketResult{
		Code:     code,
		Expires:  expires,
		HostID:   h.App.Store.DeviceID,
		HostName: hostName,
		LAN:      addr,
		Link:     p.DirectPairLink(addr, h.App.Store.DeviceID, pub, code, hostName),
		Scope:    scope,
	}, nil
}

func (h *Host) consumeLANTicket(code string) bool {
	if code == "" {
		return false
	}
	digest := p.Digest([]byte(strings.ToUpper(strings.TrimSpace(code))))
	now := time.Now().Unix()
	h.mu.Lock()
	defer h.mu.Unlock()
	exp, ok := h.lanTickets[digest]
	if !ok || exp <= now {
		delete(h.lanTickets, digest)
		return false
	}
	delete(h.lanTickets, digest)
	return true
}

func (h *Host) handleDirectPair(w http.ResponseWriter, r *http.Request, body []byte) {
	var in p.PairInput
	if err := p.Decode(body, &in); err != nil {
		http.Error(w, "invalid pairing request", 400)
		return
	}
	if !in.Valid() || in.Role != p.Controller {
		http.Error(w, "invalid controller identity", 400)
		return
	}
	if !h.consumeLANTicket(in.Code) {
		http.Error(w, "配对码无效或已过期，请在电脑端重新生成", 403)
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "Lever"
	}
	if len(name) > 80 {
		name = name[:80]
	}
	var key []byte
	if err := h.App.Store.DB.QueryRowContext(r.Context(), "SELECT key FROM remote_identity WHERE singleton=1").Scan(&key); err != nil || len(key) != ed25519.PrivateKeySize {
		http.Error(w, "host identity unavailable", 500)
		return
	}
	priv := ed25519.PrivateKey(key)
	pub := priv.Public().(ed25519.PublicKey)
	scope, _, err := h.ensureDirectScope(r.Context(), true)
	if err != nil {
		http.Error(w, "failed to prepare direct LAN scope", 500)
		return
	}
	var policy, version int64
	if err := h.App.Store.DB.QueryRowContext(r.Context(), "SELECT policy,version FROM remote_memberships WHERE hub=? AND space=?", scope.HubID, scope.SpaceID).Scan(&policy, &version); err != nil {
		http.Error(w, "direct LAN scope unavailable", 500)
		return
	}
	h.configMu.Lock()
	err = h.App.Store.Write(r.Context(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO remote_trusted_controllers VALUES(?,?,?,?,?)
			ON CONFLICT(hub,space,controller) DO UPDATE SET pub=excluded.pub,name=excluded.name`,
			scope.HubID, scope.SpaceID, in.ID, []byte(in.PublicKey), name); err != nil {
			return err
		}
		for _, op := range []string{"send", "answer", "stop", "dispatch_task"} {
			if _, err := tx.Exec("INSERT OR IGNORE INTO remote_control_permissions VALUES(?,?,?,'*',?)", scope.HubID, scope.SpaceID, in.ID, op); err != nil {
				return err
			}
		}
		return nil
	})
	h.configMu.Unlock()
	if err != nil {
		http.Error(w, "failed to trust controller", 500)
		return
	}
	hostID := p.Identity{ID: h.App.Store.DeviceID, PublicKey: pub}
	grant := p.IssueGrant(p.Grant{
		HubID:      scope.HubID,
		SpaceID:    scope.SpaceID,
		UserID:     "local",
		Controller: p.Identity{ID: in.ID, PublicKey: in.PublicKey},
		Host:       hostID,
		Policy:     policy,
		// Direct LAN grants always verify remote_trusted_controllers so untrust revokes immediately.
		Expires: time.Now().Unix() - 1,
	}, priv)
	hostName, _ := os.Hostname()
	if hostName == "" {
		hostName = "Lever"
	}
	h.mu.Lock()
	lanAddr := h.lanAddr
	h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(p.DirectPairReceipt{
		Membership: p.Membership{
			Hub:      hostID,
			SpaceID:  scope.SpaceID,
			UserID:   "local",
			DeviceID: in.ID,
			Role:     p.Controller,
		},
		Grant: grant,
		Host: p.Device{
			Identity: hostID,
			SpaceID:  scope.SpaceID,
			Name:     hostName,
			Role:     p.Workstation,
			Platform: runtime.GOOS,
			Online:   true,
			Version:  version,
		},
		LANAddr: lanAddr,
	})
}

// ServeLAN serves the Host's dedicated, authenticated TLS endpoint.
func (h *Host) ServeLAN(w http.ResponseWriter, r *http.Request) {
	commandID, lookup := strings.CutPrefix(r.URL.Path, "/commands/")
	lookup = lookup && len(commandID) == 36 && !strings.Contains(commandID, "/")
	avatarID, avatarLookup := strings.CutPrefix(r.URL.Path, "/avatars/")
	avatarLookup = avatarLookup && len(avatarID) == 64 && !strings.Contains(avatarID, "/")
	if !(r.Method == http.MethodGet && (r.URL.Path == "/archive" || r.URL.Path == "/private" || r.URL.Path == "/host" || r.URL.Path == "/composer-meta" || lookup || avatarLookup) ||
		r.Method == http.MethodPut && r.URL.Path == "/starred-models" ||
		r.Method == http.MethodPost && (r.URL.Path == "/commands" || r.URL.Path == "/read" || r.URL.Path == "/cleared" || r.URL.Path == "/attachments" || r.URL.Path == "/pair" || r.URL.Path == "/unpair")) {
		http.NotFound(w, r)
		return
	}
	maxBody := int64(p.MaxFrame)
	if r.Method == http.MethodPost && r.URL.Path == "/attachments" {
		maxBody = 12 << 20
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		http.Error(w, "request too large", 413)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/pair" {
		h.handleDirectPair(w, r, body)
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
	if r.Method == http.MethodPost && r.URL.Path == "/unpair" {
		_, _ = h.App.Store.DB.ExecContext(r.Context(), "DELETE FROM remote_trusted_controllers WHERE hub=? AND space=? AND controller=?", g.HubID, g.SpaceID, g.Controller.ID)
		_ = json.NewEncoder(w).Encode(true)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/read" {
		var in p.ReadSync
		if err = p.Decode(body, &in); err != nil {
			http.Error(w, "invalid read sync", 400)
			return
		}
		if len(in.Items) > 500 {
			http.Error(w, "too many read cursors", 400)
			return
		}
		if m.UserID == g.UserID && len(in.Items) > 0 {
			if err = h.markScopeSessionsRead(r.Context(), g.HubID, g.SpaceID, g.Controller.ID, in.Items); err != nil {
				http.Error(w, "failed to sync read state", 500)
				return
			}
		}
		_ = json.NewEncoder(w).Encode(true)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/cleared" {
		var in p.ClearSync
		if err = p.Decode(body, &in); err != nil {
			http.Error(w, "invalid cleared sync", 400)
			return
		}
		if len(in.Items) > 500 {
			http.Error(w, "too many cleared cursors", 400)
			return
		}
		if m.UserID == g.UserID && len(in.Items) > 0 {
			if err = h.markScopeSessionsCleared(r.Context(), g.HubID, g.SpaceID, g.Controller.ID, in.Items); err != nil {
				http.Error(w, "failed to sync cleared state", 500)
				return
			}
		}
		_ = json.NewEncoder(w).Encode(true)
		return
	}
	if r.Method == http.MethodGet && avatarLookup {
		var allowed bool
		err := h.App.Store.DB.QueryRowContext(r.Context(), `SELECT EXISTS(
			SELECT 1 FROM agents a JOIN remote_memberships m ON m.hub=?1 AND m.space=?2
			WHERE coalesce(json_extract(a.data,'$.archived'),0)=0
			AND json_extract(a.data,'$.avatar.kind')='image'
			AND json_extract(a.data,'$.avatar.value')=?3
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
			g.HubID, g.SpaceID, avatarID).Scan(&allowed)
		if err != nil || !allowed {
			http.NotFound(w, r)
			return
		}
		f, mediaType, err := h.App.OpenAvatarImage(avatarID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		raw, err := io.ReadAll(io.LimitReader(f, p.MaxFrame))
		if err != nil {
			http.Error(w, "avatar unavailable", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"mediaType": mediaType,
			"data":      base64.StdEncoding.EncodeToString(raw),
		})
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/host" {
		var version int64
		_ = h.App.Store.DB.QueryRowContext(r.Context(), "SELECT version FROM remote_memberships WHERE hub=? AND space=?", g.HubID, g.SpaceID).Scan(&version)
		hostName, _ := os.Hostname()
		if hostName == "" {
			hostName = "Lever"
		}
		_ = json.NewEncoder(w).Encode(p.Device{
			Identity:      g.Host,
			SpaceID:       g.SpaceID,
			Name:          hostName,
			Role:          m.Role,
			Platform:      runtime.GOOS,
			Online:        true,
			DesktopActive: h.App.DesktopActive(),
			Version:       version,
		})
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/composer-meta" {
		meta, err := h.composerMeta(r.Context(), g, r.URL.Query().Get("agent"), r.URL.Query().Get("chat"), r.URL.Query().Get("session"), r.URL.Query().Get("provider"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_ = json.NewEncoder(w).Encode(meta)
		return
	}
	if r.Method == http.MethodPut && r.URL.Path == "/starred-models" {
		var in map[string][]string
		if err = p.Decode(body, &in); err != nil {
			http.Error(w, "invalid starred models", 400)
			return
		}
		if m.UserID != g.UserID {
			http.Error(w, "forbidden", 403)
			return
		}
		saved, err := h.saveStarredModels(r.Context(), in)
		if err != nil {
			http.Error(w, "failed to save starred models", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(saved)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/attachments" {
		var in p.AttachmentUpload
		if err = p.Decode(body, &in); err != nil || strings.TrimSpace(in.Name) == "" || in.Data == "" {
			http.Error(w, "invalid attachment upload", 400)
			return
		}
		rawBytes, err := base64.StdEncoding.DecodeString(in.Data)
		if err != nil || len(rawBytes) == 0 {
			http.Error(w, "invalid attachment data", 400)
			return
		}
		ref, err := h.uploadScopeAttachment(r.Context(), g, in.ChatID, in.AgentID, in.Name, rawBytes)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		_ = json.NewEncoder(w).Encode(ref)
		return
	}
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
		item, err := store.Get[p.InboxItem](r.Context(), h.App.Store.DB, `SELECT json_object('intent',json_extract(command,'$.intent'),'receipt',json(receipt)) FROM lan_proposals WHERE hub=?1 AND space=?2 AND id=?3 AND json_extract(command,'$.intent.originDeviceId')=?4 AND (coalesce(json_extract(command,'$.intent.private'),0)=0 OR EXISTS(SELECT 1 FROM remote_private_chats g WHERE g.hub=lan_proposals.hub AND g.space=lan_proposals.space AND g.controller=?4 AND g.chat=json_extract(command,'$.intent.chatId')) OR EXISTS(SELECT 1 FROM remote_memberships m JOIN remote_trusted_controllers t USING(hub,space) WHERE m.hub=lan_proposals.hub AND m.space=lan_proposals.space AND m.origin='' AND t.controller=?4))`, g.HubID, g.SpaceID, commandID, g.Controller.ID)
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
	q := r.URL.Query()
	chatID := q.Get("chat")
	sessionID := q.Get("session")
	beforeSeq, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit > 200 {
		limit = 200
	}
	if controller == "" && q.Get("sync") == "1" && sessionID == "" && beforeSeq == 0 && limit == 0 {
		page, err := h.archivePage(r.Context(), m, chatID, p.ReadCursor(q))
		if err != nil {
			http.Error(w, "archive unavailable", 500)
			return
		}
		json.NewEncoder(w).Encode(page)
		return
	}
	records, err := lanArchivePaged(r.Context(), h.App.Store, m, chatID, controller, sessionID, beforeSeq, limit)
	if err != nil {
		http.Error(w, "archive unavailable", 500)
		return
	}
	json.NewEncoder(w).Encode(records)
}

func lanArchive(ctx context.Context, s *store.Store, m p.Membership, chat, controller string) ([]p.Record, error) {
	return lanArchivePaged(ctx, s, m, chat, controller, "", 0, 0)
}

func lanArchivePaged(ctx context.Context, s *store.Store, m p.Membership, chat, controller, sessionID string, beforeSeq int64, limit int) ([]p.Record, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if chat != "" && (sessionID != "" || limit > 0) {
		return readLANArchivePaged(ctx, tx, m, chat, controller, sessionID, beforeSeq, limit)
	}
	return readLANArchive(ctx, tx, m, chat, controller)
}

func readLANArchivePaged(ctx context.Context, tx *sql.Tx, m p.Membership, chat, controller, sessionID string, beforeSeq int64, limit int) ([]p.Record, error) {
	if limit <= 0 {
		limit = 30
	}
	scope := sharedChatCond("?1", "?2")
	args := []any{m.Hub.ID, m.SpaceID, chat}
	ctrlIdx := ""
	if controller != "" {
		ctrlIdx = "?4"
		scope = privateChatCond("?1", "?2", ctrlIdx)
		args = append(args, controller)
	}
	sessArg := fmt.Sprintf("?%d", len(args)+1)
	args = append(args, sessionID)
	beforeArg := fmt.Sprintf("?%d", len(args)+1)
	args = append(args, beforeSeq)
	limitArg := fmt.Sprintf("?%d", len(args)+1)
	args = append(args, limit)

	var query string
	if sessionID != "" {
		query = "WITH allowed AS (SELECT c.id FROM chats c WHERE " + scope + " AND c.id=?3), " +
			"page_runs AS (SELECT id FROM runs WHERE chat_id IN allowed AND session_id=" + sessArg + " AND (" + beforeArg + "=0 OR sequence<" + beforeArg + ") ORDER BY sequence DESC LIMIT " + limitArg + ") " +
			"SELECT 'session',id FROM sessions WHERE chat_id IN allowed AND id=" + sessArg + " " +
			"UNION ALL SELECT 'run',id FROM page_runs " +
			"UNION ALL SELECT 'request',id FROM requests WHERE chat_id IN allowed AND json_extract(data,'$.sessionId')=" + sessArg + " AND (status='pending' OR json_extract(data,'$.runId') IN (SELECT id FROM page_runs))"
	} else {
		query = "WITH allowed AS (SELECT c.id FROM chats c WHERE " + scope + " AND c.id=?3), " +
			"main_sess AS (SELECT id FROM sessions WHERE chat_id IN allowed AND kind='main'), " +
			"page_runs AS (SELECT id FROM runs WHERE chat_id IN allowed AND session_id IN (SELECT id FROM main_sess) AND (" + beforeArg + "=0 OR sequence<" + beforeArg + ") ORDER BY sequence DESC LIMIT " + limitArg + ") " +
			"SELECT 'chat',id FROM allowed " +
			"UNION ALL SELECT 'session',id FROM sessions WHERE chat_id IN allowed " +
			"UNION ALL SELECT 'run',id FROM page_runs " +
			"UNION ALL SELECT 'request',id FROM requests WHERE chat_id IN allowed AND (status='pending' OR json_extract(data,'$.runId') IN (SELECT id FROM page_runs))"
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

func readLANArchive(ctx context.Context, tx *sql.Tx, m p.Membership, chat, controller string) ([]p.Record, error) {
	scope := sharedChatCond("?1", "?2")
	args := []any{m.Hub.ID, m.SpaceID, chat}
	if controller != "" {
		scope = privateChatCond("?1", "?2", "?4")
		args = append(args, controller)
	}
	query := "WITH allowed AS (SELECT c.id FROM chats c WHERE " + scope + " AND (?3='' OR c.id=?3)) SELECT 'chat',id FROM allowed UNION ALL SELECT 'session',id FROM sessions WHERE chat_id IN allowed"
	if chat != "" {
		query += " UNION ALL SELECT 'run',id FROM runs WHERE chat_id IN allowed UNION ALL SELECT 'request',id FROM requests WHERE chat_id IN allowed"
	} else if controller == "" {
		query += ` UNION ALL SELECT 'agent',a.id FROM agents a JOIN remote_memberships m ON m.hub=?1 AND m.space=?2
WHERE coalesce(json_extract(a.data,'$.archived'),0)=0 AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id))`
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

func (h *Host) markScopeSessionsRead(ctx context.Context, hubID, spaceID, controllerID string, items []p.ReadMark) error {
	allowed := make([]model.ReadMark, 0, len(items))
	for _, item := range items {
		if item.SessionID == "" || item.Sequence <= 0 {
			continue
		}
		var visible bool
		query := "SELECT EXISTS(SELECT 1 FROM sessions s JOIN chats c ON c.id=s.chat_id WHERE s.id=?1 AND ((" + sharedChatCond("?2", "?3") + ")"
		args := []any{item.SessionID, hubID, spaceID}
		if controllerID != "" {
			query += " OR (" + privateChatCond("?2", "?3", "?4") + ")"
			args = append(args, controllerID)
		}
		query += "))"
		if err := h.App.Store.DB.QueryRowContext(ctx, query, args...).Scan(&visible); err != nil {
			return err
		}
		if visible {
			allowed = append(allowed, model.ReadMark{SessionID: item.SessionID, Sequence: item.Sequence})
		}
	}
	return h.App.MarkSessionsRead(ctx, allowed)
}

func (h *Host) markScopeSessionsCleared(ctx context.Context, hubID, spaceID, controllerID string, items []p.ClearMark) error {
	allowed := make([]model.ClearMark, 0, len(items))
	for _, item := range items {
		if item.SessionID == "" {
			continue
		}
		var visible bool
		query := "SELECT EXISTS(SELECT 1 FROM sessions s JOIN chats c ON c.id=s.chat_id WHERE s.id=?1 AND ((" + sharedChatCond("?2", "?3") + ")"
		args := []any{item.SessionID, hubID, spaceID}
		if controllerID != "" {
			query += " OR (" + privateChatCond("?2", "?3", "?4") + ")"
			args = append(args, controllerID)
		}
		query += "))"
		if err := h.App.Store.DB.QueryRowContext(ctx, query, args...).Scan(&visible); err != nil {
			return err
		}
		if visible {
			allowed = append(allowed, model.ClearMark{SessionID: item.SessionID, Sequence: item.Sequence})
		}
	}
	return h.App.MarkSessionsCleared(ctx, allowed)
}

func (h *Host) loadStarredModels(ctx context.Context) map[string][]string {
	out := map[string][]string{}
	var raw string
	if err := h.App.Store.DB.QueryRowContext(ctx, "SELECT value FROM settings WHERE key='starred_models'").Scan(&raw); err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &out)
	}
	if out == nil {
		out = map[string][]string{}
	}
	return out
}

func (h *Host) saveStarredModels(ctx context.Context, in map[string][]string) (map[string][]string, error) {
	cleaned := map[string][]string{}
	for prov, ids := range in {
		prov = strings.TrimSpace(prov)
		if prov == "" || len(cleaned) >= 64 {
			continue
		}
		seen := map[string]bool{}
		list := make([]string, 0, len(ids))
		for _, id := range ids {
			id = strings.TrimSpace(id)
			if id == "" || seen[id] || len(list) >= 128 {
				continue
			}
			seen[id] = true
			list = append(list, id)
		}
		if len(list) > 0 {
			cleaned[prov] = list
		}
	}
	err := h.App.Store.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO settings(key,value) VALUES('starred_models',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", store.JSON(cleaned))
		return err
	})
	return cleaned, err
}

func (h *Host) composerMeta(ctx context.Context, g p.Grant, agentID, chatID, sessionID, runtimeOverride string) (p.ComposerMeta, error) {
	meta := p.ComposerMeta{
		Providers:     []p.ProviderCatalog{},
		StarredModels: h.loadStarredModels(ctx),
		Skills:        []p.Reference{},
	}

	providers, err := store.List[model.Provider](ctx, h.App.Store.DB, "SELECT data FROM providers ORDER BY rowid")
	if err != nil {
		return meta, err
	}
	for _, prov := range providers {
		if !prov.Enabled || prov.ID == "" {
			continue
		}
		hidden := map[string]bool{}
		for _, hm := range prov.HiddenModels {
			hidden[hm] = true
		}
		pc := p.ProviderCatalog{
			ID:       prov.ID,
			Name:     prov.Name,
			Type:     prov.Type,
			PluginID: prov.PluginID,
		}
		if pc.Name == "" {
			pc.Name = prov.ID
		}
		if cat, err := store.Get[model.Catalog](ctx, h.App.Store.DB, "SELECT data FROM provider_catalogs WHERE provider_id=? ORDER BY length(data) DESC LIMIT 1", prov.ID); err == nil {
			for _, mInfo := range cat.Models {
				if mInfo.ID == "" || hidden[mInfo.ID] {
					continue
				}
				name, _ := clipped(mInfo.Name, 128)
				pc.Models = append(pc.Models, p.ModelOption{
					ID:            mInfo.ID,
					Name:          name,
					ResolvedModel: mInfo.ResolvedModel,
					Efforts:       mInfo.Efforts,
					DefaultEffort: mInfo.DefaultEffort,
					Fast:          mInfo.Fast,
				})
			}
			for _, cmd := range cat.Commands {
				if cmd.Name == "" {
					continue
				}
				desc, _ := clipped(cmd.Description, 180)
				hint, _ := clipped(cmd.ArgumentHint, 120)
				pc.Commands = append(pc.Commands, p.SlashCommand{
					Name:         cmd.Name,
					Description:  desc,
					ArgumentHint: hint,
				})
			}
		}
		meta.Providers = append(meta.Providers, pc)
	}

	// Resolve Agent skills when a visible agent/chat is supplied
	resolvedAgent := agentID
	if chatID != "" {
		var visible bool
		query := "SELECT EXISTS(SELECT 1 FROM chats c WHERE c.id=?1 AND ((" + sharedChatCond("?2", "?3") + ") OR (" + privateChatCond("?2", "?3", "?4") + ")))"
		if err := h.App.Store.DB.QueryRowContext(ctx, query, chatID, g.HubID, g.SpaceID, g.Controller.ID).Scan(&visible); err != nil || !visible {
			return meta, nil
		}
		_ = h.App.Store.DB.QueryRowContext(ctx, "SELECT coalesce(json_extract(data,'$.agentId'),'') FROM chats WHERE id=?", chatID).Scan(&resolvedAgent)
	} else if resolvedAgent != "" {
		var visible bool
		if err := h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agents a JOIN remote_memberships m ON m.hub=?1 AND m.space=?2
			WHERE a.id=?3 AND coalesce(json_extract(a.data,'$.archived'),0)=0
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
			g.HubID, g.SpaceID, resolvedAgent).Scan(&visible); err != nil || !visible {
			return meta, nil
		}
	}

	if resolvedAgent != "" {
		runtimeID := runtimeOverride
		if runtimeID == "" {
			_ = h.App.Store.DB.QueryRowContext(ctx, "SELECT coalesce(json_extract(data,'$.profile.provider'),'') FROM agents WHERE id=?", resolvedAgent).Scan(&runtimeID)
		}
		if runtimeID != "" {
			sCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			refs, err := h.App.Suggestions(sCtx, chatID, resolvedAgent, sessionID, "", "slash", runtimeID, "")
			cancel()
			if err == nil {
				for _, ref := range refs {
					desc, _ := clipped(ref.Description, 180)
					hint, _ := clipped(ref.ArgumentHint, 120)
					meta.Skills = append(meta.Skills, p.Reference{
						Kind:         ref.Kind,
						Name:         ref.Name,
						ID:           ref.ID,
						Path:         ref.Path,
						Provider:     ref.Provider,
						Description:  desc,
						ArgumentHint: hint,
					})
				}
			}
		}
	}

	return meta, nil
}

func (h *Host) uploadScopeAttachment(ctx context.Context, g p.Grant, chatID, agentID, name string, raw []byte) (p.AttachmentRef, error) {
	var out p.AttachmentRef
	if chatID != "" {
		var visible bool
		query := "SELECT EXISTS(SELECT 1 FROM chats c WHERE c.id=?1 AND ((" + sharedChatCond("?2", "?3") + ") OR (" + privateChatCond("?2", "?3", "?4") + ")))"
		if err := h.App.Store.DB.QueryRowContext(ctx, query, chatID, g.HubID, g.SpaceID, g.Controller.ID).Scan(&visible); err != nil || !visible {
			return out, errors.New("chat is not accessible")
		}
		att, err := h.App.Upload(ctx, chatID, name, bytes.NewReader(raw))
		if err != nil {
			return out, err
		}
		return p.AttachmentRef{ID: att.ID, Name: att.Name, MediaType: att.MediaType, Size: att.Size}, nil
	}
	if agentID != "" {
		var visible bool
		if err := h.App.Store.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agents a JOIN remote_memberships m ON m.hub=?1 AND m.space=?2
			WHERE a.id=?3 AND coalesce(json_extract(a.data,'$.archived'),0)=0
			AND (m.expose_all=1 OR EXISTS(SELECT 1 FROM hub_exposed_agents e WHERE e.hub=m.hub AND e.space=m.space AND e.agent_id=a.id)))`,
			g.HubID, g.SpaceID, agentID).Scan(&visible); err != nil || !visible {
			return out, errors.New("agent is not accessible")
		}
		att, err := h.App.UploadDraft(ctx, agentID, name, bytes.NewReader(raw))
		if err != nil {
			return out, err
		}
		return p.AttachmentRef{ID: att.ID, Name: att.Name, MediaType: att.MediaType, Size: att.Size}, nil
	}
	return out, errors.New("chatId or agentId required")
}
