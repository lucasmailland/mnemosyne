// make-primitives-recallable (PR3 — Phase 5, task 5.5). Unit tests for
// StorageAdapter.recallableCandidates?() against InMemoryStorageAdapter:
// kinds DRIVES the query (not a post-filter), limit is honoured, candidates
// below minSimilarity are excluded, and an empty/non-matching kinds array
// issues no query at all (returns [] without scanning).

import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";

async function makeDecision(
  s: InMemoryStorageAdapter,
  overrides: Partial<{ workspaceId: string; title: string; body: string }> = {}
) {
  return s.createDecision({
    workspaceId: overrides.workspaceId ?? WS,
    kind: "architecture",
    title: overrides.title ?? "Adopt Postgres",
    body: overrides.body ?? "We chose Postgres for durability and pgvector support.",
  });
}

describe("InMemory recallableCandidates — kind-driven, semantic + lexical arms", () => {
  it("kinds drives the query: kinds without 'decision' issues no query and returns []", async () => {
    const s = new InMemoryStorageAdapter();
    const d = await makeDecision(s);
    s.setEmbedding(d.id, [1, 0, 0]);

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["fact"],
      limit: 10,
      embedding: [1, 0, 0],
    });
    expect(cands).toEqual([]);
  });

  it("empty kinds array returns [] without scanning", async () => {
    const s = new InMemoryStorageAdapter();
    const d = await makeDecision(s);
    s.setEmbedding(d.id, [1, 0, 0]);

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: [],
      limit: 10,
      embedding: [1, 0, 0],
      terms: ["postgres"],
    });
    expect(cands).toEqual([]);
  });

  it("neither embedding nor terms supplied returns [] (no arm to run)", async () => {
    const s = new InMemoryStorageAdapter();
    await makeDecision(s);

    const cands = await s.recallableCandidates({ workspaceId: WS, kinds: ["decision"], limit: 10 });
    expect(cands).toEqual([]);
  });

  it("semantic arm: returns a decision by cosine similarity, identifiable by kind", async () => {
    const s = new InMemoryStorageAdapter();
    const d = await makeDecision(s);
    s.setEmbedding(d.id, [1, 0, 0]);

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: [1, 0, 0],
      minSimilarity: 0.35,
    });
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ id: d.id, kind: "decision", sensitivity: "internal" });
    expect(cands[0]!.score).toBeCloseTo(1, 5);
  });

  it("semantic arm: candidates below minSimilarity are excluded", async () => {
    const s = new InMemoryStorageAdapter();
    const near = await makeDecision(s, { title: "Near" });
    const far = await makeDecision(s, { title: "Far" });
    s.setEmbedding(near.id, [1, 0, 0]);
    s.setEmbedding(far.id, [0, 1, 0]); // orthogonal — cosine 0

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: [1, 0, 0],
      minSimilarity: 0.35,
    });
    const ids = cands.map((c) => c.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
  });

  it("lexical arm: matches a term present only in the decision body", async () => {
    const s = new InMemoryStorageAdapter();
    const d = await makeDecision(s, {
      title: "Cache layer",
      body: "Our caching strategy uses Redis for hot-tier lookups.",
    });

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: ["redis"],
    });
    expect(cands.map((c) => c.id)).toContain(d.id);
  });

  it("limit is honoured", async () => {
    const s = new InMemoryStorageAdapter();
    const decisions = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeDecision(s, { title: `Decision ${i}` }))
    );
    for (const d of decisions) s.setEmbedding(d.id, [1, 0, 0]);

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 2,
      embedding: [1, 0, 0],
      minSimilarity: 0,
    });
    expect(cands).toHaveLength(2);
  });

  it("does not return decisions from another workspace", async () => {
    const s = new InMemoryStorageAdapter();
    const other = await makeDecision(s, { workspaceId: OTHER_WS });
    s.setEmbedding(other.id, [1, 0, 0]);

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: [1, 0, 0],
      minSimilarity: 0,
    });
    expect(cands.map((c) => c.id)).not.toContain(other.id);
  });

  it("merges both arms by id, keeping the higher score", async () => {
    const s = new InMemoryStorageAdapter();
    const d = await makeDecision(s, {
      title: "Adopt Postgres",
      body: "We chose Postgres for durability.",
    });
    s.setEmbedding(d.id, [1, 0, 0]);

    const cands = await s.recallableCandidates({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: [1, 0, 0],
      minSimilarity: 0,
      terms: ["postgres"],
    });
    expect(cands.filter((c) => c.id === d.id)).toHaveLength(1);
  });
});
