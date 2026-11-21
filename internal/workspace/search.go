package workspace

import (
	"cmp"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"lever/internal/model"
)

// Search ranks filenames and relative paths across all roots before limiting
// results. Git supplies ignore rules; ordinary directories stay inside os.Root.
func Search(ctx context.Context, profile model.Scope, query string) ([]model.Reference, error) {
	type match struct {
		reference  model.Reference
		tier, cost int
	}
	compare := func(a, b match) int {
		return cmp.Or(
			cmp.Compare(a.tier, b.tier), cmp.Compare(a.cost, b.cost),
			strings.Compare(a.reference.Name, b.reference.Name), strings.Compare(a.reference.Path, b.reference.Path),
		)
	}
	matches := []match{}
	query = strings.TrimPrefix(strings.ToLower(strings.ReplaceAll(strings.TrimSpace(query), "\\", "/")), "./")
	seen := map[string]bool{}
	for _, scope := range profile.Roots {
		err := visitFiles(ctx, scope.Path, func(path string) bool {
			tier, cost := rankFile(path, query)
			if tier < 0 || len(matches) < 40 {
				return tier >= 0
			}
			// Only stat paths that can still improve the bounded result set.
			last := matches[len(matches)-1]
			return tier < last.tier || (tier == last.tier && cost <= last.cost)
		}, func(_ *os.Root, path string, _ fs.FileInfo) error {
			absolute := filepath.Join(scope.Path, filepath.FromSlash(path))
			if seen[absolute] {
				return nil
			}
			seen[absolute] = true
			tier, cost := rankFile(path, query)
			candidate := match{model.Reference{Kind: "file", Name: path, Path: absolute, Description: scope.Path}, tier, cost}
			index, _ := slices.BinarySearchFunc(matches, candidate, compare)
			if index < 40 {
				matches = slices.Insert(matches, index, candidate)
				if len(matches) > 40 {
					matches = matches[:40]
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	result := make([]model.Reference, len(matches))
	for i, match := range matches {
		result[i] = match.reference
	}
	return result, ctx.Err()
}

func rankFile(path, query string) (tier, cost int) {
	path = strings.ToLower(path)
	name := path[strings.LastIndexByte(path, '/')+1:]
	penalty := len(path)
	switch {
	case query == "":
		return 0, strings.Count(path, "/")*100 + penalty
	case name == query || path == query:
		return 0, penalty
	case strings.HasPrefix(name, query):
		return 1, penalty
	case strings.Contains(name, query):
		return 2, strings.Index(name, query)*2 + penalty
	case strings.HasPrefix(path, query):
		return 3, penalty
	case strings.Contains(path, query):
		return 4, strings.Index(path, query)*2 + penalty
	}
	// Subsequence matches support abbreviations such as cmpin -> ComposerInput.
	letters := []rune(query)
	for i, value := range []string{name, path} {
		remaining := letters
		first, last := -1, 0
		for position, char := range []rune(value) {
			if char != remaining[0] {
				continue
			}
			if first == -1 {
				first = position
			}
			last = position
			remaining = remaining[1:]
			if len(remaining) == 0 {
				return 5 + i, first*2 + (last-first+1-len(letters))*3 + penalty
			}
		}
	}
	return -1, 0
}

// Both filename suggestions and content search use the same ignore and scope
// rules. File reads stay inside os.Root, even if the filesystem changes.
func visitFiles(ctx context.Context, scope string, filter func(string) bool, visit func(*os.Root, string, fs.FileInfo) error) error {
	root, err := os.OpenRoot(scope)
	if err != nil {
		return err
	}
	defer root.Close()
	add := func(path string) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !filepath.IsLocal(path) || (filter != nil && !filter(path)) {
			return nil
		}
		info, err := root.Lstat(filepath.FromSlash(path))
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		return visit(root, path, info)
	}
	if data, gitErr := git(ctx, scope, "ls-files", "--cached", "--others", "--exclude-standard", "-z"); gitErr == nil {
		for _, path := range strings.Split(string(data), "\x00") {
			if err := add(path); err != nil {
				if errors.Is(err, fs.SkipAll) {
					return nil
				}
				return err
			}
		}
		return ctx.Err()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(walkErr, fs.ErrPermission) {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "node_modules", ".venv":
				return fs.SkipDir
			}
			return nil
		}
		return add(path)
	})
}
