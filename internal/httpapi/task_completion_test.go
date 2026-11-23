package httpapi_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
	"lever/internal/notes"
)

const deliverTask = `[chat-context] [{"name":"complete_current_task","arguments":{}}]`

func TestAgentCompletesOnlyTheAssignedItem(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	item, err := f.a.CreateWorkItem(t.Context(), agent.ID, nil, model.WorkItemInput{Title: "[chat-context]", Body: strings.TrimPrefix(deliverTask, "[chat-context] ")})
	if err != nil {
		t.Fatal(err)
	}
	var run model.Run
	f.request("POST", "/tasks/work-items/"+item.ID+"/dispatch", model.ExternalTaskDispatch{AgentID: agent.ID, CommandID: app.ID()}, 200, &run)
	delivered := f.wait(run.ID, "completed")
	f.request("GET", "/tasks/work-items/"+item.ID, nil, 200, &item)
	if !item.Done || !delivered.TaskCompletionRequested {
		t.Fatal("the explicit tool call did not complete the assigned work item")
	}
	var chatView model.ChatView
	f.request("GET", "/chats/"+run.ChatID, nil, 200, &chatView)
	if chatView.Chat.Source != "works" || chatView.Chat.TaskID != "" || len(chatView.Sessions) != 1 ||
		chatView.Sessions[0].Kind != "topic" || chatView.Sessions[0].TaskID != item.ID {
		t.Fatalf("work item did not run in the unified Works Chat Topic: %+v", chatView)
	}
	f.request("PATCH", "/tasks/work-items/"+item.ID, map[string]bool{"done": false}, 200, nil)
	// A fire targeting the work items Chat must never complete a work item.
	input := model.AutomationInput{Name: "Daily", Prompt: deliverTask, WorkItem: new(true),
		Trigger:     model.AutomationTrigger{Kind: "schedule", Schedule: &model.AutomationSchedule{IntervalMinutes: 60}},
		Destination: model.AutomationDestination{Mode: "chat", ChatID: run.ChatID}}
	plan := f.createAutomation(input)
	f.request("POST", "/tasks/automations/"+plan.ID+"/run", map[string]string{"commandId": app.ID()}, 200, nil)
	fire := f.waitAutomationRuns(plan.ID, 1)[0]
	f.wait(fire.Execution.RunID, "completed")
	fire = f.waitAutomationRuns(plan.ID, 1)[0]
	f.request("GET", "/tasks/work-items/"+item.ID, nil, 200, &item)
	if !fire.Execution.Done || item.Done {
		t.Fatal("automation completion did not stay bound to its own board item")
	}
	ordinaryMain := f.send(run.ChatID, "main", "", deliverTask)
	f.wait(ordinaryMain.ID, "completed")
	ordinary := f.send(run.ChatID, "topic", "", deliverTask)
	f.wait(ordinary.ID, "completed")
	f.request("GET", "/tasks/work-items/"+item.ID, nil, 200, &item)
	if item.Done {
		t.Fatal("an unrelated main turn or Topic completed the work item")
	}
	readOnly := run.Selection
	readOnly.Permission = "read_only"
	var review model.Run
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: run.ChatID, SessionID: run.SessionID, Operation: "reply", Selection: &readOnly, Text: deliverTask}, 200, &review)
	if f.wait(review.ID, "completed").TaskCompletionRequested {
		t.Fatal("a read-only execution requested a state change")
	}
	// Choose the original writable selection for the next delivery.
	f.request("POST", "/messages", model.SendInput{CommandID: app.ID(), ChatID: run.ChatID, SessionID: run.SessionID, Operation: "reply", Selection: &run.Selection, Text: deliverTask}, 200, &review)
	f.wait(review.ID, "completed")
	f.request("GET", "/tasks/work-items/"+item.ID, nil, 200, &item)
	if !item.Done {
		t.Fatal("a follow-up in the assigned Topic session could not finish delivery")
	}
}

