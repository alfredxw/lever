package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"lever/internal/model"
	"lever/internal/workspace"
)

type skillManifestEntry struct {
	Path    string   `json:"path"`
	Include []string `json:"include_only"`
	Exclude []string `json:"exclude"`
}

func skillPattern(patterns []string) func(string) bool {
	var expressions []*regexp.Regexp
	for _, pattern := range patterns {
		expr, err := regexp.Compile("^(?:" + pattern + ")$")
		if err != nil {
			expr = regexp.MustCompile("^" + regexp.QuoteMeta(pattern) + "$")
		}
		expressions = append(expressions, expr)
	}
	return func(name string) bool {
		return slices.ContainsFunc(expressions, func(expr *regexp.Regexp) bool { return expr.MatchString(name) })
	}
}

func (entry skillManifestEntry) filter(parent func(string) bool) func(string) bool {
	include, exclude := skillPattern(entry.Include), skillPattern(entry.Exclude)
	return func(name string) bool {
		return parent(name) && (len(entry.Include) == 0 || include(name)) && !exclude(name)
	}
}

func addManifestSkills(ctx context.Context, manifest, base string, root model.Root, add func(skillDirectory)) error {
	const maxManifest = 128 << 10
	remainingBytes, remainingEntries := 2<<20, 10000
	budgetError := errors.New("Antigravity skills.json exceeds the skill discovery limit")
	ancestry := map[string]bool{}
	resolve := func(base, path string) string {
		if path == "" {
			return ""
		}
		if path == "~" || strings.HasPrefix(filepath.ToSlash(path), "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return ""
			}
			path = filepath.Join(home, strings.TrimPrefix(filepath.ToSlash(path[1:]), "/"))
		} else if !filepath.IsAbs(path) {
			path = filepath.Join(base, path)
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil || (root.Path != "" && !workspace.Contains(root.Path, real)) {
			return ""
		}
		return real
	}
	var scan func(string, string, func(string) bool) error
	scan = func(path, base string, allowed func(string) bool) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == "" || ancestry[path] || len(ancestry) >= 10 {
			return nil
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		limit := min(maxManifest, remainingBytes)
		if info.Size() > int64(limit) {
			return budgetError
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
		file.Close()
		if err != nil {
			return err
		}
		if len(data) > limit {
			return budgetError
		}
		remainingBytes -= len(data)
		var config struct{ Inherits, Entries []skillManifestEntry }
		if json.Unmarshal(data, &config) != nil {
			return nil
		}
		remainingEntries -= 1 + len(config.Entries) + len(config.Inherits)
		if remainingEntries < 0 {
			return budgetError
		}
		ancestry[path] = true
		defer delete(ancestry, path)
		for _, entry := range config.Inherits {
			next := resolve(base, entry.Path)
			if err := scan(next, filepath.Dir(next), entry.filter(allowed)); err != nil {
				return err
			}
		}
		for _, entry := range config.Entries {
			dir := resolve(base, entry.Path)
			if info, err := os.Stat(dir); err != nil || !info.IsDir() {
				continue
			}
			matches := entry.filter(allowed)
			if skillDirectoryAvailable(dir) {
				if matches(filepath.Base(dir)) {
					add(skillDirectory{path: dir, root: root, packageOnly: true})
				}
				continue
			}
			collection, err := os.Open(dir)
			if err != nil {
				continue
			}
			children, err := collection.ReadDir(remainingEntries + 1)
			collection.Close()
			if err != nil && !errors.Is(err, io.EOF) {
				continue
			}
			remainingEntries -= len(children)
			if remainingEntries < 0 {
				return budgetError
			}
			for _, child := range children {
				if err := ctx.Err(); err != nil {
					return err
				}
				if matches(child.Name()) {
					if pkg := resolve(dir, child.Name()); pkg != "" && skillDirectoryAvailable(pkg) {
						add(skillDirectory{path: pkg, root: root, packageOnly: true})
					}
				}
			}
		}
		return nil
	}
	return scan(resolve(base, manifest), base, func(string) bool { return true })
}
