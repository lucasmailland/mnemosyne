// in-memory/graph.ts — Graph domain module for InMemoryStorageAdapter.
// decompose-inmemory-storage-adapter Batch B11c (design.md Module Map row 21).
// Move-only: bodies are verbatim transplants, `this.` -> `state.` is the only edit (D7).

import type {
  MnemoCitation,
  CitationFilter,
  GraphSnapshotFilter,
  GraphSnapshot,
  GraphNode,
  GraphEdge,
} from "../../relations.js";
import { assembleGraphSnapshot } from "../../graph-assembly.js";
import type { Sensitivity } from "../../common.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import type { InMemoryStorageState } from "./state.js";
import { cosineSimilarity, type SemanticEdgeRow } from "./support.js";

export async function listCitations(
  state: InMemoryStorageState,
  filter: CitationFilter
): Promise<MnemoCitation[]> {
  let items = state.citations.filter((c) => c.workspaceId === filter.workspaceId);
  if (filter.memoryKind) items = items.filter((c) => c.memoryKind === filter.memoryKind);
  if (filter.memoryId) items = items.filter((c) => c.memoryId === filter.memoryId);
  items = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // flatten-legacy-dual-core PR9h (design.md D6.5) — mirrors
  // CitationRepository's additive offset-pagination support.
  const offset = Math.max(filter.offset ?? 0, 0);
  items = offset > 0 ? items.slice(offset) : items;
  if (filter.limit !== undefined) items = items.slice(0, filter.limit);
  return items;
}

/**
 * flatten-legacy-dual-core PR9f (design.md D6.5) — mirrors legacy
 * `buildGraphQuery`'s filters exactly (canonical entities only, non-
 * synthetic episodes, active decisions, non-dismissed relations valid at
 * `asOf`/now), then shares `assembleGraphSnapshot` with `GraphRepository`
 * (adapter-postgres) for the focus/meta tail so both never drift.
 */
