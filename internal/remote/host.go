// Package remote connects an opted-in Host to its Hub. Only curated archive
// projections leave the data directory. Local management uses private IPC.
package remote

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"slices"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"lever/internal/app"
	"lever/internal/device"
	"lever/internal/lanclient"
	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type Host struct {
	nodesMu                   sync.RWMutex
	nodes                     map[string]*connectedNode
	hubDirectories            map[model.SharedScope][]p.Device
	nodesChanged              chan struct{}
	peerOnce                  sync.Once
	peerMux                   http.Handler
	lanClient                 lanclient.Client
	lanMu                     sync.Mutex
	listenAddr, advertiseAddr string
	lan                       *lanServer
	lanAddr                   string
	lanError                  string
	lanAttempts               int
	lanTickets                map[string]int64
	lanNoncesMu               sync.Mutex
	lanNonces                 map[string]int64
	App                       *app.App
	ctx                       context.Context
	cancel                    context.CancelFunc
	wg                        sync.WaitGroup
	mu                        sync.Mutex
	configMu                  sync.Mutex
	configChanged             chan struct{}
	clients                   map[model.SharedScope]*connection
}
type connection struct {
	state  p.ClientState
	cancel context.CancelFunc
	online bool
	detail string
}
type Binding struct {
	LegacyPermissions bool          `json:"legacyPermissions,omitempty"`
	AccessLevel       p.AccessLevel `json:"accessLevel"`
	ReadOnlyFS        bool          `json:"readOnlyFs"`
	RequireApproval   bool          `json:"requireApproval"`
	Login             bool          `json:"login"`
	LoginSupported    bool          `json:"loginSupported"`
	LAN               bool          `json:"lan"`
	LANAddr           string        `json:"lanAddr,omitempty"`
	LANError          string        `json:"lanError,omitempty"`
	Direct            bool          `json:"direct,omitempty"`
	model.SharedScope
	Origin          string   `json:"origin"`
	SpaceKind       string   `json:"spaceKind,omitempty"`
	Role            p.Role   `json:"role"`
	DeviceID        string   `json:"deviceId"`
	Online          bool     `json:"online"`
	Error           string   `json:"error,omitempty"`
	ExposeAll       bool     `json:"exposeAll"`
	AllowDelegation bool     `json:"allowDelegation"`
	Agents          []string `json:"agents"`
	Acked           int64    `json:"acked"`
	Version         int64    `json:"version"`
}

