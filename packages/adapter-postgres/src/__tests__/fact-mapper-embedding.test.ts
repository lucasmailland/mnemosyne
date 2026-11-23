/**
 * mapRowToFact() used to silently drop the `embedding` column, even though
 * `MnemoFact.embedding?: Float32Array` is a real, declared field and the
 * underlying `tx.select()` calls have no column projection (the data is
 * already on the wire). Since packages/consolidation's gatherClusters() only
 * groups facts when `fact.embedding` is truthy, this meant fast-mode
 * consolidation clustering could never form a cluster against the real
 * adapter in production — see
 * packages/consolidation/src/__tests__/scheduler.integration.test.ts for the
 * full real-Postgres regression test. This file is the fast, no-Docker unit
 * guard on the mapper itself.
 */
import { describe, expect, it } from "vitest";
import { mapRowToFact } from "../repositories/mappers.js";

function baseRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "fact-1",
    workspaceId: "ws-1",
    agentId: null,
    actorId: null,
    scope: "global",
    scopeRef: null,
    scopeOwner: null,
    statement: "test statement",
    subject: "test subject",
    kind: "other",
    confidence: "0.9",
    relevance: 0.5,
    hitCount: 0,
    lastRecalledAt: null,
    worthSuccess: "0",
    worthFailure: "0",
    worthAlpha: "1",
    worthBeta: "1",
    worth: "0.5",
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    lastStrengthUpdate: null,
    attribution: "user_stated",
    attributedTo: null,
    sourceMessageIds: [],
    sessionId: null,
    extractionSource: null,
    topicKey: null,
    revisionCount: 1,
    protocolVersion: "1",
    entityId: null,
    episodeId: null,
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    mergedIntoId: null,
    validFrom: now,
    validTo: null,
    embedding: null,
    embeddingModel: null,
    embeddingStale: false,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

describe("mapRowToFact — embedding", () => {
  it("converts a non-null halfvec row (number[]) into a Float32Array", () => {
    const fact = mapRowToFact(baseRow({ embedding: [0.1, 0.2, 0.3] }) as never);
    expect(fact.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(fact.embedding!)).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it("returns undefined (not null) when the row's embedding is null", () => {
    const fact = mapRowToFact(baseRow({ embedding: null }) as never);
    expect(fact.embedding).toBeUndefined();
  });
});
