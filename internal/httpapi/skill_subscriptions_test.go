package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
)

func TestSkillSubscriptionsSyncLocalEditProtectionAndFork(t *testing.T) {
	f := newFixture(t)
	repo := newPluginRepository(t)
	repo.write("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha v1\n---\n\n# Alpha v1\n", 0600)
	repo.write("skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta v1\n---\n\n# Beta v1\n", 0600)
	first := repo.commit("v1")

	var sub model.SkillSubscription
	f.request("POST", "/skill-subscriptions", map[string]any{
		"name":         "Team Pack",
		"url":          pluginRepoURL,
		"path":         "skills",
		"updatePolicy": "notify",
	}, 200, &sub)
	if sub.Commit != first || sub.SkillCount != 2 || sub.UpdatePolicy != "notify" {
		t.Fatalf("unexpected subscription: %+v", sub)
	}

	var skills []model.Skill
	f.request("GET", "/skills", nil, 200, &skills)
	findSkill := func(list []model.Skill, name string) *model.Skill {
		for i := range list {
			if list[i].Name == name {
				return &list[i]
			}
		}
		return nil
	}
	alpha := findSkill(skills, "alpha")
	beta := findSkill(skills, "beta")
	if alpha == nil || beta == nil {
		t.Fatalf("expected alpha and beta in library: %+v", skills)
	}
	if alpha.SubscriptionID != sub.ID || alpha.LocalModified || alpha.FileCount != 1 {
		t.Fatalf("unexpected alpha metadata: %+v", alpha)
	}

	// Edit alpha via the Files API — must be writable and flag localModified.
	var file model.FileContent
	f.request("GET", "/skills/"+alpha.ID+"/file?path=SKILL.md", nil, 200, &file)
	customContent := "---\nname: alpha\ndescription: Alpha local custom\n---\n\n# Local custom edits\n"
	f.request("PUT", "/skills/"+alpha.ID+"/file?path=SKILL.md", map[string]any{
		"content":  customContent,
		"version":  file.Version,
		"rootPath": alpha.Path,
	}, 200, nil)

	f.request("GET", "/skills", nil, 200, &skills)
	alpha = findSkill(skills, "alpha")
	if alpha == nil || !alpha.LocalModified {
		t.Fatalf("expected alpha to be marked localModified: %+v", alpha)
	}

	// Push upstream updates to alpha & beta, plus a brand-new skill gamma.
	repo.write("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha v2\n---\n\n# Alpha v2\n", 0600)
	repo.write("skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta v2\n---\n\n# Beta v2\n", 0600)
	repo.write("skills/gamma/SKILL.md", "---\nname: gamma\ndescription: Gamma v1\n---\n\n# Gamma v1\n", 0600)
	second := repo.commit("v2")

	var checked model.SkillSubscription
	f.request("POST", "/skill-subscriptions/"+sub.ID+"/check", nil, 200, &checked)
	if !checked.Available || checked.AvailableCommit != second || checked.ModifiedCount != 1 {
		t.Fatalf("unexpected check result: %+v", checked)
	}

	var syncRes model.SkillSubscriptionSyncResult
	f.request("POST", "/skill-subscriptions/"+sub.ID+"/sync", nil, 200, &syncRes)
	if syncRes.Added != 1 || syncRes.Updated != 1 || syncRes.SkippedModified != 1 {
		t.Fatalf("unexpected sync result: %+v", syncRes)
	}

	// Verify alpha kept local edits while beta updated and gamma appeared.
	gotAlpha, err := os.ReadFile(filepath.Join(alpha.Path, "SKILL.md"))
	if err != nil || string(gotAlpha) != customContent {
		t.Fatalf("local edits were not protected: err=%v content=%q", err, string(gotAlpha))
	}
	gotBeta, err := os.ReadFile(filepath.Join(beta.Path, "SKILL.md"))
	if err != nil || !strings.Contains(string(gotBeta), "Beta v2") {
		t.Fatalf("beta was not updated: err=%v content=%q", err, string(gotBeta))
	}

	// Fork alpha local edits into managed skill and update subscribed alpha.
	var forked model.Skill
	f.request("POST", "/skills/"+alpha.ID+"/resolve-update", map[string]any{
		"strategy": "fork",
	}, 200, &forked)
	if !forked.Managed || !strings.HasPrefix(filepath.Base(forked.Path), "alpha-local") {
		t.Fatalf("expected managed fork: %+v", forked)
	}
	gotForked, err := os.ReadFile(filepath.Join(forked.Path, "SKILL.md"))
	if err != nil || string(gotForked) != customContent {
		t.Fatalf("fork did not preserve local edits: %q", string(gotForked))
	}
	gotAlphaAfter, err := os.ReadFile(filepath.Join(alpha.Path, "SKILL.md"))
	if err != nil || !strings.Contains(string(gotAlphaAfter), "Alpha v2") {
		t.Fatalf("subscribed alpha was not updated after fork: %q", string(gotAlphaAfter))
	}

	// Update settings & policy endpoints
	var skillSettings model.UpdateSettings
	f.request("PUT", "/skill-update-settings", map[string]any{"mode": "auto", "interval": "1h"}, 200, &skillSettings)
	if skillSettings.Mode != "auto" || skillSettings.Interval != "1h" {
		t.Fatalf("unexpected skill settings: %+v", skillSettings)
	}

	// Delete subscription cleans up files
	f.request("DELETE", "/skill-subscriptions/"+sub.ID, nil, 200, nil)
	if _, err := os.Stat(alpha.Path); !os.IsNotExist(err) {
		t.Fatalf("expected subscription files removed, stat err=%v", err)
	}
}

