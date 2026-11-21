package app

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

var skillName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

func normalizeDisabledSkills(names []string) ([]string, error) {
	if len(names) > 128 {
		return nil, invalid("Select at most 128 disabled skills")
	}
	normalized := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || len(name) > 256 || strings.ContainsAny(name, "\x00\r\n") {
			return nil, invalid("Invalid disabled skill name")
		}
		if !slices.ContainsFunc(normalized, func(other string) bool { return strings.EqualFold(other, name) }) {
			normalized = append(normalized, name)
		}
	}
	return normalized, nil
}

func (a *App) SaveAgentDisabledSkills(ctx context.Context, id, version string, names []string) (model.Agent, error) {
	names, err := normalizeDisabledSkills(names)
	if err != nil {
		return model.Agent{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	var agent model.Agent
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		agent, err = store.Get[model.Agent](ctx, tx, "SELECT data FROM agents WHERE id=?", id)
		if err != nil {
			return err
		}
		if agent.UpdatedAt != version {
			return conflict("Profile changed elsewhere. Reload before saving.")
		}
		if agent.Archived {
			return conflict("Agent is archived")
		}
		config, err := configuredProvider(ctx, tx, agent.Profile.Provider)
		if err != nil {
			return err
		}
		if !provider.Capabilities(config.Type).Skills {
			return invalid("This runtime does not support Agent skill directories")
		}
		if slices.Equal(agent.Profile.DisabledSkills, names) {
			return nil
		}
		agent.Profile.DisabledSkills = names
		agent.UpdatedAt = now()
		if _, err := tx.ExecContext(ctx, "UPDATE agents SET data=? WHERE id=?", store.JSON(agent), agent.ID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "agent-skills"})
	})
	return agent, err
}

func (a *App) skillsDir() (string, error) {
	data, err := workspace.Canonical(a.Store.Dir)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(data, "skills")
	info, err := os.Lstat(dir)
	if err == nil && !info.IsDir() {
		return "", errors.New("Lever's skills directory must be a directory")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return dir, nil
}

func skillAt(path string, managed bool) model.Skill {
	return model.Skill{
		ID: hash(path), Path: path, Name: filepath.Base(path), Managed: managed, AgentIDs: []string{},
	}
}

// The managed directories and existing Profile references are already sources
// of truth. Persist only directories added directly to the library.
func (a *App) registeredSkills(ctx context.Context) (map[string]model.Skill, error) {
	dir, err := a.skillsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	skills := make(map[string]model.Skill, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			skill := skillAt(filepath.Join(dir, entry.Name()), true)
			skills[skill.ID] = skill
		}
	}
	type reference struct {
		Path    string
		AgentID string
	}
	refs, err := store.List[reference](ctx, a.Store.DB, `
SELECT json_object('path', path) FROM skill_directories
UNION ALL
SELECT json_object('path', skill.value, 'agentId', agents.id)
FROM agents, json_each(agents.data, '$.profile.skills') AS skill
WHERE skill.type = 'text' AND skill.value != ''
ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	for _, ref := range refs {
		id := hash(ref.Path)
		skill, ok := skills[id]
		if !ok {
			skill = skillAt(ref.Path, false)
		}
		if ref.AgentID != "" && !slices.Contains(skill.AgentIDs, ref.AgentID) {
			skill.AgentIDs = append(skill.AgentIDs, ref.AgentID)
		}
		skills[id] = skill
	}
	return skills, nil
}

func (a *App) discoveredSkillDirectories(ctx context.Context) ([]skillDirectory, error) {
	roots, err := store.List[model.Root](ctx, a.Store.DB, `
SELECT DISTINCT json_object('path', json_extract(root.value, '$.path'))
FROM agents, json_each(agents.data, '$.profile.roots') AS root
WHERE root.type = 'object'
ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	configs, err := store.List[model.Provider](ctx, a.Store.DB, `
SELECT data FROM providers
WHERE json_extract(data, '$.type') IN ('codex', 'claude') AND json_extract(data, '$.configDir') != ''
ORDER BY id`)
	if err != nil {
		return nil, err
	}
	// Include the inherited user directories as well as configured runtime accounts.
	dirs, err := a.skillDirectoriesForScope(model.Scope{Roots: roots}, append([]model.Provider{{}}, configs...)...)
	return slices.DeleteFunc(dirs, func(dir skillDirectory) bool { return dir.managed }), err
}

func skillDirectoryAvailable(path string) bool {
	// A saved directory is canonical. If replaced with a symlink, require
	// the new destination to be selected explicitly.
	current, err := workspace.Canonical(path)
	if err != nil || current != path {
		return false
	}
	entry, err := os.Lstat(filepath.Join(path, model.SkillEntry))
	return err == nil && entry.Mode().IsRegular()
}

func skillMetadata(dir string) (name, description string) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", ""
	}
	defer root.Close()
	file, err := root.Open(model.SkillEntry)
	if err != nil {
		return "", ""
	}
	defer file.Close()
	lines := bufio.NewScanner(io.LimitReader(file, 64<<10))
	if !lines.Scan() || strings.TrimRight(strings.TrimPrefix(lines.Text(), "\uFEFF"), " \t") != "---" {
		return "", ""
	}
	var header strings.Builder
	for lines.Scan() {
		if line := strings.TrimRight(lines.Text(), " \t"); line == "---" || line == "..." {
			var fields struct {
				Name        string `yaml:"name"`
				Description string `yaml:"description"`
			}
			if yaml.Unmarshal([]byte(header.String()), &fields) == nil {
				return strings.TrimSpace(fields.Name), strings.TrimSpace(fields.Description)
			}
			return "", ""
		}
		header.WriteString(lines.Text())
		header.WriteByte('\n')
	}
	return "", ""
}

