import { Band } from "@/components/charts/band";
import { formatValue } from "@/components/charts/format";
import { StatTile } from "@/components/charts/stat-tile";
import type { Locale, T } from "@/lib/i18n/core";
import { getLocale, getT } from "@/lib/i18n/server";
import { apiGet } from "@/lib/server-api";

import { LatencyChart, RecallsChart } from "../atrium/charts";
import { parseRecallMetrics, type RecallMetrics } from "../atrium/types";

/**
 * The waters' last 30 days, from /recall/metrics: how many recalls ran, how many found
 * something, how fast they answered; then recalls per day and latency per day.
 */
export function RecallFigures({
  t,
  locale,
  recall,
}: {
  t: T;
  locale: Locale;
  recall: RecallMetrics | null;
}) {
  const totals = recall?.totals;
  const zero = totals?.queries ? totals.zeroHitShare : null;
  const daily = recall?.days.map((d) => d.queries) ?? [];
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={3}>
        <StatTile
          label={t("metrics.recall.queries")}
          definition={t("metrics.recall.queriesDef")}
          value={totals?.queries ?? null}
          spark={daily.some((n) => n > 0) ? daily : undefined}
          sparkLabel={t("home.charts.recalls")}
        />
        <StatTile
          label={t("home.tiles.hitRate")}
          definition={t("home.tiles.hitRateDef")}
          value={zero == null ? null : 1 - zero}
          format="percent"
          meter={zero == null ? undefined : 1 - zero}
          caption={
            zero == null
              ? undefined
              : t("metrics.recall.zeroHits", { value: formatValue(locale, zero, "percent") })
          }
        />
        <StatTile
          label={t("metrics.recall.latency")}
          definition={t("metrics.recall.latencyDef")}
          value={totals?.p50Ms ?? null}
          format="ms"
          caption={
            totals?.p95Ms != null
              ? t("home.tiles.latencyP95", { value: formatValue(locale, totals.p95Ms, "ms") })
              : undefined
          }
        />
      </Band>
      <div className="grid gap-6 lg:grid-cols-2">
        <RecallsChart t={t} recall={recall} />
        <LatencyChart t={t} recall={recall} />
      </div>
    </div>
  );
}

/** The figures with their data: read on the server, streamed under the layout's Suspense. */
export async function LoadedRecallFigures() {
  const [t, locale, raw] = await Promise.all([
    getT(),
    getLocale(),
    apiGet<unknown>("/recall/metrics?days=30"),
  ]);
  return <RecallFigures t={t} locale={locale} recall={parseRecallMetrics(raw)} />;
}
