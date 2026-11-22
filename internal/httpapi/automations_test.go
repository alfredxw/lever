package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"lever/internal/app"
	"lever/internal/cli"
	"lever/internal/httpapi"
	"lever/internal/model"
	"lever/internal/plugin/builtin/imap-mail"
)

func TestAutomationEventBatchesSurviveRestartAndOpenSeparateTopics(t *testing.T) {
	f := newFixture(t)
	chat := f.chat(f.agent("codex"))
	input := model.AutomationInput{
		Name: "Summarize notifications", Prompt: "Summarize the events.", Trigger: model.AutomationTrigger{Kind: "event", BatchSize: 2},
		Destination: model.AutomationDestination{ChatID: chat.ID},
		WorkItem:    new(true),
	}
	plan := f.createAutomation(input)
	if plan.Destination.Mode != "topic" || plan.EventURL == "" || plan.EventToken == "" {
		t.Fatalf("unexpected default destination or event endpoint: %+v", plan.Destination)
	}
	f.postAutomationEvent(plan, f.s.Token, "denied", `{"number":0}`, http.StatusUnauthorized)
	f.postAutomationEvent(plan, plan.EventToken, "one", `{"number":1}`, http.StatusOK)
	f.postAutomationEvent(plan, plan.EventToken, "one", `{"number":1}`, http.StatusOK)
	if got := f.automation(plan.ID); got.PendingEvents != 1 {
		t.Fatalf("duplicate delivery affected the batch: %d pending", got.PendingEvents)
	}

	if err := f.s.HTTP.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := app.Open(f.a.Store.Dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	server, err := httpapi.New(reopened, "127.0.0.1:0", "", fstest.MapFS{"index.html": {Data: []byte("Lever")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.HTTP.Close() })
	go server.Serve()
	f.a, f.s = reopened, server

	plan = f.automation(plan.ID)
	if plan.PendingEvents != 1 {
		t.Fatalf("restart lost the pending event: %d pending", plan.PendingEvents)
	}
	f.postAutomationEvent(plan, plan.EventToken, "two", `{"number":2}`, http.StatusOK)
	first := f.waitAutomationRuns(plan.ID, 1)[0]
	run := f.wait(first.Execution.RunID, "completed")
	if !strings.Contains(run.Input, `[{"number":1},{"number":2}]`) {
		t.Fatalf("unexpected event order or content: %s", run.Input)
	}
	f.postAutomationEvent(plan, plan.EventToken, "two", `{"number":2}`, http.StatusOK)
	f.postAutomationEvent(plan, plan.EventToken, "three", `{"number":3}`, http.StatusOK)
	if got := f.automation(plan.ID); got.PendingEvents != 1 {
		t.Fatalf("replaying a processed event changed the pending count: %d", got.PendingEvents)
	}
	f.postAutomationEvent(plan, plan.EventToken, "four", `{"number":4}`, http.StatusOK)
	second := f.waitAutomationRuns(plan.ID, 2)[0]
	f.wait(second.Execution.RunID, "completed")
	if !first.Execution.Topic || !second.Execution.Topic || first.Execution.ChatID != chat.ID ||
		second.Execution.ChatID != chat.ID || second.Execution.SessionID == first.Execution.SessionID {
		t.Fatal("automation batches did not get distinct Topics in the selected Chat")
	}
	var topics []model.TopicSummary
	f.request("GET", "/chats/"+chat.ID+"/topics", nil, http.StatusOK, &topics)
	if len(topics) != 2 || topics[0].Title != plan.Name || topics[1].Title != plan.Name {
		t.Fatalf("Topic titles should use the automation name: %+v", topics)
	}
	var overview model.Overview
	f.request("GET", "/overview", nil, http.StatusOK, &overview)
	for _, conversation := range overview.Conversations {
		if conversation.Kind == "topic" && conversation.Title != plan.Name {
			t.Fatalf("unexpected sidebar Topic title: %s", conversation.Title)
		}
	}
	f.request("PATCH", "/tasks/automation-runs/"+second.ID, map[string]bool{"done": true}, http.StatusOK, nil)
	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, http.StatusOK, &executions)
	if len(executions) != 2 || executions[0].TaskID != second.ID || !executions[0].Done || executions[1].TaskID != first.ID {
		t.Fatalf("Works does not show independent automation items: %+v", executions)
	}
}

func TestAutomationScheduleDestinationsAndOneShotCatchUp(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	taskID := app.ID()
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Shared Chat"}, 200, &note)
	note.Content = json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","attrs":{"taskId":%q},"content":[{"type":"text","text":"Initial task"}]}]}`, taskID))
	f.request("PUT", "/tasks/notes/"+note.ID, note, 200, &note)
	// Older Notes handovers used the main session of a task Chat.
	chat := f.chat(agent)
	if _, err := f.a.Store.DB.Exec(`UPDATE chats SET data=json_set(data,'$.taskId',?,'$.source','task') WHERE id=?`, taskID, chat.ID); err != nil {
		t.Fatal(err)
	}
	main := f.send(chat.ID, "main", "", "Initial conversation")
	f.wait(main.ID, "completed")

	future := time.Now().UTC().Add(24 * time.Hour)
	schedule := &model.AutomationSchedule{Date: future.Format(time.DateOnly), Time: future.Format("15:04"), Timezone: "UTC"}
	input := model.AutomationInput{
		Name: "Daily work", Prompt: "Check progress.", Trigger: model.AutomationTrigger{Kind: "schedule", Schedule: schedule},
		Destination: model.AutomationDestination{Mode: "chat", ChatID: main.ChatID},
		WorkItem:    new(true),
	}
	continued := f.createAutomation(input)
	command := map[string]string{"commandId": app.ID()}
	path := "/tasks/automations/" + continued.ID + "/run"
	f.request("POST", path, command, http.StatusOK, nil)
	first := f.waitAutomationRuns(continued.ID, 1)[0]
	f.wait(first.Execution.RunID, "completed")
	f.request("POST", path, command, http.StatusOK, nil)
	if first.Trigger != "manual" || first.Execution.ChatID != main.ChatID || first.Execution.SessionID != main.SessionID || first.Execution.Topic {
		t.Fatalf("manual run did not continue the existing main session: %+v", first)
	}
	if f.waitAutomationRuns(continued.ID, 1)[0].ID != first.ID ||
		f.automation(continued.ID).NextAt != continued.NextAt {
		t.Fatal("manual run replay changed history or the schedule")
	}
	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 2 || executions[1].TaskID != taskID || executions[1].RunID != main.ID {
		t.Fatalf("automation replaced the original task's execution: %+v", executions)
	}

	input.Destination = model.AutomationDestination{Mode: "newChat", AgentID: agent.ID}
	fresh := f.createAutomation(input)
	// Move the once rule into the past to simulate an overdue task after sleep.
	due := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Minute)
	if _, err := f.a.Store.DB.Exec(`UPDATE automations SET next_at=?, data=json_set(data,
'$.trigger.schedule.date',?, '$.trigger.schedule.time',?) WHERE id=?`,
		due.Unix(), due.Format(time.DateOnly), due.Format("15:04"), fresh.ID); err != nil {
		t.Fatal(err)
	}
	scheduled := f.waitAutomationRuns(fresh.ID, 1)[0]
	f.wait(scheduled.Execution.RunID, "completed")
	if scheduled.Trigger != "schedule" || scheduled.PlannedAt != due.Unix() ||
		scheduled.Execution.ChatID == main.ChatID || scheduled.Execution.Topic || f.automation(fresh.ID).NextAt != 0 {
		t.Fatalf("once schedule was not consumed in its own Chat: %+v", scheduled)
	}
}

