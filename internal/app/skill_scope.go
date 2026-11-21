package app

import (
	"context"
	"errors"
	"io/fs"
	"iter"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

type skillDirectory struct {
	path                  string
	root                  model.Root
	managed, claudeNative bool
}

// Scope contributes its configured directories. Only Skill collection
// directories are searched, regardless of the size of the workspace.
func (a *App) skillDirectoriesForScope(scope model.Scope, configs ...model.Provider) ([]skillDirectory, error) {
	var sources []skillDirectory
	index := map[string]int{}
	add := func(dir skillDirectory) {
		if dir.path == "" {
			return
		}
		path, err := workspace.Canonical(dir.path)
		if err != nil {
			return
		}
		if i, ok := index[path]; ok {
			sources[i].claudeNative = sources[i].claudeNative || dir.claudeNative
			return
		}
		index[path] = len(sources)
		dir.path = path
		sources = append(sources, dir)
	}
	managed, err := a.skillsDir()
	if err != nil {
		return nil, err
	}
	add(skillDirectory{path: managed, managed: true})
	if home, err := os.UserHomeDir(); err == nil {
		add(skillDirectory{path: filepath.Join(home, ".agents", "skills")})
	}
	for _, config := range configs {
		add(skillDirectory{path: provider.UserSkillDirectory(config, "codex")})
		add(skillDirectory{path: provider.UserSkillDirectory(config, "claude"), claudeNative: true})
	}
	for _, root := range scope.Roots {
		if strings.TrimSpace(root.Path) == "" {
			continue
		}
		path, err := workspace.Canonical(root.Path)
		if err != nil {
			continue
		}
		root.Path = path
		for _, relative := range []string{".agents/skills", ".codex/skills", ".claude/skills", "skills"} {
			add(skillDirectory{path: filepath.Join(path, relative), root: root, claudeNative: relative == ".claude/skills"})
		}
	}
	return sources, nil
}

func (s skillDirectory) packages(ctx context.Context) iter.Seq[string] {
	return func(yield func(string) bool) {
		_ = filepath.WalkDir(s.path, func(path string, entry fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return fs.SkipAll
			}
			if err != nil {
				return nil
			}
			if path != s.path && strings.HasPrefix(entry.Name(), ".") {
				if entry.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if !entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
				return nil
			}
			dir := path
			if !entry.IsDir() {
				dir, err = workspace.Canonical(path)
				if err != nil {
					return nil
				}
			}
			info, err := os.Lstat(filepath.Join(dir, model.SkillEntry))
			if err != nil || !info.Mode().IsRegular() {
				return nil
			}
			if !yield(dir) {
				return fs.SkipAll
			}
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		})
	}
}

func (s skillDirectory) scan(ctx context.Context) []model.Skill {
	skills := []model.Skill{}
	seen := map[string]bool{}
	for dir := range s.packages(ctx) {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		skills = append(skills, describeSkill(skillAt(dir, s.managed && filepath.Dir(dir) == s.path)))
	}
	return skills
}

func (a *App) SkillSources(ctx context.Context, scope model.Scope, runtime string) ([]model.SkillSource, error) {
	return a.skillSources(ctx, a.Store.DB, scope, runtime)
}

func (a *App) skillSources(ctx context.Context, q store.Queryer, scope model.Scope, runtime string) ([]model.SkillSource, error) {
	config, err := configuredProvider(ctx, q, runtime)
	if err != nil {
		return nil, err
	}
	results := []model.SkillSource{}
	if !provider.Capabilities(config.Type).Skills {
		return results, nil
	}
	dirs, err := a.skillDirectoriesForScope(scope, config)
	if err != nil {
		return nil, err
	}
	for _, dir := range dirs {
		results = append(results, model.SkillSource{Path: dir.path, ScopeRootID: dir.root.ID, Skills: dir.scan(ctx)})
	}
	return results, ctx.Err()
}

func (a *App) prepareSkillPlan(ctx context.Context, scope model.Scope, profile model.Profile, config model.Provider, assets string) (provider.SkillPlan, func(), error) {
	plan := provider.SkillPlan{Assets: assets, Disabled: slices.Clone(profile.DisabledSkills)}
	cleanup := func() {}
	if err := os.MkdirAll(assets, 0700); err != nil {
		return plan, cleanup, err
	}
	if !provider.Capabilities(config.Type).Skills {
		return plan, cleanup, nil
	}
	dirs, err := a.skillDirectoriesForScope(scope, config)
	if err != nil {
		return plan, cleanup, err
	}
	// Native name selectors use the spelling the runtime sees. Include the
	// directory name too, since older skills can omit the name in frontmatter.
	disabled := append([]string{}, profile.DisabledSkills...)
	discovered := map[string]bool{}
	filter := func(skill model.Skill) bool {
		base := filepath.Base(skill.Path)
		if !model.SkillDisabled(profile.DisabledSkills, skill.Name) && !model.SkillDisabled(profile.DisabledSkills, base) {
			return false
		}
		for _, name := range []string{skill.Name, base} {
			if name != "" && !strings.ContainsAny(name, "\x00\r\n") && !slices.Contains(disabled, name) {
				disabled = append(disabled, name)
			}
		}
		return true
	}
	for _, dir := range dirs {
		plan.Roots = append(plan.Roots, dir.path)
		if len(profile.DisabledSkills) != 0 || len(profile.Skills) != 0 {
			for _, skill := range dir.scan(ctx) {
				discovered[skill.Path] = true
				filter(skill)
			}
		}
	}
	for _, path := range profile.Skills {
		skill := describeSkill(skillAt(path, false))
		if filter(skill) || discovered[path] {
			continue
		}
		plan.Bundled = append(plan.Bundled, path)
	}
	if err := prepareSkills(assets, plan.Bundled); err != nil {
		return plan, cleanup, err
	}
	plan.Disabled = disabled
	if config.Type != "claude" {
		return plan, cleanup, ctx.Err()
	}
	var shared []skillDirectory
	for _, dir := range dirs {
		if !dir.claudeNative {
			shared = append(shared, dir)
		}
	}
	if len(shared) == 0 {
		return plan, cleanup, ctx.Err()
	}
	stage, err := os.MkdirTemp(assets, ".scope-skills-")
	if err != nil {
		return plan, cleanup, err
	}
	plan.ClaudeStage = stage
	cleanup = func() { _ = os.RemoveAll(stage) }
	for _, dir := range shared {
		addDir := filepath.Join(stage, "lever-"+hash(dir.path)[:12])
		if err := mountClaudeSkillRoot(dir.path, addDir); err != nil {
			return plan, cleanup, err
		}
		plan.ClaudeDirectories = append(plan.ClaudeDirectories, addDir)
	}
	return plan, cleanup, ctx.Err()
}

func mountClaudeSkillRoot(source, dir string) error {
	config := filepath.Join(dir, ".claude")
	if err := os.MkdirAll(config, 0700); err != nil {
		return err
	}
	target := filepath.Join(config, "skills")
	if err := os.Symlink(source, target); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrPermission) {
		// Some systems report lack of symlink support as a platform error.
		if _, statErr := os.Lstat(target); !errors.Is(statErr, os.ErrNotExist) {
			return err
		}
	}
	root, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer root.Close()
	return os.CopyFS(target, root.FS())
}
