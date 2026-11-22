package provider

import (
	"errors"
	"slices"

	"lever/internal/model"
)

// Permissions lists only policies the adapter can enforce natively.
func Permissions(kind string) []string {
	return drivers[kind].permissions
}

// NormalizeCatalog applies the current adapter's capabilities and permission
// presets to both live discovery and catalogs saved by previous builds.
func NormalizeCatalog(config model.Provider, catalog model.Catalog) model.Catalog {
	d := drivers[config.Type]
	if d.acp {
		configured := ConfiguredCapabilities(config)
		catalog.Capabilities.Skills, catalog.Capabilities.SkillContext = configured.Skills, configured.SkillContext
		if !catalog.Capabilities.Files {
			catalog.Capabilities.Files, catalog.Capabilities.FileLinksOnly = true, true
		}
		catalog.Capabilities.DirectoryContext = acpDirectoryContext(catalog.Capabilities)
		catalog.Capabilities.MCP = true
	} else {
		catalog.Capabilities = ConfiguredCapabilities(config)
		catalog.DefaultPermission = d.defaultPermission
		catalog.Permissions = make([]model.PermissionInfo, 0, len(d.permissions))
		catalog.LegacyPermissions = nil
		for _, id := range d.permissions {
			mode := id
			if id == "auto_review" {
				mode = "auto"
			}
			option := model.PermissionInfo{ID: id, Mode: mode, NextTurnOnly: config.Type == "pi"}
			switch id {
			case "read_only", "dont_ask":
				catalog.LegacyPermissions = append(catalog.LegacyPermissions, option)
			default:
				catalog.Permissions = append(catalog.Permissions, option)
			}
		}
	}
	if config.Type == "antigravity" {
		return antigravityPermissions(config, catalog)
	}
	return catalog
}

// ResolveSelection preserves omitted permissions for the same provider, including
// older stored selections. Switching providers starts with the new provider's default.
func ResolveSelection(selection, fallback model.Selection, config model.Provider) (model.Selection, error) {
	if selection.Provider == "" {
		selection = fallback
	}
	driver := drivers[config.Type]
	isACP := driver.acp
	if selection.Permission == "" {
		selection.Permission = driver.defaultPermission
		if selection.Provider == fallback.Provider && fallback.Permission != "" {
			selection.Permission = fallback.Permission
		}
	}
	if !isACP && (selection.Permission != "" || driver.defaultPermission != "") && !slices.Contains(Permissions(config.Type), selection.Permission) {
		return selection, errors.New("Unsupported permission policy for this provider")
	}
	efforts := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
	if config.Type == "pi" {
		efforts = piThinkingLevels
	}
	if !isACP && selection.Effort != "" && !slices.Contains(efforts, selection.Effort) {
		return selection, errors.New("Unsupported reasoning effort")
	}
	if isACP && selection.Fast {
		return selection, errors.New("This runtime does not support Fast mode")
	}
	return selection, nil
}