func describeSkill(skill model.Skill) model.Skill {
	skill.Available = skillDirectoryAvailable(skill.Path)
	if !skill.Available {
		return skill
	}
	name, description := skillMetadata(skill.Path)
	if name != "" {
		skill.Name = name
	}
	skill.Description = description
	return skill
}

func (a *App) Skills(ctx context.Context) ([]model.Skill, error) {
	entries, err := a.registeredSkills(ctx)
	if err != nil {
		return nil, err
	}
	dirs, err := a.discoveredSkillDirectories(ctx)
	if err != nil {
		return nil, err
	}
	for _, dir := range dirs {
		origin := &model.SkillOrigin{Directory: dir.path, ScopePath: dir.root.Path}
		for path := range dir.packages(ctx) {
			skill := skillAt(path, false)
			if existing, ok := entries[skill.ID]; ok {
				skill = existing
			}
			if !skill.Managed && skill.Origin == nil {
				skill.Origin = origin
				entries[skill.ID] = skill
			}
		}
	}
	skills := make([]model.Skill, 0, len(entries))
	for _, skill := range entries {
		skills = append(skills, describeSkill(skill))
	}
	slices.SortFunc(skills, func(a, b model.Skill) int {
		if a.Managed != b.Managed {
			if a.Managed {
				return -1
			}
			return 1
		}
		if order := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); order != 0 {
			return order
		}
		return strings.Compare(a.Path, b.Path)
	})
	return skills, ctx.Err()
}

func (a *App) CreateSkill(name string) (model.Skill, error) {
	name = strings.TrimSpace(name)
	if len(name) > 64 || !skillName.MatchString(name) || !filepath.IsLocal(name) {
		return model.Skill{}, invalid("Use up to 64 lowercase letters, digits and hyphens for the skill name")
	}
	dir, err := a.skillsDir()
	if err != nil {
		return model.Skill{}, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return model.Skill{}, err
	}
	stage, err := os.MkdirTemp(dir, ".new-")
	if err != nil {
		return model.Skill{}, err
	}
	defer os.RemoveAll(stage)
	description := "Use this skill for " + strings.ReplaceAll(name, "-", " ") + "."
	content := fmt.Sprintf("---\nname: %q\ndescription: %q\n---\n\n# %s\n", name, description, name)
	if err := workspace.CreateText(stage, model.SkillEntry, content); err != nil {
		return model.Skill{}, err
	}
	if _, err := workspace.ChangeEntry(dir, filepath.Base(stage), "move", name); err != nil {
		if errors.Is(err, os.ErrExist) {
			return model.Skill{}, conflict("A skill with this directory name already exists")
		}
		return model.Skill{}, err
	}
	skill := skillAt(filepath.Join(dir, name), true)
	skill.Available, skill.Description = true, description
	return skill, nil
}

func (a *App) AddSkillDirectory(ctx context.Context, directory string) (model.Skill, error) {
	path, err := workspace.Canonical(strings.TrimSpace(directory))
	if err != nil {
		return model.Skill{}, invalid("Choose a directory containing a regular SKILL.md file")
	}
	dirs, err := a.registeredSkills(ctx)
	if err != nil {
		return model.Skill{}, err
	}
	skill, known := dirs[hash(path)]
	if !known {
		skill = skillAt(path, false)
	}
	skill = describeSkill(skill)
	if !skill.Available {
		return model.Skill{}, invalid("Choose a directory containing a regular SKILL.md file")
	}
	if !skill.Managed {
		if _, err := a.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO skill_directories(path) VALUES(?)", path); err != nil {
			return model.Skill{}, err
		}
	}
	return skill, nil
}

type SkillReferenceScope struct {
	AgentID, SessionID, WorkingCopyID string
}

