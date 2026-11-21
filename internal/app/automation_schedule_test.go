package app

import (
	"testing"
	"time"

	"lever/internal/model"
)

func TestAutomationWeeklySlotAcrossDaylightSaving(t *testing.T) {
	rule := model.AutomationSchedule{Time: "02:30", Timezone: "America/New_York", Weekdays: []int{0}}
	calendar, err := parseAutomationSchedule(&rule)
	if err != nil {
		t.Fatal(err)
	}
	// March 8 has no 02:30. The adjacent Sundays have different UTC offsets.
	at := time.Date(2026, time.March, 8, 16, 0, 0, 0, time.UTC)
	if got := calendar.slot(at, false).UTC(); !got.Equal(time.Date(2026, time.March, 1, 7, 30, 0, 0, time.UTC)) {
		t.Fatalf("wrong previous Sunday: %s", got)
	}
	if got := calendar.slot(at, true).UTC(); !got.Equal(time.Date(2026, time.March, 15, 6, 30, 0, 0, time.UTC)) {
		t.Fatalf("wrong next Sunday: %s", got)
	}
	rule.Date, rule.Weekdays = "2026-03-08", nil
	if _, err := parseAutomationSchedule(&rule); err == nil {
		t.Fatal("accepted a one-shot at a nonexistent local time")
	}
}

func TestAutomationMonthlySlotSkipsMissingDates(t *testing.T) {
	calendar, err := parseAutomationSchedule(&model.AutomationSchedule{
		Time: "09:15", Timezone: "America/New_York", DayOfMonth: 31,
	})
	if err != nil {
		t.Fatal(err)
	}
	// February has no 31st, and March 31 has a different UTC offset from January 31.
	at := time.Date(2026, time.February, 28, 12, 0, 0, 0, time.UTC)
	previous := time.Date(2026, time.January, 31, 14, 15, 0, 0, time.UTC)
	next := time.Date(2026, time.March, 31, 13, 15, 0, 0, time.UTC)
	if got := calendar.slot(at, false); !got.Equal(previous) {
		t.Fatalf("previous month slot: got %s, want %s", got, previous)
	}
	if got := calendar.firstSlot(at); !got.Equal(next) {
		t.Fatalf("next month slot: got %s, want %s", got, next)
	}
}

func TestAutomationFixedIntervalPreservesPhase(t *testing.T) {
	calendar, err := parseAutomationSchedule(&model.AutomationSchedule{IntervalMinutes: 13})
	if err != nil {
		t.Fatal(err)
	}
	savedAt := time.Date(2026, time.November, 16, 8, 32, 23, 0, time.UTC)
	first := calendar.firstSlot(savedAt)
	if want := time.Date(2026, time.November, 16, 8, 45, 23, 0, time.UTC); !first.Equal(want) {
		t.Fatalf("first run: got %s, want %s", first, want)
	}
	// Several slots passed while Lever was closed. Dispatch only the latest, then
	// stay on the original cadence even though we woke up between slots.
	wake := time.Date(2026, time.November, 16, 9, 15, 0, 0, time.UTC)
	due, next := calendar.dueSlots(wake, first.Unix())
	if want := time.Date(2026, time.November, 16, 9, 11, 23, 0, time.UTC); due != want.Unix() {
		t.Errorf("latest due run: got %s, want %s", time.Unix(due, 0), want)
	}
	if want := time.Date(2026, time.November, 16, 9, 24, 23, 0, time.UTC); next != want.Unix() {
		t.Errorf("next run: got %s, want %s", time.Unix(next, 0), want)
	}
}

func TestAutomationRejectsConflictingScheduleFields(t *testing.T) {
	for _, rule := range []model.AutomationSchedule{
		{IntervalMinutes: -1},
		{IntervalMinutes: maxAutomationIntervalMinutes + 1},
		{IntervalMinutes: 30, Time: "09:00", Timezone: "UTC"},
		{Time: "09:00", Timezone: "UTC", DayOfMonth: 32},
		{Time: "09:00", Timezone: "UTC", DayOfMonth: 31, Weekdays: []int{1}},
		{Time: "09:00", Timezone: "UTC", DayOfMonth: 31, Date: "2026-12-31"},
	} {
		if _, err := parseAutomationSchedule(&rule); err == nil {
			t.Errorf("accepted invalid schedule: %+v", rule)
		}
	}
}
