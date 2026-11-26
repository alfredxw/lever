package provider

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/model"
)

func TestClaudeRateLimitEventFormats(t *testing.T) {
	future := time.Now().UTC().Add(3 * time.Hour).Truncate(time.Second)

	t.Run("unifiedWindows", func(t *testing.T) {
		frame := object{
			"type": "rate_limit_event",
			"rate_limit_info": object{
				"status": "allowed",
				"unifiedWindows": object{
					"five_hour": object{"utilization": 0.29, "resetsAt": float64(future.Unix())},
					"seven_day": object{"utilization": 0.145, "resetsAt": future.Add(48 * time.Hour).Format(time.RFC3339)},
				},
			},
		}
		got := claudeRateLimitEvent(frame)
		if len(got) != 2 {
			t.Fatalf("got %d windows, want 2: %+v", len(got), got)
		}
		if got[0].ID != "five_hour" || got[0].Minutes != 300 || got[0].UsedPercent != 29 || got[0].ResetsAt != future.Format(time.RFC3339) {
			t.Fatalf("unexpected five_hour window: %+v", got[0])
		}
		if got[1].ID != "seven_day" || got[1].Minutes != 10080 || got[1].UsedPercent != 14.5 {
			t.Fatalf("unexpected seven_day window: %+v", got[1])
		}
	})

	t.Run("singleWindowRateLimitType", func(t *testing.T) {
		frame := object{
			"type": "rate_limit_event",
			"rate_limit_info": object{
				"rateLimitType": "five_hour",
				"utilization":   0.625,
				"resetsAt":      float64(future.UnixMilli()),
			},
		}
		got := claudeRateLimitEvent(frame)
		if len(got) != 1 || got[0].ID != "five_hour" || got[0].UsedPercent != 62.5 || got[0].ResetsAt != future.Format(time.RFC3339) {
			t.Fatalf("unexpected single-window result: %+v", got)
		}
	})

	t.Run("ignoresMissingOrUnknown", func(t *testing.T) {
		for _, frame := range []object{
			{"type": "assistant"},
			{"type": "rate_limit_event", "rate_limit_info": object{"status": "allowed"}},
			{"type": "rate_limit_event", "rate_limit_info": object{"rateLimitType": "seven_day_opus", "utilization": 0.5}},
		} {
			if got := claudeRateLimitEvent(frame); len(got) != 0 {
				t.Fatalf("expected no windows for %+v, got %+v", frame, got)
			}
		}
	})
}

func TestCodexRolloutUsageReadsNewestLiveSampleAndSkipsShadowHome(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	future := now.Add(4 * time.Hour).Unix()
	past := now.Add(-1 * time.Hour).Unix()
	home := t.TempDir()
	dayDir := filepath.Join(home, "sessions", "2026", "11", "25")
	if err := os.MkdirAll(dayDir, 0700); err != nil {
		t.Fatal(err)
	}

	olderPath := filepath.Join(dayDir, "rollout-older.jsonl")
	olderLine := fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":35,"window_minutes":300,"resets_at":%d},"secondary":{"used_percent":12,"window_minutes":10080,"resets_at":%d}}}}`+"\n",
		now.Add(-10*time.Minute).Format(time.RFC3339Nano), future, future+86400)
	if err := os.WriteFile(olderPath, []byte(olderLine), 0600); err != nil {
		t.Fatal(err)
	}

	// Newer file with large padding (tests tail read), non-codex limit_id, expired primary, and live secondary + individual.
	newerPath := filepath.Join(dayDir, "rollout-newer.jsonl")
	var b strings.Builder
	b.WriteString(strings.Repeat(`{"type":"noise","pad":"`+strings.Repeat("x", 1024)+`"}`+"\n", 300))
	b.WriteString(fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":99,"window_minutes":300,"resets_at":%d},"secondary":{"used_percent":44,"window_minutes":10080,"resets_at":%d},"individual_limit":{"remaining_percent":80,"resets_at":%d}}}}`+"\n",
		now.Add(-2*time.Minute).Format(time.RFC3339Nano), past, future+86400, future+86400))
	// Trailing model-specific limit_id must be ignored in favor of the codex sample above it.
	b.WriteString(fmt.Sprintf(`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"premium","primary":{"used_percent":77,"window_minutes":300,"resets_at":%d}}}}`+"\n",
		now.Add(-1*time.Minute).Format(time.RFC3339Nano), future))
	if err := os.WriteFile(newerPath, []byte(b.String()), 0600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(olderPath, now.Add(-10*time.Minute), now.Add(-10*time.Minute))
	_ = os.Chtimes(newerPath, now.Add(-1*time.Minute), now.Add(-1*time.Minute))

	cfg := model.Provider{Type: "codex", ConfigDir: home}
	windows, sampledAt, ok := CodexRolloutUsage(cfg, now, 3*24*time.Hour)
	if !ok {
		t.Fatal("expected rollout usage sample")
	}
	if !sampledAt.Equal(now.Add(-2 * time.Minute)) {
		t.Fatalf("sampledAt = %v, want %v", sampledAt, now.Add(-2*time.Minute))
	}
	// Expired primary should be dropped, keeping secondary (44%) and individual (20% used).
	if len(windows) != 2 || windows[0].ID != "secondary" || windows[0].UsedPercent != 44 || windows[1].ID != "individual" || windows[1].UsedPercent != 20 {
		t.Fatalf("unexpected rollout windows: %+v", windows)
	}

	// Shadow homes share sessions/ with another account, so rollout fallback must be disabled.
	shadowCfg := model.Provider{Type: "codex", ConfigDir: home, ShadowHome: t.TempDir()}
	if _, _, ok := CodexRolloutUsage(shadowCfg, now, 3*24*time.Hour); ok {
		t.Fatal("shadow home must not read shared rollout files")
	}
}

func TestLiveUsageWindowsFiltersExpired(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	windows := []model.UsageWindow{
		{ID: "expired", UsedPercent: 90, ResetsAt: now.Add(-time.Minute).Format(time.RFC3339)},
		{ID: "boundary", UsedPercent: 80, ResetsAt: now.Format(time.RFC3339)},
		{ID: "active", UsedPercent: 30, ResetsAt: now.Add(time.Hour).Format(time.RFC3339)},
		{ID: "no-reset", UsedPercent: 10},
	}
	live := LiveUsageWindows(windows, now)
	if len(live) != 2 || live[0].ID != "active" || live[1].ID != "no-reset" {
		t.Fatalf("unexpected live windows: %+v", live)
	}
}
