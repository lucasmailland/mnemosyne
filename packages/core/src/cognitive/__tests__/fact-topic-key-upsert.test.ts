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
    config: { surpriseThreshold: 0, maxHotTierSize: 1000, worthDecayLambda: 0.1, hotTierTtlSeconds: 1 },
  } as never;
}

const auth = { workspaceId: "ws-t", actorId: "a1", actorType: "agent", scopes: ["memory:write"], sensitivityCeiling: "restricted" } as unknown as AuthContext;

describe("remember() — fact topic-key idempotent upsert (spec §25.4)", () => {
  it("two remembers with the same topic_key produce ONE active fact with revisionCount=2", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);

    const r1 = await remember(ctx, {
      workspaceId: "ws-t", kind: "fact", content: "Deploy target is us-east-1",
      subject: "deploy-region", topicKey: "deploy.region",
    } as never, auth);

    const r2 = await remember(ctx, {
      workspaceId: "ws-t", kind: "fact", content: "Deploy target is eu-west-1",
      subject: "deploy-region", topicKey: "deploy.region",
    } as never, auth);

    expect(r2.id).toBe(r1.id);

    const active = await storage.queryFacts({ workspaceId: "ws-t", topicKey: "deploy.region", status: "active" });
    expect(active.items).toHaveLength(1);
    expect(active.items[0]!.revisionCount).toBe(2);
    expect(active.items[0]!.statement).toBe("Deploy target is eu-west-1");
  });

  it("facts without topic_key always insert (no upsert)", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    await remember(ctx, { workspaceId: "ws-t", kind: "fact", content: "A", subject: "x" } as never, auth);
    await remember(ctx, { workspaceId: "ws-t", kind: "fact", content: "B", subject: "x" } as never, auth);
    const all = await storage.queryFacts({ workspaceId: "ws-t" });
    expect(all.items.length).toBe(2);
  });

  it("merges tags and preserves unrelated metadata on an existing topic-key upsert", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const first = await remember(ctx, {
      workspaceId: "ws-t", kind: "fact", content: "First", subject: "x", topicKey: "topic",
      tags: ["existing"], metadata: { owner: "platform" },
    } as never, auth);

    await remember(ctx, {
      workspaceId: "ws-t", kind: "fact", content: "Second", subject: "x", topicKey: "topic",
      tags: ["incoming"], metadata: { source: "review" },
    } as never, auth);

    const updated = await storage.getFact(first.id, "ws-t");
    expect(updated?.metadata).toEqual({
      owner: "platform",
      source: "review",
      tags: ["existing", "incoming"],
    });
  });

  it("uses the atomic topic-key merge port instead of read-modify-write", async () => {
    const storage = new InMemoryStorageAdapter();
    const first = await storage.createFact({
      workspaceId: "ws-t", scope: "global", statement: "First", subject: "x", kind: "other",
      topicKey: "atomic", metadata: { owner: "platform", tags: ["existing"] },
    });
    const merge = vi.spyOn(storage, "mergeFactByTopicKey");
    const query = vi.spyOn(storage, "queryFacts");
    const update = vi.spyOn(storage, "updateFact");

    const result = await remember(makeCtx(storage), {
      workspaceId: "ws-t", kind: "fact", content: "Second", subject: "x", topicKey: "atomic",
      tags: ["incoming"], metadata: { source: "review" },
    } as never, auth);

    expect(result.id).toBe(first.id);
    expect(merge).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("merges tags and preserves metadata when a concurrent topic-key insert wins", async () => {
    const storage = new InMemoryStorageAdapter();
    const winner = await storage.createFact({
      workspaceId: "ws-t", scope: "global", statement: "Winner", subject: "x", kind: "other",
      topicKey: "race", metadata: { owner: "platform", tags: ["existing"] },
    });
    const realMerge = storage.mergeFactByTopicKey.bind(storage);
    const merge = vi.spyOn(storage, "mergeFactByTopicKey")
      .mockResolvedValueOnce(null)
      .mockImplementation((input) => realMerge(input));
    vi.spyOn(storage, "createFact").mockRejectedValueOnce(new Error("23505 idx_fact_topic"));

    const result = await remember(makeCtx(storage), {
      workspaceId: "ws-t", kind: "fact", content: "Race update", subject: "x", topicKey: "race",
      tags: ["incoming"], metadata: { source: "review" },
    } as never, auth);

    expect(result.id).toBe(winner.id);
    expect(merge).toHaveBeenCalledTimes(2);
    expect((await storage.getFact(winner.id, "ws-t"))?.metadata).toEqual({
      owner: "platform",
      source: "review",
      tags: ["existing", "incoming"],
    });
  });
});
