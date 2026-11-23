import { Band } from "@/components/charts/band";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeSeries } from "@/components/charts/time-series";
import type { T } from "@/lib/i18n/core";
import { num, rec, str } from "@/lib/metrics";

export interface AuditStats {
  days: Array<{ day: string; user: number; system: number }>;
  totals: { user: number; system: number };
}

/** GET /audit/stats; null when the payload is not one. */
export function parseAuditStats(v: unknown): AuditStats | null {
  if (!rec(v) || !Array.isArray(v.days) || !rec(v.totals)) return null;
  if (!num(v.totals.user) || !num(v.totals.system)) return null;
  const days: AuditStats["days"] = [];
  for (const d of v.days) {
    if (!rec(d) || !str(d.day) || !num(d.user) || !num(d.system)) return null;
    days.push({ day: d.day, user: d.user, system: d.system });
  }
  return { days, totals: { user: v.totals.user, system: v.totals.system } };
}

/**
 * The undo log over 30 days, from /audit/stats (the whole window, under the caller's ceiling):
 * entries, forgotten by people, archived by the system; then entries per day.
 */
export function AuditFigures({ t, stats }: { t: T; stats: AuditStats | null }) {
  const total = stats ? stats.totals.user + stats.totals.system : null;
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={3}>
        <StatTile
          label={t("metrics.audit.entries")}
          definition={t("metrics.audit.entriesDef")}
          value={total}
        />
        <StatTile
          label={t("metrics.audit.user")}
          definition={t("metrics.audit.userDef")}
          value={stats?.totals.user ?? null}
          href={stats?.totals.user ? "/admin/audit?actorKind=user" : undefined}
        />
        <StatTile
          label={t("metrics.audit.system")}
          definition={t("metrics.audit.systemDef")}
          value={stats?.totals.system ?? null}
          href={stats?.totals.system ? "/admin/audit?actorKind=system" : undefined}
        />
      </Band>
      <ChartCard
        title={t("metrics.audit.perDay")}
        period={t("metrics.last30")}
        definition={t("metrics.audit.perDayDef")}
        state={!stats ? "error" : total ? "ready" : "empty"}
        emptyText={t("metrics.audit.perDayEmpty")}
      >
        {stats && (
          <TimeSeries
            label={t("metrics.audit.perDay")}
            days={stats.days.map((d) => d.day)}
            series={[
              {
                name: t("metrics.audit.entries"),
                values: stats.days.map((d) => d.user + d.system),
              },
            ]}
            kind="columns"
            format="count"
            minDays={7}
          />
        )}
      </ChartCard>
    </div>
  );
}
