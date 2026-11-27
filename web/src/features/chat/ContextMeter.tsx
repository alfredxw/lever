import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  Catalog,
  ContextUsage,
  NativeCommand,
  SessionRuntime,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroupButton } from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function resolveCompactCommand(
  sessionRuntime?: SessionRuntime,
  catalog?: Catalog | null,
): NativeCommand | undefined {
  const commands =
    sessionRuntime?.commands !== undefined
      ? sessionRuntime.commands
      : (catalog?.commands ?? []);
  return commands.find((command) => command.name === "compact");
}

export function contextPercent(context?: ContextUsage): number | undefined {
  if (!context || context.window <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round((context.used / context.window) * 100)));
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.max(0, Math.round(value)));
}

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

export function ContextMeter({
  sessionRuntime,
  catalog,
  hasHistory,
  lastCompacted,
  disabled,
  onCompact,
  onHandoff,
  onReturnToComposer,
}: {
  sessionRuntime?: SessionRuntime;
  catalog?: Catalog | null;
  hasHistory: boolean;
  lastCompacted?: boolean;
  disabled?: boolean;
  onCompact: (focus?: string) => Promise<void>;
  onHandoff: (prompt: string) => Promise<void>;
  onReturnToComposer?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [handoffPrompt, setHandoffPrompt] = useState("");
  const [pendingAction, setPendingAction] = useState<"compact" | "handoff">();
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());

  const context =
    sessionRuntime?.context && sessionRuntime.context.window > 0
      ? sessionRuntime.context
      : undefined;
  const percent = contextPercent(context);
  const ratio = context ? Math.max(0, Math.min(1, context.used / context.window)) : 0;
  const compactCommand = resolveCompactCommand(sessionRuntime, catalog);
  const expiresAt = context?.promptCacheExpiresAt ?? 0;

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    if (expiresAt <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, expiresAt]);

  const cacheRemainingMs = expiresAt > now ? expiresAt - now : 0;
  const busy = Boolean(disabled || pendingAction);
  const level =
    percent === undefined
      ? "idle"
      : percent >= 90
        ? "critical"
        : percent >= 75
          ? "warn"
          : "normal";
  const preferHandoff = !compactCommand || (percent !== undefined && percent >= 75);

  async function runCompact(event?: FormEvent) {
    event?.preventDefault();
    if (!compactCommand || busy) return;
    setError(null);
    setPendingAction("compact");
    try {
      const instruction = compactCommand.argumentHint ? focus.trim() : "";
      await onCompact(instruction || undefined);
      setFocus("");
      setOpen(false);
      onReturnToComposer?.();
    } catch (reason) {
      setError(reason);
    } finally {
      setPendingAction(undefined);
    }
  }

  async function runHandoff(event: FormEvent) {
    event.preventDefault();
    const trimmed = handoffPrompt.trim();
    if (!hasHistory || !trimmed || busy) return;
    setError(null);
    setPendingAction("handoff");
    try {
      await onHandoff(trimmed);
      setHandoffPrompt("");
      setOpen(false);
    } catch (reason) {
      setError(reason);
    } finally {
      setPendingAction(undefined);
    }
  }

  const triggerLabel =
    percent !== undefined
      ? t("context.triggerUsed", {
          percent,
          used: formatTokenCount(context!.used),
          window: formatTokenCount(context!.window),
        })
      : t("context.title");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <PopoverTrigger asChild>
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            open && "bg-control-selected text-foreground",
            level === "critical"
              ? "text-destructive"
              : level === "warn"
                ? "text-(--status-attention)"
                : !open && "text-muted-foreground hover:text-foreground",
          )}
          aria-label={triggerLabel}
          title={triggerLabel}
          disabled={disabled}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            {context ? (
              <>
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
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - ratio)}
                  transform="rotate(-90 8 8)"
                />
              </>
            ) : (
              <circle
                cx="8"
                cy="8"
                r={RING_RADIUS}
                stroke="currentColor"
                strokeWidth="1.75"
                strokeDasharray="2.5 2.5"
                opacity="0.6"
              />
            )}
          </svg>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="floating-surface w-80 max-w-[calc(100vw-24px)] p-3"
      >
        <div className="flex flex-col gap-2">
          {context && percent !== undefined ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-foreground">
                  {t("context.title")}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatTokenCount(context.used)} /{" "}
                  {formatTokenCount(context.window)} · {percent}%
                </span>
              </div>
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t("context.title")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    level === "critical"
                      ? "bg-destructive"
                      : level === "warn"
                        ? "bg-(--status-attention)"
                        : "bg-foreground",
                  )}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {lastCompacted
                ? t("context.compactedPending")
                : t("context.unavailable")}
            </p>
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
        {(compactCommand || hasHistory) && (
          <>
            <Separator className="my-2.5" />
            <div className="flex flex-col gap-2">
              {compactCommand &&
                (compactCommand.argumentHint ? (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(event) => void runCompact(event)}
                  >
                    <Input
                      className="h-8 text-xs"
                      aria-label={t("context.compactFocusLabel")}
                      placeholder={t("context.compactFocusPlaceholder")}
                      value={focus}
                      disabled={busy}
                      onChange={(event) => setFocus(event.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      className="min-w-20 shrink-0"
                      disabled={busy}
                    >
                      {pendingAction === "compact" ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        t("context.compactAction")
                      )}
                    </Button>
                  </form>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={busy}
                    onClick={() => void runCompact()}
                  >
                    {pendingAction === "compact" && (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    )}
                    {t("context.compact")}
                  </Button>
                ))}
              {hasHistory && (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => void runHandoff(event)}
                >
                  <Input
                    className="h-8 text-xs"
                    aria-label={t("context.handoffLabel")}
                    placeholder={t("context.handoffPlaceholder")}
                    value={handoffPrompt}
                    disabled={busy}
                    onChange={(event) => setHandoffPrompt(event.target.value)}
                  />
                  <Button
                    type="submit"
                    variant={preferHandoff ? "default" : "outline"}
                    size="sm"
                    className="min-w-20 shrink-0"
                    disabled={busy || !handoffPrompt.trim()}
                  >
                    {pendingAction === "handoff" ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      t("context.handoffAction")
                    )}
                  </Button>
                </form>
              )}
            </div>
          </>
        )}
        {!!error && (
          <div className="mt-2">
            <ErrorNotice error={error} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
