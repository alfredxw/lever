package hub

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
	"lever/internal/eventstream"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

type ownerNode struct {
	key    deviceKey
	node   p.NodeDescriptor
	tunnel *yamux.Session
}

func (h *Hub) visibleOwners(ctx context.Context, a principal, space string) ([]ownerNode, error) {
	if space == "" {
		space = a.space
	}
	rows, err := h.db.QueryContext(ctx, `SELECT d.space_id,d.id,d.node,d.name,d.draining FROM devices d JOIN spaces s ON d.space_id=s.id JOIN memberships m ON (m.space_id,m.user_id)=(d.space_id,d.user_id) WHERE d.user_id=? AND s.kind='personal' AND d.revoked=0 AND d.role IN ('executor','workstation') AND (?='' OR d.space_id=?) ORDER BY d.name,d.id`, a.user, space, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ownerNode{}
	for rows.Next() {
		var owner ownerNode
		var raw, name string
		var draining bool
		if err = rows.Scan(&owner.key.space, &owner.key.device, &raw, &name, &draining); err != nil {
			return nil, err
		}
		if json.Unmarshal([]byte(raw), &owner.node) != nil || !owner.node.Supports(p.FeaturePeer) {
			continue
		}
		h.mu.Lock()
		if l := h.links[owner.key]; l != nil {
			owner.tunnel = l.tunnel
		}
		h.mu.Unlock()
		owner.node.Name = name
		owner.node.Draining = draining
		owner.node.Online = owner.tunnel != nil
		out = append(out, owner)
	}
	return out, rows.Err()
}

func ownerTransport(tunnel *yamux.Session) *http.Transport {
	return &http.Transport{DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second, DialContext: func(context.Context, string, string) (net.Conn, error) { return tunnel.Open() }}
}
func ownerRequest(ctx context.Context, a principal, route string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://owner/peer/v1/"+route, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Lever-Actor-User", a.user)
	req.Header.Set("X-Lever-Actor-Node", a.device)
	return req, nil
}
func (h *Hub) ownerView(ctx context.Context, a principal, owner ownerNode) (p.NodeOverview, error) {
	view := p.NodeOverview{Node: owner.node, Agents: []model.Agent{}, Chats: []model.Chat{}, Conversations: []model.Conversation{}}
	var err error
	if owner.tunnel != nil {
		req, e := ownerRequest(ctx, a, "overview")
		if e != nil {
			return view, e
		}
		client := http.Client{Transport: ownerTransport(owner.tunnel), CheckRedirect: p.Client.CheckRedirect, Timeout: 5 * time.Second}
		err = p.Exchange(&client, req, &view)
	} else if owner.node.CacheEpoch != "" {
		var raw []byte
		err = h.db.QueryRowContext(ctx, "SELECT data FROM node_hot_pages WHERE space_id=? AND device_id=? AND epoch=? AND path='overview'", owner.key.space, owner.key.device, owner.node.CacheEpoch).Scan(&raw)
		if err == nil {
			err = json.Unmarshal(raw, &view)
		} else if errors.Is(err, sql.ErrNoRows) {
			err = nil
		}
	}
	view.Node = owner.node
	return view, err
}

// Shared records can be submitted for local approval even when this controller
// has no permission to read the native overview. The task transaction checks
// those records again before storing a dispatch or source link.
func (h *Hub) taskOwnerView(ctx context.Context, a principal, space, device, kind, id string) (*p.NodeOverview, error) {
	var shared bool
	err := h.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM archive WHERE space_id=? AND device_id=? AND kind=? AND id=?)", space, device, kind, id).Scan(&shared)
	if err != nil || shared {
		return nil, err
	}
	owners, err := h.visibleOwners(ctx, a, space)
	if err != nil {
		return nil, err
	}
	for _, owner := range owners {
		if owner.key.device == device {
			view, err := h.ownerView(ctx, a, owner)
			if err != nil && owner.tunnel != nil {
				var remote *p.HTTPError
				if errors.As(err, &remote) {
					return nil, problem{remote.Status, remote.Message}
				}
				return nil, problem{503, "target device is unavailable"}
			}
			return &view, err
		}
	}
	return nil, nil
}
func (h *Hub) aggregate(w http.ResponseWriter, r *http.Request, a principal) error {
	w.Header().Set("Content-Type", "application/json")
	owners, err := h.visibleOwners(r.Context(), a, r.PathValue("space"))
	if err != nil {
		return err
	}
	views := make([]p.NodeOverview, len(owners))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for index, owner := range owners {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case limit <- struct{}{}:
			case <-r.Context().Done():
				return
			}
			defer func() { <-limit }()
			view, err := h.ownerView(r.Context(), a, owner)
			if err != nil {
				view = p.NodeOverview{Node: owner.node}
			}
			views[index] = view
		}()
	}
	wg.Wait()
	if r.URL.Path == "/api/nodes" {
		return json.NewEncoder(w).Encode(views)
	}
	nodes := make([]p.NodeDescriptor, 0, len(views))
	out := model.Overview{Agents: []model.Agent{}, Chats: []model.Chat{}, Conversations: []model.Conversation{}}
	for _, view := range views {
		nodes = append(nodes, view.Node)
		out.Agents = append(out.Agents, view.Agents...)
		out.Chats = append(out.Chats, view.Chats...)
		out.Conversations = append(out.Conversations, view.Conversations...)
	}
	return json.NewEncoder(w).Encode(struct {
		model.Overview
		Nodes []p.NodeDescriptor `json:"nodes"`
	}{out, nodes})
}
func (h *Hub) nodeEvents(w http.ResponseWriter, r *http.Request, a principal) error {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go h.watchPeerIdentity(ctx, cancel, a)
	eventstream.Merge(w, r.WithContext(ctx), "", func(ctx context.Context) map[string]eventstream.Source {
		out := map[string]eventstream.Source{}
		owners, _ := h.visibleOwners(ctx, a, r.PathValue("space"))
		for _, owner := range owners {
			if owner.tunnel == nil {
				continue
			}
			out[owner.key.device] = func(ctx context.Context, after int64, emit func(eventstream.Record) error) error {
				req, err := ownerRequest(ctx, a, "events?after="+strconv.FormatInt(after, 10))
				if err != nil {
					return err
				}
				response, err := ownerTransport(owner.tunnel).RoundTrip(req)
				if err != nil {
					return err
				}
				defer response.Body.Close()
				if response.StatusCode != 200 {
					return errors.New(response.Status)
				}
				return eventstream.Consume(ctx, response.Body, emit)
			}
		}
		return out
	})
	return nil
}