func TestAutomationIntervalKeepsScheduleAfterLateDispatch(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	const intervalMinutes = 47
	const step = int64(intervalMinutes * 60)
	input := model.AutomationInput{
		Name: "Periodic check", Prompt: "Check progress.",
		Trigger:     model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: intervalMinutes}},
		Destination: model.AutomationDestination{Mode: "newChat", AgentID: agent.ID},
	}
	before := time.Now().Unix()
	plan := f.createAutomation(input)
	if plan.Trigger.Schedule.IntervalMinutes != intervalMinutes || plan.NextAt < before+step || plan.NextAt > time.Now().Unix()+step {
		t.Fatalf("incorrect saved schedule: %+v, next at %d", plan.Trigger.Schedule, plan.NextAt)
	}
	input.Name = "Renamed check"
	var edited model.Automation
	f.request("PUT", "/tasks/automations/"+plan.ID, input, http.StatusOK, &edited)
	if edited.NextAt != plan.NextAt {
		t.Fatal("renaming the automation changed the next run")
	}

	latest := time.Now().Add(-2 * time.Minute).Unix()
	if _, err := f.a.Store.DB.Exec("UPDATE automations SET next_at=? WHERE id=?", latest-2*step, plan.ID); err != nil {
		t.Fatal(err)
	}
	run := f.waitAutomationRuns(plan.ID, 1)[0]
	if run.Trigger != "schedule" || run.PlannedAt != latest || f.automation(plan.ID).NextAt != latest+step {
		t.Fatalf("late dispatch did not keep the interval phase: %+v", run)
	}
}

