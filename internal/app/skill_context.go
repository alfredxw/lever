package app

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"lever/internal/provider"
)

type skillCatalogEntry struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Path        string `json:"path"`
}

func skillContextDirectory(assets string) string { return filepath.Join(assets, "agent-skills") }

func prepareSkillContext(plan *provider.SkillPlan, entries []skillCatalogEntry, antigravity bool) error {
	root := skillContextDirectory(plan.Assets)
	const catalog = "index.json"
	const inlineLimit = 8 << 10
	if len(entries) == 0 {
		_, err := os.Lstat(root)
		if errors.Is(err, os.ErrNotExist) && len(plan.Disabled) == 0 {
			return nil
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		entries = []skillCatalogEntry{}
	}
	slices.SortFunc(entries, func(left, right skillCatalogEntry) int {
		return cmp.Or(cmp.Compare(left.Name, right.Name), cmp.Compare(left.Path, right.Path))
	})
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	stage, err := os.MkdirTemp(plan.Assets, ".agent-skills-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.WriteFile(filepath.Join(stage, catalog), data, 0600); err != nil {
		return err
	}
	if err := copySkillPackages(filepath.Join(stage, "skills"), plan.Bundled); err != nil {
		return err
	}
	needsWorkspace := antigravity && (len(plan.Disabled) != 0 || len(plan.Bundled) != 0 || len(data) > inlineLimit)
	if needsWorkspace {
		manifest := map[string]any{}
		if len(plan.Disabled) > 0 {
			manifest["exclude"] = plan.Disabled
		}
		if len(plan.Bundled) > 0 {
			manifest["entries"] = []map[string]string{{"path": "skills"}}
		}
		if err := os.Mkdir(filepath.Join(stage, ".agents"), 0700); err != nil {
			return err
		}
		rules, err := json.Marshal(manifest)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(stage, ".agents", "skills.json"), rules, 0600); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if err := os.Rename(stage, root); err != nil {
		return err
	}
	if needsWorkspace {
		plan.AntigravityCatalogRoot = root
	}
	const instructions = "These are the supplemental Skills enabled for this Agent on this turn, replacing previous Lever skill catalogs. When a Skill matches the task, read its SKILL.md at the listed path and use its accompanying files relative to that path."
	switch {
	case len(entries) == 0:
		plan.Context = "No supplemental Lever Skills are enabled for this turn. This replaces previous Lever skill catalogs."
	case len(data) <= inlineLimit:
		plan.Context = instructions + "\n" + string(data)
	default:
		plan.Context = fmt.Sprintf("%s Consult the catalog at %q to find matching Skills.", instructions, filepath.Join(root, catalog))
	}
	return nil
}
