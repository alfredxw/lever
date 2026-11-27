package provider

import (
	"errors"
	"slices"
	"strings"

	"lever/internal/model"
)

// Permissions lists only policies the adapter can enforce natively.
func Permissions(kind string) []string {
	return drivers[kind].permissions
}

func normalizePermissionKey(text string) string {
	text = strings.TrimSpace(strings.ToLower(text))
	if text == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(text))
	sep := false
	for _, r := range text {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '-' || r == '_' {
			if !sep && b.Len() > 0 {
				b.WriteByte('_')
				sep = true
			}
			continue
		}
		b.WriteRune(r)
		sep = false
	}
	return strings.TrimSuffix(b.String(), "_")
}

var (
	readOnlyPermissionPreference = []string{
		"read_only",
		"plan",
		"request_review",
		"ask",
	}
	askPermissionPreference = []string{
		"ask",
		"request_review",
		"default",
	}
	autoPermissionPreference = []string{
		"auto",
		"auto_review",
		"accept_edits",
		"auto_edit",
		"workspace_edit",
	}
	yoloPermissionPreference = []string{
		"full_access",
		"bypass_permissions",
		"yolo",
		"turbo",
		"auto",
		"auto_review",
		"accept_edits",
		"auto_edit",
		"workspace_edit",
	}
)

// IsCanonicalPermissionPolicy reports whether permission is a provider-agnostic
// Agent profile policy. Empty means inherit the global default permission mode.
func IsCanonicalPermissionPolicy(permission string) bool {
	switch permission {
	case "", "read_only", "ask", "auto", "full_access":
		return true
	default:
		return false
	}
}

// ValidateAgentPermission accepts provider-agnostic permission policies as well
// as legacy native permission IDs supported by the provider.
func ValidateAgentPermission(config model.Provider, permission string) error {
	if IsCanonicalPermissionPolicy(permission) {
		return nil
	}
	driver := drivers[config.Type]
	if driver.acp {
		return nil
	}
	if (permission != "" || driver.defaultPermission != "") && !slices.Contains(Permissions(config.Type), permission) {
		return errors.New("Unsupported permission policy for this provider")
	}
	return nil
}

func catalogPermissionMatch(options []model.PermissionInfo, prefs []string) string {
	for _, target := range prefs {
		for _, option := range options {
			if option.Mode != "" {
				if option.Mode == target {
					return option.ID
				}
				continue
			}
			if normalizePermissionKey(option.ID) == target || normalizePermissionKey(option.Name) == target {
				return option.ID
			}
		}
	}
	return ""
}

func canonicalPermissionPolicy(policy string) string {
	switch NormalizePermissionMode("", policy) {
	case "read_only", "plan":
		return "read_only"
	case "accept_edits", "auto":
		return "auto"
	case "full_access":
		return "full_access"
	default:
		return "ask"
	}
}

// PermissionForPolicy resolves a provider-agnostic Agent permission policy (or
// legacy provider-native ID) into a concrete native permission ID for config.
func PermissionForPolicy(config model.Provider, catalog *model.Catalog, policy string, globalMode model.DefaultPermissionMode, sameProvider bool) string {
	if policy == "" {
		if catalog != nil && len(catalog.Permissions) > 0 {
			if resolved := DefaultPermissionForCatalog(*catalog, globalMode); resolved != "" {
				return resolved
			}
		}
		return DefaultPermissionForMode(config, globalMode)
	}
	if !IsCanonicalPermissionPolicy(policy) {
		driver := drivers[config.Type]
		if !driver.acp {
			if slices.Contains(Permissions(config.Type), policy) {
				return policy
			}
		} else {
			if catalog != nil {
				for _, option := range slices.Concat(catalog.Permissions, catalog.LegacyPermissions) {
					if option.ID == policy {
						return policy
					}
				}
			}
			if sameProvider {
				return policy
			}
		}
		policy = canonicalPermissionPolicy(policy)
	}
	if drivers[config.Type].acp && catalog != nil && (len(catalog.Permissions) > 0 || len(catalog.LegacyPermissions) > 0) {
		var prefs []string
		switch policy {
		case "read_only":
			prefs = readOnlyPermissionPreference
		case "ask":
			prefs = askPermissionPreference
		case "auto":
			prefs = autoPermissionPreference
		case "full_access":
			prefs = yoloPermissionPreference
		}
		if resolved := catalogPermissionMatch(catalog.Permissions, prefs); resolved != "" {
			return resolved
		}
		if resolved := catalogPermissionMatch(catalog.LegacyPermissions, prefs); resolved != "" {
			return resolved
		}
	}
	switch policy {
	case "read_only":
		switch config.Type {
		case "codex":
			return "read_only"
		case "claude":
			return "plan"
		case "pi":
			return "ask"
		case "antigravity":
			if IsAntigravityCLI(config, config.Command) {
				return "request-review"
			}
			return ""
		default:
			return drivers[config.Type].defaultPermission
		}
	case "ask":
		switch config.Type {
		case "codex", "claude", "pi":
			return "ask"
		case "antigravity":
			if IsAntigravityCLI(config, config.Command) {
				return "default"
			}
			return ""
		default:
			return drivers[config.Type].defaultPermission
		}
	case "auto":
		return DefaultPermissionForMode(config, model.DefaultPermissionAuto)
	case "full_access":
		return DefaultPermissionForMode(config, model.DefaultPermissionYOLO)
	default:
		return DefaultPermissionForMode(config, globalMode)
	}
}

