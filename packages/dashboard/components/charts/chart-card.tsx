"use client";

import { useId, useState, type ReactNode } from "react";

import { useT } from "@/lib/i18n/client";

import { InfoTip } from "@/components/ui/info-tip";

import { TableViewProvider } from "./core";

/**
 * A chart's frame: the title with its definition behind an info button, the period on one line,
 * and a table icon that swaps the chart for its table (pressed while the table shows). `state`
 * replaces the chart with a plain sentence when there is nothing to draw (`empty`) or the data
 * could not be read (`error`): no toggle then.
 */
export function ChartCard({
  title,
  period,
  definition,
  state = "ready",
  emptyText,
  children,
  className = "",
}: {
  title: string;
  period?: string;
  definition: string;
  state?: "ready" | "empty" | "error";
  emptyText?: string;
  children?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const id = useId();
  const [table, setTable] = useState(false);
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="chart-card"
      className={`border-border bg-surface flex min-w-0 flex-col gap-3 border p-4 sm:p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h2 id={`${id}-title`} className="text-text text-ui min-w-0 font-semibold">
              {title}
            </h2>
            <InfoTip label={title} text={definition} />
          </div>
          {period && (
            <p className="text-text-faint text-ui-xs mt-1 truncate" title={period}>
              {period}
            </p>
          )}
        </div>
        {state === "ready" && (
          <button
            type="button"
            aria-label={t("charts.viewTable")}
            aria-pressed={table}
            title={t("charts.viewTable")}
            onClick={() => setTable((v) => !v)}
            className="border-control-border text-text-muted hover:border-accent hover:text-text aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent focus-visible:outline-accent inline-flex size-8 shrink-0 items-center justify-center border focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
              <rect
                x="0.75"
                y="0.75"
                width="12.5"
                height="10.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M1 4.25h12M1 7.75h12M5 1v10" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          </button>
        )}
      </div>
      {state === "ready" ? (
        <TableViewProvider value={table}>{children}</TableViewProvider>
      ) : (
        <p className="text-text-muted text-ui-sm py-6 text-center">
          {state === "error" ? t("charts.error") : (emptyText ?? t("charts.empty"))}
        </p>
      )}
    </section>
  );
}
