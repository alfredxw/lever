package multinode

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	p "lever/internal/remoteproto"
)

type MobileTerminal struct{ loopbackSession }

type TerminalRequest struct {
	Node, Agent, SessionID, TerminalID, Root string
	Cols, Rows                               int
}

// Open binds the native WebSocket handshake to one paired owner and PTY.
// ProxyPeer forwards only the existing signed terminal route and its upgrade headers.
func (m *MobileTerminal) Open(dir *MobileDirectory, args TerminalRequest) (string, error) {
	n := dir.node(args.Node)
	if n == nil {
		return "", errors.New("设备未配对")
	}
	st := n.Status()
	if !st.Online {
		return "", errors.New("设备离线")
	}
	if !st.Supports(p.FeatureTerminal) {
		return "", errors.New("请升级电脑端 Lever 以使用终端")
	}
	if !st.AccessLevel.Allows(p.AccessAdmin) || st.ReadOnlyFS || st.Draining {
		return "", errors.New("终端需要可写的管理员权限")
	}
	if _, err := uuid.Parse(args.TerminalID); err != nil || args.Agent == "" || strings.ContainsAny(args.Agent, "/?#%\\") || strings.Contains(args.Agent, "..") {
		return "", errors.New("无效的终端参数")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	host, token := ln.Addr().String(), p.Token()
	route := "agents/" + args.Agent + "/terminal"
	query := url.Values{"start": {"1"}, "sessionId": {args.SessionID}, "root": {args.Root}, "terminalId": {args.TerminalID}, "cols": {strconv.Itoa(args.Cols)}, "rows": {strconv.Itoa(args.Rows)}}.Encode()
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	claimed := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		valid := !claimed && r.Method == "GET" && r.URL.Path == "/terminal" && r.Host == host && r.Header.Get("Origin") == "" && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(token)) == 1 && dir.node(args.Node) == n
		if valid {
			claimed = true
		}
		mu.Unlock()
		if !valid {
			http.Error(w, "invalid terminal handshake", 403)
			return
		}
		r.URL.RawQuery = query
		defer m.CloseHost(host)
		p.ProxyPeer(w, r, route, func(out *http.Request) (*http.Response, error) {
			return n.Open(out.Context(), "GET", "/"+route+"?"+query, nil, out.Header)
		})
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	m.serve(host, ln, server, cancel)
	time.AfterFunc(30*time.Second, func() {
		mu.Lock()
		defer mu.Unlock()
		if !claimed {
			claimed = true
			m.CloseHost(host)
		}
	})
	return "ws://" + host + "/terminal?token=" + token, nil
}
