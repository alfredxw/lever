import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ContextUsage } from "@/api/types.gen";
import { InputGroupButton } from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { deriveContextMeterSnapshot, formatTokenCount } from "./contextUsage";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function formatCacheRemaining(ms: number, t: TFunction): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return remMinutes > 0
      ? t("context.cacheDurationHoursMinutes", { hours, minutes: remMinutes })
      : t("context.cacheDurationHours", { hours });
  }
  if (minutes > 0) {
    return t("context.cacheDurationMinutesSeconds", {
      minutes,
      seconds: String(seconds).padStart(2, "0"),
    });
  }
  return t("context.cacheDurationSeconds", { seconds });
}

export function ContextMeter({ context }: { context?: ContextUsage }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const snapshot = deriveContextMeterSnapshot(context);
  const expiresAt = snapshot?.promptCacheExpiresAt ?? 0;

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    if (expiresAt <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, expiresAt]);

  if (!snapshot) return null;

  const locale = i18n.resolvedLanguage || i18n.language;
  const cacheRemainingMs = expiresAt > now ? expiresAt - now : 0;
  const triggerLabel =
    snapshot.window !== null && snapshot.percent !== null
      ? t("context.triggerUsed", {
          percent: snapshot.percent,
          used: formatTokenCount(snapshot.used),
          window: formatTokenCount(snapshot.window),
        })
      : t("context.triggerTokens", {
          used: formatTokenCount(snapshot.used),
        });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InputGroupButton
          type="button"
          variant="ghost"
          size={snapshot.window !== null ? "icon-sm" : "xs"}
          className={cn(
            snapshot.window === null && "px-1.5 text-xs font-medium tabular-nums",
            open && "bg-control-selected text-foreground",
            snapshot.level === "critical"
              ? "text-destructive"
              : snapshot.level === "warn"
                ? "text-(--status-attention)"
                : !open && "text-muted-foreground hover:text-foreground",
          )}
          aria-label={triggerLabel}
          title={triggerLabel}
        >
          {snapshot.window !== null && snapshot.ratio !== null ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              className="shrink-0"
            >
              <circle
                cx="8"
                cy="8"
                r={RING_RADIUS}
                stroke="currentColor"
                strokeWidth="2"
                opacity="0.22"
              />
              <circle
                cx="8"
                cy="8"
                r={RING_RADIUS}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - snapshot.ratio)}
                transform="rotate(-90 8 8)"
              />
            </svg>
          ) : (
            formatTokenCount(snapshot.used)
          )}
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="top"
        sideOffset={8}
        className="w-60 max-w-[calc(100vw-24px)] p-3"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium text-foreground">
              {t("context.title")}
            </span>
            {snapshot.percent !== null && (
              <span
                className={cn(
                  "text-xs font-medium tabular-nums",
                  snapshot.level === "critical"
                    ? "text-destructive"
                    : snapshot.level === "warn"
                      ? "text-(--status-attention)"
                      : "text-foreground",
                )}
              >
                {snapshot.percent}%
              </span>
            )}
          </div>
          {snapshot.window !== null && snapshot.percent !== null && (
            <div
              className="relative h-1 w-full rounded-full bg-muted"
              role="progressbar"
              aria-label={t("context.title")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={snapshot.percent}
            >
              {snapshot.used > 0 && (
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    snapshot.level === "critical"
                      ? "bg-destructive"
                      : snapshot.level === "warn"
                        ? "bg-(--status-attention)"
                        : "bg-foreground/80",
                  )}
                  style={{
                    width: `min(100%, max(${snapshot.percent}%, 4px))`,
                  }}
                />
              )}
              {snapshot.autoCompactTickPercent !== null && (
                <span
                  aria-hidden="true"
                  className="absolute -top-[2px] h-2 w-px -translate-x-1/2 bg-foreground/75"
                  style={{
                    left: `clamp(1px, ${snapshot.autoCompactTickPercent}%, calc(100% - 1px))`,
                  }}
                />
              )}
            </div>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {snapshot.window !== null
              ? t("context.tokenCounts", {
                  used: snapshot.used.toLocaleString(locale),
                  window: snapshot.window.toLocaleString(locale),
                })
              : t("context.tokensUsed", {
                  used: snapshot.used.toLocaleString(locale),
                })}
          </span>
          {snapshot.autoCompactThreshold !== null && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("context.autoCompactAt", {
                tokens: snapshot.autoCompactThreshold.toLocaleString(locale),
              })}
            </span>
          )}
          {cacheRemainingMs > 0 && (
            <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
              <span className="text-muted-foreground">
                {t("context.promptCache")}
              </span>
              <span
                className={cn(
                  cacheRemainingMs < 60_000
                    ? "font-medium text-(--status-attention)"
                    : "text-foreground",
                )}
              >
                {formatCacheRemaining(cacheRemainingMs, t)}
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
