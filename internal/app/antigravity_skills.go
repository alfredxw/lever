package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"go.yaml.in/yaml/v3"
	"lever/internal/model"
	"lever/internal/provider"
)

// ACP advertises commands by name, without their source paths. Give each
// selected package its own command so an installed namesake cannot win.
func (a *App) prepareAntigravitySkillReferences(ctx context.Context, in *provider.Input) error {
	var root string
	var total int64
	commands := map[string]string{}
	defer func() {
		if root != "" && in.Skills.AntigravityRoot == "" {
			_ = os.RemoveAll(root)
		}
	}()
	for _, ref := range in.References {
		if ref.Kind != "skill" || ref.Path == "" || commands[ref.Path] != "" {
			continue
		}
		// A runtime can also return a standalone manifest outside Lever's known
		// packages. Keep its explicit file reference without copying its siblings.
		skill, err := a.ResolveSkillReference(ctx, SkillReferenceScope{AgentID: in.Session.AgentID, SessionID: in.Session.ID}, ref)
		if errors.Is(err, errSkillUnavailable) {
			continue
		}
		if err != nil {
			return err
		}
		// The native manifest name can differ from its directory or picker label.
		ref.Name = skill.Name
		if err := validateSkillReferences([]model.Reference{ref}, in.Skills.Disabled); err != nil {
			return err
		}
		if root == "" {
			root, err = os.MkdirTemp(in.Assets, "skill-refs-")
			if err != nil {
				return err
			}
		}
		name := skill.Name
		if !skillName.MatchString(name) || len(name) > 45 {
			name = "skill"
		}
		name += "-" + hash([2]string{root, skill.Path})[:16]
		dir := filepath.Join(root, ".agents", "skills", name)
		size := total
		if err := copySkillPackage(skill.Path, dir, &size); err != nil || !renameAntigravitySkill(dir, name) {
			if err := os.RemoveAll(dir); err != nil {
				return err
			}
			continue
		}
		total = size
		commands[ref.Path] = name
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(commands) > 0 {
		// Native conversation history records these manifest paths. Retain
		// the snapshots with the session for follow-up turns.
		in.Skills.AntigravityRoot, in.Skills.AntigravitySkills = root, commands
	}
	return nil
}

var skillFrontmatter = regexp.MustCompile(`(?ms)\A\x{FEFF}?---[ \t]*\r?\n(.*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|\z)`)

func renameAntigravitySkill(dir, name string) bool {
	path := filepath.Join(dir, model.SkillEntry)
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	match := skillFrontmatter.FindSubmatchIndex(data)
	var header map[string]yaml.Node
	if match == nil || yaml.Unmarshal(data[match[2]:match[3]], &header) != nil || header == nil {
		return false
	}
	header["name"] = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name}
	fields, err := yaml.Marshal(header)
	if err != nil {
		return false
	}
	entry := append([]byte("---\n"), fields...)
	entry = append(entry, "---\n"...)
	return os.WriteFile(path, append(entry, data[match[1]:]...), 0600) == nil
}
