"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { labelOr } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { SceneHeading } from "@/components/scene-heading";
import { InfoTip } from "@/components/ui/info-tip";
import { Segmented } from "@/components/ui/segmented";
import { BRAND_IMAGES } from "@/lib/brand/images";
import { useLocale, useT } from "@/lib/i18n/client";
import { formatNumber, type Locale, type T } from "@/lib/i18n/core";
import { loadFailure, loadSignal } from "@/lib/load";
import { ROOMS } from "@/lib/rooms";

import {
  MAX_LABELS,
  MAX_NODES,
  NODE_KINDS,
  isInferred,
  isMention,
  nodeSize,
  parseGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type SkyApi,
} from "./model";

/**
 * The constellation (spec §4 row V): GET /graph?includeSemantic=true&includeMentions=true drawn
 * by react-force-graph as ivory nodes and edges on the electric scene, alive: the forces settle
 * the nodes, which can be dragged; the wheel or a pinch zooms, a drag pans. Solid edges are
 * stated, dashed ones inferred by meaning, dotted ones go through an episode's facts. Size follows
 * mentions (facts when a node has none). An entity can be entered (its card's Enter button, or a
 * double click): the room then shows GET /graph?focus=<id>, its neighbourhood, under a trail that
 * leads back; Escape or Back return. 2D by default; 3D is downloaded when turned on.
 *
 * The canvas is not accessible by itself: the nodes are also a row of visually hidden buttons, one
 * tab stop (roving tabindex): arrow keys, Home and End move between nodes (the canvas rings the
 * focused one), Enter or Space selects, Escape clears; the selection is announced and its card
 * lists the node's relations. The List view (APP-058) drops the drawing for two tables, the same
 * nodes and relations under the same filter and cap, for a screen reader or anyone who reads.
 */

const room = ROOMS.find((r) => r.id === "graph")!;
const IVORY = "var(--brand-ivory)";
const MAX_RELATIONS = 8;
const SKY_MASK = "radial-gradient(circle at 68% 38%, #000 18%, transparent 72%)";
// Drawn width of the scene: page width minus the 244 px sidebar and the page padding.
const SKY_SIZES =
  "(min-width: 1024px) calc(100vw - 324px), (min-width: 768px) calc(100vw - 292px), 100vw";
/** The drawing before it is measured (and in tests, which cannot measure). */
const SCENE_GUESS = { width: 956, height: 440 };
/** Brand tokens for the canvas, which cannot read CSS variables: replaced by the live values. */
const BRAND = { ivory: "#f5ecde", electric: "#1a18f0" };

const Sky2D = dynamic(() => import("./sky-2d"), { ssr: false });
const Sky3D = dynamic(() => import("./sky-3d"), { ssr: false });

type State =
  { status: "loading" } | { status: "error"; body: string } | { status: "ok"; graph: Graph };

const media = (query: string, set: (on: boolean) => void) => {
  if (!window.matchMedia) return;
  const mq = window.matchMedia(query);
  const sync = () => set(mq.matches);
  sync();
  mq.addEventListener("change", sync);
  return () => mq.removeEventListener("change", sync);
};

