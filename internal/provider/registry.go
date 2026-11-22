package provider

import (
	"context"
	"errors"
	"slices"
	"strings"

	"lever/internal/model"
)

type driver struct {
	definition        model.ProviderType
	permissions       []string
	defaultPermission string
	capabilities      model.ProviderCapabilities
	acp               bool
	run               func(context.Context, Input, Sink) error
	discover          func(context.Context, model.Provider, string) (model.Catalog, error)
	skills            func(context.Context, model.Provider, model.Scope, SkillPlan) ([]model.Reference, error)
}

var nativeCapabilities = model.ProviderCapabilities{Steering: true, Images: true, Files: true, MultiRoot: true, MCP: true, Skills: true, Resume: true}

var drivers = map[string]driver{
	"codex":       {definition: model.ProviderType{ID: "codex", Name: "Codex", Arguments: true, ShadowHome: true}, permissions: []string{"ask", "auto_review", "read_only", "full_access"}, defaultPermission: "auto_review", capabilities: nativeCapabilities, run: codex, discover: discoverNative, skills: nativeSkills},
	"claude":      {definition: model.ProviderType{ID: "claude", Name: "Claude Code", Arguments: true, AutoCompactWindow: true, IdleCompactionModes: []string{"onReturn", "beforeCacheExpires", "off"}}, permissions: []string{"ask", "accept_edits", "auto", "plan", "dont_ask", "full_access"}, defaultPermission: "accept_edits", capabilities: nativeCapabilities, run: claude, discover: discoverNative, skills: nativeSkills},
	"pi":          {definition: model.ProviderType{ID: "pi", Name: "Pi", Arguments: true}, permissions: piPermissions, defaultPermission: piDefaultPermission, capabilities: model.ProviderCapabilities{Steering: true, Images: true, Files: true, DirectoryContext: true, Resume: true, Skills: true, MCP: true}, run: runPi, discover: discoverPi, skills: piSkills},
	"acp":         {definition: model.ProviderType{ID: "acp", Name: "ACP", Arguments: true}, acp: true, run: runACP, discover: discoverACP},
	"antigravity": {definition: model.ProviderType{ID: "antigravity", Name: "Antigravity", AuthMethods: []string{"oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"}}, acp: true, run: runAntigravity, discover: discoverACP},
}

func Types() []model.ProviderType {
	out := make([]model.ProviderType, 0, len(drivers))
	for _, d := range drivers {
		definition := d.definition
		definition.ConfigEnv = configVariable(definition.ID)
		out = append(out, definition)
	}
	slices.SortFunc(out, func(a, b model.ProviderType) int { return strings.Compare(a.ID, b.ID) })
	return out
}

func Capabilities(kind string) model.ProviderCapabilities {
	d := drivers[kind]
	caps := d.capabilities
	caps.MCP = caps.MCP || d.acp
	return caps
}

func ConfiguredCapabilities(config model.Provider) model.ProviderCapabilities {
	caps := Capabilities(config.Type)
	if acpSkillContext(config) {
		caps.Skills, caps.SkillContext = true, true
	}
	if config.Type == "pi" {
		caps.MCP = piAllowsMCP(config.Args)
	}
	return caps
}

func Discover(ctx context.Context, config model.Provider, cwd string) (model.Catalog, error) {
	d, ok := drivers[config.Type]
	if !ok {
		return model.Catalog{}, errors.New("unsupported provider type")
	}
	ctx, cancel := context.WithTimeout(ctx, setupTimeout(config))
	defer cancel()
	catalog, err := d.discover(ctx, config, cwd)
	catalog.Provider = config.ID
	return NormalizeCatalog(config, catalog), err
}

func Skills(ctx context.Context, config model.Provider, scope model.Scope, plan SkillPlan) ([]model.Reference, error) {
	d, ok := drivers[config.Type]
	if !ok {
		return nil, errors.New("unsupported provider type")
	}
	if d.skills == nil {
		return []model.Reference{}, nil
	}
	return d.skills(ctx, config, scope, plan)
}
