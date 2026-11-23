import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { SceneHeading } from "@/components/scene-heading";
import { formatDate, formatNumber } from "@/lib/i18n/core";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { ROOMS } from "@/lib/rooms";
import { apiGet, getSession } from "@/lib/server-api";

import { ArchiveCard } from "../atrium/archive-card";
import { KindsChart, LatencyChart, RecallsChart, WritesChart } from "../atrium/charts";
import { ConflictCard } from "../atrium/conflict-card";
import { Day } from "../atrium/day";
import { Figures } from "../atrium/figures";
import { FirstSteps } from "../atrium/first-steps";
import { Needs } from "../atrium/needs";
import {
  parseConflictTotal,
  parseConflicts,
  parseFactStats,
  parseRecallMetrics,
  parseStats,
  parseTimeline,
  recallBumps,
  relabelRecalls,
} from "../atrium/types";
import { ValueBand } from "../atrium/value-band";

/** The conflict queue's length: the route's cap (routes/conflicts.ts, limit max 20). */
const CONFLICT_QUEUE = 20;

/**
 * Home: the workspace's numbers first. A one-line summary of today, the band of key figures,
 * then what memory saves (admins), the charts that explain the figures (writes, recalls, latency,
 * memory by kind); the queue of conflicts that need a person and the day's events follow. A
 * self-hosted server enforces no plan quotas, so Home draws no plan usage (APP-051). An empty
 * workspace gets its first steps instead. Every figure comes from a
 * server aggregate; a source that fails reads as an error in its own card, never as zero.
 * Members get the same room without the admin-only figures.
 */
export const generateMetadata = roomTitle("home");

const room = ROOMS.find((r) => r.id === "home")!;

