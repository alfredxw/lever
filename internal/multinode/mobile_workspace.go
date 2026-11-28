package multinode

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	p "lever/internal/remoteproto"
)

// MobileWorkspace serves the bundled workbench to the native web view. Each
// presentation gets its own loopback origin, one-use login and pinned Owner.
type MobileWorkspace struct{ loopbackSession }

type loopbackSession struct {
	mu   sync.Mutex
	stop func()
	host string
}

func (m *loopbackSession) Close() { m.closeHost("") }

// CloseHost accepts the loopback authority from a dismissed native view. A
// delayed dismissal of an old presentation must not close its replacement.
func (m *loopbackSession) CloseHost(host string) {
	if host != "" {
		m.closeHost(host)
	}
}
func (m *loopbackSession) closeHost(host string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stop != nil && (host == "" || host == m.host) {
		m.stop()
		m.stop = nil
		m.host = ""
	}
}
func (m *MobileWorkspace) Open(dir *MobileDirectory, assets fs.FS, id, agent, chat string) (string, error) {
	dir.mu.RLock()
	n := dir.nodes[id]
	dir.mu.RUnlock()
	if n == nil || !n.Status().Supports(p.FeaturePeer) {
		return "", errors.New("设备未配对或需要升级 Lever")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	host := listener.Addr().String()
	login, session := p.Token(), p.Token()
	const cookie = "lever_mobile_workspace"
	var loginMu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/pair", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Token string `json:"token"`
		}
		if r.Header.Get("Origin") != "http://"+host || json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil {
			http.Error(w, "invalid login", 403)
			return
		}
		loginMu.Lock()
		defer loginMu.Unlock()
		if login == "" || subtle.ConstantTimeCompare([]byte(login), []byte(in.Token)) != 1 {
			http.Error(w, "expired login", 403)
			return
		}
		login = ""
		http.SetCookie(w, &http.Cookie{Name: cookie, Value: session, Path: "/api/nodes/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "true")
	})
	mux.HandleFunc("/api/nodes/{node}/{route...}", func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookie)
		if err != nil || r.PathValue("node") != id || subtle.ConstantTimeCompare([]byte(c.Value), []byte(session)) != 1 {
			http.Error(w, "workspace session required", 403)
			return
		}
		dir.mu.RLock()
		current := dir.nodes[id]
		dir.mu.RUnlock()
		if current != n {
			http.Error(w, "device unpaired", 403)
			return
		}
		route := r.PathValue("route")
		path := "/" + route
		if r.URL.RawQuery != "" {
			path += "?" + r.URL.RawQuery
		}
		var data []byte
		if r.Method != "GET" {
			data, err = io.ReadAll(http.MaxBytesReader(w, r.Body, p.MaxPeerBody))
			if err != nil {
				http.Error(w, "request too large", 413)
				return
			}
		}
		p.ProxyPeer(w, r, route, func(out *http.Request) (*http.Response, error) {
			return n.Open(out.Context(), out.Method, path, data, out.Header)
		})
	})
	mux.Handle("GET /assets/", http.FileServerFS(assets))
	mux.HandleFunc("GET /workspace", func(w http.ResponseWriter, r *http.Request) {
		body, err := fs.ReadFile(assets, "hub.html")
		if err != nil {
			http.Error(w, "workbench unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(body)
	})
	ctx, cancel := context.WithCancel(context.Background())
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
		origin := r.Header.Get("Origin")
		if r.Host != host || origin != "" && origin != "http://"+host || r.Header.Get("Sec-Fetch-Site") == "cross-site" && strings.HasPrefix(r.URL.Path, "/api/") {
			http.Error(w, "invalid workspace origin", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})}
	m.serve(host, listener, server, cancel)
	link := url.URL{Scheme: "http", Host: host, Path: "/workspace", RawQuery: url.Values{"node": {id}, "agent": {agent}, "chat": {chat}}.Encode(), Fragment: "token=" + login}
	return link.String(), nil
}

func (m *loopbackSession) serve(host string, listener net.Listener, server *http.Server, cancel context.CancelFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stop != nil {
		m.stop()
	}
	m.host = host
	m.stop = func() { cancel(); _ = listener.Close(); _ = server.Close() }
	go func() { _ = server.Serve(listener) }()
}
