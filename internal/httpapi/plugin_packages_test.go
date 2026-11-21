package httpapi_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"lever/internal/model"
)

// Use a real Git upload-pack and a local transport so branch/tag resolution,
// pack transfer, executable modes and subtrees are exercised offline.
type pluginRepository struct {
	t   *testing.T
	dir string
}

const pluginRepoURL = "ssh://git@plugins.example.test/team/tools"

func newPluginRepository(t *testing.T) pluginRepository {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX SSH transport and plugin fixtures")
	}
	r := pluginRepository{t, t.TempDir()}
	r.git("init", "-q", "-b", "main")
	ssh := filepath.Join(t.TempDir(), "ssh")
	if err := os.WriteFile(ssh, []byte("#!/bin/sh\nexec git-upload-pack \"$LEVER_TEST_PLUGIN_REPO\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEVER_TEST_PLUGIN_REPO", r.dir)
	t.Setenv("GIT_SSH_COMMAND", "'"+strings.ReplaceAll(ssh, "'", "'\\''")+"'")
	t.Setenv("GIT_SSH_VARIANT", "ssh")
	return r
}

func (r pluginRepository) git(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", r.dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (r pluginRepository) write(path, value string, mode os.FileMode) {
	r.t.Helper()
	target := filepath.Join(r.dir, path)
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(value), mode); err != nil {
		r.t.Fatal(err)
	}
}

func (r pluginRepository) commit(label string) string {
	r.t.Helper()
	r.git("add", "--all")
	r.git("commit", "-qm", label)
	return r.git("rev-parse", "HEAD")
}

func (f *fixture) previewPackage(p model.Plugin, body map[string]any) model.PluginPreview {
	f.t.Helper()
	path := "/plugins/preview"
	if p.ID != "" {
		path = "/plugins/" + p.ID + "/preview"
		body["revision"] = p.Revision
	}
	var pv model.PluginPreview
	f.request("POST", path, body, 200, &pv)
	return pv
}

func (f *fixture) applyPackage(pv model.PluginPreview, status int) model.Plugin {
	f.t.Helper()
	var p model.Plugin
	f.request("POST", "/plugin-previews/"+pv.ID+"/apply", nil, status, &p)
	return p
}

