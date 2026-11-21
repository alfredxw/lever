package app

import (
	"slices"
	"time"
	_ "time/tzdata"

	"lever/internal/model"
)

const (
	automationClock              = "15:04"
	maxAutomationIntervalMinutes = 365 * 24 * 60
)

// automationCalendar is a validated wall-clock or elapsed-time schedule.
type automationCalendar struct {
	zone       *time.Location
	clock      time.Time
	once       time.Time
	weekdays   []int
	dayOfMonth int
	interval   time.Duration
}

func parseAutomationSchedule(s *model.AutomationSchedule) (automationCalendar, error) {
	if s != nil && s.IntervalMinutes != 0 {
		if s.IntervalMinutes < 1 || s.IntervalMinutes > maxAutomationIntervalMinutes {
			return automationCalendar{}, invalid("Choose an interval between 1 minute and 365 days")
		}
		if s.Date != "" || s.Time != "" || s.Timezone != "" || len(s.Weekdays) > 0 || s.DayOfMonth != 0 {
			return automationCalendar{}, invalid("Choose either a fixed interval or a calendar schedule")
		}
		return automationCalendar{interval: time.Duration(s.IntervalMinutes) * time.Minute}, nil
	}
	if s == nil || s.Timezone == "" || s.Timezone == "Local" {
		return automationCalendar{}, invalid("Choose a time and an IANA time zone")
	}
	zone, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return automationCalendar{}, invalid("Choose a valid IANA time zone")
	}
	clock, err := time.Parse(automationClock, s.Time)
	if err != nil || clock.Format(automationClock) != s.Time {
		return automationCalendar{}, invalid("Enter a time in HH:MM format")
	}
	if s.DayOfMonth < 0 || s.DayOfMonth > 31 || (s.DayOfMonth != 0 && (s.Date != "" || len(s.Weekdays) > 0)) {
		return automationCalendar{}, invalid("Choose a day from 1 to 31 for a monthly schedule")
	}
	calendar := automationCalendar{zone: zone, clock: clock, weekdays: s.Weekdays, dayOfMonth: s.DayOfMonth}
	for _, day := range s.Weekdays {
		if day < int(time.Sunday) || day > int(time.Saturday) {
			return automationCalendar{}, invalid("Choose weekdays from Sunday through Saturday")
		}
	}
	if s.Date != "" {
		const layout = time.DateOnly + " " + automationClock
		local := s.Date + " " + s.Time
		calendar.once, err = time.ParseInLocation(layout, local, zone)
		if err != nil || calendar.once.IsZero() || calendar.once.Format(layout) != local || len(s.Weekdays) > 0 {
			return automationCalendar{}, invalid("Choose a date and time that exist in this time zone")
		}
	}
	return calendar, nil
}

func (c automationCalendar) firstSlot(at time.Time) time.Time {
	if c.interval != 0 {
		return at.Add(c.interval)
	}
	return c.slot(at, true)
}

// dueSlots returns the latest due slot and the next slot after at. A fixed
// interval keeps its phase from nextAt even if the scheduler runs late.
func (c automationCalendar) dueSlots(at time.Time, nextAt int64) (int64, int64) {
	if c.interval != 0 {
		step := int64(c.interval / time.Second)
		latest := at.Unix() - (at.Unix()-nextAt)%step
		return latest, latest + step
	}
	return max(nextAt, automationUnix(c.slot(at, false))), automationUnix(c.slot(at, true))
}

// slot finds the next calendar slot strictly after at, or the latest at or
// before at. Missing dates and local times that fall in a DST gap are skipped.
func (c automationCalendar) slot(at time.Time, forward bool) time.Time {
	if !c.once.IsZero() {
		if c.once.After(at) == forward {
			return c.once
		}
		return time.Time{}
	}
	year, month, day := at.In(c.zone).Date()
	// Use UTC only to iterate dates. The actual scheduled time is local.
	date := time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	step := 1
	if !forward {
		step = -1
	}
	if c.dayOfMonth != 0 {
		monthStart := time.Date(year, month, 1, 0, 0, 0, 0, time.UTC)
		for range 12 {
			date := monthStart.AddDate(0, 0, c.dayOfMonth-1)
			if date.Month() == monthStart.Month() {
				if slot := c.slotOn(date, at, forward); !slot.IsZero() {
					return slot
				}
			}
			monthStart = monthStart.AddDate(0, step, 0)
		}
		return time.Time{}
	}
	for range 15 { // A skipped weekly time can move the next slot by a week.
		if len(c.weekdays) == 0 || slices.Contains(c.weekdays, int(date.Weekday())) {
			if slot := c.slotOn(date, at, forward); !slot.IsZero() {
				return slot
			}
		}
		date = date.AddDate(0, 0, step)
	}
	return time.Time{}
}

func (c automationCalendar) slotOn(date, at time.Time, forward bool) time.Time {
	year, month, day := date.Date()
	hour, minute, _ := c.clock.Clock()
	clock := time.Date(year, month, day, hour, minute, 0, 0, c.zone)
	if clock.Year() != year || clock.Month() != month || clock.Day() != day ||
		clock.Hour() != hour || clock.Minute() != minute || clock.After(at) != forward {
		return time.Time{}
	}
	return clock
}

func automationUnix(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}
