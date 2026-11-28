import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProviderInfo } from "@/api/types.gen";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  browserTimeZone,
  computeWindowPace,
  fmtPct,
  fmtTokens,
  fmtUsd,
  providerAccent,
  resetCountdown,
  windowLabel,
} from "@/features/usage/format";
import {
  prefetchLocalStats,
  prefetchLocalStatsSummary,
  useLocalStatsSummary,
  useSubscriptionUsage,
} from "@/features/usage/queries";
import "@/features/usage/usage-stats.css";
import type { Subscription } from "./subscriptionUsageModel";

const minuteMs = 60_000;
const summaryColors = [
  "var(--subscription-usage-blue)",
  "var(--subscription-usage-clay)",
  "var(--subscription-usage-violet)",
];

function UsageIndicator({ subscriptions }: { subscriptions: Subscription[] }) {
  if (!subscriptions.length) return <Gauge size={18} strokeWidth={1.6} aria-hidden="true" />;
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
          const color = providerAccent(
            subscription.provider.type || subscription.provider.id,
            index,
          );
          return (
            <g key={subscription.provider.id} fill={color}>
              <rect y={y} width={24} height={3} rx={1.5} fillOpacity={0.14} />
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

export function SubscriptionUsage({
  providers,
  onOpenUsageStats,
}: {
  providers: ProviderInfo[];
  onOpenUsageStats?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { subscriptions } = useSubscriptionUsage(providers);
  const measured = subscriptions.filter(({ windows }) => windows.length);
  const summary = measured.slice(0, summaryColors.length);
  const overflow = measured.length - summary.length;

  const [open, setOpen] = useState(false);
  const [popRange, setPopRange] = useState<"today" | "7d">("today");
  const [now, setNow] = useState(Date.now);
  const timeZone = useMemo(browserTimeZone, []);
  const localSummary = useLocalStatsSummary(timeZone, true);

  const warmSummary = () => {
    void prefetchLocalStatsSummary(timeZone);
  };
  const warmFullStats = () => {
    void prefetchLocalStats("7d", "all", timeZone);
  };

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), minuteMs);
    return () => clearInterval(timer);
  }, [open]);

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

  const hasAnyPaceTick = subscriptions.some((s) =>
    s.windows.some((w) => computeWindowPace(w, now).elapsedPercent !== null),
  );

  const activeLocal =
    popRange === "today" ? localSummary.data?.today : localSummary.data?.last7d;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="navigation-item data-[state=open]:bg-control-hover data-[state=open]:text-foreground"
          aria-label={t("usage.title")}
          title={t("usage.navigation")}
          onPointerEnter={warmSummary}
          onFocus={warmSummary}
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
      </PopoverTrigger>

      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="usage-popover-content"
      >
        <div className="usage-pop-body">
          {subscriptions.length > 0 && (
            <>
              <div className="usage-pop-head">
                <span className="usage-pop-label">{t("usage.title")}</span>
                {hasAnyPaceTick && (
                  <span className="usage-pop-label tabular-nums">
                    {t("usage.paceLegend")}
                  </span>
                )}
              </div>

              <div className="usage-pop-sub-list">
                {subscriptions.map((subscription, idx) => {
                  const { provider, windows, sampledAt, notice } = subscription;
                  const sampled = sampledAt ? Date.parse(sampledAt) : NaN;
                  const sampledTitle = Number.isFinite(sampled)
                    ? resetFormat.format(sampled)
                    : undefined;
                  const color = providerAccent(
                    provider.type || provider.id,
                    idx,
                  );

                  const leadWindow = windows[0];
                  const leadPace = leadWindow
                    ? computeWindowPace(leadWindow, now)
                    : null;
                  let paceBadgeText = "";
                  let paceBadgeClass = "usage-pop-provider-pace";
                  if (leadPace) {
                    if (leadPace.usedPercent >= 90) {
                      paceBadgeText = t("usage.paceNearLimit");
                      paceBadgeClass += " usage-pace-fast";
                    } else if (leadPace.delta !== null && leadPace.delta >= 6) {
                      paceBadgeText = t("usage.paceFastDelta", {
                        delta: leadPace.delta,
                      });
                      paceBadgeClass += " usage-pace-fast";
                    } else if (
                      leadPace.delta !== null &&
                      leadPace.delta <= -6
                    ) {
                      paceBadgeText = t("usage.paceAmple");
                      paceBadgeClass += " usage-pace-ok";
                    } else if (leadPace.delta !== null) {
                      paceBadgeText = t("usage.paceSteady");
                    }
                  }

                  return (
                    <section key={provider.id} className="usage-pop-provider">
                      <div className="usage-pop-provider-name">
                        <span className="truncate">{provider.name}</span>
                        {paceBadgeText && (
                          <span className={paceBadgeClass}>
                            {paceBadgeText}
                          </span>
                        )}
                      </div>

                      {notice && (
                        <p
                          title={
                            notice === "usage.lastReading"
                              ? sampledTitle
                              : undefined
                          }
                          className={
                            windows.length
                              ? "mb-1.5 text-xs text-muted-foreground"
                              : "text-xs text-muted-foreground"
                          }
                        >
                          {t(notice)}
                        </p>
                      )}

                      {windows.map((window, windowIndex) => {
                        const reset = Date.parse(window.resetsAt ?? "");
                        const pace = computeWindowPace(window, now);
                        const showGroup =
                          window.group &&
                          window.group !== windows[windowIndex - 1]?.group;
                        return (
                          <div key={window.id} className="usage-pop-win">
                            {showGroup && (
                              <div className="mb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">
                                {window.group}
                              </div>
                            )}
                            <div className="usage-pop-win-top tabular-nums">
                              <span className="usage-pop-win-left">
                                <span>{windowLabel(window, t)}</span>
                                {Number.isFinite(reset) && reset > now && (
                                  <time
                                    dateTime={window.resetsAt}
                                    title={resetFormat.format(reset)}
                                  >
                                    {t("usage.reset", {
                                      when: resetCountdown(reset - now),
                                    })}
                                  </time>
                                )}
                              </span>
                              <span className="usage-pop-win-right">
                                {t("usage.remaining", {
                                  percent: percentFormat.format(
                                    pace.remainingPercent / 100,
                                  ),
                                })}
                              </span>
                            </div>
                            <div
                              aria-hidden="true"
                              className="usage-pace-bar"
                              style={{
                                backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
                              }}
                            >
                              <div
                                className="usage-pace-bar-fill"
                                style={{
                                  width: `${pace.usedPercent}%`,
                                  backgroundColor: color,
                                }}
                              />
                              {pace.elapsedPercent !== null && (
                                <div
                                  className="usage-pace-tick"
                                  style={{ left: `${pace.elapsedPercent}%` }}
                                  title={t("usage.paceElapsedTitle", {
                                    percent: pace.elapsedPercent,
                                  })}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            </>
          )}

          {/* Local Usage Quick Summary */}
          <div
            className={
              subscriptions.length > 0
                ? "usage-pop-stats"
                : "usage-pop-stats usage-pop-stats--standalone"
            }
          >
            <div className="usage-pop-stats-head">
              <span className="usage-pop-label">
                {t("usage.popoverLocalTitle")}
              </span>
              <div className="usage-mini-seg" role="group">
                <button
                  type="button"
                  aria-pressed={popRange === "today"}
                  onClick={() => setPopRange("today")}
                >
                  {t("usage.popoverToday")}
                </button>
                <button
                  type="button"
                  aria-pressed={popRange === "7d"}
                  onClick={() => setPopRange("7d")}
                >
                  {t("usage.popover7d")}
                </button>
              </div>
            </div>

            {localSummary.isPending && !activeLocal ? (
              <div className="usage-pop-stats-grid">
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ) : (
              <div className="usage-pop-stats-grid tabular-nums">
                <div className="usage-pop-stat-item">
                  <div className="k">{t("usage.popoverTokens")}</div>
                  <div className="v">
                    {fmtTokens(activeLocal?.tokens ?? 0)}
                  </div>
                  <div className="s">
                    {t("usage.popoverCacheHit", {
                      rate: fmtPct(activeLocal?.cacheHitRate ?? 0),
                    })}
                  </div>
                </div>
                <div className="usage-pop-stat-item">
                  <div className="k">{t("usage.popoverCost")}</div>
                  <div className="v">
                    {fmtUsd(activeLocal?.costUsd ?? 0)}
                  </div>
                  <div className="s">
                    {t("usage.popoverSessionsRuns", {
                      sessions: activeLocal?.sessions ?? 0,
                      runs: (activeLocal?.runs ?? 0).toLocaleString(),
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {onOpenUsageStats && (
          <div className="usage-pop-footer">
            <button
              type="button"
              className="usage-pop-footer-btn"
              onPointerEnter={warmFullStats}
              onFocus={warmFullStats}
              onClick={() => {
                setOpen(false);
                onOpenUsageStats();
              }}
            >
              <span>{t("usage.popoverViewFull")}</span>
              <ArrowRight size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
