package httpapi_test

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"lever/internal/model"
	"lever/internal/provider"
)

func TestProviderLaunchSettingsReachNativeProcesses(t *testing.T) {
	f := newFixture(t)
	const arg = "--fixture-with=a b"
	t.Setenv("LEVER_FIXTURE_LAUNCH_ARGUMENT", arg)
	for _, kind := range []string{"codex", "claude", "pi"} {
		config := model.Provider{Type: kind, PluginID: "lever." + kind, ContributionID: kind, Name: kind + " settings", Enabled: true, Args: []string{arg}}
		if kind == "claude" {
			config.AutoCompactWindow = 300000
			config.IdleCompaction = "beforeCacheExpires"
		}
		f.request("POST", "/providers", config, 200, &config)
		var catalog model.Catalog
		f.request("GET", "/providers/"+config.ID+"/models", nil, 200, &catalog)
		if len(catalog.Models) == 0 || catalog.Provisional {
			t.Fatal(kind, "did not discover the configured CLI")
		}
		var agent model.Agent
		f.request("POST", "/agents", model.Agent{Name: kind, Profile: model.Profile{Provider: config.ID, Scope: model.Scope{Roots: []model.Root{{Path: f.root}}}}}, 200, &agent)
		chat := f.chat(agent)
		f.wait(f.send(chat.ID, "main", "", "verify launch settings").ID, "completed")
	}
}

func TestManagedAntigravityKeyIsWriteOnlyAndReachesACP(t *testing.T) {
	f := newFixture(t)
	config := f.antigravityProvider("key account")
	config.ID, config.AuthMethod = "", "gemini-api-key"
	const secret = "fixture-gemini-key"
	input := struct {
		model.Provider
		APIKey string `json:"apiKey"`
	}{config, secret}
	var raw json.RawMessage
	f.request("POST", "/providers", input, 200, &raw)
	if strings.Contains(string(raw), secret) || json.Unmarshal(raw, &config) != nil || config.ID == "" {
		t.Fatal("incorrect response when setting the initial key")
	}
	keyPath := "/providers/" + config.ID + "/api-key"
	t.Setenv("GOOGLE_API_KEY", "unrelated-host-key")
	f.request("GET", "/providers", nil, 200, &raw)
	if strings.Contains(string(raw), secret) || !strings.Contains(string(raw), `"hasApiKey":true`) {
		t.Fatal("incorrect credential metadata")
	}
	var catalog model.Catalog
	f.request("GET", "/providers/"+config.ID+"/models", nil, 200, &catalog)
	if len(catalog.Models) == 0 || catalog.Provisional {
		t.Fatal("key-backed ACP discovery failed")
	}
	f.request("PUT", keyPath, map[string]string{"key": ""}, 200, nil)
	f.request("GET", "/providers", nil, 200, &raw)
	if strings.Contains(string(raw), `"hasApiKey":true`) {
		t.Fatal("key not removed")
	}
	f.request("PUT", keyPath, map[string]string{"key": secret}, 200, nil)
	f.request("PUT", "/providers/codex/api-key", map[string]string{"key": secret}, 400, nil)
}

