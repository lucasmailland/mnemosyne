import { formatValue } from "@/components/charts/format";
import { StatTile } from "@/components/charts/stat-tile";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";

import type { AdminStats, ContextEconomy } from "./types";

/** About 4 characters per token, the rule the server's methodology states. */
const CHARS_PER_TOKEN = 4;

/**
 * What memory saves (5.4): the context recall serves per call against the whole live memory a flat
 * file would inject every turn, and recall's precision. Admin only: /admin/stats sends `context` to
 * admins alone, so a member never gets the band. A figure the server could not measure says so,
 * never 0.
 */
export function ValueBand({
  t,
  locale,
  context,
  precisionAtK,
}: {
  t: T;
  locale: Locale;
  context: ContextEconomy;
  precisionAtK?: AdminStats["recall"]["precisionAtK"];
}) {
  const num = (n: number) => formatNumber(locale, Math.round(n));
  const pct = (n: number) => formatValue(locale, n, "percent");
  const notMeasured = t("home.value.notMeasured");
  const chars = (n: number | null) =>
    n == null ? notMeasured : t("home.value.chars", { value: num(n) });
  const { servedCharsAvg7d: avg, servedCharsP95_7d: p95, recalls7d, liveFactChars, liveFacts } =
    context;
  const shareOf = avg != null && liveFactChars ? avg / liveFactChars : null;
  const p3 = precisionAtK?.find((p) => p.k === 3) ?? precisionAtK?.[0];
  const others = precisionAtK
    ?.filter((p) => p !== p3 && p.precision != null)
    .map((p) => `p@${p.k} ${pct(p.precision!)}`)
    .join(" · ");

  return (
    <section aria-labelledby="home-value-title" data-testid="home-value">
      <h2 id="home-value-title" className="eyebrow mb-3">
        {t("home.value.title")}
      </h2>
      <div className="border-border bg-surface grid grid-cols-2 gap-x-6 gap-y-6 border p-4 sm:p-5 xl:grid-cols-4">
        <StatTile
          label={t("home.value.served")}
          definition={t("home.value.servedDef")}
          value={avg}
          display={chars(avg)}
          caption={
            avg != null && p95 != null && recalls7d != null
              ? t("home.value.servedCaption", { count: recalls7d, p95: num(p95) })
              : undefined
          }
        />
        <StatTile
          label={t("home.value.live")}
          definition={t("home.value.liveDef")}
          value={liveFactChars}
          display={chars(liveFactChars)}
          caption={
            liveFactChars != null && liveFacts != null
              ? t("home.value.liveCaption", {
                  count: liveFacts,
                  tokens: num(liveFactChars / CHARS_PER_TOKEN),
                })
              : undefined
          }
        />
        <StatTile
          label={t("home.value.share")}
          definition={t("home.value.shareDef")}
          value={shareOf}
          format="percent"
          display={shareOf == null ? notMeasured : undefined}
        />
        {p3 && (
          <StatTile
            label={t("home.value.precision", { k: p3.k })}
            definition={t("home.value.precisionDef")}
            value={p3.precision}
            format="percent"
            display={p3.precision == null ? notMeasured : undefined}
            caption={others || undefined}
          />
        )}
      </div>
    </section>
  );
}