export default async function HomePage() {
  const t = await getT();
  const locale = await getLocale();
  const session = await getSession();
  const canWrite = session?.scopes.includes("memory:write") ?? false;

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const since = encodeURIComponent(`${todayKey}T00:00:00.000Z`);
  const [rawStats, rawTimeline, rawConflicts, rawRecall30, rawRecall7, rawFacts, rawRecent] =
    await Promise.all([
      apiGet<unknown>("/admin/stats"),
      apiGet<unknown>(`/timeline?since=${since}&limit=8`),
      apiGet<unknown>(`/conflicts?limit=${CONFLICT_QUEUE}`),
      apiGet<unknown>("/recall/metrics?days=30"),
      apiGet<unknown>("/recall/metrics?days=7"),
      apiGet<unknown>("/facts/stats"),
      // The 8 latest-changed facts hold every "updated" event the day can show (it shows 8):
      // they tell a recall's bump from a real change (APP-052).
      apiGet<unknown>("/facts?status=all&sortBy=updated_at&order=desc&limit=8"),
    ]);
  const stats = parseStats(rawStats);
  const timeline = parseTimeline(rawTimeline);
  const conflicts = parseConflicts(rawConflicts);
  const conflictTotal = parseConflictTotal(rawConflicts);
  const recall30 = parseRecallMetrics(rawRecall30);
  const recall7 = parseRecallMetrics(rawRecall7);
  const facts = parseFactStats(rawFacts);

  if (!stats)
    return (
      <div className="w-full space-y-6">
        <SceneHeading room={room} />
        <ErrorState title={t("home.statsError")} body="" />
      </div>
    );

  // A source that failed stays null: it is said as a failure, never as "nothing" (APP-043).
  const events = timeline ? relabelRecalls(timeline.events, recallBumps(rawRecent)) : null;
  if (stats.facts.live === 0 && stats.facts.closed === 0 && events?.length === 0)
    return (
      <div className="w-full space-y-8">
        <SceneHeading room={room} />
        <EmptyState title={t("home.empty.title")} body={t("home.empty.body")} />
        <FirstSteps canCreateKey={session?.scopes.includes("admin:keys") ?? false} />
      </div>
    );

  const pair = conflicts?.[0];
  // The series is zero-filled through today: no series, or no row for today, is unknown.
  const writtenToday = stats.writesPerDay14d?.find((d) => d.day === todayKey)?.count ?? null;
  // The live list is the truth: its `total` counts what the caller can see, a pair means at
  // least one, an empty list means none. The snapshot count is only a fallback when the list
  // could not be fetched (or an older server sends no total).
  const conflictCount = conflicts
    ? pair
      ? Math.max(conflictTotal ?? stats.relations.conflicts ?? 0, 1)
      : 0
    : (stats.relations.conflicts ?? null);
  const recallsToday = recall30?.days.at(-1)?.queries ?? null;

  // One line of true clauses: a clause whose source could not be read is left out.
  const summary: React.ReactNode[] = [];
  if (writtenToday != null) summary.push(t("home.summary.written", { count: writtenToday }));
  if (recallsToday != null) summary.push(t("home.summary.recalls", { count: recallsToday }));
  if (conflictCount != null)
    summary.push(
      conflictCount === 0 ? (
        t("home.summary.noConflicts")
      ) : pair ? (
        <a href="#atrium-conflict" className="atrium-link">
          {t("home.summary.conflicts", { count: conflictCount })}
        </a>
      ) : (
        t("home.summary.conflicts", { count: conflictCount })
      )
    );

  return (
    <div className="w-full space-y-6">
      <header className="enter space-y-2">
        <SceneHeading room={room} />
        <p className="text-text-muted text-ui leading-relaxed">
          {/* "Today" is the UTC day: the server's per-day aggregates know no other (APP-052). */}
          <span data-testid="home-date" className="text-text-faint">
            {formatDate(locale, now, "long")} (UTC)
          </span>
          <span aria-hidden="true"> — </span>
          <span data-testid="home-summary">
            {summary.map((c, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {c}
              </span>
            ))}
          </span>
        </p>
      </header>

      <div className="enter" style={{ "--i": 1 } as React.CSSProperties}>
        <Figures
          t={t}
          locale={locale}
          stats={stats}
          facts={facts}
          recall30={recall30}
          recall7={recall7}
          conflicts={conflictCount}
          conflictHref={pair ? "#atrium-conflict" : null}
          writtenToday={writtenToday}
        />
      </div>

      {stats.context && (
        <div className="enter" style={{ "--i": 2 } as React.CSSProperties}>
          <ValueBand
            t={t}
            locale={locale}
            context={stats.context}
            precisionAtK={stats.recall.precisionAtK}
          />
        </div>
      )}

      <div className="enter grid gap-6 lg:grid-cols-2" style={{ "--i": 2 } as React.CSSProperties}>
        <WritesChart t={t} stats={stats} />
        <RecallsChart t={t} recall={recall30} />
        <LatencyChart t={t} recall={recall30} />
        <KindsChart t={t} facts={facts} />
        <section className="border-border bg-surface min-w-0 border p-4 sm:p-5">
          <Needs title={t("home.needs.title")}>
            {/* "In order" is only said when the list loaded and is empty. */}
            {conflicts?.length ? (
              <>
                <ol
                  id="atrium-conflict"
                  aria-label={t("home.needs.queueLabel")}
                  className="mt-4 space-y-4"
                >
                  {conflicts.map((p) => (
                    <li key={p.relationId}>
                      <ConflictCard pair={p} canWrite={canWrite} />
                    </li>
                  ))}
                </ol>
                {conflictCount != null && conflictCount > conflicts.length && (
                  <p className="text-text-muted text-ui-sm mt-3">
                    {t("common.shownOf", {
                      shown: formatNumber(locale, conflicts.length),
                      total: formatNumber(locale, conflictCount),
                    })}
                  </p>
                )}
              </>
            ) : conflicts ? (
              <ArchiveCard t={t} />
            ) : (
              <p className="text-text-muted text-ui-sm mt-4">{t("home.needs.error")}</p>
            )}
          </Needs>
        </section>
      </div>

      <div className="enter" style={{ "--i": 3 } as React.CSSProperties}>
        <Day t={t} locale={locale} events={events} />
      </div>
    </div>
  );
}
