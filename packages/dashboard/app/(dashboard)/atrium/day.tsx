import Link from "next/link";

import { labelOr } from "@/components/badges";
import { formatDate, type Locale, type T } from "@/lib/i18n/core";

import type { TimelineEvent } from "./types";

const MAX_EVENTS = 8;

/** Where an event's memory opens in the Explorer: the fact itself, or the decisions list. */
const target = (ev: TimelineEvent) =>
  ev.factId
    ? `/browser?open=${encodeURIComponent(ev.factId)}`
    : ev.decisionId
      ? "/browser?type=decisions"
      : null;

/**
 * The day, as remembered: today's events (the UTC day, times in UTC), newest first, at most
 * eight, each a link. `events` null: the timeline could not be read, said as such (APP-043).
 */
export function Day({
  t,
  locale,
  events,
}: {
  t: T;
  locale: Locale;
  events: TimelineEvent[] | null;
}) {
  const shown = [...(events ?? [])]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_EVENTS);
  return (
    <section
      aria-labelledby="atrium-day-title"
      className="border-border bg-surface border p-4 sm:p-5"
    >
      <div className="border-border-soft flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-2">
        <h2 id="atrium-day-title" className="text-text text-ui font-semibold">
          {t("home.day.title")}
        </h2>
        <Link href="/browser" className="text-accent text-ui-xs underline-offset-4 hover:underline">
          {t("home.day.openCatalog")}
        </Link>
      </div>
      {events === null ? (
        <p role="status" className="text-text-muted text-ui-sm py-3">
          {t("home.day.error")}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-text-muted text-ui-sm py-3">{t("home.day.empty")}</p>
      ) : (
        <ul data-testid="atrium-day">
          {shown.map((ev) => {
            const decision = ev.kind.startsWith("decision_");
            const href = target(ev);
            const text = ev.summary ?? (
              <span className="font-mono text-mono">{ev.factId ?? ev.decisionId}</span>
            );
            return (
              <li
                key={ev.id}
                className="border-border-soft text-ui-sm flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className={`relative top-0.5 size-2 shrink-0 border border-accent ${decision ? "bg-accent" : ""}`}
                />
                <time
                  dateTime={ev.at}
                  className="text-text-faint w-20 shrink-0 font-mono text-mono-sm"
                >
                  {formatDate(locale, ev.at, "time")}
                </time>
                <span className="min-w-40 flex-1 leading-snug break-words">
                  {href ? (
                    <Link href={href} className="echo hover:text-accent">
                      {text}
                    </Link>
                  ) : (
                    text
                  )}
                  {ev.actor && (
                    <em className="text-text-faint text-ui-xs ml-1 not-italic">· {ev.actor}</em>
                  )}
                </span>
                <span className="text-text-faint text-ui-xs whitespace-nowrap">
                  {labelOr(t, `home.event.${ev.kind}`, ev.kind)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
