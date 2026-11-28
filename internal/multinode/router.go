// Package multinode routes a resource to its owning device. UI requests never
// choose an address and cannot fall through to the local HTTP server.
package multinode

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"lever/internal/lanclient"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

type Target struct {
	Info     p.Device
	LAN, Hub *p.ClientState
}
type Status struct {
	Denied bool `json:"-"`
	p.NodeDescriptor
	Route string `json:"route"`
	RTT   int64  `json:"rttMs"`
}
type Node struct {
	probeMu              sync.Mutex
	lastRoute            string
	mu                   sync.RWMutex
	target               Target
	lan                  *lanclient.Client
	status               Status
	lastSwitch, lastSeen time.Time
	successes            int
}

func New(t Target, lan *lanclient.Client) *Node { return &Node{target: t, lan: lan} }
func (n *Node) Update(t Target)                 { n.mu.Lock(); n.target = t; n.mu.Unlock() }
func (n *Node) Status() Status                  { n.mu.RLock(); defer n.mu.RUnlock(); return n.status }

// Probe is called by the single supervisor for this node. Only a verified LAN
// identity can advance the recovery counter. The Hub directory supplies its
// independently authenticated descriptor and presence.
func (n *Node) DirectGrant() string {
	n.mu.RLock()
	defer n.mu.RUnlock()
	if n.target.LAN == nil {
		return ""
	}
	return n.target.LAN.DirectGrant
}
func (n *Node) Probe(ctx context.Context) {
	n.probeMu.Lock()
	defer n.probeMu.Unlock()
	n.mu.RLock()
	t := n.target
	n.mu.RUnlock()
	start := time.Now()
	var direct p.Device
	var directErr error
	st := t.LAN
	if st == nil {
		st = t.Hub
	}
	if st != nil {
		probe, cancel := context.WithTimeout(ctx, 2200*time.Millisecond)
		direct, directErr = n.lan.HostInfo(probe, *st, t.Info.ID)
		cancel()
	}
	lanTime := time.Since(start)
	hubOK := t.Hub != nil && t.Info.Online && t.Info.Node != nil && t.Info.Node.Supports(p.FeaturePeer)
	var hubRTT int64
	if hubOK && (direct.Node == nil || !direct.Node.Supports(p.FeaturePeer)) && t.Info.Node.Supports(p.FeatureHealth) {
		ping, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		timer := time.Now()
		var healthy bool
		err := t.Hub.Do(ping, "GET", t.Hub.SpacePath()+"/nodes/"+url.PathEscape(t.Info.ID)+"/health", nil, &healthy)
		cancel()
		hubOK = err == nil && healthy
		if hubOK {
			hubRTT = max(1, time.Since(timer).Milliseconds())
		}
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	now := time.Now()
	lanOK := direct.Node != nil && direct.Node.Supports(p.FeaturePeer) && bytes.Equal(direct.PublicKey, t.Info.PublicKey) && direct.ID == t.Info.ID
	if lanOK {
		n.successes++
	} else {
		n.successes = 0
	}
	route := ""
	var descriptor *p.NodeDescriptor
	if lanOK && (n.lastRoute != "hub" || !hubOK || n.successes >= 2 && now.Sub(n.lastSwitch) >= 30*time.Second) {
		route = "lan"
		descriptor = direct.Node
	} else if hubOK {
		route = "hub"
		descriptor = t.Info.Node
	}
	if route != "" {
		if n.lastRoute != route {
			n.lastRoute = route
			n.lastSwitch = now
		}
		n.lastSeen = now
		if hubRTT == 0 && route == "hub" && n.status.Route == "hub" {
			hubRTT = n.status.RTT
		}
		n.status = Status{NodeDescriptor: *descriptor, Route: route, RTT: hubRTT}
		if route == "lan" {
			n.status.RTT = max(1, lanTime.Milliseconds())
		}
		n.status.Online = true
		return
	}
	var response *p.HTTPError
	if errors.As(directErr, &response) && (response.Status == 401 || response.Status == 403) {
		n.status = Status{Denied: true, NodeDescriptor: p.NodeDescriptor{NodeID: t.Info.ID, Name: t.Info.Name, Platform: t.Info.Platform, PublicKey: t.Info.PublicKey}}
		return
	}
	if n.status.NodeID == "" {
		n.status.NodeDescriptor = p.NodeDescriptor{NodeID: t.Info.ID, PublicKey: t.Info.PublicKey, Name: t.Info.Name, Platform: t.Info.Platform}
		if t.Info.Node != nil {
			n.status.NodeDescriptor = *t.Info.Node
		}
	}
	// Keep the display stable during a short network transition. With no
	// verified route, writes are blocked immediately.
	n.status.Route = ""
	n.status.Online = now.Sub(n.lastSeen) < 12*time.Second
}

func (n *Node) Open(ctx context.Context, method, path string, body []byte, headers http.Header) (*http.Response, error) {
	u, err := url.ParseRequestURI(path)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, "/") || strings.ContainsAny(u.Path, "%\\") || strings.Contains(u.Path, "..") {
		return nil, errors.New("invalid peer resource")
	}
	n.mu.RLock()
	t, status := n.target, n.status
	n.mu.RUnlock()
	if !status.Supports(p.FeaturePeer) {
		return nil, &p.HTTPError{Status: 426, Message: "target device needs a Lever upgrade"}
	}
	if status.Route == "lan" {
		st := t.LAN
		if st == nil {
			st = t.Hub
		}
		if st != nil {
			resp, err := n.lan.OpenPeer(ctx, *st, t.Info.ID, method, "/peer/v1"+path, body, headers)
			if err == nil || ctx.Err() != nil {
				return resp, err
			}
			if t.Hub == nil || !t.Info.Online || t.Info.Node == nil || !t.Info.Node.Supports(p.FeaturePeer) {
				n.mu.Lock()
				n.status.Route = ""
				n.successes = 0
				n.mu.Unlock()
				return nil, err
			}
			n.mu.Lock()
			n.status.Route = "hub"
			n.lastRoute = "hub"
			n.lastSwitch = time.Now()
			n.successes = 0
			n.mu.Unlock()
			if method != http.MethodGet || headers.Get("Upgrade") != "" {
				return nil, err
			}
		}
	} else if status.Route != "hub" && !(method == http.MethodGet && t.Hub != nil && status.CacheEpoch != "" && (u.Path == "/overview" || strings.HasPrefix(u.Path, "/chats/") || strings.HasPrefix(u.Path, "/sessions/"))) {
		return nil, &p.HTTPError{Status: 503, Message: "target device is offline"}
	}
	if t.Hub == nil {
		return nil, &p.HTTPError{Status: 503, Message: "target device is offline"}
	}
	req, err := t.Hub.Request(ctx, method, t.Hub.SpacePath()+"/nodes/"+url.PathEscape(t.Info.ID)+path, body)
	if err != nil {
		return nil, err
	}
	p.CopyPeerRequest(req.Header, headers, u.Path)
	client := http.Client{CheckRedirect: p.Client.CheckRedirect}
	return client.Do(req)
}

// DelegationScope preserves a shared Chat's membership restriction and gives a
// device-only Chat a stable route even when its transport changes.
func (n *Node) DelegationScope(required *model.SharedScope) (model.SharedScope, bool) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	for _, st := range []*p.ClientState{n.target.Hub, n.target.LAN} {
		if st == nil {
			continue
		}
		scope := model.SharedScope{HubID: st.Membership.Hub.ID, SpaceID: st.Membership.SpaceID}
		if required == nil || *required == scope {
			return scope, true
		}
	}
	return model.SharedScope{}, false
}
