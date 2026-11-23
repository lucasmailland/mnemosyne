import { labelOr } from "@/components/badges";
import { ChartCard } from "@/components/charts/chart-card";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { TimeSeries } from "@/components/charts/time-series";
import type { T } from "@/lib/i18n/core";

import type { AdminStats, FactStats, RecallMetrics } from "./types";

/** Writes per day (14 days), from /admin/stats. */
export function WritesChart({ t, stats }: { t: T; stats: AdminStats }) {
  const days = stats.writesPerDay14d;
  const state = !days ? "error" : days.some((d) => d.count > 0) ? "ready" : "empty";
  return (
    <ChartCard
      title={t("home.charts.writes")}
      period={t("home.charts.writesPeriod")}
      definition={t("home.charts.writesDef")}
      state={state}
      emptyText={t("home.charts.writesEmpty")}
    >
      {days && (
        <TimeSeries
          label={t("home.charts.writes")}
          days={days.map((d) => d.day)}
          series={[{ name: t("home.charts.writesSeries"), values: days.map((d) => d.count) }]}
          kind="columns"
          format="count"
          minDays={7}
        />
      )}
    </ChartCard>
  );
}

/** Recall calls per day (30 days), from /recall/metrics. */
export function RecallsChart({ t, recall }: { t: T; recall: RecallMetrics | null }) {
  const state = !recall ? "error" : recall.totals.queries > 0 ? "ready" : "empty";
  return (
    <ChartCard
      title={t("home.charts.recalls")}
      period={t("home.charts.recallsPeriod")}
      definition={t("home.charts.recallsDef")}
      state={state}
      emptyText={t("home.charts.recallsEmpty")}
    >
      {recall && (
        <TimeSeries
          label={t("home.charts.recalls")}
          days={recall.days.map((d) => d.day)}
          series={[
            { name: t("home.charts.recallsSeries"), values: recall.days.map((d) => d.queries) },
          ]}
          kind="columns"
          format="count"
          minDays={7}
        />
      )}
    </ChartCard>
  );
}

/** Per-call latency p50 and p95 per day (30 days), on its own chart: never a second axis. */
export function LatencyChart({ t, recall }: { t: T; recall: RecallMetrics | null }) {
  const state = !recall ? "error" : recall.days.some((d) => d.p50Ms != null) ? "ready" : "empty";
  return (
    <ChartCard
      title={t("home.charts.latency")}
      period={t("home.charts.latencyPeriod")}
      definition={t("home.charts.latencyDef")}
      state={state}
      emptyText={t("home.charts.latencyEmpty")}
    >
      {recall && (
        <TimeSeries
          label={t("home.charts.latency")}
          days={recall.days.map((d) => d.day)}
          series={[
            { name: t("home.charts.p50"), values: recall.days.map((d) => d.p50Ms) },
            { name: t("home.charts.p95"), values: recall.days.map((d) => d.p95Ms) },
          ]}
          kind="area"
          format="ms"
        />
      )}
    </ChartCard>
  );
}

/** Live memories by kind, from /facts/stats. */
export function KindsChart({ t, facts }: { t: T; facts: FactStats | null }) {
  const state = !facts ? "error" : facts.live > 0 ? "ready" : "empty";
  return (
    <ChartCard
      title={t("home.charts.kinds")}
      period={t("home.charts.kindsPeriod")}
      definition={t("home.charts.kindsDef")}
      state={state}
      emptyText={t("home.charts.kindsEmpty")}
    >
      {facts && (
        <SegmentedBar
          label={t("home.charts.kinds")}
          parts={facts.byKind.map((k) => ({
            name: labelOr(t, `browser.kind.${k.kind}`, k.kind),
            value: k.count,
          }))}
        />
      )}
    </ChartCard>
  );
}