func TestAutomationDedicatedChatAndWorkItems(t *testing.T) {
	f := newFixture(t)
	owner := f.agent("codex")
	future := time.Now().UTC().Add(24 * time.Hour)
	input := model.AutomationInput{
		Name: "Dedicated workspace", Prompt: "Check progress.",
		Trigger: model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{
			Date: future.Format(time.DateOnly), Time: future.Format("15:04"), Timezone: "UTC",
		}},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: owner.ID},
	}
	plan := f.createAutomation(input)
	if plan.CreatesWorkItem() || plan.Quiet {
		t.Fatal("new automations should be visible to Agents without creating board items")
	}
	if plan.BoundChatID != "" {
		t.Fatal("saved a Chat before the first execution")
	}
	path := "/tasks/automations/" + plan.ID
	fire := func(count int) *model.TaskExecution {
		t.Helper()
		f.request("POST", path+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
		run := f.waitAutomationRuns(plan.ID, count)[0]
		f.wait(run.Execution.RunID, "completed")
		return run.Execution
	}
	first, second := fire(1), fire(2)
	if !first.Topic || !second.Topic || first.ChatID != second.ChatID || first.SessionID == second.SessionID || f.automation(plan.ID).BoundChatID != first.ChatID {
		t.Fatal("two Topic runs did not reuse the dedicated Chat")
	}
	var executions []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 0 {
		t.Fatal("runs without Work items were included in Works")
	}
	f.request("GET", "/tasks/locate/"+first.TaskID, nil, 404, nil)

	input.Destination.Mode = "chat"
	input.WorkItem = new(true)
	f.request("PUT", path, input, 200, nil)
	third, fourth := fire(3), fire(4)
	if third.Topic || fourth.Topic || third.ChatID != first.ChatID ||
		fourth.ChatID != first.ChatID || third.SessionID != fourth.SessionID {
		t.Fatal("the dedicated Chat did not preserve its main conversation")
	}
	f.request("GET", "/tasks/executions", nil, 200, &executions)
	if len(executions) != 2 || executions[0].TaskID != fourth.TaskID || executions[1].TaskID != third.TaskID {
		t.Fatalf("Work item toggle changed historical membership: %+v", executions)
	}
	card := readBoardMention(f, owner, "automationTask", fourth.TaskID)
	if card.Body.Title != input.Name || card.Body.State != "completed" || card.Body.Done == nil || *card.Body.Done {
		t.Fatal("referenced automation card did not reflect the run", card)
	}
	// Plans saved before the board switch existed tracked their fires.
	if _, err := f.a.Store.DB.Exec("UPDATE automations SET data=json_remove(data,'$.workItem') WHERE id=?", plan.ID); err != nil {
		t.Fatal(err)
	}
	input.WorkItem = nil
	f.request("PUT", path, input, 200, &plan)
	if !plan.CreatesWorkItem() {
		t.Fatal("editing a legacy plan dropped its board setting")
	}
	input.Destination.ChatID = first.ChatID
	input.Destination.AgentID = f.agent("codex").ID
	f.request("PUT", path, input, 400, nil)
}

