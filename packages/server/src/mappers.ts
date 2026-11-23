// Domain model → API DTO mappers (TASK-5002: unified Fact type bridge).
//
// The server exposes two Fact shapes to HTTP callers:
//   • `Fact`       (deps.ts) — simplified v2-compat view (content, tags, etc.)
//   • `MemoryFact` (deps.ts) — rich v3 view (statement, kind, confidence, etc.)
//
// `MnemoFact` from @mnemo-ai/types is the v3 *domain model* (Date objects,
// Float32Array embedding). These mappers convert it to the serializable DTO
// shapes the HTTP layer expects. TypeScript enforces the mapping stays
// consistent whenever either side of the type contract changes.

import type { MnemoFact } from "@mnemo-ai/types";
import type { Fact, MemoryFact } from "./deps.js";

// ── MnemoFact → MemoryFact (rich API DTO) ─────────────────────────────────────

/** The id pointers of a MemoryFact, for `dropHiddenPointers` (rbac.ts). */
export const FACT_POINTERS: { lists: Array<keyof MemoryFact>; ids: Array<keyof MemoryFact> } = {
  lists: ["linkedMemoryIds"],
  ids: ["mergedIntoId", "episodeId"],
};

export function toMemoryFact(f: MnemoFact): MemoryFact {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    agentId: f.agentId ?? null,
    actorId: f.actorId ?? null,
    scope: f.scope,
    scopeRef: f.scopeRef ?? null,
    kind: f.kind,
    subject: f.subject,
    statement: f.statement,
    confidence: f.confidence,
    pinned: f.pinned,
    relevance: f.relevance,
    hitCount: f.hitCount,
    lastRecalledAt: f.lastRecalledAt?.toISOString() ?? null,
    sourceMessageIds: f.sourceMessageIds,
    attributedTo: (f.attributedTo ?? null) as MemoryFact["attributedTo"],
    // flatten-legacy-dual-core PR9a: MnemoFact now carries linkedMemoryIds
    // (D6.2) — no longer hardcoded to [].
    linkedMemoryIds: f.linkedMemoryIds,
    metadata: f.metadata,
    status: f.status,
    sensitivity: f.sensitivity,
    mergedIntoId: f.mergedIntoId ?? null,
    validFrom: f.validFrom.toISOString(),
    validTo: f.validTo?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    memoryType: f.memoryType,
    // CLIENTS-20 / CHAOS-8 (additive): the idempotency key, the canonical
    // origin link, and the revision a PATCH `expectedRevision` compares with.
    topicKey: f.topicKey ?? null,
    episodeId: f.episodeId ?? null,
    revisionCount: f.revisionCount,
    ...(f.redacted ? { redacted: f.redacted } : {}),
  };
}

// ── MnemoFact → Fact (simplified v2-compat DTO) ───────────────────────────────
//
// flatten-legacy-dual-core PR9a / D6.1: `Fact.tags` and `Fact.attribution`
// are phantom legacy fields — legacy `factory-mappers.ts`'s `rowToFact`
// NEVER persists or reads `tags` (hard-coded to `[]` on every read;
// `packages/core/src/db/schema/fact.ts` has no `tags` column at all), and
// `Fact.attribution` is literally `row.metadata ?? {}` (the SAME column as
// `MnemoFact.metadata`, not a derived object). This function previously
// (pre-PR9a, unused dead code — see git history) derived `attribution` from
// `f.attribution`/`attributedTo`/`sessionId` and `tags` from `f.topicKey`,
// which does NOT match real legacy wire behavior — fixed here as part of
// wiring this mapper into `GET /facts/:id`/`POST /facts/:id/pin` for the
// first time.
export function toApiFact(f: MnemoFact): Fact {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    content: f.statement,
    attribution: f.metadata,
    tags: [],
    pinned: f.pinned,
    validFrom: f.validFrom.toISOString(),
    validTo: f.validTo?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    sensitivity: f.sensitivity,
    // CLIENTS-20 (additive): `memory_fact` is the drill-down of a recall hit,
    // and this shape dropped what tells two similar facts apart — which kind
    // and subject, which project, how sure, which topicKey supersedes it, and
    // where it came from. `revisionCount` is what PATCH's `expectedRevision`
    // compares with.
    kind: f.kind,
    subject: f.subject,
    scopeRef: f.scopeRef ?? null,
    confidence: f.confidence,
    topicKey: f.topicKey ?? null,
    episodeId: f.episodeId ?? null,
    status: f.status,
    revisionCount: f.revisionCount,
    hitCount: f.hitCount,
    ...(f.redacted ? { redacted: f.redacted } : {}),
  };
}
