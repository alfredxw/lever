package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/store"
)

const (
	taskReminderSettingsKey = "task_reminder_settings"
	maxReminderOffsets      = 5
	maxReminderLeadMinutes  = 30 * 24 * 60 // 30 days
	minDeadlineUnixMilli    = 946684800000 // 2000-01-01T00:00:00Z
	maxDeadlineUnixMilli    = 4102444800000 // 2100-01-01T00:00:00Z
	staleReminderWindow     = 24 * time.Hour
	reminderMaxSleep        = 60 * time.Second
)

var defaultTaskReminderSettings = model.TaskReminderSettings{
	DefaultRemindOffsets: []int{30},
	AllDayReminderTime:   "09:00",
}

func parseReminderWallTime(raw string) (int, int, error) {
	raw = strings.TrimSpace(raw)
	parts := strings.Split(raw, ":")
	if len(parts) != 2 || len(parts[0]) != 2 || len(parts[1]) != 2 {
		return 0, 0, invalid("Choose a valid HH:MM reminder time")
	}
	hour, err1 := strconv.Atoi(parts[0])
	minute, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 0, 0, invalid("Choose a valid HH:MM reminder time")
	}
	return hour, minute, nil
}

func normalizeRemindOffsets(offsets []int) ([]int, error) {
	if len(offsets) > maxReminderOffsets {
		return nil, invalid("Configure up to 5 reminders per task")
	}
	result := make([]int, 0, len(offsets))
	for _, m := range offsets {
		if m < 0 || m > maxReminderLeadMinutes {
			return nil, invalid("Reminder lead time must be between 0 minutes and 30 days")
		}
		result = append(result, m)
	}
	slices.SortFunc(result, func(a, b int) int { return b - a })
	return slices.Compact(result), nil
}

func normalizeTaskReminderSettings(s model.TaskReminderSettings) (model.TaskReminderSettings, error) {
	if s.AllDayReminderTime == "" {
		s.AllDayReminderTime = defaultTaskReminderSettings.AllDayReminderTime
	}
	hour, minute, err := parseReminderWallTime(s.AllDayReminderTime)
	if err != nil {
		return model.TaskReminderSettings{}, err
	}
	s.AllDayReminderTime = fmt.Sprintf("%02d:%02d", hour, minute)
	offsets, err := normalizeRemindOffsets(s.DefaultRemindOffsets)
	if err != nil {
		return model.TaskReminderSettings{}, err
	}
	s.DefaultRemindOffsets = offsets
	return s, nil
}

func allDayEndUnixMilli(dueDate string, loc *time.Location) (int64, error) {
	parsed, err := time.Parse(time.DateOnly, dueDate)
	if err != nil {
		return 0, invalid("Choose a valid YYYY-MM-DD date")
	}
	return time.Date(parsed.Year(), parsed.Month(), parsed.Day()+1, 0, 0, 0, 0, loc).UnixMilli() - 1, nil
}

func normalizeDeadlineInput(input model.TaskDeadlineInput, loc *time.Location) (dueAt int64, dueDate string, remindOffsets *[]int, err error) {
	dueDate = strings.TrimSpace(input.DueDate)
	if dueDate != "" {
		dueAt, err = allDayEndUnixMilli(dueDate, loc)
		if err != nil {
			return 0, "", nil, err
		}
	} else {
		dueAt = input.DueAt
		if dueAt < minDeadlineUnixMilli || dueAt > maxDeadlineUnixMilli {
			return 0, "", nil, invalid("Choose a valid deadline")
		}
	}
	if input.RemindOffsets != nil {
		clean, err := normalizeRemindOffsets(*input.RemindOffsets)
		if err != nil {
			return 0, "", nil, err
		}
		remindOffsets = &clean
	}
	return dueAt, dueDate, remindOffsets, nil
}

func reminderTriggerTime(dueAt int64, dueDate string, offsetMinutes, allDayHour, allDayMinute int, loc *time.Location) time.Time {
	if dueDate != "" {
		if parsed, err := time.Parse(time.DateOnly, dueDate); err == nil {
			days := offsetMinutes / (24 * 60)
			return time.Date(parsed.Year(), parsed.Month(), parsed.Day(), allDayHour, allDayMinute, 0, 0, loc).AddDate(0, 0, -days)
		}
	}
	return time.UnixMilli(dueAt).Add(-time.Duration(offsetMinutes) * time.Minute)
}

