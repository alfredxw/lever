package remote

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"lever/internal/eventstream"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/multinode"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

type connectedNode struct {
	router *multinode.Node
	cancel context.CancelFunc
	view   NodeOverview
}
type NodeView struct {
	NodeOverview
	Route string `json:"route,omitempty"`
	RTT   int64  `json:"rttMs,omitempty"`
}

func (h *Host) directPeers(ctx context.Context) ([]p.ClientState, error) {
	return store.List[p.ClientState](ctx, h.App.Store.DB, `SELECT json_object('membership',json(membership),'directGrant',grant,'lanAddr',address,'hostName',name,'hostPlatform',platform,'direct',json('true')) FROM remote_peers ORDER BY node_id`)
}

func (h *Host) pollNodes() {
	defer h.wg.Done()
	for {
		h.refreshNodes(h.ctx)
		select {
		case <-h.ctx.Done():
			return
		case <-h.nodesChanged:
		case <-time.After(6 * time.Second):
		}
	}
}
func (h *Host) refreshNodes(ctx context.Context) {
	targets := map[string]multinode.Target{}
	var key []byte
	if err := h.App.Store.DB.QueryRowContext(ctx, "SELECT key FROM remote_identity").Scan(&key); err != nil || len(key) != ed25519.PrivateKeySize {
		return
	}
	direct, err := h.directPeers(ctx)
	if err != nil {
		return
	}
	for _, st := range direct {
		st.Key = key
		id := st.Membership.Hub.ID
		targets[id] = multinode.Target{Info: p.Device{Identity: st.Membership.Hub, Name: st.HostName, Platform: st.HostPlatform}, LAN: &st}
	}
	bindings, err := h.Bindings(ctx)
	if err != nil {
		return
	}
	h.nodesMu.RLock()
	previous := h.hubDirectories
	h.nodesMu.RUnlock()
	next := map[model.SharedScope][]p.Device{}
	for _, b := range bindings {
		if b.Direct || !b.Role.Controls() {
			continue
		}
		st, err := stateFor(ctx, h.App.Store, b.SharedScope)
		if err != nil {
			continue
		}
		probe, cancel := context.WithTimeout(ctx, 3*time.Second)
		var devices []p.Device
		err = st.Do(probe, "GET", st.SpacePath()+"/devices", nil, &devices)
		cancel()
		if err != nil {
			var he *p.HTTPError
			if errors.As(err, &he) && (he.Status == 401 || he.Status == 403) {
				continue
			}
			devices = slices.Clone(previous[b.SharedScope])
			for i := range devices {
				devices[i].Online = false
			}
		}
		next[b.SharedScope] = devices
		for _, d := range devices {
			if d.Revoked || !d.Role.Executes() || d.ID == h.App.Store.DeviceID {
				continue
			}
			t := targets[d.ID]
			if t.Info.ID != "" && !bytes.Equal(t.Info.PublicKey, d.PublicKey) {
				continue
			}
			t.Info = d
			t.Hub = &st
			targets[d.ID] = t
		}
	}
	h.nodesMu.Lock()
	defer h.nodesMu.Unlock()
	h.hubDirectories = next
	for id, n := range h.nodes {
		if _, ok := targets[id]; !ok {
			n.cancel()
			delete(h.nodes, id)
		}
	}
	for id, t := range targets {
		if n := h.nodes[id]; n != nil {
			n.router.Update(t)
			continue
		}
		child, cancel := context.WithCancel(ctx)
		var cached NodeOverview
		if t.LAN != nil {
			cached, _ = store.Get[NodeOverview](ctx, h.App.Store.DB, "SELECT data FROM peer_local_index WHERE node_id=?", id)
			if t.Info.Node == nil && cached.Node.NodeID == id && bytes.Equal(cached.Node.PublicKey, t.Info.PublicKey) {
				t.Info.Node = &cached.Node
			}
		}
		n := &connectedNode{router: multinode.New(t, &h.lanClient), cancel: cancel, view: cached}
		h.nodes[id] = n
		h.wg.Add(1)
		go h.followNode(child, n)
	}
}
func (h *Host) followNode(ctx context.Context, n *connectedNode) {
	defer h.wg.Done()
	var watched string
	var stop context.CancelFunc
	var watchDone chan struct{}
	defer func() {
		if stop != nil {
			stop()
			<-watchDone
		}
	}()
	var revision int64
	var epoch, previousRoute string
	var previousLevel p.AccessLevel
	for ctx.Err() == nil {
		n.router.Probe(ctx)
		status := n.router.Status()
		if status.Denied {
			h.clearPeerCache(ctx, status.NodeID)
			h.nodesMu.Lock()
			n.view = NodeOverview{}
			h.nodesMu.Unlock()
			revision, epoch, previousRoute = 0, "", ""
		}
		if watched != status.Route || (watchDone != nil && closed(watchDone)) {
			if stop != nil {
				stop()
				<-watchDone
				stop = nil
				watchDone = nil
			}
			watched = status.Route
			if watched != "" {
				var child context.Context
				child, stop = context.WithCancel(ctx)
				watchDone = make(chan struct{})
				h.nodesMu.RLock()
				cursor := n.view.Cursor
				h.nodesMu.RUnlock()
				go func(done chan struct{}, after int64) {
					defer close(done)
					resp, err := n.router.Open(child, "GET", "/events?after="+strconv.FormatInt(after, 10), nil, nil)
					if err != nil {
						return
					}
					defer resp.Body.Close()
					if resp.StatusCode == 200 {
						_ = eventstream.Consume(child, resp.Body, func(ev eventstream.Record) error { h.App.RemoteNodeChanged(); return child.Err() })
					}
				}(watchDone, cursor)
			}
		}
		if !status.Denied && (status.Route != "" || status.CacheEpoch != "") && (revision == 0 || revision != status.CacheRevision || epoch != status.CacheEpoch || previousRoute != status.Route || previousLevel != status.AccessLevel) {
			timeout, cancel := context.WithTimeout(ctx, 5*time.Second)
			resp, err := n.router.Open(timeout, "GET", "/overview", nil, nil)
			var view NodeOverview
			discard := false
			if err == nil {
				if resp.StatusCode == 200 {
					err = json.NewDecoder(resp.Body).Decode(&view)
				} else {
					discard = resp.StatusCode == 401 || resp.StatusCode == 403
					err = errors.New(resp.Status)
				}
				resp.Body.Close()
			}
			cancel()
			if discard || (status.Route == "lan" && status.CacheEpoch == "") {
				h.clearPeerCache(ctx, status.NodeID)
			}
			if err == nil && status.Route == "lan" && status.CacheEpoch != "" && view.Node.NodeID == status.NodeID && bytes.Equal(view.Node.PublicKey, status.PublicKey) {
				h.savePeerIndex(ctx, view, n.router.DirectGrant())
			}
			h.nodesMu.Lock()
			if discard {
				n.view = NodeOverview{}
			} else if err == nil && view.Node.NodeID == status.NodeID && bytes.Equal(view.Node.PublicKey, status.PublicKey) {
				n.view = view
				revision, epoch, previousRoute, previousLevel = status.CacheRevision, status.CacheEpoch, status.Route, status.AccessLevel
			}
			h.nodesMu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(4 * time.Second):
		}
	}
}
func closed(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}
func (h *Host) NodeStatus() []multinode.Status {
	h.nodesMu.RLock()
	defer h.nodesMu.RUnlock()
	status := make([]multinode.Status, 0, len(h.nodes))
	for _, node := range h.nodes {
		status = append(status, node.router.Status())
	}
	slices.SortFunc(status, func(a, b multinode.Status) int { return strings.Compare(a.NodeID, b.NodeID) })
	return status
}

