"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";

import { KindPill, labelOr } from "@/components/badges";
import { ErrorState } from "@/components/error-state";
import { HatchPattern } from "@/components/hatch";
import { FilterMenu } from "@/components/ui/filter-menu";
import { Chevron, popButton, usePopover } from "@/components/ui/popover";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatDate, formatNumber } from "@/lib/i18n/core";
import { errorMessage } from "@/lib/i18n/errors";
import { loadFailure, loadSignal } from "@/lib/load";
import { RUN_RECALL, takeRecall } from "@/lib/palette-items";
import { shortId } from "@/lib/short-id";

import {
  belowFloor,
  EXPLAIN_LIMIT,
  HIT_PREVIEW_CHARS,
  KINDS,
  errorCode,
  TOP_KS,
  parseExplain,
  parseRecall,
  strength,
  type Hit,
  type Recall,
  type Why,
} from "./model";

/**
 * Recall (spec §4 row III), the waters of Lethe: a query runs only on an explicit
 * submit. The pipeline strip comes from debug.trace; the per-hit "why" comes from one
 * /recall/explain call per query, made on the first expand and matched by hit id.
 */

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; body: string }
  | { status: "ok"; recall: Recall; query: string; narrowed: boolean };
type Explain =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; body: string }
  | { status: "ready"; byId: Map<string, Why> };
type Num = (n: number, digits?: number) => string;

/**
 * Keeps only `q` in the address, in place. Not router.replace: the page segment's key carries the
 * search params, so a navigation remounts this page and drops the result it just drew.
 */
function keepQuery(q: string) {
  window.history.replaceState(null, "", `?q=${encodeURIComponent(q)}`);
}

