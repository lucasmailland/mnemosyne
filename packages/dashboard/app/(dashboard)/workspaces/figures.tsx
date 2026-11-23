import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { formatDate, formatNumber, type Locale, type T } from "@/lib/i18n/core";

import type { MyWorkspaces } from "./workspaces-view";

/**
 * The person's workspaces in figures, from GET /my-workspaces (the whole list, each workspace's
 * memories under the session's ceiling): how many, the team workspaces owned against the limit,
 * the memories they hold; then live memories per workspace with its last write.
 */
export function WorkspaceFigures({
  t,
  locale,
  data,
}: {
  t: T;
  locale: Locale;
  data: MyWorkspaces;
}) {
  const n = (v: number) => formatNumber(locale, v);
  const known = data.workspaces.filter((w) => w.factsLive != null);
  const live = known.reduce((sum, w) => sum + w.factsLive!, 0);
  const ranked = [...known].sort((a, b) => b.factsLive! - a.factsLive!);
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={3}>
        <StatTile
          label={t("metrics.workspaces.count")}
          definition={t("metrics.workspaces.countDef")}
          value={data.workspaces.length}
        />
        <StatTile
          label={t("metrics.workspaces.owned")}
          definition={t("metrics.workspaces.ownedDef")}
          value={data.ownedTeamCount}
          meter={data.limit ? Math.min(data.ownedTeamCount / data.limit, 1) : undefined}
          caption={
            data.limit != null
              ? t("metrics.workspaces.ofLimit", {
                  count: n(data.ownedTeamCount),
                  limit: n(data.limit),
                })
              : t("metrics.workspaces.noLimit")
          }
        />
        <StatTile
          label={t("metrics.workspaces.live")}
          definition={t("metrics.workspaces.liveDef")}
          value={known.length > 0 ? live : null}
          caption={
            known.length > 0 && known.length < data.workspaces.length
              ? t("metrics.workspaces.partial", {
                  count: known.length,
                  total: data.workspaces.length,
                })
              : undefined
          }
        />
      </Band>
      <ChartCard
        title={t("metrics.workspaces.perWorkspace")}
        period={t("metrics.liveNow")}
        definition={t("metrics.workspaces.perWorkspaceDef")}
        state={known.length === 0 ? "error" : live > 0 ? "ready" : "empty"}
        emptyText={t("metrics.browser.mixEmpty")}
      >
        <BarList
          label={t("metrics.workspaces.perWorkspace")}
          items={ranked.map((w) => ({
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
