import { describe, it, expect } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import { toMemoryFact, toApiFact } from "../../mappers.js";

function fixtureFact(overrides: Partial<MnemoFact> = {}): MnemoFact {
  return {
    id: "fact_test_1",
    workspaceId: "ws_test",
    scope: "global",
    statement: "the deploy runs at 2am",
    subject: "deploy",
    kind: "other",
    confidence: 0.9,
    relevance: 0.8,
    hitCount: 3,
    worthSuccess: 1,
    worthFailure: 0,
    worthAlpha: 2,
    worthBeta: 2,
    worth: 0.6,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "user_stated",
    sourceMessageIds: ["msg_1"],
    linkedMemoryIds: [],
    topicKey: "ops/deploy",
    revisionCount: 0,
    protocolVersion: "3.0",
    status: "active",
    pinned: false,
    sensitivity: "internal",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    embeddingStale: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

describe("toMemoryFact", () => {
  it("serializes Date fields to ISO strings", () => {
    const dto = toMemoryFact(fixtureFact());
    expect(dto.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(dto.validTo).toBeNull();
    expect(dto.lastRecalledAt).toBeNull();
  });

  it("passes sensitivity through", () => {
    const dto = toMemoryFact(fixtureFact({ sensitivity: "confidential" }));
    expect(dto.sensitivity).toBe("confidential");
  });

  it("maps optional ids to explicit nulls", () => {
    const dto = toMemoryFact(fixtureFact());
    expect(dto.agentId).toBeNull();
    expect(dto.scopeRef).toBeNull();
    expect(dto.mergedIntoId).toBeNull();
  });
});

describe("toApiFact", () => {
  // flatten-legacy-dual-core PR9a / D6.1: `tags` is a phantom legacy field —
  // real `factory-mappers.ts`'s `rowToFact` hard-codes `tags: []` on every
  // read (there is no `tags` column at all), regardless of `topicKey`.
  it("maps statement to content and always yields empty tags (legacy tags is a phantom field)", () => {
    const dto = toApiFact(fixtureFact());
    expect(dto.content).toBe("the deploy runs at 2am");
    expect(dto.tags).toEqual([]);
  });

  it("yields empty tags even when topicKey is present", () => {
    const dto = toApiFact(fixtureFact({ topicKey: "ops/deploy" }));
    expect(dto.tags).toEqual([]);
  });

  // legacy `Fact.attribution` is literally `row.metadata ?? {}` — the SAME
  // column as MnemoFact.metadata, not a derived object.
  it("maps attribution to the raw metadata bag (matches legacy row.metadata ?? {})", () => {
    const dto = toApiFact(fixtureFact({ metadata: { source: "chat", note: "manual entry" } }));
    expect(dto.attribution).toEqual({ source: "chat", note: "manual entry" });
  });

  it("passes sensitivity through", () => {
    const dto = toApiFact(fixtureFact({ sensitivity: "confidential" }));
    expect(dto.sensitivity).toBe("confidential");
  });

  it("serializes dates and nullable validTo", () => {
    const dto = toApiFact(fixtureFact());
    expect(dto.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.validTo).toBeNull();
    expect(dto.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
