package app

import (
	"cmp"
	"context"
	"os"
	"path/filepath"
	"slices"

	"lever/internal/model"
	"lever/internal/provider"
	"lever/internal/store"
	"lever/internal/workspace"
)

// Suggestions use current Agent skills and the conversation's working scope.
func (a *App) Suggestions(ctx context.Context, chatID, agentID, sessionID, copyID, kind, runtime, query string) ([]model.Reference, error) {
	if chatID != "" {
		chat, err := store.Get[model.Chat](ctx, a.Store.DB, "SELECT data FROM chats WHERE id=?", chatID)
		if err != nil {
			return nil, err
		}
		agentID = chat.AgentID
	}
	agent, err := store.Get[model.Agent](ctx, a.Store.DB, "SELECT data FROM agents WHERE id=?", agentID)
	if err != nil {
		return nil, err
	}
	scope := agent.Profile.Scope
	if sessionID != "" {
		session, err := store.Get[model.Session](ctx, a.Store.DB, "SELECT data FROM sessions WHERE id=?", sessionID)
		if err != nil {
			return nil, err
		}
		if session.ChatID != chatID {
			return nil, invalid("Session must belong to this Chat")
		}
		scope = session.Scope
	} else if copyID != "" {
		copy, err := a.selectGroup(ctx, a.Store.DB, agent, copyID)
		if err != nil {
			return nil, err
		}
		scope = copy.Scope
	}
	if kind == "file" {
		return workspace.Search(ctx, scope, query)
	}
	if kind != "skill" && kind != "slash" {
		return nil, invalid("Unsupported suggestions")
	}
	config, err := configuredProvider(ctx, a.Store.DB, runtime)
	if err != nil {
		return nil, err
	}
	if !provider.Capabilities(config.Type).Skills {
		return a.directorySkillReferences(ctx, scope, config, agent.Profile)
	}
	assets, err := os.MkdirTemp("", "lever-skills-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(assets)
	assets, err = filepath.EvalSymlinks(assets)
	if err != nil {
		return nil, err
	}
	plan, cleanup, err := a.prepareSkillPlan(ctx, scope, agent.Profile, config, assets)
	defer cleanup()
	if err != nil {
		return nil, err
	}
	skills, err := provider.Skills(ctx, config, scope, plan)
	if config.Type == "pi" && err == nil {
		refs, err := a.directorySkillReferences(ctx, scope, config, agent.Profile)
		if err != nil {
			return nil, err
		}
		skills = append(refs, slices.DeleteFunc(skills, func(ref model.Reference) bool { return ref.Kind == "skill" })...)
	}
	// Store source identities in the draft; execution resolves them to that
	// run's working copy, including drafts made before a session exists.
	seen := map[string]bool{}
	out := make([]model.Reference, 0, len(skills))
	for i := range skills {
		if kind == "skill" && skills[i].Kind != "skill" {
			continue
		}
		for _, source := range plan.Bundled {
			if skills[i].Path == filepath.Join(assets, "skills", filepath.Base(source), model.SkillEntry) {
				skills[i].Path = filepath.Join(source, model.SkillEntry)
			}
		}
		key := skills[i].Path
		if key == "" {
			key = skills[i].Kind + ":" + skills[i].Name
		}
		if !seen[key] {
			seen[key] = true
			out = append(out, skills[i])
		}
	}
	return out, err
}

func (a *App) directorySkillReferences(ctx context.Context, scope model.Scope, config model.Provider, profile model.Profile) ([]model.Reference, error) {
	paths, err := a.skillReferencePaths(ctx, a.Store.DB, scope, config)
	if err != nil {
		return nil, err
	}
	for _, path := range profile.Skills {
		paths[path] = true
	}
	refs := []model.Reference{}
	for path := range paths {
		skill := describeSkill(skillAt(path, false))
		ref := model.Reference{Kind: "skill", Provider: config.ID, Name: skill.Name, Path: filepath.Join(path, model.SkillEntry), Description: skill.Description}
		if skill.Available && !skillReferenceDisabled(ref, profile.DisabledSkills) {
			refs = append(refs, ref)
		}
	}
	slices.SortFunc(refs, func(a, b model.Reference) int {
		return cmp.Or(cmp.Compare(a.Name, b.Name), cmp.Compare(a.Path, b.Path))
	})
	return refs, ctx.Err()
}
