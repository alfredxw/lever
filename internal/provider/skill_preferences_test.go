package provider

import (
	"slices"
	"testing"

	"lever/internal/model"
)

func TestACPSkillCapabilitiesFollowConnection(t *testing.T) {
	for _, row := range []struct {
		config model.Provider
		want   bool
	}{
		{model.Provider{Type: "antigravity"}, true},
		{model.Provider{Type: "acp", Command: "/opt/traex", Args: []string{"acp", "serve"}}, true},
		{model.Provider{Type: "acp", Command: "traecli.exe", Args: []string{"--acp"}}, true},
		{model.Provider{Type: "acp", PluginID: "lever.dsh"}, true},
		{model.Provider{Type: "acp", Name: "TRAE CLI", Command: "custom", Args: []string{"--acp"}}, false},
		{model.Provider{Type: "acp", Command: "traex", Args: []string{"app-server"}}, false},
	} {
		stale := model.Catalog{Capabilities: model.ProviderCapabilities{Skills: !row.want, SkillContext: !row.want}}
		for _, caps := range []model.ProviderCapabilities{ConfiguredCapabilities(row.config), NormalizeCatalog(row.config, stale).Capabilities} {
			if caps.Skills != row.want || caps.SkillContext != row.want {
				t.Fatalf("%+v returned incorrect Skill capabilities: %+v", row.config, caps)
			}
		}
	}
}

func TestTraeSkillArgumentsPreserveConnectionRules(t *testing.T) {
	plan := SkillPlan{Disabled: []string{"from-agent"}}
	for _, args := range [][]string{{"acp", "serve", "--config", `skills.config=[{name="other",enabled=false},]`}, {"acp", "serve", `--config=skills.config=[{name="other",enabled=false}]`}} {
		merged := traeSkillArguments(args, plan)
		if !slices.Equal(merged[:len(args)], args) || !slices.Equal(merged[len(args):], []string{"-c", `skills.config=[{name="other",enabled=false},{name="from-agent",enabled=false}]`}) {
			t.Fatalf("connection settings were replaced: %q", merged)
		}
	}
	args := []string{"acp", "serve", "-c", `skills={config=[{name="other",enabled=false}]}`}
	if !slices.Equal(traeSkillArguments(args, plan), args) || !slices.Equal(traeSkillArguments(args, SkillPlan{}), args) {
		t.Fatal("a custom policy or an unchanged connection was rewritten")
	}
}
