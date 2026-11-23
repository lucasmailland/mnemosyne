/**
 * LIFECYCLE-7/8 — the in-memory adapter's `commitSessionCollapse` keeps parity
 * with the Postgres one: all-or-nothing writes, one winner per session.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "00000000-0000-4000-8000-000000000001";

async function setup() {
  const storage = new InMemoryStorageAdapter();
  const session = await storage.createSession({ workspaceId: WS, agentId: "a" });
  return { storage, sessionId: session.id };
}

const fact = (statement: string) => ({
  workspaceId: WS,
  scope: "global" as const,
  statement,
  subject: "s",
  kind: "other" as const,
  confidence: 0.9,
});

describe("InMemoryStorageAdapter.commitSessionCollapse", () => {
  it("commits the writes and marks the session collapsed", async () => {
    const { storage, sessionId } = await setup();

    const out = await storage.commitSessionCollapse({ workspaceId: WS, sessionId }, async (tx) => {
      const f = await tx.createFact(fact("kept"));
      return f.id;
    });

    expect(out.committed).toBe(true);
    expect((await storage.getSession(sessionId, WS))?.status).toBe("collapsed");
    expect((await storage.queryFacts({ workspaceId: WS })).items.map((f) => f.statement)).toEqual([
      "kept",
    ]);
  });

  it("leaves nothing behind when apply throws", async () => {
    const { storage, sessionId } = await setup();

    await expect(
      storage.commitSessionCollapse({ workspaceId: WS, sessionId }, async (tx) => {
        await tx.createFact(fact("rolled back"));
        throw new Error("injected");
      })
    ).rejects.toThrow("injected");

    expect((await storage.getSession(sessionId, WS))?.status).toBe("active");
    expect((await storage.queryFacts({ workspaceId: WS })).items).toHaveLength(0);
  });

  it("refuses a collapsed session without running apply", async () => {
    const { storage, sessionId } = await setup();
    await storage.closeSession(sessionId, WS);
    let ran = false;

    const out = await storage.commitSessionCollapse({ workspaceId: WS, sessionId }, async () => {
      ran = true;
    });

    expect(out).toEqual({ committed: false, status: "collapsed" });
    expect(ran).toBe(false);
  });

  it("lets exactly one of two concurrent commits win", async () => {
    const { storage, sessionId } = await setup();
    const commit = () =>
      storage.commitSessionCollapse({ workspaceId: WS, sessionId }, async (tx) => {
        await tx.createFact(fact("once"));
      });

    const results = await Promise.all([commit(), commit()]);

    expect(results.filter((r) => r.committed)).toHaveLength(1);
    expect((await storage.queryFacts({ workspaceId: WS })).items).toHaveLength(1);
  });
});
