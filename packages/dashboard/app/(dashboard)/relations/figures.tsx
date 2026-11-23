import { labelOr } from "@/components/badges";
import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { StatTile } from "@/components/charts/stat-tile";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import { getLocale, getT } from "@/lib/i18n/server";
import { parseGraphStats, type GraphStats } from "@/lib/metrics";
import { apiGet } from "@/lib/server-api";

/**
 * The constellation in figures, from /graph/stats (the same snapshot the sky draws, under the
 * caller's ceiling): entities, relations, open conflicts, entities with no link; then relations
 * by type and the busiest hubs. Drawn under the sky, which keeps the room's heading.
 */
export function GraphFigures({
  t,
  locale,
  graph,
}: {
  t: T;
  locale: Locale;
  graph: GraphStats | null;
}) {
  return (
    <div className="mt-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.graph.entities")}
          definition={t("metrics.graph.entitiesDef")}
          value={graph?.entities ?? null}
        />
        <StatTile
          label={t("metrics.graph.relations")}
          definition={t("metrics.graph.relationsDef")}
          value={graph?.relations ?? null}
        />
        <StatTile
          label={t("metrics.graph.conflicts")}
          definition={t("home.tiles.conflictsDef")}
          value={graph?.conflicts ?? null}
          href={graph?.conflicts ? "/#atrium-conflict" : undefined}
        />
        <StatTile
          label={t("metrics.graph.isolated")}
          definition={t("metrics.graph.isolatedDef")}
          value={graph?.isolated ?? null}
          caption={
            graph && graph.entities > 0
              ? t("metrics.ofTotal", {
                  count: formatNumber(locale, graph.isolated),
                  total: formatNumber(locale, graph.entities),
                })
              : undefined
          }
        />
      </Band>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={t("metrics.graph.byType")}
          period={t("metrics.liveNow")}
          definition={t("metrics.graph.byTypeDef")}
          state={!graph ? "error" : graph.relations > 0 ? "ready" : "empty"}
          emptyText={t("metrics.graph.byTypeEmpty")}
        >
          {graph && (
            <SegmentedBar
              label={t("metrics.graph.byType")}
              parts={graph.relationsByType.map((r) => ({
                name: labelOr(t, `graph.relation.${r.name}`, r.name),
                value: r.count,
              }))}
            />
          )}
        </ChartCard>
        <ChartCard
          title={t("metrics.graph.hubs")}
          period={t("metrics.graph.hubsPeriod")}
          definition={t("metrics.graph.hubsDef")}
          state={!graph ? "error" : graph.hubs.length > 0 ? "ready" : "empty"}
          emptyText={t("metrics.graph.hubsEmpty")}
        >
          <BarList
            label={t("metrics.graph.hubs")}
            items={graph?.hubs.map((h) => ({ name: h.label, value: h.degree })) ?? []}
          />
        </ChartCard>
      </div>
    </div>
  );
}

/** The figures with their data: read on the server, streamed under the layout's Suspense. */
export async function LoadedGraphFigures() {
  const [t, locale, raw] = await Promise.all([
    getT(),
    getLocale(),
    apiGet<unknown>("/graph/stats"),
  ]);
  return <GraphFigures t={t} locale={locale} graph={parseGraphStats(raw)} />;
}
