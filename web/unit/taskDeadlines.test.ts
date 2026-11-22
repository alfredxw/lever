import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReminderTriggerMs,
  matchesDueFilter,
  normalizeOffsets,
  resolveTaskDeadline,
} from "../src/features/tasks/taskDeadlineLogic.ts";

test("computeReminderTriggerMs handles exact-time and all-day deadlines", () => {
  const exactDue = new Date(2026, 10, 25, 18, 0, 0, 0).getTime();
  assert.equal(
    computeReminderTriggerMs(exactDue, "", 30, "09:00"),
    new Date(2026, 10, 25, 17, 30, 0, 0).getTime(),
  );
  assert.equal(
    computeReminderTriggerMs(exactDue, "", 0, "09:00"),
    exactDue,
  );

  // All-day task: 0 / sub-day offsets trigger at AllDayReminderTime on due day; day offsets subtract calendar days.
  const allDayEnd = new Date(2026, 10, 26, 0, 0, 0, 0).getTime() - 1;
  assert.equal(
    computeReminderTriggerMs(allDayEnd, "2026-11-25", 0, "09:00"),
    new Date(2026, 10, 25, 9, 0, 0, 0).getTime(),
  );
  assert.equal(
    computeReminderTriggerMs(allDayEnd, "2026-11-25", 30, "09:00"),
    new Date(2026, 10, 25, 9, 0, 0, 0).getTime(),
  );
  assert.equal(
    computeReminderTriggerMs(allDayEnd, "2026-11-25", 1440, "08:30"),
    new Date(2026, 10, 24, 8, 30, 0, 0).getTime(),
  );
});

test("resolveTaskDeadline merges local override, external default, urgency, and done dimming", () => {
  const nowMs = new Date(2026, 10, 22, 10, 0, 0, 0).getTime();
  const settings = { defaultRemindOffsets: [30], allDayReminderTime: "09:00" };

  // Overdue open task.
  const overdue = resolveTaskDeadline({
    local: {
      taskId: "t1",
      dueAt: new Date(2026, 10, 22, 9, 0, 0, 0).getTime(),
      remindOffsets: [30],
    },
    done: false,
    closed: false,
    settings,
    nowMs,
  });
  assert.equal(overdue?.urgency, "overdue");
  assert.equal(overdue?.attentionActive, true);

  // Soon task inside 30m reminder window.
  const soon = resolveTaskDeadline({
    local: {
      taskId: "t2",
      dueAt: new Date(2026, 10, 22, 10, 20, 0, 0).getTime(),
      remindOffsets: [30],
    },
    done: false,
    closed: false,
    settings,
    nowMs,
  });
  assert.equal(soon?.urgency, "soon");
  assert.equal(soon?.attentionActive, true);

  // Snoozed soon task temporarily pauses attentionActive.
  const snoozed = resolveTaskDeadline({
    local: {
      taskId: "t2",
      dueAt: new Date(2026, 10, 22, 10, 20, 0, 0).getTime(),
      remindOffsets: [30],
      snoozedUntil: nowMs + 15 * 60_000,
    },
    done: false,
    closed: false,
    settings,
    nowMs,
  });
  assert.equal(snoozed?.urgency, "soon");
  assert.equal(snoozed?.attentionActive, false);

  // Synced external deadline inherits global defaults when no local override exists.
  const externalFuture = new Date(2026, 10, 25, 18, 0, 0, 0).getTime();
  const ext = resolveTaskDeadline({
    externalDueAt: externalFuture,
    done: false,
    closed: false,
    settings,
    nowMs,
  });
  assert.equal(ext?.dueAt, externalFuture);
  assert.equal(ext?.isExternalDefault, true);
  assert.deepEqual(ext?.remindOffsets, [30]);
  assert.equal(ext?.urgency, "upcoming");

  // Completed task dims urgency and never activates attention.
  const completed = resolveTaskDeadline({
    local: {
      taskId: "t1",
      dueAt: new Date(2026, 10, 22, 9, 0, 0, 0).getTime(),
      remindOffsets: [30],
    },
    done: true,
    closed: false,
    settings,
    nowMs,
  });
  assert.equal(completed?.urgency, "done");
  assert.equal(completed?.attentionActive, false);
});

test("matchesDueFilter and normalizeOffsets", () => {
  const nowMs = new Date(2026, 10, 22, 10, 0, 0, 0).getTime();
  const settings = { defaultRemindOffsets: [30], allDayReminderTime: "09:00" };
  const overdue = resolveTaskDeadline({
    local: { taskId: "a", dueAt: nowMs - 60_000 },
    done: false,
    closed: false,
    settings,
    nowMs,
  });
  const today = resolveTaskDeadline({
    local: { taskId: "b", dueAt: new Date(2026, 10, 22, 18, 0, 0, 0).getTime() },
    done: false,
    closed: false,
    settings,
    nowMs,
  });
  assert.equal(matchesDueFilter(overdue, ["overdue"], nowMs), true);
  assert.equal(matchesDueFilter(today, ["today"], nowMs), true);
  assert.equal(matchesDueFilter(today, ["week"], nowMs), true);
  assert.equal(matchesDueFilter(undefined, ["none"], nowMs), true);
  assert.equal(matchesDueFilter(undefined, ["scheduled"], nowMs), false);

  assert.deepEqual(normalizeOffsets([15, 1440, 15, -5, 60]), [1440, 60, 15]);
});
