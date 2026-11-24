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
	path                                string
	root                                model.Root
	managed, subscription, claudeNative bool
	packageOnly, runtimeNative          bool
	providers                           []string
	removed                             removedSkillPaths
}

func (a *App) skillDirectoriesForScope(ctx context.Context, q store.Queryer, scope model.Scope, config model.Provider) ([]skillDirectory, error) {
	managed, err := a.skillsDir()
	if err != nil {
		return nil, err
	}
	owned := []skillDirectory{{path: managed, managed: true}}
	ids, err := store.List[string](ctx, q, "SELECT json_quote(id) FROM skill_subscriptions ORDER BY id")
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		dir, err := a.skillSubscriptionDir(id)
		if err != nil {
			return nil, err
		}
		owned = append(owned, skillDirectory{path: dir, subscription: true})
	}
	dirs, err := a.collectSkillDirectories(ctx, scope, owned, config)
	if err != nil {
		return nil, err
	}
	removed, err := loadRemovedSkillPaths(ctx, q)
	if err != nil {
		return nil, err
	}
	for i := range dirs {
		dirs[i].removed = removed
	}
	return dirs, nil
}

// Scope contributes its configured directories. Only Skill collection
// directories are searched, regardless of the size of the workspace.
func (a *App) collectSkillDirectories(ctx context.Context, scope model.Scope, owned []skillDirectory, configs ...model.Provider) ([]skillDirectory, error) {
	var sources []skillDirectory
	index := map[string]int{}
	add := func(dir skillDirectory) {
		if dir.path == "" {
			return
		}
		path, err := workspace.Canonical(dir.path)
		if err != nil || (dir.subscription && path != dir.path) {
			return
		}
		if i, ok := index[path]; ok {
			sources[i].claudeNative = sources[i].claudeNative || dir.claudeNative
			sources[i].runtimeNative = sources[i].runtimeNative || dir.runtimeNative
			sources[i].packageOnly = sources[i].packageOnly && dir.packageOnly
			return
		}
		index[path] = len(sources)
		dir.path = path
		sources = append(sources, dir)
	}
	for _, dir := range owned {
		add(dir)
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(skillDirectory{path: filepath.Join(home, ".agents", "skills")})
	}
	collections := []string{".agents/skills", ".codex/skills", ".claude/skills", "skills"}
	agyManifests := map[string]bool{}
	nativeCollections := map[string]bool{}
	addNative := func(dir skillDirectory) { dir.runtimeNative = true; add(dir) }
	for _, config := range configs {
		add(skillDirectory{path: provider.UserSkillDirectory(config, "codex")})
		add(skillDirectory{path: provider.UserSkillDirectory(config, "claude"), claudeNative: true})
		userDirs, projectDir, manifest := provider.SkillReferenceDirectories(config, workspace.CWD(scope), a.Store.Dir)
		for _, path := range userDirs {
			addNative(skillDirectory{path: path})
		}
		if projectDir == ".trae/skills" || config.Type == "antigravity" {
			nativeCollections[projectDir], nativeCollections[".agents/skills"] = true, true
		}
		if projectDir == ".trae/skills" {
			if home, err := os.UserHomeDir(); err == nil {
				addNative(skillDirectory{path: filepath.Join(home, ".agents", "skills")})
			}
		}
		if projectDir != "" && !slices.Contains(collections, projectDir) {
			collections = append(collections, projectDir)
		}
		if manifest != "" && !agyManifests[manifest] {
			agyManifests[manifest] = true
			real, err := filepath.EvalSymlinks(manifest)
			if err != nil {
				continue
			}
			var boundary model.Root
			for _, root := range scope.Roots {
				if root.Path != "" && (workspace.Contains(root.Path, manifest) || workspace.Contains(root.Path, real)) {
					boundary = root
					break
				}
			}
			if err := addManifestSkills(ctx, manifest, filepath.Dir(manifest), boundary, addNative); err != nil {
				return nil, err
			}
		}
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
		for _, relative := range collections {
			add(skillDirectory{path: filepath.Join(path, relative), root: root, claudeNative: relative == ".claude/skills", runtimeNative: nativeCollections[relative] && (root.ID == scope.PrimaryRootID || len(agyManifests) > 0)})
		}
		if len(agyManifests) != 0 {
			add(skillDirectory{path: filepath.Join(path, ".gemini", "skills"), root: root})
			for _, dir := range []string{".agents", ".agent"} {
				if err := addManifestSkills(ctx, filepath.Join(path, dir, "skills.json"), path, root, addNative); err != nil {
					return nil, err
				}
			}
		}
	}
	return sources, nil
}

