// in-memory/metacognition.ts — InMemoryStorageAdapter's Meta-cognition port methods.
// decompose-inmemory-storage-adapter Batch B7a (design.md Module Map row 24).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).
//
// `getConfidenceMap` is cross-domain (entities + facts, per design.md's
// Cross-Domain Inventory) — reads both directly off `state`, no extra import
// needed.

import type { ConfidenceMapRow, KnowledgeGapRow, MetacognitionTrends } from "../../primitives.js";
import type { InMemoryStorageState } from "./state.js";

// ── Meta-cognition (Wave F) ───────────────────────────────────────────────────

export async function getConfidenceMap(
  state: InMemoryStorageState,
  workspaceId: string,
  opts?: { limit?: number }
): Promise<ConfidenceMapRow[]> {
  // Entity-keyed (spec §31): LEFT JOIN entities → facts so zero-fact entities
  // surface as coverage 'blind'. Mirrors migration 0020's mv_confidence_map.
  const limit = opts?.limit ?? 500;
  const out: ConfidenceMapRow[] = [];
  for (const e of state.entities.values()) {
    if (e.workspaceId !== workspaceId) continue;
    const facts = [...state.facts.values()].filter(
      (f) =>
        f.workspaceId === workspaceId &&
        f.entityId === e.id &&
        f.status === "active" &&
        f.validTo == null
    );
    const factCount = facts.length;
    const avgWorth = factCount ? facts.reduce((a, f) => a + (f.worth ?? 0.5), 0) / factCount : 0;
    const avgConfidence = factCount
      ? facts.reduce((a, f) => a + (f.confidence ?? 0.7), 0) / factCount
      : 0;
    const newest = facts.reduce<Date | null>((m, f) => {
      const d = f.createdAt ?? null;
      return d && (!m || d > m) ? d : m;
    }, null);
    const evidenceVolume = facts.reduce(
      (a, f) => a + ((f.worthSuccess ?? 1) + (f.worthFailure ?? 1)),
      0
    );
    const coverageLevel: ConfidenceMapRow["coverageLevel"] =
      factCount >= 10 && avgWorth > 0.7
        ? "expert"
        : factCount >= 5 && avgWorth > 0.5
          ? "familiar"
          : factCount >= 2
            ? "aware"
            : factCount >= 1
              ? "minimal"
              : "blind";
    const ageMs = newest ? Date.now() - newest.getTime() : Infinity;
    const day = 86_400_000;
    const freshness: ConfidenceMapRow["freshness"] =
      ageMs < 7 * day
        ? "current"
        : ageMs < 30 * day
          ? "recent"
          : ageMs < 90 * day
            ? "aging"
            : "stale";
    out.push({
      workspaceId,
      entityId: e.id,
      canonicalName: e.name,
      kind: e.kind ?? "concept",
      factCount,
      avgConfidence,
      coverageLevel,
      freshness,
      topicKey: e.name,
      memoryCount: factCount,
      avgWorth,
      evidenceVolume,
      distinctAttributions: 0,
      pinnedCount: 0,
      lowStrengthCount: 0,
      lastUpdatedAt: new Date(),
    });
  }
  return out.slice(0, limit);
}

export async function getKnowledgeGaps(
  _state: InMemoryStorageState,
  _workspaceId: string,
  _opts?: { limit?: number; minScore?: number }
): Promise<KnowledgeGapRow[]> {
  return [];
}

export async function getMetacognitionTrends(
  _state: InMemoryStorageState,
  _workspaceId: string
): Promise<MetacognitionTrends> {
  const z = { current: 0, previous: 0, delta: 0 };
  return {
    recallHitRate: z,
    avgRecallLatency: z,
    sessionCollapseQuality: z,
    strategySuccessRate: z,
  };
}

export async function refreshMetacognitionViews(_state: InMemoryStorageState): Promise<void> {
  // no-op in memory
}
