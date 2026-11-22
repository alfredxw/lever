import { useMemo, useState, type ReactNode } from "react";
import { Bell, BellOff, Clock, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TaskDeadlineInput } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  allDayReminderPresets,
  deadlineQuickPresets,
  exactReminderPresets,
  formatLocalDateISO,
  formatReminderOffset,
  formatShortReminderOffset,
  formatTimeHM,
  localEndOfDayMs,
  normalizeOffsets,
  parseLocalDateISO,
} from "./taskDeadlines";

export type DeadlineDraftValue = {
  dueAt: number;
  dueDate?: string;
  remindOffsets?: number[];
};

const quickTimes = ["12:00", "18:00", "21:00"] as const;
type CustomUnit = "minutes" | "hours" | "days";

function parseHM(raw: string): { hour: number; minute: number } | undefined {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!match) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function defaultExactTimeForDate(date: Date, now: Date): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (!sameDay || now.getHours() < 18) return "18:00";
  const nextHour = Math.min(23, now.getHours() + 1);
  return `${String(nextHour).padStart(2, "0")}:00`;
}

export function TaskDeadlinePicker({
  value,
  defaultRemindOffsets = [30],
  allDayReminderTime = "09:00",
  allowClear = true,
  clearLabel,
  align = "start",
  side = "bottom",
  disabled = false,
  onChange,
  children,
}: {
  value?: DeadlineDraftValue;
  defaultRemindOffsets?: number[];
  allDayReminderTime?: string;
  allowClear?: boolean;
  clearLabel?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
  onChange: (next: TaskDeadlineInput | null) => void;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  const [selectedDate, setSelectedDate] = useState<Date | undefined>();
  const [month, setMonth] = useState<Date>(() => new Date());
  const [isAllDay, setIsAllDay] = useState(true);
  const [timeText, setTimeText] = useState("18:00");
  const [timeError, setTimeError] = useState(false);
  const [offsets, setOffsets] = useState<number[]>(defaultRemindOffsets);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("45");
  const [customUnit, setCustomUnit] = useState<CustomUnit>("minutes");

  function handleOpenChange(next: boolean) {
    if (disabled) return;
    if (next) {
      const now = new Date();
      if (value && value.dueAt > 0) {
        const allDay = !!value.dueDate;
        const date = allDay
          ? (parseLocalDateISO(value.dueDate!) ?? new Date(value.dueAt))
          : new Date(value.dueAt);
        setSelectedDate(
          new Date(date.getFullYear(), date.getMonth(), date.getDate()),
        );
        setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
        setIsAllDay(allDay);
        setTimeText(
          allDay ? defaultExactTimeForDate(date, now) : formatTimeHM(date),
        );
        setOffsets(
          value.remindOffsets !== undefined
            ? normalizeOffsets(value.remindOffsets)
            : normalizeOffsets(defaultRemindOffsets),
        );
      } else {
        setSelectedDate(undefined);
        setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
        setIsAllDay(true);
        setTimeText("18:00");
        setOffsets(normalizeOffsets(defaultRemindOffsets));
      }
      setTimeError(false);
      setCustomOpen(false);
    }
    setOpen(next);
  }

  const presets = useMemo(
    () => (open ? deadlineQuickPresets(new Date(), t, i18n.language) : []),
    [open, t, i18n.language],
  );

  const reminderChoices = isAllDay
    ? allDayReminderPresets
    : exactReminderPresets;

  const displayOffsets = useMemo(
    () =>
      isAllDay
        ? normalizeOffsets(
            offsets.map((m) => (m < 1440 ? 0 : Math.floor(m / 1440) * 1440)),
          )
        : offsets,
    [isAllDay, offsets],
  );

  function applyPreset(preset: (typeof presets)[number]) {
    const allDay = !!preset.dueDate;
    const date = allDay
      ? (parseLocalDateISO(preset.dueDate) ?? new Date(preset.dueAt))
      : new Date(preset.dueAt);
    setSelectedDate(
      new Date(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setIsAllDay(allDay);
    if (allDay) {
      setOffsets((prev) =>
        normalizeOffsets(
          prev.map((m) => (m < 1440 ? 0 : Math.floor(m / 1440) * 1440)),
        ),
      );
    } else {
      setTimeText(formatTimeHM(date));
    }
    setTimeError(false);
  }

  function handleDaySelect(day: Date | undefined) {
    if (!day) return;
    setSelectedDate(day);
    setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
  }

  function toggleReminderOffset(minutes: number) {
    setOffsets((prev) => {
      const normalizedPrev = isAllDay
        ? normalizeOffsets(
            prev.map((m) => (m < 1440 ? 0 : Math.floor(m / 1440) * 1440)),
          )
        : prev;
      if (normalizedPrev.includes(minutes)) {
        return normalizedPrev.filter((item) => item !== minutes);
      }
      if (normalizedPrev.length >= 5) return normalizedPrev;
      return normalizeOffsets([...normalizedPrev, minutes]);
    });
  }

  function addCustomOffset() {
    const num = Number.parseInt(customValue.trim(), 10);
    if (!Number.isFinite(num) || num < 0) return;
    const unit = isAllDay ? "days" : customUnit;
    const multiplier = unit === "days" ? 1440 : unit === "hours" ? 60 : 1;
    const total = num * multiplier;
    if (total > 30 * 1440) return;
    setOffsets((prev) => normalizeOffsets([...prev, total]));
    setCustomOpen(false);
  }

  function commit() {
    if (!selectedDate) return;
    const cleanOffsets = normalizeOffsets(displayOffsets);
    if (isAllDay) {
      onChange({
        dueAt: localEndOfDayMs(selectedDate),
        dueDate: formatLocalDateISO(selectedDate),
        remindOffsets: cleanOffsets,
      });
      setOpen(false);
      return;
    }
    const parsed = parseHM(timeText);
    if (!parsed) {
      setTimeError(true);
      return;
    }
    const due = new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate(),
      parsed.hour,
      parsed.minute,
      0,
      0,
    );
    onChange({
      dueAt: due.getTime(),
      dueDate: "",
      remindOffsets: cleanOffsets,
    });
    setOpen(false);
  }

  const activePresetId = useMemo(() => {
    if (!selectedDate) return undefined;
    const iso = formatLocalDateISO(selectedDate);
    return presets.find((p) => {
      if (p.dueDate) return isAllDay && p.dueDate === iso;
      if (isAllDay) return false;
      const d = new Date(p.dueAt);
      return (
        formatLocalDateISO(d) === iso && formatTimeHM(d) === timeText.trim()
      );
    })?.id;
  }, [selectedDate, isAllDay, timeText, presets]);

  const customDisplayOffsets = displayOffsets.filter(
    (m) => !(reminderChoices as readonly number[]).includes(m),
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={6}
        className="task-deadline-popover w-[288px] p-0"
        aria-label={t("tasks.deadline.label")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && selectedDate && !customOpen) {
            const target = event.target as HTMLElement | null;
            if (target?.tagName === "INPUT") {
              event.preventDefault();
              commit();
            }
          }
        }}
      >
        <div className="task-deadline-presets">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="task-deadline-preset"
              data-selected={activePresetId === preset.id || undefined}
              onClick={() => applyPreset(preset)}
              onDoubleClick={() => {
                applyPreset(preset);
                onChange({
                  dueAt: preset.dueAt,
                  dueDate: preset.dueDate,
                  remindOffsets: normalizeOffsets(offsets),
                });
                setOpen(false);
              }}
            >
              <span className="truncate">{preset.label}</span>
              <span className="task-deadline-preset-hint tabular-nums">
                {preset.hint}
              </span>
            </button>
          ))}
        </div>

        <div className="task-deadline-calendar-wrap">
          <Calendar
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={selectedDate}
            onSelect={handleDaySelect}
            weekStartsOn={1}
            formatters={{
              formatCaption: (date) =>
                new Intl.DateTimeFormat(i18n.language, {
                  year: "numeric",
                  month: "long",
                }).format(date),
              formatWeekdayName: (date) =>
                new Intl.DateTimeFormat(i18n.language, {
                  weekday: "narrow",
                }).format(date),
            }}
          />
        </div>

        {selectedDate && (
          <div className="task-deadline-options">
            <div className="task-deadline-row">
              <span className="task-deadline-row-label">
                <Clock className="size-3.5" aria-hidden="true" />
                {t("tasks.deadline.timeLabel")}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                className="task-deadline-mode-toggle"
                aria-label={t("tasks.deadline.timeLabel")}
                value={isAllDay ? "allDay" : "exact"}
                onValueChange={(val) => {
                  if (val === "allDay") {
                    setIsAllDay(true);
                    setTimeError(false);
                  } else if (val === "exact") {
                    setIsAllDay(false);
                    setTimeText((cur) =>
                      parseHM(cur)
                        ? cur
                        : defaultExactTimeForDate(selectedDate, new Date()),
                    );
                  }
                }}
              >
                <ToggleGroupItem value="allDay">
                  {t("tasks.deadline.allDay")}
                </ToggleGroupItem>
                <ToggleGroupItem value="exact">
                  {t("tasks.deadline.exactTime")}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            {!isAllDay && (
              <div className="task-deadline-time-editor">
                <Input
                  type="text"
                  inputMode="numeric"
                  className="h-7 w-[76px] px-2 text-xs tabular-nums"
                  aria-label={t("tasks.deadline.exactTime")}
                  aria-invalid={timeError || undefined}
                  placeholder="18:00"
                  value={timeText}
                  onChange={(event) => {
                    setTimeText(event.target.value);
                    setTimeError(false);
                  }}
                />
                <div className="flex flex-1 items-center justify-end gap-1">
                  {quickTimes.map((hm) => (
                    <button
                      key={hm}
                      type="button"
                      className="task-deadline-chip-btn tabular-nums"
                      data-selected={timeText.trim() === hm || undefined}
                      onClick={() => {
                        setTimeText(hm);
                        setTimeError(false);
                      }}
                    >
                      {hm}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="task-deadline-reminder-section">
              <div className="task-deadline-row">
                <span className="task-deadline-row-label">
                  {offsets.length > 0 ? (
                    <Bell className="size-3.5" aria-hidden="true" />
                  ) : (
                    <BellOff className="size-3.5" aria-hidden="true" />
                  )}
                  {t("tasks.reminder.label")}
                </span>
                {offsets.length < 5 && (
                  <button
                    type="button"
                    className="task-deadline-custom-toggle"
                    onClick={() => {
                      setCustomOpen((prev) => !prev);
                      if (isAllDay) setCustomUnit("days");
                    }}
                  >
                    <Plus className="size-3" aria-hidden="true" />
                    {t("tasks.reminder.custom")}
                  </button>
                )}
              </div>

              <div className="task-deadline-reminder-chips">
                <button
                  type="button"
                  className="task-deadline-chip-btn"
                  data-selected={displayOffsets.length === 0 || undefined}
                  onClick={() => setOffsets([])}
                >
                  {t("tasks.reminder.none")}
                </button>
                {reminderChoices.map((minutes) => {
                  const active = displayOffsets.includes(minutes);
                  const label = isAllDay
                    ? formatReminderOffset(
                        minutes,
                        true,
                        allDayReminderTime,
                        t,
                      )
                    : formatShortReminderOffset(minutes, t);
                  return (
                    <button
                      key={minutes}
                      type="button"
                      className="task-deadline-chip-btn tabular-nums"
                      data-selected={active || undefined}
                      onClick={() => toggleReminderOffset(minutes)}
                    >
                      {label}
                    </button>
                  );
                })}
                {customDisplayOffsets.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="task-deadline-chip-btn tabular-nums"
                    data-selected="true"
                    title={t("tasks.reminder.remove")}
                    onClick={() => toggleReminderOffset(minutes)}
                  >
                    <span>
                      {formatReminderOffset(
                        minutes,
                        isAllDay,
                        allDayReminderTime,
                        t,
                      )}
                    </span>
                    <X className="size-2.5 shrink-0" aria-hidden="true" />
                  </button>
                ))}
              </div>

              {customOpen && (
                <div className="task-deadline-custom-row">
                  <Input
                    type="number"
                    min={isAllDay ? 1 : 0}
                    max={isAllDay ? 30 : 43200}
                    className="h-7 w-16 px-2 text-xs tabular-nums"
                    aria-label={t("tasks.reminder.customAmount")}
                    value={customValue}
                    onChange={(event) => setCustomValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomOffset();
                      }
                    }}
                  />
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    spacing={0}
                    className="task-deadline-unit-toggle"
                    aria-label={t("tasks.reminder.customUnit")}
                    value={isAllDay ? "days" : customUnit}
                    onValueChange={(unit) => {
                      if (
                        unit === "minutes" ||
                        unit === "hours" ||
                        unit === "days"
                      ) {
                        setCustomUnit(unit);
                      }
                    }}
                  >
                    {!isAllDay && (
                      <ToggleGroupItem value="minutes">
                        {t("tasks.reminder.unitMinute")}
                      </ToggleGroupItem>
                    )}
                    {!isAllDay && (
                      <ToggleGroupItem value="hours">
                        {t("tasks.reminder.unitHour")}
                      </ToggleGroupItem>
                    )}
                    <ToggleGroupItem value="days">
                      {t("tasks.reminder.unitDay")}
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={addCustomOffset}
                  >
                    {t("tasks.quickCreateAdd")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="task-deadline-footer">
          {allowClear && value && value.dueAt > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {clearLabel ?? t("tasks.deadline.clear")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={!selectedDate}
              onClick={commit}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
