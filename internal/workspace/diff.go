package workspace

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"lever/internal/device"
	"lever/internal/model"
)

var ErrNotRepository = errors.New("scope is not a Git repository")

type DiffOptions struct {
	Full             bool
	IgnoreWhitespace bool
	Path             string
}

func RecentCommits(ctx context.Context, root string) ([]model.GitCommit, error) {
	if _, _, err := repository(ctx, root); err != nil {
		return nil, err
	}
	commits := []model.GitCommit{}
	if _, err := revision(ctx, root, "HEAD"); err != nil {
		return commits, nil
	}
	b, err := git(ctx, root, "log", "-20", "-z", "--format=%H%x00%s", "--", ".")
	if err != nil {
		return nil, err
	}
	parts := strings.Split(string(b), "\x00")
	for i := 0; i+1 < len(parts); i += 2 {
		commits = append(commits, model.GitCommit{Hash: parts[i], Subject: parts[i+1]})
	}
	return commits, nil
}

func git(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return gitEnv(ctx, dir, nil, args...)
}

func gitEnv(ctx context.Context, dir string, env []string, args ...string) ([]byte, error) {
	return device.OutputEnv(ctx, "git", env, append([]string{"--literal-pathspecs", "-C", dir, "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never"}, args...)...)
}

func repository(ctx context.Context, root string) (string, string, error) {
	b, err := git(ctx, root, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", ErrNotRepository
	}
	repo := strings.TrimSpace(string(b))
	rel, err := filepath.Rel(repo, root)
	if err != nil || !Contains(repo, root) {
		return "", "", errors.New("repository is outside scope")
	}
	return repo, filepath.ToSlash(rel), nil
}

