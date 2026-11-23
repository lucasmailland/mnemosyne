import { labelOr } from "@/components/badges";
import { Band } from "@/components/charts/band";
import { BarList } from "@/components/charts/bar-list";
import { ChartCard } from "@/components/charts/chart-card";
import { StatTile } from "@/components/charts/stat-tile";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import type { FactStatsFull } from "@/lib/metrics";

import type { WorkspaceMode } from "./page";

export interface Retention {
  internalDays: number;
  confidentialDays: number;
  restrictedDays: number;
  transcriptDays: number;
}

/** The learning mode's own thresholds (config.modeCounters says them in words). */
const PROMOTE = { facts: 50, entities: 5, days: 14 };

/**
 * How far a learning workspace is from production: the criterion nearest its threshold, as a
 * share and in words. Production is 1.
 */
export function graduation(
  mode: WorkspaceMode,
  now = Date.now()
): {
  share: number;
  key: "sessions" | "facts" | "entities" | "days";
  count: number;
  total: number;
} {
  const days = mode.startedAt
    ? Math.floor((now - new Date(mode.startedAt).getTime()) / 86_400_000)
    : 0;
  const options = [
    { key: "facts" as const, count: mode.factCount, total: PROMOTE.facts },
    { key: "entities" as const, count: mode.entityCount, total: PROMOTE.entities },
    { key: "days" as const, count: days, total: PROMOTE.days },
    ...(mode.promoteAt
      ? [{ key: "sessions" as const, count: mode.sessionCount, total: mode.promoteAt }]
      : []),
  ];
  const best = options.reduce((a, b) => (b.count / b.total > a.count / a.total ? b : a));
  return {
    ...best,
    share: mode.mode === "production" ? 1 : Math.min(best.count / best.total, 1),
  };
}

/**
 * The workspace's settings in figures: its mode and how near production it is, embeddings
 * indexed and how long transcripts are kept (admins), then live memories by sensitivity with the
 * retention window each tier is kept for.
 */
export function ConfigFigures({
  t,
  locale,
  mode,
  facts,
  retention,
  embeddings,
}: {
  t: T;
  locale: Locale;
  mode: WorkspaceMode | null;
  facts: FactStatsFull | null;
  retention: Retention | null;
  embeddings: { indexed: number; pending: number } | null;
}) {
  const grad = mode ? graduation(mode) : null;
  const embedded = embeddings ? embeddings.indexed + embeddings.pending : 0;
  const n = (v: number) => formatNumber(locale, v);
  const kept: Record<string, number | undefined> = {
    internal: retention?.internalDays,
    confidential: retention?.confidentialDays,
    restricted: retention?.restrictedDays,
  };
  return (
    <div className="mb-6 space-y-6">
      <Band title={t("metrics.title")} cols={4}>
        <StatTile
          label={t("config.mode")}
          definition={t("metrics.config.modeDef")}
          value={mode ? 0 : null}
          display={mode ? t(`metrics.config.${mode.mode}`) : undefined}
        />
        <StatTile
          label={t("metrics.config.graduation")}
          definition={t("metrics.config.graduationDef")}
          value={grad?.share ?? null}
          format="percent"
          meter={grad?.share}
          caption={
            !grad
              ? undefined
              : mode?.mode === "production"
                ? t("metrics.config.graduated")
                : t(`metrics.config.toward.${grad.key}`, {
                    count: n(grad.count),
                    total: n(grad.total),
                  })
          }
        />
        {embeddings && (
          <StatTile
            label={t("metrics.config.embeddings")}
            definition={t("home.tiles.embeddingsDef")}
            value={embedded > 0 ? embeddings.indexed / embedded : null}
            format="percent"
            meter={embedded > 0 ? embeddings.indexed / embedded : undefined}
            caption={t("home.tiles.embeddingsPending", { count: embeddings.pending })}
          />
        )}
        {retention && (
          <StatTile
            label={t("metrics.config.transcripts")}
            definition={t("metrics.config.transcriptsDef")}
            value={retention.transcriptDays}
            display={t("metrics.config.days", { count: retention.transcriptDays })}
          />
        )}
      </Band>
      <ChartCard
        title={t("metrics.config.bySensitivity")}
        period={t("metrics.liveNow")}
        definition={t("metrics.config.bySensitivityDef")}
        state={!facts ? "error" : facts.live > 0 ? "ready" : "empty"}
        emptyText={t("metrics.browser.mixEmpty")}
      >
        <BarList
          label={t("metrics.config.bySensitivity")}
          items={(facts?.bySensitivity ?? []).map((s) => {
            const tier = labelOr(t, `browser.sensitivity.${s.name}`, s.name);
            const days = kept[s.name];
            return {
              name:
                days != null
                  ? t("metrics.config.keptFor", {
                      tier,
                      days: t("metrics.config.days", { count: days }),
                    })
                  : tier,
              value: s.count,
            };
          })}
        />
      </ChartCard>
    </div>
  );
}
