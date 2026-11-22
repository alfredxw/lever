package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/provider"
)

func TestSkillContextReplacesOversizedAndEmptyCatalogs(t *testing.T) {
	plan := provider.SkillPlan{Assets: t.TempDir()}
	if err := prepareSkillContext(&plan, nil, true); err != nil || plan.Context != "" || plan.AntigravityCatalogRoot != "" {
		t.Fatalf("unexpected initial catalog: %+v, %v", plan, err)
	}
	description := strings.Repeat("example ", 1200)
	entries := []skillCatalogEntry{{Name: "zeta", Description: description, Path: "/library/zeta/SKILL.md"}, {Name: "alpha", Path: "/library/alpha/SKILL.md"}}
	err := prepareSkillContext(&plan, entries, true)
	path := filepath.Join(skillContextDirectory(plan.Assets), "index.json")
	if err != nil || len(plan.Context) >= 1024 || !strings.Contains(plan.Context, filepath.Base(path)) || plan.AntigravityCatalogRoot != filepath.Dir(path) {
		t.Fatalf("catalog was not bounded: %d bytes, %v", len(plan.Context), err)
	}
	data, err := os.ReadFile(path)
	var saved []skillCatalogEntry
	if err != nil || json.Unmarshal(data, &saved) != nil || len(saved) != 2 || saved[0].Name != "alpha" || saved[1].Description != description {
		t.Fatalf("incomplete or unsorted catalog: %v", err)
	}
	plan.Disabled = []string{"dotted.name"}
	err = prepareSkillContext(&plan, nil, true)
	if err != nil || !strings.Contains(plan.Context, "No supplemental") {
		t.Fatalf("stale catalog not cleared: %q, %v", plan.Context, err)
	}
	if data, err = os.ReadFile(path); err != nil || string(data) != "[]" {
		t.Fatalf("old entries survived: %s, %v", data, err)
	}
	if data, err = os.ReadFile(filepath.Join(plan.AntigravityCatalogRoot, ".agents", "skills.json")); err != nil || string(data) != `{"exclude":["dotted.name"]}` {
		t.Fatalf("native exact-name mask: %s, %v", data, err)
	}
}
