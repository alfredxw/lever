package httpapi_test

import (
	"bytes"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lever/internal/model"
)

// Exercise the real HTTP -> runtime -> snapshot -> review path. The pending
// approval holds the provider open while fixture files emulate a tool's edits.
func TestTurnDiffPreservesIndexAndHistory(t *testing.T) {
	f := newFixture(t)
	git := func(args ...string) []byte {
		t.Helper()
		output, err := exec.Command("git", append([]string{"-C", f.root}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, output, err)
		}
		return output
	}
	write := func(path, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(f.root, path), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q")
	write("tracked.txt", "original\n")
	write("deleted.txt", "delete me\n")
	write(".gitignore", "ignored.txt\n")
	git("add", ".")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial")
	write("tracked.txt", "staged before turn\n")
	git("add", "tracked.txt")
	git("update-index", "--split-index")
	write("tracked.txt", "local before turn\n")
	write("ignored.txt", "private\n")
	indexPath := strings.TrimSpace(string(git("rev-parse", "--path-format=absolute", "--git-path", "index")))
	indexBefore, _ := os.ReadFile(indexPath)
	agent := f.agent("codex")
	chat := f.chat(agent)
	run := f.send(chat.ID, "main", "", "[approval]")
	f.wait(run.ID, "waiting_user")
	write("tracked.txt", "agent after turn\n")
	write("new 中文.txt", "new file\n")
	write("empty.txt", "")
	write("image.bin", "\x00\x01\x02")
	if err := os.Remove(filepath.Join(f.root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	run = f.wait(run.ID, "completed")
	if len(run.Changes) != 1 || run.Changes[0].Error != "" || len(run.Changes[0].Files) != 5 {
		t.Fatalf("missing change summary: %+v", run.Changes)
	}
	endpoint := "/agents/" + agent.ID + "/diff?mode=snapshot&root=root&run=" + run.ID
	var diff model.DiffResult
	f.request("GET", endpoint, nil, 200, &diff)
	if !strings.Contains(diff.Patch, "-local before turn") || !strings.Contains(diff.Patch, "+agent after turn") || strings.Contains(diff.Patch, "staged before turn") || strings.Contains(diff.Patch, "ignored.txt") {
		t.Fatalf("incorrect turn boundary: %s", diff.Patch)
	}
	indexAfter, _ := os.ReadFile(indexPath)
	if !bytes.Equal(indexBefore, indexAfter) {
		t.Fatal("snapshot changed the user's index")
	}
	// Later disk edits and GC cannot alter a recorded turn.
	write("tracked.txt", "edited later\n")
	git("gc", "--prune=now")
	var historical model.DiffResult
	f.request("GET", endpoint+"&full=true", nil, 200, &historical)
	if historical.Patch != diff.Patch {
		t.Fatal("historical turn changed after later edits")
	}
	var review model.TurnReview
	f.request("GET", "/agents/"+agent.ID+"/changes", nil, 200, &review)
	if len(review.Changes) != 1 || review.Changes[0].After != run.Changes[0].After || review.RunID != run.ID {
		t.Fatal("last turn does not resolve the finished execution")
	}
	f.request("GET", strings.Replace(endpoint, "mode=snapshot", "mode=turn", 1), nil, 404, nil)
	if review.TurnDiff == nil || review.TurnDiff.Reported {
		t.Fatalf("unexpected native patch for shell-only edits: %+v", review.TurnDiff)
	}
	// Existing runs contain only the directory snapshots. They still open
	// from a saved turn tab after upgrading.
	if _, err := f.a.Store.DB.Exec("UPDATE runs SET data=json_remove(data,'$.turnDiff') WHERE id=?", run.ID); err != nil {
		t.Fatal(err)
	}
	f.request("GET", strings.Replace(endpoint, "mode=snapshot", "mode=turn", 1), nil, 200, &historical)
	if historical.Patch != diff.Patch {
		t.Fatal("legacy snapshot changed")
	}
	foreign := f.agent("codex")
	f.request("GET", "/agents/"+foreign.ID+"/diff?mode=turn&root=root&run="+run.ID, nil, 404, nil)
	// A stopped execution still has a stable preview of partial edits.
	interrupted := f.send(chat.ID, "main", "", "[approval]")
	f.wait(interrupted.ID, "waiting_user")
	write("tracked.txt", "partial edit\n")
	f.request("POST", "/runs/"+interrupted.ID+"/stop", map[string]bool{}, 200, nil)
	interrupted = f.wait(interrupted.ID, "interrupted")
	if len(interrupted.Changes) != 1 || len(interrupted.Changes[0].Files) != 1 {
		t.Fatalf("partial changes lost: %+v", interrupted.Changes)
	}
}

func TestCodexTurnDiffPinsSessionAndExcludesConcurrentWrites(t *testing.T) {
	f := newFixture(t)
	if out, err := exec.Command("git", "-C", f.root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %s: %v", out, err)
	}
	agent := f.agent("codex")
	chat := f.chat(agent)
	a := f.send(chat.ID, "main", "", "[turn-diff:a.txt][approval]")
	f.wait(a.ID, "waiting_user")
	b := f.send(chat.ID, "topic", "", "[turn-diff:b.txt]")
	b = f.wait(b.ID, "completed")
	if err := os.WriteFile(filepath.Join(f.root, "external.txt"), []byte("outside the runtime\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	a = f.wait(a.ID, "completed")
	base := "/agents/" + agent.ID
	for _, want := range []struct {
		run  model.Run
		path string
	}{{a, "a.txt"}, {b, "b.txt"}} {
		var review model.TurnReview
		f.request("GET", base+"/changes?sessionId="+want.run.SessionID, nil, 200, &review)
		if review.RunID != want.run.ID || review.TurnDiff == nil || !review.TurnDiff.Reported || len(review.TurnDiff.Files) != 1 || review.TurnDiff.Files[0].Path != want.path {
			t.Fatalf("incorrect native turn summary: %+v", review)
		}
		endpoint := base + "/diff?mode=turn&root=root&sessionId=" + want.run.SessionID + "&run=" + review.RunID
		var diff model.DiffResult
		f.request("GET", endpoint+"&path="+want.path, nil, 200, &diff)
		if len(diff.Files) != 1 || diff.Files[0] != review.TurnDiff.Files[0] || !strings.Contains(diff.Patch, "+native edit") || strings.Contains(diff.Patch, "external.txt") {
			t.Fatalf("incorrect file review: %+v", diff)
		}
		f.request("GET", endpoint+"&path=external.txt", nil, 404, nil)
	}
	f.request("GET", base+"/diff?mode=turn&root=root&sessionId="+b.SessionID+"&run="+a.ID, nil, 404, nil)
	var snapshot model.DiffResult
	f.request("GET", base+"/diff?mode=snapshot&root=root&run="+a.ID, nil, 200, &snapshot)
	if len(snapshot.Files) != 1 || snapshot.Files[0].Path != "external.txt" {
		t.Fatal("directory snapshot missing concurrent write", snapshot)
	}
	cleared := f.send(chat.ID, "main", "", "[turn-diff:a.txt][clear-diff]")
	cleared = f.wait(cleared.ID, "completed")
	if cleared.TurnDiff == nil || !cleared.TurnDiff.Reported || len(cleared.TurnDiff.Files) != 0 {
		t.Fatal("empty native diff did not replace the earlier update", cleared.TurnDiff)
	}
	var empty model.DiffResult
	f.request("GET", base+"/diff?mode=turn&root=root&run="+cleared.ID, nil, 200, &empty)
	if empty.Patch != "" || len(empty.Files) != 0 {
		t.Fatal("stale patch", empty)
	}
}

func TestDiffScopesAndSubdirectoryPaths(t *testing.T) {
	f := newFixture(t)
	git := func(args ...string) {
		t.Helper()
		if output, err := exec.Command("git", append([]string{"-C", f.root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, output, err)
		}
	}
	git("init", "-q", "-b", "main")
	os.Mkdir(filepath.Join(f.root, "nested"), 0700)
	os.WriteFile(filepath.Join(f.root, "outside.txt"), []byte("outside\n"), 0600)
	os.WriteFile(filepath.Join(f.root, "nested", "file.txt"), []byte("one\ntwo\n"), 0600)
	git("add", ".")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial")
	agent := f.agent("codex")
	agent.Profile.Roots[0].Path = filepath.Join(f.root, "nested")
	f.request("PUT", "/agents/"+agent.ID, agent, 200, &agent)
	var commits []model.GitCommit
	f.request("GET", "/agents/"+agent.ID+"/commits?root=root", nil, 200, &commits)
	if len(commits) != 1 || len(commits[0].Hash) != 40 || commits[0].Subject != "initial" || commits[0].CommittedAt == "" {
		t.Fatalf("invalid commit menu: %+v", commits)
	}
	var cleanSummary []model.GitRootSummary
	f.request("GET", "/agents/"+agent.ID+"/git-summary", nil, 200, &cleanSummary)
	if len(cleanSummary) != 1 || cleanSummary[0].Root.ID != "root" || cleanSummary[0].Branch != "main" || cleanSummary[0].Files != 0 {
		t.Fatalf("invalid clean git summary: %+v", cleanSummary)
	}
	var branches model.GitBranches
	f.request("GET", "/agents/"+agent.ID+"/branches?root=root", nil, 200, &branches)
	if branches.Current != "refs/heads/main" || branches.DefaultBase != "refs/heads/main" || len(branches.Branches) != 1 {
		t.Fatalf("invalid branch choices: %+v", branches)
	}
	os.WriteFile(filepath.Join(f.root, "nested", "file.txt"), []byte("one\nchanged\n"), 0600)
	git("add", "nested/file.txt")
	os.WriteFile(filepath.Join(f.root, "nested", "file.txt"), []byte("one\nworking\n"), 0600)
	os.WriteFile(filepath.Join(f.root, "nested", "new.txt"), []byte("new\n"), 0600)
	os.WriteFile(filepath.Join(f.root, "outside.txt"), []byte("outside changed\n"), 0600)
	var dirtySummary []model.GitRootSummary
	f.request("GET", "/agents/"+agent.ID+"/git-summary", nil, 200, &dirtySummary)
	if len(dirtySummary) != 1 || dirtySummary[0].Files != 2 || dirtySummary[0].Additions != 2 || dirtySummary[0].Deletions != 1 {
		t.Fatalf("invalid dirty git summary: %+v", dirtySummary)
	}
	for mode, expected := range map[string]string{"working": "+working", "staged": "+changed", "unstaged": "+working", "committed": "+two"} {
		var diff model.DiffResult
		f.request("GET", "/agents/"+agent.ID+"/diff?root=root&mode="+mode+"&head=HEAD", nil, 200, &diff)
		if !strings.Contains(diff.Patch, expected) || strings.Contains(diff.Patch, "outside") || strings.Contains(diff.Patch, "a/nested/") {
			t.Fatalf("scope %s: %s", mode, diff.Patch)
		}
		if mode == "working" && len(diff.Files) != 2 {
			t.Fatal("untracked file missing")
		}
	}
	git("checkout", "-qb", "feature")
	git("add", "nested")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "feature")
	var branch model.DiffResult
	f.request("GET", "/agents/"+agent.ID+"/diff?root=root&mode=branch&base=main&head=HEAD", nil, 200, &branch)
	if !strings.Contains(branch.Patch, "+working") {
		t.Fatal("branch merge-base diff missing")
	}
	os.WriteFile(filepath.Join(f.root, "nested", "file.txt"), []byte("one  \nworking\n"), 0600)
	var whitespace model.DiffResult
	f.request("GET", "/agents/"+agent.ID+"/diff?"+url.Values{"root": {"root"}, "mode": {"working"}, "ignoreWhitespace": {"true"}}.Encode(), nil, 200, &whitespace)
	if len(whitespace.Files) != 0 || whitespace.Patch != "" {
		t.Fatal("whitespace was not hidden")
	}
}
