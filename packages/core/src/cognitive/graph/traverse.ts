// flatten-legacy-dual-core PR9f (design.md D6.5 "Graph — assembly-in-adapter,
// traversal-in-core"). Pure-core reimplementation of legacy
// `packages/core/src/graph/traverse.ts`'s `traverseRelations`/
// `findShortestPath` — same BFS semantics, same hop caps, same bitemporal/
// judgment filters, but looping `StorageAdapter.getRelations` per hop instead
// of a `WITH RECURSIVE` CTE.
//
// Cardinal hexagonal-purity rule (CLAUDE.md, enforced by v3-purity.test.ts):
// this file carries zero infrastructure package references — all I/O flows
// through the injected `getRelations` port method below, never a direct
// database client.
//
// Undirected traversal: `mnemo_relation` is one directed row per pair, but
// legacy treats it as undirected (`r.source_id = node OR r.target_id = node`).
// `RelationFilter.sourceIds` alone only matches the `source_id` column, so
// each hop issues TWO batched queries — `sourceIds` and `targetIds` — and
// merges them, reproducing the exact undirected semantics (see
// `RelationFilter.targetIds`'s doc comment in `@mnemo-ai/types`).
//
// `judgmentStatus <> 'dismissed'` has no direct `RelationFilter` equivalent
// (the filter is exact-match, not exclusion) — filtered client-side instead,
// same as legacy's SQL `WHERE ... judgment_status <> 'dismissed'`.

import type { StorageAdapter, RelationVerb, Sensitivity } from "@mnemo-ai/types";

/** Narrowed dependency set — only `getRelations` is needed for either function. */
export interface GraphTraverseDeps {
  storage: Pick<StorageAdapter, "getRelations">;
}

// Real (very generous) per-layer safety ceiling — mirrors routes/relations.ts's
// TRAVERSE-1 `TRAVERSE_LAYER_LIMIT`, a runaway guard scoped to one layer's
// actual fan-out, not a proxy for "how many relations has this workspace
// accumulated".
const TRAVERSE_LAYER_LIMIT = 2000;

/**
 * One BFS hop: fetch every relation touching any node in `frontier`
 * (undirected — both `sourceIds` and `targetIds` batched queries), excluding
 * dismissed judgments. Returns the raw matching relation rows.
 */
async function fetchLayer(
  deps: GraphTraverseDeps,
  workspaceId: string,
  frontier: string[],
  verbs: RelationVerb[] | undefined,
  asOf: Date | undefined,
  maxSensitivity: Sensitivity | undefined
): Promise<Array<{ sourceId: string; targetId: string; verb: string; judgmentStatus: string }>> {
  const base = {
    workspaceId,
    ...(verbs && verbs.length > 0 ? { verbs } : {}),
    // The current graph unless asked for a past one: a retracted or
    // hard-deleted edge is not traversed (PRIM-12 / PRIM-13).
    ...(asOf ? { validAt: asOf } : { openOnly: true }),
    limit: TRAVERSE_LAYER_LIMIT,
    // A node above the caller's ceiling has no edges for them, so the walk stops there.
    ...(maxSensitivity ? { maxSensitivity } : {}),
  };
  const [outgoing, incoming] = await Promise.all([
    deps.storage.getRelations({ ...base, sourceIds: frontier }),
    deps.storage.getRelations({ ...base, targetIds: frontier }),
  ]);
  return [...outgoing, ...incoming].filter((r) => r.judgmentStatus !== "dismissed");
}

export interface TraverseGraphOptions {
  /** Maximum hops from root (default 3, hard-capped at 6 — matches legacy's runaway guard). */
  maxHops?: number;
  /** Restrict to these relation verbs; empty/undefined = all. User-supplied strings pass through
   *  unvalidated (same as legacy) — an invalid verb simply matches zero relations, no write path
   *  involved, so the locked-verb CHECK constraint is never at risk on this read-only traversal. */
  relations?: string[];
  /** Reconstruct the graph as of this instant (default: now). */
  asOf?: Date;
  /** Per-hop relevance decay factor (default 0.6). */
  decay?: number;
  /** The caller's sensitivity ceiling: nodes above it are neither returned nor walked through. */
  maxSensitivity?: Sensitivity;
}

export interface TraverseGraphHit {
  id: string;
  hop: number;
  relevance: number;
}

/**
 * Multi-hop BFS from `rootId` over `mnemo_relation`, undirected, hop-capped.
 * Mirrors legacy `traverseRelations` exactly: same maxHops cap (min(opts,6)),
 * same decay formula (`decay^hop`), same dismissed/bitemporal filters. `rootId`
 * itself is never included in the result (matches legacy's `WHERE node_id <> root`).
 */
