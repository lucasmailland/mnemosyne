import Form from "next/form";
import Link from "next/link";

import { AccessDenied } from "@/components/access-denied";
import { labelOr } from "@/components/badges";
import { RecordRow, Records, Section, StatusTag } from "@/components/keeper";
import { DateRangeMenu } from "@/components/ui/date-range-menu";
import { FilterBar, SearchInput } from "@/components/ui/filter-bar";
import { Segmented } from "@/components/ui/segmented";
import { auditPageQuery, dayEnd, dayStart, validDay } from "@/lib/audit-filters";
import { formatDate, formatNumber } from "@/lib/i18n/core";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { apiGet, apiRead } from "@/lib/server-api";

import { AuditFigures, parseAuditStats } from "./figures";

/**
 * Admin — Audit Log (spec §4.10): the undo-log feed (user forgets + system
 * archives) with actor/date/text filters. URL-driven → shareable deep links.
 */

interface AuditEntry {
  id: string;
  factId: string;
  factStatement: string;
  factSubject: string;
  factKind: string;
  action: "forgotten";
  actorKind: "user" | "system";
  actorName: string | null;
  timestamp: string;
  revertible: boolean;
}

/** The most the route returns in one answer (routes/audit.ts: limit max 100, no cursor). */
const AUDIT_LIMIT = 100;

const isEntry = (v: unknown): v is AuditEntry => {
  const e = v as Partial<AuditEntry> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.id === "string" &&
    typeof e.factStatement === "string" &&
    typeof e.timestamp === "string"
  );
};

/** The feed, validated at the edge: a wrong shape is a load error, never a crash. */
function parseFeed(v: unknown): { items: AuditEntry[]; total: number } | null {
  const d = v as { items?: unknown; total?: unknown } | null;
  if (typeof d !== "object" || d === null || !Array.isArray(d.items)) return null;
  const items = d.items.filter(isEntry);
  return { items, total: typeof d.total === "number" ? d.total : items.length };
}

export const generateMetadata = roomTitle("audit");

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { actorKind, from, to, q } = await searchParams;
  const [read, rawStats] = await Promise.all([
    apiRead<unknown>(
      "/audit" +
        auditPageQuery({
          limit: String(AUDIT_LIMIT),
          actorKind,
          // A hand-edited ?from=nope used to throw a RangeError here: only real days go out.
          from: dayStart(from),
          to: dayEnd(to),
          q,
        })
    ),
    apiGet<unknown>("/audit/stats?days=30"),
  ]);

  const t = await getT();
  const locale = await getLocale();
  if (read.status === 403) return <AccessDenied t={t} scope="memory:read" />;
  const data = parseFeed(read.data);
  return (
    <div className="w-full">
      <AuditFigures t={t} stats={parseAuditStats(rawStats)} />
      <Section title={t("audit.filtersTitle")} info={t("lead.adminAudit")}>
        {/* One row: search, actor, dates, the count. A GET form (client-side navigation), so the
            filters stay in the URL and a link shares the view; the actor applies on a pick, the
            dates with their Apply, the search with Enter. Keyed by the URL so Clear resets it. */}
        <div key={JSON.stringify({ actorKind, from, to, q })}>
          <Form action="/admin/audit">
            <FilterBar
              label={t("audit.filtersTitle")}
              search={
                <SearchInput
                  id="audit-q"
                  name="q"
                  defaultValue={q ?? ""}
                  aria-label={t("audit.search")}
                  placeholder={t("audit.search")}
                />
              }
              active={[actorKind, from || to, q].filter(Boolean).length}
              clearHref="/admin/audit"
              count={data ? t("audit.count", { count: data.total }) : undefined}
            >
              <Segmented
                label={t("audit.actor")}
                name="actorKind"
                options={[
                  { value: "", label: t("audit.actorAll") },
                  { value: "user", label: t("audit.actorUser") },
                  { value: "system", label: t("audit.actorSystem") },
                ]}
                defaultValue={actorKind === "user" || actorKind === "system" ? actorKind : ""}
                submitOnChange
              />
              <DateRangeMenu
                from={validDay(from) ? from : undefined}
                to={validDay(to) ? to : undefined}
              />
            </FilterBar>
          </Form>
        </div>
      </Section>

      <Section title={t("audit.entriesTitle")}>
        {!data ? (
          <p className="text-ui text-text-muted">
            {read.timedOut ? t("common.timeout") : t("audit.loadError")}
          </p>
        ) : data.items.length === 0 ? (
          <p className="border border-border bg-surface px-4 py-6 text-center text-ui text-text-muted">
            {t("audit.noEntries")}
          </p>
        ) : (
          <>
            {/* The route has no cursor: past its cap, say how much is left out (APP-043). */}
            {data.total > data.items.length && (
              <p className="text-ui-sm text-text-muted mb-2">
                {t("common.shownOf", {
                  shown: formatNumber(locale, data.items.length),
                  total: formatNumber(locale, data.total),
                })}
              </p>
            )}
            <Records label={t("audit.feedLabel")}>
              {data.items.map((entry) => (
                <RecordRow key={entry.id}>
                  <span className="w-36 shrink-0 font-mono text-mono text-text-muted">
                    {formatDate(locale, entry.timestamp, "datetime")}
                  </span>
                  <StatusTag tone={entry.actorKind === "user" ? "accent" : "neutral"}>
                    {entry.actorKind === "user" ? t("audit.actorUser") : t("audit.actorSystem")}
                  </StatusTag>
                  <span className="w-24 shrink-0 font-mono text-mono text-text-muted">
                    {labelOr(t, `browser.kind.${entry.factKind}`, entry.factKind)}
                  </span>
                  <span className="min-w-0 flex-1 text-ui">
                    {/* The entry names a fact: open it in the catalog (closed ones open too). */}
                    {entry.factId ? (
                      <Link
                        href={`/browser?open=${encodeURIComponent(entry.factId)}`}
                        className="hover:text-accent underline-offset-4 hover:underline"
                      >
                        {entry.factStatement}
                      </Link>
                    ) : (
                      entry.factStatement
                    )}
                  </span>
                  {entry.revertible && <StatusTag tone="good">{t("audit.revertible")}</StatusTag>}
                </RecordRow>
              ))}
            </Records>
          </>
        )}
      </Section>
    </div>
  );
}
