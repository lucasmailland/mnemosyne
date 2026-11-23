// flatten-legacy-dual-core D6.4 — proves `mapRowToRelation` round-trips
// every physical `mnemo_relation` column onto `MnemoRelation`, including the
// full judgment-workflow overlay this PR adds (validFrom/validTo/
// judgmentStatus/reason/evidence/confidence/markedBy*/provenance/
// conversationId/supersededByRelationId/coRecallCount/directionality) and
// the `metadata`→`evidence` rename. Pure unit test — no database.
import { describe, expect, it } from "vitest";
import { mapRowToRelation } from "../repositories/mappers.js";
import type * as schema from "../schema/index.js";

describe("mapRowToRelation", () => {
  it("round-trips every physical column, including the full judgment overlay", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-01T00:05:00.000Z");
    const validFrom = new Date("2026-01-01T00:00:00.000Z");
    const validTo = new Date("2026-01-02T00:00:00.000Z");
    const lastCoRecallAt = new Date("2026-01-01T12:00:00.000Z");

    const row: schema.SelectRelation = {
      id: "rel-1",
      workspaceId: "ws-1",
      sourceKind: "fact",
      sourceId: "fact-a",
      targetKind: "fact",
      targetId: "fact-b",
      relation: "conflicts_with",
      hebbianWeight: 0.75,
      coRecallCount: 3,
      directionality: 0.2,
      lastCoRecallAt,
      judgmentStatus: "judged",
      reason: "duplicate detection",
      evidence: { detectedBy: "section33_resolver", action: "review" },
      confidence: 0.9,
      markedByUserId: "user-1",
      markedByKind: "llm_judge",
      markedByModel: "gpt-5",
      markedByPromptVersion: "v3",
      provenance: "consolidation",
      conversationId: "conv-1",
      supersededByRelationId: "rel-0",
      actorId: "key:test-key",
      userId: "user-1",
      actorType: "agent",
      validFrom,
      validTo,
      createdAt,
      updatedAt,
    };

    const relation = mapRowToRelation(row);

    expect(relation).toEqual({
      id: "rel-1",
      workspaceId: "ws-1",
      sourceId: "fact-a",
      sourceType: "fact",
      targetId: "fact-b",
      targetType: "fact",
      verb: "conflicts_with",
      weight: 0.75,
      coRecallCount: 3,
      directionality: 0.2,
      lastCoRecallAt,
      createdAt,
      updatedAt,
      actorId: "key:test-key",
      userId: "user-1",
      actorType: "agent",
      validFrom,
      validTo,
      judgmentStatus: "judged",
      reason: "duplicate detection",
      evidence: { detectedBy: "section33_resolver", action: "review" },
      confidence: 0.9,
      markedByUserId: "user-1",
      markedByKind: "llm_judge",
      markedByModel: "gpt-5",
      markedByPromptVersion: "v3",
      provenance: "consolidation",
      conversationId: "conv-1",
      supersededByRelationId: "rel-0",
    });
  });

  it("maps a fresh, never-judged Hebbian-only row: evidence null, judgment fields at DB defaults", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const row: schema.SelectRelation = {
      id: "rel-2",
      workspaceId: "ws-1",
      sourceKind: "fact",
      sourceId: "fact-a",
      targetKind: "fact",
      targetId: "fact-b",
      relation: "related",
      hebbianWeight: 1.0,
      coRecallCount: 0,
      directionality: 0,
      lastCoRecallAt: null,
      judgmentStatus: "pending",
      reason: null,
      evidence: null,
      confidence: null,
      markedByUserId: null,
      markedByKind: "system",
      markedByModel: null,
      markedByPromptVersion: null,
      provenance: null,
      conversationId: null,
      supersededByRelationId: null,
      actorId: null,
      userId: null,
      actorType: null,
      validFrom: now,
      validTo: null,
      createdAt: now,
      updatedAt: now,
    };

    const relation = mapRowToRelation(row);

    // The D6.4 bugfix's observable contract: a never-judged relation reads
    // back with `evidence: null` — never a stray `{}` — and `judgmentStatus`
    // reflects the real DB default rather than being silently overwritten.
    expect(relation.evidence).toBeNull();
    expect(relation.judgmentStatus).toBe("pending");
    expect(relation.reason).toBeNull();
    expect(relation.confidence).toBeNull();
    expect(relation.markedByKind).toBe("system");
    expect(relation.validTo).toBeNull();
  });
});
