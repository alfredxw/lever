package provider

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"lever/internal/model"
	"lever/internal/workspace"
)

type SkillPlan struct {
	Assets                 string
	Roots                  []string
	Bundled                []string
	Disabled               []string
	Context                string `json:",omitempty"`
	ClaudeDirectories      []string
	ClaudeStage            string
	AntigravityRoot        string
	AntigravityCatalogRoot string            `json:",omitempty"`
	AntigravitySkills      map[string]string // selected SKILL.md path to its native command
}

func isTraeCLI(config model.Provider) bool {
	if config.Type != "acp" {
		return false
	}
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(config.Command)), ".exe")
	if name != "traex" && name != "traecli" {
		return false
	}
	index := slices.Index(config.Args, "acp")
	return slices.Contains(config.Args, "--acp") || (index >= 0 && index+1 < len(config.Args) && config.Args[index+1] == "serve")
}

func acpSkillContext(config model.Provider) bool {
	return config.Type == "antigravity" || isTraeCLI(config) || (config.Type == "acp" && config.PluginID == "lever.dsh")
}

// An explicit configuration directory belongs to its runtime instance.
func UserSkillDirectory(config model.Provider, kind string) string {
	if config.Type != kind {
		config = model.Provider{Type: kind}
	}
	if path := ConfigurationDirectory(config); path != "" {
		return filepath.Join(path, "skills")
	}
	return ""
}

func SkillReferenceDirectories(config model.Provider, cwd, stateDir string) (user []string, project, manifest string) {
	if isTraeCLI(config) {
		home := os.Getenv("TRAE_HOME")
		if home == "" {
			if userHome, err := os.UserHomeDir(); err == nil {
				home = filepath.Join(userHome, ".trae")
			}
		} else if !filepath.IsAbs(home) {
			home = filepath.Join(cwd, home)
		}
		if home != "" {
			user = []string{filepath.Join(home, "skills")}
		}
		return user, ".trae/skills", ""
	}
	if config.Type == "pi" {
		return []string{UserSkillDirectory(config, "pi")}, ".pi/skills", ""
	}
	if config.Type != "antigravity" {
		return nil, "", ""
	}
	command := config.Command
	if command == "" {
		command = os.Getenv("LEVER_ANTIGRAVITY_PATH")
	}
	home := antigravityProfileDir(stateDir, config.ID)
	if IsAntigravityCLI(config, command) {
		home, _ = antigravityCLIHome(cwd)
		if home != "" {
			user = append(user, filepath.Join(home, "antigravity-cli", "skills"))
		}
	}
	if home == "" {
		return nil, ".agent/skills", ""
	}
	return append(user, filepath.Join(home, "config", "skills"), filepath.Join(home, "skills")), ".agent/skills", filepath.Join(home, "config", "skills.json")
}

func codexSkillArguments(plan SkillPlan) []string {
	if len(plan.Disabled) == 0 {
		return nil
	}
	entries := make([]string, 0, len(plan.Disabled))
	for _, name := range plan.Disabled {
		entries = append(entries, "{name="+strconv.Quote(name)+",enabled=false}")
	}
	return []string{"-c", "skills.config=[" + strings.Join(entries, ",") + "]"}
}

func traeSkillArguments(args []string, plan SkillPlan) []string {
	override := codexSkillArguments(plan)
	if len(override) == 0 {
		return args
	}
	for index, arg := range slices.Backward(args) {
		switch {
		case index > 0 && (args[index-1] == "-c" || args[index-1] == "--config"):
		case strings.HasPrefix(arg, "--config="):
			arg = strings.TrimPrefix(arg, "--config=")
		case strings.HasPrefix(arg, "-c"):
			arg = strings.TrimPrefix(strings.TrimPrefix(arg, "-c"), "=")
		default:
			continue
		}
		key, value, ok := strings.Cut(arg, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "skills":
			return args
		case "skills.config":
			value = strings.TrimSpace(value)
			if !strings.HasPrefix(value, "[") || !strings.HasSuffix(value, "]") {
				return args
			}
			entries := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(value[1:len(value)-1]), ","))
			if entries != "" {
				if !strings.HasSuffix(entries, "}") {
					return args
				}
				override[1] = "skills.config=[" + entries + "," + strings.TrimPrefix(override[1], "skills.config=[")
			}
			return append(slices.Clone(args), override...)
		}
	}
	return append(slices.Clone(args), override...)
}

func codexSkillRoots(call func(string, object) (object, error), plan SkillPlan) error {
	roots := plan.Roots
	if len(plan.Bundled) != 0 {
		roots = append(slices.Clone(roots), filepath.Join(plan.Assets, "skills"))
	}
	if len(roots) == 0 {
		return nil
	}
	_, err := call("skills/extraRoots/set", object{"extraRoots": roots})
	return err
}

func claudeSkillArguments(scope model.Scope, plan SkillPlan, settings object) []string {
	if len(plan.Disabled) > 0 {
		overrides := object{}
		for _, name := range plan.Disabled {
			overrides[name] = "off"
		}
		settings["skillOverrides"] = overrides
	}
	args := []string{"--settings", pretty(settings)}
	if len(plan.Bundled) > 0 {
		args = append(args, "--plugin-dir", plan.Assets)
	}
	for _, root := range scope.Roots {
		if root.ID != scope.PrimaryRootID {
			args = append(args, "--add-dir", root.Path)
		}
	}
	for _, dir := range plan.ClaudeDirectories {
		args = append(args, "--add-dir", dir)
	}
	return args
}

