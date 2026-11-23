import { labelOr } from "@/components/badges";
import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { StatTile } from "@/components/charts/stat-tile";
import type { T } from "@/lib/i18n/core";

import type { ApiKeyListItem } from "./page";

const DAY = 86_400_000;

/** Largest first, then by name. */
function tally(names: string[]): Array<{ name: string; value: number }> {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => ({ name, value }));
}

/**
 * The workspace's keys in figures, from the whole GET /admin/keys answer (every active key):
 * active, idle for 30 days, expiring within 30 days, rotated and in their grace period; then keys
 * by scope and by sensitivity ceiling.
 */
export function KeyFigures({
  t,
  keys,
  now = Date.now(),
}: {
  t: T;
  keys: ApiKeyListItem[] | null;
  now?: number;
}) {
  const within = (iso: string | null, days: number) =>
    iso != null &&
    new Date(iso).getTime() - now >= 0 &&
    new Date(iso).getTime() - now <= days * DAY;
  const idle = keys?.filter(
    (k) => !k.lastUsedAt || now - new Date(k.lastUsedAt).getTime() > 30 * DAY
  ).length;
  const state = !keys ? "error" : keys.length > 0 ? "ready" : "empty";
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("metrics.keys.active")}
          definition={t("metrics.keys.activeDef")}
          value={keys?.length ?? null}
        />
        <StatTile
          label={t("metrics.keys.idle")}
          definition={t("metrics.keys.idleDef")}
          value={idle ?? null}
        />
        <StatTile
          label={t("metrics.keys.expiring")}
          definition={t("metrics.keys.expiringDef")}
          value={keys?.filter((k) => within(k.expiresAt, 30)).length ?? null}
        />
        <StatTile
          label={t("metrics.keys.sunset")}
          definition={t("metrics.keys.sunsetDef")}
          value={keys?.filter((k) => k.deprecatedAt != null).length ?? null}
        />
      </Band>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={t("metrics.keys.byScope")}
          period={t("metrics.keys.byScopePeriod")}
          definition={t("metrics.keys.byScopeDef")}
          state={state}
          emptyText={t("keys.empty")}
        >
          <BarList
            label={t("metrics.keys.byScope")}
            items={tally(keys?.flatMap((k) => k.scopes) ?? []).slice(0, 5)}
          />
        </ChartCard>
        <ChartCard
          title={t("metrics.keys.byCeiling")}
          period={t("metrics.liveNow")}
          definition={t("metrics.keys.byCeilingDef")}
          state={state}
          emptyText={t("keys.empty")}
        >
          {keys && (
            <SegmentedBar
              label={t("metrics.keys.byCeiling")}
              parts={tally(
                keys.map((k) =>
                  k.maxSensitivity
                    ? labelOr(t, `browser.sensitivity.${k.maxSensitivity}`, k.maxSensitivity)
                    : t("metrics.keys.defaultCeiling")
                )
              )}
            />
          )}
        </ChartCard>
      </div>
    </div>
  );
}
