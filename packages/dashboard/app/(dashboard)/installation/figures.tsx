import { labelOr } from "@/components/badges";
import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeSeries } from "@/components/charts/time-series";
import { formatDate, formatNumber, type Locale, type T } from "@/lib/i18n/core";
import { groups, num, rec, str, type Group } from "@/lib/metrics";

const DAY = 86_400_000;

/**
 * Installation › Users in figures, from the whole GET /instance/users answer: accounts, those
 * signed in within 7 days (and 30), disabled, never signed in; then how recently each signed in.
 */
export function UserFigures({
  t,
  locale,
  users,
  now = Date.now(),
}: {
  t: T;
  locale: Locale;
  users: Array<{ lastLoginAt: string | null; disabledAt: string | null }>;
  now?: number;
}) {
  const age = (iso: string) => now - new Date(iso).getTime();
  const seen = users.filter((u) => u.lastLoginAt);
  const week = seen.filter((u) => age(u.lastLoginAt!) <= 7 * DAY).length;
  const month = seen.filter((u) => age(u.lastLoginAt!) <= 30 * DAY).length;
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.installation.users")}
          definition={t("metrics.installation.usersDef")}
          value={users.length}
        />
        <StatTile
          label={t("metrics.installation.active")}
          definition={t("metrics.installation.activeDef")}
          value={week}
          caption={t("metrics.installation.active30", { count: formatNumber(locale, month) })}
        />
        <StatTile
          label={t("metrics.installation.disabled")}
          definition={t("metrics.installation.disabledDef")}
          value={users.filter((u) => u.disabledAt).length}
        />
        <StatTile
          label={t("metrics.installation.never")}
          definition={t("metrics.installation.neverDef")}
          value={users.length - seen.length}
        />
      </Band>
      <ChartCard
        title={t("metrics.installation.recency")}
        period={t("metrics.liveNow")}
        definition={t("metrics.installation.recencyDef")}
        state={users.length > 0 ? "ready" : "empty"}
      >
        <SegmentedBar
          label={t("metrics.installation.recency")}
          parts={[
            { name: t("metrics.installation.within7"), value: week },
            { name: t("metrics.installation.within30"), value: month - week },
            { name: t("metrics.installation.older"), value: seen.length - month },
            { name: t("metrics.installation.never"), value: users.length - seen.length },
          ]}
        />
      </ChartCard>
    </div>
  );
}

/**
 * Installation › Workspaces in figures, from the whole GET /instance/workspaces answer:
 * workspaces, personal and team, dormant (no write in 30 days); then the five holding the most
 * live memories (under the caller's ceiling) with their last write.
 */
export function InstanceWorkspaceFigures({
  t,
  locale,
  workspaces,
  now = Date.now(),
}: {
  t: T;
  locale: Locale;
  workspaces: Array<{
    name: string;
    isPersonal: boolean;
    factsLive?: number | null;
    lastWriteAt?: string | null;
  }>;
  now?: number;
}) {
  const known = workspaces.filter((w) => w.factsLive != null);
  const personal = workspaces.filter((w) => w.isPersonal).length;
  const dormant = known.filter(
    (w) => !w.lastWriteAt || now - new Date(w.lastWriteAt).getTime() > 30 * DAY
  ).length;
  const top = [...known].sort((a, b) => b.factsLive! - a.factsLive!).slice(0, 5);
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.installation.workspaces")}
          definition={t("metrics.installation.workspacesDef")}
          value={workspaces.length}
        />
        <StatTile
          label={t("metrics.installation.team")}
          definition={t("metrics.installation.teamDef")}
          value={workspaces.length - personal}
        />
        <StatTile
          label={t("metrics.installation.personal")}
          definition={t("metrics.installation.personalDef")}
          value={personal}
        />
        <StatTile
          label={t("metrics.installation.dormant")}
          definition={t("metrics.installation.dormantDef")}
          value={known.length > 0 ? dormant : null}
        />
      </Band>
      <ChartCard
        title={t("metrics.installation.largest")}
        period={t("metrics.installation.largestPeriod")}
        definition={t("metrics.installation.largestDef")}
        state={known.length === 0 ? "error" : top.some((w) => w.factsLive! > 0) ? "ready" : "empty"}
        emptyText={t("metrics.browser.mixEmpty")}
      >
        <BarList
          label={t("metrics.installation.largest")}
          items={top.map((w) => ({
            name: w.lastWriteAt
              ? t("metrics.workspaces.lastWrite", {
                  name: w.name,
                  date: formatDate(locale, w.lastWriteAt, "short"),
                })
              : w.name,
            value: w.factsLive!,
          }))}
        />
      </ChartCard>
    </div>
  );
}

export interface SecurityStats {
  days: Array<{ day: string; count: number }>;
  byAction: Group[];
  failedSignIns7d: number;
}

/** GET /instance/audit/stats; null when the payload is not one. */
export function parseSecurityStats(v: unknown): SecurityStats | null {
  if (!rec(v) || !Array.isArray(v.days) || !num(v.failedSignIns7d)) return null;
  const days: SecurityStats["days"] = [];
  for (const d of v.days) {
    if (!rec(d) || !str(d.day) || !num(d.count)) return null;
    days.push({ day: d.day, count: d.count });
  }
  return { days, byAction: groups(v.byAction, "action"), failedSignIns7d: v.failedSignIns7d };
}

/**
 * Installation › Security audit in figures, from /instance/audit/stats (the whole window):
 * events in 30 days, failed sign-ins in 7, the commonest action; then events per day.
 */
export function SecurityFigures({ t, stats }: { t: T; stats: SecurityStats | null }) {
  const total = stats?.days.reduce((n, d) => n + d.count, 0) ?? null;
  const first = stats?.byAction[0];
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={3}>
        <StatTile
          label={t("metrics.installation.events")}
          definition={t("metrics.installation.eventsDef")}
          value={total}
        />
        <StatTile
          label={t("metrics.installation.failed")}
          definition={t("metrics.installation.failedDef")}
          value={stats?.failedSignIns7d ?? null}
          href={stats?.failedSignIns7d ? "/installation/audit?action=login_failure" : undefined}
        />
        <StatTile
          label={t("metrics.installation.common")}
          definition={t("metrics.installation.commonDef")}
          value={first ? first.count : null}
          display={
            first ? labelOr(t, `installation.audit.actions.${first.name}`, first.name) : undefined
          }
          caption={first ? t("metrics.installation.times", { count: first.count }) : undefined}
        />
      </Band>
      <ChartCard
        title={t("metrics.installation.perDay")}
        period={t("metrics.last30")}
        definition={t("metrics.installation.perDayDef")}
        state={!stats ? "error" : total ? "ready" : "empty"}
        emptyText={t("metrics.installation.perDayEmpty")}
      >
        {stats && (
          <TimeSeries
            label={t("metrics.installation.perDay")}
            days={stats.days.map((d) => d.day)}
            series={[
              { name: t("metrics.installation.events"), values: stats.days.map((d) => d.count) },
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
