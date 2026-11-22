import { AlertTriangle, Bell, CalendarClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TaskDeadlineInput } from "@/api/types.gen";
import {
  formatDeadlineFull,
  formatDeadlineLabel,
  type EffectiveTaskDeadline,
} from "./taskDeadlines";
import { TaskDeadlinePicker } from "./TaskDeadlinePicker";

export function TaskDeadlineBadge({
  deadline,
  nowMs,
  defaultRemindOffsets,
  allDayReminderTime,
  editable = false,
  compact = false,
  onChange,
}: {
  deadline: EffectiveTaskDeadline;
  nowMs: number;
  defaultRemindOffsets?: number[];
  allDayReminderTime?: string;
  editable?: boolean;
  compact?: boolean;
  onChange?: (next: TaskDeadlineInput | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const label = formatDeadlineLabel(deadline, nowMs, t, i18n.language);
  const fullTitle = formatDeadlineFull(deadline, t, i18n.language);
  const hasReminders =
    deadline.urgency !== "done" && deadline.remindOffsets.length > 0;
  const Icon = deadline.urgency === "overdue" ? AlertTriangle : CalendarClock;

  const content = (
    <>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {hasReminders && !compact && (
        <Bell
          className="size-2.5 shrink-0 opacity-75"
          aria-hidden="true"
        />
      )}
    </>
  );

  if (editable && onChange) {
    return (
      <TaskDeadlinePicker
        value={{
          dueAt: deadline.dueAt,
          dueDate: deadline.dueDate,
          remindOffsets: deadline.remindOffsets,
        }}
        defaultRemindOffsets={defaultRemindOffsets}
        allDayReminderTime={allDayReminderTime}
        clearLabel={
          deadline.isExternalDefault
            ? undefined
            : deadline.hasLocalOverride
              ? t("tasks.deadline.clear")
              : undefined
        }
        allowClear={deadline.hasLocalOverride}
        onChange={onChange}
      >
        <button
          type="button"
          className="task-deadline-badge task-deadline-badge-btn tabular-nums"
          data-urgency={deadline.urgency}
          title={fullTitle}
          aria-label={`${t("tasks.deadline.label")}: ${fullTitle}`}
          onClick={(event) => event.stopPropagation()}
        >
          {content}
        </button>
      </TaskDeadlinePicker>
    );
  }

  return (
    <span
      className="task-deadline-badge tabular-nums"
      data-urgency={deadline.urgency}
      title={fullTitle}
    >
      {content}
    </span>
  );
}