func TestPluginUpdateSettingsPolicyAndSafeAutoUpdate(t *testing.T) {
	f := newFixture(t)
	repo := newPluginRepository(t)
	m := model.PluginManifest{
		ManifestVersion: 1,
		ID:              "test.auto-plug",
		Name:            "Auto Plug",
		Version:         "1.0.0",
		Description:     "First version",
		Contributes: model.PluginContributions{
			Providers: []model.ProviderContribution{{ID: "agent", Name: "Auto Agent", Driver: "acp", Command: "bin/agent", Args: []string{"--acp"}}},
		},
	}
	writeManifest := func() {
		b, _ := json.Marshal(m)
		repo.write("lever-plugin.json", string(b), 0600)
	}
	writeManifest()
	repo.write("bin/agent", "#!/bin/sh\necho ok\n", 0700)
	repo.commit("1.0.0")

	pv := f.previewPackage(model.Plugin{}, map[string]any{"url": pluginRepoURL})
	p := f.applyPackage(pv, 200)

	var settings model.UpdateSettings
	f.request("PUT", "/plugin-update-settings", map[string]any{"mode": "auto", "interval": "24h"}, 200, &settings)
	if settings.Mode != "auto" || settings.Interval != "24h" {
		t.Fatalf("unexpected plugin update settings: %+v", settings)
	}

	f.request("PUT", "/plugins/"+p.ID, map[string]any{"updatePolicy": "auto"}, 200, nil)

	// Compatible patch (description + version bump, same command/args) auto-applies!
	m.Version = "1.0.1"
	m.Description = "Patched safely"
	writeManifest()
	repo.commit("1.0.1")

	var autoRes struct {
		Plugin  model.Plugin `json:"plugin"`
		Applied bool         `json:"applied"`
	}
	f.request("POST", "/plugins/"+p.ID+"/auto-update", nil, 200, &autoRes)
	if !autoRes.Applied || autoRes.Plugin.Manifest.Version != "1.0.1" {
		t.Fatalf("expected safe auto-update to apply: %+v", autoRes)
	}

	// Command change must NOT auto-apply silently (requires manual review)!
	m.Version = "2.0.0"
	m.Contributes.Providers[0].Args = []string{"--acp", "--new-flag"}
	writeManifest()
	repo.commit("2.0.0")

	f.request("POST", "/plugins/"+p.ID+"/auto-update", nil, 200, &autoRes)
	if autoRes.Applied || autoRes.Plugin.Manifest.Version != "1.0.1" {
		t.Fatalf("expected command-changing update to require manual review: %+v", autoRes)
	}
}

func TestAgentSkillAttachAndDetach(t *testing.T) {
	f := newFixture(t)
	agent := model.Agent{
		Name: "Attach Tester",
		Profile: model.Profile{
			Provider: "codex",
			Scope:    model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"},
		},
	}
	f.request("POST", "/agents", agent, 200, &agent)

	dir := t.TempDir()
	skillDir := filepath.Join(dir, "extra-skill")
	if err := os.MkdirAll(skillDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: extra-skill\n---\n\n# Extra\n"), 0600); err != nil {
		t.Fatal(err)
	}

	var updated model.Agent
	f.request("PATCH", "/agents/"+agent.ID+"/skills", map[string]any{
		"updatedAt": agent.UpdatedAt,
		"attach":    skillDir,
	}, 200, &updated)
	if len(updated.Profile.Skills) != 1 {
		t.Fatalf("expected skill attached: %+v", updated.Profile.Skills)
	}

	var detached model.Agent
	f.request("PATCH", "/agents/"+agent.ID+"/skills", map[string]any{
		"updatedAt": updated.UpdatedAt,
		"detach":    skillDir,
	}, 200, &detached)
	if len(detached.Profile.Skills) != 0 {
		t.Fatalf("expected skill detached: %+v", detached.Profile.Skills)
	}
}
