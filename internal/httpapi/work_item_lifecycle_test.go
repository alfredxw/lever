package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/notes"
)

func (f *fixture) boardAction(id string, location model.TaskLocation, action string, code int) {
	f.t.Helper()
	f.request("PATCH", "/tasks/workflows/"+id, model.TaskWorkflowUpdate{TaskLocation: location, Action: action}, code, nil)
}

func TestWorkItemLifecycleAcrossAssignments(t *testing.T) {
	f := newFixture(t)
	owner, nextOwner := f.agent("codex"), f.agent("claude")
	const items = "/tasks/work-items"
	var item model.WorkItem
	f.request("POST", items, model.UserWorkItemCreate{Title: "Review release notes"}, 200, &item)
	location := model.TaskLocation{Record: model.TaskRecordWorkItem}
	path := items + "/" + item.ID
	first := model.ExternalTaskDispatch{AgentID: owner.ID, CommandID: app.ID(), Note: "[pausable]"}
	next := model.ExternalTaskDispatch{AgentID: nextOwner.ID, CommandID: app.ID(), Note: "[hang]"}
	var run, replay, replacement model.Run
	f.request("POST", path+"/dispatch", first, 200, &run)
	waitPausable(f, run.ID)
	f.boardAction(item.ID, location, "todo", 200)
	f.wait(run.ID, "running")
	f.request("POST", path+"/dispatch", next, 409, nil)
	f.request("POST", "/runs/"+run.ID+"/pause", nil, 200, nil)
	f.wait(run.ID, "paused")
	f.request("POST", path+"/dispatch", next, 409, nil)
	f.boardAction(item.ID, location, "close", 200)
	if !f.taskWorkflow(item.ID).Closed {
		t.Fatal("archive did not persist")
	}
	f.boardAction(item.ID, location, "reopen", 200)
	if wf := f.taskWorkflow(item.ID); wf.Closed || wf.Disposition != "todo" {
		t.Fatalf("unarchive lost the manual status: %+v", wf)
	}
	f.request("POST", "/runs/"+run.ID+"/stop", nil, 200, nil)
	f.wait(run.ID, "interrupted")
	f.request("POST", path+"/dispatch", next, 200, &replacement)
	f.wait(replacement.ID, "running")
	if replacement.AgentID != nextOwner.ID || replacement.SessionID == run.SessionID || f.taskWorkflow(item.ID).Disposition != "" {
		t.Fatal("the second dispatch did not take ownership")
	}
	f.request("POST", path+"/dispatch", first, 200, &replay)
	if replay.ID != run.ID {
		t.Fatal("the old dispatch receipt changed")
	}
	f.boardAction(item.ID, location, "delete", 200)
	f.boardAction(item.ID, location, "delete", 200)
	f.boardAction(item.ID, location, "reopen", 404)
	f.request("GET", path, nil, 404, nil)
	f.request("GET", "/tasks/locate/"+item.ID, nil, 404, nil)
	var visible []model.TaskExecution
	f.request("GET", "/tasks/executions", nil, 200, &visible)
	if len(visible) != 0 {
		t.Fatalf("deleted work is still listed: %+v", visible)
	}
	f.wait(run.ID, "interrupted")
	f.wait(replacement.ID, "running")
	f.request("POST", "/runs/"+replacement.ID+"/stop", nil, 200, nil)
}

func TestWorkItemLifecycleWithdrawsQueuedDispatch(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	agent.Profile.TaskQueuePaused = true
	f.request("PUT", "/agents/"+agent.ID, agent, 200, nil)
	for _, action := range []string{"todo", "close", "delete"} {
		item := f.queuedWorkItem(agent, action, "")
		f.request("POST", "/tasks/queue", item, 200, nil)
		f.boardAction(item.TaskID, model.TaskLocation{Record: item.Record}, action, 200)
		f.request("POST", "/tasks/queue", item, 200, nil)
		if wf := f.taskWorkflow(item.TaskID); wf.Queue != nil || wf.Closed != (action != "todo") {
			t.Fatalf("a delayed retry undid %s: %+v", action, wf)
		}
	}
}

