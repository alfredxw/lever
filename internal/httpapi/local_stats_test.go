package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func TestLocalStatsRoutes(t *testing.T) {
	tmp := t.TempDir()
	claudeDir := filepath.Join(tmp, "claude")
	codexDir := filepath.Join(tmp, "codex")
	geminiDir := filepath.Join(tmp, "gemini")
	piDir := filepath.Join(tmp, "pi")
	t.Setenv("CLAUDE_CONFIG_DIR", claudeDir)
	t.Setenv("CODEX_HOME", codexDir)
	t.Setenv("GEMINI_HOME", geminiDir)
	t.Setenv("PI_CODING_AGENT_DIR", piDir)

	if err := os.MkdirAll(filepath.Join(claudeDir, "projects", "p1"), 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second).Format(time.RFC3339)
	sample := `{"type":"assistant","timestamp":"` + now + `","sessionId":"http-s1","cwd":"/tmp/demo","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":500,"cache_read_input_tokens":2000,"cache_creation_input_tokens":100,"output_tokens":250}}}` + "\n"
	if err := os.WriteFile(filepath.Join(claudeDir, "projects", "p1", "http-s1.jsonl"), []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}

	a, err := app.Open(filepath.Join(tmp, "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	srv, err := New(a, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("ok")}})
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve()
	defer srv.Close(t.Context())

	doGet := func(path string, out any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+srv.Token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d", path, resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}

	var stats model.LocalStats
	doGet("/api/stats/local?period=7d&scope=all&tz=UTC&refresh=true", &stats)
	if stats.Totals.Total != 2850 {
		t.Fatalf("stats total = %d, want 2850", stats.Totals.Total)
	}
	if len(stats.Providers) != 1 || stats.Providers[0].ID != "claude" {
		t.Fatalf("unexpected providers: %+v", stats.Providers)
	}

	var sum model.LocalStatsQuickSummary
	doGet("/api/stats/local/summary?tz=UTC", &sum)
	if sum.Today.Tokens != 2850 || sum.Last7d.Tokens != 2850 {
		t.Fatalf("unexpected summary: %+v", sum)
	}
}