func scanTaskDeadline(rows *sql.Rows) (model.TaskDeadline, error) {
	var d model.TaskDeadline
	var remindRaw sql.NullString
	var firedRaw string
	if err := rows.Scan(&d.TaskID, &d.DueAt, &d.DueDate, &remindRaw, &d.FiredDueAt, &firedRaw, &d.SnoozedUntil); err != nil {
		return d, err
	}
	if remindRaw.Valid && strings.TrimSpace(remindRaw.String) != "" {
		var offsets []int
		if err := json.Unmarshal([]byte(remindRaw.String), &offsets); err == nil {
			if offsets == nil {
				offsets = []int{}
			}
			d.RemindOffsets = &offsets
		}
	}
	if firedRaw != "" && firedRaw != "[]" {
		_ = json.Unmarshal([]byte(firedRaw), &d.FiredOffsets)
	}
	return d, nil
}

func listTaskDeadlines(ctx context.Context, q store.Queryer) ([]model.TaskDeadline, error) {
	rows, err := q.QueryContext(ctx, `SELECT task_id,due_at,due_date,remind_offsets_json,fired_due_at,fired_offsets_json,snoozed_until
FROM task_deadlines ORDER BY CASE WHEN due_at>0 THEN 0 ELSE 1 END, due_at ASC, task_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []model.TaskDeadline{}
	for rows.Next() {
		item, err := scanTaskDeadline(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	return list, rows.Err()
}

func getTaskDeadline(ctx context.Context, q store.Queryer, taskID string) (model.TaskDeadline, bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT task_id,due_at,due_date,remind_offsets_json,fired_due_at,fired_offsets_json,snoozed_until
FROM task_deadlines WHERE task_id=?`, taskID)
	if err != nil {
		return model.TaskDeadline{}, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return model.TaskDeadline{}, false, rows.Err()
	}
	item, err := scanTaskDeadline(rows)
	return item, err == nil, err
}

