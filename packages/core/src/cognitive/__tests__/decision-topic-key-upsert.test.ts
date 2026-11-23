import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    vector: { search: async () => [] },
    embed: { embedSingle: async () => new Float32Array(1536).fill(0.1) },
    telemetry: { startSpan: () => ({ end: () => {} }) },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 1,
    },
  } as never;
}

const auth = {
  workspaceId: "ws-t",
  actorId: "a1",
  actorType: "agent",
  scopes: ["memory:write"],
  sensitivityCeiling: "restricted",
} as unknown as AuthContext;

describe("remember() — decision topic-key idempotent upsert", () => {
  it("two remembers with the same topicKey produce ONE active decision, revision bumped, no duplicate", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const r1 = await remember(
      ctx,
      {
        workspaceId: "ws-t",
        kind: "decision",
        content: "We will use event sourcing for the audit log",
        subject: "Audit log architecture",
        topicKey: "x",
      } as never,
      auth
    );

    const r2 = await remember(
      ctx,
      {
        workspaceId: "ws-t",
        kind: "decision",
        content: "We will use CQRS + event sourcing for the audit log",
        subject: "Audit log architecture v2",
        topicKey: "x",
      } as never,
      auth
    );

    expect(r2.id).toBe(r1.id);

    const active = await storage.queryDecisions({ workspaceId: "ws-t", status: "active" });
    expect(active.items).toHaveLength(1);
    expect(active.items[0]!.body).toBe("We will use CQRS + event sourcing for the audit log");
    expect(active.items[0]!.revisionCount).toBeGreaterThan(0);
  });

  it("decisions without topicKey always insert (no upsert)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    await remember(
      ctx,
      { workspaceId: "ws-t", kind: "decision", content: "A", subject: "d1" } as never,
      auth
    );
    await remember(
      ctx,
      { workspaceId: "ws-t", kind: "decision", content: "B", subject: "d2" } as never,
      auth
    );
    const all = await storage.queryDecisions({ workspaceId: "ws-t" });
    expect(all.items.length).toBe(2);
  });

  it("uses the atomic topic-key merge port on a hit instead of createDecision", async () => {
    const storage = new InMemoryStorageAdapter();
    const first = await storage.createDecision({
      workspaceId: "ws-t",
      title: "First",
      body: "First body",
      kind: "decision",
      topicKey: "atomic",
    });
    const merge = vi.spyOn(storage, "mergeDecisionByTopicKey");
    const createDecisionSpy = vi.spyOn(storage, "createDecision");

    const result = await remember(
      makeCtx(storage),
      {
        workspaceId: "ws-t",
        kind: "decision",
        content: "Second body",
        subject: "Second",
        topicKey: "atomic",
      } as never,
      auth
    );

    expect(result.id).toBe(first.id);
    expect(merge).toHaveBeenCalledOnce();
    expect(createDecisionSpy).not.toHaveBeenCalled();
  });

  it("injected 23505 on createDecision triggers re-merge and returns the race winner", async () => {
    const storage = new InMemoryStorageAdapter();
    const winner = await storage.createDecision({
      workspaceId: "ws-t",
      title: "Winner",
      body: "Winner body",
      kind: "decision",
      topicKey: "race",
    });
    const realMerge = storage.mergeDecisionByTopicKey.bind(storage);
    const merge = vi
      .spyOn(storage, "mergeDecisionByTopicKey")
      .mockResolvedValueOnce(null)
      .mockImplementation((input) => realMerge(input));
    vi.spyOn(storage, "createDecision").mockRejectedValueOnce(
      new Error("23505 uniq_mnemo_decision_topic")
    );

    const result = await remember(
      makeCtx(storage),
      {
        workspaceId: "ws-t",
        kind: "decision",
        content: "Race update body",
        subject: "Race update",
        topicKey: "race",
      } as never,
      auth
    );

    expect(result.id).toBe(winner.id);
    expect(merge).toHaveBeenCalledTimes(2);
    expect((await storage.getDecision(winner.id, "ws-t"))?.body).toBe("Race update body");
  });

  it("rethrows when createDecision raises 23505 but the re-merge also returns null", async () => {
    const storage = new InMemoryStorageAdapter();
    vi.spyOn(storage, "mergeDecisionByTopicKey").mockResolvedValue(null);
    vi.spyOn(storage, "createDecision").mockRejectedValueOnce(
      new Error("23505 uniq_mnemo_decision_topic")
    );

    await expect(
      remember(
        makeCtx(storage),
        {
          workspaceId: "ws-t",
          kind: "decision",
          content: "Body",
          subject: "Subject",
          topicKey: "unresolvable",
        } as never,
        auth
      )
    ).rejects.toThrow("23505");
  });

  it("rethrows non-topicKey errors from createDecision unchanged", async () => {
    const storage = new InMemoryStorageAdapter();
    vi.spyOn(storage, "createDecision").mockRejectedValueOnce(new Error("boom"));

    await expect(
      remember(
        makeCtx(storage),
        {
          workspaceId: "ws-t",
          kind: "decision",
          content: "Body",
          subject: "Subject",
          topicKey: "whatever",
        } as never,
        auth
      )
    ).rejects.toThrow("boom");
  });
});

describe("InMemoryStorageAdapter.mergeDecisionByTopicKey — direct port semantics", () => {
  it("matches case/whitespace-insensitively, bumps revision, merges metadata shallowly", async () => {
    const storage = new InMemoryStorageAdapter();
    const created = await storage.createDecision({
      workspaceId: "ws-t",
      title: "Original title",
      body: "Original body",
      kind: "decision",
      topicKey: "Auth-Strategy",
      metadata: { owner: "platform" },
    });

    const merged = await storage.mergeDecisionByTopicKey({
      workspaceId: "ws-t",
      topicKey: " auth-strategy ",
      title: "New title",
      body: "New body",
      kind: "architecture",
      metadata: { source: "review" },
    });

    expect(merged).not.toBeNull();
    expect(merged!.id).toBe(created.id);
    expect(merged!.title).toBe("New title");
    expect(merged!.body).toBe("New body");
    expect(merged!.kind).toBe("architecture");
    expect(merged!.revisionCount).toBe(created.revisionCount + 1);
    // The replaced text is kept in metadata.revisions (PRIM-18) next to the merged keys.
    expect(merged!.metadata).toMatchObject({ owner: "platform", source: "review" });
    expect((merged!.metadata as { revisions: Array<{ title: string }> }).revisions).toHaveLength(1);
    expect((merged!.metadata as { revisions: Array<{ title: string }> }).revisions[0]!.title).toBe(
      "Original title"
    );

    const all = await storage.queryDecisions({ workspaceId: "ws-t" });
    expect(all.items).toHaveLength(1);
  });

  it("returns null when no active row exists for the topicKey", async () => {
    const storage = new InMemoryStorageAdapter();
    const result = await storage.mergeDecisionByTopicKey({
      workspaceId: "ws-t",
      topicKey: "nonexistent",
      title: "Title",
      body: "Body",
      kind: "decision",
    });
    expect(result).toBeNull();
  });
});
