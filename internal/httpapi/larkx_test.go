package httpapi_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/plugin/builtin/larkx"
	"lever/internal/store"
)

func builtinLarkx(t *testing.T, f *fixture) model.Plugin {
	t.Helper()
	var plugins []model.Plugin
	f.request("GET", "/plugins", nil, 200, &plugins)
	var found model.Plugin
	for _, p := range plugins {
		if p.Manifest.ID == larkx.LegacyID {
			t.Fatal("legacy channel still listed", p)
		}
		if p.Manifest.ID == larkx.PluginID {
			if found.ID != "" {
				t.Fatal("duplicate built-in Larkx installation")
			}
			found = p
		}
	}
	if !found.Builtin || !found.Installed || found.Directory != "" || found.Current != nil || found.Previous != nil {
		t.Fatalf("expected a bundled Larkx installation, got %+v", found)
	}
	return found
}

func TestBuiltinLarkxStartsSignedOut(t *testing.T) {
	f := newUnconfiguredFixture(t)
	p := builtinLarkx(t, f)
	if p.ID != larkx.PluginID || !p.Enabled {
		t.Fatal(p)
	}
	url := "/plugins/" + p.ID
	var view model.PersonalChannelView
	f.request("GET", url+"/channel", nil, 200, &view)
	if view.Settings.Signature != "[Lever](https://github.com/alfredxw/lever)" {
		t.Fatalf("unexpected default reply suffix %q", view.Settings.Signature)
	}
	if larkx.Supported() {
		if view.State != "signedOut" || view.Account != "" {
			t.Fatal(view)
		}
	} else {
		if view.State != "unsupported" {
			t.Fatal(view)
		}
		f.request("POST", url+"/channel/login", map[string]string{"region": "feishu"}, 400, nil)
	}
	if _, err := os.Stat(filepath.Join(f.a.Store.Dir, "personal-channels", p.ID)); !os.IsNotExist(err) {
		t.Fatalf("opening the channel prepared an account or runtime: %v", err)
	}
	f.request("GET", "/plugins/lever.feishu/channel", nil, 404, nil)
	f.request("DELETE", url, nil, 409, nil)

	// A copy of the old directory cannot add a second listener.
	p.Manifest.ID = larkx.LegacyID
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "lever-plugin.json"), []byte(store.JSON(p.Manifest)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bridge"), nil, 0700); err != nil {
		t.Fatal(err)
	}
	f.request("POST", "/plugins", map[string]string{"directory": dir}, 409, nil)
}

func TestBuiltinLarkxReplySuffixUpgrade(t *testing.T) {
	for _, tc := range []struct{ name, saved, want string }{
		{"stock", "AI · {agent}", larkx.DefaultSignature},
		{"custom", "☕ {agent}", "☕ {agent}"},
		{"disabled", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newUnconfiguredFixture(t)
			p := builtinLarkx(t, f)
			path := "/plugins/" + p.ID + "/channel"
			var view model.PersonalChannelView
			f.request("GET", path, nil, 200, &view)
			view.Settings.Signature = tc.saved
			f.request("PUT", path, view.Settings, 200, nil)
			if _, err := f.a.Store.DB.Exec(`UPDATE plugins SET data=json_set(data,'$.manifest.version','0.2.0') WHERE id=?`, p.ID); err != nil {
				t.Fatal(err)
			}
			restartProviderFixture(t, f)
			f.request("GET", path, nil, 200, &view)
			if view.Settings.Signature != tc.want {
				t.Fatalf("upgraded suffix = %q, want %q", view.Settings.Signature, tc.want)
			}
			if tc.name == "stock" {
				// The old signature remains a valid explicit choice after the upgrade.
				view.Settings.Signature = tc.saved
				f.request("PUT", path, view.Settings, 200, nil)
				restartProviderFixture(t, f)
				f.request("GET", path, nil, 200, &view)
				if view.Settings.Signature != tc.saved {
					t.Fatal("upgrade ran twice", view.Settings.Signature)
				}
			}
		})
	}
}

func TestBuiltinLarkxSavesMarkdownSuffix(t *testing.T) {
	f := newUnconfiguredFixture(t)
	path := "/plugins/" + builtinLarkx(t, f).ID + "/channel"
	var view model.PersonalChannelView
	f.request("GET", path, nil, 200, &view)
	for _, suffix := range []string{"**{agent}** 🚀\n[项目文档](https://example.com/docs)", "https://example.com", strings.Repeat("🌍", 4000), ""} {
		view.Settings.Signature = suffix
		f.request("PUT", path, view.Settings, 200, nil)
		f.request("GET", path, nil, 200, &view)
		if view.Settings.Signature != suffix {
			t.Fatal("reply suffix did not round trip")
		}
	}
	for _, suffix := range []string{strings.Repeat("🌍", 4001), "bad\x00suffix"} {
		view.Settings.Signature = suffix
		f.request("PUT", path, view.Settings, 400, nil)
	}
}

