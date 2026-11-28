import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocalStatsHourCell } from "@/api/types.gen";
import { fmtTokens, fmtUsd } from "./format";

interface ComputedCell {
  idx: number;
  day: string;
  dayLabel: string;
  hour: number;
  future: boolean;
  tokens: number;
  costUsd: number;
  level: number;
  topModel: string;
}

function formatDayLabel(dayIso: string, isToday: boolean, locale: string, todayLabel: string): string {
  if (isToday) return todayLabel;
  const parts = dayIso.split("-");
  if (parts.length !== 3) return dayIso;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  // Keep compact labels like "11/21 六" in zh or "11/21 Sat" in en
  const shortWd = weekday.replace(/^周/, "").replace(/^星期/, "");
  return `${parts[1]}/${parts[2]} ${shortWd}`;
}

function computePeakHint(cells: ComputedCell[]): string {
  const byHour = new Array<number>(24).fill(0);
  let total = 0;
  for (const c of cells) {
    if (!c.future && c.tokens > 0) {
      byHour[c.hour] += c.tokens;
      total += c.tokens;
    }
  }
  if (total === 0) return "";
  // Pick top 2 non-adjacent 2-hour windows
  const windows: Array<{ start: number; sum: number }> = [];
  for (let h = 0; h < 24; h++) {
    const sum = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
    windows.push({ start: h, sum });
  }
  windows.sort((a, b) => b.sum - a.sum);
  const picked: number[] = [];
  for (const w of windows) {
    if (w.sum <= 0) break;
    if (picked.every((p) => Math.abs(p - w.start) >= 4 && Math.abs(p - w.start) <= 20)) {
      picked.push(w.start);
      if (picked.length === 2) break;
    }
  }
  picked.sort((a, b) => a - b);
  return picked
    .map((h) => `${String(h).padStart(2, "0")}:00–${String((h + 3) % 24).padStart(2, "0")}:00`)
    .join(" / ");
}

