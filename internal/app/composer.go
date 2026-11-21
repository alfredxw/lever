package app

import (
	"context"
	"os"
	"path/filepath"

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
	}
	if sessionID == "" && copyID != "" {
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
		return []model.Reference{}, nil
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
