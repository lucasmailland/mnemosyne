import { Band } from "@/components/charts/band";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeSeries } from "@/components/charts/time-series";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import { num, rec, str } from "@/lib/metrics";

export interface SnapshotDay {
  day: string;
  recallHitRate30d: number | null;
  zeroHitShare: number | null;
  embeddedShare: number | null;
}

/** GET /health/snapshots; null when the payload is not one. */
export function parseSnapshots(v: unknown): SnapshotDay[] | null {
  if (!rec(v) || !Array.isArray(v.days)) return null;
  const share = (x: unknown) => (num(x) ? x : null);
  const days: SnapshotDay[] = [];
  for (const d of v.days) {
    if (!rec(d) || !str(d.day)) return null;
    days.push({
      day: d.day,
      recallHitRate30d: share(d.recallHitRate30d),
      zeroHitShare: share(d.zeroHitShare),
      embeddedShare: share(d.embeddedShare),
    });
  }
  return days;
}

/** GET /health/history: the readiness checks this server process has run. */
export function parseHistory(v: unknown): Array<{ status: string }> | null {
  return rec(v) && Array.isArray(v.items)
    ? v.items.filter((i): i is { status: string } => rec(i) && str(i.status))
    : null;
}

/**
 * The installation and the workspace at a glance: doctor checks passing, embeddings indexed, the
 * age of the latest daily snapshot, the share of readiness checks that passed; then the recall
 * hit rate and the never-recalled share over 30 days, from the daily snapshots.
 */
export function HealthFigures({
  t,
  locale,
  checks,
  embeddings,
  snapshots,
  history,
}: {
  t: T;
  locale: Locale;
  checks: Array<{ status: string }> | null;
  embeddings: { indexed: number; pending: number } | null;
  snapshots: SnapshotDay[] | null;
  history: Array<{ status: string }> | null;
}) {
  const n = (v: number) => formatNumber(locale, v);
  const ok = checks?.filter((c) => c.status === "ok").length ?? 0;
  const warn = checks?.filter((c) => c.status === "warn").length ?? 0;
  const failing = checks?.filter((c) => c.status === "error").length ?? 0;
  const indexable = embeddings ? embeddings.indexed + embeddings.pending : 0;
  const lastIndex = snapshots
    ? snapshots.findLastIndex((d) => d.zeroHitShare != null || d.embeddedShare != null)
    : -1;
  const age = snapshots && lastIndex >= 0 ? snapshots.length - 1 - lastIndex : null;
  const ready = history?.length
    ? history.filter((h) => h.status === "ok").length / history.length
    : null;
  const drawn = snapshots?.some((d) => d.recallHitRate30d != null || d.zeroHitShare != null);
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.health.checks")}
          definition={t("metrics.health.checksDef")}
          value={checks ? ok : null}
          caption={
            checks
              ? t("metrics.health.checksOf", {
                  total: n(checks.length),
                  warn: n(warn),
                  failing: n(failing),
                })
              : undefined
          }
        />
        <StatTile
          label={t("home.tiles.embeddings")}
          definition={t("home.tiles.embeddingsDef")}
          value={indexable > 0 ? embeddings!.indexed / indexable : null}
          format="percent"
          meter={indexable > 0 ? embeddings!.indexed / indexable : undefined}
          caption={
            embeddings
              ? t("home.tiles.embeddingsPending", { count: embeddings.pending })
              : undefined
          }
        />
        <StatTile
          label={t("metrics.health.snapshot")}
          definition={t("metrics.health.snapshotDef")}
          value={age}
          display={
            age == null
              ? undefined
              : age === 0
                ? t("metrics.health.today")
                : t("metrics.config.days", { count: age })
          }
          caption={snapshots && age == null ? t("metrics.health.noSnapshot") : undefined}
        />
        <StatTile
          label={t("metrics.health.ready")}
          definition={t("metrics.health.readyDef")}
          value={ready}
          format="percent"
          meter={ready ?? undefined}
          caption={
            history
              ? history.length
                ? t("metrics.health.readyOf", { count: history.length })
                : t("metrics.health.noChecks")
              : undefined
          }
        />
      </Band>
      <ChartCard
        title={t("metrics.health.trend")}
        period={t("metrics.last30")}
        definition={t("metrics.health.trendDef")}
        state={!snapshots ? "error" : drawn ? "ready" : "empty"}
        emptyText={t("metrics.health.noSnapshot")}
      >
        {snapshots && (
          <TimeSeries
            label={t("metrics.health.trend")}
            days={snapshots.map((d) => d.day)}
            series={[
              {
                name: t("metrics.health.hitRate"),
                values: snapshots.map((d) => d.recallHitRate30d),
              },
              { name: t("metrics.health.never"), values: snapshots.map((d) => d.zeroHitShare) },
            ]}
            kind="area"
            format="percent"
          />
        )}
      </ChartCard>
    </div>
  );
}
