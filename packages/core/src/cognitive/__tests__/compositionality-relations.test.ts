import { describe, it, expect, vi } from "vitest";
import { composeInferences } from "../compositionality.js";
import type { RecallHit } from "@mnemo-ai/types";
import type { CoreContext } from "../context.js";

function hit(id: string, content: string, rels: Array<{ targetId: string; verb: string }> = []): RecallHit {
  return {
    id, primitive: "fact", content, score: 0.9, sensitivity: "internal",
    injectionScore: 0, provenance: "user_stated", origin: "local", contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null, tags: [],
    relations: rels.map((r, i) => ({ id: `rel-${id}-${i}`, targetId: r.targetId, targetKind: "fact", verb: r.verb, weight: 1 })),
    worth: 0.9, factKind: "objective_fact",
  } as unknown as RecallHit;
}

function ctxWithRules(rules: unknown[]): CoreContext {
  const storage = {
    queryCompositionRules: vi.fn(async () => ({ items: rules, total: rules.length, offset: 0, limit: 500, hasMore: false })),
    materialiseInference: vi.fn(async () => ({ id: "derived-1" })),
    appendInference: vi.fn(async () => ({})),
    bumpCompositionExecution: vi.fn(async () => undefined),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  return { storage, logger } as unknown as CoreContext;
}

const TRANSITIVE = {
  id: "builtin_transitive_dependency", name: "transitive_dependency", priority: 100, isActive: true, executionCount: 0,
  conditionDsl: { all: [
    { op: "relation", from: "$a", to: "$b", verb: "related" },
    { op: "relation", from: "$b", to: "$c", verb: "related" },
  ] },
  actionDsl: { op: "derive_fact", statementTemplate: "$a transitively depends on $c (via $b)", baseConfidence: 0.6, sensitivity: "internal" },
};

const SPOF = {
  id: "builtin_shared_dependency_risk", name: "shared_dependency_risk", priority: 90, isActive: true, executionCount: 0,
  conditionDsl: { all: [
    { op: "relation", from: "$a", to: "$x", verb: "related" },
    { op: "relation", from: "$b", to: "$x", verb: "related" },
    { op: "relation", from: "$c", to: "$x", verb: "related" },
  ] },
  actionDsl: { op: "derive_warning", statementTemplate: "⚠️ $x is a single point of failure — $a, $b, $c all depend on it", baseConfidence: 0.75, sensitivity: "internal" },
};

describe("composeInferences — relation DSL (spec §32)", () => {
  it("materialises A→B→C transitivity over relation edges", async () => {
    const ctx = ctxWithRules([TRANSITIVE]);
    const A = hit("A", "Service A", [{ targetId: "B", verb: "related" }]);
    const B = hit("B", "Service B", [{ targetId: "C", verb: "related" }]);
    const C = hit("C", "Service C");
    const out = await composeInferences(ctx, "w", [A, B, C]);
    const stmts = out.map((o) => o.derivedStatement);
    expect(stmts).toContain("Service A transitively depends on Service C (via Service B)");
    expect(out.find((o) => o.derivedStatement.includes("transitively"))!.type).toBe("fact");
  });

  it("emits a SPOF warning when 3 services share a dependency", async () => {
    const ctx = ctxWithRules([SPOF]);
    const A = hit("A", "Svc A", [{ targetId: "X", verb: "related" }]);
    const B = hit("B", "Svc B", [{ targetId: "X", verb: "related" }]);
    const C = hit("C", "Svc C", [{ targetId: "X", verb: "related" }]);
    const X = hit("X", "Database X");
    const out = await composeInferences(ctx, "w", [A, B, C, X]);
    const warn = out.find((o) => o.type === "warning");
    expect(warn).toBeDefined();
    expect(warn!.derivedStatement).toContain("single point of failure");
    expect(warn!.derivedStatement).toContain("Database X");
  });
});

describe("composeInferences — multi-hop fixpoint (spec §32, MAX_HOP_DEPTH=4)", () => {
  it("feeds a derived fact back as a premise to fire a second rule", async () => {
    const r1 = {
      id: "r1", name: "r1", priority: 100, isActive: true, executionCount: 0,
      conditionDsl: { all: [{ op: "text_contains", needle: "seedA", bind: "$a" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "STEP1 from $a", baseConfidence: 0.9, sensitivity: "internal" },
    };
    const r2 = {
      id: "r2", name: "r2", priority: 90, isActive: true, executionCount: 0,
      conditionDsl: { all: [{ op: "text_contains", needle: "STEP1", bind: "$b" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "STEP2 reached", baseConfidence: 0.9, sensitivity: "internal" },
    };
    const ctx = ctxWithRules([r1, r2]);
    const out = await composeInferences(ctx, "w", [hit("s", "seedA present")]);
    const stmts = out.map((o) => o.derivedStatement);
    expect(stmts).toContain("STEP1 from seedA present");
    expect(stmts).toContain("STEP2 reached");
    const step1 = out.find((o) => o.derivedStatement.startsWith("STEP1"))!;
    const step2 = out.find((o) => o.derivedStatement === "STEP2 reached")!;
    expect(step2.confidence).toBeLessThan(step1.confidence);
  });
});

describe("composeInferences — conflict resolution (spec §32)", () => {
  it("keeps the higher-(priority,confidence) of two contradictory derivations", async () => {
    const positive = {
      id: "pos", name: "pos", priority: 100, isActive: true, executionCount: 0,
      conditionDsl: { all: [{ op: "text_contains", needle: "svcX", bind: "$a" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "svcX is current", baseConfidence: 0.9, sensitivity: "internal" },
    };
    const negative = {
      id: "neg", name: "neg", priority: 50, isActive: true, executionCount: 0,
      conditionDsl: { all: [{ op: "text_contains", needle: "svcX", bind: "$a" }] },
      actionDsl: { op: "derive_fact", statementTemplate: "svcX is not current", baseConfidence: 0.9, sensitivity: "internal" },
    };
    const ctx = ctxWithRules([positive, negative]);
    const out = await composeInferences(ctx, "w", [hit("h", "svcX seen")]);
    const stmts = out.map((o) => o.derivedStatement);
    expect(stmts).toContain("svcX is current");
    expect(stmts).not.toContain("svcX is not current");
  });
});
