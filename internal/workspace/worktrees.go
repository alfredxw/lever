package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
)

func CheckoutRoot(ctx context.Context, dir string) (string, error) {
	root, _, err := repository(ctx, dir)
	if err != nil {
		return "", err
	}
	return Canonical(root)
}

func GitDir(ctx context.Context, dir string) (string, error) {
	value, err := git(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	return Canonical(strings.TrimSuffix(string(value), "\n"))
}

func CheckoutOptions(ctx context.Context, dir string) (string, []model.GitCommit, []model.GitCheckout, error) {
	head, err := revision(ctx, dir, "HEAD")
	if err != nil {
		head = ""
	}
	bases := []model.GitCommit{}
	if head != "" {
		bases = append(bases, model.GitCommit{Hash: head, Subject: "HEAD"})
	}
	refs, err := git(ctx, dir, "for-each-ref", "--format=%(objectname) %(refname:lstrip=2)", "refs/heads")
	if err != nil {
		return "", nil, nil, err
	}
	for line := range strings.SplitSeq(strings.TrimSuffix(string(refs), "\n"), "\n") {
		if sha, name, ok := strings.Cut(line, " "); ok {
			bases = append(bases, model.GitCommit{Hash: sha, Subject: name})
		}
	}
	checkouts, err := worktrees(ctx, dir)
	if err != nil {
		return "", nil, nil, err
	}
	existing := []model.GitCheckout{}
	for _, item := range checkouts {
		if path, err := Canonical(item.Path); err == nil && !item.unavailable {
			existing = append(existing, model.GitCheckout{Path: path, Branch: item.Branch})
		}
	}
	return head, bases, existing, nil
}

type checkoutEntry struct {
	model.GitCheckout
	unavailable bool
	locked      bool
}

func worktrees(ctx context.Context, dir string) ([]checkoutEntry, error) {
	b, err := git(ctx, dir, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	var result []checkoutEntry
	for record := range strings.SplitSeq(strings.TrimSuffix(string(b), "\x00\x00"), "\x00\x00") {
		var entry checkoutEntry
		for line := range strings.SplitSeq(record, "\x00") {
			key, value, _ := strings.Cut(line, " ")
			switch key {
			case "worktree":
				entry.Path = filepath.Clean(value)
			case "branch":
				entry.Branch = strings.TrimPrefix(value, "refs/heads/")
			case "detached":
				entry.Branch = "HEAD"
			case "locked":
				entry.locked = true
			case "prunable", "bare":
				entry.unavailable = true
			}
		}
		if entry.Path != "" {
			result = append(result, entry)
		}
	}
	return result, nil
}

func registeredCheckout(ctx context.Context, copy model.CopyCheckout) (*checkoutEntry, error) {
	entries, err := worktrees(ctx, copy.GitDir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Path == copy.Path {
			return &entry, nil
		}
	}
	return nil, nil
}

func PrepareCheckout(ctx context.Context, copy model.CopyCheckout) error {
	entry, err := registeredCheckout(ctx, copy)
	if err != nil {
		return err
	}
	if entry != nil && !entry.unavailable {
		if copy.Base != "" && entry.Branch != copy.Branch {
			return errors.New("the planned worktree is on a different branch")
		}
		return ValidateCheckout(ctx, copy)
	}
	if copy.Base == "" {
		return errors.New("selected checkout is unavailable")
	}
	if entry != nil {
		return errors.New("Git still lists a missing checkout; repair it with Git before retrying")
	}
	if err := os.MkdirAll(filepath.Dir(copy.Path), 0700); err != nil {
		return err
	}
	args := []string{"worktree", "add", "-b", copy.Branch, "--", copy.Path, copy.Base}
	if branch, err := revision(ctx, copy.GitDir, "refs/heads/"+copy.Branch); err == nil {
		if branch != copy.Base {
			return errors.New("the planned branch already points to another commit")
		}
		args = []string{"worktree", "add", "--", copy.Path, copy.Branch}
	}
	if _, err := git(ctx, copy.GitDir, args...); err != nil {
		return err
	}
	return ValidateCheckout(ctx, copy)
}

func ValidateCheckout(ctx context.Context, copy model.CopyCheckout) error {
	path, err := Canonical(copy.Path)
	if err != nil || path != copy.Path {
		return fmt.Errorf("checkout is unavailable: %s", copy.Path)
	}
	root, err := CheckoutRoot(ctx, path)
	if err != nil || root != path {
		return fmt.Errorf("checkout was replaced: %s", copy.Path)
	}
	dir, err := GitDir(ctx, path)
	if err != nil || dir != copy.GitDir {
		return fmt.Errorf("checkout belongs to a different repository: %s", copy.Path)
	}
	return nil
}

func ValidateOwnedCheckout(ctx context.Context, copy model.CopyCheckout) error {
	entry, err := registeredCheckout(ctx, copy)
	if err != nil {
		return err
	}
	if entry == nil || entry.unavailable || entry.Branch != copy.Branch {
		return fmt.Errorf("expected worktree %s on branch %s", copy.Path, copy.Branch)
	}
	return ValidateCheckout(ctx, copy)
}

func CheckRemovableCheckout(ctx context.Context, copy model.CopyCheckout) error {
	entry, err := registeredCheckout(ctx, copy)
	if err != nil {
		return err
	}
	if entry == nil || entry.unavailable {
		if _, err := os.Lstat(copy.Path); os.IsNotExist(err) {
			return nil // Already removed, or a checkout that never finished creating.
		}
		return errors.New("path exists without a usable Git worktree")
	}
	if err := ValidateCheckout(ctx, copy); err != nil {
		return err
	}
	if entry.locked {
		return errors.New("Git worktree is locked")
	}
	if entry.Branch != copy.Branch {
		return fmt.Errorf("check out %s to keep this worktree's commits before removing it", copy.Branch)
	}
	b, err := git(ctx, copy.Path, "status", "--porcelain", "--untracked-files=all", "--ignored", "--ignore-submodules=none")
	if err != nil {
		return err
	}
	if len(b) != 0 {
		return errors.New("worktree has local changes or ignored files")
	}
	return nil
}

func RemoveCheckout(ctx context.Context, copy model.CopyCheckout) error {
	if err := CheckRemovableCheckout(ctx, copy); err != nil {
		return err
	}
	if _, err := os.Lstat(copy.Path); os.IsNotExist(err) {
		return nil
	}
	_, err := git(ctx, copy.GitDir, "worktree", "remove", "--", copy.Path)
	return err
}

// SnapshotLocation addresses immutable Git trees even after a checkout is removed.
func SnapshotLocation(ctx context.Context, path string) (gitDir, relative string) {
	_, relative, err := repository(ctx, path)
	if err != nil {
		return "", ""
	}
	gitDir, _ = GitDir(ctx, path)
	return gitDir, relative
}
