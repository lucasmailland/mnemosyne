import { describe, it, expect, vi } from "vitest";
import { composeInferences, evaluateRule } from "../compositionality.js";
import type { RecallHit } from "@mnemo-ai/types";
import type { CoreContext } from "../context.js";

function fakeHit(partial: Partial<RecallHit & { worth?: number; factKind?: string }>): RecallHit {
  return {
    id: "f-x", primitive: "fact", content: "", score: 0.5, sensitivity: "internal",
    injectionScore: 0, provenance: "user_stated", origin: "local", contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null, tags: [], relations: [], worth: undefined, factKind: undefined,
    ...partial,
  } as unknown as RecallHit;
}

function makeCtx(rules: unknown[]) {
  const storage = {
    queryCompositionRules: vi.fn(async () => ({ items: rules, total: rules.length, offset: 0, limit: 500, hasMore: false })),
    materialiseInference: vi.fn(async () => ({ id: "derived-1" })),
    appendInference: vi.fn(async () => ({})),
    bumpCompositionExecution: vi.fn(async () => undefined),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  return { storage, logger } as unknown as CoreContext;
}

// fact_kind clause binds the matched hit → premiseAvgWorth = hit.worth.
const rule = (baseConfidence: number) => ({
  id: "r", name: "r", workspaceId: "w",
  conditionDsl: { all: [{ op: "fact_kind", kind: "objective_fact", bind: "$a" }] },
  actionDsl: { op: "derive_fact", statementTemplate: "derived: $a", kind: "inferred", baseConfidence, sensitivity: "internal" },
  priority: 0, isActive: true, executionCount: 0, source: "manual", metadata: {},
  createdAt: new Date(), updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
});

describe("§32 inference confidence filter (drop confidence ≤ 0.5)", () => {
  it("drops an inference whose confidence is ≤ 0.5", async () => {
    // baseConfidence 0.5 × worth 0.5 = 0.25 ≤ 0.5 → dropped
    const ctx = makeCtx([rule(0.5)]);
    const out = await composeInferences(ctx, "w", [fakeHit({ id: "f-1", factKind: "objective_fact", content: "X", worth: 0.5 })]);
    expect(out).toHaveLength(0);
  });

  it("keeps an inference whose confidence is > 0.5", async () => {
    // baseConfidence 0.8 × worth 0.9 = 0.72 > 0.5 → kept
    const ctx = makeCtx([rule(0.8)]);
    const out = await composeInferences(ctx, "w", [fakeHit({ id: "f-1", factKind: "objective_fact", content: "X", worth: 0.9 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeCloseTo(0.72);
  });

  it("drops an inference exactly at the 0.5 boundary (strictly greater required)", async () => {
    // baseConfidence 1.0 × worth 0.5 = 0.5 → NOT > 0.5 → dropped
    const ctx = makeCtx([rule(1.0)]);
    const out = await composeInferences(ctx, "w", [fakeHit({ id: "f-1", factKind: "objective_fact", content: "X", worth: 0.5 })]);
    expect(out).toHaveLength(0);
  });

  it("does NOT materialise a fact for a sub-threshold inference", async () => {
    const ctx = makeCtx([rule(0.5)]);
    const out = await evaluateRule(ctx, rule(0.5) as any, "w",
      [fakeHit({ id: "f-1", factKind: "objective_fact", content: "X", worth: 0.5 })],
      { materialise: true });
    expect(out).toHaveLength(0);
    expect((ctx.storage as any).materialiseInference).not.toHaveBeenCalled();
  });
});