export default function RelationsPage() {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<NodeKind | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The node whose hidden button has focus: the canvas draws its focus ring.
  const [ringId, setRingId] = useState<string | null>(null);
  // The entities entered, outermost first; the last one is on show.
  const [trail, setTrail] = useState<Array<{ id: string; label: string }>>([]);
  const [mode, setMode] = useState<"2d" | "3d" | "list">("2d");
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [wide, setWide] = useState(true);
  const [colors, setColors] = useState(BRAND);
  // The drawing's size on screen; null until measured.
  const [scene, setScene] = useState<{ width: number; height: number } | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const sky = useRef<SkyApi | null>(null);
  // Where focus goes once the next graph is on show: "back" (the Back button) or a node id.
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => media("(min-width: 1024px)", setWide), []);
  useEffect(() => media("(prefers-reduced-motion: reduce)", setReduced), []);
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    setColors({
      ivory: read("--brand-ivory", BRAND.ivory),
      electric: read("--brand-electric", BRAND.electric),
    });
  }, []);

  const focusId = trail.at(-1)?.id ?? null;
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    (async () => {
      try {
        const focus = focusId ? `focus=${encodeURIComponent(focusId)}&` : "";
        const res = await fetch(
          `/dashboard/api/graph?${focus}includeSemantic=true&includeMentions=true`,
          { signal: loadSignal() }
        );
        if (!live) return;
        if (!res.ok)
          return setState({ status: "error", body: t("graph.loadError", { status: res.status }) });
        const graph = parseGraph(await res.json());
        if (!live) return;
        setState(graph ? { status: "ok", graph } : { status: "error", body: t("graph.invalid") });
      } catch (e) {
        if (live) setState({ status: "error", body: loadFailure(t, e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [t, attempt, focusId]);

  const graph = state.status === "ok" ? state.graph : null;
  const view = useMemo(() => {
    if (!graph) return null;
    // The biggest nodes survive the cap.
    const nodes = graph.nodes
      .filter((n) => !kindFilter || n.kind === kindFilter)
      .sort((a, b) => nodeSize(b) - nodeSize(a))
      .slice(0, MAX_NODES);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const labelled = new Set(nodes.slice(0, MAX_LABELS).map((n) => n.id));
    return { nodes, edges, labelled };
  }, [graph, kindFilter]);

  const selected = view?.nodes.find((n) => n.id === selectedId) ?? null;
  const toggle = (id: string | null) => setSelectedId((cur) => (cur === id ? null : id));
  // Roving tabindex: the group is one tab stop, on the active node (the first when none is).
  const tabStop = view?.nodes.find((n) => n.id === activeId)?.id ?? view?.nodes[0]?.id;
  const relationCount = selected
    ? graph!.edges.filter((e) => e.source === selected.id || e.target === selected.id).length
    : 0;

  // Whole pixels, so sub-pixel jitter never resizes the canvas.
  const measure = useCallback(() => {
    const el = sceneRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = { width: Math.round(r.width), height: Math.round(r.height) };
    setScene((cur) => (cur && cur.width === next.width && cur.height === next.height ? cur : next));
  }, []);
  useEffect(() => {
    const el = sceneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // The drawing band shrinks when the graph arrives (the counts, the trail, the controls and the
  // legend take their bands): measure again before that paint.
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "undefined") measure();
  }, [state.status, trail.length, measure]);
  // Without ResizeObserver (tests) the drawing cannot be measured: draw at the guess.
  const size = scene ?? (typeof ResizeObserver === "undefined" ? SCENE_GUESS : null);

  // Stacked layout: the card sits below the scene, so bring it into view (focus stays put).
  useEffect(() => {
    if (!selectedId || wide) return;
    cardRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [selectedId, wide, reduced]);

  // Closing from the card or the graph returns focus to the node that was selected; from
  // anywhere else (a chip, say) focus stays where it is.
  const clear = () => {
    const id = selectedId;
    setSelectedId(null);
    const at = document.activeElement;
    const inGraph =
      !at ||
      at === document.body ||
      !!cardRef.current?.contains(at) ||
      [...nodeRefs.current.values()].includes(at as HTMLButtonElement);
    if (id && inGraph) nodeRefs.current.get(id)?.focus();
  };
  const move = (from: number, key: string) => {
    const nodes = view!.nodes;
    const to =
      key === "Home"
        ? 0
        : key === "End"
          ? nodes.length - 1
          : key === "ArrowRight" || key === "ArrowDown"
            ? Math.min(from + 1, nodes.length - 1)
            : Math.max(from - 1, 0);
    const next = nodes[to]!;
    setActiveId(next.id);
    nodeRefs.current.get(next.id)?.focus();
    sky.current?.reveal(next.id);
  };

  // Entering an entity shows its neighbourhood; only entities have one (GET /graph?focus=).
  const enter = (id: string) => {
    const node = graph?.nodes.find((n) => n.id === id);
    if (!node || node.kind !== "entity" || id === focusId) return;
    pendingFocus.current = "back";
    setSelectedId(id);
    setTrail((cur) => [...cur, { id, label: node.label }]);
  };
  // Back to step `depth` of the trail (0: the whole constellation), the entity left selected.
  const backTo = (depth: number) => {
    const left = trail[depth];
    if (!left) return;
    pendingFocus.current = left.id;
    setSelectedId(left.id);
    setTrail(trail.slice(0, depth));
  };
  useEffect(() => {
    const target = pendingFocus.current;
    if (state.status !== "ok" || !target) return;
    pendingFocus.current = null;
    if (target === "back") backRef.current?.focus();
    else nodeRefs.current.get(target)?.focus();
  }, [state.status]);

  // A selection the view no longer draws (another kind, or past the node cap) is dropped, so it
  // does not come back on its own when the view changes again.
  useEffect(() => {
    if (selectedId && view && !view.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [view, selectedId]);
  const empty = graph !== null && graph.nodes.length === 0;
  const kindName = (k: NodeKind) => t(`graph.kind.${k}`);

  let overlay: ReactNode = null;
  if (state.status === "loading") {
    overlay = (
      <p role="status" className="text-ui">
        {t("graph.loading")}
      </p>
    );
  } else if (state.status === "error") {
    overlay = (
      <div className="bg-surface text-text">
        <ErrorState
          title={t("graph.errorTitle")}
          body={state.body}
          retry={() => setAttempt((n) => n + 1)}
        />
      </div>
    );
  } else if (empty) {
    overlay = (
      <div className="bg-surface text-text">
        <EmptyState title={t("graph.emptyTitle")} body={t("graph.empty")} />
      </div>
    );
  }

  const Sky = mode === "3d" ? Sky3D : Sky2D;
  return (
    <div
      className="relative w-full"
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (selectedId) clear();
        else if (trail.length) backTo(trail.length - 1);
      }}
    >
      {/* Three bands: the HUD (heading, counts, trail, controls) on top, the drawing, the legend
          at the bottom. */}
      <div className="sky-scene relative flex min-h-105 flex-col overflow-hidden lg:min-h-160">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            opacity: 0.24,
            mixBlendMode: "screen",
            WebkitMaskImage: SKY_MASK,
            maskImage: SKY_MASK,
          }}
        >
          <Image
            src={BRAND_IMAGES.constellation}
            alt=""
            fill
            sizes={SKY_SIZES}
            className="object-cover object-right"
          />
        </div>

        <div className="sky-hud relative flex flex-col gap-3 px-4 pt-4 lg:px-8 lg:pt-7">
          <SceneHeading room={room} className="max-w-lg" />
          {graph && (
            <p className="text-ui-xs" style={{ opacity: 0.85 }}>
              {t("graph.entities", { count: graph.counts.entity })} ·{" "}
              {t("graph.episodes", { count: graph.counts.episode })} ·{" "}
              {t("graph.decisions", { count: graph.counts.decision })} ·{" "}
              {t("graph.relations", { count: graph.counts.relation })}
            </p>
          )}
          {trail.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                ref={backRef}
                type="button"
                className="sky-tool"
                aria-label={t("graph.backTo", { name: trail.at(-2)?.label ?? t("graph.whole") })}
                onClick={() => backTo(trail.length - 1)}
              >
                <span aria-hidden="true">←</span>
                {t("graph.back")}
              </button>
              <nav aria-label={t("graph.trail")}>
                <ol className="text-ui-sm flex flex-wrap items-center gap-x-2">
                  {[{ id: "", label: t("graph.whole") }, ...trail].map((step, i, all) => (
                    <li key={step.id} className="flex items-center gap-2">
                      {i > 0 && <span aria-hidden="true">›</span>}
                      {i === all.length - 1 ? (
                        <span aria-current="page" className="font-medium">
                          {step.label}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="min-h-10 underline underline-offset-4"
                          onClick={() => backTo(i)}
                        >
                          {step.label}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </nav>
            </div>
          )}
          {graph && !empty && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Segmented
                label={t("graph.filterLabel")}
                hideLabel
                options={[
                  { value: "", label: t("common.all") },
                  ...NODE_KINDS.map((k) => ({ value: k, label: kindName(k) })),
                ]}
                value={kindFilter ?? ""}
                onChange={(v) => setKindFilter((v || null) as NodeKind | null)}
              />
              <Segmented
                label={t("graph.viewLabel")}
                hideLabel
                options={[
                  { value: "2d", label: "2D" },
                  { value: "3d", label: "3D" },
                  { value: "list", label: t("graph.list") },
                ]}
                value={mode}
                onChange={(v) => setMode(v as "2d" | "3d" | "list")}
              />
              {mode !== "list" && (
                <div role="group" aria-label={t("graph.controls")} className="flex gap-1">
                  <button
                    type="button"
                    className="sky-tool"
                    aria-label={t("graph.zoomOut")}
                    onClick={() => sky.current?.zoomBy(1 / 1.5)}
                  >
                    <span aria-hidden="true">−</span>
                  </button>
                  <button
                    type="button"
                    className="sky-tool"
                    aria-label={t("graph.zoomIn")}
                    onClick={() => sky.current?.zoomBy(1.5)}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                  <button type="button" className="sky-tool" onClick={() => sky.current?.fit()}>
                    {t("graph.fit")}
                  </button>
                  {!reduced && (
                    <button
                      type="button"
                      className="sky-tool"
                      aria-pressed={paused}
                      onClick={() => setPaused((p) => !p)}
                    >
                      {t("graph.pause")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div ref={sceneRef} className="relative min-h-80 flex-1">
          {view && !empty && mode === "list" && (
            <GraphList
              t={t}
              locale={locale}
              nodes={view.nodes}
              edges={view.edges}
              kindName={kindName}
              selectedId={selectedId}
              onSelect={toggle}
            />
          )}
          {view && !empty && mode !== "list" && size && (
            <div
              data-testid="sky-graph"
              role="group"
              aria-label={t("graph.svgLabel")}
              aria-describedby="sky-hint"
              className="absolute inset-0"
            >
              <div aria-hidden="true" className="absolute inset-0">
                <Sky
                  nodes={view.nodes}
                  edges={view.edges}
                  labelled={view.labelled}
                  selectedId={selectedId}
                  ringId={ringId}
                  width={size.width}
                  height={size.height}
                  paused={paused}
                  reduced={reduced}
                  frame={`${focusId ?? ""}|${kindFilter ?? ""}|${mode}`}
                  colors={colors}
                  onSelect={toggle}
                  onEnter={enter}
                  api={sky}
                />
              </div>
              {view.nodes.map((n, i) => (
                <button
                  key={n.id}
                  ref={(el) => {
                    if (el) nodeRefs.current.set(n.id, el);
                    else nodeRefs.current.delete(n.id);
                  }}
                  type="button"
                  className="sr-only"
                  tabIndex={n.id === tabStop ? 0 : -1}
                  aria-pressed={selectedId === n.id}
                  aria-label={t("graph.nodeLabel", { label: n.label, kind: kindName(n.kind) })}
                  onFocus={() => {
                    setActiveId(n.id);
                    setRingId(n.id);
                  }}
                  onBlur={() => setRingId(null)}
                  onClick={() => toggle(n.id)}
                  onKeyDown={(e) => {
                    if (
                      ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(
                        e.key
                      )
                    ) {
                      e.preventDefault();
                      move(i, e.key);
                    }
                  }}
                />
              ))}
            </div>
          )}

          {overlay && (
            <div data-testid="sky-overlay" className="relative z-10 p-4 lg:p-8">
              {overlay}
            </div>
          )}
        </div>

        {graph && !empty && mode !== "list" && (
          // lg:pr-96 keeps the legend clear of the node card, which sits bottom right.
          <div
            className="text-ui-xs relative flex flex-wrap items-center gap-x-5 gap-y-1 px-4 pb-4 lg:px-8 lg:pr-96 lg:pb-6"
            style={{ opacity: 0.9 }}
          >
            <Legend style="solid" label={t("graph.legendStated")} />
            <Legend style="dashed" label={t("graph.legendInferred")} />
            <Legend style="dotted" label={t("graph.legendMentions")} />
            <Legend style="double" label={t("graph.legendConflict")} />
            <InfoTip label={t("graph.legendSize")} text={t("graph.sizeHint")} />
          </div>
        )}
      </div>

      <p id="sky-hint" className="sr-only">
        {t("graph.hint")}
      </p>
      {graph && view && !empty && (
        // Past the node cap the cut is said visibly (APP-043); otherwise it is a reader's summary.
        <p
          className={
            view.nodes.length < graph.nodes.length
              ? "text-text-muted text-ui-xs px-4 pb-4 lg:px-8"
              : "sr-only"
          }
        >
          {t("graph.summary", {
            shown: formatNumber(locale, view.nodes.length),
            total: formatNumber(locale, graph.nodes.length),
            edges: formatNumber(locale, view.edges.length),
          })}
        </p>
      )}
      <p role="status" className="sr-only">
        {selected ? t("graph.selected", { name: selected.label, count: relationCount }) : ""}
      </p>

      {selected && graph && (
        <Card
          t={t}
          locale={locale}
          node={selected}
          graph={graph}
          kindName={kindName(selected.kind)}
          cardRef={cardRef}
          onClose={clear}
          onEnter={selected.kind === "entity" && selected.id !== focusId ? enter : null}
        />
      )}
    </div>
  );
}

/** A relation verb in words ("conflicts with"); an unknown verb prints as sent. */
const verb = (t: T, relation: string) => labelOr(t, `graph.relation.${relation}`, relation);

/** How an edge is known: through an episode's facts, or stated / inferred with its confidence. */
const how = (t: T, locale: Locale, e: GraphEdge) =>
  isMention(e)
    ? t("graph.throughFacts")
    : `${isInferred(e) ? t("graph.inferred") : t("graph.stated")} · ${formatNumber(locale, e.confidence, 2)}`;

/** A node's kind in words, with the entity's own kind ("entity · person"). */
const kindLine = (t: T, node: GraphNode, kindName: string) =>
  node.entityKind
    ? `${kindName} · ${labelOr(t, `browser.kind.${node.entityKind}`, node.entityKind)}`
    : kindName;

/**
 * The List view (APP-058): the drawn nodes and relations as two tables. A node's name selects
 * it, opening the same card as the drawing.
 */
function GraphList({
  t,
  locale,
  nodes,
  edges,
  kindName,
  selectedId,
  onSelect,
}: {
  t: T;
  locale: Locale;
  nodes: GraphNode[];
  edges: GraphEdge[];
  kindName: (k: NodeKind) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const labels = new Map(nodes.map((n) => [n.id, n.label]));
  const degree = new Map<string, number>();
  for (const e of edges)
    for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const num = (n: number) => formatNumber(locale, n);
  const th = "px-2 py-2 text-left font-medium";
  const td = "px-2 py-1 align-top";
  return (
    <div data-testid="sky-list" className="text-ui-sm space-y-6 px-4 pb-4 lg:px-8 lg:pr-96">
      <table className="w-full border-collapse">
        <caption className="eyebrow pb-2 text-left">{t("graph.listNodes")}</caption>
        <thead>
          <tr className="border-b border-current">
            <th scope="col" className={th}>
              {t("graph.colName")}
            </th>
            <th scope="col" className={th}>
              {t("graph.colKind")}
            </th>
            <th scope="col" className={th}>
              {t("graph.facts")}
            </th>
            <th scope="col" className={th}>
              {t("graph.mentions")}
            </th>
            <th scope="col" className={th}>
              {t("graph.colRelations")}
            </th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id}>
              <td className={td}>
                <button
                  type="button"
                  aria-pressed={selectedId === n.id}
                  onClick={() => onSelect(n.id)}
                  className="min-h-10 text-left underline underline-offset-4"
                >
                  {n.label}
                </button>
              </td>
              <td className={td}>{kindLine(t, n, kindName(n.kind))}</td>
              <td className={`${td} tabular-nums`}>{num(n.factCount)}</td>
              <td className={`${td} tabular-nums`}>{num(n.mentionCount)}</td>
              <td className={`${td} tabular-nums`}>{num(degree.get(n.id) ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full border-collapse">
        <caption className="eyebrow pb-2 text-left">{t("graph.listRelations")}</caption>
        <thead>
          <tr className="border-b border-current">
            <th scope="col" className={th}>
              {t("graph.colFrom")}
            </th>
            <th scope="col" className={th}>
              {t("graph.colRelation")}
            </th>
            <th scope="col" className={th}>
              {t("graph.colTo")}
            </th>
            <th scope="col" className={th}>
              {t("graph.colHow")}
            </th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e) => (
            <tr key={e.id}>
              <td className={td}>{labels.get(e.source) ?? e.source}</td>
              <td className={td}>{verb(t, e.relation)}</td>
              <td className={td}>{labels.get(e.target) ?? e.target}</td>
              <td className={`${td} font-mono text-mono-xs`}>{how(t, locale, e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({
  style,
  label,
}: {
  style: "solid" | "dashed" | "dotted" | "double";
  label: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <svg width="24" height="6" aria-hidden="true">
        <line
          x1="0"
          y1="3"
          x2="24"
          y2="3"
          stroke={IVORY}
          strokeWidth={style === "double" ? 5 : 2}
          strokeDasharray={style === "dashed" ? "5 4" : style === "dotted" ? "2 4" : undefined}
        />
        {style === "double" && (
          <line x1="0" y1="3" x2="24" y2="3" stroke="var(--brand-electric)" strokeWidth="2" />
        )}
      </svg>
      {label}
    </span>
  );
}

/** Paper on electric (Deep on Paper 18.5:1): kind, description, counts and the node's relations. */
function Card({
  t,
  locale,
  node,
  graph,
  kindName,
  cardRef,
  onClose,
  onEnter,
}: {
  t: T;
  locale: Locale;
  node: GraphNode;
  graph: Graph;
  kindName: string;
  cardRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Null when the node has no neighbourhood to enter (not an entity, or already entered). */
  onEnter: ((id: string) => void) | null;
}) {
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const rels = graph.edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => {
      const out = e.source === node.id;
      const otherId = out ? e.target : e.source;
      const vars = { relation: verb(t, e.relation), node: labels.get(otherId) ?? otherId };
      return {
        id: e.id,
        text: t(out ? "graph.relOut" : "graph.relIn", vars),
        how: how(t, locale, e),
      };
    });
  return (
    <aside
      ref={cardRef}
      data-testid="sky-card"
      aria-label={t("graph.nodeDetail")}
      className="sky-card border-border shadow-panel mt-4 max-h-100 space-y-3 overflow-y-auto border p-4 lg:absolute lg:right-6 lg:bottom-6 lg:mt-0 lg:w-80"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow" style={{ color: "var(--brand-electric)" }}>
            {kindLine(t, node, kindName)}
          </p>
          <h2 className="font-display text-display-6 leading-tight font-normal break-words">
            {node.label}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="text-ui-sm min-h-8 min-w-8 shrink-0"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {node.description && (
        <p className="text-ui-sm leading-relaxed" style={{ opacity: 0.75 }}>
          {node.description}
        </p>
      )}
      <dl className="text-ui-xs flex gap-6">
        <div>
          <dt style={{ opacity: 0.75 }}>{t("graph.facts")}</dt>
          <dd className="tabular-nums">{formatNumber(locale, node.factCount)}</dd>
        </div>
        <div>
          <dt style={{ opacity: 0.75 }}>{t("graph.mentions")}</dt>
          <dd className="tabular-nums">{formatNumber(locale, node.mentionCount)}</dd>
        </div>
      </dl>
      {rels.length === 0 ? (
        <p className="text-ui-xs" style={{ opacity: 0.75 }}>
          {t("graph.noRelations")}
        </p>
      ) : (
        <ul className="text-ui-xs space-y-1">
          {rels.slice(0, MAX_RELATIONS).map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <span className="min-w-0 break-words">{r.text}</span>
              <span className="font-mono text-mono-xs shrink-0" style={{ opacity: 0.75 }}>
                {r.how}
              </span>
            </li>
          ))}
          {rels.length > MAX_RELATIONS && (
            <li style={{ opacity: 0.75 }}>
              {t("graph.moreRelations", { count: rels.length - MAX_RELATIONS })}
            </li>
          )}
        </ul>
      )}
      <NodeLink t={t} node={node} />
      {onEnter && (
        <button
          type="button"
          onClick={() => onEnter(node.id)}
          aria-label={t("graph.enterLabel", { name: node.label })}
          className="bg-accent text-on-accent hover:bg-accent-hover text-ui-sm focus-visible:outline-accent min-h-10 px-4 font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t("graph.enter")} <span aria-hidden="true">→</span>
        </button>
      )}
    </aside>
  );
}

/**
 * Where the node lives (5.4): an episode opens its session; an entity, the catalog's entities
 * searched by its name (there is no entity page); a decision, the catalog's decisions.
 */
function NodeLink({ t, node }: { t: T; node: GraphNode }) {
  const [href, label] =
    node.kind === "episode"
      ? [`/sessions?open=${encodeURIComponent(node.id)}`, t("graph.openSession")]
      : node.kind === "entity"
        ? [
            `/browser?type=entities&q=${encodeURIComponent(node.label.slice(0, 200))}`,
            t("graph.openCatalog"),
          ]
        : ["/browser?type=decisions", t("graph.openCatalog")];
  return (
    <p className="text-ui-sm">
      <Link href={href} className="underline underline-offset-4">
        {label}
      </Link>
    </p>
  );
}
