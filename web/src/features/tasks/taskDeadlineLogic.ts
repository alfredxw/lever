import type { TFunction } from "i18next";
import type { TaskDeadline, TaskReminderSettings } from "../../api/types.gen";

export const defaultReminderSettings: TaskReminderSettings = {
  defaultRemindOffsets: [30],
  allDayReminderTime: "09:00",
};

export const exactReminderPresets = [0, 15, 30, 60, 120, 1440] as const;
export const allDayReminderPresets = [0, 1440, 2880, 10080] as const;
export const defaultReminderChoiceOffsets = [-1, 15, 30, 60, 1440] as const;

export type DeadlineUrgency = "overdue" | "soon" | "upcoming" | "done";

export type EffectiveTaskDeadline = {
  dueAt: number;
  dueDate: string;
  isAllDay: boolean;
  remindOffsets: number[];
  explicitReminders: boolean;
  hasLocalOverride: boolean;
  isExternalDefault: boolean;
  firedOffsets: number[];
  snoozedUntil: number;
  urgency: DeadlineUrgency;
  attentionActive: boolean;
};

export function parseWallTime(raw?: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((raw ?? "").trim());
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function formatLocalDateISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseLocalDateISO(dueDate: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, month, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month ||
    parsed.getDate() !== day
  ) {
    return undefined;
  }
  return parsed;
}

export function localEndOfDayMs(date: Date): number {
  return (
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
      0,
      0,
      0,
      0,
    ).getTime() - 1
  );
}

export function localStartOfDayMs(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();
}

export function computeReminderTriggerMs(
  dueAt: number,
  dueDate: string,
  offsetMinutes: number,
  allDayReminderTime = "09:00",
): number {
  if (dueDate) {
    const parsed = parseLocalDateISO(dueDate);
    if (parsed) {
      const { hour, minute } = parseWallTime(allDayReminderTime);
      const days = Math.floor(offsetMinutes / 1440);
      return new Date(
        parsed.getFullYear(),
        parsed.getMonth(),
        parsed.getDate() - days,
        hour,
        minute,
        0,
        0,
      ).getTime();
    }
  }
  return dueAt - offsetMinutes * 60_000;
}

export function normalizeOffsets(offsets: number[]): number[] {
  const unique = new Set<number>();
  for (const m of offsets) {
    if (Number.isInteger(m) && m >= 0 && m <= 30 * 1440) unique.add(m);
  }
  return [...unique].sort((a, b) => b - a).slice(0, 5);
}

export function resolveTaskDeadline({
  local,
  externalDueAt,
  externalDueDate,
  done,
  closed,
  settings,
  nowMs,
}: {
  local?: TaskDeadline;
  externalDueAt?: number;
  externalDueDate?: string;
  done: boolean;
  closed: boolean;
  settings?: TaskReminderSettings;
  nowMs: number;
}): EffectiveTaskDeadline | undefined {
  const effectiveSettings = settings ?? defaultReminderSettings;
  const hasLocalDue = !!local && (local.dueAt ?? 0) > 0;
  const dueAt = hasLocalDue ? local.dueAt! : (externalDueAt ?? 0);
  const dueDate = hasLocalDue ? (local.dueDate ?? "") : (externalDueDate ?? "");
  if (dueAt <= 0) return undefined;

  const isAllDay = dueDate.length > 0;
  const explicitReminders = local?.remindOffsets !== undefined;
  const remindOffsets = explicitReminders
    ? local!.remindOffsets!
    : effectiveSettings.defaultRemindOffsets;
  const firedOffsets =
    local?.firedDueAt === dueAt ? (local.firedOffsets ?? []) : [];
  const snoozedUntil = local?.snoozedUntil ?? 0;

  if (done || closed) {
    return {
      dueAt,
      dueDate,
      isAllDay,
      remindOffsets,
      explicitReminders,
      hasLocalOverride: hasLocalDue,
      isExternalDefault: !hasLocalDue && (externalDueAt ?? 0) > 0,
      firedOffsets,
      snoozedUntil: 0,
      urgency: "done",
      attentionActive: false,
    };
  }

  const todayEnd = localEndOfDayMs(new Date(nowMs));
  const isOverdue = nowMs > dueAt;
  const isDueToday = !isOverdue && dueAt <= todayEnd;
  const inReminderWindow = remindOffsets.some(
    (offset) =>
      nowMs >=
      computeReminderTriggerMs(
        dueAt,
        dueDate,
        offset,
        effectiveSettings.allDayReminderTime,
      ),
  );
  const snoozeHolding = snoozedUntil > nowMs;
  const urgency: DeadlineUrgency = isOverdue
    ? "overdue"
    : isDueToday || inReminderWindow
      ? "soon"
      : "upcoming";
  const attentionActive =
    isOverdue ||
    (!snoozeHolding && (inReminderWindow || firedOffsets.length > 0));

  return {
    dueAt,
    dueDate,
    isAllDay,
    remindOffsets,
    explicitReminders,
    hasLocalOverride: hasLocalDue,
    isExternalDefault: !hasLocalDue && (externalDueAt ?? 0) > 0,
    firedOffsets,
    snoozedUntil,
    urgency,
    attentionActive,
  };
}

