import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { ProviderInfo, TokenTotals } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { BreakdownTable } from "./BreakdownTable";
import {
  browserTimeZone,
  fmtMetricValue,
  fmtPct,
  fmtTokens,
  fmtTps,
  fmtUsd,
  formatWindowRange,
  modelAccent,
  providerAccent,
  type UsageMetric,
} from "./format";
import { HourlyHeatmap } from "./HourlyHeatmap";
import { LimitsOverview } from "./LimitsOverview";
import {
  useLocalStats,
  useSubscriptionUsage,
  type LocalStatsPeriod,
  type LocalStatsScope,
} from "./queries";
import { TrendChart, type ChartSeriesItem } from "./TrendChart";
import "./usage-stats.css";

type MetricMode = "tokens" | "cost" | "tps" | "limits";
type SeriesGroupMode = "provider" | "model";

interface RankItem {
  id: string;
  name: string;
  color: string;
  tokens: number;
  costUsd: number;
  avgTps: number;
  tpsSamples: number;
  sessions: number;
  totals: TokenTotals;
  cacheSavingsUsd: number;
  categoryCost: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
  leverTokens: number;
  leverCostUsd: number;
  seriesTokens: number[];
  seriesCost: number[];
  seriesTps: number[];
}

function ShareBarBlock({
  title,
  aside,
  metric,
  segments,
}: {
  title: string;
  aside: string;
  metric: "tokens" | "cost";
  segments: Array<{ label: string; value: number; color: string }>;
}) {
  const nonZero = segments.filter((s) => s.value > 0);
  const sum = nonZero.reduce((acc, s) => acc + s.value, 0) || 1;

  return (
    <div className="usage-sharebar-block">
      <div className="usage-sharebar-head">
        <h3 className="usage-section-title">{title}</h3>
        <span className="usage-sharebar-aside tabular-nums">{aside}</span>
      </div>
      <div className="usage-sharebar-track">
        {nonZero.length > 0 ? (
          nonZero.map((s) => (
            <div
              key={s.label}
              className="usage-sharebar-seg"
              style={{
                flex: `${s.value} 1 0`,
                backgroundColor: s.color,
              }}
              title={`${s.label} · ${fmtMetricValue(s.value, metric)} (${fmtPct(s.value / sum)})`}
            />
          ))
        ) : (
          <div
            className="usage-sharebar-seg"
            style={{ flex: "1 1 0", backgroundColor: "var(--usage-heat-0)" }}
          />
        )}
      </div>
      <ul className="usage-sharebar-legend tabular-nums">
        {segments.map((s) => (
          <li key={s.label}>
            <span
              className="usage-sharebar-swatch"
              style={{ backgroundColor: s.color }}
            />
            <span className="lbl">{s.label}</span>
            <span className="num">{fmtMetricValue(s.value, metric)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UsageStatsPage({
  visible,
  providers,
  onOpenChat,
}: {
  visible: boolean;
  providers: ProviderInfo[];
  onOpenChat?: (chatId: string, agentId: string, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const timeZone = useMemo(browserTimeZone, []);
  const [scope, setScope] = useState<LocalStatsScope>("all");
  const [period, setPeriod] = useState<LocalStatsPeriod>("7d");
  const [metric, setMetric] = useState<MetricMode>("tokens");
  const [groupBy, setGroupBy] = useState<SeriesGroupMode>("provider");
  const [focusId, setFocusId] = useState<string | null>(null);

  const statsQuery = useLocalStats(period, scope, timeZone, visible);
  const { subscriptions, refreshAll: refreshLimits } =
    useSubscriptionUsage(providers);
  const [refreshingLimits, setRefreshingLimits] = useState(false);

  const stats = statsQuery.data;
  const isLimits = metric === "limits";
  const valueMetric: UsageMetric =
    metric === "cost" ? "cost" : metric === "tps" ? "tps" : "tokens";
  const shareMetric: "tokens" | "cost" =
    valueMetric === "cost" ? "cost" : "tokens";

  const handleRefresh = async () => {
    if (isLimits) {
      setRefreshingLimits(true);
      try {
        await refreshLimits();
      } finally {
        setRefreshingLimits(false);
      }
      return;
    }
    await statsQuery.refresh();
  };

  const rangeLabel = useMemo(() => {
    if (isLimits) return t("usage.statsLimitsRange");
    if (!stats) return "";
    return formatWindowRange(
      stats.since,
      stats.until,
      stats.resolution,
      i18n.language,
    );
  }, [isLimits, stats, i18n.language, t]);

  // Build ranked series items for Provider mode or Model mode
  const rankPool: RankItem[] = useMemo(() => {
    if (!stats) return [];
    if (groupBy === "provider") {
      return (stats.providers ?? []).map((p, idx) => ({
        id: p.id,
        name: p.name,
        color: providerAccent(p.id, idx),
        tokens: p.tokens,
        costUsd: p.costUsd,
        avgTps: p.avgTps ?? 0,
        tpsSamples: p.tpsSamples ?? 0,
        sessions: p.sessions,
        totals: p.totals,
        cacheSavingsUsd: p.cacheSavingsUsd,
        categoryCost: p.categoryCost,
        leverTokens: p.leverTokens,
        leverCostUsd: p.leverCostUsd,
        seriesTokens: p.seriesTokens ?? [],
        seriesCost: p.seriesCost ?? [],
        seriesTps: p.seriesTps ?? [],
      }));
    }
    const perProvCount = new Map<string, number>();
    return (stats.models ?? []).map((m) => {
      const rank = perProvCount.get(m.provider) ?? 0;
      perProvCount.set(m.provider, rank + 1);
      return {
        id: m.id,
        name: m.model,
        color: modelAccent(m.provider, rank),
        tokens: m.tokens,
        costUsd: m.costUsd,
        avgTps: m.avgTps ?? 0,
        tpsSamples: m.tpsSamples ?? 0,
        sessions: m.sessions,
        totals: m.totals,
        cacheSavingsUsd: m.cacheSavingsUsd,
        categoryCost: m.categoryCost,
        leverTokens: m.leverTokens,
        leverCostUsd: m.leverCostUsd,
        seriesTokens: m.seriesTokens ?? [],
        seriesCost: m.seriesCost ?? [],
        seriesTps: m.seriesTps ?? [],
      };
    });
  }, [stats, groupBy]);

  // Clear stale focusId if the selected item doesn't exist in current period/scope/group
  const effectiveFocus = useMemo(
    () => (focusId ? rankPool.find((item) => item.id === focusId) ?? null : null),
    [focusId, rankPool],
  );

  const sortedRank = useMemo(() => {
    const limit = groupBy === "model" ? 5 : 6;
    if (valueMetric === "tps") {
      // Pick the highest-volume active providers/models with TPS samples first so
      // low-sample utility models don't crowd out primary models, then rank by TPS.
      return [...rankPool]
        .sort((a, b) => {
          const aHas = a.tpsSamples > 0 ? 1 : 0;
          const bHas = b.tpsSamples > 0 ? 1 : 0;
          if (aHas !== bHas) return bHas - aHas;
          return b.tokens - a.tokens;
        })
        .slice(0, limit)
        .sort((a, b) => b.avgTps - a.avgTps || b.tokens - a.tokens);
    }
    return [...rankPool]
      .sort((a, b) =>
        valueMetric === "cost" ? b.costUsd - a.costUsd : b.tokens - a.tokens,
      )
      .slice(0, limit);
  }, [rankPool, valueMetric, groupBy]);

  const chartSeries: ChartSeriesItem[] = useMemo(() => {
    const source = effectiveFocus ? [effectiveFocus] : sortedRank.slice(0, 5);
    return source.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      total:
        valueMetric === "tps"
          ? s.avgTps
          : valueMetric === "cost"
            ? s.costUsd
            : s.tokens,
      values:
        valueMetric === "tps"
          ? s.seriesTps
          : valueMetric === "cost"
            ? s.seriesCost
            : s.seriesTokens,
    }));
  }, [effectiveFocus, sortedRank, valueMetric]);

  // Active headline metrics (grand totals, or exact focused provider/model metrics)
  const activeMetrics = useMemo(() => {
    if (!stats) return null;
    if (effectiveFocus) {
      const totals = effectiveFocus.totals;
      const denom =
        totals.uncachedInput + totals.cachedInput + totals.cacheWrite;
      return {
        totals,
        costUsd: effectiveFocus.costUsd,
        avgTps: effectiveFocus.avgTps,
        tpsSamples: effectiveFocus.tpsSamples,
        cacheSavingsUsd: effectiveFocus.cacheSavingsUsd,
        categoryCost: effectiveFocus.categoryCost,
        cacheHitRate: denom > 0 ? totals.cachedInput / denom : 0,
        sessionsCount: effectiveFocus.sessions,
        leverTokens: effectiveFocus.leverTokens,
        leverCostUsd: effectiveFocus.leverCostUsd,
        externalTokens: Math.max(
          0,
          effectiveFocus.tokens - effectiveFocus.leverTokens,
        ),
        externalCostUsd: Math.max(
          0,
          effectiveFocus.costUsd - effectiveFocus.leverCostUsd,
        ),
      };
    }
    return {
      totals: stats.totals,
      costUsd: stats.costUsd,
      avgTps: stats.avgTps ?? 0,
      tpsSamples: stats.tpsSamples ?? 0,
      cacheSavingsUsd: stats.cacheSavingsUsd,
      categoryCost: stats.categoryCost,
      cacheHitRate: stats.cacheHitRate,
      sessionsCount: stats.sessionsCount,
      leverTokens: stats.leverTokens,
      leverCostUsd: stats.leverCostUsd,
      externalTokens: stats.externalTokens,
      externalCostUsd: stats.externalCostUsd,
    };
  }, [stats, effectiveFocus]);

  const allTokensSum = Math.max(1, stats?.totals.total ?? 0);
  const allCostSum = Math.max(0.0001, stats?.costUsd ?? 0);

  const chartTitle =
    stats?.resolution === "hour"
      ? valueMetric === "tps"
        ? t("usage.chartTitleTps24h")
        : valueMetric === "cost"
          ? t("usage.chartTitleCost24h")
          : t("usage.chartTitleTokens24h")
      : valueMetric === "tps"
        ? t("usage.chartTitleTpsDay")
        : valueMetric === "cost"
          ? t("usage.chartTitleCostDay")
          : t("usage.chartTitleTokensDay");

  const readySourcesCount =
    stats?.sources.filter((s) => s.status === "ok" || s.status === "partial")
      .length ?? 0;

  const isSpinning = statsQuery.refreshing || refreshingLimits;

  return (
    <div className="usage-page">
      {/* Page Header + Controls */}
      <header className="usage-page-header">
        <div className="usage-page-title">
          <h2 id="settings-section-usageStats">{t("usage.statsTitle")}</h2>
          <div className="usage-page-subtitle">
            {rangeLabel && <span>{rangeLabel}</span>}
            {rangeLabel && <span aria-hidden="true">·</span>}
            <span>
              {scope === "lever"
                ? t("usage.statsScopeLeverDesc")
                : t("usage.statsScopeAllDesc")}
            </span>
          </div>
        </div>

        <div className="usage-controls-row">
          <ToggleGroup
            type="single"
            value={scope}
            onValueChange={(next) => {
              if (next) {
                setScope(next as LocalStatsScope);
                setFocusId(null);
              }
            }}
            aria-label={t("usage.scopeLabel")}
            className="usage-toggle-group"
          >
            <ToggleGroupItem value="all" className="usage-toggle-item">
              {t("usage.scopeAll")}
            </ToggleGroupItem>
            <ToggleGroupItem value="lever" className="usage-toggle-item">
              {t("usage.scopeLever")}
            </ToggleGroupItem>
          </ToggleGroup>

          <ToggleGroup
            type="single"
            value={period}
            onValueChange={(next) => {
              if (next) setPeriod(next as LocalStatsPeriod);
            }}
            aria-label={t("usage.periodLabel")}
            className={cn(
              "usage-toggle-group",
              isLimits && "pointer-events-none opacity-40",
            )}
          >
            <ToggleGroupItem value="24h" className="usage-toggle-item">
              24h
            </ToggleGroupItem>
            <ToggleGroupItem value="7d" className="usage-toggle-item">
              7d
            </ToggleGroupItem>
            <ToggleGroupItem value="30d" className="usage-toggle-item">
              30d
            </ToggleGroupItem>
            <ToggleGroupItem value="90d" className="usage-toggle-item">
              90d
            </ToggleGroupItem>
          </ToggleGroup>

          <ToggleGroup
            type="single"
            value={metric}
            onValueChange={(next) => {
              if (next) setMetric(next as MetricMode);
            }}
            aria-label={t("usage.metricLabel")}
            className="usage-toggle-group"
          >
            <ToggleGroupItem value="tokens" className="usage-toggle-item">
              {t("usage.metricTokens")}
            </ToggleGroupItem>
            <ToggleGroupItem value="cost" className="usage-toggle-item">
              {t("usage.metricCost")}
            </ToggleGroupItem>
            <ToggleGroupItem value="tps" className="usage-toggle-item">
              {t("usage.metricTps")}
            </ToggleGroupItem>
            <ToggleGroupItem value="limits" className="usage-toggle-item">
              {t("usage.metricLimits")}
            </ToggleGroupItem>
          </ToggleGroup>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("usage.refresh")}
            title={t("usage.refresh")}
            disabled={isSpinning}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw
              size={15}
              strokeWidth={1.7}
              className={cn(isSpinning && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {/* Main Content */}
      {isLimits ? (
        <LimitsOverview subscriptions={subscriptions} />
      ) : statsQuery.error ? (
        <ErrorNotice
          error={statsQuery.error}
          retry={() => void statsQuery.refetch()}
        />
      ) : !stats || !activeMetrics ? (
        <div className="flex flex-col gap-6">
          <div className="usage-hero-grid">
            <div className="flex flex-col gap-3">
              <Skeleton className="h-11 w-40" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-2 h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
            <Skeleton className="h-[268px] w-full rounded-xl" />
          </div>
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-52 w-full rounded-xl" />
        </div>
      ) : stats.totals.total === 0 ? (
        <Empty className="panel-surface py-12">
          <EmptyHeader>
            <EmptyTitle>{t("usage.emptyStateTitle")}</EmptyTitle>
            <EmptyDescription>{t("usage.emptyStateDesc")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-7">
          {/* 1. Hero + Distribution Chart */}
          <section className="usage-hero-grid">
            <div className="usage-hero-summary">
              <div>
                <div className="usage-hero-figure tabular-nums">
                  {valueMetric === "tps"
                    ? fmtTps(activeMetrics.avgTps)
                    : valueMetric === "cost"
                      ? fmtUsd(activeMetrics.costUsd)
                      : fmtTokens(activeMetrics.totals.total)}
                </div>
                <div className="usage-hero-meta tabular-nums">
                  {valueMetric === "tps"
                    ? t("usage.heroMetaTps", {
                        samples: activeMetrics.tpsSamples.toLocaleString(),
                        output: fmtTokens(activeMetrics.totals.output),
                      })
                    : valueMetric === "cost"
                      ? t("usage.heroMetaCost", {
                          sessions: activeMetrics.sessionsCount,
                        })
                      : t("usage.heroMetaTokens", {
                          sessions: activeMetrics.sessionsCount,
                          cost: fmtUsd(activeMetrics.costUsd),
                        })}
                </div>
              </div>

              <div className="usage-series-rank">
                {sortedRank.map((item) => {
                  const share =
                    valueMetric === "cost"
                      ? item.costUsd / allCostSum
                      : item.tokens / allTokensSum;
                  const selected = effectiveFocus?.id === item.id;
                  const dimmed = !!effectiveFocus && !selected;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        "usage-series-row",
                        selected && "selected",
                        dimmed && "dimmed",
                      )}
                      onClick={() =>
                        setFocusId((prev) =>
                          prev === item.id ? null : item.id,
                        )
                      }
                    >
                      <div className="usage-series-row-top">
                        <span className="usage-series-name">
                          <span
                            className="usage-series-dot"
                            style={{ backgroundColor: item.color }}
                          />
                          <span
                            className={cn(
                              "usage-series-label-txt",
                              groupBy === "model" && "font-mono text-xs",
                            )}
                            title={item.name}
                          >
                            {item.name}
                          </span>
                          <span className="usage-series-sessions tabular-nums">
                            {t("usage.sessionsUnit", { count: item.sessions })}
                          </span>
                        </span>
                        <span className="usage-series-val tabular-nums">
                          {fmtMetricValue(
                            valueMetric === "tps"
                              ? item.avgTps
                              : valueMetric === "cost"
                                ? item.costUsd
                                : item.tokens,
                            valueMetric,
                          )}
                        </span>
                      </div>
                      <div className="usage-series-sub tabular-nums">
                        {valueMetric === "tps"
                          ? t("usage.shareOfTps", {
                              samples: item.tpsSamples.toLocaleString(),
                              output: fmtTokens(item.totals.output),
                            })
                          : valueMetric === "cost"
                            ? t("usage.shareOfCost", {
                                share: fmtPct(share),
                                tokens: fmtTokens(item.tokens),
                              })
                            : t("usage.shareOfTokens", {
                                share: fmtPct(share),
                                cost: fmtUsd(item.costUsd),
                              })}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="usage-chart-column">
              <div className="usage-chart-header">
                <div className="usage-chart-header-left">
                  <h3 className="usage-section-title">{chartTitle}</h3>
                  <span className="usage-hint">
                    {effectiveFocus
                      ? t("usage.chartFocusedHint", {
                          name: effectiveFocus.name,
                        })
                      : groupBy === "provider"
                        ? t("usage.chartHintProvider")
                        : t("usage.chartHintModel")}
                  </span>
                </div>

                <ToggleGroup
                  type="single"
                  value={groupBy}
                  onValueChange={(next) => {
                    if (next) {
                      setGroupBy(next as SeriesGroupMode);
                      setFocusId(null);
                    }
                  }}
                  aria-label={t("usage.groupByLabel")}
                  className="usage-toggle-group"
                >
                  <ToggleGroupItem
                    value="provider"
                    className="usage-toggle-item"
                  >
                    {t("usage.groupByProvider")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="model" className="usage-toggle-item">
                    {t("usage.groupByModel")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <TrendChart
                slots={stats.timeSlots ?? []}
                resolution={stats.resolution}
                series={chartSeries}
                metric={valueMetric}
                overallValues={
                  valueMetric === "tps" ? (stats.seriesTps ?? []) : undefined
                }
                monoNames={groupBy === "model"}
              />
            </div>
          </section>

          {/* 2. Totals 5-col */}
          <section className="usage-totals-section">
            <h3 className="usage-section-title">{t("usage.totalsHeading")}</h3>
            <dl className="usage-totals-grid">
              <div className="usage-metric-cell">
                <dt>{t("usage.totalProcessed")}</dt>
                <dd className="tabular-nums">
                  {fmtTokens(activeMetrics.totals.total)}
                </dd>
                <div className="usage-metric-sub">
                  {t("usage.totalProcessedSub")}
                </div>
              </div>

              <div className="usage-metric-cell">
                <dt>{t("usage.totalCachedRead")}</dt>
                <dd className="tabular-nums">
                  {fmtTokens(activeMetrics.totals.cachedInput)}
                </dd>
                <div className="usage-metric-sub tabular-nums">
                  {t("usage.totalHitRate", {
                    rate: fmtPct(activeMetrics.cacheHitRate),
                  })}
                </div>
              </div>

              <div className="usage-metric-cell">
                <dt>{t("usage.totalUncachedInput")}</dt>
                <dd className="tabular-nums">
                  {fmtTokens(activeMetrics.totals.uncachedInput)}
                </dd>
                <div className="usage-metric-sub tabular-nums">
                  {t("usage.totalCacheWriteSub", {
                    tokens: fmtTokens(activeMetrics.totals.cacheWrite),
                  })}
                </div>
              </div>

              <div className="usage-metric-cell">
                <dt>{t("usage.totalOutput")}</dt>
                <dd className="tabular-nums">
                  {fmtTokens(activeMetrics.totals.output)}
                </dd>
                <div className="usage-metric-sub tabular-nums">
                  {activeMetrics.totals.reasoning > 0
                    ? t("usage.totalOutputReasoning", {
                        tokens: fmtTokens(activeMetrics.totals.reasoning),
                      })
                    : t("usage.totalOutputSub")}
                </div>
              </div>

              <div className="usage-metric-cell">
                <dt>{t("usage.totalCacheSavings")}</dt>
                <dd className="positive tabular-nums">
                  {fmtUsd(activeMetrics.cacheSavingsUsd)}
                </dd>
                <div className="usage-metric-sub tabular-nums">
                  {activeMetrics.cacheSavingsUsd > 0 &&
                  activeMetrics.costUsd + activeMetrics.cacheSavingsUsd > 0
                    ? t("usage.totalCacheSavingsSub", {
                        pct: fmtPct(
                          activeMetrics.cacheSavingsUsd /
                            (activeMetrics.costUsd +
                              activeMetrics.cacheSavingsUsd),
                        ),
                      })
                    : t("usage.totalCacheSavingsNone")}
                </div>
              </div>
            </dl>
          </section>

          {/* 3. ShareBars (Monochrome neutral ink scale) */}
          <section className="usage-sharebars-grid">
            <ShareBarBlock
              title={
                shareMetric === "tokens"
                  ? t("usage.shareTokenTypes")
                  : t("usage.shareCostTypes")
              }
              aside={t("usage.shareCacheHitAside", {
                rate: fmtPct(activeMetrics.cacheHitRate),
              })}
              metric={shareMetric}
              segments={
                shareMetric === "tokens"
                  ? [
                      {
                        label: t("usage.shareCacheRead"),
                        value: activeMetrics.totals.cachedInput,
                        color: "var(--usage-ink-28)",
                      },
                      {
                        label: t("usage.shareCacheWrite"),
                        value: activeMetrics.totals.cacheWrite,
                        color: "var(--usage-ink-72)",
                      },
                      {
                        label: t("usage.shareUncachedInput"),
                        value: activeMetrics.totals.uncachedInput,
                        color: "var(--usage-ink-50)",
                      },
                      {
                        label: t("usage.shareOutput"),
                        value: activeMetrics.totals.output,
                        color: "var(--usage-ink-100)",
                      },
                    ]
                  : [
                      {
                        label: t("usage.shareOutputCost"),
                        value: activeMetrics.categoryCost.output,
                        color: "var(--usage-ink-100)",
                      },
                      {
                        label: t("usage.shareCacheWrite"),
                        value: activeMetrics.categoryCost.cacheWrite,
                        color: "var(--usage-ink-72)",
                      },
                      {
                        label: t("usage.shareUncachedInput"),
                        value: activeMetrics.categoryCost.input,
                        color: "var(--usage-ink-50)",
                      },
                      {
                        label: t("usage.shareCacheRead"),
                        value: activeMetrics.categoryCost.cacheRead,
                        color: "var(--usage-ink-28)",
                      },
                    ]
              }
            />

            <ShareBarBlock
              title={t("usage.shareSources")}
              aside={
                scope === "lever"
                  ? t("usage.shareLeverOnly")
                  : t("usage.shareLeverRatio", {
                      rate: fmtPct(
                        shareMetric === "cost"
                          ? activeMetrics.leverCostUsd /
                              Math.max(
                                0.0001,
                                activeMetrics.leverCostUsd +
                                  activeMetrics.externalCostUsd,
                              )
                          : activeMetrics.leverTokens /
                              Math.max(
                                1,
                                activeMetrics.leverTokens +
                                  activeMetrics.externalTokens,
                              ),
                      ),
                    })
              }
              metric={shareMetric}
              segments={[
                {
                  label: t("usage.shareLeverLabel"),
                  value:
                    shareMetric === "cost"
                      ? activeMetrics.leverCostUsd
                      : activeMetrics.leverTokens,
                  color: "var(--usage-ink-100)",
                },
                ...(scope === "all"
                  ? [
                      {
                        label: t("usage.shareExternalLabel"),
                        value:
                          shareMetric === "cost"
                            ? activeMetrics.externalCostUsd
                            : activeMetrics.externalTokens,
                        color: "var(--usage-ink-28)",
                      },
                    ]
                  : []),
              ]}
            />
          </section>

          {/* 4. Last 7 Days 7x24 Hourly Activity Matrix */}
          <HourlyHeatmap
            hourly={stats.hourly ?? []}
            timeZone={stats.timeZone}
            groupBy={groupBy}
            focusId={effectiveFocus?.id ?? null}
            focusName={effectiveFocus?.name}
          />

          {/* 5. Breakdown Table (Model / Agent / Project / Session / Date) */}
          <BreakdownTable
            stats={stats}
            metric={valueMetric}
            groupBy={groupBy}
            focusId={effectiveFocus?.id ?? null}
            rangeLabel={rangeLabel}
            onOpenChat={onOpenChat}
          />
        </div>
      )}

      {/* Collapsible Local Scan Sources */}
      {stats && (stats.sources?.length ?? 0) > 0 && (
        <details className="panel-surface usage-sources-panel">
          <summary className="usage-sources-summary">
            <span>{t("usage.sourcesHeading")}</span>
            <span className="usage-sources-meta tabular-nums">
              {t("usage.sourcesSummary", {
                ready: readySourcesCount,
                ms: stats.scanMs,
              })}
            </span>
          </summary>
          <div className="usage-source-list">
            {stats.sources.map((src) => (
              <div key={src.id} className="usage-source-item">
                <div>
                  <strong className="font-medium text-foreground">
                    {src.name}
                  </strong>
                  {src.path && (
                    <span className="usage-source-path">{src.path}</span>
                  )}
                </div>
                <div className="usage-source-status tabular-nums">
                  <span
                    className={cn(
                      "usage-status-dot",
                      src.status === "missing" && "usage-status-dot--muted",
                    )}
                  />
                  {src.status === "missing"
                    ? t("usage.sourceMissing")
                    : src.id === "lever"
                      ? t("usage.sourceLeverStat", {
                          sessions: src.sessions,
                          records: src.records,
                        })
                      : t("usage.sourceFilesStat", {
                          files: src.files,
                          sessions: src.sessions,
                        })}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
