package provider

import (
	"context"
	"errors"
	"strings"
	"time"

	"lever/internal/model"
)

// Discover asks the installed runtime for its own catalog; no model API call or
// credential-file inspection is involved. Probe processes never receive a task.
func discoverNative(ctx context.Context, config model.Provider, cwd string) (model.Catalog, error) {
	id := config.Type
	catalog := model.Catalog{Provider: id, Models: []model.ModelInfo{}}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	started := time.Now()
	client, err := openDiscovery(ctx, config, cwd, nil)
	if err != nil {
		return catalog, err
	}
	defer client.close()
	catalog.Path = client.path
	if id == "claude" {
		if version, err := profileOutput(ctx, config, client.path, "--version"); err == nil {
			catalog.Version = runtimeVersion(string(version))
		}
		r := client.initial
		catalog.FastUnavailable = str(r["fast_mode_disabled_reason"])
		if catalog.FastUnavailable == "" && str(r["fast_mode_state"]) != "on" {
			catalog.FastUnavailable = "Claude did not enable Fast mode"
		}
		for _, v := range arr(r["models"]) {
			m := obj(v)
			entry := model.ModelInfo{ID: str(m["value"]), Name: str(m["displayName"]), ResolvedModel: str(m["resolvedModel"]), Default: str(m["value"]) == "default", Efforts: []string{}}
			if entry.ID == "" {
				continue
			}
			for _, e := range arr(m["supportedEffortLevels"]) {
				if m["supportsEffort"] != false {
					entry.Efforts = append(entry.Efforts, str(e))
				}
			}
			// Only advertise Fast when the runtime explicitly offers it. Other
			// models can still be selected without assuming their capabilities.
			entry.Fast, _ = m["supportsFastMode"].(bool)
			entry.Fast = entry.Fast && catalog.FastUnavailable == ""
			catalog.Models = append(catalog.Models, entry)
		}
		for _, ref := range claudeSkillReferences(r, config.ID) {
			if ref.Kind != "command" || strings.HasPrefix(ref.Name, "mcp__") {
				continue
			}
			hint := ref.ArgumentHint
			if ref.Name == "compact" && hint == "" {
				hint = "[instructions]"
			}
			catalog.Commands = append(catalog.Commands, model.NativeCommand{
				Name:         ref.Name,
				Description:  ref.Description,
				ArgumentHint: hint,
			})
		}
	} else {
		catalog.Commands = []model.NativeCommand{{Name: "compact", Description: "Summarize the current conversation"}}
		catalog.Version = runtimeVersion(str(client.initial["userAgent"]))
		list := func() ([]model.ModelInfo, error) {
			return listCodexModels(func(params object) (object, error) {
				return client.call("model/list", params)
			})
		}
		catalog.Models, err = list()
		if err != nil {
			return catalog, err
		}
		if home := str(client.initial["codexHome"]); home != "" {
			confirmed := false
			if waitForCodexCatalog(ctx, home, catalog.Version, started) {
				if refreshed, err := list(); err == nil && len(refreshed) > 0 {
					catalog.Models = refreshed
					confirmed = true
				}
			}
			catalog.Provisional = !confirmed && usesCodexRemoteCatalog(client, cwd)
		}
		if codexGoalsEnabled(client.call) {
			catalog.Commands = append(catalog.Commands, model.NativeCommand{Name: "goal", Description: "Manage this session's goal", ArgumentHint: "[objective | pause | resume | clear]"})
		}
	}
	if len(catalog.Models) == 0 {
		return catalog, errors.New("runtime returned no models")
	}
	mergeCatalog(&catalog, bundledModels[id])
	return catalog, nil
}

// A file-backed or local catalog can be complete without a shared cache write.
// A command-authenticated provider can fetch remote models even with no account.
func usesCodexRemoteCatalog(client *nativeClient, cwd string) bool {
	params := object{"includeLayers": false}
	if cwd != "" {
		params["cwd"] = cwd
	}
	response, err := client.call("config/read", params)
	if err != nil {
		return true
	}
	config := obj(response["config"])
	if config["model_catalog_json"] != nil {
		return false
	}
	id := str(config["model_provider"])
	if id == "" {
		id = "openai"
	}
	if obj(obj(config["model_providers"])[id])["auth"] != nil {
		return true
	}
	account, err := client.call("account/read", object{})
	if err != nil {
		return true
	}
	switch str(obj(account["account"])["type"]) {
	case "chatgpt":
		return true
	case "apiKey", "amazonBedrock":
		return false
	default:
		return account["requiresOpenaiAuth"] != false
	}
}
