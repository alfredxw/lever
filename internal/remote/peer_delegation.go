package remote

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/multinode"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func (q *peerRequest) delegate(w http.ResponseWriter, r *http.Request) (any, error) {
	var i p.Intent
	if err := peerBody(w, r, &i); err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(q.actor.device); err != nil || i.DeviceID != q.host.App.Store.DeviceID {
		return nil, os.ErrPermission
	}
	i.ActorUserID = q.actor.user
	i.OriginDeviceID = q.actor.device
	if d := i.Delegation; d != nil {
		if d.DeviceID != q.actor.device || d.Depth < 1 || d.Depth != len(d.Chain) || d.MaxDepth < d.Depth || d.MaxDepth > model.MaxDelegationHops || d.Chain[d.Depth-1] != d.DeviceID+":"+d.AgentID {
			return nil, &app.Error{Status: 400, Message: "invalid delegation chain"}
		}
		seen := map[string]bool{i.DeviceID + ":" + i.AgentID: true}
		for _, hop := range d.Chain {
			device, agent, ok := strings.Cut(hop, ":")
			_, de := uuid.Parse(device)
			_, ae := uuid.Parse(agent)
			if !ok || de != nil || ae != nil || seen[hop] {
				return nil, &app.Error{Status: 400, Message: "invalid or circular delegation"}
			}
			seen[hop] = true
		}
	}
	return q.apply(r, i)
}

func (q *peerRequest) run(_ http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	run, err := store.Get[model.Run](ctx, q.host.App.Store.DB, "SELECT data FROM runs WHERE id=?", id)
	if err != nil {
		return nil, err
	}
	peerRun(&run)
	requests, err := store.List[model.Request](ctx, q.host.App.Store.DB, "SELECT data FROM requests WHERE run_id=? AND status='pending' ORDER BY rowid", id)
	return p.PeerRun{Run: run, Requests: requests}, err
}

func (h *Host) delegationNode(scope *model.SharedScope, id string) (*multinode.Node, bool) {
	h.nodesMu.RLock()
	defer h.nodesMu.RUnlock()
	n := h.nodes[id]
	if n == nil || !n.router.Status().Supports(p.FeatureDelegate) {
		return nil, false
	}
	_, ok := n.router.DelegationScope(scope)
	return n.router, ok
}

