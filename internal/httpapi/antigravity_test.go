package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/provider"
)

func TestAntigravityTokenRecovery(t *testing.T) {
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", t.TempDir())
	t.Setenv("GEMINI_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	f := newFixture(t)
	config := model.Provider{ID: "antigravity", Name: "Antigravity"}
	agent := f.acpAgent(config)
	for _, test := range []struct {
		name, status, failure string
		prompts               int
	}{
		{"once", "completed", "", 2},
		{"persistent", "failed", "agy acp --login", 2},
		{"login", "failed", "agy acp --login", 1},
		{"pending", "failed", "agy acp --login", 1},
		{"forbidden", "failed", "PERMISSION_DENIED (HTTP 403)", 1},
		{"text", "completed", "", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			chat := f.chat(agent)
			file := f.upload(chat.ID, "original.txt", []byte("original attachment"))
			text := "[agy-token-" + test.name + "] original request mentioning UNAUTHENTICATED (code 401):"
			var sent model.Run
			f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: text, AttachmentIDs: []string{file.ID}}, 200, &sent)
			run := f.wait(sent.ID, test.status)
			if (test.failure == "" && run.Error != "") || !strings.Contains(run.Error, test.failure) || strings.Contains(run.Error, "private-fixture-detail") {
				t.Fatalf("unexpected run error: %s", run.Error)
			}
			type receipt struct {
				Native, Input  string
				PID, Resources int
				History        []string
			}
			var replies []receipt
			tools := 0
			for _, item := range run.Items {
				if item.Kind == "tool" && item.Status == "completed" {
					tools++
				}
				if item.Kind == "text" {
					var reply receipt
					if err := json.Unmarshal([]byte(item.Text), &reply); err != nil {
						t.Fatal("unexpected transcript replay or overwritten output", err)
					}
					replies = append(replies, reply)
				}
			}
			if len(replies) != test.prompts || tools != test.prompts || !strings.Contains(replies[0].Input, text) || replies[0].Resources != 1 {
				t.Fatalf("got %d prompts, %d tools; expected %d original/continuation receipts", len(replies), tools, test.prompts)
			}
			if len(replies) == 2 {
				first, next := replies[0], replies[1]
				if first.Native == "" || first.Native != next.Native || first.PID == 0 || first.PID == next.PID || next.Resources != 0 ||
					strings.Contains(next.Input, "original") || !strings.Contains(next.Input, agent.Profile.Instructions) || !strings.Contains(next.Input, "Do not repeat completed actions") || !slices.Equal(next.History, []string{first.Input, next.Input}) {
					t.Fatal("did not continue the saved conversation in a fresh process without resending the original input")
				}
			}
		})
	}
	cmd, err := provider.LoginCommand(t.Context(), model.Provider{PluginID: "lever.antigravity", Type: "antigravity", Command: "agy"})
	if err != nil || !slices.Equal(cmd.Args[1:], []string{"acp", "--login"}) {
		t.Fatalf("wrong native ACP login command: %v, %v", cmd, err)
	}
}

