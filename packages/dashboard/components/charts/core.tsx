"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

/** Categorical slot `i` (0-based), in the palette's fixed order. */
export const seriesColor = (i: number) => `var(--chart-${i + 1})`;
export const OTHER_COLOR = "var(--chart-other)";

/**
 * The element's content width, kept current with a ResizeObserver, so an SVG can draw at
 * its real size (viewBox = measured width) instead of scaling text. `fallback` is the width
 * of the first, server-rendered frame.
 */
export function useMeasuredWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The mark (or day) the reader is on, from the pointer or the keyboard: both give the same
 * readout. Arrow keys step, Home and End jump; focusing starts on `start` (the latest value).
 */
export function useActiveIndex(count: number, start = count - 1) {
  const [active, setActive] = useState<number | null>(null);
  const focused = useRef(false);
  const clamp = (i: number) => Math.min(Math.max(i, 0), count - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    const next: Record<string, number> = {
      ArrowRight: (active ?? start) + 1,
      ArrowDown: (active ?? start) + 1,
      ArrowLeft: (active ?? start) - 1,
      ArrowUp: (active ?? start) - 1,
      Home: 0,
      End: count - 1,
    };
    if (e.key === "Escape") return setActive(null);
    if (!(e.key in next)) return;
    e.preventDefault();
    setActive(clamp(next[e.key]!));
  };
  return {
    active,
    point: useCallback((i: number | null) => setActive(i), []),
    bind: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => {
        focused.current = true;
        setActive((a) => a ?? clamp(start));
      },
      onBlur: () => {
        focused.current = false;
        setActive(null);
      },
      onPointerLeave: () => {
        if (!focused.current) setActive(null);
      },
    },
  };
}

export interface TooltipRow {
  color: string;
  value: string;
  name?: string;
  /** Key the row with a short line (lines, areas) or a small block (bars, parts). */
  key?: "line" | "block";
}

const TOOLTIP_WIDTH = 176;

/**
 * The readout box: value first and strong, the series name after it, keyed by a mark of the
 * series color. Kept inside the chart's box (`x` is clamped to `bound`). Decorative for
 * assistive technology: each chart says the same in its live region and its table.
 */
export function ChartTooltip({
  x,
  bound,
  title,
  rows,
}: {
  x: number;
  bound: number;
  title: string;
  rows: TooltipRow[];
}) {
  const left = Math.min(Math.max(x - TOOLTIP_WIDTH / 2, 0), Math.max(bound - TOOLTIP_WIDTH, 0));
  return (
    <div
      aria-hidden="true"
      data-testid="chart-tooltip"
      className="border-border bg-surface shadow-overlay pointer-events-none absolute top-0 z-10 w-44 border px-3 py-2"
      style={{ left }}
    >
      <p className="text-text-muted text-ui-xs">{title}</p>
      <ul className="mt-1 space-y-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <svg width="12" height="8" aria-hidden="true" className="shrink-0">
              {r.key === "block" ? (
                <rect width="8" height="8" fill={r.color} />
              ) : (
                <line x1="0" y1="4" x2="12" y2="4" stroke={r.color} strokeWidth="2" />
              )}
            </svg>
            <span className="text-text text-ui-sm font-semibold">{r.value}</span>
            {r.name && (
              <span className="text-text-muted text-ui-xs min-w-0 truncate">{r.name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const TableView = createContext(false);
export const TableViewProvider = TableView.Provider;

/**
 * Every chart's table twin. Always in the page: visually hidden while the chart shows (screen
 * readers read it instead of the drawing), drawn in its place after "View as table".
 */
export function ChartTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: string[][];
}) {
  const visible = useContext(TableView);
  // The wrapper is what hides: `sr-only` on a <table> itself does not hold its width to 1 px.
  return (
    <div className={visible ? undefined : "sr-only"}>
      <table className="text-ui-sm w-full">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-border border-b">
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className={`text-text-muted text-ui-xs py-2 font-semibold ${i ? "pl-3 text-right" : "text-left"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-border-soft border-b last:border-b-0">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-2 text-left font-normal">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="py-2 pl-3 text-right tabular-nums">
                    {cell}
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Chart-only content (meters, a drawing in plain HTML): hidden while the card shows the table. */
export function ChartView({ children }: { children: React.ReactNode }) {
  return <div hidden={useContext(TableView)}>{children}</div>;
}

/** True while the card shows the table instead of the chart. */
export const useTableView = () => useContext(TableView);
