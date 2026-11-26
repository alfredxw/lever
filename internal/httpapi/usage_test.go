package httpapi_test

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func countLines(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return 0
	}
	return len(strings.Split(trimmed, "\n"))
}

func TestProviderUsageCachingSingleflightAndPersistence(t *testing.T) {
	for _, tc := range []struct {
		id         string
		wantFirst  float64
		wantUpdate float64
	}{
		{id: "codex", wantFirst: 15, wantUpdate: 48},
		{id: "claude", wantFirst: 32, wantUpdate: 71},
		{id: "antigravity", wantFirst: 25, wantUpdate: 60},
	} {
		t.Run(tc.id, func(t *testing.T) {
			f := newFixture(t)
			t.Setenv("CODEX_HOME", t.TempDir())
			t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
			countFile := filepath.Join(t.TempDir(), "probes.log")
			t.Setenv("LEVER_FIXTURE_USAGE_COUNT_FILE", countFile)
			t.Setenv("LEVER_FIXTURE_USAGE_DELAY_MS", "120")
			t.Setenv("LEVER_FIXTURE_USAGE_PERCENT", fmt.Sprintf("%.0f", tc.wantFirst))

			// Concurrent cold requests share one singleflight subprocess.
			var wg sync.WaitGroup
			results := make([]model.ProviderUsage, 4)
			for i := range results {
				wg.Add(1)
				go func(idx int) {
					defer wg.Done()
					f.request(http.MethodGet, "/providers/"+tc.id+"/usage", nil, http.StatusOK, &results[idx])
				}(i)
			}
			wg.Wait()
			if got := countLines(t, countFile); got != 1 {
				t.Fatalf("expected 1 singleflight probe, got %d", got)
			}
			for i, res := range results {
				if len(res.Windows) == 0 || res.Windows[0].UsedPercent != tc.wantFirst || res.Stale || res.SampledAt == "" {
					t.Fatalf("result[%d] = %+v, want %.0f fresh", i, res, tc.wantFirst)
				}
			}

			// Subsequent reads within TTL hit cache without spawning another CLI process.
			var cached model.ProviderUsage
			f.request(http.MethodGet, "/providers/"+tc.id+"/usage", nil, http.StatusOK, &cached)
			if got := countLines(t, countFile); got != 1 {
				t.Fatalf("cached read spawned an extra probe: count=%d", got)
			}

			// After restart with a failing probe, SQLite reading is preserved and marked stale.
			t.Setenv("LEVER_FIXTURE_USAGE_DELAY_MS", "0")
			t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "1")
			restartProviderFixture(t, f)
			var preserved model.ProviderUsage
			f.request(http.MethodGet, "/providers/"+tc.id+"/usage", nil, http.StatusOK, &preserved)
			if len(preserved.Windows) == 0 || preserved.Windows[0].UsedPercent != tc.wantFirst {
				t.Fatalf("SQLite reading was not served via SWR after restart: %+v", preserved)
			}
			// Wait for the background refresh failure to settle and verify stale fallback persists.
			deadline := time.Now().Add(5 * time.Second)
			for {
				f.request(http.MethodGet, "/providers/"+tc.id+"/usage", nil, http.StatusOK, &preserved)
				if preserved.Stale {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("failed background refresh did not mark reading stale: %+v", preserved)
				}
				time.Sleep(20 * time.Millisecond)
			}
			if preserved.Windows[0].UsedPercent != tc.wantFirst {
				t.Fatalf("stale fallback lost last reading: %+v", preserved)
			}

			// Once probe recovers, forced refresh clears stale and publishes the new reading.
			t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "0")
			t.Setenv("LEVER_FIXTURE_USAGE_PERCENT", fmt.Sprintf("%.0f", tc.wantUpdate))
			var updated model.ProviderUsage
			f.request(http.MethodGet, "/providers/"+tc.id+"/usage?refresh=true", nil, http.StatusOK, &updated)
			if updated.Stale || len(updated.Windows) == 0 || updated.Windows[0].UsedPercent != tc.wantUpdate {
				t.Fatalf("recovered usage = %+v, want %.0f fresh", updated, tc.wantUpdate)
			}
		})
	}
}

func TestProviderUsageErrorsAndNoAllowanceSemantics(t *testing.T) {
	f := newFixture(t)
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())

	// First-ever probe failure returns 500 for Codex, Claude, and agy (never silent 200 null).
	t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "1")
	for _, id := range []string{"codex", "claude", "antigravity"} {
		f.request(http.MethodGet, "/providers/"+id+"/usage", nil, http.StatusInternalServerError, nil)
	}

	// API-key or signed-out Codex returns 200 with empty windows, not an error.
	t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "0")
	t.Setenv("LEVER_FIXTURE_CODEX_ACCOUNT_TYPE", "apiKey")
	var apiKeyUsage model.ProviderUsage
	f.request(http.MethodGet, "/providers/codex/usage?refresh=true", nil, http.StatusOK, &apiKeyUsage)
	if len(apiKeyUsage.Windows) != 0 || apiKeyUsage.Stale {
		t.Fatalf("expected empty non-stale usage for API-key Codex, got %+v", apiKeyUsage)
	}
}