// DefaultPermissionForMode returns the static permission ID corresponding to
// the user's global Auto or YOLO default mode when no catalog is available.
func DefaultPermissionForMode(config model.Provider, mode model.DefaultPermissionMode) string {
	if mode == model.DefaultPermissionYOLO {
		switch config.Type {
		case "codex", "claude", "pi":
			return "full_access"
		case "antigravity":
			if IsAntigravityCLI(config, config.Command) {
				return antigravityTurbo
			}
			return ""
		default:
			return ""
		}
	}
	switch config.Type {
	case "codex":
		return "auto_review"
	case "claude":
		return "auto"
	case "pi":
		return "accept_edits"
	case "antigravity":
		if IsAntigravityCLI(config, config.Command) {
			return "auto"
		}
		return ""
	default:
		return drivers[config.Type].defaultPermission
	}
}

// DefaultPermissionForCatalog picks the permission option in catalog that best
// matches the user's global Auto or YOLO default mode, falling back to the
// catalog's native default when no matching option is advertised.
func DefaultPermissionForCatalog(catalog model.Catalog, mode model.DefaultPermissionMode) string {
	prefs := autoPermissionPreference
	if mode == model.DefaultPermissionYOLO {
		prefs = yoloPermissionPreference
	}
	for _, target := range prefs {
		for _, option := range catalog.Permissions {
			if option.Mode != "" {
				if option.Mode == target {
					return option.ID
				}
				continue
			}
			if normalizePermissionKey(option.ID) == target || normalizePermissionKey(option.Name) == target {
				return option.ID
			}
		}
	}
	return catalog.DefaultPermission
}

// ApplyDefaultPermission returns catalog with DefaultPermission updated to
// reflect the user's global Auto or YOLO default permission mode.
func ApplyDefaultPermission(config model.Provider, catalog model.Catalog, mode model.DefaultPermissionMode) model.Catalog {
	catalog.DefaultPermission = DefaultPermissionForCatalog(catalog, mode)
	if catalog.DefaultPermission == "" {
		catalog.DefaultPermission = DefaultPermissionForMode(config, mode)
	}
	return catalog
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
	return ResolveSelectionWithDefault(selection, fallback, config, DefaultPermissionForMode(config, model.DefaultPermissionAuto))
}

// ResolveSelectionWithDefault resolves omitted permissions using defaultPermission
// when starting fresh or switching to a different provider.
func ResolveSelectionWithDefault(selection, fallback model.Selection, config model.Provider, defaultPermission string) (model.Selection, error) {
	if selection.Provider == "" {
		selection = fallback
	}
	driver := drivers[config.Type]
	isACP := driver.acp
	if selection.Permission == "" {
		if selection.Provider == fallback.Provider && fallback.Permission != "" {
			selection.Permission = fallback.Permission
		} else if defaultPermission != "" {
			selection.Permission = defaultPermission
		} else {
			selection.Permission = driver.defaultPermission
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
