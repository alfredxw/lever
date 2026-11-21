package httpapi_test

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lever/internal/model"
)

func TestCodexCatalogKeepsConfirmedModelsUntilRefreshSucceeds(t *testing.T) {
	f := newFixture(t)
	configDir := t.TempDir()
	t.Setenv("CODEX_HOME", configDir)
	endpoint := "/providers/codex/models?cwd=" + url.QueryEscape(f.root)
	otherWorkspace := "/providers/codex/models?cwd=" + url.QueryEscape(t.TempDir())
	check := func(path, want string, provisional bool) {
		t.Helper()
		var catalog model.Catalog
		f.request(http.MethodGet, path, nil, http.StatusOK, &catalog)
		if len(catalog.Models) != 1 || catalog.Models[0].ID != want {
			t.Fatalf("models = %+v, want %s", catalog.Models, want)
		}
		if catalog.Provisional != provisional {
			t.Fatalf("provisional = %t, want %t", catalog.Provisional, provisional)
		}
	}
	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_MODEL", "current-model")
	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_VERSION", "1.0.0")
	check(endpoint, "current-model", false)

	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_ERROR", "1")
	restartProviderFixture(t, f)
	check(endpoint, "current-model", true)
	check(endpoint+"&refresh=true", "current-model", true)
	check(endpoint, "current-model", true)
	f.request(http.MethodGet, otherWorkspace, nil, http.StatusInternalServerError, nil)
	var other model.Provider
	f.request(http.MethodPost, "/providers", model.Provider{PluginID: "lever.codex", ContributionID: "codex", Type: "codex", Name: "Other Codex", Enabled: true}, http.StatusOK, &other)
	f.request(http.MethodGet, "/providers/"+other.ID+"/models?cwd="+url.QueryEscape(f.root), nil, http.StatusInternalServerError, nil)
	t.Setenv("CODEX_HOME", t.TempDir())
	f.request(http.MethodGet, endpoint, nil, http.StatusInternalServerError, nil)
	t.Setenv("CODEX_HOME", configDir)
	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_ERROR", "0")

	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_MODEL", "cached-model")
	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_VERSION", "")
	restartProviderFixture(t, f)
	check(endpoint+"&refresh=true", "current-model", true)
	check(endpoint, "current-model", true)
	check(otherWorkspace, "cached-model", true)

	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_MODEL", "replacement-model")
	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_VERSION", "1.0.0")
	restartProviderFixture(t, f)
	check(endpoint, "current-model", true)
	// A normal read should refresh in the background even if the picker never forces it.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var catalog model.Catalog
		f.request(http.MethodGet, endpoint, nil, http.StatusOK, &catalog)
		if !catalog.Provisional {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background refresh did not publish the replacement model")
		}
		time.Sleep(10 * time.Millisecond)
	}
	check(endpoint, "replacement-model", false)

	t.Setenv("LEVER_FIXTURE_CODEX_CATALOG_ERROR", "1")
	restartProviderFixture(t, f)
	check(endpoint+"&refresh=true", "replacement-model", true)
	f.request(http.MethodGet, otherWorkspace, nil, http.StatusInternalServerError, nil)

	cli := os.Getenv("LEVER_CODEX_PATH")
	t.Setenv("LEVER_CODEX_PATH", filepath.Join(t.TempDir(), "missing-codex"))
	restartProviderFixture(t, f)
	var unavailable *model.Catalog
	f.request(http.MethodGet, endpoint, nil, http.StatusOK, &unavailable)
	if unavailable != nil {
		t.Fatalf("expected no catalog after the runtime was removed, got %+v", unavailable)
	}
	restartProviderFixture(t, f)
	f.request(http.MethodGet, endpoint, nil, http.StatusOK, &unavailable)
	if unavailable != nil {
		t.Fatalf("removed runtime was restored from disk: %+v", unavailable)
	}
	t.Setenv("LEVER_CODEX_PATH", cli)
	check(endpoint+"&refresh=true", "replacement-model", true)
}
