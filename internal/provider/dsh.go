package provider

import (
	"context"
	"errors"
	"os"
	"slices"

	"go.yaml.in/yaml/v3"

	"lever/internal/device"
	"lever/internal/model"
)

const (
	dshFlashModel       = `["deepseek-official","deepseek-flash"]`
	dshLegacyFlashModel = `["deepseek-official","deepseek-v4-flash"]`
)

func openDSH(ctx context.Context, config model.Provider, cwd string, sink Sink) (*acpRuntime, error) {
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, err
	}
	patch, err := dshFlashPatch(ctx, path, cwd, config)
	if err != nil {
		return nil, err
	}
	if patch != "" {
		patched := config
		patched.Args = append(slices.Clone(config.Args), "--patch", patch)
		c, err := openACPWithAuth(ctx, patched, cwd, sink, nil, "")
		if err == nil {
			if c.capabilities().Images {
				c.dshFlash = true
				c.cleanup = func() { _ = os.Remove(patch) }
				return c, nil
			}
			c.close()
		}
		_ = os.Remove(patch)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Keep the original route if this installation cannot negotiate images.
	}
	return openACPWithAuth(ctx, config, cwd, sink, nil, "")
}

// Some dsh releases updated the agent's default Flash model but left the ACP
// bridge pinned to its retired ID. ACP fixes image capability at initialize.
func dshFlashPatch(ctx context.Context, path, cwd string, config model.Provider) (string, error) {
	probe, cancel := context.WithTimeout(ctx, setupTimeout(config))
	defer cancel()
	cmd := device.Command(path, "--profile", "acp", "--dump-config")
	cmd.Dir = cwd
	data, err := device.OutputCommand(probe, cmd)
	if err != nil {
		// An older launcher may only implement the ACP protocol.
		return "", ctx.Err()
	}
	var entries []struct {
		ID, Name string
		Config   yaml.Node
	}
	if yaml.Unmarshal(data, &entries) != nil {
		return "", nil
	}
	var defaults struct{ Provider, Model string }
	var bridge map[string]yaml.Node
	for _, entry := range entries {
		switch {
		case entry.ID == "agent-default-model" && entry.Name == "@deepseek-ai/dsh-agent-default-model":
			if entry.Config.Decode(&defaults) != nil {
				return "", nil
			}
		case entry.ID == "acp" && entry.Name == "@deepseek-ai/dsh-acp":
			if entry.Config.Decode(&bridge) != nil {
				return "", nil
			}
		}
	}
	if defaults.Provider != "deepseek-official" || defaults.Model != "deepseek-flash" ||
		bridge["provider"].Value != defaults.Provider || bridge["model"].Value != "deepseek-v4-flash" {
		return "", nil
	}
	// dsh replaces the whole config of a patched row. Preserve its other fields.
	bridge["model"] = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: defaults.Model}
	patch, err := yaml.Marshal([]any{map[string]any{"id": "acp", "config": bridge}})
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp("", "lever-dsh-*.yaml")
	if err != nil {
		return "", err
	}
	_, writeErr := f.Write(patch)
	if err := errors.Join(writeErr, f.Close()); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// Keep previously saved selections usable when dsh drops the old default ID
// from its catalog. Both IDs route to the same official Flash model.
func addDSHFlashAlias(catalog *model.Catalog) {
	if slices.ContainsFunc(catalog.Models, func(m model.ModelInfo) bool { return m.ID == dshLegacyFlashModel }) {
		return
	}
	for _, m := range catalog.Models {
		if m.ID == dshFlashModel {
			m.ID, m.Name, m.Default = dshLegacyFlashModel, "deepseek-v4-flash", false
			catalog.Models = append(catalog.Models, m)
			return
		}
	}
}
