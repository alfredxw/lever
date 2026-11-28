import type { TFunction } from "i18next";
import type { UsageWindow } from "@/api/types.gen";

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export function fmtAxisUsd(n: number): string {
  if (n <= 0) return "$0";
  if (n >= 100) return `$${Math.round(n)}`;
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(1)}`;
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtAxisTokens(n: number): string {
  if (n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

export function fmtPct(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
  const pct = ratio * 100;
  if (pct < 0.1) return "<0.1%";
  if (pct >= 99.95) return "100%";
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

export function fmtMetricValue(value: number, metric: "tokens" | "cost"): string {
  return metric === "cost" ? fmtUsd(value) : fmtTokens(value);
}

const PROVIDER_PALETTE: Record<string, [string, string]> = {
  claude: ["var(--usage-clay)", "var(--usage-clay-soft)"],
  codex: ["var(--usage-blue)", "var(--usage-blue-soft)"],
  antigravity: ["var(--usage-violet)", "var(--usage-violet-soft)"],
  pi: ["var(--usage-teal)", "var(--usage-teal-soft)"],
};

const FALLBACK_COLORS = [
  "var(--usage-clay)",
  "var(--usage-blue)",
  "var(--usage-violet)",
  "var(--usage-teal)",
  "var(--usage-slate)",
];

export function providerAccent(providerId: string, index = 0): string {
  const key = providerId.toLowerCase();
  if (PROVIDER_PALETTE[key]) return PROVIDER_PALETTE[key][0];
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export function modelAccent(providerId: string, siblingRank: number): string {
  const key = providerId.toLowerCase();
  const pair = PROVIDER_PALETTE[key];
  if (pair) return siblingRank % 2 === 0 ? pair[0] : pair[1];
  return FALLBACK_COLORS[siblingRank % FALLBACK_COLORS.length];
}

export function windowLabel(window: UsageWindow, t: TFunction): string {
  if (window.id === "individual") return t("usage.monthlyCredits");
  const minutes = window.minutes;
  if (!minutes) {
    return t(
      window.group
        ? "usage.quota"
        : window.id === "primary"
          ? "usage.primary"
          : "usage.secondary",
    );
  }
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR}h`;
  return `${minutes}m`;
}

export function resetCountdown(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / MINUTE_MS);
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR) % HOURS_PER_DAY;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  const remainingMinutes = minutes % MINUTES_PER_HOUR;
  if (hours) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  return minutes ? `${minutes}m` : "<1m";
}

export interface WindowPace {
  usedPercent: number;
  remainingPercent: number;
  elapsedPercent: number | null;
  delta: number | null;
  status: "fast" | "ok" | "steady";
}

export function computeWindowPace(window: UsageWindow, now: number): WindowPace {
  const usedPercent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const totalMs = window.minutes ? window.minutes * MINUTE_MS : 0;
  let elapsedPercent: number | null = null;
  if (totalMs > 0 && Number.isFinite(resetMs) && resetMs > now) {
    const remainingMs = Math.min(totalMs, resetMs - now);
    elapsedPercent = Math.max(0, Math.min(100, Math.round(((totalMs - remainingMs) / totalMs) * 100)));
  }
  const delta = elapsedPercent !== null ? usedPercent - elapsedPercent : null;
  let status: "fast" | "ok" | "steady" = "steady";
  if (usedPercent >= 90 || (delta !== null && delta >= 6)) {
    status = "fast";
  } else if (delta !== null && delta <= -6) {
    status = "ok";
  }
  return { usedPercent, remainingPercent, elapsedPercent, delta, status };
}

export function formatSlotLabel(
  slot: string,
  resolution: "hour" | "day",
): string {
  if (resolution === "hour") {
    // "2026-11-27T15:00" -> "15:00"
    const idx = slot.indexOf("T");
    return idx >= 0 ? slot.slice(idx + 1, idx + 6) : slot;
  }
  // "2026-11-27" -> "11/27"
  const parts = slot.split("-");
  if (parts.length === 3) {
    return `${parts[1]}/${parts[2]}`;
  }
  return slot;
}

export function formatWindowRange(
  sinceIso: string,
  untilIso: string,
  resolution: "hour" | "day",
  locale: string,
): string {
  const since = Date.parse(sinceIso);
  const until = Date.parse(untilIso);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return "";
  if (resolution === "hour") {
    const fmt = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${fmt.format(since)} — ${fmt.format(until)}`;
  }
  const fmt = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  });
  return `${fmt.format(since)} — ${fmt.format(until)}`;
}

export function formatSessionUpdated(
  iso: string,
  t: TFunction,
  locale: string,
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const now = new Date();
  const timeFmt = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) {
    return t("usage.timeToday", { time: timeFmt.format(d) });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) {
    return t("usage.timeYesterday", { time: timeFmt.format(d) });
  }
  const dateFmt = new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return dateFmt.format(d);
}
