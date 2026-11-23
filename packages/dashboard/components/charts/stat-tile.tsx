"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { InfoTip } from "@/components/ui/info-tip";
import { useLocale, useT } from "@/lib/i18n/client";

import { OTHER_COLOR, seriesColor, useMeasuredWidth } from "./core";
import { formatValue, type ValueFormat } from "./format";
import { Meter } from "./meter";

const SPARK_H = 32;

/**
 * A trend inside a tile: one series as a 2 px line in the de-emphasis hue, the latest value
 * marked with a square in the accent. Drawn at its measured width so the line and the dot keep their size.
 */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>(160);
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const pad = 5;
  const x = (i: number) => pad + ((width - 2 * pad) * i) / (values.length - 1);
  const y = (v: number) => pad + (SPARK_H - 2 * pad) * (1 - v / max);
  const last = values.length - 1;
  return (
    <div ref={box} className="mt-2">
      <svg
        role="img"
        aria-label={label}
        width="100%"
        height={SPARK_H}
        viewBox={`0 0 ${width} ${SPARK_H}`}
        className="block"
      >
        <path
          d={`M${values.map((v, i) => `${x(i)},${y(v)}`).join("L")}`}
          fill="none"
          stroke={OTHER_COLOR}
          strokeWidth="2"
          strokeLinejoin="miter"
          strokeLinecap="square"
        />
        <rect
          x={x(last) - 4}
          y={y(values[last]!) - 4}
          width="8"
          height="8"
          fill={seriesColor(0)}
          stroke="var(--color-surface)"
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}

/**
 * One figure: label, value (Inter semibold, proportional figures, compact from 10,000), an
 * optional caption, sparkline or meter, and a one-line definition behind the info button.
 * A null value reads "—" and says "No data" to assistive technology.
 */
export function StatTile({
  label,
  definition,
  value,
  format = "count",
  display,
  caption,
  href,
  spark,
  sparkLabel,
  meter,
}: {
  label: string;
  definition: string;
  value: number | null;
  format?: ValueFormat;
  /** Overrides the formatted value (e.g. "36 / 140 ms"). */
  display?: string;
  caption?: ReactNode;
  href?: string;
  spark?: number[];
  sparkLabel?: string;
  /** A share in 0..1 drawn as a meter under the value. */
  meter?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const text = display ?? (value == null ? null : formatValue(locale, value, format, true));
  const figure =
    text == null ? (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("charts.noData")}</span>
      </>
    ) : (
      text
    );
  return (
    <div data-testid="stat-tile" className="flex min-w-0 flex-col">
      <div className="flex min-h-8 items-start justify-between gap-2">
        <p className="eyebrow min-w-0 break-words">{label}</p>
        <InfoTip label={label} text={definition} />
      </div>
      <p
        data-testid="stat-value"
        className="text-text text-display-5 mt-2 font-sans leading-tight font-semibold break-words"
      >
        {href && text != null ? (
          <Link href={href} className="echo">
            {figure}
          </Link>
        ) : (
          figure
        )}
      </p>
      {meter != null && (
        <div className="mt-2">
          <Meter value={meter} max={1} format="percent" limit={false} label={label} bare />
        </div>
      )}
      {spark && <Sparkline values={spark} label={sparkLabel ?? label} />}
      {caption && <p className="text-text-muted text-ui-xs mt-1 leading-snug">{caption}</p>}
    </div>
  );
}
