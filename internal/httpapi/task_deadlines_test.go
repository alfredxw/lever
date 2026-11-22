package httpapi_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"lever/internal/app"
	"lever/internal/model"
)

func TestTaskDeadlinesRemindersAndEDFQueue(t *testing.T) {
	f := newFixture(t)
	agent := f.agent("codex")
	ctx := context.Background()

	// 1. Default reminder settings and update.
	var settings model.TaskReminderSettings
	f.request("GET", "/settings/task-reminders", nil, 200, &settings)
	if !slices.Equal(settings.DefaultRemindOffsets, []int{30}) || settings.AllDayReminderTime != "09:00" {
		t.Fatalf("unexpected default reminder settings: %+v", settings)
	}
	f.request("PUT", "/settings/task-reminders", model.TaskReminderSettings{
		DefaultRemindOffsets: []int{15, 60, 15},
		AllDayReminderTime:   "08:30",
	}, 200, &settings)
	if !slices.Equal(settings.DefaultRemindOffsets, []int{60, 15}) || settings.AllDayReminderTime != "08:30" {
		t.Fatalf("expected deduplicated descending offsets and wall time: %+v", settings)
	}
	f.request("PUT", "/settings/task-reminders", model.TaskReminderSettings{
		DefaultRemindOffsets: []int{30},
		AllDayReminderTime:   "25:99",
	}, 400, nil)

	// 2. Create work items: one blocking the agent slot, then no-DDL, late-DDL, early-DDL.
	blocker := f.queuedWorkItem(agent, "Blocker", "[approval]")
	f.request("POST", "/tasks/queue", blocker, 200, nil)
	f.waitForTask(blocker.TaskID, "waiting_user")

	now := time.Now().Truncate(time.Minute)
	lateDue := now.Add(48 * time.Hour).UnixMilli()
	earlyDue := now.Add(2 * time.Hour).UnixMilli()

	var noDDL, lateItem, earlyItem model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "No DDL"}, 200, &noDDL)
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{
		Title:    "Late DDL",
		Deadline: &model.TaskDeadlineInput{DueAt: lateDue},
	}, 200, &lateItem)
	earlyOffsets := []int{60, 15}
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{
		Title: "Early DDL",
		Deadline: &model.TaskDeadlineInput{
			DueAt:         earlyDue,
			RemindOffsets: &earlyOffsets,
		},
	}, 200, &earlyItem)

	// Enqueue in reverse order: noDDL -> late -> early.
	noDDLQueue := model.TaskQueueInput{
		Record:       model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{TaskID: noDDL.ID, AgentID: agent.ID, CommandID: app.ID()},
	}
	lateQueue := model.TaskQueueInput{
		Record:       model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{TaskID: lateItem.ID, AgentID: agent.ID, CommandID: app.ID()},
	}
	earlyQueue := model.TaskQueueInput{
		Record:       model.TaskRecordWorkItem,
		TaskDispatch: model.TaskDispatch{TaskID: earlyItem.ID, AgentID: agent.ID, CommandID: app.ID()},
	}
	f.request("POST", "/tasks/queue", noDDLQueue, 200, nil)
	f.request("POST", "/tasks/queue", lateQueue, 200, nil)
	f.request("POST", "/tasks/queue", earlyQueue, 200, nil)

	// Verify EDF insertion order: early (#1) -> late (#2) -> noDDL (#3).
	if pos := f.taskWorkflow(earlyItem.ID).Queue.Position; pos != 1 {
		t.Fatalf("expected early DDL at position 1, got %d", pos)
	}
	if pos := f.taskWorkflow(lateItem.ID).Queue.Position; pos != 2 {
		t.Fatalf("expected late DDL at position 2, got %d", pos)
	}
	if pos := f.taskWorkflow(noDDL.ID).Queue.Position; pos != 3 {
		t.Fatalf("expected no-DDL at position 3, got %d", pos)
	}

	// Manual reorder still works after EDF insertion.
	f.request("PUT", "/tasks/queue/order", map[string]any{
		"agentId": agent.ID,
		"ids":     []string{noDDLQueue.CommandID, earlyQueue.CommandID, lateQueue.CommandID},
	}, 200, nil)
	if pos := f.taskWorkflow(noDDL.ID).Queue.Position; pos != 1 {
		t.Fatalf("manual reorder should move no-DDL to position 1, got %d", pos)
	}

	// 3. Reminder evaluation: multi-offset anti-storm & exact trigger.
	var overview model.Overview
	f.request("GET", "/overview", nil, 200, &overview)
	cursor := overview.Cursor

	// 90 minutes before earlyDue: nothing fires yet; next wake is 60m before.
	nextWake, err := f.a.CheckTaskRemindersAt(ctx, time.UnixMilli(earlyDue).Add(-90*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	wantWake := time.UnixMilli(earlyDue).Add(-60 * time.Minute)
	if !nextWake.Equal(wantWake) {
		t.Fatalf("expected next wake %v, got %v", wantWake, nextWake)
	}

	// Jump straight to 5 minutes before earlyDue (simulating sleep across both 60m and 15m):
	// both offsets must be marked fired, and ONLY ONE notice (closest = 15m) emitted.
	if _, err := f.a.CheckTaskRemindersAt(ctx, time.UnixMilli(earlyDue).Add(-5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	events, err := f.a.Store.Events(ctx, cursor)
	if err != nil {
		t.Fatal(err)
	}
	var notices []model.TaskReminderNotice
	for _, ev := range events {
		if ev.Sequence > cursor {
			cursor = ev.Sequence
		}
		if ev.Type == "task-reminder" && ev.TaskReminder != nil && ev.TaskReminder.TaskID == earlyItem.ID {
			notices = append(notices, *ev.TaskReminder)
		}
	}
	if len(notices) != 1 || notices[0].OffsetMinutes != 15 || notices[0].Snoozed {
		t.Fatalf("expected single coalesced 15m reminder notice, got %+v", notices)
	}

	// Repeat check at same time must NOT re-emit.
	if _, err := f.a.CheckTaskRemindersAt(ctx, time.UnixMilli(earlyDue).Add(-4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	events, err = f.a.Store.Events(ctx, cursor)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.Sequence > cursor {
			cursor = ev.Sequence
		}
		if ev.Type == "task-reminder" && ev.TaskReminder != nil && ev.TaskReminder.TaskID == earlyItem.ID {
			t.Fatalf("duplicate reminder fired: %+v", ev.TaskReminder)
		}
	}

	// 4. Snooze reminder fires once snooze duration elapses.
	var snoozed model.TaskDeadline
	f.request("POST", "/tasks/deadlines/"+earlyItem.ID+"/snooze", map[string]int{"minutes": 15}, 200, &snoozed)
	if snoozed.SnoozedUntil <= 0 {
		t.Fatalf("expected snoozedUntil to be set: %+v", snoozed)
	}
	if _, err := f.a.CheckTaskRemindersAt(ctx, time.UnixMilli(snoozed.SnoozedUntil).Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	events, err = f.a.Store.Events(ctx, cursor)
	if err != nil {
		t.Fatal(err)
	}
	var snoozeNotices []model.TaskReminderNotice
	for _, ev := range events {
		if ev.Sequence > cursor {
			cursor = ev.Sequence
		}
		if ev.Type == "task-reminder" && ev.TaskReminder != nil && ev.TaskReminder.TaskID == earlyItem.ID && ev.TaskReminder.Snoozed {
			snoozeNotices = append(snoozeNotices, *ev.TaskReminder)
		}
	}
	if len(snoozeNotices) != 1 {
		t.Fatalf("expected one snoozed reminder notice, got %+v", snoozeNotices)
	}

	// 5. All-day deadline uses AllDayReminderTime (08:30) and day offsets.
	var allDayItem model.WorkItem
	f.request("POST", "/tasks/work-items", model.UserWorkItemCreate{Title: "All day"}, 200, &allDayItem)
	allDayOffsets := []int{1440, 0}
	var savedAllDay model.TaskDeadline
	f.request("PUT", "/tasks/deadlines/"+allDayItem.ID, model.TaskDeadlineInput{
		DueDate:       "2026-12-10",
		RemindOffsets: &allDayOffsets,
	}, 200, &savedAllDay)
	if savedAllDay.DueDate != "2026-12-10" || savedAllDay.DueAt <= 0 {
		t.Fatalf("unexpected all-day deadline: %+v", savedAllDay)
	}
	dayBefore0830 := time.Date(2026, 12, 9, 8, 30, 0, 0, time.Local)
	if _, err := f.a.CheckTaskRemindersAt(ctx, dayBefore0830); err != nil {
		t.Fatal(err)
	}
	events, err = f.a.Store.Events(ctx, cursor)
	if err != nil {
		t.Fatal(err)
	}
	foundAllDay := false
	for _, ev := range events {
		if ev.Sequence > cursor {
			cursor = ev.Sequence
		}
		if ev.Type == "task-reminder" && ev.TaskReminder != nil && ev.TaskReminder.TaskID == allDayItem.ID && ev.TaskReminder.OffsetMinutes == 1440 {
			foundAllDay = true
		}
	}
	if !foundAllDay {
		t.Fatal("expected all-day 1-day-before reminder at 08:30 local time")
	}

	// 6. Marking task done suppresses future reminders; clearing removes row.
	f.request("PATCH", "/tasks/work-items/"+allDayItem.ID, map[string]bool{"done": true}, 200, nil)
	sameDay0830 := time.Date(2026, 12, 10, 8, 30, 0, 0, time.Local)
	if _, err := f.a.CheckTaskRemindersAt(ctx, sameDay0830); err != nil {
		t.Fatal(err)
	}
	events, err = f.a.Store.Events(ctx, cursor)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.Type == "task-reminder" && ev.TaskReminder != nil && ev.TaskReminder.TaskID == allDayItem.ID {
			t.Fatalf("completed task must not emit reminder: %+v", ev.TaskReminder)
		}
	}

	f.request("DELETE", "/tasks/deadlines/"+allDayItem.ID, nil, 200, nil)
	var deadlines []model.TaskDeadline
	f.request("GET", "/tasks/deadlines", nil, 200, &deadlines)
	for _, d := range deadlines {
		if d.TaskID == allDayItem.ID {
			t.Fatalf("expected deadline to be deleted: %+v", d)
		}
	}
}
