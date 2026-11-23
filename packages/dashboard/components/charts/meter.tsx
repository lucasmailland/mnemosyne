"use client";

import { useLocale, useT } from "@/lib/i18n/client";

import { seriesColor } from "./core";
import { formatValue, type ValueFormat } from "./format";

/**
 * A ratio against a target, as an 8 px square bar on a track of the same (lighter) ramp, its
 * fill engraved with the hatch. The fill
 * turns to the warning color from 90 % and to the danger color past 100 %, and the state is
 * said in words beside it, never by color alone. `limit={false}` is a share with no limit to
 * reach (a hit rate): no severity. `bare` drops the label row (a stat tile already names it).
 */
export function Meter({
  label,
  value,
  max,
  format = "count",
  limit = true,
  bare = false,
}: {
  label: string;
  value: number;
  max: number;
  format?: ValueFormat;
  limit?: boolean;
  bare?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const share = max > 0 ? value / max : 0;
  const state = !limit ? "ok" : share > 1 ? "over" : share >= 0.9 ? "near" : "ok";
  const fill =
    state === "over"
      ? "var(--color-red)"
      : state === "near"
        ? "var(--color-yellow)"
        : seriesColor(0);
  const used =
    format === "percent" && max === 1
      ? formatValue(locale, value, "percent")
      : t("charts.ofLimit", {
          used: formatValue(locale, value, format, true),
          limit: formatValue(locale, max, format, true),
        });
  const status =
    state === "over" ? t("charts.overLimit") : state === "near" ? t("charts.nearLimit") : "";
  return (
    <div className="min-w-0">
      {!bare && (
        <div className="text-ui-sm mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-text">{label}</span>
          <span className="text-text-muted text-ui-xs">
            {used}
            {status && <strong className="text-text ml-2 font-semibold">{status}</strong>}
          </span>
        </div>
      )}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={status ? `${used}, ${status}` : used}
        className="h-2 overflow-hidden"
        style={{ background: "var(--chart-track)" }}
      >
        <div
          className="hatch h-full"
          style={{ width: `${Math.min(share, 1) * 100}%`, "--hatch": fill } as React.CSSProperties}
        />
      </div>
    </div>
  );
}
