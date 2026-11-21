import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "@/api/client";
import type { ProviderInfo, UsageWindow } from "@/api/types.gen";

const minuteMs = 60_000;
const minutesPerHour = 60;
const hoursPerDay = 24;
const minutesPerDay = hoursPerDay * minutesPerHour;
const summaryColors = [
  "var(--subscription-usage-blue)",
  "var(--subscription-usage-clay)",
  "var(--subscription-usage-violet)",
];

type Subscription = {
  provider: ProviderInfo;
  windows: UsageWindow[];
  notice?: string;
};

function usageSources(providers: ProviderInfo[]) {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    const localAgy = provider.type === "antigravity" && provider.auth === "cli";
    if (
      !provider.available ||
      !provider.installed ||
      !(
        provider.reportsUsage ||
        (localAgy && provider.reportsUsage === undefined)
      )
    )
      return false;
    // Multiple runtime entries can launch exactly the same native profile.
    const profile = JSON.stringify([
      provider.type,
      provider.path,
      provider.configPath ||
        (provider.type === "antigravity" && provider.auth === "cli"
          ? "local"
          : provider.id),
    ]);
    if (seen.has(profile)) return false;
    seen.add(profile);
    return true;
  });
}

function UsageIndicator({ subscriptions }: { subscriptions: Subscription[] }) {
  if (!subscriptions.length) return <Gauge aria-hidden="true" />;
  const used = (subscription: Subscription) =>
    Math.max(...subscription.windows.map((window) => window.usedPercent));
  const remaining =
    subscriptions.length === 1 ? 100 - used(subscriptions[0]) : undefined;

  return (
    <svg
      width={23}
      height={23}
      viewBox="0 0 24 24"
      className="-mx-0.5"
      aria-hidden="true"
    >
      {remaining !== undefined ? (
        <g fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="10.5" strokeOpacity="0.2" />
          {remaining > 0 && (
            <circle
              cx="12"
              cy="12"
              r="10.5"
              pathLength="100"
              strokeDasharray={`${remaining} 100`}
              strokeLinecap="round"
              transform="rotate(-90 12 12)"
            />
          )}
        </g>
      ) : (
        subscriptions.map((subscription, index) => {
          const y = 10.5 + (index - (subscriptions.length - 1) / 2) * 8;
          return (
            <g key={subscription.provider.id} fill={summaryColors[index]}>
              <rect y={y} width={24} height={3} rx={1.5} fillOpacity={0.13} />
              <rect
                y={y}
                width={(24 * used(subscription)) / 100}
                height={3}
                rx={1.5}
              />
            </g>
          );
        })
      )}
    </svg>
  );
}

function windowLabel(window: UsageWindow, t: TFunction) {
  if (window.id === "individual") return t("usage.monthlyCredits");
  const minutes = window.minutes;
  if (!minutes)
    return t(
      window.group
        ? "usage.quota"
        : window.id === "primary"
          ? "usage.primary"
          : "usage.secondary",
    );
  if (minutes % minutesPerDay === 0) return `${minutes / minutesPerDay}d`;
  if (minutes % minutesPerHour === 0) return `${minutes / minutesPerHour}h`;
  return `${minutes}m`;
}

function resetCountdown(remainingMs: number) {
  const minutes = Math.floor(remainingMs / minuteMs);
  const days = Math.floor(minutes / minutesPerDay);
  const hours = Math.floor(minutes / minutesPerHour) % hoursPerDay;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  const remainingMinutes = minutes % minutesPerHour;
  if (hours)
    return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  return minutes ? `${minutes}m` : "<1m";
}

export function SubscriptionUsage({
  providers,
}: {
  providers: ProviderInfo[];
}) {
  const sources = usageSources(providers);
  const samples = useQueries({
    queries: sources.map(({ id, reportsUsage }) => ({
      queryKey: ["providers", "usage", id],
      enabled: !!reportsUsage,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<UsageWindow[] | null>(
          `/providers/${encodeURIComponent(id)}/usage`,
          undefined,
          "GET",
          signal,
        ),
      staleTime: minuteMs,
      refetchInterval: minuteMs,
      refetchOnWindowFocus: true,
      retry: false,
    })),
  });
  const subscriptions = sources.flatMap<Subscription>((provider, i) => {
    const sample = samples[i];
    const windows = sample.data ?? [];
    if (windows.length)
      return [
        {
          provider,
          windows,
          notice: sample.isError ? "usage.lastReading" : undefined,
        },
      ];
    if (provider.type !== "antigravity") return [];
    const notice = !provider.reportsUsage
      ? "usage.backendUpdate"
      : sample.isPending
        ? "usage.loading"
        : sample.isError
          ? "usage.readFailed"
          : "usage.noAllowance";
    return [{ provider, windows, notice }];
  });
  return subscriptions.length ? (
    <UsageDetails subscriptions={subscriptions} />
  ) : null;
}

