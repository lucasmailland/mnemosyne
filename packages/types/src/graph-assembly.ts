// flatten-legacy-dual-core PR9f (design.md D6.5 "Graph — assembly-in-adapter,
// traversal-in-core"). Pure snapshot assembly, zero I/O — mirrors legacy
// `buildGraphData`'s focus-neighbourhood + meta-count tail exactly
// (`packages/core/src/graph/query.ts:132-162`).
//
// Callers (`GraphRepository` in adapter-postgres, `InMemoryStorageAdapter`
// here) map their own rows to `GraphNode[]`/`GraphEdge[]` first — including
// pre-filtering edges to pairs whose both endpoints are in `nodes`, exactly
// as legacy's `relations.filter(r => nodeIds.has(sourceId) && nodeIds.has(targetId))`
// does — then share this one assembly step so the focus/meta logic can never
// duplicate or drift between adapters.

import type { GraphNode, GraphEdge, GraphSnapshot } from "./relations.js";

export interface AssembleGraphSnapshotOptions {
  /** Restrict the returned snapshot to this node + its 1-hop neighbourhood. */
  focusEntityId?: string;
}

function countMeta(nodes: GraphNode[], edges: GraphEdge[]): GraphSnapshot["meta"] {
  return {
    entityCount: nodes.filter((n) => n.kind === "entity").length,
    episodeCount: nodes.filter((n) => n.kind === "episode").length,
    decisionCount: nodes.filter((n) => n.kind === "decision").length,
    relationCount: edges.length,
  };
}

/**
 * An entity's mentions are the facts linked to it (its `factCount`) plus the
 * episodes related to it. Both come from rows the caller can already see, so
 * the count never reflects anything above the ceiling. The stored
 * `mention_count` column is never maintained, so it is not read.
 */
function withMentionCounts(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const episodes = new Set(nodes.filter((n) => n.kind === "episode").map((n) => n.id));
  const episodesByNode = new Map<string, Set<string>>();
  const link = (nodeId: string, episodeId: string) => {
    const seen = episodesByNode.get(nodeId) ?? new Set<string>();
    seen.add(episodeId);
    episodesByNode.set(nodeId, seen);
  };
  for (const e of edges) {
    // A derived "mentions" edge restates the episode's facts, already in factCount; counting it
    // again would also part the graph from GET /entities (countEntityMentions).
    if (e.provenance === "episode_facts") continue;
    if (episodes.has(e.source)) link(e.target, e.source);
    if (episodes.has(e.target)) link(e.source, e.target);
  }
  return nodes.map((n) =>
    n.kind === "entity"
      ? { ...n, mentionCount: n.factCount + (episodesByNode.get(n.id)?.size ?? 0) }
      : n
  );
}

export function assembleGraphSnapshot(
  allNodes: GraphNode[],
  edges: GraphEdge[],
  opts: AssembleGraphSnapshotOptions = {}
): GraphSnapshot {
  // Counted over the whole graph, before a focus narrows what is returned.
  const nodes = withMentionCounts(allNodes, edges);
  if (opts.focusEntityId) {
    const focus = opts.focusEntityId;
    const neighborIds = new Set<string>([focus]);
    for (const e of edges) {
      if (e.source === focus) neighborIds.add(e.target);
      if (e.target === focus) neighborIds.add(e.source);
    }
    const focusNodes = nodes.filter((n) => neighborIds.has(n.id));
    const focusEdges = edges.filter((e) => neighborIds.has(e.source) && neighborIds.has(e.target));
    return { nodes: focusNodes, edges: focusEdges, meta: countMeta(focusNodes, focusEdges) };
  }

  return { nodes, edges, meta: countMeta(nodes, edges) };
}