func Start(a *app.App) *Host {
	ctx, cancel := context.WithCancel(a.Context())
	h := &Host{nodes: map[string]*connectedNode{}, nodesChanged: make(chan struct{}, 1), App: a, ctx: ctx, cancel: cancel, configChanged: make(chan struct{}, 1), clients: map[model.SharedScope]*connection{}, lanTickets: map[string]int64{}}
	h.wg.Add(2)
	go h.pollNodes()
	go h.manage()
	return h
}
func (h *Host) Close() { h.cancel(); h.wg.Wait() }
func (h *Host) reload() {
	select {
	case h.nodesChanged <- struct{}{}:
	default:
	}
	select {
	case h.configChanged <- struct{}{}:
	default:
	}
}
func stateFor(ctx context.Context, s *store.Store, scope model.SharedScope) (p.ClientState, error) {
	var st p.ClientState
	var key []byte
	if err := s.DB.QueryRowContext(ctx, "SELECT origin,key FROM remote_memberships,remote_identity WHERE hub=? AND space=?", scope.HubID, scope.SpaceID).Scan(&st.Origin, &key); err != nil {
		return st, err
	}
	m, err := store.Get[p.Membership](ctx, s.DB, "SELECT credential FROM remote_memberships WHERE hub=? AND space=?", scope.HubID, scope.SpaceID)
	st.Membership = m
	st.Key = key
	return st, err
}
func (h *Host) Bindings(ctx context.Context) ([]Binding, error) {
	rows, err := h.App.Store.DB.QueryContext(ctx, "SELECT hub,space,origin,coalesce(json_extract(credential,'$.spaceKind'),'personal'),json_extract(credential,'$.role'),acked,version,lan,expose_all,allow_delegation,coalesce(level,'workspace'),coalesce(read_only,0),coalesce(confirm,1),level IS NULL FROM remote_memberships LEFT JOIN remote_access USING(hub,space) ORDER BY origin,space")
	if err != nil {
		return nil, err
	}
	list := []Binding{}
	for rows.Next() {
		var v Binding
		if err = rows.Scan(&v.HubID, &v.SpaceID, &v.Origin, &v.SpaceKind, &v.Role, &v.Acked, &v.Version, &v.LAN, &v.ExposeAll, &v.AllowDelegation, &v.AccessLevel, &v.ReadOnlyFS, &v.RequireApproval, &v.LegacyPermissions); err != nil {
			rows.Close()
			return nil, err
		}
		v.LoginSupported = runtime.GOOS == "darwin" || runtime.GOOS == "windows"
		v.Login = device.LoginEnabled(h.App.Store.Dir)
		v.DeviceID = h.App.Store.DeviceID
		if !v.Role.Executes() {
			v.AccessLevel = p.AccessNone
		}
		list = append(list, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for j := range list {
		v := &list[j]
		groups, err := store.List[string](ctx, h.App.Store.DB, "SELECT json_quote(agent_id) FROM hub_exposed_agents WHERE hub=? AND space=? ORDER BY agent_id", v.HubID, v.SpaceID)
		if err != nil {
			return nil, err
		}
		v.Agents = groups
		v.Direct = v.Origin == ""
		h.mu.Lock()
		if v.LAN {
			v.LANError = h.lanError
			v.LANAddr = h.lanAddr
		}
		if v.Direct {
			v.Online = v.LAN && h.lanError == "" && h.lanAddr != ""
			v.Error = v.LANError
		} else if c := h.clients[v.SharedScope]; c != nil {
			v.Online = c.online
			v.Error = c.detail
		}
		h.mu.Unlock()
	}
	return list, nil
}

// ListenPeer configures the dedicated, authenticated TLS listener for a headless
// Node. Its full local workbench continues to use a separate loopback listener.
func (h *Host) ListenPeer(bind, advertise string) (string, error) {
	h.lanMu.Lock()
	defer h.lanMu.Unlock()
	if h.lan != nil {
		h.lan.close()
		h.lan = nil
	}
	h.listenAddr, h.advertiseAddr = bind, advertise
	return h.syncLANLocked(true)
}
func (h *Host) syncLAN(want bool) (string, error) {
	h.lanMu.Lock()
	defer h.lanMu.Unlock()
	return h.syncLANLocked(want || h.listenAddr != "" && h.ctx.Err() == nil)
}
func (h *Host) syncLANLocked(want bool) (string, error) {
	if want && h.lan == nil {
		lan, err := h.listenLAN()
		h.mu.Lock()
		h.lanError = ""
		h.lanAddr = ""
		if err != nil {
			h.lanError = err.Error()
		} else {
			h.lan = lan
			h.lanAddr = lan.addr
		}
		h.mu.Unlock()
		if err != nil {
			return "", err
		}
	} else if !want && h.lan != nil {
		h.lan.close()
		h.lan = nil
		h.mu.Lock()
		h.lanAddr = ""
		h.lanError = ""
		h.mu.Unlock()
	}
	if h.lan != nil {
		return h.lan.addr, nil
	}
	return "", nil
}
func (h *Host) manage() {
	defer h.wg.Done()
	defer func() {
		_, _ = h.syncLAN(false)
	}()
	for {
		bindings, err := h.Bindings(h.ctx)
		if err == nil {
			wantLAN := false
			for _, v := range bindings {
				wantLAN = wantLAN || (v.LAN && v.Role.Executes())
			}
			_, _ = h.syncLAN(wantLAN)
			current := map[model.SharedScope]bool{}
			for _, v := range bindings {
				if v.Origin == "" {
					continue
				}
				st, err := stateFor(h.ctx, h.App.Store, v.SharedScope)
				if err != nil {
					continue
				}
				current[v.SharedScope] = true
				h.mu.Lock()
				old := h.clients[v.SharedScope]
				if old == nil || old.state.Membership.Token != st.Membership.Token {
					if old != nil {
						old.cancel()
					}
					ctx, cancel := context.WithCancel(h.ctx)
					c := &connection{state: st, cancel: cancel}
					h.clients[v.SharedScope] = c
					h.wg.Add(1)
					go h.run(ctx, c)
				}
				h.mu.Unlock()
			}
			h.mu.Lock()
			for k, c := range h.clients {
				if !current[k] {
					c.cancel()
					delete(h.clients, k)
				}
			}
			h.mu.Unlock()
		}
		select {
		case <-h.ctx.Done():
			return
		case <-h.configChanged:
		case <-time.After(30 * time.Second):
		}
	}
}
func (h *Host) run(ctx context.Context, c *connection) {
	defer h.wg.Done()
	retry := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := h.sync(ctx, c)
		h.mu.Lock()
		c.online = false
		if err != nil {
			c.detail = err.Error()
		}
		h.mu.Unlock()
		if time.Since(start) > 30*time.Second {
			retry = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retry + time.Duration(rand.IntN(400))*time.Millisecond):
		}
		retry = min(retry*2, 30*time.Second)
	}
}
func (h *Host) sync(ctx context.Context, c *connection) error {
	st := c.state
	m := st.Membership
	syncPath := st.SpacePath() + "/connect"
	if slices.Contains(m.Features, p.FeatureTunnel) {
		syncPath = "/ws/sync"
	}
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, Proxy: http.ProxyFromEnvironment}
	dial := func(path string) (*websocket.Conn, *http.Response, error) {
		req, err := st.Request(ctx, "GET", path, nil)
		if err != nil {
			return nil, nil, err
		}
		u := *req.URL
		if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
		return dialer.DialContext(ctx, u.String(), req.Header)
	}
	ws, resp, err := dial(syncPath)
	if err != nil && syncPath == "/ws/sync" && resp != nil && (resp.StatusCode == 404 || resp.StatusCode == 426) {
		resp.Body.Close()
		ws, resp, err = dial(st.SpacePath() + "/connect")
	}

	if resp != nil {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			_, _ = h.App.Store.DB.ExecContext(ctx, "UPDATE remote_memberships SET policy=-1 WHERE hub=? AND space=? AND json_extract(credential,'$.token')=?", m.Hub.ID, m.SpaceID, m.Token)
		}
		resp.Body.Close()
	}
	if err != nil {
		return err
	}
	defer ws.Close()
	stop := context.AfterFunc(ctx, func() { ws.Close() })
	defer stop()
	ws.SetReadLimit(p.MaxFrame)
	ws.SetReadDeadline(time.Now().Add(90 * time.Second))
	ws.SetPingHandler(func(data string) error {
		ws.SetReadDeadline(time.Now().Add(90 * time.Second))
		return ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(5*time.Second))
	})
	var hello p.Frame
	if err = ws.ReadJSON(&hello); err != nil {
		return err
	}
	if hello.Type != "hello" || hello.Protocol != p.Version || hello.SpaceID != m.SpaceID || hello.DeviceID != m.DeviceID {
		return errors.New("Hub protocol or identity mismatch")
	}
	if _, err = h.App.Store.DB.ExecContext(ctx, "UPDATE remote_memberships SET policy=? WHERE hub=? AND space=? AND json_extract(credential,'$.token')=?", hello.Policy, m.Hub.ID, m.SpaceID, m.Token); err != nil {
		return err
	}
	h.mu.Lock()
	c.online = true
	c.detail = ""
	h.mu.Unlock()
	ch := make(chan p.Frame, 8)
	readctx, done := context.WithCancel(ctx)
	defer done()
	go func() {
		defer close(ch)
		for {
			var f p.Frame
			if ws.ReadJSON(&f) != nil {
				return
			}
			select {
			case ch <- f:
			case <-readctx.Done():
				return
			}
		}
	}()
	if m.Role.Executes() {
		var reports sync.WaitGroup
		if slices.Contains(hello.Features, p.FeatureTunnel) && hello.TunnelID != "" {
			reports.Add(1)
			go func() { defer reports.Done(); h.maintainTunnel(readctx, st, hello.TunnelID) }()
		}
		reports.Add(1)
		go func() {
			defer reports.Done()
			tick := time.NewTicker(3 * time.Second)
			defer tick.Stop()
			for {
				_ = h.publishLAN(readctx, st)
				select {
				case <-readctx.Done():
					return
				case <-tick.C:
				}
			}
		}()
		defer func() { done(); reports.Wait() }()
	}

	tick := time.NewTicker(650 * time.Millisecond)
	defer tick.Stop()
	send := func(f p.Frame) error {
		f.SpaceID = m.SpaceID
		f.DeviceID = m.DeviceID
		ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return ws.WriteJSON(f)
	}
	base := hello.Version
	var localEpoch string
	var localAck, localVersion int64
	if err = h.App.Store.DB.QueryRowContext(ctx, "SELECT epoch,acked,version FROM remote_memberships WHERE hub=? AND space=?", m.Hub.ID, m.SpaceID).Scan(&localEpoch, &localAck, &localVersion); err != nil {
		return err
	}
	if base > localVersion {
		// The Hub has seen writes absent from this restored Host. Give its
		// replacement snapshot a fresh lineage before advertising new changes.
		localEpoch = p.NewID()
		if _, err = h.App.Store.DB.ExecContext(ctx, "UPDATE remote_memberships SET epoch=?,acked=0 WHERE hub=? AND space=? AND version<?", localEpoch, m.Hub.ID, m.SpaceID, base); err != nil {
			return err
		}
	}
	full := hello.Epoch != localEpoch || base != localAck || base == 0
	dirty := true
	pending := int64(-1)
	var epoch string
	lastPresenceSent := false
	lastPresenceAt := time.Time{}
	lastDescriptor := ""
	var checkedDescriptorAt time.Time
	sendPresence := func(force bool) error {
		if !m.Role.Executes() {
			return nil
		}
		if slices.Contains(hello.Features, p.FeatureTunnel) && (force || time.Since(checkedDescriptorAt) >= 2*time.Second) {
			checkedDescriptorAt = time.Now()
			node, err := h.descriptor(ctx, m)
			if err != nil {
				return err
			}
			if data := store.JSON(node); node.Supports(p.FeaturePeer) && data != lastDescriptor {
				if err = send(p.Frame{Type: "node", Node: &node}); err != nil {
					return err
				}
				lastDescriptor = data
			}
		}
		active := h.App.DesktopActive()
		if !force && active == lastPresenceSent && (!active || time.Since(lastPresenceAt) < 20*time.Second) {
			return nil
		}
		lastPresenceSent = active
		lastPresenceAt = time.Now()
		return send(p.Frame{Type: "desktop_presence", DesktopActive: active})
	}
	if err = sendPresence(true); err != nil {
		return err
	}
	for {
		if err = sendPresence(false); err != nil {
			return err
		}
		if dirty && pending < 0 && m.Role.Executes() {
			b, err := projectBatch(ctx, h.App.Store, m, base, full, localEpoch)
			if err != nil {
				return err
			}
			dirty = false
			full = false
			if b.full || b.version != base {
				if err = send(p.Frame{Type: "start", Base: base, Epoch: b.epoch, Version: b.version, Full: b.full}); err != nil {
					return err
				}
				for _, change := range b.changes {
					if err = send(p.Frame{Type: "chunk", Changes: []p.Change{change}}); err != nil {
						return err
					}
				}
				if err = send(p.Frame{Type: "commit"}); err != nil {
					return err
				}
				pending = b.version
				epoch = b.epoch
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			// SQLite triggers also see writes made by an independent run host.
			dirty = true
		case f, ok := <-ch:
			if !ok {
				return errors.New("Hub disconnected")
			}
			if f.SpaceID != m.SpaceID || f.DeviceID != m.DeviceID {
				return errors.New("unexpected scope")
			}
			switch f.Type {
			case "offer_command":
				if m.Role.Executes() && len(f.RPCID) == 36 {
					h.acceptOffer(ctx, st, f)
				}
			case "refresh":
				if _, err = h.App.Store.DB.ExecContext(ctx, "UPDATE remote_memberships SET policy=? WHERE hub=? AND space=? AND json_extract(credential,'$.token')=? AND policy<>?", f.Policy, m.Hub.ID, m.SpaceID, m.Token, f.Policy); err != nil {
					return err
				}
			case "ack":
				if f.Version != pending || f.Epoch != epoch {
					return errors.New("unexpected sync acknowledgement")
				}
				if err = h.App.Store.Write(ctx, func(tx *sql.Tx) error {
					if _, err := tx.Exec("UPDATE remote_memberships SET acked=? WHERE hub=? AND space=? AND epoch=?", f.Version, m.Hub.ID, m.SpaceID, epoch); err != nil {
						return err
					}
					floor := max(int64(0), f.Version-p.ArchiveWindow)
					if _, err := tx.Exec("INSERT INTO remote_replay_bounds VALUES(?,?,?) ON CONFLICT(hub,space) DO UPDATE SET floor=max(floor,excluded.floor)", m.Hub.ID, m.SpaceID, floor); err != nil {
						return err
					}
					_, err := tx.Exec("DELETE FROM shared_sync_log WHERE hub=? AND space=? AND version<=?", m.Hub.ID, m.SpaceID, floor)
					return err
				}); err != nil {
					return err
				}
				localEpoch = epoch
				base = pending
				pending = -1
			case "query_command", "cancel_dispatch":
				if !m.Role.Executes() || len(f.Digest) != 64 || len(f.RPCID) != 36 {
					return errors.New("invalid receipt query")
				}
				var rec p.Receipt
				// Share the local review lock so a cancelled and an accepted
				// outcome cannot both win the same command ID.
				h.configMu.Lock()
				err = h.App.Store.Write(ctx, func(tx *sql.Tx) error {
					if f.Type == "cancel_dispatch" {
						tomb := p.Receipt{ID: f.RPCID, Status: "cancelled", Detail: "confirmed"}
						if _, err := tx.Exec("INSERT OR IGNORE INTO remote_commands VALUES(?,?,?,?,?)", m.Hub.ID, m.SpaceID, f.RPCID, f.Digest, store.JSON(tomb)); err != nil {
							return err
						}
					}
					var err error
					rec, err = store.Get[p.Receipt](ctx, tx, "SELECT receipt FROM remote_commands WHERE hub=? AND space=? AND id=? AND digest=?", m.Hub.ID, m.SpaceID, f.RPCID, f.Digest)
					if errors.Is(err, sql.ErrNoRows) {
						rec = p.Receipt{ID: f.RPCID, Status: "not_found"}
						return nil
					}
					return err
				})
				h.configMu.Unlock()
				if err != nil {
					return err
				}
				if err = send(p.Frame{Type: "command_state", Digest: f.Digest, RPCID: f.RPCID, Receipt: &rec}); err != nil {
					return err
				}
			case "verify_idle":
				idle, err := h.App.SharedIdle(ctx, model.SharedScope{HubID: m.Hub.ID, SpaceID: m.SpaceID}, f.SessionID, f.RunID, f.Completed)
				if err != nil {
					return err
				}
				if err = send(p.Frame{Type: "idle", RPCID: f.RPCID, Idle: idle}); err != nil {
					return err
				}
			case "mark_read":
				if m.Role.Executes() && len(f.ReadMarks) > 0 && len(f.ReadMarks) <= 500 {
					_ = h.markScopeSessionsRead(ctx, m.Hub.ID, m.SpaceID, "", f.ReadMarks)
				}
			case "mark_cleared":
				if m.Role.Executes() && len(f.ClearMarks) > 0 && len(f.ClearMarks) <= 500 {
					_ = h.markScopeSessionsCleared(ctx, m.Hub.ID, m.SpaceID, "", f.ClearMarks)
				}
			}
		}
	}
}