func (h *Host) Nodes() []NodeView {
	h.nodesMu.RLock()
	defer h.nodesMu.RUnlock()
	out := make([]NodeView, 0, len(h.nodes))
	for _, n := range h.nodes {
		status := n.router.Status()
		if status.NodeID == "" {
			continue
		}
		v := n.view
		v.Node = status.NodeDescriptor
		out = append(out, NodeView{NodeOverview: v, Route: status.Route, RTT: status.RTT})
	}
	slices.SortFunc(out, func(a, b NodeView) int { return strings.Compare(a.Node.NodeID, b.Node.NodeID) })
	return out
}
func (h *Host) RouteNode(w http.ResponseWriter, r *http.Request) {
	h.nodesMu.RLock()
	n := h.nodes[r.PathValue("node")]
	h.nodesMu.RUnlock()
	if n == nil {
		http.NotFound(w, r)
		return
	}
	path := "/" + r.PathValue("route")
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 24<<20))
	if err != nil {
		http.Error(w, "request too large", 413)
		return
	}
	p.ProxyPeer(w, r, r.PathValue("route"), func(out *http.Request) (*http.Response, error) {
		return h.openNodeResource(out, n, path, body)
	})

}

func (h *Host) EventSources(ctx context.Context) map[string]eventstream.Source {
	sources := map[string]eventstream.Source{}
	h.nodesMu.RLock()
	defer h.nodesMu.RUnlock()
	for id, node := range h.nodes {
		status := node.router.Status()
		if status.Route == "" || !status.Online {
			continue
		}
		sources[id] = func(ctx context.Context, after int64, emit func(eventstream.Record) error) error {
			resp, err := node.router.Open(ctx, "GET", "/events?after="+strconv.FormatInt(after, 10), nil, nil)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				return errors.New(resp.Status)
			}
			return eventstream.Consume(ctx, resp.Body, emit)
		}
	}
	return sources
}