func TestWorkItemLifecycleNoteKeepsManualDecisionOnDelivery(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	var note model.TaskNote
	f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Release"}, 200, &note)
	id := app.ID()
	path := "/tasks/notes/" + note.ID
	location := model.TaskLocation{Record: model.TaskRecordNote, NoteID: note.ID}
	note.Content = json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"paragraph","attrs":{"taskId":%q,"done":true},"content":[{"type":"text","text":"Verify delivery"}]}]}`, id))
	checkedContent := bytes.Clone(note.Content)
	f.request("PUT", path, note, 200, &note)
	f.boardAction(id, location, "todo", 200)
	checkOpen := func() {
		t.Helper()
		f.request("GET", path, nil, 200, &note)
		_, markers, err := notes.ParseContent(note.Content)
		if marker, ok := markers[id]; err != nil || !ok || marker.Done {
			t.Fatalf("expected the original open note block: %s, %v", note.Content, err)
		}
	}
	checkOpen()
	var run model.Run
	f.request("POST", "/tasks/dispatch", model.TaskDispatch{TaskID: id, NoteID: note.ID, Version: note.Version,
		CommandID: app.ID(), AgentID: agent.ID, Title: "Verify delivery", Text: deliverTask + " [approval]"}, 200, &run)
	if !f.wait(run.ID, "waiting_user").TaskCompletionRequested {
		t.Fatal("fixture needs a pending delivery to exercise the race")
	}
	f.boardAction(id, location, "todo", 200)
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
	f.wait(run.ID, "completed")
	checkOpen()
	f.boardAction(id, location, "close", 200)
	f.boardAction(id, location, "delete", 200)
	checkOpen()
	note.Content = checkedContent
	f.request("PUT", path, note, 200, &note)
	f.request("GET", "/tasks/locate/"+id, nil, 404, nil)
}

func TestAutomationRunControlsForStopOnlyProvider(t *testing.T) {
	f := newFixture(t)
	agent := f.acpAgent(f.acpProvider("automation"))
	plan := f.createAutomation(model.AutomationInput{
		Name: "Background review", Prompt: "[hang]", NotifyPolicy: "silent",
		Trigger:     model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 1440}},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: agent.ID},
	})
	f.request("POST", "/tasks/automations/"+plan.ID+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
	entry := f.waitAutomationRuns(plan.ID, 1)[0]
	id := entry.Execution.RunID
	f.wait(id, "running")
	if f.waitAutomationRuns(plan.ID, 1)[0].CanPause {
		t.Fatal("the run advertised a continuation the provider cannot perform")
	}
	f.request("POST", "/runs/"+id+"/pause", nil, 409, nil)
	f.request("POST", "/runs/"+id+"/stop", nil, 200, nil)
	f.wait(id, "interrupted")
}

func TestAutomationRunControlsIsolateTargetsAndBoardState(t *testing.T) {
	f := newFixture(t)
	first, second := f.agent("codex"), f.agent("claude")
	plan := f.createAutomation(model.AutomationInput{
		Name: "Nightly checks", Prompt: "[pausable]", NotifyPolicy: "silent", WorkItem: new(true),
		Trigger:     model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 1440}},
		Destination: model.AutomationDestination{Mode: "topic", AgentID: first.ID},
		Targets:     []model.AutomationTarget{{ID: "a", AgentID: first.ID}, {ID: "b", AgentID: second.ID}},
	})
	f.request("POST", "/tasks/automations/"+plan.ID+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
	history := f.waitAutomationRuns(plan.ID, 2)
	for _, entry := range history {
		waitPausable(f, entry.Execution.RunID)
	}
	var feed []model.AutomationRun
	f.request("GET", "/tasks/automation-runs", nil, 200, &feed)
	if len(feed) != 2 || !feed[0].CanPause || !feed[1].CanPause {
		t.Fatalf("silent run controls missing from the feed: %+v", feed)
	}
	target, other := feed[0], feed[1]
	runID := target.Execution.RunID
	f.boardAction(target.ID, model.TaskLocation{Record: model.TaskRecordAutomation}, "todo", 200)
	f.request("POST", "/runs/"+runID+"/pause", nil, 200, nil)
	paused := f.wait(runID, "paused")
	f.wait(other.Execution.RunID, "running")
	f.boardAction(target.ID, model.TaskLocation{Record: model.TaskRecordAutomation}, "close", 200)
	f.boardAction(target.ID, model.TaskLocation{Record: model.TaskRecordAutomation}, "delete", 200)
	f.request("PATCH", "/tasks/automation-runs/"+target.ID, map[string]bool{"done": true}, 404, nil)
	f.request("POST", "/runs/"+runID+"/stop", nil, 200, nil)
	stopped := f.wait(runID, "interrupted")
	if !hasPauseTestOutput(stopped, "Partial reply before the pause") || !f.automation(plan.ID).Enabled {
		t.Fatal("stopping a paused run lost the output or disabled the plan")
	}
	f.request("POST", "/runs/"+runID+"/resume", map[string]string{"nativeTurnId": *paused.NativeTurnID}, 409, nil)
	if len(f.waitAutomationRuns(plan.ID, 2)) != 2 {
		t.Fatal("removing a work item erased automation history")
	}
	f.wait(other.Execution.RunID, "running")
	f.request("POST", "/runs/"+other.Execution.RunID+"/stop", nil, 200, nil)
	f.wait(other.Execution.RunID, "interrupted")
}
