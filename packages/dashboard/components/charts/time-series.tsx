"use client";

import { useId, useRef, type PointerEvent } from "react";

import { HatchPattern } from "@/components/hatch";

import { useLocale, useT } from "@/lib/i18n/client";

import {
  ChartTable,
  ChartTooltip,
  seriesColor,
  useActiveIndex,
  useMeasuredWidth,
  useTableView,
} from "./core";
import { formatDay, formatValue, niceTicks, type ValueFormat } from "./format";

export interface Series {
  name: string;
  /** One value per day; null where there is nothing to measure (not zero). */
  values: Array<number | null>;
}

const BAR_MAX = 24;
// px between x-axis label centers: a label is at most 48 px wide, so even the last one, pushed to
// end at the right edge, keeps clear of the one before it.
const LABEL_GAP = 72;
const LABEL_HALF = 24;
const PAD = { top: 8, right: 8, bottom: 24 };

/** Day indices that get an x-axis label: the last one (today) and back from it, `step` apart. */
export function labelIndices(n: number, band: number): number[] {
  const step = Math.max(1, Math.ceil(LABEL_GAP / band));
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) out.push(i);
  return out;
}

/**
 * Values per UTC day on one axis: columns for counts, areas (a 2 px line over a hatched wash)
 * for rates and latency. Marks are square and engraved: columns are hatched in the series
 * color, today's and the one being read are solid. Up to five series, in palette order, with a legend from two. The date axis
 * is in the reader's locale and the last day is today. The pointer and the arrow keys give the
 * same readout; the table twin carries every value. `minDays`: say so when fewer days than
 * that have data.
 */
