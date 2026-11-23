import { formatDate, type Locale } from "@/lib/i18n/core";

/** What a value is: a count, a duration in ms, or a share in 0..1. */
export type ValueFormat = "count" | "ms" | "percent";

/** One number for a reader: compact from 10,000 when `compact` (12.9K), ms and % in the locale. */
export function formatValue(
  locale: Locale,
  value: number,
  format: ValueFormat,
  compact = false
): string {
  if (format === "percent")
    return new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: value > 0 && value < 0.1 ? 1 : 0,
    }).format(value);
  const opts: Intl.NumberFormatOptions =
    compact && Math.abs(value) >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {};
  if (format === "ms")
    return new Intl.NumberFormat(locale, {
      ...opts,
      style: "unit",
      unit: "millisecond",
      unitDisplay: "short",
    }).format(Math.round(value));
  return new Intl.NumberFormat(locale, opts).format(value);
}

/** A `YYYY-MM-DD` UTC day as the reader's short date ("Nov 17", "17 nov"). */
export const formatDay = (locale: Locale, day: string) =>
  formatDate(locale, `${day}T00:00:00Z`, "day");

/**
 * Clean ticks from 0 to at least `max`: 1, 2 or 5 times a power of ten, about `count` steps.
 * Counts and milliseconds step by whole units; a share never passes 100 %.
 */
export function niceTicks(max: number, format: ValueFormat, count = 3): number[] {
  const top = format === "percent" ? Math.min(Math.max(max, 0.01), 1) : Math.max(max, 1);
  const raw = top / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  if (format !== "percent") step = Math.max(1, Math.round(step));
  const n = Math.ceil(top / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toFixed(6)));
}
