package provider

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"lever/internal/workspace"
)

// A shadow home has its own login and model cache. Codex uses its native
// SQLITE_HOME for the shared database, and follows links for shared files.
func prepareCodexShadow(shared, shadow string) error {
	if !filepath.IsAbs(shared) || !filepath.IsAbs(shadow) {
		return errors.New("Codex homes must be absolute directories")
	}
	if workspace.Contains(shared, shadow) || workspace.Contains(shadow, shared) {
		return errors.New("Choose separate, non-nested Codex homes")
	}
	for _, dir := range []string{shared, shadow} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	shared, err := filepath.EvalSymlinks(shared)
	if err != nil {
		return err
	}
	shadow, err = filepath.EvalSymlinks(shadow)
	if err != nil {
		return err
	}
	if workspace.Contains(shared, shadow) || workspace.Contains(shadow, shared) {
		return errors.New("Choose separate, non-nested Codex homes")
	}
	for _, file := range []string{"auth.json", "auth.lock", "models_cache.json"} {
		info, err := os.Lstat(filepath.Join(shadow, file))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		source, _ := os.Stat(filepath.Join(shared, file))
		if !info.Mode().IsRegular() || (source != nil && os.SameFile(info, source)) {
			return fmt.Errorf("Shadow home needs its own %s", file)
		}
	}
	for _, name := range []string{"sessions", "archived_sessions", "shell_snapshots", "worktrees", "skills", "plugins", "rules", "prompts", "config.toml", "AGENTS.md"} {
		src, dst := filepath.Join(shared, name), filepath.Join(shadow, name)
		if filepath.Ext(name) == "" {
			if err := os.MkdirAll(src, 0700); err != nil {
				return err
			}
		} else if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if err := os.Symlink(src, dst); err != nil {
			if !errors.Is(err, os.ErrExist) {
				return err
			}
			target, err := filepath.EvalSymlinks(dst)
			source, srcErr := filepath.EvalSymlinks(src)
			if err != nil || srcErr != nil || source != target {
				return fmt.Errorf("Shadow home already has a different %s", name)
			}
		}
	}
	return nil
}