func TestAutomationRetryUsesTheOriginalActivityAndBoardSettings(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	input := model.AutomationInput{
		Name: "Snapshot", Prompt: "[approval]", Quiet: true, WorkItem: new(true),
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
		Trigger:     model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 60}},
	}
	plan := f.createAutomation(input)
	path := "/tasks/automations/" + plan.ID
	f.request("POST", path+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
	fire := f.waitAutomationRuns(plan.ID, 1)[0].Execution
	f.wait(fire.RunID, "waiting_user")
	input.Quiet, input.WorkItem = false, new(false)
	f.request("PUT", path, input, 200, nil)
	f.request("POST", "/runs/"+fire.RunID+"/stop", nil, 200, nil)
	f.wait(fire.RunID, "interrupted")
	// Older persisted runs only identified the board item through automation_runs.
	if _, err := f.a.Store.DB.Exec("UPDATE runs SET data=json_remove(data,'$.task') WHERE id=?", fire.RunID); err != nil {
		t.Fatal(err)
	}
	var retry model.Run
	f.request("POST", "/runs/"+fire.RunID+"/retry", map[string]string{"commandId": app.ID()}, 200, &retry)
	if !retry.Quiet || retry.Task == nil || retry.Task.ID != fire.TaskID || retry.TaskCompletionRequested {
		t.Fatal("retry lost its original settings or inherited a delivery signal")
	}
	f.wait(retry.ID, "waiting_user")
	f.request("POST", "/runs/"+retry.ID+"/stop", nil, 200, nil)
	f.wait(retry.ID, "interrupted")
	f.request("POST", path+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
	next := f.waitAutomationRuns(plan.ID, 2)[0].Execution
	if run := f.wait(next.RunID, "waiting_user"); run.Quiet || run.Task != nil {
		t.Fatal("next fire did not pick up the new settings")
	}
}

func TestAutomationLocalCLIHookAndListing(t *testing.T) {
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
	agent := f.agent("codex")
	chat := f.chat(agent)
	webhook := f.createAutomation(model.AutomationInput{
		Name: "CLI Hook", Prompt: "Summarize local hooks.",
		Trigger:     model.AutomationTrigger{Kind: "event", BatchSize: 2},
		Destination: model.AutomationDestination{Mode: "topic", ChatID: chat.ID},
	})
	scheduled := f.createAutomation(model.AutomationInput{
		Name: "Hourly", Prompt: "Run hourly.",
		Trigger:     model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 60}},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
	})
	sourced := f.createAutomation(model.AutomationInput{
		Name: "Mail", Prompt: "Check mail.",
		Trigger: model.AutomationTrigger{Kind: "event", BatchSize: 1, Source: &model.AutomationEventSource{
			PluginID: imapmail.PluginID, ContributionID: imapmail.ContributionID,
			Config: map[string]string{"server": "imap.example.invalid", "username": "u", "password": "p"},
		}},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
	})

	runCLI := func(stdin string, args []string, out any) error {
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
		return err
	}

	var listed []struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		Trigger       string `json:"trigger"`
		Enabled       bool   `json:"enabled"`
		AcceptsEvents bool   `json:"acceptsEvents"`
	}
	if err := runCLI("", []string{"automations", "list"}, &listed); err != nil {
		t.Fatal(err)
	}
	byID := map[string]struct {
		Trigger       string
		Enabled       bool
		AcceptsEvents bool
	}{}
	for _, item := range listed {
		byID[item.ID] = struct {
			Trigger       string
			Enabled       bool
			AcceptsEvents bool
		}{item.Trigger, item.Enabled, item.AcceptsEvents}
	}
	if len(byID) != 3 || !byID[webhook.ID].AcceptsEvents || byID[scheduled.ID].AcceptsEvents || byID[sourced.ID].AcceptsEvents {
		t.Fatalf("unexpected CLI automation listing: %+v", listed)
	}

	// Active Lever executions cannot inspect or trigger automations via local CLI.
	t.Setenv("LEVER_EXECUTION_TOKEN", "active-run-token")
	if err := runCLI("", []string{"automations", "list"}, nil); err == nil {
		t.Fatal("CLI allowed listing automations with LEVER_EXECUTION_TOKEN set")
	}
	if err := runCLI("", []string{"automations", "emit", "--id", webhook.ID, "--data", `{"n":0}`}, nil); err == nil {
		t.Fatal("CLI allowed emitting events with LEVER_EXECUTION_TOKEN set")
	}
	t.Setenv("LEVER_EXECUTION_TOKEN", "")

	// Reject schedule, plugin-sourced, unknown, invalid JSON, and oversized payloads.
	for _, bad := range [][]string{
		{"automations", "emit", "--id", scheduled.ID, "--data", `{"n":1}`},
		{"automations", "emit", "--id", sourced.ID, "--data", `{"n":1}`},
		{"automations", "emit", "--id", "missing", "--data", `{"n":1}`},
		{"automations", "emit", "--id", webhook.ID, "--data", `not-json`},
		{"automations", "emit", "--id", webhook.ID, "--data", `"` + strings.Repeat("a", app.MaxAutomationEventBytes) + `"`},
	} {
		if err := runCLI("", bad, nil); err == nil {
			t.Fatalf("expected error for %v", bad)
		}
	}

	// Emit via inline --data with --key, then deduplicate against HTTP webhook.
	var ack map[string]bool
	if err := runCLI("", []string{"automations", "emit", "--id", webhook.ID, "--key", "evt-1", "--data", `{"n":1}`}, &ack); err != nil || !ack["accepted"] {
		t.Fatalf("CLI inline emit failed: %v, %+v", err, ack)
	}
	f.postAutomationEvent(webhook, webhook.EventToken, "evt-1", `{"n":1}`, http.StatusOK)
	if got := f.automation(webhook.ID); got.PendingEvents != 1 {
		t.Fatalf("HTTP replay of CLI idempotency key duplicated event: %d", got.PendingEvents)
	}

	// Paused automation rejects new events until resumed.
	f.request("PATCH", "/tasks/automations/"+webhook.ID, map[string]bool{"enabled": false}, http.StatusOK, nil)
	if err := runCLI(`{"n":2}`, []string{"automations", "emit", "--id", webhook.ID}, nil); err == nil {
		t.Fatal("CLI accepted event for paused automation")
	}
	f.request("PATCH", "/tasks/automations/"+webhook.ID, map[string]bool{"enabled": true}, http.StatusOK, nil)

	// Emit second event via piped stdin (no --data flag) -> triggers batch of 2.
	if err := runCLI("{\"n\":2}\n", []string{"automations", "emit", "--id", webhook.ID, "--key", "evt-2"}, &ack); err != nil || !ack["accepted"] {
		t.Fatalf("CLI stdin emit failed: %v, %+v", err, ack)
	}
	first := f.waitAutomationRuns(webhook.ID, 1)[0]
	run := f.wait(first.Execution.RunID, "completed")
	if !strings.Contains(run.Input, `[{"n":1},{"n":2}]`) {
		t.Fatalf("unexpected CLI event batch payload: %s", run.Input)
	}

	// Explicit --data - also reads from stdin.
	if err := runCLI(`{"n":3}`, []string{"automations", "emit", "--id", webhook.ID, "--data", "-"}, &ack); err != nil || !ack["accepted"] {
		t.Fatalf("CLI --data - emit failed: %v, %+v", err, ack)
	}
	if got := f.automation(webhook.ID); got.PendingEvents != 1 {
		t.Fatalf("expected 1 pending event after --data -, got %d", got.PendingEvents)
	}
}

