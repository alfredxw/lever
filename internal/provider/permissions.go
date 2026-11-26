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

// NormalizePermissionMode maps provider-specific permission identifiers to a
// canonical cross-provider mode for permission ceilings and capability summaries.
func NormalizePermissionMode(providerType, permission string) string {
	if permission == "" {
		if d, ok := drivers[providerType]; ok && d.defaultPermission != "" {
			permission = d.defaultPermission
		} else {
			return "ask"
		}
	}
	switch permission {
	case "read_only", "plan":
		return permission
	case "ask", "request_review", "request-review", "dont_ask":
		return "ask"
	case "default":
		if providerType == "antigravity" || providerType == "acp" {
			return "ask"
		}
		return "ask"
	case "accept_edits", "accept-edits", "auto_edit":
		return "accept_edits"
	case "auto", "auto_review":
		return "auto"
	case "full_access", "turbo", "yolo":
		return "full_access"
	default:
		return "ask"
	}
}

// PermissionRank orders normalized permission modes from narrowest to broadest.
// Unknown modes rank conservatively as "ask" (1).
func PermissionRank(mode string) int {
	switch NormalizePermissionMode("", mode) {
	case "read_only", "plan":
		return 0
	case "ask":
		return 1
	case "accept_edits":
		return 2
	case "auto":
		return 3
	case "full_access":
		return 4
	default:
		return 1
	}
}

// CapPermission narrows desiredPermission so a delegated execution cannot exceed
// ceilingMode. If the target provider lacks an exact equivalent for ceilingMode,
// it steps down to the broadest supported mode within the ceiling.
func CapPermission(providerType, desiredPermission, ceilingMode string) string {
	if ceilingMode == "" {
		return desiredPermission
	}
	d, ok := drivers[providerType]
	effective := desiredPermission
	if effective == "" && ok {
		effective = d.defaultPermission
	}
	desiredRank := PermissionRank(NormalizePermissionMode(providerType, effective))
	ceilingRank := PermissionRank(ceilingMode)
	if desiredRank <= ceilingRank {
		return desiredPermission
	}
	if !ok {
		return ""
	}
	if d.acp {
		if providerType == "antigravity" {
			switch {
			case ceilingRank <= 0:
				return "request-review"
			case ceilingRank <= 2:
				return "default"
			case ceilingRank == 3:
				return "auto"
			default:
				return desiredPermission
			}
		}
		return ""
	}
	best := ""
	bestRank := -1
	for _, candidate := range d.permissions {
		rank := PermissionRank(NormalizePermissionMode(providerType, candidate))
		if rank <= ceilingRank && rank > bestRank {
			best = candidate
			bestRank = rank
		}
	}
	if best == "" {
		return "ask"
	}
	return best
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
