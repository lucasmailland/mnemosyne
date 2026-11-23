import Form from "next/form";
import Link from "next/link";

import { BackTo } from "@/components/back-to";
import { labelOr } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { CapNote, LoadMore } from "@/components/load-more";
import { formatDate, formatNumber } from "@/lib/i18n/core";
import { getLocale, getT, roomTitle } from "@/lib/i18n/server";
import { apiGet } from "@/lib/server-api";
import { ScrollIntoViewOnOpen } from "@/components/scroll-into-view-on-open";
import { FilterBar, SearchInput } from "@/components/ui/filter-bar";
import { FilterMenu } from "@/components/ui/filter-menu";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

import { parseFactStatsFull, parseGraphStats } from "@/lib/metrics";

import { CatalogFigures } from "./figures";
import { IndexCard } from "./index-card";
import { Plate, loadPlate } from "./plate";
import { buildQuery, type Fact } from "./types";

/**
 * Memory Browser (spec §4.2) — URL-driven so every filtered view is a
 * shareable deep link. Tabs: facts / decisions / entities, each a list of
 * index cards. Facts support kind, sensitivity, status, pinned, q filters +
 * keyset pagination. The open card is `?open=<id>`: the detail plate is
 * rendered on the server, so a link to any fact (closed ones included) is shareable.
 */

type Tab = "facts" | "decisions" | "entities";

interface Decision {
  id: string;
  kind: string;
  title: string;
  topicKey?: string | null;
  status: string;
  validFrom: string;
}

interface Entity {
  id: string;
  kind: string;
  name: string;
  description?: string | null;
  mentionCount?: number;
}

const TAB_LABEL = {
  facts: "browser.tabFacts",
  decisions: "browser.tabDecisions",
  entities: "browser.tabEntities",
} as const;

const FACT_KINDS = [
  "preference",
  "trait",
  "event",
  "relationship",
  "skill",
  "concern",
  "architecture",
  "bugfix",
  "config",
  "discovery",
  "policy",
  "process",
  "other",
];
const SENSITIVITIES = ["public", "internal", "confidential", "restricted"];

// DASH-1: /decisions and /entities have no cursor/nextCursor/total envelope
// (unlike /facts) — just a server-capped `limit`. So "Load more" here grows
// `limit` by PAGE_SIZE and re-fetches the top N, rather than paging forward
// from a cursor. Caps match each route's own zod `.max()` (decisions.ts,
// entities.ts) so "Load more" never sends a limit the server would 400 on.
const PAGE_SIZE = 25;
const DECISIONS_MAX_LIMIT = 500;
const ENTITIES_MAX_LIMIT = 200;

const NOTE = "border-border bg-surface text-text-muted text-ui-sm border px-4 py-6 text-center";

export const generateMetadata = roomTitle("browser");