var errSkillUnavailable = &Error{404, "Skill directory or SKILL.md is unavailable"}

func (a *App) skillReferenceScope(ctx context.Context, source SkillReferenceScope) (model.Agent, model.Scope, error) {
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", source.AgentID)
	if err != nil {
		return agent, model.Scope{}, err
	}
	if source.SessionID != "" {
		scope, _, err := a.UseScope(ctx, agent.ID, source.SessionID, "", false)
		return agent, scope, err
	}
	if source.WorkingCopyID != "" {
		copy, err := a.selectGroup(ctx, a.Store.DB, agent, source.WorkingCopyID)
		return agent, copy.Scope, err
	}
	return agent, agent.Profile.Scope, nil
}

func (a *App) ResolveSkillReference(ctx context.Context, source SkillReferenceScope, ref model.Reference) (model.Skill, error) {
	if ref.Path != "" {
		if !filepath.IsAbs(ref.Path) || !strings.EqualFold(filepath.Base(ref.Path), model.SkillEntry) {
			return model.Skill{}, errSkillUnavailable
		}
		path, err := workspace.Canonical(filepath.Dir(ref.Path))
		if err != nil {
			return model.Skill{}, errSkillUnavailable
		}
		skill, err := a.skillByID(ctx, hash(path), source)
		if err != nil {
			return model.Skill{}, err
		}
		return describeSkill(skill), nil
	}

	// Claude exposes command names without paths. Open a file only when the
	// name identifies a single package among this composer's Skill sources.
	agent, scope, err := a.skillReferenceScope(ctx, source)
	if err != nil {
		return model.Skill{}, err
	}
	return a.resolveNamedSkill(ctx, a.Store.DB, agent.Profile, scope, ref)
}

func (a *App) resolveNamedSkill(ctx context.Context, q store.Queryer, profile model.Profile, scope model.Scope, ref model.Reference) (model.Skill, error) {
	matches := map[string]model.Skill{}
	match := func(name string, skill model.Skill) {
		if skill.Available && (skill.Name == name || filepath.Base(skill.Path) == name) {
			matches[skill.ID] = skill
		}
	}
	if name, bundled := strings.CutPrefix(ref.Name, skillBundlePluginName+":"); bundled {
		for _, path := range profile.Skills {
			match(name, describeSkill(skillAt(path, false)))
		}
	} else {
		sources, err := a.skillSources(ctx, q, scope, ref.Provider)
		if err != nil {
			return model.Skill{}, err
		}
		for _, source := range sources {
			for _, skill := range source.Skills {
				match(ref.Name, skill)
			}
		}
	}
	if len(matches) > 1 {
		return model.Skill{}, &Error{409, "More than one Skill matches this reference"}
	}
	for _, skill := range matches {
		return skill, nil
	}
	return model.Skill{}, errSkillUnavailable
}

func findSkillDirectory(ctx context.Context, dirs []skillDirectory, id string) model.Skill {
	for _, dir := range dirs {
		for path := range dir.packages(ctx) {
			if hash(path) == id {
				return skillAt(path, false)
			}
		}
	}
	return model.Skill{}
}

func (a *App) skillByID(ctx context.Context, id string, source SkillReferenceScope) (model.Skill, error) {
	entries, err := a.registeredSkills(ctx)
	if err != nil {
		return model.Skill{}, err
	}
	skill, known := entries[id]
	if !known {
		dirs, err := a.discoveredSkillDirectories(ctx)
		if err != nil {
			return model.Skill{}, err
		}
		skill = findSkillDirectory(ctx, dirs, id)
		if skill.Path == "" && (source.SessionID != "" || source.WorkingCopyID != "") {
			_, scope, err := a.skillReferenceScope(ctx, source)
			if err != nil {
				return model.Skill{}, err
			}
			dirs, err := a.skillDirectoriesForScope(scope)
			if err != nil {
				return model.Skill{}, err
			}
			skill = findSkillDirectory(ctx, dirs, id)
		}
		if err := ctx.Err(); err != nil {
			return model.Skill{}, err
		}
	}
	if skill.Path == "" || !skillDirectoryAvailable(skill.Path) {
		return model.Skill{}, errSkillUnavailable
	}
	return skill, nil
}

func (a *App) SkillScope(ctx context.Context, id string, write bool, source SkillReferenceScope) (model.Scope, error) {
	skill, err := a.skillByID(ctx, id, source)
	if err != nil {
		return model.Scope{}, err
	}
	if write && !skill.Managed {
		return model.Scope{}, &Error{403, "External skill directories are read-only"}
	}
	return model.Scope{Roots: []model.Root{{ID: id, Path: skill.Path}}, PrimaryRootID: id}, nil
}