func TestCodexRolloutFallbackAndShadowIsolation(t *testing.T) {
	f := newFixture(t)
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "1")

	now := time.Now().UTC().Truncate(time.Second)
	dayDir := filepath.Join(codexHome, "sessions", "2026", "11", "25")
	if err := os.MkdirAll(dayDir, 0700); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":41,"window_minutes":300,"resets_at":%d}}}}`+"\n",
		now.Add(-5*time.Minute).Format(time.RFC3339Nano), now.Add(3*time.Hour).Unix())
	if err := os.WriteFile(filepath.Join(dayDir, "rollout-local.jsonl"), []byte(line), 0600); err != nil {
		t.Fatal(err)
	}

	// Cold start with failing app-server falls back to rollout sample.
	var usage model.ProviderUsage
	f.request(http.MethodGet, "/providers/codex/usage", nil, http.StatusOK, &usage)
	if len(usage.Windows) != 1 || usage.Windows[0].ID != "primary" || usage.Windows[0].UsedPercent != 41 {
		t.Fatalf("expected rollout fallback reading, got %+v", usage)
	}

	// Once a shadow-home Codex provider shares sessions/, neither provider may read rollout files.
	shadow := model.Provider{
		PluginID: "lever.codex", ContributionID: "codex", Type: "codex",
		Name: "Shadow Codex", ConfigDir: codexHome, ShadowHome: t.TempDir(), Enabled: true,
	}
	f.request(http.MethodPost, "/providers", shadow, http.StatusOK, &shadow)
	f.request(http.MethodGet, "/providers/"+shadow.ID+"/usage", nil, http.StatusInternalServerError, nil)

	// Restarting drops in-memory cache; default codex now also detects shared sessions/ and skips rollout.
	restartProviderFixture(t, f)
	f.request(http.MethodGet, "/providers/codex/usage", nil, http.StatusInternalServerError, nil)
}

func TestLiveTurnStreamUpdatesUsageCache(t *testing.T) {
	for _, tc := range []struct {
		kind        string
		mode        string
		open        func(string) (*app.App, error)
		wantUpdated float64
		wantSecond  string
	}{
		{kind: "codex", mode: "embedded", open: app.Open, wantUpdated: 64, wantSecond: "secondary"},
		{kind: "codex", mode: "worker", open: app.OpenServer, wantUpdated: 64, wantSecond: "secondary"},
		{kind: "claude", mode: "embedded", open: app.Open, wantUpdated: 42, wantSecond: "seven_day"},
		{kind: "claude", mode: "worker", open: app.OpenServer, wantUpdated: 42, wantSecond: "seven_day"},
	} {
		t.Run(tc.kind+"/"+tc.mode, func(t *testing.T) {
			f := openFixture(t, tc.open).withLocalProviders()
			t.Setenv("CODEX_HOME", t.TempDir())
			t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
			countFile := filepath.Join(t.TempDir(), "probes.log")
			t.Setenv("LEVER_FIXTURE_USAGE_COUNT_FILE", countFile)

			// Seed initial full windows (primary+secondary or five_hour+seven_day).
			var initial model.ProviderUsage
			f.request(http.MethodGet, "/providers/"+tc.kind+"/usage", nil, http.StatusOK, &initial)
			if len(initial.Windows) != 2 {
				t.Fatalf("expected 2 initial windows, got %+v", initial)
			}

			// Run a turn that emits a partial live rate-limit update.
			chat := f.chat(f.agent(tc.kind))
			f.wait(f.send(chat.ID, "main", "", "[usage-update]").ID, "completed")

			// Reading usage now reflects the live stream update merged with the untouched second window,
			// with zero extra CLI probes.
			var after model.ProviderUsage
			f.request(http.MethodGet, "/providers/"+tc.kind+"/usage", nil, http.StatusOK, &after)
			if got := countLines(t, countFile); got != 1 {
				t.Fatalf("live stream update should not trigger extra probe, count=%d", got)
			}
			if len(after.Windows) != 2 || after.Windows[0].UsedPercent != tc.wantUpdated || after.Windows[1].ID != tc.wantSecond || after.Stale {
				t.Fatalf("expected merged live usage (%.0f + %s), got %+v", tc.wantUpdated, tc.wantSecond, after)
			}

			// Persisted to SQLite across restart even if subsequent probes fail.
			t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "1")
			restartProviderFixture(t, f)
			var restarted model.ProviderUsage
			f.request(http.MethodGet, "/providers/"+tc.kind+"/usage", nil, http.StatusOK, &restarted)
			if len(restarted.Windows) != 2 || restarted.Windows[0].UsedPercent != tc.wantUpdated {
				t.Fatalf("live usage did not persist across restart: %+v", restarted)
			}
		})
	}
}

func TestDisablingProviderClearsCachedUsage(t *testing.T) {
	f := newFixture(t)
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("LEVER_FIXTURE_USAGE_PERCENT", "33")

	var first model.ProviderUsage
	f.request(http.MethodGet, "/providers/codex/usage", nil, http.StatusOK, &first)
	if len(first.Windows) != 2 || first.Windows[0].UsedPercent != 33 {
		t.Fatalf("unexpected initial usage: %+v", first)
	}

	var providers []model.ProviderInfo
	f.request(http.MethodGet, "/providers", nil, http.StatusOK, &providers)
	var codex model.Provider
	for _, p := range providers {
		if p.ID == "codex" {
			codex = p.Provider
			break
		}
	}
	codex.Enabled = false
	f.request(http.MethodPost, "/providers", codex, http.StatusOK, &codex)

	// Re-enabling with a failing probe must not resurrect pre-disable cached values.
	t.Setenv("LEVER_FIXTURE_USAGE_ERROR", "1")
	codex.Enabled = true
	f.request(http.MethodPost, "/providers", codex, http.StatusOK, &codex)
	f.request(http.MethodGet, "/providers/codex/usage", nil, http.StatusInternalServerError, nil)
}
