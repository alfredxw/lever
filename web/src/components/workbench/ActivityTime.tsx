import { useTranslation } from "react-i18next";

export function ActivityTime({
  timestamp,
  compact = false,
}: {
  timestamp?: string;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const locale = i18n.language;
  const full = date.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const displayed = !compact
    ? full
    : date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year:
            date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
  const label = compact ? t("tasks.lastExecutionAt", { time: full }) : full;
  return (
    <time
      className="flex-none whitespace-nowrap text-[11px] font-[450] text-muted-foreground tabular-nums"
      dateTime={timestamp}
      title={label}
      aria-label={label}
    >
      {displayed}
    </time>
  );
}
