package app

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ResolveHostFile validates and canonicalizes an absolute or home-relative host
// file path for read-only preview. Lever's own internal state/secret files and
// dangerous host paths are rejected as not found.
func (a *App) ResolveHostFile(raw string) (string, error) {
	if raw == "" || len(raw) > 4096 || strings.ContainsRune(raw, 0) {
		return "", os.ErrNotExist
	}
	if isNetworkHostPath(raw) {
		return "", os.ErrNotExist
	}
	path := raw
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil || !filepath.IsAbs(home) {
			return "", os.ErrNotExist
		}
		path = filepath.Join(home, filepath.FromSlash(strings.ReplaceAll(path[2:], "\\", "/")))
	} else {
		path = filepath.FromSlash(path)
	}
	if !filepath.IsAbs(path) || isNetworkHostPath(path) {
		return "", os.ErrNotExist
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil || isNetworkHostPath(canonical) {
		return "", os.ErrNotExist
	}
	if a.isBlockedHostPath(canonical) {
		return "", os.ErrNotExist
	}
	return canonical, nil
}

func isNetworkHostPath(path string) bool {
	return strings.HasPrefix(path, "//") || strings.HasPrefix(path, `\\`)
}

func (a *App) isBlockedHostPath(canonical string) bool {
	if runtime.GOOS != "windows" {
		for _, blocked := range []string{"/dev/fd", "/proc/self/fd"} {
			if _, ok := hostPathWithin(blocked, canonical); ok {
				return true
			}
		}
	}
	if a.Store == nil || a.Store.Dir == "" {
		return false
	}
	storeDir, err := filepath.EvalSymlinks(a.Store.Dir)
	if err != nil {
		storeDir, err = filepath.Abs(a.Store.Dir)
		if err != nil {
			return true
		}
	}
	rel, ok := hostPathWithin(storeDir, canonical)
	if !ok {
		return false
	}
	return !isAllowedStoreArtifactPath(rel)
}

func hostPathWithin(root, target string) (string, bool) {
	if runtime.GOOS == "windows" {
		rel, err := filepath.Rel(strings.ToLower(root), strings.ToLower(target))
		if err != nil || (rel != "." && !filepath.IsLocal(rel)) {
			return "", false
		}
		// Recover original casing for relative path segments.
		orig, err := filepath.Rel(root, target)
		if err == nil && (orig == "." || filepath.IsLocal(orig)) {
			return filepath.ToSlash(orig), true
		}
		return filepath.ToSlash(rel), true
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || (rel != "." && !filepath.IsLocal(rel)) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// Inside Lever's own Store.Dir, deny by default so lever.db, channel/automation
// secrets, session MCP relays, and provider credentials/API keys are never exposed.
// Allow only explicit user note and managed provider artifact subtrees.
func isAllowedStoreArtifactPath(rel string) bool {
	if rel == "" || rel == "." {
		return false
	}
	parts := strings.Split(rel, "/")
	switch {
	case len(parts) >= 2 && parts[0] == "notes":
		return true
	case len(parts) >= 6 && parts[0] == "providers" && parts[1] == "antigravity" && parts[2] != "" && parts[3] == "antigravity-acp" && parts[4] == "brain" && parts[5] != "":
		return true
	case len(parts) >= 5 && parts[0] == "providers" && parts[1] == "codex" && parts[2] != "" && (parts[3] == "visualizations" || parts[3] == "generated_images"):
		return true
	case len(parts) == 5 && parts[0] == "sessions" && parts[1] != "" && parts[2] == "generated-images" && parts[3] != "" && parts[4] != "":
		return true
	default:
		return false
	}
}
