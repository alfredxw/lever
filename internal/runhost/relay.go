package runhost

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"net/http/httputil"
	"time"

	"lever/internal/localipc"
)

// The native client keeps one URL for the turn, even across backend port
// changes. Wait for its private socket before sending an MCP request. A call
// already delivered to a backend is never replayed by the relay.
func mcpRelay(dir, token string) (*http.Server, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			c, err := localipc.Dial(ctx, dir)
			if err == nil {
				return c, nil
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-ticker.C:
			}
		}
	}}
	proxy := &httputil.ReverseProxy{Transport: transport, Rewrite: func(r *httputil.ProxyRequest) {
		r.Out.URL.Scheme = "http"
		r.Out.URL.Host = "lever"
		r.Out.Host = "lever"
	}}
	server := &http.Server{Addr: l.Addr().String(), ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != l.Addr().String() || r.URL.Path != "/mcp" || r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "Invalid execution capability", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})}
	go server.Serve(l)
	return server, nil
}