func TestNoteTaskCompletionWaitsForSuccessfulDelivery(t *testing.T) {
	for _, outcome := range []string{"delivered", "edited", "sibling edited", "queued edit", "interrupted", "failed"} {
		t.Run(outcome, func(t *testing.T) {
			f := newFixture(t)
			agent := f.agent("codex")
			var note model.TaskNote
			f.request("POST", "/tasks/notes", model.TaskNoteSummary{ID: app.ID(), Title: "Review"}, 200, &note)
			path := "/tasks/notes/" + note.ID
			id, sibling := app.ID(), app.ID()
			note.Content = json.RawMessage(fmt.Sprintf(`{"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"taskId":%q,"alignment":"center"},"content":[{"type":"text","text":"Deliver"}]}]}]},{"type":"paragraph","attrs":{"taskId":%q},"content":[{"type":"text","text":"Other"}]}]}`, id, sibling))
			f.request("PUT", path, note, 200, &note)
			dispatch := model.TaskDispatch{AgentID: agent.ID, NoteID: note.ID, Version: note.Version, TaskID: id, CommandID: app.ID(), Title: "Deliver", Text: deliverTask + " [approval]"}
			var run model.Run
			if outcome == "queued edit" {
				blocker := f.queuedWorkItem(agent, "First", "[hang]")
				f.request("POST", "/tasks/queue", blocker, 200, nil)
				first := f.waitForTask(blocker.TaskID, "running")
				f.request("POST", "/tasks/queue", model.TaskQueueInput{TaskDispatch: dispatch, Record: model.TaskRecordNote}, 200, nil)
				note.Content = json.RawMessage(strings.Replace(string(note.Content), "Deliver", "New requirements", 1))
				f.request("PUT", path, note, 200, &note)
				f.request("POST", "/runs/"+first.RunID+"/stop", nil, 200, nil)
				run.ID = f.waitForTask(id, "waiting_user").RunID
			} else {
				if outcome == "failed" {
					dispatch.Text = deliverTask + " [approval-fail]"
				}
				f.request("POST", "/tasks/dispatch", dispatch, 200, &run)
			}
			waiting := f.wait(run.ID, "waiting_user")
			if !waiting.TaskCompletionRequested {
				t.Fatal("runtime did not record delivery before asking for approval")
			}
			f.request("GET", path, nil, 200, &note)
			markers := func() map[string]notes.Marker {
				t.Helper()
				_, m, err := notes.ParseContent(note.Content)
				if err != nil {
					t.Fatal(err)
				}
				return m
			}
			if markers()[id].Done {
				t.Fatal("the tool checked the note before the run succeeded")
			}
			if outcome == "edited" {
				note.Content = json.RawMessage(strings.Replace(string(note.Content), "Deliver", "New requirements", 1))
				f.request("PUT", path, note, 200, &note)
			} else if outcome == "sibling edited" {
				note.Content = json.RawMessage(strings.Replace(string(note.Content), "Other", "Updated sibling", 1))
				f.request("PUT", path, note, 200, &note)
			}
			if outcome == "interrupted" {
				f.request("POST", "/runs/"+run.ID+"/stop", nil, 200, nil)
				f.wait(run.ID, "interrupted")
			} else {
				var overview model.Overview
				f.request("GET", "/overview", nil, 200, &overview)
				f.request("POST", "/requests/"+overview.Requests[0].ID+"/answer", model.Answer{Allow: true}, 200, nil)
				status := "completed"
				if outcome == "failed" {
					status = "failed"
				}
				f.wait(run.ID, status)
			}
			// The Note write follows the durable success transaction.
			wantDone := outcome == "delivered" || outcome == "sibling edited"
			for deadline := time.Now().Add(2 * time.Second); ; {
				f.request("GET", path, nil, 200, &note)
				if !wantDone || markers()[id].Done || time.Now().After(deadline) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			m := markers()
			edited := outcome == "edited" || outcome == "queued edit"
			if m[id].Done != wantDone || m[sibling].Done || !strings.Contains(string(note.Content), "center") || (edited && m[id].Title != "New requirements") || (outcome == "sibling edited" && m[sibling].Title != "Updated sibling") {
				t.Fatalf("incorrect writeback after %s: %s", outcome, note.Content)
			}
		})
	}
}
