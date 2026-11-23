import { labelOr } from "@/components/badges";
import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { SegmentedBar } from "@/components/charts/segmented-bar";
import { StatTile } from "@/components/charts/stat-tile";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import type { FactStatsFull, GraphStats } from "@/lib/metrics";

import { buildQuery, type Fact } from "./types";

/**
 * The catalog's figures: what it holds (memories, decisions, entities), what is pinned and what
 * no recall has served, then two charts: live memories by kind and sensitivity, and the five most
 * recalled. Counts come from /facts/stats and /graph/stats (both under the caller's ceiling); the
 * ranking is GET /facts sorted by hit count, so its top five are the real top five.
 */
export function CatalogFigures({
  t,
  locale,
  facts,
  graph,
  top,
}: {
  t: T;
  locale: Locale;
  facts: FactStatsFull | null;
  graph: GraphStats | null;
  top: Fact[] | null;
}) {
  const never = facts && facts.live > 0 ? facts.neverRecalled / facts.live : null;
  const recalled = top?.filter((f) => f.hitCount > 0) ?? [];
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={5}>
        <StatTile
          label={t("metrics.browser.live")}
          definition={t("metrics.browser.liveDef")}
          value={facts?.live ?? null}
        />
        <StatTile
          label={t("metrics.browser.decisions")}
          definition={t("metrics.browser.decisionsDef")}
          value={graph?.decisions ?? null}
          href="/browser?type=decisions"
        />
        <StatTile
          label={t("metrics.browser.entities")}
          definition={t("metrics.browser.entitiesDef")}
          value={graph?.entities ?? null}
          href="/browser?type=entities"
        />
        <StatTile
          label={t("metrics.browser.pinned")}
          definition={t("metrics.browser.pinnedDef")}
          value={facts?.pinned ?? null}
          href={facts?.pinned ? "/browser?pinned=true" : undefined}
        />
        <StatTile
          label={t("metrics.browser.never")}
          definition={t("metrics.browser.neverDef")}
          value={never}
          format="percent"
          caption={
            facts && facts.live > 0
              ? t("metrics.ofTotal", {
                  count: formatNumber(locale, facts.neverRecalled),
                  total: formatNumber(locale, facts.live),
                })
              : undefined
          }
        />
      </Band>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={t("metrics.browser.mix")}
          period={t("metrics.liveNow")}
          definition={t("metrics.browser.mixDef")}
          state={!facts ? "error" : facts.live > 0 ? "ready" : "empty"}
          emptyText={t("metrics.browser.mixEmpty")}
        >
          {facts && (
            <div className="space-y-5">
              <div>
                <p className="eyebrow" aria-hidden="true">
                  {t("metrics.browser.byKind")}
                </p>
                <SegmentedBar
                  label={t("metrics.browser.byKind")}
                  parts={facts.byKind.map((k) => ({
                    name: labelOr(t, `browser.kind.${k.name}`, k.name),
                    value: k.count,
                  }))}
                />
              </div>
              <div>
                <p className="eyebrow" aria-hidden="true">
                  {t("metrics.browser.bySensitivity")}
                </p>
                <SegmentedBar
                  label={t("metrics.browser.bySensitivity")}
                  parts={facts.bySensitivity.map((s) => ({
                    name: labelOr(t, `browser.sensitivity.${s.name}`, s.name),
                    value: s.count,
                  }))}
                />
              </div>
            </div>
          )}
        </ChartCard>
        <ChartCard
          title={t("metrics.browser.top")}
          period={t("metrics.browser.topPeriod")}
          definition={t("metrics.browser.topDef")}
          state={!top ? "error" : recalled.length > 0 ? "ready" : "empty"}
          emptyText={t("metrics.browser.topEmpty")}
        >
          <BarList
            label={t("metrics.browser.top")}
            items={recalled.map((f) => ({
              name: f.statement,
              value: f.hitCount,
              href: `/browser${buildQuery({ open: f.id })}`,
            }))}
          />
        </ChartCard>
      </div>
    </div>
  );
}
