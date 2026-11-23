package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/cli"
	"lever/internal/model"
)

type cliTestRunView struct {
	model.Run
	PendingRequests []model.Request `json:"pendingRequests,omitempty"`
}

func TestAutomationSelectionOverridesAndPermissions(t *testing.T) {
	f := newFixture(t)
	var agent model.Agent
	f.request("POST", "/agents", model.Agent{
		Name: "Ask Codex Agent",
		Profile: model.Profile{
			Provider:   "codex",
			Model:      "gpt-default",
			Permission: "ask",
			Scope:      model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"},
			Skills:     []string{},
			Delegations: []model.DelegationRule{},
		},
	}, http.StatusOK, &agent)

	// 1. Task-level model + effort + fast + permission override overrides Agent's ask mode.
	plan := f.createAutomation(model.AutomationInput{
		Name:   "Override model and permission",
		Prompt: "[wire] inspect repo",
		Trigger: model.AutomationTrigger{
			Kind:     "schedule",
			Schedule: &model.AutomationSchedule{IntervalMinutes: 60},
		},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Selection: &model.Selection{
			Provider:   "codex",
			Model:      "gpt-6.2-sol",
			Effort:     "max",
			Fast:       true,
			Permission: "full_access",
		},
	})
	if plan.Selection == nil || plan.Selection.Model != "gpt-6.2-sol" || plan.Selection.Effort != "max" || plan.Selection.Permission != "full_access" || !plan.Selection.Fast {
		t.Fatalf("automation did not persist selection: %+v", plan.Selection)
	}
	f.request("POST", "/tasks/automations/"+plan.ID+"/run", map[string]string{"commandId": app.ID()}, http.StatusOK, nil)
	run := f.wait(f.waitAutomationRuns(plan.ID, 1)[0].Execution.RunID, "completed")
	if run.Selection.Provider != "codex" || run.Selection.Model != "gpt-6.2-sol" ||
		run.Selection.Effort != "max" || !run.Selection.Fast || run.Selection.Permission != "full_access" {
		t.Fatalf("automation run did not honor selection override: %+v", run.Selection)
	}

	// 2. Permission-only override preserves Agent's provider & model while switching permission.
	permOnly := f.createAutomation(model.AutomationInput{
		Name:   "Permission only",
		Prompt: "run without ask",
		Trigger: model.AutomationTrigger{
			Kind:     "schedule",
			Schedule: &model.AutomationSchedule{IntervalMinutes: 60},
		},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Selection:   &model.Selection{Permission: "auto_review"},
	})
	f.request("POST", "/tasks/automations/"+permOnly.ID+"/run", map[string]string{"commandId": app.ID()}, http.StatusOK, nil)
	permRun := f.wait(f.waitAutomationRuns(permOnly.ID, 1)[0].Execution.RunID, "completed")
	if permRun.Selection.Provider != "codex" || permRun.Selection.Model != "gpt-default" || permRun.Selection.Permission != "auto_review" {
		t.Fatalf("permission-only override did not merge cleanly: %+v", permRun.Selection)
	}

	// 3. Cross-provider override uses the target provider's default permission when omitted.
	cross := f.createAutomation(model.AutomationInput{
		Name:   "Cross provider",
		Prompt: "run on claude",
		Trigger: model.AutomationTrigger{
			Kind:     "schedule",
			Schedule: &model.AutomationSchedule{IntervalMinutes: 60},
		},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Selection:   &model.Selection{Provider: "claude", Model: "claude-sonnet", Effort: "high"},
	})
	f.request("POST", "/tasks/automations/"+cross.ID+"/run", map[string]string{"commandId": app.ID()}, http.StatusOK, nil)
	crossRun := f.wait(f.waitAutomationRuns(cross.ID, 1)[0].Execution.RunID, "completed")
	if crossRun.Selection.Provider != "claude" || crossRun.Selection.Model != "claude-sonnet" ||
		crossRun.Selection.Effort != "high" || crossRun.Selection.Permission != "accept_edits" {
		t.Fatalf("cross-provider automation selection mismatch: %+v", crossRun.Selection)
	}

	// 4. Multi-target per-target selection override.
	multi := f.createAutomation(model.AutomationInput{
		Name:   "Multi target selections",
		Prompt: "check targets",
		Trigger: model.AutomationTrigger{
			Kind:     "schedule",
			Schedule: &model.AutomationSchedule{IntervalMinutes: 60},
		},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Targets: []model.AutomationTarget{
			{ID: "t-codex", AgentID: agent.ID, Selection: &model.Selection{Provider: "codex", Model: "gpt-a", Permission: "full_access"}},
			{ID: "t-claude", AgentID: agent.ID, Selection: &model.Selection{Provider: "claude", Model: "claude-b", Permission: "auto"}},
		},
	})
	f.request("POST", "/tasks/automations/"+multi.ID+"/run", map[string]string{"commandId": app.ID()}, http.StatusOK, nil)
	for _, entry := range f.waitAutomationRuns(multi.ID, 2) {
		r := f.wait(entry.Execution.RunID, "completed")
		switch entry.TargetID {
		case "t-codex":
			if r.Selection.Provider != "codex" || r.Selection.Model != "gpt-a" || r.Selection.Permission != "full_access" {
				t.Fatalf("unexpected t-codex selection: %+v", r.Selection)
			}
		case "t-claude":
			if r.Selection.Provider != "claude" || r.Selection.Model != "claude-b" || r.Selection.Permission != "auto" {
				t.Fatalf("unexpected t-claude selection: %+v", r.Selection)
			}
		}
	}

	// 5. Validation rejects invalid provider, permission, or effort at save time.
	for _, bad := range []*model.Selection{
		{Provider: "missing-provider"},
		{Provider: "codex", Permission: "nonexistent-perm"},
		{Provider: "codex", Effort: "bogus-effort"},
	} {
		f.request("POST", "/tasks/automations", model.AutomationInput{
			Name:   "Invalid selection",
			Prompt: "check",
			Trigger: model.AutomationTrigger{
				Kind:     "schedule",
				Schedule: &model.AutomationSchedule{IntervalMinutes: 60},
			},
			Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
			Selection:   bad,
		}, http.StatusBadRequest, nil)
	}
}