export default async function BrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const t = await getT();
  const locale = await getLocale();
  const kindLabel = (kind: string) => labelOr(t, `browser.kind.${kind}`, kind);
  const statusLabel = (status: string) => labelOr(t, `browser.status.${status}`, status);
  const tab: Tab =
    params.type === "decisions" || params.type === "entities" ? params.type : "facts";
  const { kind, sensitivity, status, pinned, q, cursor, limit: limitParam } = params;
  const requestedLimit = Math.max(PAGE_SIZE, parseInt(limitParam ?? "", 10) || PAGE_SIZE);

  const base = { type: tab === "facts" ? undefined : tab, kind, sensitivity, status, pinned, q };

  // The room's figures, fetched alongside the tab's list (they do not depend on it).
  const figures = Promise.all([
    apiGet<unknown>("/facts/stats"),
    apiGet<unknown>("/graph/stats"),
    apiGet<{ items: Fact[] }>("/facts?status=active&sortBy=hit_count&order=desc&limit=5"),
  ]);

  let content: React.ReactNode;
  // The facts tab's match count, said at the end of the filter row.
  let total: number | null = null;

  if (tab === "facts") {
    const open = params.open;
    // The list and the open plate do not depend on each other: fetch them together.
    const [data, plateData] = await Promise.all([
      apiGet<{ items: Fact[]; nextCursor: string | null; total: number }>(
        "/facts" +
          buildQuery({
            kind,
            sensitivity,
            status: status ?? "active",
            pinned,
            q,
            cursor,
            limit: "25",
          })
      ),
      open ? loadPlate(open) : null,
    ]);
    // The list has no successor ids. Successors known on this page: the open plate is
    // superseded when it names a successor, and so is everything it supersedes. A forgotten
    // card among them reads as superseded; otherwise the server status stands.
    const supersededIds = new Set([
      ...(Array.isArray(plateData?.d.supersedesIds) ? plateData.d.supersedesIds : []),
      ...(plateData?.d.supersededById ? [plateData.d.id] : []),
    ]);
    const filtered = !!(kind || sensitivity || status || pinned || q || cursor);
    const keep = { ...base, cursor, limit: limitParam };
    total = data?.total ?? null;
    content = !data ? (
      <p className="text-text-muted text-ui-sm">{t("browser.loadFactsError")}</p>
    ) : data.items.length === 0 && !filtered && !open ? (
      <EmptyState title={t("browser.empty.title")} body={t("browser.empty.body")} />
    ) : (
      <div className={open ? "catalog-grid" : undefined}>
        <ScrollIntoViewOnOpen
          open={open}
          targetId="catalog-plate"
          headingId="catalog-statement"
          below={1024}
        />
        <div id="catalog-list">
          {/* Nothing open: the cards take the width, two across, instead of an empty plate. */}
          <ul
            aria-label={t("browser.listLabel")}
            className={open ? "space-y-2" : "grid gap-2 lg:grid-cols-2"}
          >
            {data.items.map((f, i) => {
              const shown =
                supersededIds.has(f.id) && f.status === "forgotten" ? "superseded" : f.status;
              return (
                <IndexCard
                  key={f.id}
                  index={i}
                  id={f.id}
                  kind={kindLabel(f.kind)}
                  tags={[
                    ...(shown !== "active" ? [statusLabel(shown)] : []),
                    ...(f.pinned ? [t("browser.pinned")] : []),
                  ]}
                  date={formatDate(locale, f.createdAt, "short")}
                  statement={f.statement}
                  closed={f.validTo !== null || f.status !== "active"}
                  href={`/browser${buildQuery({ ...keep, open: f.id })}`}
                  current={f.id === open}
                />
              );
            })}
          </ul>
          {data.items.length === 0 && (
            <p className={NOTE}>{filtered ? t("browser.noFacts") : t("browser.empty.title")}</p>
          )}
          {data.nextCursor && (
            <LoadMore
              href={`/browser${buildQuery({ ...base, open, cursor: data.nextCursor })}`}
              label={t("browser.nextPage")}
            />
          )}
        </div>
        {open && (
          <section
            id="catalog-plate"
            data-testid="catalog-plate"
            aria-label={t("browser.plate.label")}
            className="catalog-plate"
          >
            <BackTo href="#catalog-list" label={t("browser.plate.back")} className="lg:hidden" />
            <Plate
              data={plateData}
              hit={data.items.find((f) => f.id === open)}
              t={t}
              locale={locale}
            />
          </section>
        )}
      </div>
    );
  } else if (tab === "decisions") {
    const limit = Math.min(requestedLimit, DECISIONS_MAX_LIMIT);
    const data = await apiGet<{ items: Decision[] }>(
      "/decisions" + buildQuery({ limit: String(limit) })
    );
    content = !data ? (
      <p className="text-text-muted text-ui-sm">{t("browser.loadDecisionsError")}</p>
    ) : data.items.length === 0 ? (
      <p className={NOTE}>{t("browser.noDecisions")}</p>
    ) : (
      <>
        <ul aria-label={t("browser.tabDecisions")} className="space-y-2">
          {data.items.map((d, i) => (
            <IndexCard
              key={d.id}
              index={i}
              id={d.id}
              kind={kindLabel(d.kind)}
              tags={d.status !== "active" ? [statusLabel(d.status)] : []}
              date={formatDate(locale, d.validFrom, "short")}
              statement={d.title}
              topicKey={d.topicKey}
              closed={d.status !== "active"}
            />
          ))}
        </ul>
        {data.items.length >= limit &&
          (limit < DECISIONS_MAX_LIMIT ? (
            <LoadMore
              href={`/browser${buildQuery({ type: "decisions", limit: String(limit + PAGE_SIZE) })}`}
              label={t("browser.loadMore")}
            />
          ) : (
            <CapNote>{t("common.firstN", { count: formatNumber(locale, limit) })}</CapNote>
          ))}
      </>
    );
  } else {
    const limit = Math.min(requestedLimit, ENTITIES_MAX_LIMIT);
    // The bridge takes 1–200 characters.
    const entityQuery = q?.trim().slice(0, 200) || undefined;
    const data = await apiGet<{ items: Entity[] }>(
      "/entities" + buildQuery({ limit: String(limit), q: entityQuery })
    );
    content = !data ? (
      <p className="text-text-muted text-ui-sm">{t("browser.loadEntitiesError")}</p>
    ) : data.items.length === 0 ? (
      <p className={NOTE}>{t("browser.noEntities")}</p>
    ) : (
      <>
        <ul aria-label={t("browser.tabEntities")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {data.items.map((e, i) => (
            <IndexCard
              key={e.id}
              index={i}
              id={e.id}
              kind={kindLabel(e.kind)}
              tags={
                typeof e.mentionCount === "number"
                  ? [t("browser.mentions", { count: e.mentionCount })]
                  : []
              }
              statement={e.name}
              description={e.description}
              closed={false}
            />
          ))}
        </ul>
        {data.items.length >= limit &&
          (limit < ENTITIES_MAX_LIMIT ? (
            <LoadMore
              href={`/browser${buildQuery({ type: "entities", q: entityQuery, limit: String(limit + PAGE_SIZE) })}`}
              label={t("browser.loadMore")}
            />
          ) : (
            <CapNote>{t("common.firstN", { count: formatNumber(locale, limit) })}</CapNote>
          ))}
      </>
    );
  }

  const [rawFacts, rawGraph, rawTop] = await figures;

  return (
    <div className="w-full">
      <CatalogFigures
        t={t}
        locale={locale}
        facts={parseFactStatsFull(rawFacts)}
        graph={parseGraphStats(rawGraph)}
        top={Array.isArray(rawTop?.items) ? rawTop.items : null}
      />
      <div className="border-border mb-4 flex gap-1 border-b">
        {(["facts", "decisions", "entities"] as const).map((tabKey) => (
          <Link
            key={tabKey}
            href={`/browser${buildQuery({
              type: tabKey === "facts" ? undefined : tabKey,
              q: tabKey === "decisions" ? undefined : q,
            })}`}
            aria-current={tab === tabKey ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center border-b-2 px-3 text-ui-sm",
              tab === tabKey
                ? "border-accent text-text font-medium"
                : "text-text-muted hover:text-text border-transparent"
            )}
          >
            {t(TAB_LABEL[tabKey])}
          </Link>
        ))}
      </div>

      {tab !== "decisions" && (
        // One row: search, Kind, Sensitivity, the count. A pick sends the form (client-side
        // navigation, the URL stays the source of truth); Enter in the search field does too.
        // Keyed by the filters, so Clear or a back step shows the URL's values, not stale ones.
        <div key={JSON.stringify({ tab, kind, sensitivity, q })} className="mb-4">
          <Form action="/browser">
            {tab !== "facts" && <input type="hidden" name="type" value={tab} />}
            <FilterBar
              label={t("browser.filtersLabel")}
              search={
                <SearchInput
                  name="q"
                  defaultValue={q ?? ""}
                  aria-label={t("browser.searchPlaceholder")}
                  placeholder={t("browser.searchPlaceholder")}
                />
              }
              active={[q, ...(tab === "facts" ? [kind, sensitivity] : [])].filter(Boolean).length}
              clearHref={`/browser${buildQuery({ type: tab === "facts" ? undefined : tab })}`}
              count={
                total != null && (
                  <span className="inline-flex items-center gap-1">
                    {t("browser.matches", { count: total })}
                    <InfoTip label={t("browser.plate.label")} text={t("browser.plate.prompt")} />
                  </span>
                )
              }
            >
              {tab === "facts" && (
                <>
                  <FilterMenu
                    label={t("browser.filterKind")}
                    name="kind"
                    options={FACT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
                    defaultValue={kind ? [kind] : []}
                    submitOnChange
                  />
                  <FilterMenu
                    label={t("browser.filterSensitivity")}
                    name="sensitivity"
                    options={SENSITIVITIES.map((v) => ({
                      value: v,
                      label: labelOr(t, `browser.sensitivity.${v}`, v),
                    }))}
                    defaultValue={sensitivity ? [sensitivity] : []}
                    submitOnChange
                  />
                </>
              )}
            </FilterBar>
          </Form>
        </div>
      )}

      {content}
    </div>
  );
}
