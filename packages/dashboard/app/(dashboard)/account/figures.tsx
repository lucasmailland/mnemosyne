import { labelOr } from "@/components/badges";
import { Band } from "@/components/charts/band";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeSeries } from "@/components/charts/time-series";
import { formatDate, type Locale, type T } from "@/lib/i18n/core";
import { groups, num, rec, str, type Group } from "@/lib/metrics";
import { roleLabel } from "@/lib/roles";
import type { DashboardSession } from "@/lib/server-api";

export interface OwnActivity {
  days: Array<{ day: string; count: number }>;
  byAction: Group[];
  lastAt: string | null;
}

/** GET /me/activity; null when the payload is not one. */
export function parseOwnActivity(v: unknown): OwnActivity | null {
  if (!rec(v) || !Array.isArray(v.days)) return null;
  const days: OwnActivity["days"] = [];
  for (const d of v.days) {
    if (!rec(d) || !str(d.day) || !num(d.count)) return null;
    days.push({ day: d.day, count: d.count });
  }
  return { days, byAction: groups(v.byAction, "action"), lastAt: str(v.lastAt) ? v.lastAt : null };
}

/**
 * The account in figures: the role here, the permissions it carries, the person's own activity
 * in this workspace over 30 days (from /me/activity) and the memories in their personal
 * workspace (from /my-workspaces); then their activity per day.
 */
export function AccountFigures({
  t,
  locale,
  session,
  activity,
  personal,
}: {
  t: T;
  locale: Locale;
  session: DashboardSession | null;
  activity: OwnActivity | null;
  personal: number | null;
}) {
  const total = activity?.days.reduce((n, d) => n + d.count, 0) ?? null;
  const role = session
    ? session.workspaceRole
      ? roleLabel(t, session.workspaceRole)
      : labelOr(t, `nav.scope.${session.role}`, session.role)
    : null;
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.account.role")}
          definition={t("metrics.account.roleDef")}
          value={role ? 0 : null}
          display={role ?? undefined}
        />
        <StatTile
          label={t("metrics.account.scopes")}
          definition={t("metrics.account.scopesDef")}
          value={session?.scopes?.length ?? null}
        />
        <StatTile
          label={t("metrics.account.activity")}
          definition={t("metrics.account.activityDef")}
          value={total}
          caption={
            activity?.lastAt
              ? t("metrics.account.lastAt", { date: formatDate(locale, activity.lastAt, "short") })
              : undefined
          }
        />
        <StatTile
          label={t("metrics.account.personal")}
          definition={t("metrics.account.personalDef")}
          value={personal}
        />
      </Band>
      <ChartCard
        title={t("metrics.account.perDay")}
        period={t("metrics.last30")}
        definition={t("metrics.account.perDayDef")}
        state={!activity ? "error" : total ? "ready" : "empty"}
        emptyText={t("metrics.account.perDayEmpty")}
      >
        {activity && (
          <TimeSeries
            label={t("metrics.account.perDay")}
            days={activity.days.map((d) => d.day)}
            series={[
              { name: t("metrics.account.entries"), values: activity.days.map((d) => d.count) },
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
