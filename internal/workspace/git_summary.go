package workspace

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"lever/internal/model"
)

const (
	maxSummaryUntrackedFiles      = 200
	maxSummaryUntrackedFileBytes  = 1 << 20
	maxSummaryUntrackedTotalBytes = 8 << 20
	binaryProbeBytes              = 8000
)

// GitSummary reads branch metadata and uncommitted line/file totals for a scope
// root without taking optional Git locks or writing objects to .git.
func GitSummary(ctx context.Context, root model.Root) (model.GitRootSummary, error) {
	repo, rel, err := repository(ctx, root.Path)
	if err != nil {
		return model.GitRootSummary{}, err
	}
	summary := model.GitRootSummary{Root: root}
	out, err := gitReadOnly(ctx, repo, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", rel)
	if err != nil {
		return model.GitRootSummary{}, err
	}
	tracked := 0
	var untracked []string
	tokens := strings.Split(string(out), "\x00")
	for i := 0; i < len(tokens); i++ {
		entry := tokens[i]
		if entry == "" {
			continue
		}
		switch {
		case strings.HasPrefix(entry, "# "):
			parseStatusHeader(&summary, entry)
		case strings.HasPrefix(entry, "1 "), strings.HasPrefix(entry, "u "):
			tracked++
		case strings.HasPrefix(entry, "2 "):
			tracked++
			// Rename/copy records carry an extra NUL-delimited original path.
			if i+1 < len(tokens) {
				i++
			}
		case strings.HasPrefix(entry, "? "):
			path := entry[2:]
			// Untracked directories with trailing "/" represent nested Git repositories.
			if strings.HasSuffix(path, "/") {
				continue
			}
			untracked = append(untracked, path)
		}
	}
	summary.Files = tracked + len(untracked)
	if tracked > 0 {
		base := summary.Head
		if base == "" {
			empty, err := readOnlyEmptyTree(ctx, repo)
			if err != nil {
				return model.GitRootSummary{}, err
			}
			base = empty
		}
		added, deleted, err := trackedNumstat(ctx, repo, rel, base)
		if err != nil {
			return model.GitRootSummary{}, err
		}
		summary.Additions += added
		summary.Deletions += deleted
	}
	if len(untracked) > 0 {
		added, truncated := countUntrackedAdditions(ctx, repo, untracked)
		summary.Additions += added
		summary.Truncated = truncated
	}
	return summary, nil
}

func parseStatusHeader(summary *model.GitRootSummary, line string) {
	switch {
	case strings.HasPrefix(line, "# branch.oid "):
		oid := strings.TrimPrefix(line, "# branch.oid ")
		if oid != "(initial)" {
			summary.Head = oid
		}
	case strings.HasPrefix(line, "# branch.head "):
		head := strings.TrimPrefix(line, "# branch.head ")
		if head != "(detached)" {
			summary.Branch = head
		}
	case strings.HasPrefix(line, "# branch.upstream "):
		summary.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
	case strings.HasPrefix(line, "# branch.ab "):
		fields := strings.Fields(strings.TrimPrefix(line, "# branch.ab "))
		if len(fields) == 2 {
			summary.Ahead, _ = strconv.Atoi(strings.TrimPrefix(fields[0], "+"))
			summary.Behind, _ = strconv.Atoi(strings.TrimPrefix(fields[1], "-"))
		}
	}
}

func readOnlyEmptyTree(ctx context.Context, repo string) (string, error) {
	b, err := gitReadOnly(ctx, repo, "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func trackedNumstat(ctx context.Context, repo, rel, base string) (int, int, error) {
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--numstat", "-z", base, "--", rel}
	b, err := gitReadOnly(ctx, repo, args...)
	if err != nil {
		return 0, 0, err
	}
	var added, deleted int
	for _, record := range strings.Split(string(b), "\x00") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\t", 3)
		if len(parts) != 3 {
			return 0, 0, errors.New("invalid Git diff statistics")
		}
		if parts[0] == "-" || parts[1] == "-" {
			continue
		}
		a, _ := strconv.Atoi(parts[0])
		d, _ := strconv.Atoi(parts[1])
		added += a
		deleted += d
	}
	return added, deleted, nil
}

func countUntrackedAdditions(ctx context.Context, repo string, paths []string) (int, bool) {
	var totalLines int
	var totalBytes int64
	truncated := false
	for idx, relPath := range paths {
		if ctx.Err() != nil {
			return totalLines, true
		}
		if idx >= maxSummaryUntrackedFiles {
			return totalLines, true
		}
		fullPath := filepath.Join(repo, filepath.FromSlash(relPath))
		if !Contains(repo, fullPath) {
			continue
		}
		info, err := os.Lstat(fullPath)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			totalLines++
			continue
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			continue
		}
		if info.Size() > maxSummaryUntrackedFileBytes || totalBytes+info.Size() > maxSummaryUntrackedTotalBytes {
			truncated = true
			continue
		}
		data, err := readBoundedFile(fullPath, maxSummaryUntrackedFileBytes)
		if err != nil {
			if errors.Is(err, errFileTooLarge) {
				truncated = true
			}
			continue
		}
		totalBytes += int64(len(data))
		if len(data) == 0 {
			continue
		}
		probe := data
		if len(probe) > binaryProbeBytes {
			probe = probe[:binaryProbeBytes]
		}
		if bytes.IndexByte(probe, 0) >= 0 {
			continue
		}
		lines := bytes.Count(data, []byte{'\n'})
		if data[len(data)-1] != '\n' {
			lines++
		}
		totalLines += lines
	}
	return totalLines, truncated
}

var errFileTooLarge = errors.New("file exceeds summary limit")

func readBoundedFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errFileTooLarge
	}
	return data, nil
}
