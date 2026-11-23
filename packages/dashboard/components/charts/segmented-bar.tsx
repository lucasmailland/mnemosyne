"use client";

import { useId } from "react";

import { HatchPattern } from "@/components/hatch";
import { useLocale, useT } from "@/lib/i18n/client";

import {
  ChartTable,
  ChartTooltip,
  OTHER_COLOR,
  seriesColor,
  useActiveIndex,
  useMeasuredWidth,
  useTableView,
} from "./core";
import { formatValue, type ValueFormat } from "./format";

export interface Part {
  name: string;
  value: number;
}

const SLOTS = 5;
const BAR_H = 8;
const GAP = 2;

/** At most five parts: past that, the first four keep their slots and the rest fold into "other". */
export function foldParts(parts: Part[], otherName: string): Part[] {
  const kept = parts.filter((p) => p.value > 0);
  if (kept.length <= SLOTS) return kept;
  const rest = kept.slice(SLOTS - 1).reduce((n, p) => n + p.value, 0);
  return [...kept.slice(0, SLOTS - 1), { name: otherName, value: rest }];
}

/**
 * One whole split into parts: a thin 8 px square bar, each part as wide as its share and
 * engraved with the hatch in its color (solid while it is the one being read), 2 px of surface
 * between parts, a legend with every name, amount and share, in block order. Hover or the arrow
 * keys read one part; the accessible name lists them all.
 */
export function SegmentedBar({
  label,
  parts: input,
  format = "count",
}: {
  label: string;
  parts: Part[];
  format?: ValueFormat;
}) {
  const t = useT();
  const locale = useLocale();
  const table = useTableView();
  const [box, width] = useMeasuredWidth<HTMLDivElement>();
  const uid = useId();
  const otherName = t("charts.other");
  const parts = foldParts(input, otherName);
  const { active, point, bind } = useActiveIndex(parts.length, 0);
  const total = parts.reduce((n, p) => n + p.value, 0);
  const color = (i: number) =>
    input.filter((p) => p.value > 0).length > SLOTS && i === parts.length - 1
      ? OTHER_COLOR
      : seriesColor(i);
  const pct = (v: number) => formatValue(locale, total ? v / total : 0, "percent");
  const amount = (v: number) => formatValue(locale, v, format);
  const say = (p: Part) => `${p.name} ${amount(p.value)} (${pct(p.value)})`;

  // Widths: each part's share of what is left after the gaps, never under 2 px.
  const room = Math.max(width - GAP * (parts.length - 1), parts.length * 2);
  let at = 0;
  const blocks = parts.map((p) => {
    const w = Math.max(2, (room * p.value) / (total || 1));
    const block = { x: at, w };
    at += w + GAP;
    return block;
  });

  return (
    <div className="min-w-0">
      <div ref={box} className="relative" hidden={table}>
        <div
          role="img"
          aria-label={`${label}: ${parts.map(say).join(", ")}. ${t("charts.keys")}`}
          className="focus-visible:outline-accent py-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
          {...bind}
        >
          <svg width="100%" height={BAR_H} viewBox={`0 0 ${width} ${BAR_H}`} className="block">
            <defs>
              {parts.map((_, i) => (
                <HatchPattern key={i} id={`${uid}-${i}`} color={color(i)} />
              ))}
            </defs>
            {blocks.map((b, i) => (
              <rect
                key={i}
                x={b.x}
                y="0"
                width={b.w}
                height={BAR_H}
                fill={active === i ? color(i) : `url(#${uid}-${i})`}
                onPointerEnter={() => point(i)}
              />
            ))}
          </svg>
          {active != null && parts[active] && (
            <div className="relative mt-2 h-0">
              <ChartTooltip
                x={blocks[active]!.x + blocks[active]!.w / 2}
                bound={width}
                title={parts[active]!.name}
                rows={[
                  {
                    color: color(active),
                    value: amount(parts[active]!.value),
                    name: pct(parts[active]!.value),
                    key: "block",
                  },
                ]}
              />
            </div>
          )}
        </div>
        <p className="sr-only" aria-live="polite">
          {active != null && parts[active] ? say(parts[active]!) : ""}
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-hidden="true">
          {parts.map((p, i) => (
            <li key={p.name} className="text-ui-xs flex items-center gap-2">
              <svg width="10" height="10" className="shrink-0">
                <rect width="10" height="10" fill={`url(#${uid}-${i})`} />
              </svg>
              <span className="text-text">{p.name}</span>
              <span className="text-text-muted">
                {amount(p.value)} · {pct(p.value)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <ChartTable
        caption={label}
        head={[t("charts.name"), t("charts.value"), t("charts.share")]}
        // Every part, the folded ones too: the table is where the tail stays readable.
        rows={input.filter((p) => p.value > 0).map((p) => [p.name, amount(p.value), pct(p.value)])}
      />
    </div>
  );
}