func TestAntigravityAutomaticallyDetectsAndReusesNativeCLI(t *testing.T) {
	f := newFixture(t)
	nativeConfig := t.TempDir()
	geminiHome := t.TempDir()
	t.Setenv("ANTIGRAVITY_CLI_CONFIG_DIR", nativeConfig)
	t.Setenv("GEMINI_HOME", geminiHome)
	t.Setenv("GEMINI_API_KEY", "native-user-configuration")
	t.Setenv("AGY_ACP_FORCE_FILE_STORAGE", "")
	cliDir := filepath.Join(geminiHome, "antigravity-cli")
	if err := os.MkdirAll(cliDir, 0700); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(cliDir, "settings.json")
	original := []byte(`{"model":"user-default","toolPermission":"strict","permissions":{"deny":["command(fixture)"]}}`)
	if err := os.WriteFile(settings, original, 0600); err != nil {
		t.Fatal(err)
	}
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	index := slices.IndexFunc(providers, func(p model.ProviderInfo) bool { return p.ID == "antigravity" })
	if index < 0 {
		t.Fatal("local Antigravity was not registered automatically")
	}
	config := providers[index]
	if !config.Installed || config.Command != "agy" || config.Auth != "cli" || !config.Capabilities.MCP {
		t.Fatal(config)
	}
	// The native fixture rejects authenticate: only initialize and session/new
	// may be needed to discover an already signed-in CLI's models.
	var catalog model.Catalog
	f.request("GET", "/providers/antigravity/models", nil, 200, &catalog)
	if catalog.Version != "1.5.1" || len(catalog.Models) != 2 {
		t.Fatal(catalog)
	}
	var ids []string
	for _, option := range catalog.Permissions {
		ids = append(ids, option.ID)
		if !option.NextTurnOnly {
			t.Fatal("native CLI preset must start a new turn", option)
		}
	}
	if !slices.Equal(ids, []string{"request-review", "default", "auto", "turbo"}) || catalog.Permissions[3].Mode != "full_access" {
		t.Fatal("native CLI catalog differs from the Antigravity presets", catalog.Permissions)
	}
	chat := f.chat(f.acpAgent(config.Provider))
	f.request("DELETE", "/providers/antigravity", nil, 409, nil)
	first := f.wait(f.send(chat.ID, "main", "", "native CLI marker").ID, "completed")
	receipt := acpReceipt(t, first)
	if receipt["profile"] != geminiHome || receipt["nativeConfigDir"] != nativeConfig || receipt["ambientKey"] != "native-user-configuration" || receipt["fileStorage"] != "" {
		t.Fatal("native CLI configuration was replaced", receipt)
	}
	servers, _ := receipt["servers"].([]any)
	if len(servers) != 1 || servers[0].(map[string]any)["type"] != "http" {
		t.Fatal("native agy did not negotiate HTTP MCP")
	}
	second := f.wait(f.send(chat.ID, "main", "", "continue native CLI marker").ID, "completed")
	if acpReceipt(t, second)["native"] != receipt["native"] {
		t.Fatal("native CLI did not resume its original session")
	}
	_, results, _ := historyTurn(f, chat.ID, "main", historyCall{Name: "find_chat_context", Arguments: map[string]any{"query": first.Input}})
	if results[0].Error != "" || len(results[0].Body.Matches) == 0 {
		t.Fatalf("native agy could not search earlier dialogue: %+v", results)
	}
	// Each preset must replace the resumed mode and leave the native history intact.
	sendWithPermission := func(permission string) map[string]any {
		t.Helper()
		var run model.Run
		f.request("POST", "/messages", model.SendInput{
			CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "check native permissions",
			Selection: &model.Selection{Provider: config.ID, Permission: permission},
		}, 200, &run)
		if run.Selection.Permission != permission {
			t.Fatal("permission was not saved", run.Selection)
		}
		return acpReceipt(t, f.wait(run.ID, "completed"))
	}
	for _, test := range []struct {
		id, mode, toolPermission string
		sandbox                  bool
	}{
		{"request-review", "default", "request-review", false},
		{"default", "default", "proceed-in-sandbox", true},
		{"auto", "auto", "request-review", true},
		{"turbo", "default", "always-proceed", false},
	} {
		result := sendWithPermission(test.id)
		preset, _ := result["presetSettings"].(map[string]any)
		args, _ := json.Marshal(result["args"])
		if result["native"] != receipt["native"] || result["mode"] != test.mode ||
			preset["toolPermission"] != test.toolPermission || preset["enableTerminalSandbox"] != test.sandbox ||
			preset["model"] != "user-default" || preset["permissions"] == nil ||
			strings.Contains(string(args), "--dangerously-skip-permissions") != (test.id == "turbo") {
			t.Fatalf("wrong native settings for %s: %+v", test.id, result)
		}
	}
	plan := sendWithPermission("plan")
	args, _ := json.Marshal(plan["args"])
	if plan["native"] != receipt["native"] || plan["mode"] != "plan" || string(args) != `["acp","--process-per-session"]` {
		t.Fatal("leaving Turbo did not restore native permissions", plan)
	}
	if data, err := os.ReadFile(settings); err != nil || string(data) != string(original) {
		t.Fatal("user settings changed", err)
	}
	if overrides, err := filepath.Glob(filepath.Join(cliDir, ".lever-permissions-*")); err != nil || len(overrides) != 0 {
		t.Fatal("per-turn permission settings survived cleanup", overrides, err)
	}
	if _, err := os.Stat(filepath.Join(f.a.Store.Dir, "providers", "antigravity")); !os.IsNotExist(err) {
		t.Fatal("native CLI was given a private login profile", err)
	}
	config.Enabled = false
	f.request("POST", "/providers", config.Provider, 200, nil)
	restartProviderFixture(t, f)
	f.request("GET", "/providers", nil, 200, &providers)
	index = slices.IndexFunc(providers, func(p model.ProviderInfo) bool { return p.ID == "antigravity" })
	if index < 0 || providers[index].Enabled {
		t.Fatal("automatic detection overwrote the disabled setting", providers)
	}
}

