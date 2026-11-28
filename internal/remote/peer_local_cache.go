package remote

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"lever/internal/model"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func (h *Host) clearPeerCache(ctx context.Context, id string) {
	_, _ = h.App.Store.DB.ExecContext(ctx, "DELETE FROM peer_local_index WHERE node_id=?", id)
}

func (h *Host) savePeerIndex(ctx context.Context, view NodeOverview, grant string) {
	if grant == "" {
		return
	}
	view.Agents = slices.Clone(view.Agents)
	for i := range view.Agents {
		a := &view.Agents[i]
		a.Profile = model.Profile{Provider: a.Profile.Provider, Model: a.Profile.Model, Description: a.Profile.Description, AcceptDelegations: a.Profile.AcceptDelegations}
	}
	view.Node.Online = false
	_, _ = h.App.Store.DB.ExecContext(ctx, `INSERT INTO peer_local_index(node_id,epoch,data) SELECT node_id,?,? FROM remote_peers WHERE node_id=? AND grant=?
        ON CONFLICT(node_id) DO UPDATE SET epoch=excluded.epoch,data=excluded.data`, view.Node.CacheEpoch, store.JSON(view), view.Node.NodeID, grant)
}

func historyResource(path string) bool {
	parts := strings.Split(path, "/")
	return (len(parts) == 2 && parts[0] == "chats" || len(parts) == 3 && parts[0] == "sessions" && parts[2] == "runs") && parts[1] != ""
}

func (h *Host) openNodeResource(out *http.Request, n *connectedNode, path string, body []byte) (*http.Response, error) {
	st := n.router.Status()
	u, err := url.ParseRequestURI(path)
	if err != nil {
		return nil, err
	}
	route := strings.TrimPrefix(u.Path, "/")
	if out.Method != http.MethodGet || st.Denied || st.CacheEpoch == "" || (route != "overview" && !historyResource(route)) || n.router.DirectGrant() == "" {
		return n.router.Open(out.Context(), out.Method, path, body, out.Header)
	}
	resp, err := n.router.Open(out.Context(), out.Method, path, body, out.Header)
	if err == nil && resp.StatusCode == 200 {
		if st.Route != "lan" || route == "overview" || (u.Query().Get("before") != "" && u.Query().Get("before") != "0") || (u.Query().Get("limit") != "" && u.Query().Get("limit") != "40") {
			return resp, nil
		}
		raw, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		h.savePeerPage(out.Context(), st.NodeID, st.CacheEpoch, route, raw)
		return resp, nil
	}
	if resp != nil && (resp.StatusCode == 403 || resp.StatusCode == 401 || resp.StatusCode == 404) {
		if route == "overview" {
			h.clearPeerCache(out.Context(), st.NodeID)
		} else {
			_, _ = h.App.Store.DB.ExecContext(out.Context(), "DELETE FROM peer_local_pages WHERE node_id=? AND path=?", st.NodeID, route)
		}
		return resp, nil
	}
	// A reachable Owner is authoritative, even when it returns an error.
	// Cached pages can only replace a read from a verified offline route.
	if n.router.Status().Route != "" || (resp != nil && resp.StatusCode != 503) {
		return resp, err
	}
	var raw []byte
	var lookupErr error
	if route == "overview" {
		lookupErr = h.App.Store.DB.QueryRowContext(out.Context(), "SELECT data FROM peer_local_index WHERE node_id=? AND epoch=?", st.NodeID, st.CacheEpoch).Scan(&raw)
	} else {
		lookupErr = h.App.Store.DB.QueryRowContext(out.Context(), "SELECT data FROM peer_local_pages WHERE node_id=? AND epoch=? AND path=?", st.NodeID, st.CacheEpoch, route).Scan(&raw)
	}
	if errors.Is(lookupErr, sql.ErrNoRows) {
		return resp, err
	}
	if resp != nil {
		resp.Body.Close()
	}
	if lookupErr != nil {
		return nil, lookupErr
	}
	raw, err = p.SliceCachedPage(raw, route, u.Query())
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}, "X-Lever-Source": {"cache"}}, Body: io.NopCloser(bytes.NewReader(raw)), ContentLength: int64(len(raw))}, nil
}

func (h *Host) savePeerPage(ctx context.Context, node, epoch, route string, raw []byte) {
	var page any
	if strings.HasPrefix(route, "chats/") {
		var chat model.ChatView
		if json.Unmarshal(raw, &chat) != nil {
			return
		}
		for i := range chat.Runs {
			p.HotRun(&chat.Runs[i])
		}
		for i := range chat.Sessions {
			chat.Sessions[i].Scope = model.Scope{}
		}
		page = chat
	} else {
		var session struct {
			model.SessionRuns
			Requests []model.Request `json:"requests"`
		}
		if json.Unmarshal(raw, &session) != nil {
			return
		}
		for i := range session.Runs {
			p.HotRun(&session.Runs[i])
		}
		page = session
	}
	_, _ = h.App.Store.DB.ExecContext(ctx, `INSERT INTO peer_local_pages(node_id,path,epoch,data)
        SELECT node_id,?,epoch,? FROM peer_local_index WHERE node_id=? AND epoch=?
        ON CONFLICT(node_id,path) DO UPDATE SET epoch=excluded.epoch,data=excluded.data`, route, store.JSON(page), node, epoch)
}
