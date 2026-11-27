package httpapi_test

import (
	"net/http"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
)

func TestAgentSelectionPersistenceGlobalInheritanceAndPermissionPolicies(t *testing.T) {
	f := newFixture(t)

	// 1. Creating an Agent without provider/model/permission auto-picks an available runtime and leaves permission empty (inherit global).
	var first model.Agent
	f.request("POST", "/agents", model.Agent{
		Name: "Auto Default Agent",
		Profile: model.Profile{
			Scope:       model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"},
			Skills:      []string{},
			Delegations: []model.DelegationRule{},
		},
	}, http.StatusOK, &first)
	if first.Profile.Provider == "" || first.Profile.Permission != "" {
		t.Fatalf("unexpected auto-initialized agent profile: %+v", first.Profile)
	}

	// 2. Updating the Agent's selection via PUT /agents/{id}/selection persists provider/model/effort/fast and updates global lastSelection without touching permission.
	first.Profile.Permission = "read_only"
	f.request("PUT", "/agents/"+first.ID, first, http.StatusOK, &first)

	var updated model.Agent
	f.request("PUT", "/agents/"+first.ID+"/selection", model.Selection{
		Provider:   "claude",
		Model:      "claude-opus-4-6",
		Effort:     "high",
		Fast:       true,
		Permission: "full_access", // Ignored by selection endpoint.
	}, http.StatusOK, &updated)
	if updated.Profile.Provider != "claude" || updated.Profile.Model != "claude-opus-4-6" ||
		updated.Profile.Effort != "high" || !updated.Profile.Fast || updated.Profile.Permission != "read_only" {
		t.Fatalf("selection update mismatch: %+v", updated.Profile)
	}

	var ov model.Overview
	f.request("GET", "/overview", nil, http.StatusOK, &ov)
	if ov.LastSelection == nil || ov.LastSelection.Provider != "claude" ||
		ov.LastSelection.Model != "claude-opus-4-6" || ov.LastSelection.Effort != "high" || !ov.LastSelection.Fast {
		t.Fatalf("overview lastSelection mismatch: %+v", ov.LastSelection)
	}

	// 3. A newly created Agent without provider/model inherits global lastSelection and empty permission.
	var second model.Agent
	f.request("POST", "/agents", model.Agent{
		Name: "Inherited Agent",
		Profile: model.Profile{
			Scope:       model.Scope{Roots: []model.Root{{ID: "root", Path: f.root}}, PrimaryRootID: "root"},
			Skills:      []string{},
			Delegations: []model.DelegationRule{},
		},
	}, http.StatusOK, &second)
	if second.Profile.Provider != "claude" || second.Profile.Model != "claude-opus-4-6" ||
		second.Profile.Effort != "high" || !second.Profile.Fast || second.Profile.Permission != "" {
		t.Fatalf("new agent did not inherit global lastSelection: %+v", second.Profile)
	}

	// 4. Work-item dispatch without explicit selection uses the Agent's persisted latest selection + cross-provider permission policy (read_only -> plan on Claude).
	var item model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "Check latest model"}, http.StatusOK, &item)
	var dispatched model.Run
	f.request("POST", "/tasks/work-items/"+item.ID+"/dispatch", model.ExternalTaskDispatch{
		CommandID: app.ID(),
		AgentID:   updated.ID,
	}, http.StatusOK, &dispatched)
	dispatched = f.wait(dispatched.ID, "completed")
	if dispatched.Selection.Provider != "claude" || dispatched.Selection.Model != "claude-opus-4-6" ||
		dispatched.Selection.Effort != "high" || !dispatched.Selection.Fast || dispatched.Selection.Permission != "plan" {
		t.Fatalf("dispatched run did not use latest selection + mapped read_only permission: %+v", dispatched.Selection)
	}

	// 5. Locked automation stays pinned to its saved selection even after the Agent switches models later.
	locked := f.createAutomation(model.AutomationInput{
		Name:   "Locked plan",
		Prompt: "Audit daily",
		Trigger: model.AutomationTrigger{
			Kind:     "schedule",
			Schedule: &model.AutomationSchedule{IntervalMinutes: 60},
		},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: second.ID},
		Selection: &model.Selection{
			Provider:   "claude",
			Model:      "claude-opus-4-6",
			Effort:     "high",
			Fast:       true,
			Permission: "auto",
		},
	})
	f.request("PUT", "/agents/"+second.ID+"/selection", model.Selection{
		Provider: "codex",
		Model:    "gpt-5.4",
		Effort:   "low",
	}, http.StatusOK, &second)
	f.request("POST", "/tasks/automations/"+locked.ID+"/run", map[string]string{"commandId": app.ID()}, http.StatusOK, nil)
	autoRun := f.wait(f.waitAutomationRuns(locked.ID, 1)[0].Execution.RunID, "completed")
	if autoRun.Selection.Provider != "claude" || autoRun.Selection.Model != "claude-opus-4-6" ||
		autoRun.Selection.Effort != "high" || !autoRun.Selection.Fast || autoRun.Selection.Permission != "auto" {
		t.Fatalf("locked automation drifted after agent selection change: %+v", autoRun.Selection)
	}

	// 6. Cross-provider permission policy resolution works across codex, claude, and pi.
	for _, tc := range []struct {
		policy   string
		provider string
		want     string
	}{
		{"read_only", "codex", "read_only"},
		{"read_only", "claude", "plan"},
		{"read_only", "pi", "ask"},
		{"ask", "codex", "ask"},
		{"ask", "claude", "ask"},
		{"ask", "pi", "ask"},
		{"auto", "codex", "auto_review"},
		{"auto", "claude", "auto"},
		{"auto", "pi", "accept_edits"},
		{"full_access", "codex", "full_access"},
		{"full_access", "claude", "full_access"},
		{"full_access", "pi", "full_access"},
	} {
		second.Profile.Permission = tc.policy
		f.request("PUT", "/agents/"+second.ID, second, http.StatusOK, &second)
		modelID := "m"
		if tc.provider == "pi" {
			modelID = ""
		}
		f.request("PUT", "/agents/"+second.ID+"/selection", model.Selection{Provider: tc.provider, Model: modelID}, http.StatusOK, &second)
		run := f.wait(f.send(f.chat(second).ID, "main", "", "check "+tc.policy+" on "+tc.provider).ID, "completed")
		if run.Selection.Permission != tc.want {
			t.Fatalf("policy %q on %s resolved to %q, want %q", tc.policy, tc.provider, run.Selection.Permission, tc.want)
		}
	}
}
