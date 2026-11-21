package workspace

import (
	"context"
	"errors"
	"strings"

	"lever/internal/model"
)

// Branches lists local and remote-tracking refs without fetching or checking out.
// Full ref names keep local branches distinct from similarly named remote refs.
func Branches(ctx context.Context, root string) (model.GitBranches, error) {
	result := model.GitBranches{Branches: []model.GitBranch{}}
	if _, _, err := repository(ctx, root); err != nil {
		return result, err
	}
	b, err := git(ctx, root, "for-each-ref", "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes")
	if err != nil {
		return result, err
	}
	available := map[string]bool{}
	for line := range strings.SplitSeq(strings.TrimSuffix(string(b), "\n"), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\x00")
		if len(fields) != 4 {
			return result, errors.New("invalid Git branch list")
		}
		ref, name, current, target := fields[0], fields[1], fields[2], fields[3]
		if target != "" {
			if strings.HasSuffix(ref, "/HEAD") && (result.DefaultBase == "" || ref == "refs/remotes/origin/HEAD") {
				result.DefaultBase = target
			}
			continue
		}
		result.Branches = append(result.Branches, model.GitBranch{Name: name, Ref: ref})
		available[ref] = true
		if current == "*" {
			result.Current = ref
		}
	}
	if result.Current == "" {
		if _, err := revision(ctx, root, "HEAD"); err == nil {
			result.Current = "HEAD"
			result.Branches = append(result.Branches, model.GitBranch{Name: "HEAD", Ref: "HEAD"})
			available["HEAD"] = true
		}
	}
	if !available[result.DefaultBase] {
		result.DefaultBase = ""
		for _, ref := range []string{"refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master", result.Current} {
			if available[ref] {
				result.DefaultBase = ref
				break
			}
		}
		if result.DefaultBase == "" && len(result.Branches) > 0 {
			result.DefaultBase = result.Branches[0].Ref
		}
	}
	return result, nil
}