export default function RecallPage() {
  const t = useT();
  const locale = useLocale();
  const num: Num = (n, digits) => formatNumber(locale, n, digits);
  const params = useSearchParams();
  const urlQuery = params?.get("q") ?? "";
  const urlRun = params?.get("run") === "1";
  const [query, setQuery] = useState(urlQuery);
  const [topK, setTopK] = useState(TOP_KS[0]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [asOf, setAsOf] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [explain, setExplain] = useState<Explain>({ status: "idle" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Bumped on every run so a late answer for an older query is ignored.
  const runId = useRef(0);
  const explaining = useRef(false);

  const run = useCallback(
    async (override?: string) => {
      const text = (override ?? query).trim();
      if (!text) return;
      const id = ++runId.current;
      explaining.current = false;
      setExplain({ status: "idle" });
      setOpen(new Set());
      setState({ status: "loading" });
      const body = {
        query: text,
        topK,
        ...(kinds.length > 0 ? { kinds } : {}),
        ...(asOf ? { asOf: `${asOf}T23:59:59.999Z` } : {}),
        debug: true,
      };
      try {
        const res = await fetch("/dashboard/api/recall", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: loadSignal(),
        });
        if (id !== runId.current) return;
        if (!res.ok) {
          const code = await errorCode(res);
          if (id !== runId.current) return;
          return setState({ status: "error", body: errorMessage(t, { status: res.status, code }) });
        }
        const recall = parseRecall(await res.json());
        if (id !== runId.current) return;
        // Explain covers the query alone, top EXPLAIN_LIMIT: kinds, a date or a longer list narrow past it.
        const narrowed = kinds.length > 0 || !!asOf || topK > EXPLAIN_LIMIT;
        setState(
          recall
            ? { status: "ok", recall, query: text, narrowed }
            : { status: "error", body: t("recall.invalid") }
        );
      } catch (e) {
        if (id === runId.current) setState({ status: "error", body: loadFailure(t, e) });
      }
    },
    [query, topK, kinds, asOf, t]
  );

  // ⌘K → ⌘↵ arrives as /recall?q=…&run=1 with the palette's one-shot token for q: run that
  // query once (the ref also covers StrictMode's double effect), then drop `run` from the URL
  // and keep `q`. Without the token (a bare link) it only prefills: recall is metered.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!urlRun) {
      handled.current = null;
      return;
    }
    if (handled.current === urlQuery) return;
    handled.current = urlQuery;
    setQuery(urlQuery);
    if (!takeRecall(urlQuery)) return;
    void run(urlQuery);
    keepQuery(urlQuery);
  }, [urlRun, urlQuery, run]);

  // ⌘↵ from the palette while this page is open: run that query once, keep q, drop `run`.
  useEffect(() => {
    const onRun = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      setQuery(text);
      void run(text);
      keepQuery(text);
    };
    window.addEventListener(RUN_RECALL, onRun);
    return () => window.removeEventListener(RUN_RECALL, onRun);
  }, [run]);

  // One call per query: the first expand asks, later ones reuse the answer.
  const loadExplain = useCallback(
    async (text: string) => {
      if (explaining.current) return;
      explaining.current = true;
      const id = runId.current;
      setExplain({ status: "loading" });
      let byId: Map<string, Why> | null = null;
      let failure = t("recall.invalid");
      try {
        const res = await fetch("/dashboard/api/recall/explain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: text, limit: EXPLAIN_LIMIT }),
          signal: loadSignal(),
        });
        if (res.ok) byId = parseExplain(await res.json());
        else failure = errorMessage(t, { status: res.status, code: await errorCode(res) });
      } catch (e) {
        failure = loadFailure(t, e);
      }
      if (id !== runId.current) return;
      if (!byId) explaining.current = false;
      setExplain(byId ? { status: "ready", byId } : { status: "failed", body: failure });
    },
    [t]
  );

  const toggleWhy = (hitId: string) => {
    if (state.status !== "ok") return;
    const next = new Set(open);
    if (next.has(hitId)) next.delete(hitId);
    else {
      next.add(hitId);
      if (explain.status === "idle") void loadExplain(state.query);
    }
    setOpen(next);
  };
  const retryExplain = () => {
    if (state.status !== "ok") return;
    explaining.current = false;
    void loadExplain(state.query);
  };

  const busy = state.status === "loading";
  const best = state.status === "ok" ? Math.max(...state.recall.hits.map((h) => h.score)) : 0;
  // What the status region says (WCAG 4.1.3). An error is said once, by the ErrorState's alert.
  const said =
    state.status === "loading"
      ? t("recall.running")
      : state.status !== "ok"
        ? ""
        : state.recall.hits.length === 0
          ? t("recall.nothing")
          : state.recall.nothingRelevant
            ? `${t("recall.results", { count: state.recall.hits.length })}. ${t("recall.nothingRelevant")}`
            : t("recall.results", { count: state.recall.hits.length });

  return (
    <div className="w-full">
      <p role="status" className="sr-only">
        {said}
      </p>
      {/* One row: the query, Kinds, Options (as of, how many) and Run; it wraps on a phone. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          required
          aria-label={t("recall.placeholder")}
          placeholder={t("recall.placeholder")}
          className="border-control-border bg-surface placeholder:text-text-faint text-ui min-h-11 min-w-0 flex-1 basis-72 border px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <FilterMenu
          label={t("recall.kindsLabel")}
          multiple
          options={KINDS.map((k) => ({
            value: k,
            label: t(`recall.kindName.${k}` as "recall.kindName.fact"),
          }))}
          value={kinds}
          onChange={setKinds}
        />
        <Options asOf={asOf} setAsOf={setAsOf} topK={topK} setTopK={setTopK} />
        <button
          type="submit"
          disabled={busy || query.trim().length === 0}
          className="bg-accent text-on-accent text-ui-sm min-h-11 px-5 font-medium disabled:opacity-50"
        >
          {busy ? t("recall.running") : t("recall.run")}
        </button>
      </form>

      {state.status === "error" && (
        <div className="mt-6">
          <ErrorState title={t("recall.errorTitle")} body={state.body} retry={() => void run()} />
        </div>
      )}

      {state.status === "ok" && (
        <>
          {state.recall.trace.length > 0 && <Pipeline recall={state.recall} num={num} />}
          <section className="mt-8">
            <h2 className="eyebrow mb-3">
              {t("recall.results", { count: state.recall.hits.length })}
            </h2>
            {state.recall.hits.length === 0 ? (
              <p className="text-text-muted text-ui border-border border px-4 py-6 text-center">
                {t("recall.nothing")}
              </p>
            ) : (
              <>
                {state.recall.nothingRelevant && (
                  <p className="text-text-muted text-ui-sm mb-3">{t("recall.nothingRelevant")}</p>
                )}
                {(() => {
                  // Hits below the floor wait behind a closed disclosure, unless none on this
                  // page clears it (nothing relevant, or what does clear it is off this page):
                  // then the closest results are all there is, shown dimmed, never a bare fold.
                  const recall = state.recall;
                  const ranked = recall.hits.map((h, i) => ({ h, rank: i + 1 }));
                  const below = ranked.filter(({ h }) => belowFloor(h, recall));
                  const hidden = below.length < ranked.length ? below : [];
                  const shown = ranked.filter((r) => !hidden.includes(r));
                  const rows = (list: typeof ranked) =>
                    list.map(({ h, rank }) => (
                      <HitRow
                        key={h.id}
                        hit={h}
                        rank={rank}
                        best={best}
                        below={belowFloor(h, recall)}
                        open={open.has(h.id)}
                        onToggle={() => toggleWhy(h.id)}
                        explain={explain}
                        narrowed={state.narrowed}
                        retry={retryExplain}
                        num={num}
                      />
                    ));
                  return (
                    <>
                      {shown.length > 0 && <ol className="space-y-3">{rows(shown)}</ol>}
                      {hidden.length > 0 && (
                        <details data-testid="lethe-below" className="mt-4">
                          <summary className="text-accent text-ui-sm focus-visible:outline-accent inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4 focus-visible:outline-2">
                            {t("recall.belowFloor", {
                              count: hidden.length,
                              floor: num(recall.relevanceFloor ?? 0, 2),
                            })}
                          </summary>
                          <ol className="mt-3 space-y-3">{rows(hidden)}</ol>
                        </details>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * The query's options behind one button: the day to recall as of and how many results. The button
 * says what differs from the defaults ("Options: Top 50 · as of Aug 12").
 */
function Options({
  asOf,
  setAsOf,
  topK,
  setTopK,
}: {
  asOf: string;
  setAsOf: (v: string) => void;
  topK: number;
  setTopK: (v: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const { buttonProps, panelProps } = usePopover();
  const changed = [
    ...(topK !== TOP_KS[0] ? [t("recall.topK", { count: topK })] : []),
    ...(asOf ? [t("recall.asOfDay", { date: formatDate(locale, asOf, "day") })] : []),
  ];
  const field =
    "border-control-border bg-surface-2 text-text text-ui-sm min-h-10 w-full border px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return (
    <>
      <button
        {...buttonProps}
        aria-haspopup="dialog"
        className={`${popButton} ${
          changed.length
            ? "border-accent text-text"
            : "border-control-border text-text-muted hover:border-accent hover:text-text"
        }`}
      >
        <span>
          {t("ui.options")}
          {changed.length > 0 && (
            <>
              : <span className="font-medium">{changed.join(" · ")}</span>
            </>
          )}
        </span>
        <Chevron />
      </button>
      <div {...panelProps} role="dialog" aria-label={t("ui.options")} className="pop w-64 p-3">
        <div className="flex flex-col gap-3">
          <label htmlFor={`${id}-as-of`} className="text-text-muted text-ui-xs flex flex-col gap-1">
            {t("recall.asOfLabel")}
            <input
              id={`${id}-as-of`}
              data-autofocus
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className={field}
            />
          </label>
          <label htmlFor={`${id}-top-k`} className="text-text-muted text-ui-xs flex flex-col gap-1">
            {t("recall.topKLabel")}
            <select
              id={`${id}-top-k`}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className={field}
            >
              {TOP_KS.map((n) => (
                <option key={n} value={n}>
                  {t("recall.topK", { count: n })}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </>
  );
}

function Pipeline({ recall, num }: { recall: Recall; num: Num }) {
  const t = useT();
  const total = recall.latencyMs ?? recall.trace.reduce((sum, s) => sum + s.ms, 0);
  const counts = (n: number | null) => (n === null ? "—" : num(n));
  return (
    <section className="mt-8">
      <h2 className="eyebrow mb-3">{t("recall.pipelineTitle")}</h2>
      <div
        role="region"
        aria-label={t("recall.pipelineLabel")}
        tabIndex={0}
        className="border-border bg-surface relative overflow-x-auto border"
      >
        {/* Rendered in server order: the server emits the stages in canonical order (RecallTraceStage in @mnemo-ai/types). */}
        <ol data-testid="lethe-strip" className="lethe-strip">
          {recall.trace.map((s, i) => {
            const hidden = s.candidatesIn === null || s.candidatesOut === null;
            return (
              <li key={i} className="lethe-cell">
                <p className="text-ui-xs text-text-muted">
                  {labelOr(t, `recall.stage.${s.name}`, s.name)}
                </p>
                <p
                  className="text-ui-sm font-mono"
                  title={hidden ? t("recall.hiddenCount") : undefined}
                >
                  {counts(s.candidatesIn)} → {counts(s.candidatesOut)}
                  {hidden && <span className="sr-only"> {t("recall.hiddenCount")}</span>}
                </p>
                <p className="text-mono-xs text-text-faint font-mono">
                  {t("recall.ms", { ms: num(s.ms) })}
                </p>
              </li>
            );
          })}
          <li className="lethe-cell">
            <p className="text-ui-xs text-text-muted">{t("recall.stageTotal")}</p>
            <p className="text-ui-sm font-mono">{t("recall.ms", { ms: num(total) })}</p>
          </li>
        </ol>
      </div>
    </section>
  );
}

function HitRow({
  hit,
  rank,
  best,
  below,
  open,
  onToggle,
  explain,
  narrowed,
  retry,
  num,
}: {
  hit: Hit;
  rank: number;
  best: number;
  /** Under the relevance floor: dimmed. */
  below: boolean;
  open: boolean;
  onToggle: () => void;
  explain: Explain;
  narrowed: boolean;
  retry: () => void;
  num: Num;
}) {
  const t = useT();
  const locale = useLocale();
  const fill = Math.round(strength(hit, best) * 100);
  const hatch = useId();
  const date = hit.validFrom ? formatDate(locale, hit.validFrom, "short") : "";
  const panelId = `lethe-why-${encodeURIComponent(hit.id)}`;
  const [full, setFull] = useState(false);
  const long = hit.content.length > HIT_PREVIEW_CHARS;
  const text =
    long && !full ? `${hit.content.slice(0, HIT_PREVIEW_CHARS).trimEnd()}…` : hit.content;
  return (
    <li
      data-testid="lethe-hit"
      data-below={below || undefined}
      className={`border-border bg-surface enter border p-4 ${below ? "opacity-70" : ""}`}
      style={{ "--i": rank - 1 } as CSSProperties}
    >
      <div className="flex items-start gap-4">
        <span className="font-display text-display-6 text-accent w-8 shrink-0">
          <span className="sr-only">{t("recall.rank", { rank })}</span>
          <span aria-hidden="true">{rank}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="echo text-ui break-words">{text}</p>
          {long && (
            <button
              type="button"
              aria-expanded={full}
              onClick={() => setFull(!full)}
              className="text-accent text-ui-sm min-h-11 underline underline-offset-4"
            >
              {full ? t("recall.showLess") : t("recall.showAll")}
            </button>
          )}
          <div className="text-text-muted text-ui-xs mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <KindPill label={labelOr(t, `recall.kindName.${hit.primitive}`, hit.primitive)} />
            {hit.status && <span>{labelOr(t, `recall.status.${hit.status}`, hit.status)}</span>}
            {hit.hitFreshness && (
              <span>{labelOr(t, `recall.freshness.${hit.hitFreshness}`, hit.hitFreshness)}</span>
            )}
            {date && <span>{date}</span>}
            <span className="text-mono-xs font-mono" title={hit.id}>
              {shortId(hit.id)}
            </span>
            {hit.primitive === "fact" && (
              <Link
                href={`/browser?open=${encodeURIComponent(hit.id)}`}
                className="text-accent underline underline-offset-4"
              >
                {t("recall.openMemory")}
              </Link>
            )}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <div
              role="meter"
              aria-label={t("recall.scoreBar")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={fill}
              className="lethe-bar w-40 max-w-full"
            >
              <svg aria-hidden="true" width={`${fill}%`} height="100%" className="block">
                <defs>
                  <HatchPattern id={hatch} />
                </defs>
                <rect width="100%" height="100%" fill={`url(#${hatch})`} />
              </svg>
            </div>
            <span className="text-mono-xs text-text-muted font-mono">
              {hit.similarity !== undefined
                ? t("recall.similarity", { value: num(hit.similarity, 2) })
                : t("recall.score", { value: num(hit.score, 3) })}
            </span>
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={onToggle}
            className="text-accent text-ui-sm mt-3 min-h-11 underline underline-offset-4"
          >
            {t("recall.why")}
          </button>
          {open && (
            <div id={panelId} className="border-border-soft mt-2 border-t pt-3">
              <WhyPanel id={hit.id} explain={explain} narrowed={narrowed} retry={retry} num={num} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function WhyPanel({
  id,
  explain,
  narrowed,
  retry,
  num,
}: {
  id: string;
  explain: Explain;
  narrowed: boolean;
  retry: () => void;
  num: Num;
}) {
  const t = useT();
  if (explain.status === "idle" || explain.status === "loading")
    return <p className="text-text-muted text-ui-sm">{t("recall.whyLoading")}</p>;
  if (explain.status === "failed")
    return (
      <div className="text-ui-sm">
        <p className="text-text-muted">
          {t("recall.whyFailed")} {explain.body}
        </p>
        <button
          type="button"
          onClick={retry}
          className="text-accent mt-1 min-h-11 underline underline-offset-4"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  const why = explain.byId.get(id);
  if (!why)
    return (
      <p className="text-text-muted text-ui-sm">
        {narrowed
          ? t("recall.whyNarrowed", { limit: num(EXPLAIN_LIMIT) })
          : t("recall.whyUnmatched")}
      </p>
    );
  const yesNo = (v: boolean) => (v ? t("recall.yes") : t("recall.no"));
  const measured = (v: number | undefined) =>
    v === undefined ? t("recall.notMeasured") : num(v, 2);
  const rows: [string, string][] = [
    [t("recall.worth"), measured(why.worth)],
    [t("recall.worthLowerBound"), measured(why.worthLowerBound)],
    [t("recall.injection"), num(why.injectionScore, 2)],
    [t("recall.provenance"), labelOr(t, `recall.provenanceName.${why.provenance}`, why.provenance)],
    [t("recall.contested"), yesNo(why.contested)],
    [t("recall.hotTier"), yesNo(why.servedFromHotTier)],
    [t("recall.relations"), num(why.relationCount)],
  ];
  return (
    <dl className="lethe-why text-ui-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
