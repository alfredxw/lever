export type FormattedMessageTime = {
  displayed: string;
  full: string;
};

type FormatMessageTimeOptions = {
  now?: Date;
  formatYesterday?: (time: string) => string;
};

function isSameCalendarDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatMessageTime(
  timestamp: string | undefined,
  locale: string,
  options?: FormatMessageTimeOptions,
): FormattedMessageTime | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;

  const now = options?.now ?? new Date();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const full = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    hourCycle: "h23",
  }).format(date);

  if (isSameCalendarDay(date, now)) {
    return { displayed: time, full };
  }

  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );
  if (options?.formatYesterday && isSameCalendarDay(date, yesterday)) {
    return { displayed: options.formatYesterday(time), full };
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  const displayed = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);

  return { displayed, full };
}