func upsertTaskDeadlineTx(ctx context.Context, tx *sql.Tx, taskID string, input model.TaskDeadlineInput, loc *time.Location) (model.TaskDeadline, error) {
	dueAt, dueDate, remindOffsets, err := normalizeDeadlineInput(input, loc)
	if err != nil {
		return model.TaskDeadline{}, err
	}
	var remindVal any
	if remindOffsets != nil {
		remindVal = store.JSON(*remindOffsets)
	}
	existing, found, err := getTaskDeadline(ctx, tx, taskID)
	if err != nil {
		return model.TaskDeadline{}, err
	}
	firedDueAt := int64(0)
	firedOffsets := []int{}
	snoozedUntil := int64(0)
	if found && existing.DueAt == dueAt && existing.DueDate == dueDate {
		// Preserve fired state only for offsets that remain unchanged when due time did not move.
		firedDueAt = existing.FiredDueAt
		firedOffsets = existing.FiredOffsets
		snoozedUntil = existing.SnoozedUntil
		if remindOffsets != nil {
			filtered := make([]int, 0, len(firedOffsets))
			for _, f := range firedOffsets {
				if slices.Contains(*remindOffsets, f) {
					filtered = append(filtered, f)
				}
			}
			firedOffsets = filtered
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO task_deadlines(task_id,due_at,due_date,remind_offsets_json,fired_due_at,fired_offsets_json,snoozed_until)
VALUES(?,?,?,?,?,?,?)
ON CONFLICT(task_id) DO UPDATE SET
  due_at=excluded.due_at,
  due_date=excluded.due_date,
  remind_offsets_json=excluded.remind_offsets_json,
  fired_due_at=excluded.fired_due_at,
  fired_offsets_json=excluded.fired_offsets_json,
  snoozed_until=excluded.snoozed_until`,
		taskID, dueAt, dueDate, remindVal, firedDueAt, store.JSON(firedOffsets), snoozedUntil); err != nil {
		return model.TaskDeadline{}, err
	}
	return model.TaskDeadline{
		TaskID:        taskID,
		DueAt:         dueAt,
		DueDate:       dueDate,
		RemindOffsets: remindOffsets,
		FiredDueAt:    firedDueAt,
		FiredOffsets:  firedOffsets,
		SnoozedUntil:  snoozedUntil,
	}, nil
}

func (a *App) TaskDeadlines(ctx context.Context) ([]model.TaskDeadline, error) {
	return listTaskDeadlines(ctx, a.Store.DB)
}

func (a *App) SetTaskDeadline(ctx context.Context, taskID string, input model.TaskDeadlineInput) (model.TaskDeadline, error) {
	if !taskIDPattern.MatchString(taskID) {
		return model.TaskDeadline{}, invalid("Choose a task")
	}
	if _, err := a.LocateTask(ctx, taskID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.TaskDeadline{}, conflict("Task not found")
		}
		return model.TaskDeadline{}, err
	}
	var saved model.TaskDeadline
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		var err error
		saved, err = upsertTaskDeadlineTx(ctx, tx, taskID, input, time.Local)
		if err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-deadlines"})
	})
	if err == nil {
		a.wakeTaskReminders()
	}
	return saved, err
}

func (a *App) ClearTaskDeadline(ctx context.Context, taskID string) error {
	if !taskIDPattern.MatchString(taskID) {
		return invalid("Choose a task")
	}
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM task_deadlines WHERE task_id=?", taskID); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-deadlines"})
	})
	if err == nil {
		a.wakeTaskReminders()
	}
	return err
}

func (a *App) SnoozeTaskDeadline(ctx context.Context, taskID string, minutes int) (model.TaskDeadline, error) {
	if !taskIDPattern.MatchString(taskID) {
		return model.TaskDeadline{}, invalid("Choose a task")
	}
	if minutes < 1 || minutes > 7*24*60 {
		return model.TaskDeadline{}, invalid("Snooze duration must be between 1 minute and 7 days")
	}
	if _, err := a.LocateTask(ctx, taskID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.TaskDeadline{}, conflict("Task not found")
		}
		return model.TaskDeadline{}, err
	}
	until := time.Now().Add(time.Duration(minutes) * time.Minute).UnixMilli()
	var saved model.TaskDeadline
	err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO task_deadlines(task_id,due_at,due_date,remind_offsets_json,fired_due_at,fired_offsets_json,snoozed_until)
VALUES(?,0,'',NULL,0,'[]',?)
ON CONFLICT(task_id) DO UPDATE SET snoozed_until=excluded.snoozed_until`, taskID, until); err != nil {
			return err
		}
		var err error
		saved, _, err = getTaskDeadline(ctx, tx, taskID)
		if err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-deadlines"})
	})
	if err == nil {
		a.wakeTaskReminders()
	}
	return saved, err
}

func (a *App) TaskReminderSettings(ctx context.Context) (model.TaskReminderSettings, error) {
	var raw string
	err := a.Store.DB.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", taskReminderSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultTaskReminderSettings, nil
	}
	if err != nil {
		return defaultTaskReminderSettings, err
	}
	var parsed model.TaskReminderSettings
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return defaultTaskReminderSettings, nil
	}
	normalized, err := normalizeTaskReminderSettings(parsed)
	if err != nil {
		return defaultTaskReminderSettings, nil
	}
	return normalized, nil
}

func (a *App) SaveTaskReminderSettings(ctx context.Context, input model.TaskReminderSettings) (model.TaskReminderSettings, error) {
	normalized, err := normalizeTaskReminderSettings(input)
	if err != nil {
		return model.TaskReminderSettings{}, err
	}
	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO settings(key,value) VALUES(?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, taskReminderSettingsKey, store.JSON(normalized)); err != nil {
			return err
		}
		return store.Event(tx, model.Event{Type: "task-reminder-settings"})
	})
	if err == nil {
		a.wakeTaskReminders()
	}
	return normalized, err
}