func TestLocalCLIFullModulesAndCommunication(t *testing.T) {
	f := newFixture(t)
	if err := f.s.StartLocalCLI(nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := f.s.CloseLocalCLI(ctx); err != nil {
			t.Error(err)
		}
	})

	runCLI := func(stdin string, args []string, out any) (string, error) {
		t.Helper()
		var stdout, stderr bytes.Buffer
		var in io.Reader
		if stdin != "" {
			in = strings.NewReader(stdin)
		}
		handled, err := cli.RunWithInput(args, f.a.Store.Dir, in, &stdout, &stderr)
		if !handled {
			t.Fatalf("CLI did not handle %v", args)
		}
		if err == nil && out != nil {
			err = json.Unmarshal(stdout.Bytes(), out)
		}
		return stdout.String(), err
	}

	// 1. Providers list & models.
	var providers []model.ProviderInfo
	if _, err := runCLI("", []string{"providers", "list"}, &providers); err != nil || len(providers) == 0 {
		t.Fatalf("providers list failed: %v (%d)", err, len(providers))
	}

	// 2. Agent create, get, list --full, update.
	var createdAgent model.Agent
	if _, err := runCLI("", []string{
		"agent", "create",
		"--name", "CLI Agent",
		"--provider", "codex",
		"--root", f.root,
		"--model", "gpt-test",
		"--permission", "ask",
	}, &createdAgent); err != nil {
		t.Fatalf("agent create failed: %v", err)
	}
	var fetchedAgent model.Agent
	if _, err := runCLI("", []string{"agent", "get", "--id", createdAgent.ID}, &fetchedAgent); err != nil || fetchedAgent.Profile.Permission != "ask" {
		t.Fatalf("agent get failed: %v %+v", err, fetchedAgent)
	}
	var updatedAgent model.Agent
	if _, err := runCLI("", []string{"agent", "update", "--id", createdAgent.ID, "--permission", "full_access"}, &updatedAgent); err != nil || updatedAgent.Profile.Permission != "full_access" {
		t.Fatalf("agent update failed: %v %+v", err, updatedAgent)
	}

	// 3. Chat create + send --wait (round-trip communication).
	var chat model.Chat
	if _, err := runCLI("", []string{"chat", "create", "--agent", createdAgent.ID, "--title", "CLI Comms"}, &chat); err != nil {
		t.Fatalf("chat create failed: %v", err)
	}
	var waited cliTestRunView
	if _, err := runCLI("", []string{
		"chat", "send",
		"--chat", chat.ID,
		"--text", "hello from cli",
		"--model", "gpt-override",
		"--effort", "high",
		"--wait",
		"--timeout", "15s",
	}, &waited); err != nil {
		t.Fatalf("chat send --wait failed: %v", err)
	}
	if waited.Status != "completed" || waited.Selection.Model != "gpt-override" || waited.Selection.Effort != "high" {
		t.Fatalf("unexpected waited run: %+v", waited)
	}

	// 4. Approval round-trip via CLI: chat send --wait stops at waiting_user with pendingRequests -> run answer -> run wait.
	var askRun cliTestRunView
	if _, err := runCLI("", []string{
		"chat", "send",
		"--chat", chat.ID,
		"--operation", "topic",
		"--text", "[approval] need approval",
		"--permission", "ask",
		"--wait",
		"--timeout", "15s",
	}, &askRun); err != nil {
		t.Fatalf("chat send [approval] --wait failed: %v", err)
	}
	if askRun.Status != "waiting_user" || len(askRun.PendingRequests) != 1 {
		t.Fatalf("expected waiting_user with 1 pending request, got status=%s requests=%d", askRun.Status, len(askRun.PendingRequests))
	}
	if _, err := runCLI("", []string{"run", "answer", "--request", askRun.PendingRequests[0].ID, "--allow=true"}, nil); err != nil {
		t.Fatalf("run answer failed: %v", err)
	}
	var finishedAsk cliTestRunView
	if _, err := runCLI("", []string{"run", "wait", "--id", askRun.ID, "--timeout", "15s"}, &finishedAsk); err != nil || finishedAsk.Status != "completed" {
		t.Fatalf("run wait after answer failed: %v status=%s", err, finishedAsk.Status)
	}

	// 5. Events tail streams NDJSON.
	rawEvents, err := runCLI("", []string{"events", "tail", "--after", "0", "--limit", "2", "--timeout", "5s"}, nil)
	if err != nil {
		t.Fatalf("events tail failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(rawEvents), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 NDJSON event lines, got %d: %s", len(lines), rawEvents)
	}

	// 6. Automations full lifecycle via CLI (create with model/effort/permission, get, update, disable, enable, run, history, archive).
	var auto model.Automation
	if _, err := runCLI("", []string{
		"automations", "create",
		"--name", "CLI Scheduled",
		"--prompt", "daily check",
		"--agent", createdAgent.ID,
		"--time", "11:00",
		"--timezone", "Asia/Shanghai",
		"--weekdays", "tu,fr",
		"--model", "gpt-6.2-sol",
		"--effort", "max",
		"--permission", "full_access",
		"--notify", "silent",
	}, &auto); err != nil {
		t.Fatalf("automations create failed: %v", err)
	}
	if auto.Selection == nil || auto.Selection.Model != "gpt-6.2-sol" || auto.Selection.Effort != "max" || auto.Selection.Permission != "full_access" || !auto.Quiet {
		t.Fatalf("unexpected created automation: %+v", auto)
	}
	var updatedAuto model.Automation
	if _, err := runCLI("", []string{"automations", "update", "--id", auto.ID, "--effort", "xhigh"}, &updatedAuto); err != nil || updatedAuto.Selection == nil || updatedAuto.Selection.Effort != "xhigh" || updatedAuto.Selection.Model != "gpt-6.2-sol" {
		t.Fatalf("automations update failed: %v %+v", err, updatedAuto.Selection)
	}
	if _, err := runCLI("", []string{"automations", "disable", "--id", auto.ID}, nil); err != nil {
		t.Fatalf("automations disable failed: %v", err)
	}
	if _, err := runCLI("", []string{"automations", "enable", "--id", auto.ID}, nil); err != nil {
		t.Fatalf("automations enable failed: %v", err)
	}
	if _, err := runCLI("", []string{"automations", "run", "--id", auto.ID}, nil); err != nil {
		t.Fatalf("automations run failed: %v", err)
	}
	f.waitAutomationRuns(auto.ID, 1)
	var history []model.AutomationRun
	if _, err := runCLI("", []string{"automations", "history", "--id", auto.ID}, &history); err != nil || len(history) != 1 {
		t.Fatalf("automations history failed: %v len=%d", err, len(history))
	}
	if _, err := runCLI("", []string{"automations", "archive", "--id", auto.ID}, nil); err != nil {
		t.Fatalf("automations archive failed: %v", err)
	}

	// 7. Codex automation migration (dry-run + real import).
	codexDir := t.TempDir()
	missingRepo := t.TempDir()
	longName := strings.Repeat("调", 90)
	writeCodexTask := func(id, content string, withMemory bool) {
		p := filepath.Join(codexDir, id)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "automation.toml"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if withMemory {
			if err := os.WriteFile(filepath.Join(p, "memory.md"), []byte("# memo"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	writeCodexTask("matched", `id = "matched"
kind = "cron"
name = "`+longName+`"
prompt = "daily review"
status = "PAUSED"
rrule = "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
model = "gpt-6.2-sol"
reasoning_effort = "xhigh"
cwds = ["`+filepath.ToSlash(f.root)+`"]
`, true)
	writeCodexTask("newdir", `id = "newdir"
kind = "cron"
name = "New Dir Task"
prompt = "scan notes"
status = "ACTIVE"
rrule = "RRULE:FREQ=WEEKLY;BYHOUR=11;BYMINUTE=0;BYDAY=MO,WE"
model = "gpt-6.2-astra"
reasoning_effort = "max"
notification_policy = "failed_runs_only"
cwds = ["`+filepath.ToSlash(missingRepo)+`"]
`, false)

	var importOut struct {
		DryRun bool `json:"dryRun"`
		Items  []struct {
			CodexID      string   `json:"codexId"`
			Action       string   `json:"action"`
			AutomationID string   `json:"automationId"`
			CreatedAgent bool     `json:"createdAgent"`
			Paused       bool     `json:"paused"`
			Warnings     []string `json:"warnings"`
		} `json:"items"`
	}
	if _, err := runCLI("", []string{"automations", "import-codex", "--dir", codexDir, "--dry-run"}, &importOut); err != nil {
		t.Fatalf("import-codex dry-run failed: %v", err)
	}
	if !importOut.DryRun || len(importOut.Items) != 2 {
		t.Fatalf("unexpected dry-run result: %+v", importOut)
	}
	if _, err := runCLI("", []string{"automations", "import-codex", "--dir", codexDir, "--create-missing-agents", "--permission", "full_access"}, &importOut); err != nil {
		t.Fatalf("import-codex failed: %v", err)
	}
	byCodex := map[string]struct {
		action       string
		id           string
		createdAgent bool
		paused       bool
		warnings     []string
	}{}
	for _, it := range importOut.Items {
		byCodex[it.CodexID] = struct {
			action       string
			id           string
			createdAgent bool
			paused       bool
			warnings     []string
		}{it.Action, it.AutomationID, it.CreatedAgent, it.Paused, it.Warnings}
	}
	if byCodex["matched"].action != "imported" || !byCodex["matched"].paused || len(byCodex["matched"].warnings) < 2 {
		t.Fatalf("unexpected matched import: %+v", byCodex["matched"])
	}
	if byCodex["newdir"].action != "imported" || !byCodex["newdir"].createdAgent {
		t.Fatalf("unexpected newdir import: %+v", byCodex["newdir"])
	}
	var pausedImported model.Automation
	if _, err := runCLI("", []string{"automations", "get", "--id", byCodex["matched"].id}, &pausedImported); err != nil || pausedImported.Enabled {
		t.Fatalf("expected paused Codex automation to remain paused in Lever: %v %+v", err, pausedImported.Enabled)
	}

	// 8. Work items list/get/update/dispatch & notes create/list/get.
	var wi model.WorkItem
	if _, err := runCLI("", []string{"work-items", "create", "--agent", createdAgent.ID, "--title", "CLI WI", "--body", "detail"}, &wi); err != nil {
		t.Fatalf("work-items create failed: %v", err)
	}
	var wis []model.WorkItem
	if _, err := runCLI("", []string{"work-items", "list", "--agent", createdAgent.ID, "--done=false"}, &wis); err != nil || len(wis) != 1 {
		t.Fatalf("work-items list failed: %v len=%d", err, len(wis))
	}
	var updatedWI model.WorkItem
	if _, err := runCLI("", []string{"work-items", "update", "--id", wi.ID, "--priority", "high"}, &updatedWI); err != nil || updatedWI.Priority != model.WorkItemPriorityHigh {
		t.Fatalf("work-items update failed: %v %+v", err, updatedWI)
	}
	var wiRun model.Run
	if _, err := runCLI("", []string{"work-items", "dispatch", "--id", wi.ID, "--agent", createdAgent.ID, "--model", "gpt-wi"}, &wiRun); err != nil || wiRun.Selection.Model != "gpt-wi" {
		t.Fatalf("work-items dispatch failed: %v %+v", err, wiRun.Selection)
	}
	f.wait(wiRun.ID, "completed")

	var note model.TaskNote
	if _, err := runCLI("", []string{"notes", "create", "--title", "CLI Note", "--text", "line 1\nline 2"}, &note); err != nil || note.Title != "CLI Note" {
		t.Fatalf("notes create failed: %v %+v", err, note)
	}
	var notes []model.TaskNoteSummary
	if _, err := runCLI("", []string{"notes", "list"}, &notes); err != nil || len(notes) == 0 {
		t.Fatalf("notes list failed: %v len=%d", err, len(notes))
	}

	// 9. Security isolation: active execution token cannot call operator CLI endpoints.
	t.Setenv("LEVER_EXECUTION_TOKEN", "active-run-token")
	for _, blocked := range [][]string{
		{"agent", "get", "--id", createdAgent.ID},
		{"providers", "list"},
		{"chat", "send", "--chat", chat.ID, "--text", "blocked"},
		{"run", "get", "--id", waited.ID},
		{"automations", "get", "--id", byCodex["newdir"].id},
		{"work-items", "list"},
		{"notes", "list"},
	} {
		if _, err := runCLI("", blocked, nil); err == nil {
			t.Fatalf("CLI allowed %v with LEVER_EXECUTION_TOKEN set", blocked)
		}
	}
	t.Setenv("LEVER_EXECUTION_TOKEN", "")
}