func claudeSkillReferences(data object, provider string) []model.Reference {
	skills := []model.Reference{}
	for _, value := range arr(data["commands"]) {
		command := obj(value)
		kind := "skill"
		name := str(command["name"])
		if command["builtin"] == true || strings.HasPrefix(name, "mcp__") {
			kind = "command"
		}
		switch name {
		case "goal", "loop", "compact", "context": // Older CLIs omit builtin.
			kind = "command"
		}
		skills = append(skills, model.Reference{Kind: kind, Provider: provider, Name: name, Description: str(command["description"]), ArgumentHint: str(command["argumentHint"])})
	}
	return skills
}

func codexSkillReferences(call func(string, object) (object, error), cwd, provider string) ([]model.Reference, error) {
	result, err := call("skills/list", object{"cwds": []string{cwd}})
	if err != nil {
		return nil, err
	}
	skills := []model.Reference{}
	for _, entry := range arr(result["data"]) {
		for _, value := range arr(obj(entry)["skills"]) {
			skill := obj(value)
			if skill["enabled"] == false {
				continue
			}
			skills = append(skills, model.Reference{Kind: "skill", Provider: provider, Name: str(skill["name"]), Path: str(skill["path"]), Description: str(skill["description"])})
		}
	}
	return skills, nil
}

func verifySkillPolicy(plan SkillPlan, skills []model.Reference) error {
	for _, skill := range skills {
		if skill.Kind != "skill" {
			continue
		}
		// Claude plugin commands have their own namespace and are managed
		// by the runtime. A same-name plugin must not prevent a turn.
		if slices.ContainsFunc(plan.Disabled, func(name string) bool {
			return strings.EqualFold(name, skill.Name)
		}) {
			return fmt.Errorf("the runtime still exposes disabled Skill %q; update the runtime to apply this Agent's Skills settings", skill.Name)
		}
	}
	return nil
}

// Plugin commands and plugin Skills share a namespace in initialize. Only
// Skills appear in the CLI's own Skills menu.
func classifyClaudePluginCommands(call func(string, object) (object, error), refs []model.Reference) {
	isNamespaced := func(r model.Reference) bool { return r.Kind == "skill" && strings.Contains(r.Name, ":") }
	if !slices.ContainsFunc(refs, isNamespaced) {
		return
	}
	dialog, err := call("get_skills_dialog", object{})
	rows, ok := dialog["skills"].([]any)
	if err != nil || !ok {
		return
	}
	names := make(map[string]bool, len(rows))
	for _, row := range rows {
		names[str(obj(row)["name"])] = true
	}
	for i, r := range refs {
		if isNamespaced(r) && !names[r.Name] {
			refs[i].Kind = "command"
		}
	}
}

func nativeSkills(ctx context.Context, config model.Provider, scope model.Scope, plan SkillPlan) ([]model.Reference, error) {
	cwd := workspace.CWD(scope)
	args := codexSkillArguments(plan)
	if config.Type == "claude" {
		args = claudeSkillArguments(scope, plan, object{"disableAllHooks": true, "fastMode": true})
	}
	client, err := openDiscovery(ctx, config, cwd, args)
	if err != nil {
		return nil, err
	}
	defer client.close()
	var skills []model.Reference
	if config.Type == "claude" {
		skills = claudeSkillReferences(client.initial, config.ID)
		classifyClaudePluginCommands(client.call, skills)
		// Project and user command files share the initialization list with
		// inline Skills. Keep their native /name argument dispatch.
		dirs := []string{ConfigurationDirectory(config)}
		for dir := cwd; dir != ""; dir = filepath.Dir(dir) {
			dirs = append(dirs, filepath.Join(dir, ".claude"))
			if filepath.Dir(dir) == dir {
				break
			}
		}
		for _, root := range scope.Roots {
			dirs = append(dirs, filepath.Join(root.Path, ".claude"))
		}
		for i, entry := range skills {
			if entry.Kind != "skill" {
				continue
			}
			name := strings.ReplaceAll(entry.Name, ":", "/") + ".md"
			if !filepath.IsLocal(name) {
				continue
			}
			for _, dir := range dirs {
				if info, err := os.Stat(filepath.Join(dir, "commands", name)); err == nil && info.Mode().IsRegular() {
					skills[i].Kind = "command"
					break
				}
			}
		}
	} else {
		if err = codexSkillRoots(client.call, plan); err != nil {
			return nil, err
		}
		skills, err = codexSkillReferences(client.call, cwd, config.ID)
		if err != nil {
			return nil, err
		}
	}
	if err := verifySkillPolicy(plan, skills); err != nil {
		return nil, err
	}
	skills = slices.DeleteFunc(skills, func(skill model.Reference) bool {
		return skill.Kind == "skill" && model.SkillDisabled(plan.Disabled, skill.Name)
	})
	slices.SortStableFunc(skills, func(a, b model.Reference) int {
		return strings.Compare(a.Name, b.Name)
	})
	return skills, nil
}
