package provider

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/device"
	"lever/internal/model"
	"lever/internal/workspace"
)

func piCommandReferences(ctx context.Context, process *device.Process, id string) ([]model.Reference, error) {
	data, err := piRequest(ctx, process, "get_commands")
	if err != nil {
		return nil, err
	}
	var refs []model.Reference
	for _, value := range arr(data["commands"]) {
		cmd := obj(value)
		ref := model.Reference{Kind: "command", Provider: id, Name: str(cmd["name"]), Description: str(cmd["description"])}
		if ref.Name == "" {
			continue
		}
		if cmd["source"] == "skill" && strings.HasPrefix(ref.Name, "skill:") {
			ref.Kind, ref.Name, ref.Path = "skill", strings.TrimPrefix(ref.Name, "skill:"), str(obj(cmd["sourceInfo"])["path"])
		}
		refs = append(refs, ref)
	}
	return refs, nil
}

func listPiReferences(ctx context.Context, path string, config model.Provider, cwd string, args []string) ([]model.Reference, error) {
	ctx, cancel := context.WithTimeout(ctx, piSetupTimeout)
	defer cancel()
	process, err := startPi(path, config, cwd, nil, append(slices.Clone(args), "--no-session", "--offline")...)
	if err != nil {
		return nil, err
	}
	defer process.Close()
	return piCommandReferences(ctx, process, config.ID)
}

func piSkillArguments(ctx context.Context, path string, config model.Provider, cwd string, plan SkillPlan) ([]string, error) {
	var args []string
	roots := plan.Roots
	if slices.Contains(config.Args, "--no-skills") || slices.Contains(config.Args, "-ns") {
		roots = nil
	}
	if len(plan.Bundled) > 0 {
		roots = append(slices.Clone(roots), filepath.Join(plan.Assets, "skills"))
	}
	for _, root := range roots {
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			args = append(args, "--skill", root)
		}
	}
	if len(plan.Disabled) == 0 {
		return args, nil
	}
	refs, err := listPiReferences(ctx, path, config, cwd, args)
	if err != nil {
		return nil, err
	}
	args = []string{"--no-skills"}
	for _, ref := range refs {
		if ref.Kind != "skill" || model.SkillDisabled(plan.Disabled, ref.Name) || model.SkillDisabled(plan.Disabled, filepath.Base(filepath.Dir(ref.Path))) {
			continue
		}
		if !filepath.IsAbs(ref.Path) {
			return nil, fmt.Errorf("Pi did not report a path for enabled Skill %q", ref.Name)
		}
		args = append(args, "--skill", ref.Path)
	}
	return args, nil
}

func piSkills(ctx context.Context, config model.Provider, scope model.Scope, plan SkillPlan) ([]model.Reference, error) {
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, err
	}
	cwd := workspace.CWD(scope)
	args, err := piSkillArguments(ctx, path, config, cwd, plan)
	if err != nil {
		return nil, err
	}
	refs, err := listPiReferences(ctx, path, config, cwd, args)
	if err != nil {
		return nil, err
	}
	return refs, verifySkillPolicy(plan, refs)
}