export async function traverseGraph(
  deps: GraphTraverseDeps,
  workspaceId: string,
  rootId: string,
  opts: TraverseGraphOptions = {}
): Promise<TraverseGraphHit[]> {
  const maxHops = Math.min(opts.maxHops ?? 3, 6);
  const decay = opts.decay ?? 0.6;
  const asOf = opts.asOf;
  const verbs = opts.relations as RelationVerb[] | undefined;

  const hopById = new Map<string, number>();
  const visited = new Set<string>([rootId]);
  let frontier = [rootId];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const rows = await fetchLayer(deps, workspaceId, frontier, verbs, asOf, opts.maxSensitivity);
    const frontierSet = new Set(frontier);
    const nextFrontier: string[] = [];

    for (const rel of rows) {
      const neighborId = frontierSet.has(rel.sourceId) ? rel.targetId : rel.sourceId;
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      hopById.set(neighborId, hop);
      nextFrontier.push(neighborId);
    }

    frontier = nextFrontier;
  }

  return [...hopById.entries()]
    .map(([id, hop]) => ({ id, hop, relevance: Math.pow(decay, hop) }))
    .sort((a, b) => a.hop - b.hop);
}

export interface GraphPathOptions {
  /** Maximum hops (default 4, hard-capped at 6 — matches legacy). */
  maxHops?: number;
  /** Reconstruct the graph as of this instant (default: now). */
  asOf?: Date;
  /** The caller's sensitivity ceiling: no path runs through a node above it. */
  maxSensitivity?: Sensitivity;
}

export interface GraphPathEdge {
  source: string;
  target: string;
  relation: string;
}

export interface GraphPathResult {
  /** Node ids from `from` to `to` inclusive. Empty if unreachable within maxHops. */
  path: string[];
  /** The relation verb traversed for each consecutive pair on the path. */
  edges: GraphPathEdge[];
}

/**
 * Shortest path between two nodes over `mnemo_relation`, undirected,
 * hop-capped BFS with parent-pointer reconstruction — same observable
 * contract as legacy `findShortestPath` (first-discovered shortest path;
 * legacy itself is non-deterministic among same-depth ties, since its CTE's
 * `ORDER BY depth LIMIT 1` picks whichever row Postgres materializes first).
 */
export async function findGraphPath(
  deps: GraphTraverseDeps,
  workspaceId: string,
  from: string,
  to: string,
  opts: GraphPathOptions = {}
): Promise<GraphPathResult> {
  const maxHops = Math.min(opts.maxHops ?? 4, 6);
  const asOf = opts.asOf;

  if (from === to) return { path: [from], edges: [] };

  // Stores the RAW relation row's source/target verbatim (not walk order) —
  // legacy `findShortestPath` re-queries `mnemo_relation` for each path step
  // and echoes its actual `source_id`/`target_id` columns, regardless of
  // which direction the path walks the edge. Reproducing that exactly (not
  // synthesizing `{source: parentId, target: cursor}`) matters: an edge
  // discovered while walking B->C could physically be stored as C->B.
  const parent = new Map<
    string,
    { parentId: string; source: string; target: string; relation: string }
  >();
  const visited = new Set<string>([from]);
  let frontier = [from];
  let reached = false;

  for (let hop = 1; hop <= maxHops && frontier.length > 0 && !reached; hop++) {
    const rows = await fetchLayer(
      deps,
      workspaceId,
      frontier,
      undefined,
      asOf,
      opts.maxSensitivity
    );
    const frontierSet = new Set(frontier);
    const nextFrontier: string[] = [];

    for (const rel of rows) {
      const fromFrontierId = frontierSet.has(rel.sourceId) ? rel.sourceId : rel.targetId;
      const neighborId = frontierSet.has(rel.sourceId) ? rel.targetId : rel.sourceId;
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      parent.set(neighborId, {
        parentId: fromFrontierId,
        source: rel.sourceId,
        target: rel.targetId,
        relation: rel.verb,
      });
      if (neighborId === to) {
        reached = true;
        break;
      }
      nextFrontier.push(neighborId);
    }

    frontier = nextFrontier;
  }

  if (!visited.has(to)) return { path: [], edges: [] };

  const path: string[] = [to];
  const edges: GraphPathEdge[] = [];
  let cursor = to;
  while (cursor !== from) {
    const step = parent.get(cursor)!;
    edges.unshift({ source: step.source, target: step.target, relation: step.relation });
    path.unshift(step.parentId);
    cursor = step.parentId;
  }
  return { path, edges };
}