func TestAutomationMultiTargetDispatchAndGlobalFeed(t *testing.T) {
	f := newFixture(t)
	agentA := f.agent("codex")
	agentB := f.agent("codex")
	plan := f.createAutomation(model.AutomationInput{
		Name:         "Multi-repo audit",
		Prompt:       "Inspect recent commits.",
		NotifyPolicy: "silent",
		DeliveryMode: "deliver",
		Trigger:      model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 1440}},
		Destination:  model.AutomationDestination{Mode: "topic", AgentID: agentA.ID},
		Targets: []model.AutomationTarget{
			{ID: "target-a", AgentID: agentA.ID, Prompt: "Focus on Go tests."},
			{ID: "target-b", AgentID: agentB.ID, Prompt: "Focus on Web UI."},
		},
	})
	if !plan.Quiet || plan.NotifyPolicy != "silent" || plan.DeliveryMode != "deliver" || len(plan.Targets) != 2 {
		t.Fatalf("unexpected multi-target automation: %+v", plan)
	}

	// Run all targets together; expect two flat runs with distinct agents and prompts.
	f.request("POST", "/tasks/automations/"+plan.ID+"/run", map[string]string{"commandId": app.ID()}, http.StatusOK, nil)
	history := f.waitAutomationRuns(plan.ID, 2)
	agentsSeen := map[string]bool{}
	for _, entry := range history {
		run := f.wait(entry.Execution.RunID, "completed")
		agentsSeen[entry.AgentID] = true
		if entry.TargetID == "target-a" && !strings.Contains(run.Input, "Focus on Go tests.") {
			t.Fatalf("target-a missing supplemental prompt: %s", run.Input)
		}
		if entry.TargetID == "target-b" && !strings.Contains(run.Input, "Focus on Web UI.") {
			t.Fatalf("target-b missing supplemental prompt: %s", run.Input)
		}
	}
	if !agentsSeen[agentA.ID] || !agentsSeen[agentB.ID] {
		t.Fatalf("expected runs for both agents, saw: %+v", agentsSeen)
	}

	// Single-target manual run dispatches only the chosen target.
	f.request("POST", "/tasks/automations/"+plan.ID+"/run", map[string]string{"commandId": app.ID(), "targetId": "target-b"}, http.StatusOK, nil)
	history = f.waitAutomationRuns(plan.ID, 3)
	if history[0].TargetID != "target-b" || history[0].AgentID != agentB.ID {
		t.Fatalf("single-target run dispatched unexpected target: %+v", history[0])
	}
	f.wait(history[0].Execution.RunID, "completed")

	// Global flat feed returns runs with automationId, targetId, summary, and replyCount.
	f.request("POST", "/messages", model.SendInput{
		CommandID: app.ID(),
		ChatID:    history[0].Execution.ChatID,
		SessionID: history[0].Execution.SessionID,
		Operation: "reply",
		Text:      "Follow-up question",
	}, http.StatusOK, nil)
	var feed []model.AutomationRun
	f.request("GET", "/tasks/automation-runs", nil, http.StatusOK, &feed)
	if len(feed) < 3 || feed[0].AutomationID != plan.ID || feed[0].Summary == "" {
		t.Fatalf("unexpected global automation runs feed: %+v", feed)
	}
	if feed[0].ReplyCount < 1 {
		t.Fatalf("expected replyCount >= 1 after follow-up, got %d", feed[0].ReplyCount)
	}
}