type PairConfig struct {
	reciprocal *p.DirectPairReceipt
	Link       string        `json:"link,omitempty"`
	Access     p.AccessLevel `json:"access,omitempty"`
	ExposeAll  *bool         `json:"exposeAll,omitempty"`
	AgentIDs   []string      `json:"agentIds,omitempty"`
	NoControl  bool          `json:"noControl,omitempty"`
	Hub        string        `json:"hub"`
	Code       string        `json:"code"`
	Role       p.Role        `json:"role"`
	Name       string        `json:"name,omitempty"`
}

func PairStore(ctx context.Context, s *store.Store, in PairConfig) (model.SharedScope, error) {
	var key []byte
	var scope model.SharedScope
	if err := s.DB.QueryRowContext(ctx, "SELECT key FROM remote_identity WHERE singleton=1").Scan(&key); err != nil {
		return scope, err
	}
	if len(key) != ed25519.PrivateKeySize {
		return scope, errors.New("invalid Host private key")
	}
	if in.Access == "" {
		in.Access = p.AccessWorkspace
	}
	if !in.Access.Allows(p.AccessChat) {
		return scope, errors.New("access must be chat, workspace or admin")
	}
	if in.NoControl {
		in.Role = p.Executor
	}
	if in.Name == "" {
		in.Name, _ = os.Hostname()
	}
	priv := ed25519.PrivateKey(key)
	pi := p.PairInput{Code: in.Code, Name: in.Name, Platform: runtime.GOOS, Role: in.Role, Identity: p.Identity{ID: s.DeviceID, PublicKey: priv.Public().(ed25519.PublicKey)}}
	if in.Link != "" {
		params, direct, err := p.ParseDirectPairLink(in.Link)
		if err != nil {
			return scope, err
		}
		if direct {
			if in.NoControl || in.Role == p.Executor {
				return scope, errors.New("direct pairing requires a controller or workstation")
			}
			if params.HostID == s.DeviceID {
				return scope, errors.New("cannot pair this device with itself")
			}
			// Use the controller wire role for compatibility with older LAN Hosts.
			pi.Role = p.Controller
			pi.Reciprocal = in.reciprocal
			st, receipt, err := p.PairDirect(ctx, params, pi, priv)
			if err != nil {
				return scope, err
			}
			m := st.Membership
			receipt.LANAddr = st.LANAddr
			err = s.Write(ctx, func(tx *sql.Tx) error {
				if err := savePeer(tx, receipt); err != nil {
					return err
				}
				if in.reciprocal != nil {
					return saveLANController(tx, model.SharedScope{HubID: s.DeviceID, SpaceID: s.DeviceID}, m.Hub, st.HostName, false)
				}
				return nil
			})
			return model.SharedScope{HubID: m.Hub.ID, SpaceID: m.SpaceID}, err
		}
		origin, code, err := p.HubPairLink(in.Link)
		if err != nil {
			return scope, err
		}
		in.Hub, pi.Code = origin, code
	}
	state, err := p.Pair(ctx, in.Hub, pi, priv)
	if err != nil {
		return scope, err
	}
	m := state.Membership
	scope = model.SharedScope{HubID: m.Hub.ID, SpaceID: m.SpaceID}
	err = s.Write(ctx, func(tx *sql.Tx) error {
		expose := m.SpaceKind == "personal" && m.Role.Executes()
		if in.ExposeAll != nil {
			expose = *in.ExposeAll && m.Role.Executes()
		}
		result, err := tx.Exec(`INSERT INTO remote_memberships(hub,space,origin,credential,epoch,expose_all) VALUES(?,?,?,?,?,?)
			ON CONFLICT(hub,space) DO UPDATE SET origin=excluded.origin,credential=excluded.credential,epoch=excluded.epoch,acked=0
			WHERE json_extract(remote_memberships.credential,'$.hub.publicKey')=json_extract(excluded.credential,'$.hub.publicKey') AND json_extract(remote_memberships.credential,'$.userId')=json_extract(excluded.credential,'$.userId')`, scope.HubID, scope.SpaceID, state.Origin, store.JSON(m), p.NewID(), expose)
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n != 1 {
			return errors.New("paired Hub identity or owner changed")
		}
		if !expose && m.Role.Executes() {
			for _, id := range in.AgentIDs {
				if _, err = tx.Exec("INSERT OR IGNORE INTO hub_exposed_agents SELECT ?,?,id FROM agents WHERE id=?", scope.HubID, scope.SpaceID, id); err != nil {
					return err
				}
			}
		}
		_, err = tx.Exec("INSERT OR IGNORE INTO remote_access(hub,space,level,confirm) VALUES(?,?,?,?)", scope.HubID, scope.SpaceID, in.Access, m.SpaceKind != "personal")
		return err
	})
	return scope, err
}
func (h *Host) Unpair(ctx context.Context, scope model.SharedScope) error {
	st, err := stateFor(ctx, h.App.Store, scope)
	if err != nil {
		return err
	}
	if st.Origin != "" {
		err = st.Do(ctx, "DELETE", st.SpacePath()+"/devices/"+url.PathEscape(st.Membership.DeviceID), nil, nil)
		var httpErr *p.HTTPError
		if err != nil && !(errors.As(err, &httpErr) && httpErr.Status == 401) {
			return fmt.Errorf("revoking Hub credential: %w", err)
		}
	}
	_, err = h.App.Store.DB.ExecContext(ctx, "DELETE FROM remote_memberships WHERE hub=? AND space=?", scope.HubID, scope.SpaceID)
	h.reload()
	return err
}

