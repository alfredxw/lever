import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fmtAxisTokens,
  fmtAxisUsd,
  fmtMetricValue,
  formatSlotLabel,
} from "./format";

export interface ChartSeriesItem {
  id: string;
  name: string;
  color: string;
  total: number;
  values: number[];
}

interface Point {
  x: number;
  y: number;
}

function monotonePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }
  const n = points.length;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx);
  }
  const t = new Array<number>(n).fill(0);
  t[0] = slopes[0];
  t[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = slopes[i];
    if (s === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / s;
    const b = t[i + 1] / s;
    const m = a * a + b * b;
    if (m > 9) {
      const sc = 3 / Math.sqrt(m);
      t[i] = sc * a * s;
      t[i + 1] = sc * b * s;
    }
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = p1.x - p0.x;
    d += ` C ${(p0.x + dx / 3).toFixed(1)} ${(p0.y + (t[i] * dx) / 3).toFixed(1)}, ${(p1.x - dx / 3).toFixed(1)} ${(p1.y - (t[i + 1] * dx) / 3).toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

export function TrendChart({
  slots,
  resolution,
  series,
  metric,
  monoNames,
}: {
  slots: string[];
  resolution: "hour" | "day";
  series: ChartSeriesItem[];
  metric: "tokens" | "cost";
  monoNames?: boolean;
}) {
  const { t } = useTranslation();
  const uid = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 120) setWidth(next);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const labels = useMemo(
    () => slots.map((s) => formatSlotLabel(s, resolution)),
    [slots, resolution],
  );

  const height = 244;
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = Math.max(80, width - padL - padR);
  const plotH = height - padT - padB;

  const { yMax, sortedSeries } = useMemo(() => {
    const maxRaw = Math.max(
      metric === "cost" ? 0.04 : 4,
      ...series.flatMap((s) => s.values),
    );
    const rough = maxRaw / 4;
    const mag = 10 ** Math.floor(Math.log10(rough));
    const norm = rough / mag;
    const step = (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
    const computedMax = Math.max(step * 4, Math.ceil(maxRaw / step) * step);
    const ordered = [...series].sort((a, b) => b.total - a.total);
    return { yMax: computedMax, sortedSeries: ordered };
  }, [series, metric]);

  const xAt = (i: number) =>
    padL +
    (slots.length <= 1 ? plotW / 2 : (i / (slots.length - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - (Math.max(0, v) / yMax) * plotH;

  const labelStep = useMemo(() => {
    if (labels.length <= 8) return 1;
    const maxLabels = Math.max(4, Math.floor(plotW / 68));
    return Math.max(1, Math.ceil(labels.length / maxLabels));
  }, [labels.length, plotW]);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!slots.length || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (relX - padL) / plotW));
    const idx = Math.round(ratio * Math.max(0, slots.length - 1));
    setHoverIdx(idx);
  };

  const hoverX = hoverIdx !== null ? xAt(hoverIdx) : 0;
  const tooltipLeft = useMemo(() => {
    if (hoverIdx === null) return 0;
    const tipW = 208;
    return hoverX + 14 + tipW > width
      ? Math.max(8, hoverX - tipW - 14)
      : hoverX + 14;
  }, [hoverIdx, hoverX, width]);

  const hoverTotal =
    hoverIdx !== null
      ? sortedSeries.reduce((sum, s) => sum + (s.values[hoverIdx] ?? 0), 0)
      : 0;

  return (
    <div
      ref={wrapRef}
      className="usage-chart-wrap"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          {sortedSeries.map((s, idx) => (
            <linearGradient
              key={s.id}
              id={`usage-grad-${uid}-${idx}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={s.color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.01} />
            </linearGradient>
          ))}
        </defs>

        {/* Horizontal dashed grid & Y axis labels */}
        {[0, 1, 2, 3, 4].map((tick) => {
          const val = (yMax / 4) * tick;
          const y = yAt(val);
          return (
            <g key={tick}>
              <line
                className="usage-chart-grid-line"
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
              />
              <text
                className="usage-chart-axis-text tabular-nums"
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
              >
                {metric === "cost" ? fmtAxisUsd(val) : fmtAxisTokens(val)}
              </text>
            </g>
          );
        })}

        {/* X axis labels */}
        {labels.map((lbl, i) => {
          if (i % labelStep !== 0 && i !== labels.length - 1) return null;
          if (
            i !== labels.length - 1 &&
            labels.length - 1 - i < Math.ceil(labelStep * 0.5)
          ) {
            return null;
          }
          return (
            <text
              key={slots[i]}
              className="usage-chart-axis-text tabular-nums"
              x={xAt(i)}
              y={height - 6}
              textAnchor="middle"
            >
              {lbl}
            </text>
          );
        })}

        {/* Area fills & smooth monotone spline lines */}
        {sortedSeries.map((s, idx) => {
          if (!slots.length) return null;
          const pts = slots.map((_, i) => ({
            x: xAt(i),
            y: yAt(s.values[i] ?? 0),
          }));
          if (pts.length === 1) {
            return (
              <circle
                key={s.id}
                cx={pts[0].x}
                cy={pts[0].y}
                r={3.5}
                fill={s.color}
              />
            );
          }
          const lineD = monotonePath(pts);
          const areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
          return (
            <g key={s.id}>
              <path d={areaD} fill={`url(#usage-grad-${uid}-${idx})`} />
              <path
                d={lineD}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* Hover crosshair & focus dots */}
        {hoverIdx !== null && slots.length > 0 && (
          <g>
            <line
              x1={hoverX}
              y1={padT}
              x2={hoverX}
              y2={padT + plotH}
              stroke="var(--usage-border-strong)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {sortedSeries.map((s) => (
              <circle
                key={s.id}
                cx={hoverX}
                cy={yAt(s.values[hoverIdx] ?? 0)}
                r={3.5}
                fill={s.color}
                stroke="var(--background)"
                strokeWidth={1.5}
              />
            ))}
          </g>
        )}
      </svg>

      {/* Frosted glass floating tooltip */}
      {hoverIdx !== null && slots[hoverIdx] && sortedSeries.length > 0 && (
        <div
          className="usage-chart-tooltip tabular-nums"
          style={{ left: tooltipLeft, top: 14 }}
        >
          <div className="usage-chart-tooltip-date">
            {resolution === "hour"
              ? `${slots[hoverIdx].slice(5, 10).replace("-", "/")} ${labels[hoverIdx]}`
              : labels[hoverIdx]}
          </div>
          {sortedSeries.map((s) => (
            <div key={s.id} className="usage-chart-tooltip-row">
              <span className="usage-chart-tooltip-label">
                <span
                  className="usage-series-dot"
                  style={{ backgroundColor: s.color }}
                />
                <span
                  className={
                    monoNames
                      ? "usage-chart-tooltip-label-txt font-mono text-[11px]"
                      : "usage-chart-tooltip-label-txt"
                  }
                >
                  {s.name}
                </span>
              </span>
              <span>{fmtMetricValue(s.values[hoverIdx] ?? 0, metric)}</span>
            </div>
          ))}
          {sortedSeries.length > 1 && (
            <div className="usage-chart-tooltip-total">
              <span>{t("usage.chartTotal")}</span>
              <span>{fmtMetricValue(hoverTotal, metric)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
