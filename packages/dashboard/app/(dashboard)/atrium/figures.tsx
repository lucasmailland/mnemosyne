import { StatTile } from "@/components/charts/stat-tile";
import { formatValue } from "@/components/charts/format";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";

import type { AdminStats, FactStats, RecallMetrics } from "./types";

/**
 * The band of key figures. Every tile names what it counts (its definition sits behind the info
 * button) and reads "—" when its source could not be read, never a made-up zero.
 */
export function Figures({
  t,
  locale,
  stats,
  facts,
  recall30,
  recall7,
  conflicts,
  conflictHref,
  writtenToday,
}: {
  t: T;
  locale: Locale;
  stats: AdminStats;
  facts: FactStats | null;
  recall30: RecallMetrics | null;
  recall7: RecallMetrics | null;
  conflicts: number | null;
  conflictHref: string | null;
  /** null: the writes series could not be read. */
  writtenToday: number | null;
}) {
  const num = (n: number) => formatNumber(locale, n);
  const series = stats.writesPerDay14d?.map((d) => d.count) ?? [];
  const live = facts?.live ?? stats.facts.live;
  const zero = recall30?.totals.zeroHitShare;
  const hitRate = recall30?.totals.queries && zero != null ? 1 - zero : null;
  const p50 = recall7?.totals.p50Ms ?? null;
  const p95 = recall7?.totals.p95Ms ?? null;
  const never = facts && facts.live > 0 ? facts.neverRecalled / facts.live : null;

  return (
    <section aria-labelledby="atrium-figures-title" data-testid="atrium-figures">
      <h2 id="atrium-figures-title" className="sr-only">
        {t("home.tiles.title")}
      </h2>
      <div className="border-border bg-surface grid grid-cols-2 gap-x-6 gap-y-6 border p-4 sm:grid-cols-3 sm:p-5 xl:grid-cols-6">
        <StatTile
          label={t("home.tiles.live")}
          definition={t("home.tiles.liveDef")}
          value={live}
          href="/browser"
          spark={series.length > 1 ? series : undefined}
          sparkLabel={t("home.tiles.liveSpark", {
            today: writtenToday == null ? "—" : num(writtenToday),
            peak: num(Math.max(0, ...series)),
          })}
          caption={writtenToday ? t("home.tiles.liveToday", { count: writtenToday }) : undefined}
        />
        <StatTile
          label={t("home.tiles.hitRate")}
          definition={t("home.tiles.hitRateDef")}
          value={hitRate}
          format="percent"
          meter={hitRate ?? undefined}
          caption={
            recall30
              ? recall30.totals.queries > 0
                ? t("home.tiles.hitRateOf", { count: recall30.totals.queries })
                : t("home.tiles.noRecalls")
              : undefined
          }
        />
        <StatTile
          label={t("home.tiles.latency")}
          definition={t("home.tiles.latencyDef")}
          value={p50}
          format="ms"
          caption={
            p95 != null
              ? t("home.tiles.latencyP95", { value: formatValue(locale, p95, "ms") })
              : recall7
                ? t("home.tiles.noRecalls")
                : undefined
          }
        />
        <StatTile
          label={t("home.tiles.never")}
          definition={t("home.tiles.neverDef")}
          value={never}
          format="percent"
          caption={
            facts && facts.live > 0
              ? t("home.tiles.neverOf", { count: num(facts.neverRecalled), total: num(facts.live) })
              : undefined
          }
        />
        <StatTile
          label={t("home.tiles.conflicts")}
          definition={t("home.tiles.conflictsDef")}
          value={conflicts}
          href={conflictHref ?? undefined}
          caption={
            conflicts == null
              ? undefined
              : conflicts > 0
                ? t("home.tiles.conflictsSome")
                : t("home.tiles.conflictsNone")
          }
        />
        {stats.embeddings && (
          <StatTile
            label={t("home.tiles.embeddings")}
            definition={t("home.tiles.embeddingsDef")}
            value={stats.embeddings.indexed}
            caption={t("home.tiles.embeddingsPending", { count: stats.embeddings.pending })}
          />
        )}
      </div>
    </section>
  );
}
