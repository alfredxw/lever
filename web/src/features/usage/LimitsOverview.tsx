import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { Subscription } from "@/features/runtime/subscriptionUsageModel";
import {
  computeWindowPace,
  providerAccent,
  resetCountdown,
  windowLabel,
} from "./format";

const MINUTE_MS = 60_000;

export function LimitsOverview({
  subscriptions,
}: {
  subscriptions: Subscription[];
}) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);

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
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="usage-section-title">{t("usage.limitsHeading")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("usage.limitsSubtitle")}
          </p>
        </div>
      </div>

      {!subscriptions.length ? (
        <Empty className="panel-surface py-10">
          <EmptyHeader>
            <EmptyTitle>{t("usage.limitsEmptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("usage.limitsEmptyDesc")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="usage-limits-grid">
          {subscriptions.map((sub, idx) => {
            const color = providerAccent(sub.provider.type || sub.provider.id, idx);
            return (
              <div
                key={sub.provider.id}
                className="panel-surface usage-limit-card"
              >
                <div className="usage-limit-card-head">
                  <div className="usage-limit-card-title">
                    <span
                      className="usage-series-dot"
                      style={{ backgroundColor: color }}
                    />
                    <span>{sub.provider.name}</span>
                  </div>
                  <span className="usage-limit-badge">{sub.provider.type}</span>
                </div>

                {sub.notice && (
                  <p className="text-xs text-muted-foreground">
                    {t(sub.notice)}
                  </p>
                )}

                {sub.windows.map((win, winIdx) => {
                  const pace = computeWindowPace(win, now);
                  const resetMs = win.resetsAt ? Date.parse(win.resetsAt) : NaN;
                  const showGroup =
                    win.group && win.group !== sub.windows[winIdx - 1]?.group;
                  const paceText =
                    pace.usedPercent >= 90
                      ? t("usage.paceNearLimit")
                      : pace.delta !== null
                        ? pace.delta >= 6
                          ? t("usage.paceNoteFast", { delta: pace.delta })
                          : pace.delta <= -6
                            ? t("usage.paceNoteLow", {
                                delta: Math.abs(pace.delta),
                              })
                            : t("usage.paceNoteSteady", {
                                delta:
                                  pace.delta >= 0
                                    ? `+${pace.delta}`
                                    : String(pace.delta),
                              })
                        : null;

                  return (
                    <div key={win.id} className="usage-limit-win">
                      {showGroup && (
                        <div className="text-xs font-medium text-muted-foreground">
                          {win.group}
                        </div>
                      )}
                      <div className="usage-limit-win-row tabular-nums">
                        <div className="usage-limit-win-meta">
                          <span>{windowLabel(win, t)}</span>
                          {Number.isFinite(resetMs) && resetMs > now && (
                            <time
                              dateTime={win.resetsAt}
                              title={resetFormat.format(resetMs)}
                            >
                              {t("usage.reset", {
                                when: resetCountdown(resetMs - now),
                              })}
                            </time>
                          )}
                        </div>
                        <span className="usage-limit-win-pct">
                          {t("usage.remaining", {
                            percent: percentFormat.format(
                              pace.remainingPercent / 100,
                            ),
                          })}
                        </span>
                      </div>

                      <div
                        className="usage-pace-bar"
                        style={{
                          backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
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

                      <div className="usage-pace-note">
                        <span
                          className={
                            pace.status === "fast"
                              ? "usage-pace-fast"
                              : pace.status === "ok"
                                ? "usage-pace-ok"
                                : undefined
                          }
                        >
                          {paceText ?? ""}
                        </span>
                        <span className="tabular-nums">
                          {pace.elapsedPercent !== null
                            ? t("usage.paceUsedElapsed", {
                                used: pace.usedPercent,
                                elapsed: pace.elapsedPercent,
                              })
                            : t("usage.paceUsedOnly", {
                                used: pace.usedPercent,
                              })}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
