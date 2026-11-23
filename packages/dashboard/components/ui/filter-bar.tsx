"use client";

import Link from "next/link";
import type { InputHTMLAttributes, ReactNode } from "react";

import { useT } from "@/lib/i18n/client";

/** A search field with its magnifier, for the start of a FilterBar. Needs an aria-label. */
export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="relative flex min-w-0 items-center">
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        className="text-text-faint pointer-events-none absolute left-3"
      >
        <rect
          x="1"
          y="1"
          width="8"
          height="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M8.5 8.5 13 13" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <input
        type="search"
        {...props}
        className="border-control-border bg-surface placeholder:text-text-faint text-ui-sm min-h-10 w-full min-w-0 border pr-3 pl-9 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </span>
  );
}

/**
 * One row of filters that wraps on a phone: a search field, the filter buttons (FilterMenu,
 * Segmented, DateRangeMenu), "N filters · Clear" when some are on, and the result count at the
 * end (announced politely when it changes).
 */
export function FilterBar({
  label,
  search,
  children,
  active = 0,
  clearHref,
  onClear,
  count,
}: {
  label: string;
  search?: ReactNode;
  children?: ReactNode;
  /** How many filters are on (search text included). */
  active?: number;
  clearHref?: string;
  onClear?: () => void;
  count?: ReactNode;
}) {
  const t = useT();
  const clearClass = "text-accent min-h-10 underline underline-offset-4";
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {search && <div className="min-w-0 flex-1 basis-60">{search}</div>}
      {children}
      {active > 0 && (clearHref || onClear) && (
        <span className="text-text-muted text-ui-xs inline-flex items-center gap-2">
          {t("ui.activeFilters", { count: active })}
          <span aria-hidden="true">·</span>
          {clearHref ? (
            <Link
              href={clearHref}
              aria-label={t("ui.clearFilters")}
              className={`${clearClass} inline-flex items-center`}
            >
              {t("ui.clear")}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onClear}
              aria-label={t("ui.clearFilters")}
              className={clearClass}
            >
              {t("ui.clear")}
            </button>
          )}
        </span>
      )}
      {count != null && (
        <span aria-live="polite" className="text-text-muted text-ui-xs ml-auto">
          {count}
        </span>
      )}
    </div>
  );
}
