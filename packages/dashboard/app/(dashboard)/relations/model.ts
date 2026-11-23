/** The graph payload (GET /graph), validated, plus the sizing and labelling rules of the sky. */

export type NodeKind = "entity" | "episode" | "decision";
export const NODE_KINDS: readonly NodeKind[] = ["entity", "episode", "decision"];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  entityKind?: string;
  label: string;
  description: string | null;
  mentionCount: number;
  factCount: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: number;
  provenance: string | null;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: Record<NodeKind | "relation", number>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** null when the payload is not a graph; callers show an error state. */
export function parseGraph(raw: unknown): Graph | null {
  if (!isRecord(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  const nodes: GraphNode[] = [];
  for (const n of raw.nodes) {
    if (!isRecord(n) || !str(n.id) || typeof n.label !== "string") return null;
    if (!NODE_KINDS.includes(n.kind as NodeKind)) return null;
    nodes.push({
      id: n.id,
      kind: n.kind as NodeKind,
      ...(typeof n.entityKind === "string" ? { entityKind: n.entityKind } : {}),
      label: n.label,
      description: typeof n.description === "string" ? n.description : null,
      mentionCount: num(n.mentionCount),
      factCount: num(n.factCount),
    });
  }
  const edges: GraphEdge[] = [];
  for (const e of raw.edges) {
    if (!isRecord(e) || !str(e.id) || !str(e.source) || !str(e.target) || !str(e.relation))
      return null;
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      relation: e.relation,
      confidence: num(e.confidence),
      provenance: typeof e.provenance === "string" ? e.provenance : null,
    });
  }
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const of = (kind: NodeKind) => nodes.filter((n) => n.kind === kind).length;
  return {
    nodes,
    edges,
    counts: {
      entity: num(meta.entityCount, of("entity")),
      episode: num(meta.episodeCount, of("episode")),
      decision: num(meta.decisionCount, of("decision")),
      // Stored relations only: the derived episode → entity lines are not relations.
      relation: num(meta.relationCount, edges.length) - edges.filter(isMention).length,
    },
  };
}

/**
 * Dashed = inferred, solid = stated. The server marks inferred edges with the
 * provenance "semantic_knn" (the includeSemantic overlay, relation
 * "semantically_related") or "inferred" (composition); stated ones carry
 * "user_stated" or nothing.
 */
export function isInferred(e: GraphEdge): boolean {
  return (
    e.provenance === "semantic_knn" ||
    e.provenance === "inferred" ||
    e.relation === "semantically_related"
  );
}

/**
 * An episode → entity line the server derives from the episode's facts (includeMentions):
 * drawn dotted and faint, never counted as a relation.
 */
export const isMention = (e: GraphEdge) => e.provenance === "episode_facts";

/** Mentions drive the size; a node nothing mentions falls back to its facts. */
export const nodeSize = (n: GraphNode) => (n.mentionCount > 0 ? n.mentionCount : n.factCount);
export const radius = (n: GraphNode) => 5 + Math.min(Math.sqrt(Math.max(nodeSize(n), 0)) * 2.5, 13);

export const MAX_NODES = 200;
export const MAX_LABELS = 60;

const SEGMENTER = new Intl.Segmenter();

/** A label as the reader sees it: at most 18 graphemes, so an emoji is never split. */
export function shortLabel(label: string) {
  const chars = Array.from(SEGMENTER.segment(label), (g) => g.segment);
  return chars.length > 18 ? chars.slice(0, 17).join("") + "…" : label;
}

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A node on the drawing (graph units): its centre and radius. */
export interface Disc {
  id: string;
  x: number;
  y: number;
  r: number;
}

/**
 * Labels that never cover one another or another node, in graph units. In priority order (the
 * caller passes the biggest nodes first), each label tries under its node, above it, to its right
 * and to its left; the first spot that hits no placed label, no other node and stays inside
 * `bounds` (the visible area) wins. A label with no free spot is left out: the node keeps its
 * accessible name and its card on click. `size` is the font size and `w` each label's measured
 * width; the result is each label's centre and baseline.
 */
export function placeLabels(
  items: Array<Disc & { w: number }>,
  nodes: Disc[],
  size: number,
  bounds: Bounds
): Map<string, { x: number; y: number }> {
  const gap = size / 3;
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const discs = nodes.map((n) => ({
    id: n.id,
    box: { x0: n.x - n.r, x1: n.x + n.r, y0: n.y - n.r, y1: n.y + n.r },
  }));
  const placed: Box[] = [];
  const out = new Map<string, { x: number; y: number }>();
  for (const it of items) {
    const half = it.w / 2;
    const side = it.r + gap + half;
    const candidates = [
      { x: it.x, y: it.y + it.r + size * 1.1 },
      { x: it.x, y: it.y - it.r - size * 0.35 },
      { x: it.x + side, y: it.y + size * 0.35 },
      { x: it.x - side, y: it.y + size * 0.35 },
    ];
    for (const c of candidates) {
      const box = { x0: c.x - half, x1: c.x + half, y0: c.y - size * 0.8, y1: c.y + size * 0.25 };
      if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1)
        continue;
      if (placed.some((b) => hits(b, box))) continue;
      if (discs.some((n) => n.id !== it.id && hits(n.box, box))) continue;
      placed.push({
        x0: box.x0 - gap / 2,
        x1: box.x1 + gap / 2,
        y0: box.y0 - gap / 2,
        y1: box.y1 + gap / 2,
      });
      out.set(it.id, c);
      break;
    }
  }
  return out;
}

/** What the page asks of the drawing, 2D or 3D. */
export interface SkyApi {
  /** Zoom in (f > 1) or out around the centre. */
  zoomBy(f: number): void;
  /** Frame every node. */
  fit(): void;
  /** Bring a node into view when it is off screen (the keyboard moved to it). */
  reveal(id: string): void;
}

export interface SkyProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The nodes that may carry a label (the biggest ones). */
  labelled: ReadonlySet<string>;
  selectedId: string | null;
  /** The node with keyboard focus: drawn with a focus ring. */
  ringId: string | null;
  width: number;
  height: number;
  paused: boolean;
  /** prefers-reduced-motion: drawn already settled, the camera jumps. */
  reduced: boolean;
  /** Changes with the graph on show (another neighbourhood): the camera frames it once it settles. */
  frame: string;
  colors: { ivory: string; electric: string };
  onSelect(id: string | null): void;
  onEnter(id: string): void;
  api: { current: SkyApi | null };
}

/** A second click on the same node within this many ms is a double click: enter it. */
export const DOUBLE_CLICK_MS = 350;
/** The simulation settles in about two seconds (d3 default 0.0228: five), so the camera frames it soon. */
export const ALPHA_DECAY = 0.05;
/** The simulation runs this long, then the camera frames it. */
export const SETTLE_MS = 3000;
/** The closest zoom, so a neighbourhood of three nodes is not framed at poster size. */
export const MAX_ZOOM = 2.5;
/** Camera moves, in ms (0 under reduced motion). */
export const CAMERA_MS = 600;
/** Simulation ticks computed before the first frame under reduced motion. */
export const SETTLE_TICKS = 300;
