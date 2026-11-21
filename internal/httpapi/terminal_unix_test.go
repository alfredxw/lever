//go:build !windows

package httpapi_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"lever/internal/app"
	"lever/internal/model"
)

func terminalSocket(t *testing.T, f *fixture, agent string) *websocket.Conn {
	t.Helper()
	conn := terminalConnect(t, f, agent, app.ID(), true)
	terminalReady(t, conn)
	return conn
}

func terminalReady(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.BinaryMessage {
			_ = conn.WriteJSON(map[string]string{"type": "ack"})
			continue
		}
		if strings.Contains(string(data), `"type":"ready"`) {
			return
		}
	}
}

func terminalConnect(t *testing.T, f *fixture, agent, id string, start bool) *websocket.Conn {
	t.Helper()
	t.Setenv("HISTFILE", "/dev/null")
	url := "ws" + strings.TrimPrefix(f.s.URL, "http") + "/api/agents/" + agent + "/terminal?cols=90&rows=30&terminalId=" + id
	if start {
		url += "&start=1"
	}
	header := http.Header{"Cookie": {"lever_session=" + f.s.Token}, "Origin": {f.s.URL}}
	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func terminalUntil(t *testing.T, conn *websocket.Conn, marker string) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var output strings.Builder
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("terminal stopped before %q: %v; output: %q", marker, err, output.String())
		}
		if kind == websocket.BinaryMessage {
			output.Write(data)
			if err := conn.WriteJSON(map[string]string{"type": "ack"}); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(output.String(), marker) {
				return output.String()
			}
		} else {
			var message struct{ Type, Message string }
			if err := json.Unmarshal(data, &message); err != nil || message.Type != "ready" && message.Type != "replay" && message.Type != "size" {
				t.Fatalf("unexpected control frame: %s (%v)", data, err)
			}
		}
	}
}

func terminalInput(t *testing.T, conn *websocket.Conn, input string) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte(input)); err != nil {
		t.Fatal(err)
	}
}

func TestProviderLoginTerminalUsesConfiguredAccount(t *testing.T) {
	f := newFixture(t)
	account := t.TempDir()
	t.Setenv("LEVER_FIXTURE_EXPECT_CONFIG_DIR", account)
	config := model.Provider{PluginID: "lever.claude", ContributionID: "claude", Type: "claude", Name: "Separate account", Enabled: true, ConfigDir: account}
	f.request("POST", "/providers", config, 200, &config)
	path := "/providers/" + config.ID + "/terminal/" + app.ID()
	url := "ws" + strings.TrimPrefix(f.s.URL, "http") + "/api" + path + "?cols=90&rows=30&start=1"
	header := http.Header{"Cookie": {"lever_session=" + f.s.Token}, "Origin": {f.s.URL}}
	conn, _, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, frame, err := conn.ReadMessage()
	_ = conn.Close()
	if err != nil || !strings.Contains(string(frame), `"type":"ended"`) {
		t.Fatalf("attaching to a login terminal must not launch a shell: %s (%v)", frame, err)
	}
	f.request("POST", path, nil, 200, nil)
	conn, _, err = websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	terminalUntil(t, conn, "fixture native login")
	f.request("DELETE", path, nil, 200, nil)
}