function UsageDetails({ subscriptions }: { subscriptions: Subscription[] }) {
  const { t, i18n } = useTranslation();
  const measured = subscriptions.filter(({ windows }) => windows.length);
  const summary = measured.slice(0, summaryColors.length);
  const overflow = measured.length - summary.length;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), minuteMs);
    return () => clearInterval(timer);
  }, [open]);

  function changeOpen(next: boolean) {
    if (next) setNow(Date.now());
    setOpen(next);
  }

  const resetFormat = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const percentFormat = new Intl.NumberFormat(i18n.language, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  return (
    <Tooltip.Provider delayDuration={180}>
      <Tooltip.Root open={open} onOpenChange={changeOpen}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="navigation-item data-[state=delayed-open]:bg-control-hover data-[state=instant-open]:bg-control-hover"
            aria-label={t("usage.title")}
            onClick={(event) => {
              // Also reveal the details for touch and keyboard activation.
              event.preventDefault();
              changeOpen(true);
            }}
          >
            <UsageIndicator subscriptions={summary} />
            <span>{t("usage.navigation")}</span>
            {overflow > 0 && (
              <span
                aria-hidden="true"
                className="subscription-usage-overflow ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground"
              >
                +{overflow}
              </span>
            )}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            align="end"
            sideOffset={8}
            collisionPadding={8}
            className="floating-surface z-50 max-h-(--radix-tooltip-content-available-height) w-64 max-w-(--radix-tooltip-content-available-width) overflow-y-auto p-3 text-popover-foreground"
          >
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">
              {t("usage.title")}
            </div>
            <div className="divide-y divide-border/70">
              {subscriptions.map((subscription) => {
                const { provider, windows, notice } = subscription;
                const color =
                  summary.length > 1
                    ? summaryColors[summary.indexOf(subscription)]
                    : undefined;
                return (
                  <section
                    key={provider.id}
                    className="py-2 first:pt-0 last:pb-0"
                  >
                    <div className="mb-1.5 wrap-anywhere text-[13px] font-medium">
                      {provider.name}
                    </div>
                    {notice && (
                      <p className="text-xs text-muted-foreground">
                        {t(notice)}
                      </p>
                    )}
                    <ul className="space-y-2 text-xs">
                      {windows.map((window, windowIndex) => {
                        const reset = Date.parse(window.resetsAt ?? "");
                        const remainingPercent = 100 - window.usedPercent;
                        return (
                          <li key={window.id}>
                            {window.group &&
                              window.group !==
                                windows[windowIndex - 1]?.group && (
                                <div className="mb-1.5 pt-1 font-medium wrap-anywhere text-muted-foreground">
                                  {window.group}
                                </div>
                              )}
                            <div className="flex items-baseline justify-between gap-x-2 tabular-nums">
                              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted-foreground">
                                <span className="wrap-anywhere">
                                  {windowLabel(window, t)}
                                </span>
                                {reset > now && (
                                  <time
                                    dateTime={window.resetsAt}
                                    title={resetFormat.format(reset)}
                                    className="text-[11px]"
                                  >
                                    {t("usage.reset", {
                                      when: resetCountdown(reset - now),
                                    })}
                                  </time>
                                )}
                              </div>
                              <span className="shrink-0 font-medium">
                                {t("usage.remaining", {
                                  percent: percentFormat.format(
                                    remainingPercent / 100,
                                  ),
                                })}
                              </span>
                            </div>
                            <div
                              aria-hidden="true"
                              className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                              style={
                                color
                                  ? {
                                      backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
                                    }
                                  : undefined
                              }
                            >
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{
                                  width: `${window.usedPercent}%`,
                                  backgroundColor: color,
                                }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
