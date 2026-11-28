package remoteproto

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"strings"
)

// CopyPeerRequest forwards only application headers and, on the PTY route,
// the standard WebSocket handshake. Authentication is supplied by each hop.
func CopyPeerRequest(dst, src http.Header, path string) {
	for _, key := range []string{"Content-Type", "Last-Event-ID", "Range"} {
		if value := src.Get(key); value != "" {
			dst.Set(key, value)
		}
	}
	if terminalRoute(path) && strings.EqualFold(src.Get("Upgrade"), "websocket") {
		dst.Set("Connection", "Upgrade")
		dst.Set("Upgrade", "websocket")
		dst.Set("Sec-WebSocket-Key", src.Get("Sec-WebSocket-Key"))
		dst.Set("Sec-WebSocket-Version", src.Get("Sec-WebSocket-Version"))
	}
}

func terminalRoute(path string) bool {
	path = strings.TrimPrefix(path, "/peer/v1/")
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	return len(parts) == 3 && parts[0] == "agents" && parts[1] != "" && parts[2] == "terminal"
}

type PeerRoundTrip func(*http.Request) (*http.Response, error)

func (f PeerRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// ProxyPeer streams an Owner response, including SSE flushes and authorized
// bidirectional PTY upgrades. Neither browser cookies nor peer response headers
// are allowed to cross transports unchanged.
func ProxyPeer(w http.ResponseWriter, r *http.Request, route string, transport PeerRoundTrip) {
	upgrade := r.Header.Get("Upgrade")
	socket := r.Method == "GET" && terminalRoute(route) && strings.EqualFold(upgrade, "websocket")
	if upgrade != "" && !socket {
		http.Error(w, "unsupported upgrade", 400)
		return
	}
	if route == "" || strings.ContainsAny(route, "\\%") || strings.Contains(route, "..") || strings.HasPrefix(route, "/") {
		http.Error(w, "invalid node resource", 400)
		return
	}
	proxy := httputil.ReverseProxy{Transport: transport, FlushInterval: -1, Rewrite: func(pr *httputil.ProxyRequest) {
		out := pr.Out
		out.URL.Scheme = "http"
		out.URL.Host = "owner"
		out.Host = "owner"
		out.URL.Path = "/peer/v1/" + route
		out.URL.RawPath = ""
		out.URL.RawQuery = r.URL.RawQuery
		out.Header = make(http.Header)
		CopyPeerRequest(out.Header, r.Header, route)
	}, ModifyResponse: func(resp *http.Response) error {
		safe := make(http.Header)
		if resp.StatusCode == http.StatusSwitchingProtocols {
			if !socket || !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
				return errors.New("invalid Owner protocol upgrade")
			}
			safe.Set("Connection", "Upgrade")
			safe.Set("Upgrade", "websocket")
			safe.Set("Sec-WebSocket-Accept", resp.Header.Get("Sec-WebSocket-Accept"))
		} else {
			parts := strings.Split(route, "/")
			asset := len(parts) == 3 && (((parts[0] == "runs" || parts[0] == "attachments") && parts[2] == "preview") || (parts[0] == "agents" && parts[2] == "file"))
			copyPeerHeaders(safe, resp.Header, asset)
			// ReverseProxy appends headers. Replace the outer application's page
			// policy with the gateway's document sandbox before copying them.
			for key := range safe {
				w.Header().Del(key)
			}
		}
		resp.Header = safe
		resp.Trailer = nil
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
		var he *HTTPError
		if errors.As(err, &he) {
			http.Error(w, he.Message, he.Status)
			return
		}
		http.Error(w, "connection to target device interrupted", 502)
	}}
	proxy.ServeHTTP(w, r)
}
