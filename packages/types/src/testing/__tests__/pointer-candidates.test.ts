import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "11111111-1111-1111-1111-111111111111";

// Minimal inline band signature helper (avoids circular dep on @mnemo-ai/core)
function fakeBands(seed: number) {
  return Array.from({ length: 6 }, (_, b) => ({ bandIdx: b, bandHash: BigInt(seed + b) }));
}

describe("InMemory pointerCandidates — FTS ∪ LSH narrowing", () => {
  it("returns facts whose LSH bands collide with the query signature", async () => {
    const s = new InMemoryStorageAdapter();
    const f = await s.createFact({
      workspaceId: WS, scope: "global", statement: "Acme ships on Fridays",
      subject: "acme", kind: "other",
    });
    const bands = fakeBands(42);
    await s.upsertFactLsh({ workspaceId: WS, factId: f.id, revision: f.revisionCount, bands });

    const cands = await s.pointerCandidates({
      workspaceId: WS,
      terms: [],
      bands,
      limit: 50,
    });
    expect(cands.map((c) => c.factId)).toContain(f.id);
  });

  it("returns facts matched purely by pointer term (FTS arm)", async () => {
    const s = new InMemoryStorageAdapter();
    const f = await s.createFact({
      workspaceId: WS, scope: "global", statement: "Billing webhook timeout is 30s",
      subject: "billing", kind: "other",
    });
    const cands = await s.pointerCandidates({
      workspaceId: WS, terms: ["billing", "webhook"], bands: [], limit: 50,
    });
    expect(cands.map((c) => c.factId)).toContain(f.id);
  });

  it("does not return facts from another workspace", async () => {
    const s = new InMemoryStorageAdapter();
    const other = "22222222-2222-2222-2222-222222222222";
    const f = await s.createFact({
      workspaceId: other, scope: "global", statement: "secret stuff",
      subject: "secret", kind: "other",
    });
    const bands = fakeBands(99);
    await s.upsertFactLsh({ workspaceId: other, factId: f.id, revision: f.revisionCount, bands });
    const cands = await s.pointerCandidates({ workspaceId: WS, terms: ["secret"], bands, limit: 50 });
    expect(cands.map((c) => c.factId)).not.toContain(f.id);
  });

  it("embedding is returned when set via setEmbedding", async () => {
    const s = new InMemoryStorageAdapter();
    const f = await s.createFact({
      workspaceId: WS, scope: "global", statement: "has embedding",
      subject: "embed", kind: "other",
    });
    s.setEmbedding(f.id, [1, 2, 3]);
    const cands = await s.pointerCandidates({ workspaceId: WS, terms: ["embedding"], bands: [], limit: 50 });
    const hit = cands.find((c) => c.factId === f.id);
    expect(hit?.embedding).toEqual([1, 2, 3]);
  });

  it("rejects late LSH writes from an older topic-key revision", async () => {
    const s = new InMemoryStorageAdapter();
    const fact = await s.createFact({
      workspaceId: WS, scope: "global", statement: "old revision", subject: "topic",
      kind: "other", topicKey: "revisioned",
    });
    const oldBands = fakeBands(200);
    const newBands = fakeBands(300);
    const merged = await s.mergeFactByTopicKey({
      workspaceId: WS, topicKey: "revisioned", statement: "new revision",
    });
    expect(merged).not.toBeNull();

    await s.upsertFactLsh({ workspaceId: WS, factId: fact.id, revision: fact.revisionCount, bands: oldBands });
    await s.upsertFactLsh({ workspaceId: WS, factId: fact.id, revision: merged!.revisionCount, bands: newBands });

    expect(await s.pointerCandidates({ workspaceId: WS, terms: [], bands: oldBands, limit: 10 })).toEqual([]);
    expect((await s.pointerCandidates({ workspaceId: WS, terms: [], bands: newBands, limit: 10 }))[0]?.factId).toBe(fact.id);
  });
});