// effectiveTaskDueAt returns the effective Unix-ms deadline for a task (local
// override first, then synced external task deadline, or 0 if unscheduled).
func effectiveTaskDueAt(ctx context.Context, q store.Queryer, taskID string) (int64, error) {
	var dueAt int64
	err := q.QueryRowContext(ctx, `
SELECT COALESCE(
  (SELECT NULLIF(due_at, 0) FROM task_deadlines WHERE task_id=?),
  (SELECT NULLIF(CAST(COALESCE(json_extract(data,'$.dueAt'),0) AS INTEGER), 0) FROM external_tasks WHERE id=?),
  0
)`, taskID, taskID).Scan(&dueAt)
	return dueAt, err
}

func (a *App) wakeTaskReminders() {
	if a.taskReminderWake == nil {
		return
	}
	select {
	case a.taskReminderWake <- struct{}{}:
	default:
	}
}

func (a *App) runTaskReminders() {
	defer a.wg.Done()
	for a.ctx.Err() == nil {
		nextAt, err := a.CheckTaskRemindersAt(a.ctx, time.Now())
		delay := reminderMaxSleep
		if err != nil && a.ctx.Err() == nil {
			slog.Error("Check task deadline reminders", "error", err)
			delay = 15 * time.Second
		} else if !nextAt.IsZero() {
			if until := time.Until(nextAt); until < delay {
				if until < time.Second {
					delay = time.Second
				} else {
					delay = until
				}
			}
		}
		timer := time.NewTimer(delay)
		select {
		case <-a.ctx.Done():
			timer.Stop()
			return
		case <-a.taskReminderWake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

type reminderCandidate struct {
	taskID        string
	title         string
	dueAt         int64
	dueDate       string
	hasLocalRow   bool
	localDueAt    int64
	localDueDate  string
	remindOffsets *[]int
	firedDueAt    int64
	firedOffsets  []int
	snoozedUntil  int64
}

func (a *App) loadReminderCandidates(ctx context.Context) ([]reminderCandidate, error) {
	deadlines, err := listTaskDeadlines(ctx, a.Store.DB)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]model.TaskDeadline, len(deadlines))
	for _, d := range deadlines {
		byID[d.TaskID] = d
	}

	closedSet := map[string]bool{}
	closedRows, err := a.Store.DB.QueryContext(ctx, "SELECT task_id FROM task_triage WHERE closed=1")
	if err != nil {
		return nil, err
	}
	for closedRows.Next() {
		var id string
		if err := closedRows.Scan(&id); err != nil {
			closedRows.Close()
			return nil, err
		}
		closedSet[id] = true
	}
	closedRows.Close()
	if err := closedRows.Err(); err != nil {
		return nil, err
	}

	resolved := map[string]bool{}
	candidates := []reminderCandidate{}

	// 1. Open native work items with a local deadline.
	workRows, err := a.Store.DB.QueryContext(ctx, `
SELECT w.id, COALESCE(json_extract(w.data,'$.title'),''), COALESCE(json_extract(w.data,'$.done'),0)
FROM work_items w JOIN task_deadlines d ON d.task_id=w.id`)
	if err != nil {
		return nil, err
	}
	for workRows.Next() {
		var id, title string
		var done bool
		if err := workRows.Scan(&id, &title, &done); err != nil {
			workRows.Close()
			return nil, err
		}
		resolved[id] = true
		d := byID[id]
		if done || closedSet[id] || d.DueAt <= 0 {
			continue
		}
		candidates = append(candidates, reminderCandidate{
			taskID: id, title: title, dueAt: d.DueAt, dueDate: d.DueDate,
			hasLocalRow: true, localDueAt: d.DueAt, localDueDate: d.DueDate,
			remindOffsets: d.RemindOffsets, firedDueAt: d.FiredDueAt,
			firedOffsets: d.FiredOffsets, snoozedUntil: d.SnoozedUntil,
		})
	}
	workRows.Close()
	if err := workRows.Err(); err != nil {
		return nil, err
	}

	// 2. Open external tasks with either a local deadline row or a synced dueAt.
	extRows, err := a.Store.DB.QueryContext(ctx, `
SELECT e.id, COALESCE(json_extract(e.data,'$.title'),''), e.done,
  COALESCE(CAST(json_extract(e.data,'$.dueAt') AS INTEGER), 0),
  COALESCE(json_extract(e.data,'$.dueDate'),'')
FROM external_tasks e
JOIN task_sources s ON s.id=e.source_id
LEFT JOIN task_deadlines d ON d.task_id=e.id
WHERE d.task_id IS NOT NULL OR (
  s.status<>'removed' AND e.in_scope=1 AND COALESCE(json_extract(e.data,'$.state'),'')='open'
  AND COALESCE(CAST(json_extract(e.data,'$.dueAt') AS INTEGER), 0) > 0
)`)
	if err != nil {
		return nil, err
	}
	for extRows.Next() {
		var id, title, extDueDate string
		var done bool
		var extDueAt int64
		if err := extRows.Scan(&id, &title, &done, &extDueAt, &extDueDate); err != nil {
			extRows.Close()
			return nil, err
		}
		resolved[id] = true
		if done || closedSet[id] {
			continue
		}
		d, hasLocal := byID[id]
		dueAt := extDueAt
		dueDate := extDueDate
		if hasLocal && d.DueAt > 0 {
			dueAt = d.DueAt
			dueDate = d.DueDate
		}
		if dueAt <= 0 {
			continue
		}
		candidates = append(candidates, reminderCandidate{
			taskID: id, title: title, dueAt: dueAt, dueDate: dueDate,
			hasLocalRow: hasLocal, localDueAt: d.DueAt, localDueDate: d.DueDate,
			remindOffsets: d.RemindOffsets, firedDueAt: d.FiredDueAt,
			firedOffsets: d.FiredOffsets, snoozedUntil: d.SnoozedUntil,
		})
	}
	extRows.Close()
	if err := extRows.Err(); err != nil {
		return nil, err
	}

	// 3. Only read notes from disk when unresolved local deadline rows remain.
	var noteIDs []string
	for id, d := range byID {
		if !resolved[id] && !closedSet[id] && d.DueAt > 0 {
			noteIDs = append(noteIDs, id)
		}
	}
	if len(noteIDs) > 0 {
		a.notesMu.Lock()
		catalog, err := a.readNotes(ctx)
		a.notesMu.Unlock()
		if err == nil {
			for _, id := range noteIDs {
				task, ok := catalog.tasks[id]
				if !ok || task.Done || task.Deleted || catalog.conflicts[task.NoteID] != nil {
					continue
				}
				d := byID[id]
				candidates = append(candidates, reminderCandidate{
					taskID: id, title: task.Title, dueAt: d.DueAt, dueDate: d.DueDate,
					hasLocalRow: true, localDueAt: d.DueAt, localDueDate: d.DueDate,
					remindOffsets: d.RemindOffsets, firedDueAt: d.FiredDueAt,
					firedOffsets: d.FiredOffsets, snoozedUntil: d.SnoozedUntil,
				})
			}
		}
	}
	return candidates, nil
}

// CheckTaskRemindersAt evaluates all open tasks against now, fires due
// reminders (suppressing storms after sleep/restart), and returns the next
// scheduled wake time.
func (a *App) CheckTaskRemindersAt(ctx context.Context, now time.Time) (time.Time, error) {
	settings, err := a.TaskReminderSettings(ctx)
	if err != nil {
		return time.Time{}, err
	}
	allDayHour, allDayMinute, err := parseReminderWallTime(settings.AllDayReminderTime)
	if err != nil {
		allDayHour, allDayMinute = 9, 0
	}
	candidates, err := a.loadReminderCandidates(ctx)
	if err != nil {
		return time.Time{}, err
	}

	type pendingUpdate struct {
		candidate    reminderCandidate
		firedDueAt   int64
		firedOffsets []int
		snoozedUntil int64
		notice       *model.TaskReminderNotice
	}
	var updates []pendingUpdate
	var nextWake time.Time
	recordWake := func(at time.Time) {
		if at.IsZero() {
			return
		}
		if nextWake.IsZero() || at.Before(nextWake) {
			nextWake = at
		}
	}

	loc := now.Location()
	nowMs := now.UnixMilli()
	for _, c := range candidates {
		firedDueAt := c.firedDueAt
		var fired []int
		if firedDueAt == c.dueAt {
			fired = append([]int{}, c.firedOffsets...)
		} else {
			firedDueAt = c.dueAt
		}
		snoozedUntil := c.snoozedUntil
		var notice *model.TaskReminderNotice
		dirty := false

		// Handle active snooze.
		if snoozedUntil > 0 {
			snoozeAt := time.UnixMilli(snoozedUntil)
			if !now.Before(snoozeAt) {
				if now.Sub(snoozeAt) <= staleReminderWindow {
					notice = &model.TaskReminderNotice{
						ID:            fmt.Sprintf("%s:snooze:%d", c.taskID, snoozedUntil),
						TaskID:        c.taskID,
						Title:         c.title,
						DueAt:         c.dueAt,
						DueDate:       c.dueDate,
						OffsetMinutes: -1,
						Snoozed:       true,
						TriggeredAt:   nowMs,
					}
				}
				snoozedUntil = 0
				dirty = true
			} else {
				recordWake(snoozeAt)
			}
		}

		// Handle lead-time offsets.
		offsets := settings.DefaultRemindOffsets
		if c.remindOffsets != nil {
			offsets = *c.remindOffsets
		}
		var dueOffsets []int
		for _, offset := range offsets {
			if slices.Contains(fired, offset) {
				continue
			}
			triggerAt := reminderTriggerTime(c.dueAt, c.dueDate, offset, allDayHour, allDayMinute, loc)
			if !now.Before(triggerAt) {
				dueOffsets = append(dueOffsets, offset)
			} else {
				recordWake(triggerAt)
			}
		}
		if len(dueOffsets) > 0 {
			fired = append(fired, dueOffsets...)
			slices.SortFunc(fired, func(a, b int) int { return b - a })
			fired = slices.Compact(fired)
			dirty = true
			// Emit at most one notification per task (closest offset) if not stale overdue.
			if notice == nil && now.Sub(time.UnixMilli(c.dueAt)) <= staleReminderWindow {
				closest := slices.Min(dueOffsets)
				notice = &model.TaskReminderNotice{
					ID:            fmt.Sprintf("%s:%d:%d", c.taskID, c.dueAt, closest),
					TaskID:        c.taskID,
					Title:         c.title,
					DueAt:         c.dueAt,
					DueDate:       c.dueDate,
					OffsetMinutes: closest,
					TriggeredAt:   nowMs,
				}
			}
		}

		if dirty {
			updates = append(updates, pendingUpdate{
				candidate:    c,
				firedDueAt:   firedDueAt,
				firedOffsets: fired,
				snoozedUntil: snoozedUntil,
				notice:       notice,
			})
		}
	}

	if len(updates) == 0 {
		return nextWake, nil
	}

	err = a.Store.Write(ctx, func(tx *sql.Tx) error {
		emittedAny := false
		for _, u := range updates {
			var remindVal any
			if u.candidate.remindOffsets != nil {
				remindVal = store.JSON(*u.candidate.remindOffsets)
			}
			if _, err := tx.ExecContext(ctx, `
INSERT INTO task_deadlines(task_id,due_at,due_date,remind_offsets_json,fired_due_at,fired_offsets_json,snoozed_until)
VALUES(?,?,?,?,?,?,?)
ON CONFLICT(task_id) DO UPDATE SET
  fired_due_at=excluded.fired_due_at,
  fired_offsets_json=excluded.fired_offsets_json,
  snoozed_until=excluded.snoozed_until`,
				u.candidate.taskID, u.candidate.localDueAt, u.candidate.localDueDate, remindVal,
				u.firedDueAt, store.JSON(u.firedOffsets), u.snoozedUntil); err != nil {
				return err
			}
			if u.notice != nil {
				emittedAny = true
				if err := store.Event(tx, model.Event{Type: "task-reminder", TaskReminder: u.notice}); err != nil {
					return err
				}
			}
		}
		if emittedAny || len(updates) > 0 {
			if err := store.Event(tx, model.Event{Type: "task-deadlines"}); err != nil {
				return err
			}
		}
		return nil
	})
	return nextWake, err
}