export type DueFilterValue = "overdue" | "today" | "week" | "scheduled" | "none";

export const dueFilterValues: readonly DueFilterValue[] = [
  "overdue",
  "today",
  "week",
  "scheduled",
  "none",
];

export function matchesDueFilter(
  deadline: EffectiveTaskDeadline | undefined,
  selected: string[],
  nowMs: number,
): boolean {
  if (!selected.length) return true;
  const todayEnd = localEndOfDayMs(new Date(nowMs));
  const weekEnd = todayEnd + 7 * 24 * 60 * 60 * 1000;
  return selected.some((filter) => {
    switch (filter) {
      case "overdue":
        return !!deadline && deadline.urgency === "overdue";
      case "today":
        return (
          !!deadline &&
          deadline.urgency !== "done" &&
          deadline.dueAt >= localStartOfDayMs(new Date(nowMs)) &&
          deadline.dueAt <= todayEnd
        );
      case "week":
        return (
          !!deadline &&
          deadline.urgency !== "done" &&
          deadline.dueAt >= nowMs &&
          deadline.dueAt <= weekEnd
        );
      case "scheduled":
        return !!deadline;
      case "none":
        return !deadline;
      default:
        return true;
    }
  });
}

function dayDiff(target: Date, now: Date): number {
  const targetStart = localStartOfDayMs(target);
  const nowStart = localStartOfDayMs(now);
  return Math.round((targetStart - nowStart) / (24 * 60 * 60 * 1000));
}

export function formatTimeHM(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatDeadlineLabel(
  deadline: Pick<EffectiveTaskDeadline, "dueAt" | "dueDate" | "isAllDay" | "urgency">,
  nowMs: number,
  t: TFunction,
  language: string,
): string {
  const now = new Date(nowMs);
  const target = deadline.isAllDay
    ? (parseLocalDateISO(deadline.dueDate) ?? new Date(deadline.dueAt))
    : new Date(deadline.dueAt);

  if (deadline.urgency === "overdue") {
    const overdueMs = Math.max(60_000, nowMs - deadline.dueAt);
    const overdueMinutes = Math.floor(overdueMs / 60_000);
    if (overdueMinutes < 60) {
      return t("tasks.deadline.overdueMinutes", { count: overdueMinutes });
    }
    const overdueHours = Math.floor(overdueMinutes / 60);
    if (overdueHours < 24) {
      return t("tasks.deadline.overdueHours", { count: overdueHours });
    }
    const overdueDays = Math.max(1, Math.floor(overdueHours / 24));
    return t("tasks.deadline.overdueDays", { count: overdueDays });
  }

  const diff = dayDiff(target, now);
  const timeText = deadline.isAllDay ? "" : ` ${formatTimeHM(target)}`;

  if (!deadline.isAllDay && deadline.urgency === "soon") {
    const remainingMin = Math.ceil((deadline.dueAt - nowMs) / 60_000);
    if (remainingMin > 0 && remainingMin < 60) {
      return t("tasks.deadline.leftMinutes", { count: remainingMin });
    }
  }

  if (diff === 0) {
    return `${t("tasks.deadline.today")}${timeText}`;
  }
  if (diff === 1) {
    return `${t("tasks.deadline.tomorrow")}${timeText}`;
  }
  if (diff === -1) {
    return `${t("tasks.deadline.yesterday")}${timeText}`;
  }

  const sameYear = target.getFullYear() === now.getFullYear();
  const dateFormatter = new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
  });
  return `${dateFormatter.format(target)}${timeText}`;
}