export function HourlyHeatmap({
  hourly,
  timeZone,
  groupBy,
  focusId,
  focusName,
}: {
  hourly: LocalStatsHourCell[];
  timeZone: string;
  groupBy: "provider" | "model";
  focusId: string | null;
  focusName?: string;
}) {
  const { t, i18n } = useTranslation();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [lockedIdx, setLockedIdx] = useState<number | null>(null);

  const { days, cells, peakSummary } = useMemo(() => {
    const dayKeys: string[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = hourly[d * 24];
      dayKeys.push(cell?.day ?? "");
    }
    const dayLabels = dayKeys.map((day, idx) =>
      formatDayLabel(day, idx === 6, i18n.language, t("usage.hourlyToday")),
    );

    const rawValues = hourly.map((cell) => {
      if (cell.future) return { tokens: 0, cost: 0 };
      if (!focusId) return { tokens: cell.tokens, cost: cell.costUsd };
      if (groupBy === "provider") {
        const tok = cell.byProvider?.[focusId] ?? 0;
        const cost = cell.byProviderCost?.[focusId] ?? 0;
        return { tokens: tok, cost };
      }
      const tok = cell.byModel?.[focusId] ?? 0;
      const cost = cell.byModelCost?.[focusId] ?? 0;
      return { tokens: tok, cost };
    });

    const maxTok = Math.max(1, ...rawValues.map((v) => v.tokens));
    const computed: ComputedCell[] = hourly.map((cell, idx) => {
      const dIdx = Math.floor(idx / 24);
      const { tokens, cost } = rawValues[idx];
      let level = 0;
      if (cell.future) {
        level = -1;
      } else if (tokens > 0) {
        const ratio = tokens / maxTok;
        level = ratio < 0.2 ? 1 : ratio < 0.45 ? 2 : ratio < 0.72 ? 3 : 4;
      }
      const topModel =
        focusId && groupBy === "model" && focusName
          ? focusName
          : cell.topModel ?? "";
      return {
        idx,
        day: cell.day,
        dayLabel: dayLabels[dIdx] ?? cell.day,
        hour: cell.hour,
        future: !!cell.future,
        tokens,
        costUsd: cost,
        level,
        topModel,
      };
    });

    return {
      days: dayLabels,
      cells: computed,
      peakSummary: computePeakHint(computed),
    };
  }, [hourly, focusId, groupBy, focusName, i18n.language, t]);

  const activeIdx = hoveredIdx !== null ? hoveredIdx : lockedIdx;
  const activeCell = activeIdx !== null ? cells[activeIdx] : undefined;
  const isShowingLocked = hoveredIdx === null && lockedIdx !== null && !!activeCell;

  const h1 = activeCell ? `${String(activeCell.hour).padStart(2, "0")}:00` : "";
  const h2 = activeCell
    ? `${String((activeCell.hour + 1) % 24).padStart(2, "0")}:00`
    : "";

  return (
    <section className="usage-hourly-section">
      <div className="usage-hourly-head">
        <div>
          <h3 className="usage-section-title">{t("usage.hourlyHeading")}</h3>
          <div className="usage-hourly-readout tabular-nums">
            {activeCell && !activeCell.future ? (
              activeCell.tokens === 0 ? (
                <>
                  <strong>
                    {activeCell.dayLabel} {h1}–{h2}
                  </strong>
                  {" · "}
                  {t("usage.hourlyNoActivity")}
                  {isShowingLocked && (
                    <span className="ml-1.5 opacity-75">
                      {t("usage.hourlyLocked")}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <strong>
                    {activeCell.dayLabel} {h1}–{h2}
                  </strong>
                  {" · "}
                  <strong>{fmtTokens(activeCell.tokens)} tokens</strong>
                  {" · "}
                  {fmtUsd(activeCell.costUsd)}
                  {activeCell.topModel && (
                    <>
                      {" · "}
                      <span className="font-mono">{activeCell.topModel}</span>
                    </>
                  )}
                  {isShowingLocked && (
                    <span className="ml-1.5 opacity-75">
                      {t("usage.hourlyLocked")}
                    </span>
                  )}
                </>
              )
            ) : peakSummary ? (
              t("usage.hourlyPeakHint", { peaks: peakSummary })
            ) : (
              t("usage.hourlyDefaultHint")
            )}
          </div>
        </div>
        <div className="usage-hourly-right-meta">
          <div className="usage-heat-legend">
            <span>{t("usage.hourlyLess")}</span>
            <i style={{ backgroundColor: "var(--usage-heat-0)" }} />
            <i style={{ backgroundColor: "var(--usage-heat-1)" }} />
            <i style={{ backgroundColor: "var(--usage-heat-2)" }} />
            <i style={{ backgroundColor: "var(--usage-heat-3)" }} />
            <i style={{ backgroundColor: "var(--usage-heat-4)" }} />
            <span>{t("usage.hourlyMore")}</span>
          </div>
          {timeZone && (
            <span className="tabular-nums">
              {t("usage.hourlyTimezone", { tz: timeZone })}
            </span>
          )}
        </div>
      </div>

      <div className="panel-surface usage-hourly-card">
        <div className="usage-hour-matrix-wrap">
          <div className="usage-hour-day-labels">
            {days.map((label, i) => (
              <span key={i} className={i === 6 ? "today-lbl" : undefined}>
                {label}
              </span>
            ))}
          </div>

          <div
            className="usage-hour-grid"
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {cells.map((c) => (
              <button
                key={c.idx}
                type="button"
                className={
                  lockedIdx === c.idx
                    ? "usage-hour-cell locked"
                    : "usage-hour-cell"
                }
                data-level={c.level}
                disabled={c.future}
                tabIndex={c.future ? -1 : 0}
                aria-label={`${c.dayLabel} ${String(c.hour).padStart(2, "0")}:00`}
                onMouseEnter={() => {
                  if (!c.future) setHoveredIdx(c.idx);
                }}
                onFocus={() => {
                  if (!c.future) setHoveredIdx(c.idx);
                }}
                onBlur={() => setHoveredIdx(null)}
                onClick={() => {
                  if (c.future) return;
                  setLockedIdx((prev) => (prev === c.idx ? null : c.idx));
                }}
              />
            ))}
          </div>

          <div className="usage-hour-axis tabular-nums" aria-hidden="true">
            <span style={{ gridColumn: "1 / span 4" }}>00:00</span>
            <span style={{ gridColumn: "7 / span 4" }}>06:00</span>
            <span style={{ gridColumn: "13 / span 4" }}>12:00</span>
            <span style={{ gridColumn: "19 / span 4" }}>18:00</span>
            <span style={{ gridColumn: "23 / span 2", textAlign: "right" }}>
              23h
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