func (h *Host) ensureDirectScope(ctx context.Context, enableLAN bool) (model.SharedScope, ed25519.PublicKey, error) {
	var key []byte
	scope := model.SharedScope{HubID: h.App.Store.DeviceID, SpaceID: h.App.Store.DeviceID}
	if err := h.App.Store.DB.QueryRowContext(ctx, "SELECT key FROM remote_identity WHERE singleton=1").Scan(&key); err != nil {
		return scope, nil, err
	}
	if len(key) != ed25519.PrivateKeySize {
		return scope, nil, errors.New("invalid Host private key")
	}
	pub := ed25519.PrivateKey(key).Public().(ed25519.PublicKey)
	m := p.Membership{
		Hub:       p.Identity{ID: h.App.Store.DeviceID, PublicKey: pub},
		SpaceID:   h.App.Store.DeviceID,
		SpaceKind: "personal",
		UserID:    "local",
		DeviceID:  h.App.Store.DeviceID,
		Role:      p.Workstation,
	}
	lanVal := 0
	if enableLAN {
		lanVal = 1
	}
	err := h.App.Store.Write(ctx, func(tx *sql.Tx) error {
		var existing bool
		if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM remote_memberships WHERE hub=? AND space=?)", scope.HubID, scope.SpaceID).Scan(&existing); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO remote_memberships(hub,space,origin,credential,epoch,lan,policy,expose_all) VALUES(?,?,'',?,?,?,1,1)
			ON CONFLICT(hub,space) DO UPDATE SET credential=excluded.credential,policy=max(policy,1),lan=CASE WHEN ?=1 THEN 1 ELSE lan END`,
			scope.HubID, scope.SpaceID, store.JSON(m), p.NewID(), lanVal, lanVal)
		if err != nil {
			return err
		}
		if existing {
			return nil
		} // Preserve the original per-controller policy on upgrade.
		_, err = tx.Exec("INSERT OR IGNORE INTO remote_access(hub,space,level) VALUES(?,?,'workspace')", scope.HubID, scope.SpaceID)
		return err
	})
	return scope, pub, err
}
