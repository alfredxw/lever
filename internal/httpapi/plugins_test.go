package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestPluginInstallDisableUninstallAndReinstallKeepConversationIdentity(t *testing.T) {
	f := newFixture(t)
	manifest := model.PluginManifest{ManifestVersion: 1, ID: "example.acp", Name: "Example agent", Version: "1.0.0", Contributes: model.PluginContributions{Providers: []model.ProviderContribution{{ID: "agent", Name: "Example agent", Driver: "acp", Command: os.Getenv("LEVER_CODEX_PATH"), Args: []string{"--acp", "plugin"}}}}}
	directory := t.TempDir()
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(directory, "lever-plugin.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	var installed model.Plugin
	f.request("POST", "/plugins", map[string]string{"directory": directory}, 200, &installed)
	f.request("POST", "/plugins", map[string]string{"directory": directory}, 409, nil)
	f.request("POST", "/provider-candidates/"+installed.ID+"/agent", nil, 200, nil)
	var providers []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &providers)
	var config model.Provider
	for _, info := range providers {
		if info.PluginID == installed.ID {
			config = info.Provider
			if !info.Available {
				t.Fatal(info)
			}
		}
	}
	if config.ID == "" || config.ContributionID != "agent" {
		t.Fatal("provider contribution was not registered", providers)
	}
	agent := f.acpAgent(config)
	chat := f.chat(agent)
	first := f.wait(f.send(chat.ID, "main", "", "preserve plugin context").ID, "completed")
	native := acpReceipt(t, first)["native"]
	f.request("PUT", "/plugins/"+installed.ID, map[string]bool{"enabled": false}, 200, nil)
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "disabled plugin cannot run"}, 400, nil)
	// Editing metadata of an Agent whose plugin is disabled remains possible.
	agent.Name = "Renamed Agent"
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	f.request("PUT", "/plugins/"+installed.ID, map[string]bool{"enabled": true}, 200, nil)
	second := f.wait(f.send(chat.ID, "main", "", "same installation resumes").ID, "completed")
	if acpReceipt(t, second)["native"] != native {
		t.Fatal("toggle changed native binding")
	}
	hang := f.send(chat.ID, "main", "", "[hang]")
	f.wait(hang.ID, "running")
	f.request("DELETE", "/plugins/"+installed.ID, nil, 409, nil)
	f.request("POST", "/runs/"+hang.ID+"/stop", map[string]bool{}, 200, nil)
	f.wait(hang.ID, "interrupted")
	f.request("DELETE", "/plugins/"+installed.ID, nil, 200, nil)
	if _, err := os.Stat(filepath.Join(directory, "lever-plugin.json")); err != nil {
		t.Fatal("uninstall removed the source package", err)
	}
	var list []model.Plugin
	f.request("GET", "/plugins", nil, 200, &list)
	for _, item := range list {
		if item.ID == installed.ID {
			t.Fatal("uninstalled plugin still listed")
		}
	}
	var reinstalled model.Plugin
	f.request("POST", "/plugins", map[string]string{"directory": directory}, 200, &reinstalled)
	if installed.ID == reinstalled.ID {
		t.Fatal("reinstall reused an old installation identity")
	}
	f.request("POST", "/provider-candidates/"+reinstalled.ID+"/agent", nil, 200, nil)
	f.request("GET", "/providers", nil, 200, &providers)
	var next model.Provider
	for _, info := range providers {
		if info.PluginID == reinstalled.ID {
			next = info.Provider
		}
		if info.ID == config.ID && info.Available {
			t.Fatal("old provider became executable again")
		}
	}
	var resumed model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: chat.ID, Operation: "main", Text: "continue after reinstall", Selection: &model.Selection{Provider: next.ID, Model: "acp-model", Permission: "review-mode"}}, 200, &resumed)
	resumed = f.wait(resumed.ID, "completed")
	if !resumed.Handoff || resumed.SessionID != first.SessionID || acpReceipt(t, resumed)["native"] == native {
		t.Fatal("reinstall crossed installation identities", resumed)
	}
	restartProviderFixture(t, f)
	f.wait(first.ID, "completed")
	f.request("GET", "/plugins", nil, 200, &list)
	if !slices.ContainsFunc(list, func(item model.Plugin) bool { return item.ID == reinstalled.ID }) {
		t.Fatal("plugin installation did not persist", list)
	}
	f.request("DELETE", "/plugins/lever.codex", nil, 409, nil)
}

func TestPluginManifestRejectsUnsupportedContributionsAndEscapingExecutables(t *testing.T) {
	f := newFixture(t)
	directory := t.TempDir()
	path := filepath.Join(directory, "lever-plugin.json")
	if err := os.WriteFile(path, []byte(`{"manifestVersion":1,"id":"example.unsupported","name":"Unsupported","version":"1.0.0","contributes":{"ui":[]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/plugins", map[string]string{"directory": directory}, 400, nil)
	if err := os.WriteFile(path, []byte(`{"manifestVersion":1,"id":"example.escape","name":"Escape","version":"1.0.0","contributes":{"providers":[{"id":"agent","name":"Agent","driver":"acp","command":"../outside"}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/plugins", map[string]string{"directory": directory}, 400, nil)
	var list []model.Plugin
	f.request("GET", "/plugins", nil, 200, &list)
	if slices.ContainsFunc(list, func(item model.Plugin) bool { return !item.Builtin }) {
		t.Fatal("invalid manifest installed partially", list)
	}
	config := model.Provider{PluginID: "lever.codex", ContributionID: "codex", Type: "acp", Name: "Wrong driver", Command: "agent", Enabled: true}
	f.request("POST", "/providers", config, 400, nil)
}

func TestBuiltinPluginRefreshesManifestAndKeepsEnabledState(t *testing.T) {
	f := newFixture(t)
	f.request("PUT", "/plugins/lever.feishu", map[string]bool{"enabled": false}, 200, nil)
	if _, err := f.a.Store.DB.Exec(`
UPDATE plugins SET data=json_set(data,'$.manifest.name','Feishu Bot',
  '$.manifest.contributes.channels[0].name','Feishu Bot') WHERE id='lever.feishu'`); err != nil {
		t.Fatal(err)
	}
	restartProviderFixture(t, f)
	var plugins []model.Plugin
	f.request("GET", "/plugins", nil, 200, &plugins)
	if !slices.ContainsFunc(plugins, func(p model.Plugin) bool {
		return p.ID == "lever.feishu" && !p.Enabled && p.Manifest.Name == "Lark Bot" &&
			len(p.Manifest.Contributes.Channels) == 1 && p.Manifest.Contributes.Channels[0].Name == "Lark Bot"
	}) {
		t.Fatal("the built-in Lark Bot name or enabled state was not restored")
	}
	if !slices.ContainsFunc(plugins, func(p model.Plugin) bool {
		return p.ID == "lever.lark-todos" && p.Enabled && p.Manifest.Name == "Lark Todos" &&
			len(p.Manifest.Contributes.TaskSources) == 1 && p.Manifest.Contributes.TaskSources[0].ID == "lark-todos"
	}) {
		t.Fatal("Lark Todos was not registered as a built-in task source")
	}
}
