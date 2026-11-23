import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

describe("InMemoryStorageAdapter — composition/inference/fact_hash (Wave E)", () => {
  const workspaceId = "ws-e7";
  let adapter: InMemoryStorageAdapter;

  it("composition rule CRUD + bumpExecution", async () => {
    adapter = new InMemoryStorageAdapter();
    const rule = await adapter.createCompositionRule({
      workspaceId, name: "r1", conditionDsl: {}, actionDsl: {}, priority: 5,
    });
    expect(rule.isActive).toBe(true);
    expect(rule.source).toBe("manual");

    const patched = await adapter.updateCompositionRule(rule.id, workspaceId, { isActive: false });
    expect(patched.isActive).toBe(false);

    const page = await adapter.queryCompositionRules({ workspaceId, isActive: false });
    expect(page.items.some(r => r.id === rule.id)).toBe(true);

    await adapter.bumpCompositionExecution(rule.id, workspaceId);
    const after = await adapter.getCompositionRule(rule.id, workspaceId);
    expect(after?.executionCount).toBe(1);
  });

  it("inference log append + query", async () => {
    adapter = new InMemoryStorageAdapter();
    const rule = await adapter.createCompositionRule({ workspaceId, name: "r2", conditionDsl: {}, actionDsl: {} });
    const entry = await adapter.appendInference({
      workspaceId, ruleId: rule.id, inputFactIds: ["f1", "f2"],
      confidence: 0.9, derivedKind: "fact", derivedId: "fd",
    });
    expect(entry.confidence).toBeCloseTo(0.9);

    const page = await adapter.queryInferences({ workspaceId, ruleId: rule.id });
    expect(page.items[0]?.id).toBe(entry.id);
  });

  it("fact hash upsert idempotent", async () => {
    adapter = new InMemoryStorageAdapter();
    const h = "abc123";
    const first = await adapter.upsertFactHash({ workspaceId, statementHash: h, factId: "fx" });
    expect(first.seenCount).toBe(1);
    const second = await adapter.upsertFactHash({ workspaceId, statementHash: h, factId: "fx" });
    expect(second.seenCount).toBe(2);
    const looked = await adapter.lookupFactHash(workspaceId, h);
    expect(looked?.seenCount).toBe(2);
  });
});