// ReadRemoteRun returns handled=false for a pre-peer device, whose existing
// archive protocol remains usable during a rolling upgrade.
func (h *Host) ReadRemoteRun(ctx context.Context, scope model.SharedScope, nodeID, id string) (p.PeerRun, bool, error) {
	var out p.PeerRun
	node, ok := h.delegationNode(&scope, nodeID)
	if !ok {
		return out, false, nil
	}
	err := peerJSON(ctx, node, "GET", "/runs/"+url.PathEscape(id), nil, &out)
	return out, true, err
}
func peerJSON(ctx context.Context, node *multinode.Node, method, path string, in, out any) error {
	var body []byte
	var err error
	if in != nil {
		body, err = json.Marshal(in)
		if err != nil {
			return err
		}
	}
	resp, err := node.Open(ctx, method, path, body, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &p.HTTPError{Status: resp.StatusCode, Message: strings.TrimSpace(string(detail))}
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func targetSummary(a model.Agent) model.RemoteAgentTarget {
	avatar := ""
	if a.Avatar != nil && a.Avatar.Kind == "emoji" {
		avatar = a.Avatar.Value
	}
	return model.RemoteAgentTarget{AgentID: a.ID, Name: a.Name, Description: a.Profile.Description, Provider: a.Profile.Provider, Model: a.Profile.Model, PermissionMode: a.Profile.Permission, Avatar: avatar}
}

func (q *peerRequest) delegationTargets(_ http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	scope := q.actor.scope
	agents, err := store.List[model.Agent](ctx, q.host.App.Store.DB, "SELECT data FROM agents WHERE id IN (SELECT agent_id FROM peer_agents WHERE hub=? AND space=?) ORDER BY id", scope.HubID, scope.SpaceID)
	if err != nil {
		return nil, err
	}
	rows := []model.RemoteAgentTarget{}
	for _, a := range agents {
		if !a.Profile.CanAcceptDelegations() {
			continue
		}
		target := targetSummary(a)
		target.DefaultBusy, target.WorkingCopies = q.host.App.DelegationWorkspace(ctx, a)
		rows = append(rows, target)
	}
	return rows, nil
}

func identifyTargets(rows []model.RemoteAgentTarget, scope model.SharedScope, id, name string, online, draining bool) {
	for i := range rows {
		t := &rows[i]
		t.HubID, t.SpaceID, t.SpaceKind = scope.HubID, scope.SpaceID, "personal"
		t.DeviceID, t.DeviceName, t.Online, t.Draining = id, name, online, draining
	}
}
func (h *Host) nativeDelegationTargets(ctx context.Context, scope *model.SharedScope) ([]model.RemoteAgentTarget, map[string]bool) {
	type owner struct {
		router  *multinode.Node
		agents  []model.Agent
		binding model.SharedScope
		status  multinode.Status
	}
	var owners []owner
	handled := map[string]bool{}
	h.nodesMu.RLock()
	for _, n := range h.nodes {
		status := n.router.Status()
		binding, ok := n.router.DelegationScope(scope)
		if !ok || !status.Supports(p.FeatureDelegate) {
			continue
		}
		owners = append(owners, owner{n.router, n.view.Agents, binding, status})
		handled[status.NodeID] = true
	}
	h.nodesMu.RUnlock()
	out := []model.RemoteAgentTarget{}
	for _, n := range owners {
		var rows []model.RemoteAgentTarget
		if n.status.Online && n.status.Supports(p.FeatureDelegationTargets) {
			quick, cancel := context.WithTimeout(ctx, 3*time.Second)
			err := peerJSON(quick, n.router, http.MethodGet, "/delegation-targets", nil, &rows)
			cancel()
			if err != nil {
				continue
			}
		} else {
			for _, a := range n.agents {
				if a.Profile.CanAcceptDelegations() {
					rows = append(rows, targetSummary(a))
				}
			}
		}
		identifyTargets(rows, n.binding, n.status.NodeID, n.status.Name, n.status.Online, n.status.Draining)
		out = append(out, rows...)
	}
	return out, handled
}

// Manual reviews use the already authenticated Owner and retain the original
// command ID. An approval revalidates the controller and the current exposure.
func (q *peerRequest) reviewReceipt(ctx context.Context, id string, intent *p.Intent) (p.Receipt, error) {
	var stored p.Intent
	var raw, data string
	var receipt p.Receipt
	err := q.host.App.Store.DB.QueryRowContext(ctx, "SELECT intent,receipt FROM peer_delegation_reviews WHERE id=? AND json_extract(intent,'$.originDeviceId')=?", id, q.actor.device).Scan(&raw, &data)
	if err != nil {
		return receipt, err
	}
	if err = json.Unmarshal([]byte(raw), &stored); err != nil {
		return receipt, err
	}
	kind, target := "chat", stored.ChatID
	if target == "" {
		kind, target = "agent", stored.AgentID
	}
	if _, err = q.target(ctx, kind, target); err != nil {
		return receipt, err
	}
	if intent != nil {
		v := *intent
		v.ActorUserID = stored.ActorUserID
		if store.JSON(v) != raw {
			return receipt, &app.Error{Status: 409, Message: "command ID is bound to a different input"}
		}
	}
	err = json.Unmarshal([]byte(data), &receipt)
	return receipt, err
}
func (h *Host) reviewPeerDelegation(ctx context.Context, st p.ClientState, in Management) (p.Receipt, bool, error) {
	var item p.InboxItem
	var raw, itemJSON string
	err := h.App.Store.DB.QueryRowContext(ctx, "SELECT json_object('intent',json(intent),'receipt',json(receipt)),grant FROM peer_delegation_reviews WHERE id=? AND hub=? AND space=?", in.ID, in.Scope.HubID, in.Scope.SpaceID).Scan(&itemJSON, &raw)
	if err == nil {
		err = json.Unmarshal([]byte(itemJSON), &item)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return p.Receipt{}, false, nil
	}
	if err != nil || item.Receipt.Status != "pending" {
		return item.Receipt, true, err
	}
	i := item.Intent
	rec := p.Receipt{ID: i.ID, Status: "declined"}
	if in.Action == "accept" {
		actor := peerActor{scope: in.Scope, user: i.ActorUserID, device: i.OriginDeviceID}
		if err = json.Unmarshal([]byte(raw), &actor.lan); err != nil {
			return rec, true, err
		}
		if actor.lan == nil {
			var devices []p.Device
			if err = st.Do(ctx, "GET", st.SpacePath()+"/devices", nil, &devices); err != nil {
				return rec, true, err
			}
			if !slices.ContainsFunc(devices, func(d p.Device) bool { return d.ID == actor.device && !d.Revoked && d.Role.Controls() }) {
				return rec, true, os.ErrPermission
			}
		}
		policy, err := h.peerPolicy(ctx, actor)
		if err != nil || !policy.level.Allows(p.AccessChat) {
			return rec, true, os.ErrPermission
		}
		ok, err := h.delegationAllowed(ctx, in.Scope, i, true)
		if err != nil || !ok {
			return rec, true, os.ErrPermission
		}
		rec, err = h.App.ApplyPeer(ctx, in.Scope, i)
		if err != nil {
			return rec, true, err
		}
	}
	_, err = h.App.Store.DB.ExecContext(ctx, "UPDATE peer_delegation_reviews SET receipt=? WHERE id=?", store.JSON(rec), i.ID)
	return rec, true, err
}

func (q *peerRequest) sessionContext(_ http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	chat, err := q.target(r.Context(), "session", id)
	if err != nil {
		return nil, err
	}
	var anchor *app.ContextAnchor
	if value := r.URL.Query().Get("anchor"); value != "" {
		if err := json.Unmarshal([]byte(value), &anchor); err != nil {
			return nil, &app.Error{Status: 400, Message: "invalid message anchor"}
		}
	}
	return q.host.App.PeerSessionContext(r.Context(), chat, id, anchor, r.URL.Query().Get("direction"))
}
func (h *Host) ReadPeerContext(ctx context.Context, scope model.SharedScope, nodeID, session string, anchor *app.ContextAnchor, direction string) (app.ReadContextResult, bool, error) {
	var out app.ReadContextResult
	n, ok := h.delegationNode(&scope, nodeID)
	if !ok || !n.Status().Supports(p.FeatureChatControls) {
		return out, false, nil
	}
	params := url.Values{"direction": {direction}}
	if anchor != nil {
		params.Set("anchor", store.JSON(anchor))
	}
	err := peerJSON(ctx, n, "GET", "/sessions/"+url.PathEscape(session)+"/context?"+params.Encode(), nil, &out)
	return out, true, err
}
