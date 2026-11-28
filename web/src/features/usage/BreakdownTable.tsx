import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, GitBranch, MessageSquare, Terminal } from "lucide-react";
import type {
  LocalStats,
  LocalStatsAgent,
  LocalStatsModel,
  LocalStatsProject,
  LocalStatsSession,
} from "@/api/types.gen";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  fmtMetricValue,
  fmtPct,
  fmtTokens,
  fmtTps,
  fmtUsd,
  formatSessionUpdated,
  formatSlotLabel,
  modelAccent,
  providerAccent,
  type UsageMetric,
} from "./format";

export type BreakdownTab = "model" | "agent" | "project" | "session" | "time";

interface DetailModalData {
  title: string;
  monoTitle?: boolean;
  subtitle: string;
  kpis: Array<[string, string]>;
  rows: Array<[string, string]>;
  openChat?: { chatId: string; agentId: string; title: string };
}

function sortByKey<T>(
  rows: T[],
  getter: (row: T) => number | string,
  dir: "asc" | "desc",
): T[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    if (typeof va === "string" && typeof vb === "string") {
      return va.localeCompare(vb) * mul;
    }
    return ((va as number) - (vb as number)) * mul;
  });
}

export function BreakdownTable({
  stats,
  metric,
  groupBy,
  focusId,
  rangeLabel,
  onOpenChat,
}: {
  stats: LocalStats;
  metric: UsageMetric;
  groupBy: "provider" | "model";
  focusId: string | null;
  rangeLabel: string;
  onOpenChat?: (chatId: string, agentId: string, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const tableMetric: "tokens" | "cost" = metric === "cost" ? "cost" : "tokens";
  const [tab, setTab] = useState<BreakdownTab>("model");
  const [sortKey, setSortKey] = useState<string>(metric);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [detail, setDetail] = useState<DetailModalData | null>(null);

  // Follow primary metric switch when sorting by tokens, cost, or tps
  useEffect(() => {
    setSortKey((prev) => {
      if (prev !== "tokens" && prev !== "cost" && prev !== "tps") return prev;
      return tab === "model" ? metric : tableMetric;
    });
  }, [metric, tableMetric, tab]);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const renderSortTh = (label: string, key: string) => {
    const active = sortKey === key;
    return (
      <th>
        <button
          type="button"
          className={active ? "usage-th-sort-btn active" : "usage-th-sort-btn"}
          onClick={() => toggleSort(key)}
        >
          <span>{label}</span>
          {active && (
            <span className="usage-sort-arrow" aria-hidden="true">
              {sortDir === "desc" ? "↓" : "↑"}
            </span>
          )}
        </button>
      </th>
    );
  };

  // Consistent color assignment per model (matches Hero & TrendChart)
  const modelColorMap = useMemo(() => {
    const counts = new Map<string, number>();
    const map = new Map<string, string>();
    for (const m of stats.models ?? []) {
      const rank = counts.get(m.provider) ?? 0;
      counts.set(m.provider, rank + 1);
      map.set(m.id, modelAccent(m.provider, rank));
    }
    return map;
  }, [stats.models]);

  const matchesFocus = (providerId: string, modelId?: string, modelName?: string) => {
    if (!focusId) return true;
    if (groupBy === "provider") return providerId === focusId;
    if (modelId && modelId === focusId) return true;
    if (modelName && `${providerId}:${modelName}` === focusId) return true;
    return false;
  };

  const handleTabChange = (next: string) => {
    if (!next) return;
    setTab(next as BreakdownTab);
    setSortKey(next === "model" ? metric : tableMetric);
    setSortDir("desc");
  };

  // --- Prepared rows for each tab ---
  const modelRows = useMemo(() => {
    const base = (stats.models ?? []).filter((m) =>
      matchesFocus(m.provider, m.id, m.model),
    );
    const totalSum =
      base.reduce(
        (s, m) => s + (tableMetric === "cost" ? m.costUsd : m.tokens),
        0,
      ) || 1;
    const getters: Record<string, (m: LocalStatsModel) => number> = {
      tps: (m) => m.avgTps ?? 0,
      hit: (m) => m.cacheHitRate,
      sessions: (m) => m.sessions,
      cost: (m) => m.costUsd,
      tokens: (m) => m.tokens,
    };
    const sorted = sortByKey(base, getters[sortKey] ?? getters[metric], sortDir);
    const peak = Math.max(
      1,
      ...sorted.map((m) =>
        metric === "tps"
          ? (m.avgTps ?? 0)
          : metric === "cost"
            ? m.costUsd
            : m.tokens,
      ),
    );
    return { rows: sorted, totalSum, peak };
  }, [stats.models, focusId, groupBy, metric, tableMetric, sortKey, sortDir]);

  const agentRows = useMemo(() => {
    const base = (stats.agents ?? []).filter((a) =>
      matchesFocus(a.provider, undefined, a.model),
    );
    const totalSum =
      base.reduce(
        (s, a) => s + (tableMetric === "cost" ? a.costUsd : a.tokens),
        0,
      ) || 1;
    const getters: Record<string, (a: LocalStatsAgent) => number> = {
      runs: (a) => a.runs,
      codeTotal: (a) => a.additions + a.deletions,
      cost: (a) => a.costUsd,
      tokens: (a) => a.tokens,
    };
    const sorted = sortByKey(
      base,
      getters[sortKey] ?? getters[tableMetric],
      sortDir,
    );
    const peak = Math.max(
      1,
      ...sorted.map((a) => (tableMetric === "cost" ? a.costUsd : a.tokens)),
    );
    return { rows: sorted, totalSum, peak };
  }, [stats.agents, focusId, groupBy, tableMetric, sortKey, sortDir]);

  const projectRows = useMemo(() => {
    const base = stats.projects ?? [];
    const totalSum =
      base.reduce(
        (s, p) => s + (tableMetric === "cost" ? p.costUsd : p.tokens),
        0,
      ) || 1;
    const getters: Record<string, (p: LocalStatsProject) => number> = {
      sessions: (p) => p.sessions,
      codeTotal: (p) => p.additions + p.deletions,
      cost: (p) => p.costUsd,
      tokens: (p) => p.tokens,
    };
    const sorted = sortByKey(
      base,
      getters[sortKey] ?? getters[tableMetric],
      sortDir,
    );
    const peak = Math.max(
      1,
      ...sorted.map((p) => (tableMetric === "cost" ? p.costUsd : p.tokens)),
    );
    return { rows: sorted, totalSum, peak };
  }, [stats.projects, tableMetric, sortKey, sortDir]);

  const sessionRows = useMemo(() => {
    const base = (stats.sessions ?? []).filter((s) =>
      matchesFocus(s.provider, undefined, s.model),
    );
    const getters: Record<string, (s: LocalStatsSession) => number> = {
      runs: (s) => s.runs,
      updatedTs: (s) => Date.parse(s.updatedAt) || 0,
      cost: (s) => s.costUsd,
      tokens: (s) => s.tokens,
    };
    const sorted = sortByKey(
      base,
      getters[sortKey] ?? getters[tableMetric],
      sortDir,
    );
    const peak = Math.max(
      1,
      ...sorted.map((s) => (tableMetric === "cost" ? s.costUsd : s.tokens)),
    );
    return { rows: sorted, peak };
  }, [stats.sessions, focusId, groupBy, tableMetric, sortKey, sortDir]);

  const timeSeriesCols = useMemo(() => {
    const rawPool =
      groupBy === "provider"
        ? (stats.providers ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            seriesTokens: p.seriesTokens ?? [],
            seriesCost: p.seriesCost ?? [],
            seriesTps: p.seriesTps ?? [],
            sortVal:
              metric === "tps"
                ? (p.avgTps ?? 0)
                : metric === "cost"
                  ? p.costUsd
                  : p.tokens,
          }))
        : (stats.models ?? []).map((m) => ({
            id: m.id,
            name: m.model,
            seriesTokens: m.seriesTokens ?? [],
            seriesCost: m.seriesCost ?? [],
            seriesTps: m.seriesTps ?? [],
            sortVal:
              metric === "tps"
                ? (m.avgTps ?? 0)
                : metric === "cost"
                  ? m.costUsd
                  : m.tokens,
          }));
    const filtered = focusId
      ? rawPool.filter((item) => item.id === focusId)
      : rawPool;
    const ordered = [...filtered].sort((a, b) => b.sortVal - a.sortVal);
    const cols = ordered.slice(0, 5);
    const slots = stats.timeSlots ?? [];
    const overallTps = stats.seriesTps ?? [];
    const rows = slots
      .map((slot, i) => {
        const totCost = ordered.reduce(
          (sum, s) => sum + (s.seriesCost[i] ?? 0),
          0,
        );
        const totTokens = ordered.reduce(
          (sum, s) => sum + (s.seriesTokens[i] ?? 0),
          0,
        );
        const slotAvgTps = focusId
          ? (cols[0]?.seriesTps[i] ?? 0)
          : (overallTps[i] ?? 0);
        return {
          slot,
          label: formatSlotLabel(slot, stats.resolution),
          values: cols.map((c) =>
            metric === "tps"
              ? (c.seriesTps[i] ?? 0)
              : metric === "cost"
                ? (c.seriesCost[i] ?? 0)
                : (c.seriesTokens[i] ?? 0),
          ),
          cost: totCost,
          tokens: totTokens,
          avgTps: slotAvgTps,
        };
      })
      .reverse();
    return { cols, rows };
  }, [stats, groupBy, focusId, metric]);

  const projectKindLabel = (kind: LocalStatsProject["kind"]) => {
    if (kind === "git") return t("usage.projectKindGit");
    if (kind === "chat") return t("usage.projectKindChat");
    return t("usage.projectKindFolder");
  };

  return (
    <section className="usage-breakdown-section">
      <div className="usage-breakdown-head">
        <div className="usage-breakdown-head-left">
          <h3 className="usage-section-title">{t("usage.breakdownHeading")}</h3>
          <span className="usage-hint">{t("usage.breakdownHint")}</span>
        </div>

        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={handleTabChange}
          aria-label={t("usage.breakdownGroupLabel")}
          className="usage-toggle-group"
        >
          <ToggleGroupItem value="model" className="usage-toggle-item">
            {t("usage.tabModel")}
          </ToggleGroupItem>
          <ToggleGroupItem value="agent" className="usage-toggle-item">
            {t("usage.tabAgent")}
          </ToggleGroupItem>
          <ToggleGroupItem value="project" className="usage-toggle-item">
            {t("usage.tabProject")}
          </ToggleGroupItem>
          <ToggleGroupItem value="session" className="usage-toggle-item">
            {t("usage.tabSession")}
          </ToggleGroupItem>
          <ToggleGroupItem value="time" className="usage-toggle-item">
            {t("usage.tabTime")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="overflow-x-auto">
        {tab === "model" && (
          <table className="usage-data-table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>{t("usage.colModel")}</th>
                {renderSortTh(t("usage.colOutputTps"), "tps")}
                {renderSortTh(t("usage.colCacheHit"), "hit")}
                {renderSortTh(t("usage.colSessions"), "sessions")}
                {renderSortTh(t("usage.colEstCost"), "cost")}
                <th>{t("usage.colShare")}</th>
                {renderSortTh(t("usage.colTotalTokens"), "tokens")}
              </tr>
            </thead>
            <tbody>
              {modelRows.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center">
                    {t("usage.emptyRows")}
                  </td>
                </tr>
              ) : (
                modelRows.rows.map((m, idx) => {
                  const val =
                    metric === "tps"
                      ? (m.avgTps ?? 0)
                      : metric === "cost"
                        ? m.costUsd
                        : m.tokens;
                  const shareVal =
                    tableMetric === "cost" ? m.costUsd : m.tokens;
                  const color =
                    modelColorMap.get(m.id) ?? providerAccent(m.provider);
                  return (
                    <tr
                      key={m.id}
                      className="clickable"
                      onClick={() =>
                        setDetail({
                          title: m.model,
                          monoTitle: true,
                          subtitle: `${m.providerName} · ${rangeLabel}`,
                          kpis: [
                            [t("usage.colTotalTokens"), fmtTokens(m.tokens)],
                            [t("usage.colEstCost"), fmtUsd(m.costUsd)],
                            [
                              t("usage.colOutputTps"),
                              fmtTps(m.avgTps ?? 0),
                            ],
                          ],
                          rows: [
                            [
                              t("usage.modalOutputTps"),
                              (m.avgTps ?? 0) > 0
                                ? `${fmtTps(m.avgTps)} · ${t("usage.tpsSamplesShort", { count: m.tpsSamples ?? 0 })}`
                                : "—",
                            ],
                            [
                              t("usage.modalCacheHitRate"),
                              fmtPct(m.cacheHitRate),
                            ],
                            [
                              t("usage.modalSessions"),
                              t("usage.sessionsTimes", { count: m.sessions }),
                            ],
                            [
                              t("usage.modalCachedRead"),
                              fmtTokens(m.totals.cachedInput),
                            ],
                            [
                              t("usage.modalUncachedInput"),
                              fmtTokens(m.totals.uncachedInput),
                            ],
                            [
                              t("usage.modalCacheWrite"),
                              fmtTokens(m.totals.cacheWrite),
                            ],
                            [
                              t("usage.modalOutput"),
                              fmtTokens(m.totals.output),
                            ],
                            [
                              t("usage.modalRefPrice"),
                              m.priceInput && m.priceOutput
                                ? `$${m.priceInput} / M · $${m.priceOutput} / M`
                                : t("usage.modalUnpriced"),
                            ],
                          ],
                        })
                      }
                    >
                      <td className="text-xs tabular-nums">{idx + 1}</td>
                      <td>
                        <div className="usage-primary-cell">
                          <span
                            className="usage-series-dot"
                            style={{ backgroundColor: color }}
                          />
                          <span className="font-mono text-[12.5px]">
                            {m.model}
                          </span>
                          <span className="text-[11px] font-normal text-muted-foreground">
                            {m.providerName}
                          </span>
                        </div>
                        <div className="usage-inline-bar-track">
                          <div
                            className="usage-inline-bar-fill"
                            style={{
                              width:
                                val > 0
                                  ? `${Math.max(4, (val / modelRows.peak) * 100)}%`
                                  : "0%",
                              backgroundColor: color,
                            }}
                          />
                        </div>
                      </td>
                      <td
                        className={
                          metric === "tps"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtTps(m.avgTps ?? 0)}
                      </td>
                      <td className="tabular-nums">{fmtPct(m.cacheHitRate)}</td>
                      <td className="tabular-nums">{m.sessions}</td>
                      <td
                        className={
                          metric === "cost"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtUsd(m.costUsd)}
                      </td>
                      <td className="tabular-nums">
                        {fmtPct(shareVal / modelRows.totalSum)}
                      </td>
                      <td
                        className={
                          metric === "tokens"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtTokens(m.tokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {tab === "agent" && (
          <table className="usage-data-table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>{t("usage.colAgent")}</th>
                <th>{t("usage.colTopModel")}</th>
                {renderSortTh(t("usage.colRuns"), "runs")}
                {renderSortTh(t("usage.colCodeDiff"), "codeTotal")}
                {renderSortTh(t("usage.colEstCost"), "cost")}
                <th>{t("usage.colShare")}</th>
                {renderSortTh(t("usage.colTotalTokens"), "tokens")}
              </tr>
            </thead>
            <tbody>
              {agentRows.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center">
                    {t("usage.emptyRows")}
                  </td>
                </tr>
              ) : (
                agentRows.rows.map((a, idx) => {
                  const val = metric === "cost" ? a.costUsd : a.tokens;
                  const color = providerAccent(a.provider, idx);
                  const codeTotal = a.additions + a.deletions;
                  return (
                    <tr
                      key={a.id}
                      className="clickable"
                      onClick={() =>
                        setDetail({
                          title: a.name,
                          subtitle: `Lever Agent · ${a.model}`,
                          kpis: [
                            [t("usage.colTotalTokens"), fmtTokens(a.tokens)],
                            [t("usage.colEstCost"), fmtUsd(a.costUsd)],
                            [
                              t("usage.colRuns"),
                              t("usage.runsUnit", { count: a.runs }),
                            ],
                          ],
                          rows: [
                            [
                              t("usage.modalActiveSessions"),
                              t("usage.sessionsTimes", { count: a.sessions }),
                            ],
                            [
                              t("usage.modalPrimaryProject"),
                              a.project || t("usage.projectGlobalPath"),
                            ],
                            [
                              t("usage.modalCacheHitRate"),
                              fmtPct(a.cacheHitRate),
                            ],
                            [
                              t("usage.modalCodeDiff"),
                              codeTotal > 0
                                ? t("usage.modalCodeDiffLines", {
                                    add: a.additions.toLocaleString(),
                                    del: a.deletions.toLocaleString(),
                                  })
                                : t("usage.modalNoCodeDiff"),
                            ],
                          ],
                        })
                      }
                    >
                      <td className="text-xs tabular-nums">{idx + 1}</td>
                      <td>
                        <div className="usage-primary-cell">
                          <AgentAvatar
                            agent={{ id: a.id, name: a.name, avatar: a.avatar }}
                            size="xs"
                          />
                          <div className="min-w-0">
                            <div className="truncate">{a.name}</div>
                            <div className="usage-sub-meta-row">
                              {a.project
                                ? t("usage.agentPrimaryProject", {
                                    project: a.project,
                                    sessions: a.sessions,
                                  })
                                : t("usage.agentNoProject", {
                                    sessions: a.sessions,
                                  })}
                            </div>
                          </div>
                        </div>
                        <div className="usage-inline-bar-track ml-[30px]">
                          <div
                            className="usage-inline-bar-fill"
                            style={{
                              width: `${Math.max(5, (val / agentRows.peak) * 100)}%`,
                              backgroundColor: color,
                            }}
                          />
                        </div>
                      </td>
                      <td className="font-mono text-xs">{a.model || "—"}</td>
                      <td className="tabular-nums">
                        {t("usage.runsUnit", { count: a.runs })}
                      </td>
                      <td className="usage-diff-stat font-mono tabular-nums">
                        {codeTotal > 0 ? (
                          <>
                            <span className="usage-diff-add">
                              +{a.additions.toLocaleString()}
                            </span>
                            <span className="usage-diff-del">
                              -{a.deletions.toLocaleString()}
                            </span>
                          </>
                        ) : (
                          <span className="opacity-45">—</span>
                        )}
                      </td>
                      <td
                        className={
                          metric === "cost"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtUsd(a.costUsd)}
                      </td>
                      <td className="tabular-nums">
                        {fmtPct(val / agentRows.totalSum)}
                      </td>
                      <td
                        className={
                          tableMetric === "tokens"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtTokens(a.tokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {tab === "project" && (
          <table className="usage-data-table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>{t("usage.colProject")}</th>
                {renderSortTh(t("usage.colSessions"), "sessions")}
                {renderSortTh(t("usage.colCodeDiff"), "codeTotal")}
                {renderSortTh(t("usage.colEstCost"), "cost")}
                <th>{t("usage.colShare")}</th>
                {renderSortTh(t("usage.colTotalTokens"), "tokens")}
              </tr>
            </thead>
            <tbody>
              {projectRows.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center">
                    {t("usage.emptyRows")}
                  </td>
                </tr>
              ) : (
                projectRows.rows.map((p, idx) => {
                  const val = metric === "cost" ? p.costUsd : p.tokens;
                  const codeTotal = p.additions + p.deletions;
                  const displayName = p.name || t("usage.projectUnnamed");
                  const displayPath = p.path || t("usage.projectGlobalPath");
                  const kindLbl = projectKindLabel(p.kind);
                  return (
                    <tr
                      key={p.id}
                      className="clickable"
                      onClick={() =>
                        setDetail({
                          title: displayName,
                          subtitle: `${kindLbl} · ${displayPath}`,
                          kpis: [
                            [t("usage.colTotalTokens"), fmtTokens(p.tokens)],
                            [t("usage.colEstCost"), fmtUsd(p.costUsd)],
                            [
                              t("usage.colSessions"),
                              t("usage.sessionsTimes", { count: p.sessions }),
                            ],
                          ],
                          rows: [
                            [
                              t("usage.modalTopAgent"),
                              p.topAgent || t("usage.externalCli"),
                            ],
                            [t("usage.modalTopModel"), p.topModel || "—"],
                            [
                              t("usage.modalRuns"),
                              t("usage.runsUnit", { count: p.runs }),
                            ],
                            [
                              t("usage.modalCacheHitRate"),
                              fmtPct(p.cacheHitRate),
                            ],
                            [
                              t("usage.modalCodeDiff"),
                              codeTotal > 0
                                ? t("usage.modalCodeDiffLines", {
                                    add: p.additions.toLocaleString(),
                                    del: p.deletions.toLocaleString(),
                                  })
                                : t("usage.modalNoCodeDiff"),
                            ],
                          ],
                        })
                      }
                    >
                      <td className="text-xs tabular-nums">{idx + 1}</td>
                      <td>
                        <div className="usage-primary-cell">
                          {p.kind === "git" ? (
                            <GitBranch
                              size={15}
                              strokeWidth={1.6}
                              className="shrink-0 text-foreground"
                            />
                          ) : p.kind === "chat" ? (
                            <MessageSquare
                              size={15}
                              strokeWidth={1.6}
                              className="shrink-0 text-muted-foreground"
                            />
                          ) : (
                            <Folder
                              size={15}
                              strokeWidth={1.6}
                              className="shrink-0 text-muted-foreground"
                            />
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{displayName}</span>
                              <span className="usage-soft-badge">{kindLbl}</span>
                            </div>
                            <div className="usage-sub-meta-row">
                              <span
                                className="max-w-[168px] truncate font-mono"
                                title={displayPath}
                              >
                                {displayPath}
                              </span>
                              {p.topModel && (
                                <>
                                  <span>·</span>
                                  <span className="max-w-[130px] truncate">
                                    {t("usage.projectTopModelSub", {
                                      model: p.topModel,
                                    })}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="usage-inline-bar-track ml-[23px]">
                          <div
                            className="usage-inline-bar-fill"
                            style={{
                              width: `${Math.max(5, (val / projectRows.peak) * 100)}%`,
                              backgroundColor: "var(--foreground)",
                              opacity: 0.65,
                            }}
                          />
                        </div>
                      </td>
                      <td className="tabular-nums">
                        {t("usage.sessionsTimes", { count: p.sessions })}
                      </td>
                      <td className="usage-diff-stat font-mono tabular-nums">
                        {codeTotal > 0 ? (
                          <>
                            <span className="usage-diff-add">
                              +{p.additions.toLocaleString()}
                            </span>
                            <span className="usage-diff-del">
                              -{p.deletions.toLocaleString()}
                            </span>
                          </>
                        ) : (
                          <span className="opacity-45">—</span>
                        )}
                      </td>
                      <td
                        className={
                          metric === "cost"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtUsd(p.costUsd)}
                      </td>
                      <td className="tabular-nums">
                        {fmtPct(val / projectRows.totalSum)}
                      </td>
                      <td
                        className={
                          tableMetric === "tokens"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtTokens(p.tokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {tab === "session" && (
          <table className="usage-data-table">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th>{t("usage.colSession")}</th>
                <th>{t("usage.colTopModel")}</th>
                {renderSortTh(t("usage.colShortRuns"), "runs")}
                {renderSortTh(t("usage.colRecentActive"), "updatedTs")}
                {renderSortTh(t("usage.colEstCost"), "cost")}
                {renderSortTh(t("usage.colTotalTokens"), "tokens")}
              </tr>
            </thead>
            <tbody>
              {sessionRows.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center">
                    {t("usage.emptyRows")}
                  </td>
                </tr>
              ) : (
                sessionRows.rows.map((s, idx) => {
                  const val = metric === "cost" ? s.costUsd : s.tokens;
                  const color = providerAccent(s.provider, idx);
                  const updatedText = formatSessionUpdated(
                    s.updatedAt,
                    t,
                    i18n.language,
                  );
                  const codeTotal = s.additions + s.deletions;
                  const projectLabel = s.project || t("usage.projectGlobalPath");
                  const canOpen =
                    s.source === "lever" &&
                    !!s.chatId &&
                    !!s.agentId &&
                    !!onOpenChat;
                  return (
                    <tr
                      key={s.id}
                      className="clickable"
                      onClick={() =>
                        setDetail({
                          title: s.title,
                          subtitle: [
                            s.source === "lever"
                              ? t("usage.modalSourceLever", {
                                  agent: s.agentName || "Agent",
                                })
                              : t("usage.modalSourceCli"),
                            t("usage.modalProjectPrefix", {
                              project: projectLabel,
                            }),
                          ].join(" · "),
                          kpis: [
                            [t("usage.colTotalTokens"), fmtTokens(s.tokens)],
                            [t("usage.colEstCost"), fmtUsd(s.costUsd)],
                            [
                              t("usage.modalCacheHitRate"),
                              fmtPct(s.cacheHitRate),
                            ],
                          ],
                          rows: [
                            [
                              t("usage.modalTopModel"),
                              `${s.model} (${s.providerName})`,
                            ],
                            [
                              t("usage.modalRuns"),
                              t("usage.runsUnit", { count: s.runs }),
                            ],
                            [t("usage.modalRecentActive"), updatedText],
                            [
                              t("usage.modalCachedRead"),
                              fmtTokens(s.totals.cachedInput),
                            ],
                            [
                              t("usage.modalOutput"),
                              fmtTokens(s.totals.output),
                            ],
                            ...(codeTotal > 0
                              ? [
                                  [
                                    t("usage.modalCodeDiff"),
                                    t("usage.modalCodeDiffLines", {
                                      add: s.additions.toLocaleString(),
                                      del: s.deletions.toLocaleString(),
                                    }),
                                  ] as [string, string],
                                ]
                              : []),
                          ],
                          openChat: canOpen
                            ? {
                                chatId: s.chatId!,
                                agentId: s.agentId!,
                                title: s.title,
                              }
                            : undefined,
                        })
                      }
                    >
                      <td className="text-xs tabular-nums">{idx + 1}</td>
                      <td>
                        <div className="usage-primary-cell">
                          {s.source === "lever" && s.agentId ? (
                            <AgentAvatar
                              agent={{
                                id: s.agentId,
                                name: s.agentName || "A",
                                avatar: s.agentAvatar,
                              }}
                              size="xs"
                            />
                          ) : (
                            <span className="usage-cli-avatar" aria-hidden="true">
                              <Terminal size={12} strokeWidth={1.8} />
                            </span>
                          )}
                          <div className="min-w-0">
                            <div
                              className="usage-primary-cell-text"
                              title={s.title}
                            >
                              {s.title}
                            </div>
                            <div className="usage-sub-meta-row">
                              <span>
                                {s.source === "lever"
                                  ? s.agentName || "Lever"
                                  : t("usage.externalCli")}
                              </span>
                              <span>·</span>
                              <span>{projectLabel}</span>
                              {codeTotal > 0 && (
                                <>
                                  <span>·</span>
                                  <span className="font-mono">
                                    <span className="usage-diff-add">
                                      +{s.additions.toLocaleString()}
                                    </span>
                                    <span className="usage-diff-del">
                                      -{s.deletions.toLocaleString()}
                                    </span>
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="usage-inline-bar-track ml-[30px]">
                          <div
                            className="usage-inline-bar-fill"
                            style={{
                              width: `${Math.max(5, (val / sessionRows.peak) * 100)}%`,
                              backgroundColor: color,
                            }}
                          />
                        </div>
                      </td>
                      <td className="font-mono text-xs">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="usage-series-dot"
                            style={{ backgroundColor: color }}
                          />
                          {s.model || "—"}
                        </span>
                      </td>
                      <td className="tabular-nums">
                        {t("usage.runsUnit", { count: s.runs })}
                      </td>
                      <td className="text-xs tabular-nums">{updatedText}</td>
                      <td
                        className={
                          metric === "cost"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtUsd(s.costUsd)}
                      </td>
                      <td
                        className={
                          tableMetric === "tokens"
                            ? "strong tabular-nums"
                            : "tabular-nums"
                        }
                      >
                        {fmtTokens(s.tokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}

        {tab === "time" && (
          <table className="usage-data-table usage-time-table">
            <thead>
              <tr>
                <th>
                  {stats.resolution === "hour"
                    ? t("usage.colHourSlot")
                    : t("usage.colDate")}
                </th>
                {timeSeriesCols.cols.map((col) => (
                  <th
                    key={col.id}
                    className={
                      groupBy === "model" ? "font-mono text-[11px]" : undefined
                    }
                  >
                    {col.name}
                  </th>
                ))}
                <th>
                  {metric === "tps"
                    ? t("usage.colAvgTps")
                    : t("usage.colTotalCost")}
                </th>
                <th>{t("usage.colTotalTokens")}</th>
              </tr>
            </thead>
            <tbody>
              {timeSeriesCols.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={timeSeriesCols.cols.length + 3}
                    className="py-6 text-center"
                  >
                    {t("usage.emptyRows")}
                  </td>
                </tr>
              ) : (
                timeSeriesCols.rows.map((r) => (
                  <tr key={r.slot}>
                    <td className="strong tabular-nums">{r.label}</td>
                    {r.values.map((v, i) => (
                      <td
                        key={timeSeriesCols.cols[i].id}
                        className="tabular-nums"
                      >
                        {v > 0 ? fmtMetricValue(v, metric) : "—"}
                      </td>
                    ))}
                    <td
                      className={
                        metric === "cost" || metric === "tps"
                          ? "strong tabular-nums"
                          : "tabular-nums"
                      }
                    >
                      {metric === "tps" ? fmtTps(r.avgTps) : fmtUsd(r.cost)}
                    </td>
                    <td
                      className={
                        metric === "tokens"
                          ? "strong tabular-nums"
                          : "tabular-nums"
                      }
                    >
                      {fmtTokens(r.tokens)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Drilldown Detail Dialog */}
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="sm:max-w-[490px]">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle
                  className={
                    detail.monoTitle
                      ? "pr-7 font-mono text-[15px]"
                      : "pr-7 text-[15.5px]"
                  }
                >
                  {detail.title}
                </DialogTitle>
                <DialogDescription>{detail.subtitle}</DialogDescription>
              </DialogHeader>

              <div className="usage-dialog-metrics tabular-nums">
                {detail.kpis.map(([k, v]) => (
                  <div key={k}>
                    <div className="k">{k}</div>
                    <div className="v">{v}</div>
                  </div>
                ))}
              </div>

              <div className="usage-dialog-rows tabular-nums">
                {detail.rows.map(([k, v]) => (
                  <div key={k} className="usage-dialog-row">
                    <span className="k">{k}</span>
                    <span className="v">{v}</span>
                  </div>
                ))}
              </div>

              <DialogFooter>
                {detail.openChat && onOpenChat && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const target = detail.openChat!;
                      setDetail(null);
                      onOpenChat(target.chatId, target.agentId, target.title);
                    }}
                  >
                    {t("usage.modalOpenChat")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDetail(null)}
                >
                  {t("common.close")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
