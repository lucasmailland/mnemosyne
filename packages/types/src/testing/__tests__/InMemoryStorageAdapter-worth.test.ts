import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

describe("InMemoryStorageAdapter — Beta-Bernoulli worth", () => {
  it("default worth = 0.5 (prior α=β=2)", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: "ws-1",
      statement: "test",
      subject: "ws",
      kind: "trait",
      scope: "global",
      attribution: "objective_fact",
    });
    expect(fact.worthAlpha).toBeCloseTo(2.0);
    expect(fact.worthBeta).toBeCloseTo(2.0);
    expect(fact.worth).toBeCloseTo(0.5);
  });

  it("updateWorth(success) bumps α and recomputes worth", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: "ws-1",
      statement: "test", subject: "ws", kind: "trait",
      scope: "global", attribution: "objective_fact",
    });
    await adapter.updateWorth(fact.id, fact.workspaceId, "fact", { success: 1, failure: 0, creditWeight: 1 });
    const after = await adapter.getFact(fact.id, "ws-1");
    expect(after!.worthAlpha).toBeCloseTo(3.0);
    expect(after!.worthBeta).toBeCloseTo(2.0);
    expect(after!.worth).toBeCloseTo(0.6);
  });

  it("updateWorth(failure) bumps β", async () => {
    const adapter = new InMemoryStorageAdapter();
    const fact = await adapter.createFact({
      workspaceId: "ws-1",
      statement: "test", subject: "ws", kind: "event",
      scope: "global", attribution: "objective_fact",
    });
    await adapter.updateWorth(fact.id, fact.workspaceId, "fact", { success: 0, failure: 1, creditWeight: 1 });
    const after = await adapter.getFact(fact.id, "ws-1");
    expect(after!.worthBeta).toBeCloseTo(3.0);
    expect(after!.worth).toBeCloseTo(2.0 / 5.0);
  });

  it("updateWorth no-ops on a fact carrying a pending consolidation marker", async () => {
    const WS = "11111111-1111-4111-8111-111111111111";
    const adapter = new InMemoryStorageAdapter();
    const survivor = await adapter.createFact({
      workspaceId: WS, statement: "survivor", subject: "ws", kind: "trait",
      scope: "global", attribution: "objective_fact",
    });
    const absorbed = await adapter.createFact({
      workspaceId: WS, statement: "absorbed", subject: "ws", kind: "trait",
      scope: "global", attribution: "objective_fact",
    });
    await (adapter as unknown as {
      applyConsolidationMerge(input: {
        operationId: string; workspaceId: string; survivorId: string;
        absorbedFactIds: string[]; leaseExpiresAt: Date;
      }): Promise<unknown>;
    }).applyConsolidationMerge({
      operationId: "op-worth-guard",
      workspaceId: WS,
      survivorId: survivor.id,
      absorbedFactIds: [absorbed.id],
      leaseExpiresAt: new Date("2026-07-17T12:15:00.000Z"),
    });
    const before = await adapter.getFact(survivor.id, WS);
    await adapter.updateWorth(survivor.id, WS, "fact", { success: 7, failure: 0, creditWeight: 1 });
    const after = await adapter.getFact(survivor.id, WS);
    expect(after!.worthAlpha).toBe(before!.worthAlpha);
    expect(after!.worthSuccess).toBe(before!.worthSuccess);
  });
});
