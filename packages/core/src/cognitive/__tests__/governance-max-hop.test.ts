import { describe, it, expect, vi } from "vitest";
import { propagateGovernanceForSession, GOVERNANCE_MAX_HOPS } from "../governance.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CoreContext } from "../context.js";
import type { CreateFactInput } from "@mnemo-ai/types";

const WS = "ws-gov-max-hop";

function makeCtx(storage: InMemoryStorageAdapter): CoreContext {
  return {
    storage,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  } as unknown as CoreContext;
}

function mkFactInput(i: number): CreateFactInput {
  return {
    workspaceId: WS,
    scope: "agent",
    statement: `fact ${i}`,
    subject: `subject-${i}`,
    kind: "preference",
  };
}

describe("propagateGovernanceForSession — TD(λ) max-5-hop (spec lines 1010-1039)", () => {
  it("caps DAG traversal at 5 hops and applies lambda^depth credit", async () => {
    expect(GOVERNANCE_MAX_HOPS).toBe(5);
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    // Build a 7-deep derived_from chain: f0 <- f1 <- f2 <- f3 <- f4 <- f5 <- f6
    // where f0 is the terminal (recalled in session), so f1..f5 should be credited,
    // f6 (6 hops away) should NOT be touched.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const f = await storage.createFact(mkFactInput(i));
      ids.push(f.id);
    }

    // Create derived_from chain: source=ids[i] derived_from target=ids[i+1]
    for (let i = 0; i < 6; i++) {
      await storage.createRelation({
        workspaceId: WS,
        sourceId: ids[i]!,
        targetId: ids[i + 1]!,
        verb: "derived_from",
      });
    }

    // Record f0 as recalled in session S.
    await storage.recordRecall({ workspaceId: WS, sessionId: "S", factId: ids[0]!, hitRank: 0 });

    // Spy on updateWorth to track which facts get credited
    const updateWorthSpy = vi.spyOn(storage, "updateWorth");

    await propagateGovernanceForSession(
      ctx,
      WS,
      "S",
      { success: 1, failure: 0, creditWeight: 1 },
      0.7,
    );

    const calledIds = updateWorthSpy.mock.calls.map((c) => c[0] as string);

    // f1..f5 (hops 1..5) should be credited
    expect(calledIds).toContain(ids[1]);
    expect(calledIds).toContain(ids[2]);
    expect(calledIds).toContain(ids[3]);
    expect(calledIds).toContain(ids[4]);
    expect(calledIds).toContain(ids[5]);

    // f6 (hop 6) is BEYOND the bound → never touched
    expect(calledIds).not.toContain(ids[6]);

    // Check lambda^depth credit values
    const callFor = (id: string) =>
      updateWorthSpy.mock.calls.find((c) => c[0] === id)?.[3];

    // f1 = hop 1, credit = 0.7^1
    expect(callFor(ids[1]!)?.creditWeight).toBeCloseTo(0.7, 5);
    // f5 = hop 5, credit = 0.7^5
    expect(callFor(ids[5]!)?.creditWeight).toBeCloseTo(0.7 ** 5, 5);
  });

  it("no-ops when sessionId is empty", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const spy = vi.spyOn(storage, "updateWorth");
    await propagateGovernanceForSession(ctx, WS, "", { success: 1, failure: 0 }, 0.7);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops when no facts were recalled in session", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const spy = vi.spyOn(storage, "updateWorth");
    await propagateGovernanceForSession(ctx, WS, "empty-session", { success: 1, failure: 0 }, 0.7);
    expect(spy).not.toHaveBeenCalled();
  });
});