func TestAntigravityFallsBackWhenProcessPerSessionIsUnknown(t *testing.T) {
	t.Setenv("LEVER_FIXTURE_AGY_LEGACY_ACP", "1")
	f := newFixture(t)
	chat := f.chat(f.acpAgent(model.Provider{ID: "antigravity", Name: "Legacy agy"}))
	first := f.wait(f.send(chat.ID, "main", "", "Legacy agy context marker").ID, "completed")
	receipt := acpReceipt(t, first)
	args, _ := json.Marshal(receipt["args"])
	servers, _ := receipt["servers"].([]any)
	if string(args) != `["acp"]` || len(servers) != 1 || servers[0].(map[string]any)["command"] == nil {
		t.Fatal("legacy agy did not retry initialization with stdio MCP")
	}
	_, results, _ := historyTurn(f, chat.ID, "main", historyCall{Name: "find_chat_context", Arguments: map[string]any{"query": first.Input}})
	if results[0].Error != "" || len(results[0].Body.Matches) == 0 {
		t.Fatalf("legacy agy could not search earlier dialogue: %+v", results)
	}
}

func TestAntigravityKeepsDefaultRuntimeWhenCLIIsMissing(t *testing.T) {
	f := newFixture(t)
	t.Setenv("LEVER_ANTIGRAVITY_PATH", filepath.Join(t.TempDir(), "missing-agy"))
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	index := slices.IndexFunc(providers, func(p model.ProviderInfo) bool { return p.ID == "antigravity" })
	if index < 0 || providers[index].Installed || providers[index].Auth != "cli" || providers[index].Error == "" {
		t.Fatal(providers)
	}
}

func (f *fixture) antigravityProvider(name string) model.Provider {
	command := "agy_acp_server.par"
	if runtime.GOOS == "windows" {
		command = "agy_acp_server.exe"
	}
	config := model.Provider{PluginID: "lever.antigravity", ContributionID: "antigravity", Type: "antigravity", Name: name, Command: filepath.Join(filepath.Dir(os.Getenv("LEVER_CODEX_PATH")), command), Enabled: true, Args: []string{}}
	f.request("POST", "/providers", config, 200, &config)
	return config
}

