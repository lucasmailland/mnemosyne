import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../testing/InMemoryStorageAdapter.js";

const workspaceId = "00000000-0000-4000-8000-000000000101";
const binding = {
  workspaceId,
  actorId: "key:capture",
  sourceSessionId: "conversation",
  sourceClientInstanceId: "client",
  sourceGeneration: 0,
};
const turn = (sessionId: string, sourceMessageId: string) => ({
  workspaceId,
  sessionId,
  turnIndex: 0,
  role: "user" as const,
  content: "yes",
  tokenCount: 1,
  sourceMessageId,
});

describe("legacy continuity", () => {
  it("retries start and successor creation without branching; keeps occurrence identity across segments", async () => {
    const storage = new InMemoryStorageAdapter();
    const root = await storage.createSession(binding);
    expect((await storage.createSession(binding)).id).toBe(root.id);
    await storage.appendTurn(root.id, turn(root.id, "occurrence-1"));
    await storage.closeSession(root.id, workspaceId);
    const next = { ...binding, sourceGeneration: 1, predecessorSessionId: root.id };
    const [a, b] = await Promise.all([storage.createSession(next), storage.createSession(next)]);
    expect(a.id).toBe(b.id);
    expect(a.predecessorSessionId).toBe(root.id);
    await storage.appendTurn(a.id, turn(a.id, "occurrence-1")); // ACK lost before rollover
    await storage.appendTurn(a.id, turn(a.id, "occurrence-2")); // identical text, new occurrence
    expect((await storage.listTurns(root.id, workspaceId)).map((t) => t.sourceMessageId)).toEqual([
      "occurrence-1",
    ]);
    expect((await storage.listTurns(a.id, workspaceId)).map((t) => t.sourceMessageId)).toEqual([
      "occurrence-2",
    ]);
    expect((await storage.getSession(a.id, workspaceId))?.turnCount).toBe(1);
  });

  it("refuses successors of active, foreign or mismatched conversations", async () => {
    const storage = new InMemoryStorageAdapter();
    const root = await storage.createSession(binding);
    const next = { ...binding, sourceGeneration: 1, predecessorSessionId: root.id };
    await expect(storage.createSession(next)).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
    await storage.closeSession(root.id, workspaceId);
    await expect(storage.createSession({ ...next, workspaceId: "other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(storage.createSession({ ...next, actorId: "key:other" })).rejects.toMatchObject({
      code: "SESSION_BINDING_MISMATCH",
    });
  });

  it("fences a stale collapse snapshot when a late turn is accepted", async () => {
    const storage = new InMemoryStorageAdapter();
    const root = await storage.createSession(binding);
    await storage.appendTurn(root.id, turn(root.id, "one"));
    const snapshot = (await storage.getSession(root.id, workspaceId))!;
    await storage.appendTurn(root.id, turn(root.id, "two"));
    await expect(
      storage.commitSessionCollapse(
        { workspaceId, sessionId: root.id, expectedTurnCount: snapshot.turnCount },
        async () => true
      )
    ).rejects.toMatchObject({ code: "SESSION_SNAPSHOT_CHANGED" });
    expect((await storage.getSession(root.id, workspaceId))?.status).toBe("active");
  });
});
