package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	p "lever/internal/remoteproto"
)

func (h *Hub) tunnel(w http.ResponseWriter, r *http.Request, a principal) error {
	k := deviceKey{a.space, a.device}
	h.mu.Lock()
	l := h.links[k]
	h.mu.Unlock()
	if l == nil || r.URL.Query().Get("link") != l.tunnelID || r.Header.Get("Origin") != "" {
		return denied
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return nil
	}
	defer ws.CloseNow()
	conn := websocket.NetConn(r.Context(), ws, websocket.MessageBinary)
	cfg := yamux.DefaultConfig()
	cfg.StreamOpenTimeout = 5 * time.Second
	session, err := yamux.Client(conn, cfg)
	if err != nil {
		return nil
	}
	defer session.Close()
	h.mu.Lock()
	if h.links[k] != l {
		h.mu.Unlock()
		return nil
	}
	old := l.tunnel
	l.tunnel = session
	h.mu.Unlock()
	if old != nil {
		old.Close()
	}
	h.notify(a.space)
	cacheCtx, stopCache := context.WithCancel(r.Context())
	cacheDone := make(chan struct{})
	go func() { defer close(cacheDone); h.warmNode(cacheCtx, k, a.user, l, session) }()
	defer func() { stopCache(); <-cacheDone }()
	defer func() {
		h.mu.Lock()
		if l.tunnel == session {
			l.tunnel = nil
		}
		h.mu.Unlock()
		h.notify(a.space)
	}()
	select {
	case <-session.CloseChan():
	case <-l.ended:
	case <-r.Context().Done():
	}
	return nil
}

func (h *Hub) peer(w http.ResponseWriter, r *http.Request, a principal) error {
	id := r.PathValue("node")
	space := r.PathValue("space")
	if space == "" {
		space = a.space
	}
	var raw string
	var draining bool
	// Browser sessions may belong to multiple spaces. Resolve only a personal
	// executor owned by this account, and bind device credentials to their space.
	err := h.db.QueryRowContext(r.Context(), `SELECT d.space_id,d.node,d.draining FROM devices d JOIN spaces s ON s.id=d.space_id
		JOIN memberships m ON m.space_id=s.id AND m.user_id=d.user_id
		WHERE d.id=? AND d.user_id=? AND s.kind='personal' AND d.revoked=0 AND d.role IN ('workstation','executor')
		AND (?='' OR d.space_id=?)`, id, a.user, space, space).Scan(&space, &raw, &draining)
	if err != nil {
		return err
	}
	k := deviceKey{space, id}
	h.mu.Lock()
	var tunnel *yamux.Session
	if l := h.links[k]; l != nil {
		tunnel = l.tunnel
	}
	h.mu.Unlock()
	var n p.NodeDescriptor
	if json.Unmarshal([]byte(raw), &n) != nil || !n.Supports(p.FeaturePeer) {
		return problem{426, "target device needs a Lever upgrade"}
	}
	route := r.PathValue("route")
	if tunnel == nil {
		if r.Method == "GET" && n.Supports(p.FeatureHotCache) && n.CacheEpoch != "" {
			return h.cachedNode(w, r, k, n)
		}
		return problem{503, "target device is offline"}
	}
	transport := ownerTransport(tunnel)
	defer transport.CloseIdleConnections()
	// Cut long-lived responses when their source session or device is revoked.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if route == "events" || r.Header.Get("Upgrade") != "" {
		go h.watchPeerIdentity(ctx, cancel, a)
	}
	p.ProxyPeer(w, r.WithContext(ctx), route, func(out *http.Request) (*http.Response, error) {
		out.Header.Set("X-Lever-Actor-User", a.user)
		out.Header.Set("X-Lever-Actor-Node", a.device)
		if draining {
			out.Header.Set("X-Lever-Draining", "1")
		}
		return transport.RoundTrip(out)
	})
	return nil
}
func (h *Hub) watchPeerIdentity(ctx context.Context, cancel context.CancelFunc, a principal) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var one int
			var err error
			if a.session != "" {
				err = h.db.QueryRowContext(ctx, "SELECT 1 FROM sessions WHERE id=? AND expires>?", a.session, time.Now().Unix()).Scan(&one)
			} else {
				err = h.db.QueryRowContext(ctx, "SELECT 1 FROM devices WHERE token=? AND revoked=0", a.token).Scan(&one)
			}
			if err != nil {
				cancel()
				return
			}
		}
	}
}
