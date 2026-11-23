"use client";

import Link from "next/link";
import { useState } from "react";

import { useLocale, useT } from "@/lib/i18n/client";

import { ChartTable, ChartTooltip, seriesColor, useMeasuredWidth, useTableView } from "./core";
import { formatValue, type ValueFormat } from "./format";

export interface BarItem {
  name: string;
  value: number;
  href?: string;
}

/** Room kept at a bar's tip for its value. */
const VALUE_ROOM = "4.5rem";

/**
 * Ranked horizontal bars (top N, largest first): the name above, a 12 px square bar engraved
 * with the hatch (solid while it is the one being read), and the value at the tip. A row with `href` is a link. Hover
 * and keyboard focus show the value and its share of the list.
 */
export function BarList({
  label,
  items,
  format = "count",
}: {
  label: string;
  items: BarItem[];
  format?: ValueFormat;
}) {
  const t = useT();
  const locale = useLocale();
  const table = useTableView();
  const [box, width] = useMeasuredWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...items.map((i) => i.value), 1);
  const total = items.reduce((n, i) => n + i.value, 0);
  const amount = (v: number) => formatValue(locale, v, format);
  const share = (v: number) => formatValue(locale, total ? v / total : 0, "percent");

  return (
    <div className="min-w-0">
      <div ref={box} className="relative" hidden={table}>
        <ol className="space-y-3" onPointerLeave={() => setActive(null)}>
          {items.map((item, i) => {
            const name = item.href ? (
              <Link
                href={item.href}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="text-text hover:text-accent underline-offset-4 hover:underline"
              >
                {item.name}
              </Link>
            ) : (
              <span className="text-text">{item.name}</span>
            );
            return (
              <li key={i} className="relative" onPointerEnter={() => setActive(i)}>
                <p className="text-ui-sm min-w-0 truncate">{name}</p>
                <div className="mt-1 flex items-center gap-2">
                  <div
                    className={active === i ? "h-3" : "hatch h-3"}
                    style={
                      {
                        width: `calc((100% - ${VALUE_ROOM}) * ${item.value / max})`,
                        minWidth: item.value > 0 ? 2 : 0,
                        "--hatch": seriesColor(0),
                        background: active === i ? seriesColor(0) : undefined,
                      } as React.CSSProperties
                    }
                  />
                  <span className="text-text-muted text-ui-xs shrink-0 tabular-nums">
                    {amount(item.value)}
                  </span>
                </div>
                {active === i && (
                  <div className="relative h-0">
                    <ChartTooltip
                      x={(width - 72) * (item.value / max)}
                      bound={width}
                      title={item.name}
                      rows={[
                        {
                          color: seriesColor(0),
                          value: amount(item.value),
                          name: share(item.value),
                          key: "block",
                        },
                      ]}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <ChartTable
        caption={label}
        head={[t("charts.name"), t("charts.value"), t("charts.share")]}
        rows={items.map((i) => [i.name, amount(i.value), share(i.value)])}
      />
    </div>
  );
}
