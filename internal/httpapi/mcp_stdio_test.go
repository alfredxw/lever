package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestACPStdioBridgeReportsTransientHTTPErrorWithoutRetry(t *testing.T) {
	const token = "fixture-execution"
	server := mcp.NewServer(&mcp.Implementation{Name: "lever-fixture", Version: "1"}, nil)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true})
	var reject atomic.Bool
	var rejected atomic.Int32
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "missing execution capability", http.StatusUnauthorized)
			return
		}
		if reject.Load() {
			rejected.Add(1)
			http.Error(w, "fixture temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer host.Close()

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--mcp-stdio")
	cmd.Env = append(os.Environ(), "LEVER_MCP_URL="+host.URL+"/mcp", "LEVER_MCP_TOKEN="+token)
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-fixture", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	reject.Store(true)
	if _, err := session.ListTools(ctx, nil); err == nil || !strings.Contains(err.Error(), "Service Unavailable") || rejected.Load() != 1 {
		t.Fatalf("expected one attempt and a concrete transport error, got %d attempts (%v)", rejected.Load(), err)
	}
	reject.Store(false)
	if _, err := session.ListTools(ctx, nil); err != nil {
		t.Fatalf("transient error closed the stdio connection: %v", err)
	}
}