func TestBuiltinLarkxAdoptsLegacyAccount(t *testing.T) {
	f := newFixture(t)
	p := builtinLarkx(t, f)
	agent := f.agent("codex")

	// Emulate an older database, including a prior uninstall and a disabled
	// installation with a paired account that had been listening.
	db := f.a.Store.DB
	if _, err := db.Exec("DELETE FROM plugins WHERE id=?", p.ID); err != nil {
		t.Fatal(err)
	}
	p.ID, p.Manifest.ID, p.Builtin, p.Enabled = app.ID(), larkx.LegacyID, false, false
	p.Directory = filepath.Join(t.TempDir(), "old-checkout")
	p.Current, p.Previous = &model.PluginRelease{Package: "pkg-old"}, &model.PluginRelease{Package: "pkg-older"}
	tombstone := p
	tombstone.ID, tombstone.Installed = app.ID(), false
	if _, err := db.Exec("INSERT INTO plugins(id,data) VALUES(?,?),(?,?)", tombstone.ID, store.JSON(tombstone), p.ID, store.JSON(p)); err != nil {
		t.Fatal(err)
	}
	session := app.ID()
	config := map[string]any{"Region": "lark", "Account": "123", "Session": session, "Listening": true,
		"routes": []model.PersonalChannelRoute{{AgentID: agent.ID, Commands: []string{"/review"}, Enabled: true}}}
	if _, err := db.Exec("INSERT INTO channel_connections(kind,data) VALUES(?,?)", p.ID, store.JSON(config)); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(f.a.Store.Dir, "personal-channels", p.ID, session)
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "test-account"), []byte("123"), 0600); err != nil {
		t.Fatal(err)
	}
	// Exercise the embedded launcher and all packaged runtime files without
	// contacting Feishu. Only the original session directory has the account.
	python := filepath.Join(t.TempDir(), "python")
	if err := os.WriteFile(python, []byte(`#!/bin/sh
set -eu
test "$1 $2 $3" = "-I -B -u"
test -s "$4" && test -s pyproject.toml && test -s uv.lock || exit 1
test "$5" = listen
printf '{"event":"online","account":"%s","region":"%s"}\n' "$(cat "$LEVER_CHANNEL_HOME/test-account")" "$6"
while test ! -f "$LEVER_CHANNEL_HOME/test-inbox"; do sleep .05; done
printf '{"event":"message","message":{"id":"50","sender":"123","chat":"66","kind":"dm","text":"/review hello","created":%s}}\n' "$(date +%s)"
while IFS= read -r request; do
  id=$(printf '%s' "$request" | sed 's/.*"id":"\([^"]*\)".*/\1/')
  case "$request" in *'"method":"reply"'*) printf '%s' "$request" > "$LEVER_CHANNEL_HOME/test-reply";; esac
  printf '{"id":"%s","status":"ok","remoteId":"51"}\n' "$id"
done
`), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEVER_LARKX_PYTHON", python)
	restartProviderFixture(t, f)
	adopted := builtinLarkx(t, f)
	if adopted.ID != p.ID || adopted.Enabled {
		t.Fatal("lost installation identity or enablement", adopted)
	}
	url := "/plugins/" + p.ID
	var view model.PersonalChannelView
	f.request("GET", url+"/channel", nil, 200, &view)
	if view.State != "disabled" || view.Account != "123" || view.Settings.Signature != larkx.DefaultSignature ||
		len(view.Settings.Routes) != 1 || view.Settings.Routes[0].AgentID != agent.ID {
		t.Fatal(view)
	}
	f.request("PUT", url, map[string]bool{"enabled": true}, 200, nil)
	restartProviderFixture(t, f)
	if p2 := builtinLarkx(t, f); p2.ID != p.ID || !p2.Enabled {
		t.Fatal(p2)
	}
	if larkx.Supported() {
		if err := os.WriteFile(filepath.Join(home, "test-inbox"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
			f.request("GET", url+"/channel", nil, 200, &view)
			if view.State == "online" && view.Region == "lark" && view.Account == "123" && view.Last != nil && view.Last.Status == "sent" {
				var reply struct{ Text, Signature string }
				data, err := os.ReadFile(filepath.Join(home, "test-reply"))
				if err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(data, &reply); err != nil {
					t.Fatal(err)
				}
				if reply.Signature != larkx.DefaultSignature || reply.Text == "" || strings.Contains(reply.Text, reply.Signature) {
					t.Fatalf("body and footer did not reach the adapter separately: %+v", reply)
				}
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("bundled adapter did not reply from the old account: %+v", view)
	}
}