func TestIdleCompactionRunsOnceForACurrentWarmClaudeSession(t *testing.T) {
	f := newFixture(t)
	config := model.Provider{Type: "claude", PluginID: "lever.claude", ContributionID: "claude", Name: "Warm cache", Enabled: true, IdleCompaction: "beforeCacheExpires"}
	f.request("POST", "/providers", config, 200, &config)
	agent := f.agent(config.ID)
	var previous []model.Run
	for _, window := range []int64{90, -10, 240} {
		chat := f.chat(agent)
		run := f.wait(f.send(chat.ID, "main", "", "initial turn").ID, "completed")
		usage, err := json.Marshal(model.ContextUsage{Used: 230000, Window: 300000, CacheRunID: run.ID, PromptCacheExpiresAt: time.Now().Add(time.Duration(window) * time.Second).UnixMilli()})
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.a.Store.DB.Exec("UPDATE sessions SET data=json_set(data,'$.runtime.context',json(?)) WHERE id=?", string(usage), run.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		previous = append(previous, run)
	}
	restartProviderFixture(t, f)
	deadline := time.Now().Add(6 * time.Second)
	var id string
	for time.Now().Before(deadline) {
		if err := f.a.Store.DB.QueryRow("SELECT id FROM runs WHERE command_id=?", "idle-compact-"+previous[0].ID).Scan(&id); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if id == "" {
		t.Fatal("no compaction for eligible warm cache")
	}
	if run := f.wait(id, "completed"); run.SessionID != previous[0].SessionID || !run.Quiet || run.Input != "/compact" {
		t.Fatal("compaction did not use the original Claude session")
	}
	restartProviderFixture(t, f)
	var count int
	if err := f.a.Store.DB.QueryRow("SELECT COUNT(*) FROM runs WHERE command_id LIKE 'idle-compact-%'").Scan(&count); err != nil || count != 1 {
		t.Fatal("expired, premature or duplicate compaction", count, err)
	}
}

func TestLocalProviderDiscoveryRequiresAdoptionAndPreservesDisabledConnections(t *testing.T) {
	f := newUnconfiguredFixture(t)
	var candidates []model.ProviderCandidate
	for range 2 {
		f.request("GET", "/provider-candidates", nil, 200, &candidates)
		if len(candidates) != 5 || slices.ContainsFunc(candidates, func(p model.ProviderCandidate) bool { return p.Path == "" || p.ContributionID == "acp" }) {
			t.Fatal("unexpected candidates", candidates)
		}
	}
	var connections []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &connections)
	if len(connections) != 0 {
		t.Fatal("discovery created connections", connections)
	}
	f.request("PUT", "/plugins/lever.codex", map[string]bool{"enabled": false}, 200, nil)
	f.request("GET", "/provider-candidates", nil, 200, &candidates)
	if slices.ContainsFunc(candidates, func(p model.ProviderCandidate) bool { return p.PluginID == "lever.codex" }) {
		t.Fatal("disabled plugin was discovered")
	}
	const adopt = "/provider-candidates/lever.codex/codex"
	f.request("POST", adopt, nil, 400, nil)
	f.request("PUT", "/plugins/lever.codex", map[string]bool{"enabled": true}, 200, nil)
	var pending sync.WaitGroup
	for range 4 {
		pending.Go(func() {
			saved, err := f.a.UseLocalProvider(t.Context(), "lever.codex", "codex")
			if err != nil || saved.ID != "codex" || saved.ConfigDir != "" || !saved.Enabled {
				t.Errorf("unexpected local connection: %+v, %v", saved, err)
			}
		})
	}
	pending.Wait()
	f.request("GET", "/providers", nil, 200, &connections)
	if len(connections) != 1 {
		t.Fatal("concurrent adoption duplicated the default", connections)
	}
	saved := connections[0].Provider
	saved.Enabled = false
	f.request("POST", "/providers", saved, 200, nil)
	f.request("POST", adopt, nil, 200, &saved)
	if saved.Enabled || saved.ID != "codex" {
		t.Fatal("repeated adoption changed the saved connection", saved)
	}
	f.request("GET", "/provider-candidates", nil, 200, &candidates)
	if slices.ContainsFunc(candidates, func(p model.ProviderCandidate) bool { return p.PluginID == "lever.codex" }) {
		t.Fatal("saved connection reappeared as a candidate")
	}
}

func TestAutomaticLocalProviderScanPreservesUserChoices(t *testing.T) {
	dsh := os.Getenv("LEVER_DSH_PATH")
	t.Setenv("LEVER_DSH_PATH", filepath.Join(t.TempDir(), "missing-dsh"))
	f := newUnconfiguredFixture(t)
	const scan = "/provider-candidates/scan"
	var result map[string]bool
	f.request("PUT", "/plugins/lever.pi", map[string]bool{"enabled": false}, 200, nil)
	f.request("POST", scan, nil, 200, &result)
	if !result["connected"] {
		t.Fatal("the scan did not connect any available defaults")
	}
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	ids := make([]string, 0, len(providers))
	for _, p := range providers {
		ids = append(ids, p.ID)
	}
	if !slices.Equal(ids, []string{"codex", "claude", "antigravity"}) || providers[2].Command != "agy" {
		t.Fatal("unexpected automatic connections", providers)
	}
	t.Setenv("LEVER_DSH_PATH", dsh)
	f.request("POST", scan, nil, 200, &result)
	if !result["connected"] {
		t.Fatal("the rescan did not connect a newly available executable")
	}
	codex := providers[0].Provider
	codex.Name, codex.Enabled = "Renamed local Codex", false
	f.request("POST", "/providers", codex, 200, nil)
	f.request("DELETE", "/providers/antigravity", nil, 200, nil)
	restartProviderFixture(t, f)
	f.request("POST", scan, nil, 200, &result)
	if result["connected"] {
		t.Fatal("the scan recreated a removed or disabled default")
	}
	f.request("GET", "/providers", nil, 200, &providers)
	if len(providers) != 3 || providers[0].Name != codex.Name || providers[0].Enabled {
		t.Fatal("the scan changed existing instances", providers)
	}
	var restored model.Provider
	f.request("POST", "/provider-candidates/lever.antigravity/antigravity", nil, 200, &restored)
	if restored.ID != "antigravity" || restored.Command != "agy" {
		t.Fatal("could not reconnect the removed local source", restored)
	}
}

func TestNativeAntigravityUsageReportsAccountQuota(t *testing.T) {
	f := newFixture(t)
	find := func() model.ProviderInfo {
		var providers []model.ProviderInfo
		f.request("GET", "/providers", nil, 200, &providers)
		for _, p := range providers {
			if p.ID == "antigravity" {
				return p
			}
		}
		t.Fatal("native Antigravity instance was not found")
		return model.ProviderInfo{}
	}
	if info := find(); info.Auth != "cli" || !info.ReportsUsage {
		t.Fatal("supported CLI did not advertise subscription usage", info)
	}
	var usage model.ProviderUsage
	f.request("GET", "/providers/antigravity/usage", nil, 200, &usage)
	windows := usage.Windows
	if len(windows) != 3 || windows[0].Group != "Gemini Models" || windows[0].Minutes != 7*24*60 || windows[0].UsedPercent != 25 ||
		windows[1].UsedPercent != 0 || windows[1].Minutes != 5*60 || windows[1].ResetsAt == "" ||
		windows[2].Group != "Claude and GPT models" || windows[2].UsedPercent != 50 {
		t.Fatal("unexpected subscription usage", usage)
	}
	t.Setenv("LEVER_FIXTURE_AGY_VERSION", "1.1.10")
	if info := find(); info.ReportsUsage {
		t.Fatal("older CLI advertised subscription usage", info)
	}
	f.request("GET", "/providers/antigravity/usage", nil, 200, &usage)
	if len(usage.Windows) != 0 {
		t.Fatal("older CLI's print mode was invoked for /usage", usage)
	}
}

func TestNewLoginProfilesUseSeparateNativeAccounts(t *testing.T) {
	t.Setenv("LEVER_FIXTURE_PROFILE_LOGIN", "1")
	for _, kind := range []string{"codex", "claude"} {
		t.Run(kind, func(t *testing.T) {
			f := newUnconfiguredFixture(t)
			var local model.Provider
			f.request("POST", "/provider-candidates/lever."+kind+"/"+kind, nil, 200, &local)
			config := model.Provider{PluginID: local.PluginID, ContributionID: kind, Type: kind, Enabled: true}
			accounts := []model.Provider{local}
			for _, name := range []string{"Work", "Personal"} {
				config.Name = name
				input := struct {
					model.Provider
					NewProfile bool `json:"newProfile"`
				}{config, true}
				var saved model.Provider
				f.request("POST", "/providers", input, 200, &saved)
				dir := filepath.Join(f.a.Store.Dir, "providers", kind, saved.ID)
				if saved.ConfigDir != dir || !saved.ManagedProfile {
					t.Fatal("unexpected new profile", saved)
				}
				if info, err := os.Stat(dir); err != nil || !info.IsDir() {
					t.Fatalf("profile directory %s: %v", dir, err)
				}
				accounts = append(accounts, saved)
			}
			work := accounts[1]
			key := "OPENAI_API_KEY"
			if kind == "claude" {
				key = "ANTHROPIC_API_KEY"
			}
			t.Setenv(key, "fixture-host-key")
			for _, account := range accounts {
				cmd, err := provider.LoginCommand(t.Context(), account)
				if err != nil {
					t.Fatal(err)
				}
				inheritsKey := slices.ContainsFunc(cmd.Environ(), func(entry string) bool { return strings.HasPrefix(entry, key+"=") })
				if inheritsKey != (account.ID == local.ID) {
					t.Fatal("incorrect host credential inheritance", account.Name)
				}
			}
			terminal := "/providers/" + work.ID + "/terminal/work-login"
			f.request("POST", terminal, nil, 200, nil)
			deadline := time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(filepath.Join(work.ConfigDir, "fixture-login")); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("native login did not write into the work profile")
				}
				time.Sleep(10 * time.Millisecond)
			}
			f.request("DELETE", terminal, nil, 200, nil)
			var connections []model.ProviderInfo
			f.request("GET", "/providers?login=true", nil, 200, &connections)
			for _, account := range accounts {
				i := slices.IndexFunc(connections, func(p model.ProviderInfo) bool { return p.ID == account.ID })
				if i < 0 || (connections[i].LoginStatus == "signedIn") != (account.ID == work.ID) ||
					(account.ID != work.ID && connections[i].LoginStatus != "signedOut") {
					t.Fatal("unexpected native account status", account.Name, connections)
				}
			}
			work.Name = "Renamed"
			work.ManagedProfile = false
			f.request("POST", "/providers", work, 200, &work)
			if !work.ManagedProfile || work.ConfigDir != accounts[1].ConfigDir {
				t.Fatal("renaming changed the login profile", work)
			}
		})
	}
}

