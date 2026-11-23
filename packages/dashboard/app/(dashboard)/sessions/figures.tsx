import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeSeries } from "@/components/charts/time-series";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import type { SessionStats } from "@/lib/metrics";

/**
 * The columbarium's last 30 days, from /session/stats: sessions started, how many collapsed into
 * memory, their mean turns, the episodes remembered; then sessions per day and the topics the
 * episodes carry most.
 */
export function SessionFigures({
  t,
  locale,
  stats,
}: {
  t: T;
  locale: Locale;
  stats: SessionStats | null;
}) {
  const totals = stats?.totals;
  const one = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
  const perDay = stats?.days.map((d) => d.active + d.collapsed + d.archived) ?? [];
  return (
    <div className="space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.sessions.sessions")}
          definition={t("metrics.sessions.sessionsDef")}
          value={totals?.sessions ?? null}
        />
        <StatTile
          label={t("metrics.sessions.collapsed")}
          definition={t("metrics.sessions.collapsedDef")}
          value={totals?.sessions ? totals.collapsed / totals.sessions : null}
          format="percent"
          caption={
            totals?.sessions
              ? t("metrics.ofTotal", {
                  count: formatNumber(locale, totals.collapsed),
                  total: formatNumber(locale, totals.sessions),
                })
              : undefined
          }
        />
        <StatTile
          label={t("metrics.sessions.turns")}
          definition={t("metrics.sessions.turnsDef")}
          value={totals?.avgTurns ?? null}
          display={totals?.avgTurns != null ? one(totals.avgTurns) : undefined}
        />
        <StatTile
          label={t("metrics.sessions.episodes")}
          definition={t("metrics.sessions.episodesDef")}
          value={totals?.episodes ?? null}
          caption={
            totals?.factsPerEpisode != null
              ? t("metrics.sessions.factsPer", { value: one(totals.factsPerEpisode) })
              : undefined
          }
        />
      </Band>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={t("metrics.sessions.perDay")}
          period={t("metrics.last30")}
          definition={t("metrics.sessions.perDayDef")}
          state={!stats ? "error" : totals!.sessions > 0 ? "ready" : "empty"}
          emptyText={t("metrics.sessions.perDayEmpty")}
        >
          {stats && (
            <TimeSeries
              label={t("metrics.sessions.perDay")}
              days={stats.days.map((d) => d.day)}
              series={[{ name: t("metrics.sessions.sessions"), values: perDay }]}
              kind="columns"
              format="count"
              minDays={7}
            />
          )}
        </ChartCard>
        <ChartCard
          title={t("metrics.sessions.topics")}
          period={t("metrics.sessions.topicsPeriod")}
          definition={t("metrics.sessions.topicsDef")}
          state={!stats ? "error" : stats.topics.length > 0 ? "ready" : "empty"}
          emptyText={t("metrics.sessions.topicsEmpty")}
        >
          <BarList
            label={t("metrics.sessions.topics")}
            items={stats?.topics.map((g) => ({ name: g.name, value: g.count })) ?? []}
          />
        </ChartCard>
      </div>
    </div>
  );
}
