package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"lever/internal/model"
)

func TestMergeCatalogKeepsRuntimeAliasesAndCapabilities(t *testing.T) {
	catalog := model.Catalog{Provider: "claude", Version: "2.1.10", FastUnavailable: "account", Models: []model.ModelInfo{
		{ID: "default", Default: true, ResolvedModel: "gateway/custom"},
		{ID: "opus", Name: "Gateway", ResolvedModel: "gateway/custom"},
		{ID: "claude-current", Name: "Runtime name", Efforts: []string{"low"}},
		{ID: "gateway/custom", Name: "Custom"},
		{ID: "gateway/custom", Name: "Duplicate"},
		{ID: ""},
	}}
	mergeCatalog(&catalog, []catalogModel{
		{ModelInfo: model.ModelInfo{ID: "claude-current", Name: "Bundled", Efforts: []string{"max"}, Fast: true}},
		{ModelInfo: model.ModelInfo{ID: "claude-extra", Fast: true}, MinVersion: "2.1.9"},
		{ModelInfo: model.ModelInfo{ID: "claude-future", Fast: true}, MinVersion: "2.1.11"},
	})
	if len(catalog.Models) != 6 || catalog.Models[0].ID != "default" {
		t.Fatalf("missing or duplicated models: %+v", catalog.Models)
	}
	byID := map[string]model.ModelInfo{}
	for _, m := range catalog.Models {
		byID[m.ID] = m
		if m.Efforts == nil {
			t.Fatal("efforts must serialize as an array")
		}
	}
	if m := byID["claude-current"]; m.Name != "Runtime name" || !slices.Equal(m.Efforts, []string{"low"}) || m.Fast {
		t.Fatalf("bundled metadata overrode the runtime: %+v", m)
	}
	if byID["opus"].ResolvedModel != "gateway/custom" || byID["claude-extra"].Fast || byID["claude-extra"].RequiresVersion != "" {
		t.Fatal("alias, account capability or numeric version comparison changed")
	}
	if byID["claude-future"].RequiresVersion != "2.1.11" || byID["claude-future"].Fast {
		t.Fatal("unsupported model was advertised as available")
	}
}

func TestCodexCatalogDoesNotInventAccountAccess(t *testing.T) {
	builtins := []catalogModel{{ModelInfo: model.ModelInfo{ID: "future"}, MinVersion: "0.150.0"}}
	for _, version := range []string{"", "0.99.0", "0.150.0"} {
		catalog := model.Catalog{Provider: "codex", Version: version, Models: []model.ModelInfo{{ID: "native", Default: true}}}
		mergeCatalog(&catalog, builtins)
		if version == "0.150.0" {
			if len(catalog.Models) != 1 {
				t.Fatal("model missing from account catalog should not become selectable")
			}
		} else if len(catalog.Models) != 2 || catalog.Models[1].RequiresVersion != "0.150.0" {
			t.Fatalf("missing CLI upgrade hint: %+v", catalog)
		}
	}
}

func TestCodexRemoteCatalogSources(t *testing.T) {
	for _, test := range []struct {
		name    string
		config  object
		account object
		remote  bool
	}{
		{"login could not be read", object{}, object{"requiresOpenaiAuth": true}, true},
		{"custom command-backed provider", object{"model_provider": "work", "model_providers": object{"work": object{"auth": object{"command": "login"}}}}, object{"requiresOpenaiAuth": false}, true},
		{"custom provider with ChatGPT login", object{"model_provider": "work"}, object{"account": object{"type": "chatgpt"}}, true},
		{"explicit model catalog", object{"model_catalog_json": "/configured/models.json"}, object{"account": object{"type": "chatgpt"}}, false},
		{"API key", object{}, object{"account": object{"type": "apiKey"}}, false},
		{"custom provider without login", object{"model_provider": "local"}, object{"requiresOpenaiAuth": false}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cwd := t.TempDir()
			client := &nativeClient{call: func(method string, params object) (object, error) {
				switch method {
				case "config/read":
					if params["cwd"] != cwd {
						t.Fatalf("config/read used a different project from model/list: %v", params)
					}
					return object{"config": test.config}, nil
				case "account/read":
					return test.account, nil
				default:
					t.Fatalf("unexpected request %s", method)
					return nil, nil
				}
			}}
			if got := usesCodexRemoteCatalog(client, cwd); got != test.remote {
				t.Fatalf("needs remote confirmation = %t, want %t", got, test.remote)
			}
		})
	}
}

func TestCodexCatalogPaginatesAndRejectsRepeatedCursor(t *testing.T) {
	calls := 0
	models, err := listCodexModels(func(params object) (object, error) {
		calls++
		if calls == 1 {
			return object{"data": []any{object{"model": "first"}}, "nextCursor": "next"}, nil
		}
		if params["cursor"] != "next" {
			t.Fatalf("missing pagination cursor: %+v", params)
		}
		return object{"data": []any{object{"model": "last", "supportedReasoningEfforts": []any{object{"reasoningEffort": "max"}}, "additionalSpeedTiers": []any{"fast"}}}}, nil
	})
	if err != nil || calls != 2 || len(models) != 2 || models[1].ID != "last" || !models[1].Fast || !slices.Equal(models[1].Efforts, []string{"max"}) {
		t.Fatalf("incomplete catalog: %+v, %v", models, err)
	}
	_, err = listCodexModels(func(object) (object, error) { return object{"nextCursor": "same"}, nil })
	if err == nil {
		t.Fatal("repeated cursor must terminate discovery")
	}
}

func TestCodexCatalogRefresh(t *testing.T) {
	home := t.TempDir()
	started := time.Now()
	write := func(stamp time.Time, version string) {
		t.Helper()
		data, _ := json.Marshal(object{"fetched_at": stamp, "client_version": version})
		if err := os.WriteFile(filepath.Join(home, "models_cache.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(started.Add(-time.Minute), "1.0.0")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitForCodexCatalog(ctx, home, "1.0.0", started) {
		t.Fatal("a stale cache was accepted as a fresh catalog")
	}
	write(started.Add(time.Second), "0.9.0")
	if waitForCodexCatalog(ctx, home, "1.0.0", started) {
		t.Fatal("a cache written by a different CLI version was accepted")
	}
	write(started.Add(time.Second), "1.0.0")
	if !waitForCodexCatalog(context.Background(), home, "1.0.0", started) {
		t.Fatal("a fresh cache should trigger a second model/list")
	}
}

func TestLiveCatalogs(t *testing.T) {
	if os.Getenv("LEVER_LIVE_DISCOVERY") != "1" {
		t.Skip("set LEVER_LIVE_DISCOVERY=1 for catalog-only CLI discovery (no model generation)")
	}
	for _, id := range []string{"codex", "claude"} {
		t.Run(id, func(t *testing.T) {
			catalog, err := Discover(context.Background(), model.Provider{ID: id, Type: id, Enabled: true}, "")
			if err != nil {
				t.Fatal(err)
			}
			ids := make([]string, 0, len(catalog.Models))
			for _, m := range catalog.Models {
				if m.RequiresVersion == "" {
					ids = append(ids, m.ID)
				}
			}
			t.Logf("%s %s: %d selectable models (%s)", id, catalog.Version, len(ids), catalog.Path)
			t.Log(ids)
		})
	}
}