func (f *fixture) waitSetup(id string, phases ...string) model.ProviderSetup {
	f.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var state model.ProviderSetup
		f.request("GET", "/providers/"+id+"/setup", nil, 200, &state)
		if slices.Contains(phases, state.Phase) && (state.Phase != "signing_in" || state.URL != "") {
			return state
		}
		if state.Phase == "failed" {
			f.t.Fatal("setup failed:", state.Error)
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.t.Fatal("runtime setup did not reach", phases)
	return model.ProviderSetup{}
}

func (f *fixture) signInAntigravity(config model.Provider) {
	f.t.Helper()
	f.request("POST", "/providers/"+config.ID+"/setup", map[string]string{"action": "signin"}, 200, nil)
	state := f.waitSetup(config.ID, "signing_in")
	link, err := url.Parse(state.URL)
	if err != nil || link.Host != "accounts.google.com" {
		f.t.Fatal(state)
	}
	// Finish only the fixture's loopback callback; no Google request is made.
	callback, err := url.Parse(link.Query().Get("redirect_uri"))
	if err != nil || callback.Hostname() != "127.0.0.1" {
		f.t.Fatal(state)
	}
	callback.RawQuery = "state=fixture&code=fixture"
	response, err := http.Get(callback.String())
	if err != nil {
		f.t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		f.t.Fatal(response.Status)
	}
	state = f.waitSetup(config.ID, "authenticated")
	if state.URL != "" {
		f.t.Fatal("authorization URL retained after sign-in")
	}
}

func TestAntigravitySignInModelsAndNativeResume(t *testing.T) {
	f := newFixture(t)
	t.Setenv("GEMINI_API_KEY", "ambient-must-not-override-account")
	config := f.antigravityProvider("Google account")
	// Discovery never launches a browser or leaks an OAuth URL through an error.
	var failure map[string]string
	f.request("GET", "/providers/"+config.ID+"/models", nil, 500, &failure)
	if !strings.Contains(failure["error"], "Sign in to Antigravity") || strings.Contains(failure["error"], "accounts.google.com") {
		t.Fatal(failure)
	}
	f.signInAntigravity(config)
	var catalog model.Catalog
	f.request("GET", "/providers/"+config.ID+"/models", nil, 200, &catalog)
	if catalog.Provider != config.ID || catalog.Version != "1.4.5" || len(catalog.Models) != 2 || catalog.Capabilities.Steering || !catalog.Capabilities.Resume {
		t.Fatal(catalog)
	}
	if !slices.Equal(catalog.Models[0].Efforts, []string{"balanced", "deep"}) || !slices.Equal(catalog.Models[1].Efforts, []string{"high", "ultra"}) {
		t.Fatal("model-specific efforts lost", catalog.Models)
	}
	chat := f.chat(f.acpAgent(config))
	input := model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "remember antigravity-marker", Selection: &model.Selection{Provider: config.ID, Model: "acp-other", Effort: "ultra", Permission: "build-mode"}}
	var first model.Run
	f.request("POST", "/messages", input, 200, &first)
	first = f.wait(first.ID, "completed")
	receipt := acpReceipt(t, first)
	if receipt["effort"] != "ultra" || receipt["ambientKey"] != "" || receipt["fileStorage"] != "1" {
		t.Fatal(receipt)
	}
	meta := receipt["meta"].(map[string]any)["antigravity"].(map[string]any)
	if meta["disabledTools"].([]any)[0] != "run_workflow" {
		t.Fatal(meta)
	}
	second := f.wait(f.send(chat.ID, "main", "", "continue antigravity-marker").ID, "completed")
	resumed := acpReceipt(t, second)
	wire, _ := json.Marshal(second)
	if resumed["native"] != receipt["native"] || len(resumed["history"].([]any)) != 2 || strings.Contains(string(wire), "REPLAY MUST NOT APPEAR") {
		t.Fatal("native resume changed", second)
	}
	// A second provider cannot reuse the first provider's saved Google account.
	other := f.antigravityProvider("Another Google account")
	f.request("GET", "/providers/"+other.ID+"/models", nil, 500, &failure)
	if !strings.Contains(failure["error"], "Sign in to Antigravity") {
		t.Fatal(failure)
	}
	f.request("POST", "/providers/"+config.ID+"/setup", map[string]string{"action": "unknown"}, 400, nil)
	input.CommandID, input.Selection.Fast = app.ID(), true
	f.request("POST", "/messages", input, 400, nil)
}

func TestAntigravitySetupCancellationAndDisable(t *testing.T) {
	f := newFixture(t)
	config := f.antigravityProvider("Cancel sign-in")
	for _, disable := range []bool{false, true} {
		f.request("POST", "/providers/"+config.ID+"/setup", map[string]string{"action": "signin"}, 200, nil)
		f.waitSetup(config.ID, "signing_in")
		f.request("POST", "/providers/"+config.ID+"/setup", map[string]string{"action": "signin"}, 409, nil)
		if disable {
			config.Enabled = false
			f.request("POST", "/providers", config, 200, &config)
		} else {
			f.request("POST", "/providers/"+config.ID+"/setup", map[string]string{"action": "cancel"}, 200, nil)
		}
		state := f.waitSetup(config.ID, "cancelled")
		if state.URL != "" {
			t.Fatal("cancelled sign-in retained its URL")
		}
	}
}
