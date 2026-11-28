package remote

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

func (h *Host) maintainTunnel(ctx context.Context, st p.ClientState, link string) {
	for delay := time.Second; ctx.Err() == nil; delay = min(delay*2, 30*time.Second) {
		h.runTunnel(ctx, st, link)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func (h *Host) runTunnel(ctx context.Context, st p.ClientState, link string) {
	req, err := st.Request(ctx, "GET", "/ws/tunnel?link="+url.QueryEscape(link), nil)
	if err != nil {
		return
	}
	dial, cancel := context.WithTimeout(ctx, 10*time.Second)
	ws, _, err := websocket.Dial(dial, req.URL.String(), &websocket.DialOptions{HTTPHeader: req.Header, HTTPClient: &http.Client{CheckRedirect: p.Client.CheckRedirect}})
	cancel()
	if err != nil {
		return
	}
	defer ws.CloseNow()
	conn := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	session, err := yamux.Server(conn, nil)
	if err != nil {
		return
	}
	defer session.Close()
	scope := model.SharedScope{HubID: st.Membership.Hub.ID, SpaceID: st.Membership.SpaceID}
	server := http.Server{ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Lever-Actor-User") != st.Membership.UserID {
			http.Error(w, "owner required", 403)
			return
		}
		h.servePeer(w, r, peerActor{scope: scope, user: st.Membership.UserID, device: r.Header.Get("X-Lever-Actor-Node"), draining: r.Header.Get("X-Lever-Draining") == "1"})
	})}
	defer server.Close()
	_ = server.Serve(session)
}