// CaptureTree uses a private copy of the index: staging, HEAD, merge state and
// worktree files are never changed. Untracked (but not ignored) files participate.
// A private ref keeps turn snapshots alive across Git garbage collection.
func CaptureTree(ctx context.Context, root, ref string) (string, error) {
	repo, rel, err := repository(ctx, root)
	if err != nil {
		return "", err
	}
	directory, err := os.MkdirTemp("", "lever-index-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(directory)
	index := filepath.Join(directory, "index")
	b, err := git(ctx, repo, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return "", err
	}
	source, err := os.Open(strings.TrimSpace(string(b)))
	if err == nil {
		defer source.Close()
		info, err := source.Stat()
		if err != nil {
			return "", err
		}
		content, err := io.ReadAll(source)
		if err != nil {
			return "", err
		}
		if err = os.WriteFile(index, content, 0600); err != nil {
			return "", err
		}
		// Git uses the index timestamp to detect same-size edits made within
		// one filesystem clock tick. A fresh copy's mtime would hide those edits.
		if err = os.Chtimes(index, info.ModTime(), info.ModTime()); err != nil {
			return "", err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	env := []string{"GIT_INDEX_FILE=" + index}
	if _, err = gitEnv(ctx, repo, env, "add", "-A", "--", rel); err != nil {
		return "", fmt.Errorf("capture workspace: %w", err)
	}
	b, err = gitEnv(ctx, repo, env, "write-tree")
	if err != nil {
		return "", fmt.Errorf("capture tree: %w", err)
	}
	tree := strings.TrimSpace(string(b))
	if ref != "" {
		if _, err = git(ctx, repo, "update-ref", ref, tree); err != nil {
			return "", err
		}
	}
	return tree, nil
}

func CheckpointRef(runID, rootID, phase string) string {
	return fmt.Sprintf("refs/lever/turns/%s/%x/%s", runID, sha256.Sum256([]byte(rootID)), phase)
}

func revision(ctx context.Context, root, ref string) (string, error) {
	if strings.TrimSpace(ref) == "" {
		return "", errors.New("revision is required")
	}
	b, err := git(ctx, root, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("invalid revision: %s", ref)
	}
	return strings.TrimSpace(string(b)), nil
}

func emptyTree(ctx context.Context, root string) (string, error) {
	b, err := git(ctx, root, "hash-object", "-w", "-t", "tree", "--stdin")
	return strings.TrimSpace(string(b)), err
}

func Diff(ctx context.Context, root, mode, base, head string, options ...DiffOptions) (model.DiffResult, error) {
	if _, _, err := repository(ctx, root); err != nil {
		return model.DiffResult{}, err
	}
	opts := DiffOptions{}
	if len(options) > 0 {
		opts = options[0]
	}
	var refs []string
	switch mode {
	case "staged":
		refs = []string{"--cached"}
	case "unstaged":
	case "", "working":
		before, err := revision(ctx, root, "HEAD")
		if err != nil {
			before, err = emptyTree(ctx, root)
		}
		if err != nil {
			return model.DiffResult{}, err
		}
		after, err := CaptureTree(ctx, root, "")
		if err != nil {
			return model.DiffResult{}, err
		}
		refs = []string{before, after}
	case "committed":
		commit, err := revision(ctx, root, head)
		if err != nil {
			return model.DiffResult{}, err
		}
		parent, err := revision(ctx, root, commit+"^")
		if err != nil {
			parent, err = emptyTree(ctx, root)
		}
		if err != nil {
			return model.DiffResult{}, err
		}
		refs = []string{parent, commit}
	case "compare", "branch":
		before, err := revision(ctx, root, base)
		if err != nil {
			return model.DiffResult{}, err
		}
		after, err := revision(ctx, root, head)
		if err != nil {
			return model.DiffResult{}, err
		}
		if mode == "branch" {
			b, err := git(ctx, root, "merge-base", before, after)
			if err != nil {
				return model.DiffResult{}, errors.New("branches have no common ancestor")
			}
			before = strings.TrimSpace(string(b))
		}
		refs = []string{before, after}
	default:
		return model.DiffResult{}, errors.New("invalid diff mode")
	}
	return diffTrees(ctx, root, refs, opts)
}

func TurnDiff(ctx context.Context, change model.RunChanges, opts DiffOptions) (model.DiffResult, error) {
	if change.Error != "" {
		return model.DiffResult{}, errors.New(change.Error)
	}
	if change.Before == "" || change.After == "" {
		return model.DiffResult{}, errors.New("turn snapshot is not available")
	}
	refs := []string{change.Before, change.After}
	if change.GitDir != "" && change.Relative != "" {
		return diffAt(ctx, change.GitDir, change.Relative, refs, opts)
	}
	return diffTrees(ctx, change.Root.Path, refs, opts)
}

func diffArgs(rel string, refs []string, opts DiffOptions) []string {
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"}
	if rel != "." {
		args = append(args, "--relative="+rel)
	}
	if opts.IgnoreWhitespace {
		args = append(args, "--ignore-all-space", "--ignore-blank-lines")
	}
	return append(args, refs...)
}

func diffFiles(ctx context.Context, root string, refs []string, opts DiffOptions) ([]model.DiffFile, error) {
	repo, rel, err := repository(ctx, root)
	if err != nil {
		return nil, err
	}
	return diffFilesAt(ctx, repo, rel, refs, opts)
}

func diffFilesAt(ctx context.Context, repo, rel string, refs []string, opts DiffOptions) ([]model.DiffFile, error) {
	args := diffArgs(rel, refs, opts)
	b, err := git(ctx, repo, append(args, "--numstat", "-z", "--", rel)...)
	if err != nil {
		return nil, err
	}
	files := []model.DiffFile{}
	for _, record := range strings.Split(string(b), "\x00") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\t", 3)
		if len(parts) != 3 {
			return nil, errors.New("invalid Git diff statistics")
		}
		added, _ := strconv.Atoi(parts[0])
		removed, _ := strconv.Atoi(parts[1])
		files = append(files, model.DiffFile{Path: parts[2], Status: "M", Additions: added, Deletions: removed, Binary: parts[0] == "-"})
	}
	b, err = git(ctx, repo, append(args, "--name-status", "-z", "--", rel)...)
	if err != nil {
		return nil, err
	}
	names := strings.Split(string(b), "\x00")
	statuses := map[string]string{}
	for i := 0; i+1 < len(names); i += 2 {
		statuses[names[i+1]] = names[i]
	}
	for i := range files {
		files[i].Status = statuses[files[i].Path]
	}
	return files, nil
}

// FinishRunChanges records the workspace at native turn completion.
func FinishRunChanges(ctx context.Context, runID string, changes []model.RunChanges) {
	for i := range changes {
		change := &changes[i]
		if change.Error != "" {
			continue
		}
		var err error
		change.After, err = CaptureTree(ctx, change.Root.Path, CheckpointRef(runID, change.Root.ID, "after"))
		if err == nil {
			change.Files, err = TurnFiles(ctx, *change)
		}
		if err != nil {
			change.Error = err.Error()
		}
	}
}

func TurnFiles(ctx context.Context, change model.RunChanges) ([]model.DiffFile, error) {
	return diffFiles(ctx, change.Root.Path, []string{change.Before, change.After}, DiffOptions{})
}

func diffTrees(ctx context.Context, root string, refs []string, opts DiffOptions) (model.DiffResult, error) {
	repo, rel, err := repository(ctx, root)
	if err != nil {
		return model.DiffResult{}, err
	}
	return diffAt(ctx, repo, rel, refs, opts)
}

func diffAt(ctx context.Context, repo, rel string, refs []string, opts DiffOptions) (model.DiffResult, error) {
	result := model.DiffResult{Repository: repo, Untracked: []string{}}
	var err error
	result.Files, err = diffFilesAt(ctx, repo, rel, refs, opts)
	if err != nil {
		return result, err
	}
	paths := []string{rel}
	if opts.Path != "" {
		found := false
		for _, file := range result.Files {
			if file.Path == opts.Path {
				found = true
				break
			}
		}
		if !found {
			return result, errors.New("file is no longer in this diff; refresh the file list")
		}
		path := filepath.ToSlash(filepath.Join(rel, opts.Path))
		// A literal file path also matches descendants if the file became a
		// directory. Exclude them so a file request always returns one patch.
		paths = []string{":(literal)" + path, ":(exclude,literal)" + path + "/"}
	} else {
		// Large reviews start with statistics only. Fetch patches one file at a
		// time instead of transferring and parsing the entire repository diff.
		if largeDiff(result.Files) {
			result.SingleFile = true
			return result, nil
		}
	}
	args := diffArgs(rel, refs, opts)
	if opts.Path != "" {
		args = append([]string{"--no-literal-pathspecs"}, args...)
	}
	if opts.Full {
		args = append(args, "--unified=2147483647")
	}
	b, err := git(ctx, repo, append(append(args, "--patch", "--"), paths...)...)
	if err != nil {
		return result, err
	}
	return withPatch(result, string(b), opts.Path)
}

func largeDiff(files []model.DiffFile) bool {
	lines := 0
	for _, file := range files {
		lines += file.Additions + file.Deletions
	}
	return len(files) > 50 || lines > 10_000
}

func withPatch(result model.DiffResult, patch, path string) (model.DiffResult, error) {
	if path == "" && len(patch) > 1<<20 {
		result.SingleFile = true
		return result, nil
	}
	if len(patch) > 8<<20 {
		return result, errors.New("file diff exceeds 8 MiB; disable full file context or open the file")
	}
	result.Patch = patch
	return result, nil
}