export function TimeSeries({
  label,
  days,
  series,
  kind,
  format,
  minDays,
  height = 176,
}: {
  label: string;
  days: string[];
  series: Series[];
  kind: "columns" | "area";
  format: ValueFormat;
  minDays?: number;
  height?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const table = useTableView();
  const [box, width] = useMeasuredWidth<HTMLDivElement>();
  const svg = useRef<SVGSVGElement>(null);
  const uid = useId();
  const n = days.length;
  const { active, point, bind } = useActiveIndex(n);

  const fmt = (v: number) => formatValue(locale, v, format);
  const dayName = (i: number) => (i === n - 1 ? t("charts.today") : formatDay(locale, days[i]!));
  const dayLong = (i: number) =>
    i === n - 1
      ? `${t("charts.today")} · ${formatDay(locale, days[i]!)}`
      : formatDay(locale, days[i]!);

  const numbers = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const ticks = niceTicks(Math.max(0, ...numbers), format);
  const top = ticks[ticks.length - 1]!;
  const tick = (v: number) => formatValue(locale, v, format, true);
  const left = Math.ceil(Math.max(...ticks.map((v) => tick(v).length)) * 6.5) + 10;
  const plotW = Math.max(width - left - PAD.right, 1);
  const plotH = height - PAD.top - PAD.bottom;
  const band = plotW / Math.max(n, 1);
  const base = PAD.top + plotH;
  const x = (i: number) => left + band * (i + 0.5);
  const y = (v: number) => PAD.top + plotH * (1 - v / top);

  const onPointerMove = (e: PointerEvent) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const px = ((e.clientX - r.left) * width) / r.width;
    point(Math.min(Math.max(Math.floor((px - left) / band), 0), n - 1));
  };

  const withData = days.filter((_, i) => series.some((s) => (s.values[i] ?? 0) > 0)).length;
  const readout =
    active == null
      ? ""
      : `${dayLong(active)}: ${series
          .map((s) => {
            const v = s.values[active];
            return `${s.name} ${v == null ? t("charts.noData") : fmt(v)}`;
          })
          .join(", ")}`;

  return (
    <div className="min-w-0">
      {series.length > 1 && !table && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-hidden="true">
          {series.map((s, i) => (
            <li key={s.name} className="text-text-muted text-ui-xs flex items-center gap-2">
              <svg width="12" height="8" className="shrink-0">
                <line x1="0" y1="4" x2="12" y2="4" stroke={seriesColor(i)} strokeWidth="2" />
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div ref={box} className="relative" hidden={table}>
        <div
          role="img"
          aria-label={`${label}. ${t("charts.keys")}`}
          className="focus-visible:outline-accent outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
          {...bind}
        >
          <svg
            ref={svg}
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="block"
            onPointerMove={onPointerMove}
          >
            {ticks.map((v) => (
              <g key={v}>
                <line
                  x1={left}
                  x2={left + plotW}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={v === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                <text
                  x={left - 6}
                  y={y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-text-faint text-ui-2xs tabular-nums"
                >
                  {tick(v)}
                </text>
              </g>
            ))}

            <defs>
              {series.map((s, si) =>
                kind === "columns" ? (
                  <HatchPattern key={si} id={`${uid}-${si}`} color={seriesColor(si)} />
                ) : (
                  <HatchPattern
                    key={si}
                    id={`${uid}-${si}`}
                    color={seriesColor(si)}
                    gap={6}
                    width={1}
                  />
                )
              )}
            </defs>

            {kind === "columns"
              ? series[0]?.values.map((v, i) => {
                  const w = Math.min(BAR_MAX, Math.max(1, band * 0.7));
                  return v ? (
                    <rect
                      key={i}
                      x={x(i) - w / 2}
                      y={y(v)}
                      width={w}
                      height={base - y(v)}
                      fill={i === n - 1 || i === active ? seriesColor(0) : `url(#${uid}-0)`}
                      shapeRendering="crispEdges"
                    />
                  ) : null;
                })
              : series.map((s, si) => (
                  <Area
                    key={s.name}
                    values={s.values}
                    color={seriesColor(si)}
                    wash={`url(#${uid}-${si})`}
                    x={x}
                    y={y}
                    base={base}
                  />
                ))}

            {kind === "area" && active != null && (
              <g>
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={PAD.top}
                  y2={base}
                  stroke="var(--color-text-faint)"
                  strokeWidth="1"
                />
                {series.map((s, si) => {
                  const v = s.values[active];
                  return v == null ? null : (
                    <Marker key={s.name} cx={x(active)} cy={y(v)} color={seriesColor(si)} />
                  );
                })}
              </g>
            )}

            {labelIndices(n, band).map((i) => {
              if (x(i) - LABEL_HALF < 0) return null;
              // A label that would run past the right edge ends at it instead of centering.
              const atEdge = x(i) + LABEL_HALF > width;
              return (
                <text
                  key={i}
                  x={atEdge ? width - 1 : x(i)}
                  y={height - 6}
                  textAnchor={atEdge ? "end" : "middle"}
                  className={`text-ui-2xs ${i === n - 1 ? "fill-text font-semibold" : "fill-text-faint"}`}
                >
                  {dayName(i)}
                </text>
              );
            })}
          </svg>
          {active != null && (
            <ChartTooltip
              x={x(active)}
              bound={width}
              title={dayLong(active)}
              rows={series.map((s, si) => {
                const v = s.values[active];
                return {
                  color: seriesColor(si),
                  value: v == null ? t("charts.noData") : fmt(v),
                  name: s.name,
                  key: kind === "columns" ? "block" : "line",
                };
              })}
            />
          )}
        </div>
        <p className="sr-only" aria-live="polite">
          {readout}
        </p>
      </div>
      {minDays != null && withData < minDays && (
        <p className="text-text-faint text-ui-xs mt-2">
          {t("charts.fewDays", { count: withData, total: n })}
        </p>
      )}
      <ChartTable
        caption={label}
        head={[t("charts.day"), ...series.map((s) => s.name)]}
        rows={days.map((_, i) => [
          dayLong(i),
          ...series.map((s) => {
            const v = s.values[i];
            return v == null ? t("charts.noData") : fmt(v);
          }),
        ])}
      />
    </div>
  );
}

/** An 8 px square marker with a 2 px surface ring. */
function Marker({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return (
    <rect
      x={cx - 4}
      y={cy - 4}
      width="8"
      height="8"
      fill={color}
      stroke="var(--color-surface)"
      strokeWidth="2"
    />
  );
}

/** One series as a 2 px line over a hatched wash, broken where a day has no value; the last point is marked. */
function Area({
  values,
  color,
  wash,
  x,
  y,
  base,
}: {
  values: Array<number | null>;
  color: string;
  wash: string;
  x: (i: number) => number;
  y: (v: number) => number;
  base: number;
}) {
  const runs: number[][] = [];
  values.forEach((v, i) => {
    if (v == null) return;
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === i - 1) run.push(i);
    else runs.push([i]);
  });
  const last = runs.at(-1)?.at(-1);
  return (
    <g>
      {runs.map((run) => {
        const pts = run.map((i) => `${x(i)},${y(values[i]!)}`);
        return (
          <g key={run[0]}>
            {run.length > 1 && (
              <>
                <path
                  d={`M${x(run[0]!)},${base}L${pts.join("L")}L${x(run.at(-1)!)},${base}Z`}
                  fill={wash}
                  opacity="0.6"
                  data-wash=""
                />
                <path
                  d={`M${pts.join("L")}`}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinejoin="miter"
                  strokeLinecap="square"
                />
              </>
            )}
            {(run.length === 1 || run.at(-1) === last) && (
              <Marker cx={x(run.at(-1)!)} cy={y(values[run.at(-1)!]!)} color={color} />
            )}
          </g>
        );
      })}
    </g>
  );
}