func TestTerminalInteractionAndExit(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	f := newFixture(t)
	agent := f.agent("codex")
	conn := terminalSocket(t, f, agent.ID)
	terminalInput(t, conn, "stty -echo; set +H; printf '\\nREADY\\n'\r")
	terminalUntil(t, conn, "\r\nREADY\r\n")
	terminalInput(t, conn, "printf '\\nCWD:'; pwd; stty size; test -t 0 && test -t 1 && printf 'TTY_OK\\n'\r")
	output := terminalUntil(t, conn, "TTY_OK")
	if !strings.Contains(output, f.root) || !strings.Contains(output, "30 90") {
		t.Fatalf("incorrect working directory or PTY size: %q", output)
	}
	if err := conn.WriteJSON(map[string]any{"type": "resize", "cols": 103, "rows": 37}); err != nil {
		t.Fatal(err)
	}
	terminalInput(t, conn, "stty size; printf 'RESIZED\\n'\r")
	if output := terminalUntil(t, conn, "RESIZED"); !strings.Contains(output, "37 103") {
		t.Fatalf("resize did not reach shell: %q", output)
	}
	terminalInput(t, conn, "sh -c 'echo FOREGROUND_READY; exec sleep 30'\r")
	terminalUntil(t, conn, "FOREGROUND_READY")
	terminalInput(t, conn, "\x03")
	terminalInput(t, conn, "printf 'INTERRUPTED\\n'\r")
	terminalUntil(t, conn, "INTERRUPTED")
	// More than the transport window, with multibyte output and an explicit
	// nonzero exit: final output must arrive before the exit control frame.
	terminalInput(t, conn, "i=0; while [ $i -lt 20000 ]; do printf '中文✓'; i=$((i+1)); done; printf '\\nFINAL_OUTPUT\\n'; exit 7\r")
	var all strings.Builder
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if kind == websocket.BinaryMessage {
			all.Write(data)
			_ = conn.WriteJSON(map[string]string{"type": "ack"})
			continue
		}
		var message struct {
			Type string
			Code int
		}
		if err := json.Unmarshal(data, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type != "exit" || message.Code != 7 || strings.Count(all.String(), "中文✓") != 20000 || !strings.Contains(all.String(), "FINAL_OUTPUT") {
			t.Fatalf("incomplete output or incorrect exit: %s, received %d bytes", data, all.Len())
		}
		break
	}
}

