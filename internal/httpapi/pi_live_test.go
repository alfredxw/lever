package httpapi_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func TestLivePiSteerAndLeverTools(t *testing.T) {
	binary := os.Getenv("LEVER_LIVE_PI_BIN")
	if binary == "" {
		t.Skip("set LEVER_LIVE_PI_BIN to an installed Pi; only a loopback model is used")
	}
	started, release := make(chan struct{}, 1), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := func(delta map[string]any, reason string) {
			var stop any
			if reason != "" {
				stop = reason
			}
			data, _ := json.Marshal(map[string]any{"id": "chatcmpl-local", "object": "chat.completion.chunk", "model": "parity", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": stop}}})
			fmt.Fprintf(w, "data: %s\n\n", data)
			w.(http.Flusher).Flush()
		}
		chunk(map[string]any{"role": "assistant"}, "")
		var request struct {
			Messages []struct {
				Role    string
				Content json.RawMessage
			}
		}
		if err := json.Unmarshal(body, &request); err != nil {
			t.Error(err)
			return
		}
		tool, steered := false, false
		for _, message := range request.Messages {
			tool = tool || message.Role == "tool" && strings.Contains(string(message.Content), `messages`)
			steered = steered || message.Role == "user" && strings.Contains(string(message.Content), "ORCHID-427")
		}
		if !tool && !steered {
			select {
			case started <- struct{}{}:
			default:
			}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_context", "type": "function", "function": map[string]any{"name": "mcp__lever__read_chat_context", "arguments": `{"target":"main"}`}}}}, "tool_calls")
		} else {
			chunk(map[string]any{"content": fmt.Sprintf("tool=%t steer=%t", tool, steered)}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	configDir := t.TempDir()
	data, _ := json.Marshal(map[string]any{"providers": map[string]any{"local-test": map[string]any{"baseUrl": server.URL + "/v1", "api": "openai-completions", "apiKey": "loopback-fixture", "models": []any{map[string]string{"id": "parity", "name": "Parity"}}}}})
	if err := os.WriteFile(filepath.Join(configDir, "models.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	f := openFixture(t, app.OpenServer).withLocalProviders()
	f.startLocalCLI()
	p := model.Provider{PluginID: "lever.pi", ContributionID: "pi", Type: "pi", Name: "Pi loopback", Command: binary, Args: []string{"--offline"}, Enabled: true, ConfigDir: configDir}
	f.request("POST", "/providers", p, 200, &p)
	agent := model.Agent{Name: "Pi loopback", Profile: model.Profile{Provider: p.ID, Model: "local-test/parity", Scope: model.Scope{PrimaryRootID: "root", Roots: []model.Root{{ID: "root", Path: f.root}}}}}
	f.request("POST", "/agents", agent, 200, &agent)
	chat := f.chat(agent)
	prior := f.wait(f.send(f.chat(f.agent("codex")).ID, "main", "", "context marker").ID, "completed")
	var first model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "Start the local test", References: []model.Reference{{Kind: "chat", Name: "Context", ID: prior.SessionID}}}, 200, &first)
	select {
	case <-started:
	case <-time.After(45 * time.Second):
		var got model.Run
		f.request("GET", "/runs/"+first.ID, nil, 200, &got)
		t.Fatalf("no model request: %s: %s", got.Status, got.Error)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		var got model.Run
		f.request("GET", "/runs/"+first.ID, nil, 200, &got)
		if got.CanSteer {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Pi was not steerable")
		}
	}
	var steer model.Run
	f.request("POST", "/messages", model.SendInput{ChatID: chat.ID, Operation: "main", CommandID: app.ID(), Delivery: "steer", Text: "ORCHID-427"}, 200, &steer)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		var taken bool
		if err := f.a.Store.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM runtime_commands WHERE run_id=? AND kind='steer' AND taken=1)", first.ID).Scan(&taken); err != nil {
			t.Fatal(err)
		}
		if taken {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Pi did not take the steer")
		}
	}
	close(release)
	f.wait(first.ID, "waiting_user")
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	if len(overview.Requests) != 1 || !strings.Contains(overview.Requests[0].Title, "read_chat_context") {
		t.Fatal("expected a Pi tool approval", overview.Requests)
	}
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	got := f.wait(first.ID, "completed")
	if !hasPauseTestOutput(got, "tool=true steer=true") {
		t.Fatalf("Pi did not apply both inputs: %+v", got.Items)
	}
	if got := f.wait(steer.ID, "steered"); got.Error != "" {
		t.Fatal(got.Error)
	}
}

func TestLivePiApprovalAndServiceTier(t *testing.T) {
	binary := os.Getenv("LEVER_LIVE_PI_BIN")
	if binary == "" {
		t.Skip("set LEVER_LIVE_PI_BIN; the model endpoint is a local test server")
	}
	for _, tc := range []struct {
		permission, tool  string
		ask, writes, fast bool
	}{
		{"ask", "write", true, false, false},
		{"accept_edits", "write", false, true, true},
		{"accept_edits", "bash", true, false, false},
		{"full_access", "write", false, true, false},
	} {
		t.Run(tc.permission+"_"+tc.tool, func(t *testing.T) {
			f := openFixture(t, app.OpenServer).withLocalProviders()
			f.startLocalCLI()
			args := `{"path":"effect.txt","content":"written"}`
			if tc.tool == "bash" {
				args = `{"command":"printf written > effect.txt"}`
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Tier     *string `json:"service_tier"`
					Messages []struct{ Role string }
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					return
				}
				if tc.fast && (request.Tier == nil || *request.Tier != "priority") || !tc.fast && request.Tier != nil {
					t.Error("unexpected service_tier on the wire", request.Tier)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				delta := map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "actual-tool", "type": "function", "function": map[string]any{"name": tc.tool, "arguments": args}}}}
				reason := "tool_calls"
				for _, message := range request.Messages {
					if message.Role == "tool" {
						delta, reason = map[string]any{"role": "assistant", "content": "done"}, "stop"
						break
					}
				}
				data, _ := json.Marshal(map[string]any{"id": "test", "object": "chat.completion.chunk", "model": "policy", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": reason}}})
				fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
			}))
			defer server.Close()
			home := t.TempDir()
			models, _ := json.Marshal(map[string]any{"providers": map[string]any{"local-test": map[string]any{"baseUrl": server.URL + "/v1", "api": "openai-completions", "apiKey": "loopback", "models": []any{map[string]string{"id": "policy", "name": "Policy"}}}}})
			if err := os.WriteFile(filepath.Join(home, "models.json"), models, 0600); err != nil {
				t.Fatal(err)
			}
			tiers := filepath.Join(home, "tiers.mjs")
			if err := os.WriteFile(tiers, []byte(`export default pi => pi.on('session_start', (_, ctx) => { for (const model of [ctx.model, ...ctx.modelRegistry.getAll()]) if (model?.provider === 'local-test') model.serviceTiers = [{id:'priority',name:'Fast'}]; });`), 0600); err != nil {
				t.Fatal(err)
			}
			p := model.Provider{PluginID: "lever.pi", ContributionID: "pi", Type: "pi", Name: "Pi policy", Command: binary, Enabled: true, Args: []string{"--offline", "--extension", tiers}, ConfigDir: home}
			f.request("POST", "/providers", p, 200, &p)
			agent := model.Agent{Name: "Pi policy", Profile: model.Profile{Provider: p.ID, Model: "local-test/policy", Scope: model.Scope{PrimaryRootID: "root", Roots: []model.Root{{ID: "root", Path: f.root}}}}}
			f.request("POST", "/agents", agent, 200, &agent)
			chat := f.chat(agent)
			var run model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "test tool policy", Selection: &model.Selection{Provider: p.ID, Model: agent.Profile.Model, Permission: tc.permission, Fast: tc.fast}}, 200, &run)
			t.Cleanup(func() {
				if t.Failed() {
					var state model.Run
					f.request("GET", "/runs/"+run.ID, nil, 200, &state)
					t.Logf("Pi run: %s %s %+v", state.Status, state.Error, state.Items)
				}
			})
			if tc.ask {
				f.wait(run.ID, "waiting_user")
				var overview model.Overview
				f.request("GET", "/overview", nil, 200, &overview)
				if len(overview.Requests) != 1 || overview.Requests[0].Title != "Allow "+tc.tool+"?" {
					t.Fatal(overview.Requests)
				}
				f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: false}, 200, nil)
			}
			f.wait(run.ID, "completed")
			data, err := os.ReadFile(filepath.Join(f.root, "effect.txt"))
			if tc.writes && (err != nil || string(data) != "written") || !tc.writes && !os.IsNotExist(err) {
				t.Fatalf("policy %s: file=%q, error=%v", tc.permission, data, err)
			}
		})
	}
}
