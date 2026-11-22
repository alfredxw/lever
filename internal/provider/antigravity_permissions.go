package provider

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"lever/internal/model"
)

type antigravityPreset struct {
	id, mode, nativeMode, toolPermission string
	sandbox                              bool
}

const antigravityTurbo = "turbo"

var antigravityPresets = []antigravityPreset{
	{id: "request-review", mode: "request_review", nativeMode: "default", toolPermission: "request-review"},
	{id: "default", mode: "ask", nativeMode: "default", toolPermission: "proceed-in-sandbox", sandbox: true},
	{id: "auto", mode: "auto", nativeMode: "auto", toolPermission: "request-review", sandbox: true},
	{id: antigravityTurbo, mode: "full_access", nativeMode: "default", toolPermission: "always-proceed"},
}

func antigravityCLIPreset(id string) *antigravityPreset {
	for i := range antigravityPresets {
		if antigravityPresets[i].id == id {
			return &antigravityPresets[i]
		}
	}
	return nil
}

func antigravityPermissions(config model.Provider, catalog model.Catalog) model.Catalog {
	native := slices.Concat(catalog.Permissions, catalog.LegacyPermissions)
	catalog.Permissions, catalog.LegacyPermissions = []model.PermissionInfo{}, nil
	cli := IsAntigravityCLI(config, catalog.Path)
	hasMode := func(id string) bool {
		return slices.ContainsFunc(native, func(option model.PermissionInfo) bool { return option.ID == id })
	}
	showPresets := cli && hasMode("default")
	if showPresets {
		for _, preset := range antigravityPresets {
			if hasMode(preset.nativeMode) {
				catalog.Permissions = append(catalog.Permissions, model.PermissionInfo{ID: preset.id, Mode: preset.mode, NextTurnOnly: true})
			}
		}
		if !hasMode(catalog.DefaultPermission) || antigravityCLIPreset(catalog.DefaultPermission) == nil {
			catalog.DefaultPermission = "default"
		}
	}
	for _, option := range native {
		switch option.ID {
		case "accept-edits", "auto_edit":
			option.Mode = "accept_edits"
		case "plan":
			option.Mode = "plan"
		case "yolo":
			option.Mode = "full_access"
		default:
			if preset := antigravityCLIPreset(option.ID); preset != nil {
				if showPresets {
					continue
				}
				option.Mode = preset.mode
			}
		}
		if showPresets || option.ID == "accept-edits" || option.ID == "auto_edit" || option.ID == "plan" {
			catalog.LegacyPermissions = append(catalog.LegacyPermissions, option)
		} else {
			catalog.Permissions = append(catalog.Permissions, option)
		}
	}
	return catalog
}

func antigravityCLIHome(cwd string) (string, error) {
	if dir := os.Getenv("GEMINI_HOME"); dir != "" {
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(cwd, dir)
		}
		return dir, nil
	}
	home, err := os.UserHomeDir()
	return filepath.Join(home, ".gemini"), err
}

// agy's ACP command reads settings from its CLI subdirectory. A per-turn copy
// changes the preset without changing the account, conversation store, or user settings.
func antigravityPresetArgs(cwd string, preset *antigravityPreset) ([]string, func(), error) {
	geminiDir, err := antigravityCLIHome(cwd)
	if err != nil {
		return nil, nil, err
	}
	cliDir := filepath.Join(geminiDir, "antigravity-cli")
	settings := object{}
	data, err := os.ReadFile(filepath.Join(cliDir, "settings.json"))
	if err == nil {
		if err := json.Unmarshal(data, &settings); err != nil || settings == nil {
			return nil, nil, errors.New("Antigravity CLI settings.json must contain a valid JSON object")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	settings["toolPermission"] = preset.toolPermission
	settings["enableTerminalSandbox"] = preset.sandbox
	if preset.id == antigravityTurbo {
		settings["allowNonWorkspaceAccess"] = true
	}
	if err := os.MkdirAll(cliDir, 0700); err != nil {
		return nil, nil, err
	}
	dir, err := os.MkdirTemp(cliDir, ".lever-permissions-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(pretty(settings)), 0600); err != nil {
		cleanup()
		return nil, nil, err
	}
	args := []string{"--gemini-dir", geminiDir, "--cli_dir_name", filepath.Base(dir)}
	if preset.id == antigravityTurbo {
		args = append(args, "--dangerously-skip-permissions", "--sandbox=false")
	}
	return args, cleanup, nil
}
