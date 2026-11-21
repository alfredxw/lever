package httpapi_test

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/httpapi"
)

func TestDevelopmentFrontendKeepsAPIAndOriginBoundaries(t *testing.T) {
	frontend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("API credentials reached the frontend server")
		}
		fmt.Fprint(w, "Vite "+r.URL.RequestURI())
	}))
	defer frontend.Close()
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s, err := httpapi.New(a, "127.0.0.1:0", frontend.URL, fstest.MapFS{"index.html": {Data: []byte("built frontend")}})
	if err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	defer s.HTTP.Close()
	for _, tc := range []struct {
		name, path, origin, host, want string
		status                         int
	}{
		{"index", "/", s.URL, "", "Vite /", 200},
		{"module", "/src/App.tsx?t=123", s.URL, "", "Vite /src/App.tsx?t=123", 200},
		{"API stays authenticated", "/api/overview", s.URL, "", "local pairing link", 401},
		{"foreign origin", "/src/App.tsx", "https://untrusted.example", "", "Unexpected origin", 403},
		{"foreign host", "/src/App.tsx", s.URL, "untrusted.example", "Unexpected host", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", s.URL+tc.path, nil)
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("Cookie", "lever_session=invalid")
			req.Header.Set("Authorization", "Bearer invalid")
			if tc.host != "" {
				req.Host = tc.host
			}
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != tc.status || !strings.Contains(string(body), tc.want) {
				t.Fatalf("got %d %q; want %d containing %q", response.StatusCode, body, tc.status, tc.want)
			}
		})
	}
	// The same backend still handles authenticated requests through Vite's Host.
	u, _ := url.Parse(frontend.URL)
	req, _ := http.NewRequest("GET", s.URL+"/api/overview", nil)
	req.Host = u.Host
	req.Header.Set("Origin", frontend.URL)
	req.Header.Set("Authorization", "Bearer "+s.Token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("API did not reach the backend: %s", response.Status)
	}
}

func TestDevelopmentFrontendProxiesHMRUpgrade(t *testing.T) {
	frontend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		fmt.Fprint(rw, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		rw.Flush()
		line, err := rw.ReadString('\n')
		if err != nil {
			t.Error(err)
			return
		}
		fmt.Fprint(rw, "hmr:"+line)
		rw.Flush()
	}))
	defer frontend.Close()
	a, err := app.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	s, err := httpapi.New(a, "127.0.0.1:0", frontend.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	defer s.HTTP.Close()
	u, _ := url.Parse(s.URL)
	conn, err := net.DialTimeout("tcp", u.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	fmt.Fprintf(conn, "GET /?token=hmr HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", u.Host, s.URL)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 101 {
		t.Fatalf("upgrade failed: %s", response.Status)
	}
	fmt.Fprint(conn, "update\n")
	line, err := reader.ReadString('\n')
	if err != nil || line != "hmr:update\n" {
		t.Fatalf("upgrade is not bidirectional: %q, %v", line, err)
	}
}

func TestDevelopmentFrontendRejectsNonLoopbackOrigins(t *testing.T) {
	for _, origin := range []string{"https://127.0.0.1:5179", "http://example.com", "http://192.0.2.2:5179", "http://user@127.0.0.1:5179", "http://127.0.0.1:5179/path"} {
		if s, err := httpapi.New(&app.App{}, "127.0.0.1:0", origin, nil); err == nil {
			s.HTTP.Close()
			t.Fatalf("accepted invalid development origin %q", origin)
		}
	}
}