func (s skillDirectory) packages(ctx context.Context) iter.Seq[string] {
	return func(yield func(string) bool) {
		if s.packageOnly {
			if ctx.Err() == nil && !s.removed[s.path] && skillDirectoryAvailable(s.path) {
				yield(s.path)
			}
			return
		}
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
			if !s.removed[dir] && !yield(dir) {
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

func (a *App) skillReferencePaths(ctx context.Context, q store.Queryer, scope model.Scope, config model.Provider) (map[string]bool, error) {
	dirs, err := a.skillDirectoriesForScope(ctx, q, scope, config)
	if err != nil {
		return nil, err
	}
	paths := map[string]bool{}
	for _, dir := range dirs {
		for path := range dir.packages(ctx) {
			paths[path] = true
		}
	}
	return paths, ctx.Err()
}

func (a *App) SkillSources(ctx context.Context, scope model.Scope, runtime string) ([]model.SkillSource, error) {
	config, err := configuredProvider(ctx, a.Store.DB, runtime)
	if err != nil {
		return nil, err
	}
	return a.skillSources(ctx, a.Store.DB, scope, config)
}

func (a *App) skillSources(ctx context.Context, q store.Queryer, scope model.Scope, config model.Provider) ([]model.SkillSource, error) {
	results := []model.SkillSource{}
	if !provider.ConfiguredCapabilities(config).Skills {
		return results, nil
	}
	dirs, err := a.skillDirectoriesForScope(ctx, q, scope, config)
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
	caps := provider.ConfiguredCapabilities(config)
	if !caps.Skills {
		return plan, cleanup, nil
	}
	dirs, err := a.skillDirectoriesForScope(ctx, a.Store.DB, scope, config)
	if err != nil {
		return plan, cleanup, err
	}
	// Native name selectors use the spelling the runtime sees. Include the
	// directory name too, since older skills can omit the name in frontmatter.
	disabled := append([]string{}, profile.DisabledSkills...)
	discovered := map[string]bool{}
	var catalog []skillCatalogEntry
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
		if caps.SkillContext || len(profile.DisabledSkills) != 0 || len(profile.Skills) != 0 {
			for path := range dir.packages(ctx) {
				if discovered[path] {
					continue
				}
				discovered[path] = true
				skill := withSkillMetadata(skillAt(path, false))
				native := dir.runtimeNative && (config.Type != "antigravity" || dir.packageOnly || filepath.Dir(path) == dir.path)
				if !filter(skill) && caps.SkillContext && !native {
					catalog = append(catalog, skillCatalogEntry{skill.Name, skill.Description, filepath.Join(path, model.SkillEntry)})
				}
			}
		}
	}
	for _, path := range profile.Skills {
		skill := withSkillMetadata(skillAt(path, false))
		if filter(skill) || discovered[path] {
			continue
		}
		plan.Bundled = append(plan.Bundled, path)
		if caps.SkillContext {
			catalog = append(catalog, skillCatalogEntry{skill.Name, skill.Description, filepath.Join(skillContextDirectory(assets), "skills", filepath.Base(path), model.SkillEntry)})
		}
	}
	if err := ctx.Err(); err != nil {
		return plan, cleanup, err
	}
	plan.Disabled = disabled
	if caps.SkillContext {
		err = prepareSkillContext(&plan, catalog, config.Type == "antigravity")
		return plan, cleanup, err
	}
	if err := prepareSkills(assets, plan.Bundled); err != nil {
		return plan, cleanup, err
	}
	if config.Type != "claude" {
		return plan, cleanup, ctx.Err()
	}
	var shared []skillDirectory
	for _, dir := range dirs {
		if !dir.claudeNative {
			shared = append(shared, dir)
		}
	}
	stage := filepath.Join(assets, "scope-skills")
	if len(shared) == 0 {
		_ = os.RemoveAll(stage)
		return plan, cleanup, ctx.Err()
	}
	if err := os.MkdirAll(stage, 0700); err != nil {
		return plan, cleanup, err
	}
	keep := make(map[string]bool, len(shared))
	for _, dir := range shared {
		name := "lever-" + hash(dir.path)[:12]
		keep[name] = true
		addDir := filepath.Join(stage, name)
		if err := syncClaudeSkillRoot(dir.path, addDir); err != nil {
			return plan, cleanup, err
		}
		plan.ClaudeDirectories = append(plan.ClaudeDirectories, addDir)
	}
	if entries, err := os.ReadDir(stage); err == nil {
		for _, entry := range entries {
			if !keep[entry.Name()] {
				_ = os.RemoveAll(filepath.Join(stage, entry.Name()))
			}
		}
	}
	return plan, cleanup, ctx.Err()
}

func syncClaudeSkillRoot(source, dir string) error {
	target := filepath.Join(dir, ".claude", "skills")
	if link, err := os.Readlink(target); err == nil && link == source {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return mountClaudeSkillRoot(source, dir)
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