export async function getGraphSnapshot(
  state: InMemoryStorageState,
  filter: GraphSnapshotFilter
): Promise<GraphSnapshot> {
  const asOf = filter.asOf;
  const ceiling = filter.maxSensitivity;
  const visible = (row: { sensitivity: Sensitivity }) =>
    !ceiling || SENSITIVITY_ORDER[row.sensitivity] <= SENSITIVITY_ORDER[ceiling];

  const entities = [...state.entities.values()].filter(
    (e) =>
      e.workspaceId === filter.workspaceId &&
      e.canonicalId == null &&
      visible(e) &&
      (!asOf || e.createdAt <= asOf)
  );
  const episodes = [...state.episodes.values()].filter(
    (ep) =>
      ep.workspaceId === filter.workspaceId &&
      ep.isSynthetic !== true &&
      visible(ep) &&
      (!asOf || ep.createdAt <= asOf)
  );
  const decisions = [...state.decisions.values()].filter(
    (d) =>
      d.workspaceId === filter.workspaceId &&
      d.status === "active" &&
      visible(d) &&
      (!asOf || d.createdAt <= asOf)
  );
  const facts = [...state.facts.values()].filter(
    (f) =>
      f.workspaceId === filter.workspaceId &&
      f.status === "active" &&
      f.entityId != null &&
      visible(f) &&
      (!asOf || f.createdAt <= asOf)
  );
  const relations = [...state.relations.values()].filter(
    (r) =>
      r.workspaceId === filter.workspaceId &&
      r.judgmentStatus !== "dismissed" &&
      (asOf ? r.validFrom <= asOf && (r.validTo === null || r.validTo > asOf) : r.validTo === null)
  );

  const factStatsByEntity = new Map<string, { factCount: number; sum: number }>();
  for (const f of facts) {
    const entry = factStatsByEntity.get(f.entityId!) ?? { factCount: 0, sum: 0 };
    entry.factCount++;
    entry.sum += f.memoryStrength;
    factStatsByEntity.set(f.entityId!, entry);
  }

  const entityNodes: GraphNode[] = entities.map((e) => {
    const stats = factStatsByEntity.get(e.id);
    return {
      id: e.id,
      kind: "entity",
      entityKind: e.kind,
      label: e.name,
      description: e.description ?? null,
      mentionCount: 0, // derived by assembleGraphSnapshot
      factCount: stats?.factCount ?? 0,
      avgMemoryStrength: stats ? stats.sum / stats.factCount : 1.0,
      createdAt: e.createdAt,
    };
  });
  const episodeNodes: GraphNode[] = episodes.map((ep) => ({
    id: ep.id,
    kind: "episode",
    label: ep.title,
    mentionCount: 0,
    // Linked facts above the ceiling are not counted.
    factCount: ep.linkedFactIds.filter((id) => {
      const f = state.facts.get(id);
      return !f || visible(f);
    }).length,
    avgMemoryStrength: 1.0,
    createdAt: ep.createdAt,
  }));
  const decisionNodes: GraphNode[] = decisions.map((d) => ({
    id: d.id,
    kind: "decision",
    label: d.title,
    mentionCount: 0,
    factCount: 0,
    avgMemoryStrength: 1.0,
    createdAt: d.createdAt,
  }));

  const nodes = [...entityNodes, ...episodeNodes, ...decisionNodes];
  const nodeIds = new Set(nodes.map((n) => n.id));

  const edges: GraphEdge[] = relations
    .filter((r) => nodeIds.has(r.sourceId) && nodeIds.has(r.targetId))
    .map((r) => ({
      id: r.id,
      source: r.sourceId,
      target: r.targetId,
      relation: r.verb,
      confidence: r.confidence ?? 0.7,
      provenance: r.provenance,
    }));

  // Episode → entity through the episode's visible linked facts (mirrors GraphRepository).
  if (filter.includeMentions) {
    for (const ep of episodes) {
      const seen = new Set<string>();
      for (const id of ep.linkedFactIds) {
        const f = state.facts.get(id);
        if (!f || f.workspaceId !== filter.workspaceId || f.status !== "active") continue;
        if (!f.entityId || !visible(f) || (asOf && f.createdAt > asOf)) continue;
        if (seen.has(f.entityId) || !nodeIds.has(f.entityId)) continue;
        seen.add(f.entityId);
        edges.push({
          id: `men:${ep.id}:${f.entityId}`,
          source: ep.id,
          target: f.entityId,
          relation: "mentions",
          confidence: 1,
          provenance: "episode_facts",
        });
      }
    }
  }

  // flatten-legacy-dual-core PR9g: `backfillSemanticNeighbors` (below) now
  // populates `state.semanticNeighbors` — projected to entity pairs here,
  // same LEAST/GREATEST + max-cosine dedup as `GraphRepository.
  // loadSemanticEdges` (adapter-postgres), so both adapters agree.
  if (filter.includeSemantic) {
    for (const s of projectSemanticEdges(state, filter.workspaceId, visible)) {
      if (!nodeIds.has(s.sourceId) || !nodeIds.has(s.targetId)) continue;
      edges.push({
        id: `sem:${s.sourceId}:${s.targetId}`,
        source: s.sourceId,
        target: s.targetId,
        relation: "semantically_related",
        confidence: s.cosine,
        provenance: "semantic_knn",
      });
    }
  }

  return assembleGraphSnapshot(nodes, edges, { focusEntityId: filter.focusEntityId });
}

