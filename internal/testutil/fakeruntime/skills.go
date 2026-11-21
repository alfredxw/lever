package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var disabledCodexSkill = regexp.MustCompile(`\{name=("(?:[^"\\]|\\.)*"),enabled=false\}`)

func fixtureCodexDisabled() map[string]bool {
	disabled := map[string]bool{}
	for _, arg := range os.Args {
		if !strings.HasPrefix(arg, "skills.config=") {
			continue
		}
		for _, names := range disabledCodexSkill.FindAllStringSubmatch(arg, -1) {
			var name string
			if json.Unmarshal([]byte(names[1]), &name) == nil {
				disabled[name] = true
			}
		}
	}
	return disabled
}

func fixtureSkills(root string) []object {
	out := []object{}
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name(), "SKILL.md")
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if canonical, err := filepath.EvalSymlinks(path); err == nil {
			path = canonical
		}
		name, description := entry.Name(), ""
		for _, line := range strings.Split(string(data), "\n") {
			if value, ok := strings.CutPrefix(line, "name:"); ok {
				name = strings.Trim(strings.TrimSpace(value), "\"'")
			}
			if value, ok := strings.CutPrefix(line, "description:"); ok {
				description = strings.Trim(strings.TrimSpace(value), "\"'")
			}
		}
		out = append(out, object{"name": name, "path": path, "description": description, "enabled": true})
	}
	return out
}

func fixtureCodexSkills(cwd string, roots []any, disabled map[string]bool) []object {
	skills := []object{
		{"name": "fixture-review", "description": "Review the selected files", "path": filepath.Join(cwd, ".agents", "skills", "fixture-review", "SKILL.md")},
		{"name": "a-related-skill", "description": "Alternative to fixture-review", "path": filepath.Join(cwd, ".agents", "skills", "a-related-skill", "SKILL.md")},
	}
	for _, root := range roots {
		skills = append(skills, fixtureSkills(str(root))...)
	}
	for _, skill := range skills {
		skill["enabled"] = !disabled[str(skill["name"])]
	}
	return append(skills, object{"name": "disabled-skill", "enabled": false})
}

func fixtureClaudeSkills(dirs, plugins []string, overrides object) []object {
	skills := []object{{"name": "fixture-claude", "description": "Claude review skill"}}
	user := os.Getenv("CLAUDE_CONFIG_DIR")
	if user == "" {
		home, _ := os.UserHomeDir()
		user = filepath.Join(home, ".claude")
	}
	skills = append(skills, fixtureSkills(filepath.Join(user, "skills"))...)
	for _, dir := range dirs {
		skills = append(skills, fixtureSkills(filepath.Join(dir, ".claude", "skills"))...)
	}
	for _, plugin := range plugins {
		for _, skill := range fixtureSkills(filepath.Join(plugin, "skills")) {
			skill["name"] = "lever-session-skills:" + str(skill["name"])
			skills = append(skills, skill)
		}
	}
	out := []object{}
	for _, skill := range skills {
		if overrides[str(skill["name"])] != "off" {
			out = append(out, skill)
		}
	}
	return out
}

func fixtureVisibleSkills(skills []object) []string {
	names := []string{}
	for _, skill := range skills {
		if skill["enabled"] != false {
			names = append(names, str(skill["name"]))
		}
	}
	return names
}
