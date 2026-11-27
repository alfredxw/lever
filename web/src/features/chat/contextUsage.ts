import type { ContextUsage } from "@/api/types.gen";

export type ContextMeterLevel = "normal" | "warn" | "critical";

export interface ContextMeterSnapshot {
  used: number;
  window: number | null;
  percent: number | null;
  ratio: number | null;
  level: ContextMeterLevel;
  autoCompactThreshold: number | null;
  autoCompactTickPercent: number | null;
  promptCacheExpiresAt: number;
}

export function deriveContextMeterSnapshot(
  context?: ContextUsage,
): ContextMeterSnapshot | null {
  if (!context) return null;
  if (!Number.isFinite(context.used) || context.used < 0) return null;
  const used = Math.round(context.used);
  const window =
    Number.isFinite(context.window) && context.window > 0
      ? Math.round(context.window)
      : null;
  if (window === null && used === 0) return null;

  const ratio = window !== null ? Math.max(0, Math.min(1, used / window)) : null;
  const percent = ratio !== null ? Math.round(ratio * 100) : null;
  const level: ContextMeterLevel =
    percent === null
      ? "normal"
      : percent >= 90
        ? "critical"
        : percent >= 80
          ? "warn"
          : "normal";

  const rawThreshold = context.autoCompactThreshold;
  const autoCompactThreshold =
    typeof rawThreshold === "number" &&
    Number.isFinite(rawThreshold) &&
    rawThreshold > 0
      ? Math.round(rawThreshold)
      : null;
  const autoCompactTickPercent =
    window !== null &&
    autoCompactThreshold !== null &&
    autoCompactThreshold < window
      ? (autoCompactThreshold / window) * 100
      : null;

  const promptCacheExpiresAt =
    typeof context.promptCacheExpiresAt === "number" &&
    Number.isFinite(context.promptCacheExpiresAt) &&
    context.promptCacheExpiresAt > 0
      ? context.promptCacheExpiresAt
      : 0;

  return {
    used,
    window,
    percent,
    ratio,
    level,
    autoCompactThreshold,
    autoCompactTickPercent,
    promptCacheExpiresAt,
  };
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
