package cli

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"lever/internal/model"
)

func TestParseCodexAutomationTOMLAndRRule(t *testing.T) {
	dir := t.TempDir()
	taskDir := filepath.Join(dir, "sample")
	if err := os.MkdirAll(taskDir, 0o755); err != nil {
		t.Fatal(err)
	}
	toml := `version = 1
id = "sample"
kind = "cron"
name = "AI + Agent 雷达"
prompt = "第一行\n第二行 \"引用\""
status = "ACTIVE"
rrule = "RRULE:FREQ=WEEKLY;INTERVAL=1;BYHOUR=11;BYMINUTE=0;BYDAY=TU,FR"
model = "gpt-6.2-sol"
reasoning_effort = "max"
notification_policy = "failed_runs_only"
cwds = ["/tmp/repo-a", "/tmp/repo-b"]
`
	if err := os.WriteFile(filepath.Join(taskDir, "automation.toml"), []byte(toml), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "memory.md"), []byte("# memory\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := parseCodexAutomationTOML(filepath.Join(taskDir, "automation.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "sample" || got.Name != "AI + Agent 雷达" || got.Prompt != "第一行\n第二行 \"引用\"" ||
		got.Model != "gpt-6.2-sol" || got.ReasoningEffort != "max" || got.NotificationPolicy != "failed_runs_only" ||
		!got.HasMemory || !slices.Equal(got.CWDs, []string{"/tmp/repo-a", "/tmp/repo-b"}) {
		t.Fatalf("unexpected parsed automation: %+v", got)
	}

	sched, err := parseCodexRRule(got.RRule, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if sched.Time != "11:00" || sched.Timezone != "Asia/Shanghai" || !slices.Equal(sched.Weekdays, []int{2, 5}) {
		t.Fatalf("unexpected weekly schedule: %+v", sched)
	}

	daily, err := parseCodexRRule("RRULE:FREQ=WEEKLY;BYHOUR=12;BYMINUTE=15;BYDAY=SU,MO,TU,WE,TH,FR,SA", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if daily.Time != "12:15" || len(daily.Weekdays) != 0 {
		t.Fatalf("expected 7-day weekly RRULE to collapse to daily: %+v", daily)
	}

	hourly, err := parseCodexRRule("FREQ=HOURLY;INTERVAL=6;BYMINUTE=0", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if hourly.IntervalMinutes != 360 {
		t.Fatalf("expected 360m interval, got %+v", hourly)
	}
}

func TestMatchLeverAgentForCWDs(t *testing.T) {
	base := t.TempDir()
	repoA := filepath.Join(base, "a")
	repoB := filepath.Join(base, "b")
	for _, p := range []string{repoA, repoB} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	agents := []model.Agent{
		{
			ID: "parent-claude", Name: "Parent",
			Profile: model.Profile{
				Provider: "claude",
				Scope:    model.Scope{Roots: []model.Root{{ID: "r0", Path: base}}},
			},
		},
		{
			ID: "exact-codex", Name: "Exact",
			Profile: model.Profile{
				Provider: "codex",
				Scope:    model.Scope{Roots: []model.Root{{ID: "r1", Path: repoA}, {ID: "r2", Path: repoB}}},
			},
		},
	}
	matched, reason := matchLeverAgentForCWDs(agents, []string{repoA, repoB}, "codex")
	if matched == nil || matched.ID != "exact-codex" || reason != "exact_roots" {
		t.Fatalf("expected exact-codex, got %+v (%s)", matched, reason)
	}
	matched, reason = matchLeverAgentForCWDs(agents, []string{filepath.Join(base, "c")}, "codex")
	if matched == nil || matched.ID != "parent-claude" || reason != "parent_root" {
		t.Fatalf("expected parent-claude fallback, got %+v (%s)", matched, reason)
	}
}
