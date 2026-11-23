"use client";

// CLIENT renderer. Imports ONLY the client-safe @mnemo-ai/core/graph entry;
// the graph data arrives from the server component, so no database code or
// API key reaches the browser bundle. react-force-graph is canvas/WebGL and touches
// `window`, so it's pulled in via next/dynamic with ssr:false.
import dynamic from "next/dynamic";
import { useMemo, useRef, useState, useEffect } from "react";
import {
  ENTITY_KIND_COLOR,
  EDGE_STYLES,
  nodeRadius,
  NODE_RADIUS_MAX,
  defaultForceConfig,
  type GraphResponse,
  type GraphNode,
  type GraphEdge,
} from "@mnemo-ai/core/graph";

// Client-only dynamic imports. force-graph reaches for `window`/WebGL on load.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

type EdgeStyle = { color: string; dash: number[]; width: number };
const FALLBACK_EDGE: EdgeStyle = EDGE_STYLES.related;

// Resolve a node's color from the package's ENTITY_KIND_COLOR table. Entities
// key off entityKind (person/org/…); episodes & decisions key off kind.
function colorFor(node: GraphNode): string {
  const key = node.entityKind ?? node.kind;
  return ENTITY_KIND_COLOR[key] ?? ENTITY_KIND_COLOR.other ?? "#52525b";
}

// Force-graph node/link shapes (its data model) carrying our graph fields.
type FGNode = GraphNode & { val: number; color: string };
type FGLink = {
  source: string;
  target: string;
  relation: string;
  confidence: number;
  provenance: string | null;
  color: string;
  width: number;
};

export function MemoryGraph({ graph }: { graph: GraphResponse }) {
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  const { nodes, links } = useMemo(() => {
    const maxMentions = graph.nodes.reduce((m, n) => Math.max(m, n.mentionCount), 0);

    const nodes: FGNode[] = graph.nodes.map((n: GraphNode) => {
      // Node size from the package's nodeRadius() — entities scale by mention
      // count; episodes/decisions (mentionCount 0) get a floor bumped a touch
      // by factCount so a busy episode still reads as larger.
      const base = nodeRadius(n.mentionCount, maxMentions);
      const factBump = Math.min(n.factCount, 12) * 0.6;
      const r = Math.min(base + factBump, NODE_RADIUS_MAX);
      return { ...n, color: colorFor(n), val: r };
    });

    const links: FGLink[] = graph.edges.map((e: GraphEdge) => {
      const style: EdgeStyle =
        (EDGE_STYLES as Record<string, EdgeStyle>)[e.relation] ?? FALLBACK_EDGE;
      // Edge width from confidence (mirrors drawEdge in edge-canvas.ts).
      const width = style.width * (0.5 + e.confidence * 0.5);
      return {
        source: e.source,
        target: e.target,
        relation: e.relation,
        confidence: e.confidence,
        provenance: e.provenance,
        color: style.color,
        width,
      };
    });

    return { nodes, links };
  }, [graph]);

  // Wire the package's defaultForceConfig into the d3 force simulation so the
  // example proves the layout config is real and consumed.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const cfg = defaultForceConfig();
    fg.d3Force("charge")?.strength(cfg.chargeStrength);
    fg.d3Force("link")?.distance(cfg.linkDistance);
    fg.d3Force("center")?.strength?.(cfg.centerStrength);
    if (typeof fg.d3AlphaDecay === "function") fg.d3AlphaDecay(cfg.alphaDecay);
    fg.d3ReheatSimulation?.();
  }, [mode, nodes, links]);

  // react-force-graph's accessor callbacks are typed against its own generic
  // node/link shapes. Our objects carry every field at runtime, so we read
  // them through small casts at the accessor boundary and keep `common` typed
  // as the library's prop bag. The `any`-typed ref is the library's own
  // imperative handle (d3Force, d3ReheatSimulation, …).
  const asNode = (n: unknown) => n as FGNode;
  const asLink = (l: unknown) => l as FGLink;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const common: any = {
    ref: fgRef,
    graphData: { nodes, links },
    nodeId: "id",
    nodeLabel: (n: unknown) => {
      const x = asNode(n);
      return `${x.label} · ${x.kind}${x.entityKind ? ` (${x.entityKind})` : ""}`;
    },
    nodeColor: (n: unknown) => asNode(n).color,
    nodeVal: (n: unknown) => asNode(n).val,
    linkColor: (l: unknown) => asLink(l).color,
    linkWidth: (l: unknown) => asLink(l).width,
    linkLabel: (l: unknown) => {
      const x = asLink(l);
      return `${x.relation} · ${(x.confidence * 100).toFixed(0)}%`;
    },
    linkDirectionalArrowLength: 3.5,
    linkDirectionalArrowRelPos: 1,
    backgroundColor: "rgba(0,0,0,0)",
    height: 560,
  };

  return (
    <section>
      <Toolbar mode={mode} setMode={setMode} />
      <div
        style={{
          position: "relative",
          borderRadius: 16,
          overflow: "hidden",
          border: "1px solid rgba(138,152,255,0.18)",
          background: "rgba(3,6,12,0.35)",
          boxShadow: "0 24px 80px -40px rgba(34,211,238,0.35)",
        }}
      >
        {mode === "2d" ? <ForceGraph2D {...common} /> : <ForceGraph3D {...common} />}
        <Legend />
      </div>
    </section>
  );
}

function Toolbar({ mode, setMode }: { mode: "2d" | "3d"; setMode: (m: "2d" | "3d") => void }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      {(["2d", "3d"] as const).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              cursor: "pointer",
              padding: "7px 16px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: 0.5,
              color: active ? "#03060c" : "#c9d4ff",
              border: "1px solid rgba(138,152,255,0.3)",
              background: active
                ? "linear-gradient(90deg, #8a98ff, #22d3ee)"
                : "rgba(138,152,255,0.08)",
            }}
          >
            {m.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

// Legend keyed off the package's ENTITY_KIND_COLOR so it never drifts.
const LEGEND_KEYS: { key: string; label: string }[] = [
  { key: "person", label: "Person" },
  { key: "organization", label: "Organization" },
  { key: "project", label: "Project" },
  { key: "concept", label: "Concept" },
  { key: "place", label: "Place" },
  { key: "episode", label: "Episode" },
  { key: "decision", label: "Decision" },
];

function Legend() {
  return (
    <div
      style={{
        position: "absolute",
        left: 14,
        bottom: 14,
        display: "flex",
        flexWrap: "wrap",
        gap: "8px 14px",
        maxWidth: 360,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(3,6,12,0.6)",
        border: "1px solid rgba(138,152,255,0.18)",
        backdropFilter: "blur(8px)",
        fontSize: 12,
        color: "#c9d4ff",
      }}
    >
      {LEGEND_KEYS.map(({ key, label }) => (
        <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: ENTITY_KIND_COLOR[key] ?? "#52525b",
              boxShadow: `0 0 8px ${ENTITY_KIND_COLOR[key] ?? "#52525b"}`,
            }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