/** Mirrors GraphRepository.countEntityMentions (see the port's doc comment). */
export async function countEntityMentions(
  state: InMemoryStorageState,
  input: { workspaceId: string; entityIds: string[]; maxSensitivity?: Sensitivity }
): Promise<Record<string, number>> {
  const ceiling = input.maxSensitivity;
  const visible = (row: { sensitivity?: Sensitivity }) =>
    !ceiling || SENSITIVITY_ORDER[row.sensitivity ?? "internal"] <= SENSITIVITY_ORDER[ceiling];
  const counts: Record<string, number> = {};
  for (const id of input.entityIds) counts[id] = 0;
  for (const f of state.facts.values()) {
    if (
      f.workspaceId === input.workspaceId &&
      f.status === "active" &&
      f.entityId != null &&
      Object.hasOwn(counts, f.entityId) &&
      visible(f)
    ) {
      counts[f.entityId]!++;
    }
  }
  const episodesByEntity = new Map<string, Set<string>>();
  for (const r of state.relations.values()) {
    if (r.workspaceId !== input.workspaceId || r.validTo !== null) continue;
    if (r.judgmentStatus === "dismissed") continue;
    const pairs: Array<[string, string]> = [];
    if (r.sourceType === "entity" && r.targetType === "episode")
      pairs.push([r.sourceId, r.targetId]);
    if (r.sourceType === "episode" && r.targetType === "entity")
      pairs.push([r.targetId, r.sourceId]);
    for (const [entityId, otherId] of pairs) {
      const ep = state.episodes.get(otherId);
      if (!Object.hasOwn(counts, entityId) || !ep || ep.workspaceId !== input.workspaceId) continue;
      if (ep.isSynthetic === true || !visible(ep)) continue;
      const seen = episodesByEntity.get(entityId) ?? new Set<string>();
      seen.add(otherId);
      episodesByEntity.set(entityId, seen);
    }
  }
  for (const [entityId, seen] of episodesByEntity) counts[entityId]! += seen.size;
  return counts;
}

/**
 * flatten-legacy-dual-core PR9g (design.md D6.5) — mirrors legacy
 * `backfillSemanticNeighbors` (`core/src/graph/semantic-neighbors.ts`):
 * delete-then-insert per workspace, brute-force top-k cosine over active
 * embedded facts (no real HNSW index to fake in-memory — this fake has no
 * pgvector, so it's a full scan instead of the adapter-postgres/legacy
 * `INSERT ... JOIN LATERAL`), same per-fact top-k/threshold semantics.
 * Idempotent: delete-first means a repeat call with unchanged embeddings
 * reproduces the identical edge set.
 */
export async function backfillSemanticNeighbors(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    k?: number;
    threshold?: number;
    modelVersion?: string;
  }
): Promise<number> {
  const k = input.k ?? 8;
  const threshold = input.threshold ?? 0.75;

  for (const [key, row] of state.semanticNeighbors) {
    if (row.workspaceId === input.workspaceId) state.semanticNeighbors.delete(key);
  }

  const activeEmbedded = [...state.facts.values()].filter(
    (f) => f.workspaceId === input.workspaceId && f.status === "active" && f.embedding
  );

  let written = 0;
  for (const a of activeEmbedded) {
    const neighbours = activeEmbedded
      .filter((b) => b.id !== a.id)
      .map((b) => ({ b, cosine: cosineSimilarity(a.embedding!, b.embedding!) }))
      .sort((x, y) => y.cosine - x.cosine)
      .slice(0, k)
      .filter((n) => n.cosine >= threshold);

    for (const { b, cosine } of neighbours) {
      const key = `${input.workspaceId}:${a.id}:${b.id}`;
      state.semanticNeighbors.set(key, {
        workspaceId: input.workspaceId,
        sourceFactId: a.id,
        targetFactId: b.id,
        cosine,
      });
      written++;
    }
  }

  return written;
}

/** Fact-pair -> entity-pair projection, same dedup rule as GraphRepository.loadSemanticEdges. */
function projectSemanticEdges(
  state: InMemoryStorageState,
  workspaceId: string,
  visible: (fact: { sensitivity: Sensitivity }) => boolean
): SemanticEdgeRow[] {
  const byPair = new Map<string, number>(); // key: "<entityA>:<entityB>" (LEAST:GREATEST) -> max cosine
  for (const row of state.semanticNeighbors.values()) {
    if (row.workspaceId !== workspaceId) continue;
    const fa = state.facts.get(row.sourceFactId);
    const fb = state.facts.get(row.targetFactId);
    if (!fa?.entityId || !fb?.entityId || fa.entityId === fb.entityId) continue;
    if (!visible(fa) || !visible(fb)) continue;
    const [source, target] = [fa.entityId, fb.entityId].sort();
    const key = `${source}:${target}`;
    const existing = byPair.get(key);
    if (existing === undefined || row.cosine > existing) byPair.set(key, row.cosine);
  }
  return [...byPair.entries()].map(([key, cosine]) => {
    const [sourceId, targetId] = key.split(":") as [string, string];
    return { sourceId, targetId, cosine };
  });
}