export function formatDeadlineFull(
  deadline: Pick<EffectiveTaskDeadline, "dueAt" | "dueDate" | "isAllDay">,
  t: TFunction,
  language: string,
): string {
  const target = deadline.isAllDay
    ? (parseLocalDateISO(deadline.dueDate) ?? new Date(deadline.dueAt))
    : new Date(deadline.dueAt);
  if (deadline.isAllDay) {
    const formatted = new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
    }).format(target);
    return `${formatted} · ${t("tasks.deadline.allDay")}`;
  }
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(target);
}

export function formatReminderOffset(
  minutes: number,
  isAllDay: boolean,
  allDayTime: string,
  t: TFunction,
): string {
  if (isAllDay) {
    const days = Math.floor(minutes / 1440);
    if (days <= 0) {
      return t("tasks.reminder.sameDayAt", { time: allDayTime });
    }
    return t("tasks.reminder.daysBeforeAt", { count: days, time: allDayTime });
  }
  if (minutes === 0) return t("tasks.reminder.atTime");
  if (minutes % 1440 === 0) {
    return t("tasks.reminder.daysBefore", { count: minutes / 1440 });
  }
  if (minutes % 60 === 0) {
    return t("tasks.reminder.hoursBefore", { count: minutes / 60 });
  }
  return t("tasks.reminder.minutesBefore", { count: minutes });
}

export function formatShortReminderOffset(minutes: number, t: TFunction): string {
  if (minutes < 0) return t("tasks.reminder.none");
  if (minutes === 0) return t("tasks.reminder.atTime");
  if (minutes % 1440 === 0) {
    return t("tasks.reminder.shortDays", { count: minutes / 1440 });
  }
  if (minutes % 60 === 0) {
    return t("tasks.reminder.shortHours", { count: minutes / 60 });
  }
  return t("tasks.reminder.shortMinutes", { count: minutes });
}

export type QuickDeadlinePreset = {
  id: string;
  label: string;
  hint: string;
  dueAt: number;
  dueDate: string;
};

export function deadlineQuickPresets(
  now: Date,
  t: TFunction,
  language: string,
): QuickDeadlinePreset[] {
  const shortDate = (date: Date) =>
    new Intl.DateTimeFormat(language, {
      month: "numeric",
      day: "numeric",
    }).format(date);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const today18 = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    18,
    0,
    0,
    0,
  );
  const useToday18 = now.getTime() < today18.getTime();
  const todayPreset: QuickDeadlinePreset = useToday18
    ? {
        id: "today",
        label: t("tasks.deadline.presetTodayEvening"),
        hint: "18:00",
        dueAt: today18.getTime(),
        dueDate: "",
      }
    : {
        id: "today",
        label: t("tasks.deadline.today"),
        hint: shortDate(today),
        dueAt: localEndOfDayMs(today),
        dueDate: formatLocalDateISO(today),
      };

  const tomorrow = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  const tomorrowPreset: QuickDeadlinePreset = {
    id: "tomorrow",
    label: t("tasks.deadline.tomorrow"),
    hint: shortDate(tomorrow),
    dueAt: localEndOfDayMs(tomorrow),
    dueDate: formatLocalDateISO(tomorrow),
  };

  const dayOfWeek = now.getDay();
  const daysToFriday = dayOfWeek < 5 ? 5 - dayOfWeek : 5 + (7 - dayOfWeek);
  const friday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysToFriday,
  );
  const fridayPreset: QuickDeadlinePreset = {
    id: "friday",
    label: t(
      dayOfWeek < 5
        ? "tasks.deadline.presetThisFriday"
        : "tasks.deadline.presetNextFriday",
    ),
    hint: shortDate(friday),
    dueAt: localEndOfDayMs(friday),
    dueDate: formatLocalDateISO(friday),
  };

  // If today is Sunday, tomorrow is already Monday, so point "Next Monday" to the following Monday.
  const daysToMonday = dayOfWeek === 0 ? 8 : 8 - dayOfWeek;
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysToMonday,
  );
  const mondayPreset: QuickDeadlinePreset = {
    id: "monday",
    label: t("tasks.deadline.presetNextMonday"),
    hint: shortDate(monday),
    dueAt: localEndOfDayMs(monday),
    dueDate: formatLocalDateISO(monday),
  };

  return [todayPreset, tomorrowPreset, fridayPreset, mondayPreset];
}