func TestGitPluginUpdatesPreserveNativeSessionAndReviewedBytes(t *testing.T) {
	f := newFixture(t)
	repo := newPluginRepository(t)
	m := model.PluginManifest{ManifestVersion: 1, ID: "test.git-acp", Name: "Example ACP", Version: "1", Contributes: model.PluginContributions{Providers: []model.ProviderContribution{{ID: "agent", Name: "Example connection", Driver: "acp", Command: "bin/agent", Args: []string{"--acp", "agent"}}}}}
	writeManifest := func() {
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		repo.write("packages/agent/lever-plugin.json", string(b), 0600)
	}
	writeManifest()
	repo.write("packages/agent/bin/agent", "#!/bin/sh\nexec \"$LEVER_CODEX_PATH\" \"$@\"\n", 0700)
	one := repo.commit("first")
	repo.git("tag", "-a", "stable", "-m", "release")
	input := map[string]any{"url": pluginRepoURL, "path": "packages/agent"}
	pv := f.previewPackage(model.Plugin{}, input)
	if pv.Release.Commit != one || pv.Release.Source.Ref != "main" || pv.Manifest.Contributes.Providers[0].Command != "bin/agent" {
		t.Fatal(pv)
	}
	p := f.applyPackage(pv, 200)
	f.request("POST", "/plugins/"+p.ID+"/preview", map[string]any{"revision": p.Revision, "url": "https://other.example.test/plugins"}, 400, nil)
	check := func() model.PluginUpdate {
		var u model.PluginUpdate
		f.request("GET", "/plugins/"+p.ID+"/update", nil, 200, &u)
		return u
	}
	repo.write("other-package.txt", "unrelated", 0600)
	repo.commit("unrelated")
	if check().Available {
		t.Fatal("unrelated subtree produced an update")
	}

	var c model.Provider
	f.request("POST", "/provider-candidates/"+p.ID+"/agent", nil, 200, &c)
	chat := f.chat(f.acpAgent(c))
	first := f.wait(f.send(chat.ID, "main", "", "before update").ID, "completed")
	native := acpReceipt(t, first)["native"]
	repo.write("packages/agent/version.txt", "second", 0600)
	two := repo.commit("same display version, different contents")
	u := check()
	if !u.Available || u.Commit != two {
		t.Fatal(u)
	}
	pv = f.previewPackage(p, map[string]any{"commit": u.Commit})
	stale := f.previewPackage(p, map[string]any{"commit": u.Commit})
	repo.write("packages/agent/version.txt", "unreviewed", 0600)
	repo.commit("branch advanced")
	hang := f.send(f.chat(f.acpAgent(c)).ID, "main", "", "[hang]")
	f.wait(hang.ID, "running")
	f.applyPackage(pv, 409)
	f.request("POST", "/runs/"+hang.ID+"/stop", nil, 200, nil)
	f.wait(hang.ID, "interrupted")
	f.request("PUT", "/plugins/"+p.ID, map[string]bool{"enabled": false}, 200, nil)
	updated := f.applyPackage(pv, 200)
	if updated.ID != p.ID || updated.Enabled || updated.Current.Commit != two || updated.Previous.Commit != one {
		t.Fatal(updated)
	}
	b, err := os.ReadFile(filepath.Join(updated.Directory, "version.txt"))
	if err != nil || string(b) != "second" {
		t.Fatal(string(b), err)
	}
	f.applyPackage(stale, 409)
	f.request("PUT", "/plugins/"+p.ID, map[string]bool{"enabled": true}, 200, nil)
	second := f.wait(f.send(chat.ID, "main", "", "after update").ID, "completed")
	if acpReceipt(t, second)["native"] != native || second.Handoff {
		t.Fatal("upgrade changed native session", second)
	}
	var infos []model.ProviderInfo
	f.request("GET", "/providers", nil, 200, &infos)
	for _, info := range infos {
		if info.ID == c.ID && (info.Command != "bin/agent" || !strings.HasPrefix(info.Path, updated.Directory)) {
			t.Fatal(info)
		}
	}
	m.Contributes.Providers[0].Args = append(m.Contributes.Providers[0].Args, "new-identity")
	writeManifest()
	repo.commit("breaking change")
	broken := f.previewPackage(updated, map[string]any{})
	if len(broken.Blockers) != 1 || !strings.Contains(broken.Blockers[0], c.Name) {
		t.Fatal(broken)
	}
	f.applyPackage(broken, 409)
	f.request("POST", "/plugins/"+p.ID+"/rollback", map[string]int64{"revision": p.Revision}, 409, nil)
	var rolled model.Plugin
	f.request("POST", "/plugins/"+p.ID+"/rollback", map[string]int64{"revision": updated.Revision}, 200, &rolled)
	if rolled.Current.Commit != one || rolled.ID != p.ID {
		t.Fatal(rolled)
	}
	pinned := f.applyPackage(f.previewPackage(rolled, map[string]any{"ref": "stable"}), 200)
	if pinned.Current.Source.Kind != "tag" || pinned.Current.Commit != one || pinned.Previous == nil || pinned.Previous.Commit != two || check().Available {
		t.Fatal(pinned)
	}
	restartProviderFixture(t, f)
	resumed := f.wait(f.send(chat.ID, "main", "", "after restart").ID, "completed")
	if acpReceipt(t, resumed)["native"] != native {
		t.Fatal("restart lost native session")
	}
	f.request("POST", "/plugin-previews/"+stale.ID+"/apply", nil, 409, nil)
	f.request("DELETE", "/plugins/"+p.ID, nil, 200, nil)
	if _, err := os.Stat(pinned.Directory); !os.IsNotExist(err) {
		t.Fatal("managed files remained after uninstall", err)
	}
}

