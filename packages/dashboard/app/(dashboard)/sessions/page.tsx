import Link from "next/link";

import { BackTo } from "@/components/back-to";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { CapNote, LoadMore } from "@/components/load-more";
import { formatDate, formatNumber } from "@/lib/i18n/core";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { apiGet, apiRead } from "@/lib/server-api";

import { ScrollIntoViewOnOpen } from "@/components/scroll-into-view-on-open";

import { parseSessionStats } from "@/lib/metrics";

import { buildQuery } from "../browser/types";
import { SessionFigures } from "./figures";
import { Niche, loadNiche } from "./niche";
import { parseEpisode, type Episode } from "./types";

/**
 * Sessions, the columbarium (spec §4, row IV): each episode is a niche in a
 * grid. The open niche is `?open=<id>`, rendered on the server so a link to
 * any session is shareable (the catalog's provenance chain points here).
 */

const MAX_TOPICS = 4;
/**
 * GET /episodes has no cursor: "Load more" asks for a longer list (`?limit=`), up to the
 * route's own max (routes/episodes.ts), where the grid says it stops (APP-043).
 */
const PAGE_SIZE = 50;
const MAX_LIMIT = 200;

export const generateMetadata = roomTitle("sessions");

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const t = await getT();
  const locale = await getLocale();
  const open = params.open;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(PAGE_SIZE, parseInt(params.limit ?? "", 10) || PAGE_SIZE)
  );
  // The list and the open niche do not depend on each other: fetch them together.
  const [read, niche, rawStats] = await Promise.all([
    apiRead<{ items?: unknown } | unknown[]>(`/episodes?limit=${limit}`),
    open ? loadNiche(open) : null,
    apiGet<unknown>("/session/stats?days=30"),
  ]);
  const data = read.data;
  const raw = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(raw)) {
    return (
      <ErrorState
        title={t("sessions.listLabel")}
        body={read.timedOut ? t("common.timeout") : t("sessions.loadError")}
      />
    );
  }
  const items = raw.map(parseEpisode).filter((e): e is Episode => e !== null);
  if (items.length === 0 && !open) {
    return (
      <EmptyState
        title={t("sessions.empty.title")}
        body={t("sessions.empty.body")}
        command={t("sessions.empty.command")}
      />
    );
  }

  return (
    <div className="w-full space-y-8">
      {/* The niche always sits under the grid, so it is always brought into view. */}
      <ScrollIntoViewOnOpen open={open} targetId="columbarium-open" headingId="columbarium-title" />
      <SessionFigures t={t} locale={locale} stats={parseSessionStats(rawStats)} />
      {items.length > 0 && (
        <ul
          id="columbarium-grid"
          data-testid="columbarium-grid"
          aria-label={t("sessions.listLabel")}
          className="columbarium-grid"
        >
          {items.map((ep, i) => (
            <li key={ep.id} className="enter" style={{ "--i": i } as React.CSSProperties}>
              <Link
                href={`/sessions${buildQuery({ ...params, open: ep.id })}`}
                aria-current={ep.id === open ? "page" : undefined}
                className="columbarium-niche bg-surface border-border block h-full border p-4"
              >
                <span className="text-text-muted text-mono block font-mono">
                  {formatDate(locale, ep.occurredAt, "datetime")}
                </span>
                <span className="font-display text-display-6 echo mt-2 block leading-tight break-words">
                  {ep.title}
                </span>
                <span className="text-text-muted text-ui-xs mt-3 flex flex-wrap gap-x-3 gap-y-1">
                  {ep.durationMinutes !== null && (
                    <span>{t("sessions.minutes", { count: ep.durationMinutes })}</span>
                  )}
                  <span>{t("sessions.facts", { count: ep.linkedFactIds.length })}</span>
                </span>
                {ep.topics.length > 0 && (
                  <span className="text-text-muted text-ui-xs mt-1 block break-words">
                    {ep.topics.slice(0, MAX_TOPICS).join(" · ")}
                    {ep.topics.length > MAX_TOPICS &&
                      ` ${t("sessions.more", { count: ep.topics.length - MAX_TOPICS })}`}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {raw.length >= limit &&
        (limit < MAX_LIMIT ? (
          <LoadMore
            href={`/sessions${buildQuery({ ...params, limit: String(limit + PAGE_SIZE) })}`}
            label={t("sessions.loadMore")}
          />
        ) : (
          <CapNote>{t("common.firstN", { count: formatNumber(locale, limit) })}</CapNote>
        ))}
      {open && (
        <section
          id="columbarium-open"
          data-testid="columbarium-niche"
          aria-label={t("sessions.nicheLabel")}
          className="columbarium-open"
        >
          {/* Always shown: the niche sits under the grid at every width. */}
          <BackTo href="#columbarium-grid" label={t("sessions.back")} />
          <Niche data={niche ?? "unavailable"} t={t} locale={locale} />
        </section>
      )}
    </div>
  );
}
