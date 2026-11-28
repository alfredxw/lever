package workspace

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"

	"lever/internal/model"
)

// SearchFiles searches literal text, ignoring case, in the Agent's current
// roots. Bounds keep a broad query from reading or returning an entire repo.
func SearchFiles(ctx context.Context, profile model.Scope, query string, content bool) (model.FileSearch, error) {
	return searchFiles(ctx, profile, query, content, "")
}

func PeerSearchFiles(ctx context.Context, profile model.Scope, query string, content bool, dataDir string) (model.FileSearch, error) {
	if dataDir == "" {
		return model.FileSearch{}, os.ErrPermission
	}
	return searchFiles(ctx, profile, query, content, dataDir)
}
func searchFiles(ctx context.Context, profile model.Scope, query string, content bool, dataDir string) (model.FileSearch, error) {
	result := model.FileSearch{Matches: []model.FileMatch{}}
	if query == "" {
		return result, ctx.Err()
	}
	pattern, err := regexp.Compile("(?i)" + regexp.QuoteMeta(query))
	if err != nil {
		return result, err
	}
	seen := map[string]bool{}
	files, bytesRead := 0, int64(0)
	add := func(match model.FileMatch) bool {
		if len(result.Matches) == 200 {
			result.Truncated = true
			return false
		}
		result.Matches = append(result.Matches, match)
		return true
	}
	for _, scope := range profile.Roots {
		var filter func(string) bool
		if dataDir != "" {
			filter = func(path string) bool { return peerPathAllowed(filepath.Join(scope.Path, path), dataDir, false) }
		}
		err := visitFiles(ctx, scope.Path, filter, func(root *os.Root, path string, info fs.FileInfo) error {
			absolute := filepath.Join(scope.Path, filepath.FromSlash(path))
			if seen[absolute] {
				return nil
			}
			seen[absolute] = true
			files++
			if files > 20000 || bytesRead >= 64<<20 {
				result.Truncated = true
				return fs.SkipAll
			}
			if !content {
				if pattern.MatchString(path) && (dataDir == "" || PeerAllowsPath(scope.Path, path, dataDir)) && !add(model.FileMatch{RootID: scope.ID, Path: path}) {
					return fs.SkipAll
				}
				return nil
			}
			if info.Size() > MaxFileBytes {
				return nil
			}
			var data model.FileContent
			var err error
			if dataDir != "" {
				data, err = PeerFile(scope.Path, path, dataDir, nil)
			} else {
				var f *os.File
				f, err = root.Open(filepath.FromSlash(path))
				if err == nil {
					data, err = readFile(f, path)
					f.Close()
				}
			}
			bytesRead += info.Size()
			if err != nil || data.Truncated {
				return nil // Binary, non-UTF-8, or oversized text.
			}
			for line, text := range strings.Split(data.Content, "\n") {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				location := pattern.FindStringIndex(text)
				if location == nil {
					continue
				}
				// Monaco uses one-based UTF-16 columns, not UTF-8 byte offsets.
				column := len(utf16.Encode([]rune(text[:location[0]]))) + 1
				endColumn := column + len(utf16.Encode([]rune(text[location[0]:location[1]])))
				before, after := []rune(text[:location[0]]), []rune(text[location[1]:])
				prefix, suffix := "", ""
				if len(before) > 80 {
					before, prefix = before[len(before)-80:], "…"
				}
				if len(after) > 120 {
					after, suffix = after[:120], "…"
				}
				snippet := prefix + string(before) + text[location[0]:location[1]] + string(after) + suffix
				if !add(model.FileMatch{RootID: scope.ID, Path: path, Line: line + 1, Column: column, EndColumn: endColumn, Text: strings.TrimSuffix(snippet, "\r")}) {
					return fs.SkipAll
				}
			}
			return nil
		})
		if errors.Is(err, context.DeadlineExceeded) {
			result.Truncated = true
			return result, nil
		}
		if err != nil {
			return result, err
		}
		if result.Truncated {
			break
		}
	}
	return result, ctx.Err()
}
