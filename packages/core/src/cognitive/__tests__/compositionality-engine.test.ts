import { describe, it, expect, vi } from "vitest";
import { composeInferences, evaluateRule } from "../compositionality.js";
import type { RecallHit } from "@mnemo-ai/types";
import type { CoreContext } from "../context.js";

function fakeHit(partial: Partial<RecallHit & { worth?: number; factKind?: string }>): RecallHit {
  return {
    id: "f-x",
    primitive: "fact",
    content: "",
    score: 0.5,
    sensitivity: "internal",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null,
    tags: [],
    relations: [],
    worth: undefined,
    factKind: undefined,
    ...partial,
  } as unknown as RecallHit;
}

function makeCtxWithRules(rules: unknown[]): CoreContext {
  const storage = {
    queryCompositionRules: vi.fn(async () => ({
      items: rules, total: rules.length, offset: 0, limit: 500, hasMore: false,
    })),
    materialiseInference: vi.fn(async () => ({ id: "derived-1" })),
    appendInference: vi.fn(async () => ({})),
    bumpCompositionExecution: vi.fn(async () => undefined),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  return { storage, logger } as unknown as CoreContext;
}

const SIMPLE_RULE = {
  id: "r-1", name: "tag-as-auth", workspaceId: "w",
  conditionDsl: { all: [{ op: "fact_kind", kind: "objective_fact", bind: "$a" }] },
  actionDsl: { op: "derive_fact", statementTemplate: "AUTH inferred from: $a", kind: "inferred", baseConfidence: 0.8, sensitivity: "internal" },
  priority: 100, isActive: true, executionCount: 0,
  source: "manual", metadata: {},
  createdAt: new Date(), updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
};

describe("composeInferences", () => {
  it("fires a 1-premise rule (dry run)", async () => {
    const ctx = makeCtxWithRules([SIMPLE_RULE]);
    const out = await composeInferences(ctx, "w", [
      fakeHit({ id: "f-1", factKind: "objective_fact", content: "X is true", worth: 0.9 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.derivedStatement).toBe("AUTH inferred from: X is true");
    // confidence = 0.8 × 0.9 = 0.72, priority NOT a factor
    expect(out[0]!.confidence).toBeCloseTo(0.72);
  });

  it("does not materialise unless opts.materialise === true", async () => {
    const ctx = makeCtxWithRules([SIMPLE_RULE]);
    await composeInferences(ctx, "w", [
      fakeHit({ id: "f-1", factKind: "objective_fact", content: "X", worth: 0.9 }),
    ]);
    expect(ctx.storage.materialiseInference).not.toHaveBeenCalled();
  });

  it("invalid DSL skips rule without crashing", async () => {
    const ctx = makeCtxWithRules([
      { id: "r-bad", name: "bad", conditionDsl: { totallyBogus: true }, actionDsl: {} },
    ]);
    const out = await composeInferences(ctx, "w", [fakeHit({ id: "f-1" })]);
    expect(out).toHaveLength(0);
  });

  it("returns empty on empty hits", async () => {
    const ctx = makeCtxWithRules([SIMPLE_RULE]);
    const out = await composeInferences(ctx, "w", []);
    expect(out).toHaveLength(0);
  });

  it("respects MAX_FIRINGS_PER_CALL (50)", async () => {
    // 60 hits → the backtracker would produce 60 matches → only 50 kept
    const rules = [{ ...SIMPLE_RULE, conditionDsl: { all: [{ op: "text_contains", needle: "x" }] } }];
    const ctx = makeCtxWithRules(rules);
    const hits = Array.from({ length: 60 }, (_, i) =>
      fakeHit({ id: `f-${i}`, content: "x", worth: 0.5 })
    );
    const out = await composeInferences(ctx, "w", hits);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("deduplicates near-identical firings of the same rule", async () => {
    // Two hits with same factKind → two matches, but expanded statement is identical
    const rule = { ...SIMPLE_RULE, actionDsl: { ...SIMPLE_RULE.actionDsl, statementTemplate: "FIXED STATEMENT" } };
    const ctx = makeCtxWithRules([rule]);
    const hits = [
      fakeHit({ id: "f-1", factKind: "objective_fact", content: "A", worth: 0.9 }),
      fakeHit({ id: "f-2", factKind: "objective_fact", content: "B", worth: 0.9 }),
    ];
    const out = await composeInferences(ctx, "w", hits);
    // Both expand "$a" to different content, so statement IS different ("FIXED STATEMENT" has no $a)
    // Wait — statementTemplate "FIXED STATEMENT" has no token → both expand identically → dedup → 1
    expect(out.length).toBe(1);
  });

  it("calls materialiseInference when materialise:true", async () => {
    const ctx = makeCtxWithRules([SIMPLE_RULE]);
    const out = await composeInferences(ctx, "w", [
      fakeHit({ id: "f-1", factKind: "objective_fact", content: "X", worth: 0.9 }),
    ], { materialise: true });
    expect(ctx.storage.materialiseInference).toHaveBeenCalledOnce();
    expect(out[0]?.materialisedFactId).toBe("derived-1");
  });
});

describe("evaluateRule", () => {
  it("evaluates inline synthetic rule correctly", async () => {
    const rule = {
      id: "inline-1", name: "inline test",
      // Bind the matched hit so its worth feeds premiseAvgWorth (else premises are
      // empty → premiseAvgWorth 0.5 → confidence 0.3, which the §32 filter drops).
      conditionDsl: { all: [{ op: "text_contains", needle: "auth", bind: "$a" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "Auth pattern detected", kind: "inferred", baseConfidence: 0.6, sensitivity: "internal" },
      priority: 0, isActive: true, executionCount: 0,
    };
    const ctx = makeCtxWithRules([]);
    const out = await evaluateRule(ctx, rule, "w", [
      fakeHit({ id: "f-1", content: "auth token expired", worth: 1.0 }),
    ], { materialise: false });
    expect(out).toHaveLength(1); // confidence = 0.6 × 1.0 = 0.6 > 0.5 gate
    expect(out[0]!.derivedStatement).toBe("Auth pattern detected");
  });
});
