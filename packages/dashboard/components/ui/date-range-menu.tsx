"use client";

import { useEffect, useId, useRef, useState } from "react";

import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate } from "@/lib/i18n/core";

import { Chevron, popButton, usePopover } from "./popover";

const SHORTCUTS = [7, 30, 90];
const field =
  "border-control-border bg-surface-2 text-ui-sm min-h-10 w-full border px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The UTC day `days - 1` days before today, so "last 7 days" is today and the six before it. */
const daysAgo = (days: number) =>
  new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

/**
 * A date range behind one button ("Dates: any", "Dates: Nov 1 – Nov 17"): From and To day fields
 * named `fromName` and `toName` (so a GET form carries them), shortcuts for the last 7, 30 and
 * 90 days, Clear, and Apply, which submits the form around it. A shortcut or Clear submits at once.
 */
export function DateRangeMenu({
  from: initialFrom = "",
  to: initialTo = "",
  fromName = "from",
  toName = "to",
}: {
  from?: string;
  to?: string;
  fromName?: string;
  toName?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const pop = usePopover();
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    pop.panel.current?.closest("form")?.requestSubmit();
  });
  const set = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    pending.current = true;
    pop.close();
  };

  const day = (d: string) => formatDate(locale, d, "day");
  const summary =
    from && to
      ? `${day(from)} – ${day(to)}`
      : from
        ? t("ui.sinceDay", { date: day(from) })
        : to
          ? t("ui.untilDay", { date: day(to) })
          : t("ui.anyDate");
  const active = !!(from || to);

  return (
    <>
      <button
        {...pop.buttonProps}
        aria-haspopup="dialog"
        className={`${popButton} ${
          active
            ? "border-accent text-text"
            : "border-control-border text-text-muted hover:border-accent hover:text-text"
        }`}
      >
        <span>
          {t("ui.dates")}: <span className={active ? "font-medium" : ""}>{summary}</span>
        </span>
        <Chevron />
      </button>
      <div {...pop.panelProps} role="dialog" aria-label={t("ui.dates")} className="pop w-72 p-3">
        <div className="grid grid-cols-2 gap-3">
          <label htmlFor={`${id}-from`} className="text-ui-xs text-text-muted flex flex-col gap-1">
            {t("ui.from")}
            <input
              id={`${id}-from`}
              data-autofocus
              type="date"
              name={fromName}
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className={field}
            />
          </label>
          <label htmlFor={`${id}-to`} className="text-ui-xs text-text-muted flex flex-col gap-1">
            {t("ui.to")}
            <input
              id={`${id}-to`}
              type="date"
              name={toName}
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className={field}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SHORTCUTS.map((n) => (
            <button
              key={n}
              data-item
              type="button"
              aria-label={t("ui.lastDays", { count: n })}
              onClick={() => set(daysAgo(n), "")}
              className="border-control-border text-text-muted hover:border-accent hover:text-text text-ui-xs focus-visible:outline-accent inline-flex min-h-8 items-center border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t("ui.lastDaysShort", { count: n })}
            </button>
          ))}
        </div>
        <div className="border-border mt-3 flex items-center justify-between gap-2 border-t pt-3">
          <button
            type="button"
            disabled={!active}
            onClick={() => set("", "")}
            className="text-accent text-ui-sm min-h-10 underline underline-offset-4 disabled:opacity-50"
          >
            {t("ui.clear")}
          </button>
          <button
            type="submit"
            className="bg-accent text-on-accent hover:bg-accent-hover text-ui-sm focus-visible:outline-accent min-h-10 px-4 font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {t("ui.apply")}
          </button>
        </div>
      </div>
    </>
  );
}