func TestProviderConfigurationDirectoryIsConsistentAndImmutable(t *testing.T) {
	for _, kind := range []string{"codex", "claude"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			home, inherited := t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("USERPROFILE", home)
			variable := "CODEX_HOME"
			if kind == "claude" {
				variable = "CLAUDE_CONFIG_DIR"
			}
			t.Setenv(variable, inherited)
			path := filepath.Join(home, "separate account")
			t.Setenv("LEVER_FIXTURE_EXPECT_CONFIG_DIR", path)
			config := model.Provider{PluginID: "lever." + kind, ContributionID: kind, Type: kind, Name: "Separate account", ConfigDir: "~/separate account", Enabled: true}
			f.request("POST", "/providers", config, 200, &config)
			if config.ConfigDir != path {
				t.Fatalf("home path was not expanded: %+v", config)
			}
			info := provider.Probe(context.Background(), config)
			if info.ConfigPath != path || !info.Installed || info.Error != "" {
				t.Fatalf("probe did not use the configured directory: %+v", info)
			}
			var catalog model.Catalog
			f.request("GET", "/providers/"+config.ID+"/models?cwd="+url.QueryEscape(f.root), nil, 200, &catalog)
			if len(catalog.Models) == 0 {
				t.Fatal("catalog discovery did not use the configured directory")
			}
			var usage model.ProviderUsage
			f.request("GET", "/providers/"+config.ID+"/usage", nil, 200, &usage)
			if len(usage.Windows) != 2 || usage.Windows[0].Minutes != 300 || usage.Windows[1].Minutes != 10080 {
				t.Fatalf("usage discovery did not read the configured subscription: %+v", usage)
			}
			if reset, err := time.Parse(time.RFC3339, usage.Windows[0].ResetsAt); err != nil || !reset.After(time.Now()) {
				t.Fatalf("invalid subscription reset: %q", usage.Windows[0].ResetsAt)
			}
			skills, err := provider.Skills(context.Background(), config, model.Scope{
				PrimaryRootID: "root", Roots: []model.Root{{ID: "root", Path: f.root}},
			}, provider.SkillPlan{})
			if err != nil || len(skills) == 0 {
				t.Fatal("skill discovery did not use the configured directory", skills, err)
			}
			chat := f.chat(f.agent(config.ID))
			first := f.wait(f.send(chat.ID, "main", "", "configuration marker").ID, "completed")
			config.Name = "Renamed account"
			f.request("POST", "/providers", config, 200, &config)
			next := f.wait(f.send(chat.ID, "main", "", "resume same account").ID, "completed")
			if next.SessionID != first.SessionID || next.Handoff {
				t.Fatal("metadata edit changed the session binding", next)
			}
			changed := config
			changed.ConfigDir = inherited
			f.request("POST", "/providers", changed, 409, nil)
			changed.ConfigDir = "relative/account"
			changed.ID = ""
			f.request("POST", "/providers", changed, 400, nil)
			changed.ConfigDir = "~"
			f.request("POST", "/providers", changed, 200, &changed)
			if changed.ConfigDir != home {
				t.Fatal("bare home path was not expanded", changed.ConfigDir)
			}
			restartProviderFixture(t, f)
			var stored []model.ProviderInfo
			f.request("GET", "/providers", nil, 200, &stored)
			found := false
			for _, item := range stored {
				if item.ID == config.ID {
					found = item.ConfigDir == path && item.ConfigPath == path && item.Error == ""
				}
			}
			if !found {
				t.Fatal("configuration directory did not survive restart", stored)
			}
			// Default instances retain the existing CLI configuration, including
			// inherited overrides, without capturing or rewriting credentials.
			t.Setenv("LEVER_FIXTURE_EXPECT_CONFIG_DIR", inherited)
			info = provider.Probe(context.Background(), model.Provider{Type: kind, Enabled: true})
			if info.ConfigPath != inherited || info.Error != "" || os.Getenv(variable) != inherited {
				t.Fatal("default CLI configuration was changed", info)
			}
			unsupported := model.Provider{PluginID: "lever.acp", ContributionID: "acp", Type: "acp", Name: "Unsupported directory", Command: os.Getenv("LEVER_CODEX_PATH"), ConfigDir: path}
			f.request("POST", "/providers", unsupported, 400, nil)
		})
	}
}