func TestGitPluginChannelReusesAccountAndRoutes(t *testing.T) {
	f := newFixture(t)
	repo := newPluginRepository(t)
	repo.write("inbox/lever-plugin.json", `{"manifestVersion":1,"id":"test.git-channel","name":"Example channel","version":"1","contributes":{"channels":[{"id":"inbox","driver":"personal-stdio-v1","command":"bridge","name":"Inbox"}]}}`, 0600)
	ready := filepath.Join(t.TempDir(), "ready")
	t.Setenv("LEVER_TEST_PAIR_READY", ready)
	bridge := `#!/bin/sh
set -eu
if [ "$1" = login ]; then
  printf '{"event":"qr","qr":"fixture"}\n'
  while [ ! -e "$LEVER_TEST_PAIR_READY" ]; do sleep .02; done
  echo 100 > "$LEVER_CHANNEL_HOME/account"
fi
account=$(cat "$LEVER_CHANNEL_HOME/account")
printf '%s %s\n' "$1" "$account" >> "$LEVER_CHANNEL_HOME/starts"
printf '{"event":"online","account":"%s","region":"feishu"}\n' "$account"
while read -r line; do :; done
`
	repo.write("inbox/bridge", bridge, 0700)
	repo.commit("channel")
	p := f.applyPackage(f.previewPackage(model.Plugin{}, map[string]any{"url": pluginRepoURL, "path": "inbox"}), 200)
	path := "/plugins/" + p.ID + "/channel"
	var view model.PersonalChannelView
	f.request("GET", path, nil, 200, &view)
	agent := f.agent("codex")
	settings := view.Settings
	settings.Routes = []model.PersonalChannelRoute{{AgentID: agent.ID, Commands: []string{"/ai"}, Enabled: true}}
	f.request("PUT", path, settings, 200, nil)
	repo.write("inbox/bridge", bridge+"\n# second release\n", 0700)
	repo.commit("channel update")
	pv := f.previewPackage(p, map[string]any{})
	f.request("POST", path+"/login", map[string]string{"region": "feishu"}, 200, nil)
	waitState := func(state string) {
		t.Helper()
		for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
			f.request("GET", path, nil, 200, &view)
			if view.State == state {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("expected %s, got %+v", state, view)
	}
	waitState("pairing")
	f.applyPackage(pv, 409)
	if err := os.WriteFile(ready, nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitState("online")
	updated := f.applyPackage(pv, 200)
	waitState("online")
	if view.Account != "100" || len(view.Settings.Routes) != 1 || view.Settings.Routes[0].AgentID != agent.ID {
		t.Fatal(view)
	}
	matches, err := filepath.Glob(filepath.Join(f.a.Store.Dir, "personal-channels", p.ID, "*", "starts"))
	if err != nil || len(matches) != 1 {
		t.Fatal(matches, err)
	}
	b, err := os.ReadFile(matches[0])
	if err != nil || string(b) != "login 100\nlisten 100\n" {
		t.Fatal(string(b), err)
	}
	f.request("POST", path+"/pause", map[string]string{}, 200, nil)
	f.request("POST", "/plugins/"+p.ID+"/rollback", map[string]int64{"revision": updated.Revision}, 200, nil)
	waitState("paused")
}

func TestReloadLinkedPluginRetainsIdentityAndValidatesConnections(t *testing.T) {
	f := newFixture(t)
	dir := t.TempDir()
	m := model.PluginManifest{ManifestVersion: 1, ID: "example.linked", Name: "Linked", Version: "old", Contributes: model.PluginContributions{Providers: []model.ProviderContribution{{ID: "example", Name: "Connection", Driver: "acp", Command: os.Getenv("LEVER_CODEX_PATH"), Args: []string{"--acp", "linked"}}}}}
	write := func() {
		t.Helper()
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "lever-plugin.json"), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	var p model.Plugin
	f.request("POST", "/plugins", map[string]string{"directory": dir}, 200, &p)
	f.request("POST", "/provider-candidates/"+p.ID+"/example", nil, 200, nil)
	m.Version = "new"
	write()
	var updated model.Plugin
	f.request("POST", "/plugins/"+p.ID+"/reload", nil, 200, &updated)
	if updated.ID != p.ID || updated.Manifest.Version != "new" || updated.Current != nil || updated.Directory != p.Directory {
		t.Fatal(updated)
	}
	m.Contributes.Providers[0].Args = nil
	write()
	f.request("POST", "/plugins/"+p.ID+"/reload", nil, 409, nil)
	m.ID = "other.publisher"
	write()
	f.request("POST", "/plugins/"+p.ID+"/reload", nil, 409, nil)
	f.request("POST", "/plugins/lever.codex/reload", nil, 400, nil)
	f.request("POST", "/plugins/"+p.ID+"/preview", map[string]string{"url": pluginRepoURL}, 409, nil)
	f.request("DELETE", "/plugins/"+p.ID, nil, 200, nil)
	if _, err := os.Stat(filepath.Join(dir, "lever-plugin.json")); err != nil {
		t.Fatal(err)
	}
}
