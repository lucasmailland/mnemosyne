import { describe, expect, it } from "vitest";
import type { MnemoFact, RecallFilter } from "@mnemo-ai/types";
import { matchesRecallFilter } from "../recall-filter.js";

const FACT: MnemoFact = {
  id: "fact-1",
  workspaceId: "ws-1",
  actorId: "actor-1",
  scope: "conversation",
  scopeRef: "project-1",
  statement: "Canonical candidate",
  subject: "recall",
  kind: "preference",
  confidence: 0.9,
  relevance: 1,
  hitCount: 0,
  worthSuccess: 8,
  worthFailure: 2,
  worthAlpha: 10,
  worthBeta: 2,
  worth: 0.8,
  memoryType: "semantic",
  memoryStrength: 1,
  memoryStability: 1,
  attribution: "user_stated",
  sourceMessageIds: [],
  sessionId: "session-1",
  revisionCount: 1,
  protocolVersion: "3.0",
  entityId: "entity-1",
  status: "active",
  pinned: false,
  canonical: false,
  sensitivity: "confidential",
  validFrom: new Date("2026-02-01T00:00:00Z"),
  validTo: undefined,
  embeddingStale: false,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
  metadata: { tags: ["typescript", "security"] },
};

describe("matchesRecallFilter", () => {
  it("accepts a fact matching every current filter field", () => {
    const filter: RecallFilter = {
      kinds: ["fact"],
      tags: ["typescript", "security"],
      validAfter: new Date("2026-01-01T00:00:00Z"),
      validBefore: new Date("2026-03-01T00:00:00Z"),
      minWorth: 0.7,
      minConfidence: 0.8,
      sensitivity: ["confidential"],
      provenance: ["user_stated"],
      entityId: "entity-1",
      sessionId: "session-1",
      scope: "conversation",
      scopeRef: "project-1",
      actorId: "actor-1",
    };

    expect(matchesRecallFilter(FACT, filter)).toBe(true);
  });

  it.each([
    ["kinds", { kinds: ["decision"] }],
    ["tags", { tags: ["typescript", "missing"] }],
    ["validAfter", { validAfter: new Date("2026-02-02T00:00:00Z") }],
    ["validBefore", { validBefore: new Date("2026-01-31T00:00:00Z") }],
    ["minWorth", { minWorth: 0.81 }],
    ["minConfidence", { minConfidence: 0.91 }],
    ["sensitivity", { sensitivity: ["public", "internal"] }],
    ["provenance", { provenance: ["inferred"] }],
    ["entityId", { entityId: "entity-2" }],
    ["sessionId", { sessionId: "session-2" }],
    ["scope", { scope: "global" }],
    ["scopeRef", { scopeRef: "project-2" }],
    ["actorId", { actorId: "actor-2" }],
  ] satisfies Array<[string, RecallFilter]>)("rejects a %s mismatch", (_field, filter) => {
    expect(matchesRecallFilter(FACT, filter)).toBe(false);
  });
});