func TestAutomationOutputsAndRepliesStayWithTheirRun(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	chat := f.chat(agent)
	f.wait(f.send(chat.ID, "main", "", "Earlier conversation").ID, "completed")
	plan := f.createAutomation(model.AutomationInput{Name: "Weekly findings", Prompt: "Inspect changes", Trigger: model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 1440}}, Destination: model.AutomationDestination{Mode: "chat", ChatID: chat.ID}})
	path := "/tasks/automations/" + plan.ID
	fire := func(count int) model.Run {
		f.request("POST", path+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
		return f.wait(f.waitAutomationRuns(plan.ID, count)[0].Execution.RunID, "completed")
	}
	first := fire(1)
	f.wait(f.send(chat.ID, "main", first.SessionID, "Follow up on the first report").ID, "completed")
	second := fire(2)
	result := "## Report\n\nFix ready for [review](https://github.com/sample/lever/pull/418).\n\n- **Guard the cursor**\n- Cover the empty case\n- Keep the parser small\n- Fourth finding stays in the full response\n\nhttps://github.com/SAMPLE/lever/pull/418/files\n\n`https://github.com/sample/lever/pull/17`\n\n[not GitHub](https://github.com.example.org/sample/lever/pull/19)"
	items, err := json.Marshal([]model.Item{{Kind: "text", Text: "Planning https://github.com/sample/lever/pull/1"}, {Kind: "tool", Text: "Internal tool output"}, {Kind: "text", Text: result}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.a.Store.DB.Exec(`UPDATE runs SET data=json_set(data,'$.items',json(?),'$.turnDiff',json('{"reported":true,"files":[{"path":"poll.go","additions":5,"deletions":2}]}'),'$.changes',json('[{"files":[{"path":"other.go","additions":99}]}]')) WHERE id=?`, string(items), first.ID); err != nil {
		t.Fatal(err)
	}
	var proposed, again model.WorkItem
	input := model.UserWorkItemCreate{Title: "Guard the cursor", Body: "Guard the cursor", OriginRunID: first.ID, AssigneeAgentID: agent.ID}
	f.request("POST", "/tasks/work-items", input, 200, &proposed)
	f.request("POST", "/tasks/work-items", input, 200, &again)
	if proposed.ID != again.ID || proposed.CreatedByAgentID != "" || proposed.Origin == nil || proposed.Origin.RunID != first.ID || proposed.Origin.ChatID != chat.ID {
		t.Fatalf("wrong work item ownership or duplicate: %+v / %+v", proposed, again)
	}
	for _, endpoint := range []string{path + "/history", "/tasks/automation-runs"} {
		var runs []model.AutomationRun
		f.request("GET", endpoint, nil, 200, &runs)
		if len(runs) != 2 {
			t.Fatalf("%s: unexpected runs: %+v", endpoint, runs)
		}
		latest, older := runs[0], runs[1]
		if older.ReplyCount != 1 || latest.ReplyCount != 0 || older.NextFireSequence != second.Sequence || older.ScopePath != agent.Profile.Roots[0].Path {
			t.Fatalf("%s: shared chat history or scope crossed runs: %+v / %+v", endpoint, older, latest)
		}
		if older.Summary != "Fix ready for review." || len(older.ReportItems) != 3 || older.ReportItems[0] != "Guard the cursor" || len(older.PullRequests) != 1 || older.PullRequests[0] != (model.AutomationPullRequest{Repository: "sample/lever", Number: "418", Label: "review"}) {
			t.Fatalf("%s: unexpected report projection: %+v", endpoint, older)
		}
		if older.ChangeSummary == nil || *older.ChangeSummary != (model.AutomationChangeSummary{Files: 1, Additions: 5, Deletions: 2}) || len(older.WorkItemIDs) != 1 || older.WorkItemIDs[0] != proposed.ID || len(latest.PullRequests) != 0 {
			t.Fatalf("%s: wrong artifacts: %+v / %+v", endpoint, older, latest)
		}
	}
}

func (f *fixture) createAutomation(input model.AutomationInput) model.Automation {
	f.t.Helper()
	var plan model.Automation
	f.request("POST", "/tasks/automations", input, http.StatusOK, &plan)
	return plan
}

func (f *fixture) automation(id string) model.Automation {
	f.t.Helper()
	var plans []model.Automation
	f.request("GET", "/tasks/automations", nil, http.StatusOK, &plans)
	for _, plan := range plans {
		if plan.ID == id {
			return plan
		}
	}
	f.t.Fatalf("automation %s is missing", id)
	return model.Automation{}
}

func (f *fixture) postAutomationEvent(plan model.Automation, token, key, body string, status int) {
	f.t.Helper()
	req, err := http.NewRequestWithContext(f.t.Context(), "POST", plan.EventURL, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		data, _ := io.ReadAll(response.Body)
		f.t.Fatalf("post event: got %d, want %d: %s", response.StatusCode, status, data)
	}
}

func (f *fixture) waitAutomationRuns(id string, count int) []model.AutomationRun {
	f.t.Helper()
	for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
		var history []model.AutomationRun
		f.request("GET", "/tasks/automations/"+id+"/history", nil, http.StatusOK, &history)
		if len(history) >= count {
			for _, run := range history {
				if run.Execution == nil {
					f.t.Fatalf("trigger did not dispatch: %s", run.Error)
				}
			}
			if len(history) != count {
				f.t.Fatalf("expected %d runs, got %d", count, len(history))
			}
			return history
		}
		time.Sleep(30 * time.Millisecond)
	}
	f.t.Fatalf("automation %s did not trigger %d runs", id, count)
	return nil
}
