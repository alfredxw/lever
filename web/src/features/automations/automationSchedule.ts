import type { AutomationSchedule } from "@/api/types.gen";

export const frequencies = [
  "once",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "interval",
] as const;
export const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
const workweek = weekdayOrder.slice(0, 5);
export const intervalUnits = ["minutes", "hours"] as const;
type IntervalUnit = (typeof intervalUnits)[number];

export const minutesPerUnit = { minutes: 1, hours: 60 } as const;
export const maxIntervalMinutes = 365 * 24 * 60;

export type ScheduleDraft = {
  frequency: (typeof frequencies)[number];
  date: string;
  time: string;
  zone: string;
  days: number[];
  dayOfMonth: number;
  intervalAmount: string;
  intervalUnit: IntervalUnit;
};

export function isWorkweek(days: number[]) {
  return (
    days.length === workweek.length &&
    workweek.every((day) => days.includes(day))
  );
}

export function intervalParts(minutes: number): {
  count: number;
  unit: IntervalUnit;
} {
  return minutes % 60 === 0
    ? { count: minutes / 60, unit: "hours" }
    : { count: minutes, unit: "minutes" };
}

export function scheduleDraft(schedule?: AutomationSchedule): ScheduleDraft {
  const days = schedule?.weekdays ?? [];
  const { count, unit } = intervalParts(schedule?.intervalMinutes ?? 60);
  let frequency: ScheduleDraft["frequency"] = "daily";
  if (schedule?.intervalMinutes) frequency = "interval";
  else if (schedule?.date) frequency = "once";
  else if (schedule?.dayOfMonth) frequency = "monthly";
  else if (days.length) frequency = isWorkweek(days) ? "weekdays" : "weekly";

  return {
    frequency,
    date: schedule?.date ?? "",
    time: schedule?.time ?? "09:00",
    zone:
      schedule?.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
    days,
    dayOfMonth: schedule?.dayOfMonth ?? 1,
    intervalAmount: String(count),
    intervalUnit: unit,
  };
}

export function scheduleInput(
  draft: ScheduleDraft,
): AutomationSchedule | undefined {
  const {
    frequency,
    date,
    time,
    zone,
    days,
    dayOfMonth,
    intervalAmount,
    intervalUnit,
  } = draft;
  if (frequency === "interval") {
    const amount = Number(intervalAmount);
    const intervalMinutes = amount * minutesPerUnit[intervalUnit];
    if (
      Number.isInteger(amount) &&
      intervalMinutes >= 1 &&
      intervalMinutes <= maxIntervalMinutes
    ) {
      return { intervalMinutes };
    }
    return;
  }
  if (
    !time ||
    !zone.trim() ||
    (frequency === "once" && !date) ||
    (frequency === "weekly" && !days.length)
  ) {
    return;
  }
  return {
    time,
    timezone: zone.trim(),
    date: frequency === "once" ? date : undefined,
    weekdays:
      frequency === "weekdays"
        ? workweek
        : frequency === "weekly"
          ? days
          : undefined,
    dayOfMonth: frequency === "monthly" ? dayOfMonth : undefined,
  };
}
