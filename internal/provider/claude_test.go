package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

func envMap(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, entry := range env {
		key, val, ok := strings.Cut(entry, "=")
		if ok {
			out[key] = val
		}
	}
	return out
}

func TestApplyClaudeEnvironmentSetsEntrypointAndStripsHostSession(t *testing.T) {
	configDir := t.TempDir()
	config := model.Provider{Type: "claude", ConfigDir: configDir}
	cmd := exec.Command("claude")
	cmd.Env = []string{
		"KEEP_ME=1",
		"CLAUDE_CODE_ENTRYPOINT=sdk-cli",
		"CLAUDECODE=1",
		"CLAUDE_CODE_SESSION_ID=host-session",
		"CLAUDE_CODE_CHILD_SESSION=1",
		"CLAUDE_CODE_MESSAGING_SOCKET=/tmp/host.sock",
		"CLAUDE_EFFORT=high",
		"CLAUDE_AGENT_SDK_VERSION=0.3.0",
	}
	if err := applyProfile(cmd, config); err != nil {
		t.Fatal(err)
	}
	got := envMap(cmd.Env)
	if got["CLAUDE_CODE_ENTRYPOINT"] != claudeEntrypoint {
		t.Fatalf("got entrypoint %q, want %q", got["CLAUDE_CODE_ENTRYPOINT"], claudeEntrypoint)
	}
	if got["KEEP_ME"] != "1" || got["CLAUDE_CONFIG_DIR"] != configDir {
		t.Fatalf("lost expected env vars: %v", got)
	}
	for _, stripped := range []string{
		"CLAUDECODE",
		"CLAUDE_CODE_SESSION_ID",
		"CLAUDE_CODE_CHILD_SESSION",
		"CLAUDE_CODE_MESSAGING_SOCKET",
		"CLAUDE_EFFORT",
		"CLAUDE_AGENT_SDK_VERSION",
	} {
		if _, exists := got[stripped]; exists {
			t.Fatalf("inherited host session variable %s was not stripped", stripped)
		}
	}

	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(`{"env":{"CLAUDE_CODE_ENTRYPOINT":"custom-client"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	cmd2 := exec.Command("claude")
	cmd2.Env = []string{"CLAUDE_CODE_ENTRYPOINT=sdk-cli"}
	if err := applyProfile(cmd2, config); err != nil {
		t.Fatal(err)
	}
	if got := envMap(cmd2.Env)["CLAUDE_CODE_ENTRYPOINT"]; got != "custom-client" {
		t.Fatalf("settings.json override not honored: got %q, want %q", got, "custom-client")
	}
}

func TestSharedClaudeIgnoresLeverEntrypoint(t *testing.T) {
	config := model.Provider{Type: "claude", ConfigDir: t.TempDir()}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("LOCALAPPDATA", t.TempDir())
	dir := filepath.Join(config.ConfigDir, "projects", "sample")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	cliID := "78b8440e-9c0c-4558-8909-2728d46764a8"
	leverID := "11111111-2222-4333-8444-555555555555"
	if err := os.WriteFile(filepath.Join(dir, cliID+".jsonl"), []byte(`{"type":"user","uuid":"u1","cwd":"/sample","entrypoint":"cli","message":{"content":"CLI chat"}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, leverID+".jsonl"), []byte(`{"type":"user","uuid":"u2","cwd":"/sample","entrypoint":"lever","message":{"content":"Lever chat"}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	rows, err := ListShared(t.Context(), config, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != cliID {
		t.Fatalf("expected only interactive cli session, got %+v", rows)
	}
}

func TestClaudeMCPRelaySwapsTurnsAndBlocksIdle(t *testing.T) {
	upstream := func(expectedToken, label string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/mcp" || r.Header.Get("Authorization") != "Bearer "+expectedToken {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(w, label)
		}))
	}
	s1 := upstream("turn-1-token", "turn-1")
	defer s1.Close()
	s2 := upstream("turn-2-token", "turn-2")
	defer s2.Close()

	assets := t.TempDir()
	relay, err := newClaudeMCPRelay(assets, s1.URL+"/mcp", "turn-1-token")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(relay.configPath)
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		MCPServers map[string]struct {
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	entry := cfg.MCPServers["lever"]
	call := func(auth string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, entry.URL, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	if code, _ := call("Bearer wrong"); code != http.StatusForbidden {
		t.Fatalf("expected 403 for wrong relay secret, got %d", code)
	}
	if code, body := call(entry.Headers["Authorization"]); code != http.StatusOK || body != "turn-1" {
		t.Fatalf("turn 1 relay failed: %d %q", code, body)
	}

	relay.clear()
	if code, _ := call(entry.Headers["Authorization"]); code != http.StatusUnauthorized {
		t.Fatalf("expected 401 while idle, got %d", code)
	}

	if err := relay.set(s2.URL+"/mcp", "turn-2-token"); err != nil {
		t.Fatal(err)
	}
	if code, body := call(entry.Headers["Authorization"]); code != http.StatusOK || body != "turn-2" {
		t.Fatalf("turn 2 relay failed: %d %q", code, body)
	}

	configPath := relay.configPath
	relay.close()
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatalf("expected relay config %s to be deleted on close", configPath)
	}
}

func startSleepingProcess(t *testing.T) *device.Process {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = device.Command("powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
	} else {
		cmd = device.Command("cat")
	}
	p, err := device.Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func TestClaudePoolEvictsIdleTimeoutAndLRU(t *testing.T) {
	origTimeout, origMax := claudeIdleTimeout, claudeMaxIdle
	t.Cleanup(func() {
		claudeIdleTimeout, claudeMaxIdle = origTimeout, origMax
	})

	t.Run("idle timeout", func(t *testing.T) {
		claudeIdleTimeout = 80 * time.Millisecond
		claudeMaxIdle = 4
		pool := &claudePool{entries: map[claudePoolKey]*claudeResident{}}
		r := &claudeResident{p: startSleepingProcess(t), nativeID: "n1"}
		pool.park("dir", "s1", r)
		if !pool.has("dir", "s1") {
			t.Fatal("expected resident entry right after park")
		}
		select {
		case <-r.p.Done:
		case <-time.After(2 * time.Second):
			t.Fatal("idle resident process was not closed after idle timeout")
		}
		if pool.has("dir", "s1") {
			t.Fatal("expired entry remained in pool")
		}
	})

	t.Run("lru cap", func(t *testing.T) {
		claudeIdleTimeout = time.Minute
		claudeMaxIdle = 2
		pool := &claudePool{entries: map[claudePoolKey]*claudeResident{}}
		defer pool.closeStateDir("dir")
		r1 := &claudeResident{p: startSleepingProcess(t), nativeID: "n1"}
		r2 := &claudeResident{p: startSleepingProcess(t), nativeID: "n2"}
		r3 := &claudeResident{p: startSleepingProcess(t), nativeID: "n3"}
		pool.park("dir", "s1", r1)
		time.Sleep(5 * time.Millisecond)
		pool.park("dir", "s2", r2)
		time.Sleep(5 * time.Millisecond)
		pool.park("dir", "s3", r3)
		if pool.has("dir", "s1") || !pool.has("dir", "s2") || !pool.has("dir", "s3") {
			t.Fatalf("unexpected LRU eviction state: s1=%t s2=%t s3=%t", pool.has("dir", "s1"), pool.has("dir", "s2"), pool.has("dir", "s3"))
		}
		select {
		case <-r1.p.Done:
		case <-time.After(2 * time.Second):
			t.Fatal("evicted resident process was not closed")
		}
	})
}