func TestTerminalCloseAndShutdownReleaseJobs(t *testing.T) {
	for _, mode := range []string{"foreground", "background", "exit", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("SHELL", "/bin/sh")
			f := newFixture(t)
			agent, id := f.agent("codex").ID, app.ID()
			conn := terminalConnect(t, f, agent, id, true)
			terminalReady(t, conn)
			terminalInput(t, conn, "stty -echo; set +H; printf '\\nREADY\\n'\r")
			terminalUntil(t, conn, "\r\nREADY\r\n")
			command := "sh -c 'printf \"CHILD:%s:END\\n\" $$; exec sleep 30'\r"
			if mode == "background" || mode == "exit" {
				command = "sleep 30 & printf 'CHILD:%s:END\\n' $!\r"
			}
			if mode == "exit" {
				command = strings.TrimSuffix(command, "\r") + "; exit 4\r"
			}
			terminalInput(t, conn, command)
			output := terminalUntil(t, conn, ":END")
			match := regexp.MustCompile(`CHILD:(\d+):END`).FindStringSubmatch(output)
			if match == nil {
				t.Fatalf("no child PID: %q", output)
			}
			pid, _ := strconv.Atoi(match[1])
			if mode == "shutdown" {
				done := make(chan struct{})
				go func() { f.a.Terminals.Close(); close(done) }()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("terminal shutdown hung")
				}
			} else if mode == "exit" {
				for {
					kind, data, err := conn.ReadMessage()
					if err != nil {
						t.Fatalf("shell exit left the terminal open: %v", err)
					}
					if kind == websocket.BinaryMessage {
						_ = conn.WriteJSON(map[string]string{"type": "ack"})
						continue
					}
					var message struct {
						Type string
						Code int
					}
					if json.Unmarshal(data, &message) != nil || message.Type != "exit" || message.Code != 4 {
						t.Fatalf("unexpected exit: %s", data)
					}
					break
				}
			} else {
				if mode == "background" {
					_ = conn.Close() // explicit close can terminate a detached shell as well
				}
				f.request("DELETE", "/agents/"+agent+"/terminal", map[string][]string{"ids": {id}}, 200, nil)
			}
			deadline := time.Now().Add(5 * time.Second)
			for {
				if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
					break
				}
				if time.Now().After(deadline) {
					state, _ := exec.Command("ps", "-o", "pid,ppid,pgid,stat,comm", "-p", strconv.Itoa(pid)).CombinedOutput()
					_ = syscall.Kill(pid, syscall.SIGKILL)
					t.Fatalf("terminal leaked %s job %d: %s", mode, pid, state)
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}

func TestTerminalReconnectRetainsShell(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	f := newFixture(t)
	agent, id := f.agent("codex").ID, app.ID()
	conn := terminalConnect(t, f, agent, id, true)
	terminalReady(t, conn)
	terminalInput(t, conn, "stty -echo; set +H; printf '\\nREADY\\n'\r")
	terminalUntil(t, conn, "READY\r\n")
	terminalInput(t, conn, "export LEVER_TEST_VALUE=kept; printf 'PID:%s:END\\n' $$; (sleep 0.3; printf 'WHILE_AWAY\\n') &\r")
	match := regexp.MustCompile(`PID:(\d+):END`).FindString(terminalUntil(t, conn, ":END"))
	if match == "" {
		t.Fatal("could not read shell PID")
	}
	_ = conn.Close()
	// A second Agent cannot attach even if it supplies the same terminal ID.
	foreign := terminalConnect(t, f, f.agent("codex").ID, id, false)
	_ = foreign.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, frame, err := foreign.ReadMessage()
	if err != nil || !strings.Contains(string(frame), `"type":"ended"`) {
		t.Fatalf("other Agent attached to the terminal: %s (%v)", frame, err)
	}
	time.Sleep(400 * time.Millisecond)
	reconnected := terminalConnect(t, f, agent, id, false)
	if output := terminalUntil(t, reconnected, "WHILE_AWAY"); !strings.Contains(output, match) {
		t.Fatalf("missing earlier output in replay: %q", output)
	}
	terminalReady(t, reconnected)
	terminalInput(t, reconnected, "printf '%s PID:%s:END\\n' \"$LEVER_TEST_VALUE\" $$\r")
	if output := terminalUntil(t, reconnected, ":END"); !strings.Contains(output, "kept "+match) {
		t.Fatalf("reattached to a different shell: %q", output)
	}
	f.request("DELETE", "/agents/"+agent+"/terminal", map[string][]string{"ids": {id}}, 200, nil)
	for _, start := range []bool{false, true} {
		closed := terminalConnect(t, f, agent, id, start)
		_ = closed.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, data, err := closed.ReadMessage()
		if err != nil || !strings.Contains(string(data), `"type":"ended"`) {
			t.Fatalf("closed session was reopened: %s (%v)", data, err)
		}
	}
}

func TestTerminalAuthenticationAndScope(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	base := "ws" + strings.TrimPrefix(f.s.URL, "http") + "/api/agents/"
	for _, test := range []struct {
		name, agent, query, origin, token string
		status                            int
	}{
		{"unauthenticated", agent.ID, "cols=80&rows=24", f.s.URL, "", 401},
		{"foreign origin", agent.ID, "cols=80&rows=24", "https://example.com", f.s.Token, 403},
		{"unknown agent", "missing", "cols=80&rows=24", f.s.URL, f.s.Token, 404},
		{"unknown root", agent.ID, "cols=80&rows=24&root=missing", f.s.URL, f.s.Token, 400},
		{"invalid size", agent.ID, "cols=99999&rows=24", f.s.URL, f.s.Token, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			conn, response, err := websocket.DefaultDialer.Dial(base+test.agent+"/terminal?terminalId=test&"+test.query,
				http.Header{"Origin": {test.origin}, "Cookie": {"lever_session=" + test.token}})
			if conn != nil {
				conn.Close()
			}
			if response != nil {
				defer response.Body.Close()
			}
			if err == nil || response == nil || response.StatusCode != test.status {
				t.Fatalf("upgrade should fail with %d, got %v (%v)", test.status, response, err)
			}
		})
	}
}
