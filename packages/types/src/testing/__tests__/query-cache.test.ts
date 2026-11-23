/**
 * P59 (docs/archive/openspec/p59-query-cache-l3-fix) design.md D13 — InMemoryStorageAdapter
 * L3 query-cache parity: insert-only, age-window filter, topK equality,
 * newest-first candidate scan. This adapter is what every core unit test
 * asserts against; divergent semantics is how "green tests, dead SQL"
 * happened to the real Postgres path in the first place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "ws-query-cache";
const EMBEDDING_A = new Float32Array([1, 0, 0, 0]);
const EMBEDDING_B = new Float32Array([0, 1, 0, 0]);

describe("InMemoryStorageAdapter — L3 query cache (design.md D13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is insert-only: two identical writes produce two independent rows, both servable", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1"],
      resultKinds: ["fact"],
      topK: 10,
    });
    vi.advanceTimersByTime(1_000);
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1", "f2"],
      resultKinds: ["fact", "fact"],
      topK: 10,
    });

    // Newest write wins the read-side ordering (design.md D12).
    const hit = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      threshold: 0.99,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(hit).toEqual({ resultIds: ["f1", "f2"], resultKinds: ["fact", "fact"] });
  });

  it("matches topK exactly — a top_k=10 row never serves a topK=5 lookup", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1"],
      resultKinds: ["fact"],
      topK: 10,
    });

    const miss = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      threshold: 0.99,
      topK: 5,
      maxAgeMs: 60_000,
    });
    expect(miss).toBeNull();

    const hit = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      threshold: 0.99,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(hit).toEqual({ resultIds: ["f1"], resultKinds: ["fact"] });
  });

  it("age window: an entry older than maxAgeMs is not returned", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1"],
      resultKinds: ["fact"],
      topK: 10,
    });

    // Still fresh at 4 minutes.
    vi.advanceTimersByTime(4 * 60_000);
    expect(
      await adapter.lookupQueryCache({
        workspaceId: WS,
        embedding: EMBEDDING_A,
        threshold: 0.99,
        topK: 10,
        maxAgeMs: 5 * 60_000,
      })
    ).toEqual({ resultIds: ["f1"], resultKinds: ["fact"] });

    // Aged past the 5-minute window (D5's L3_MAX_AGE_MS).
    vi.advanceTimersByTime(2 * 60_000);
    expect(
      await adapter.lookupQueryCache({
        workspaceId: WS,
        embedding: EMBEDDING_A,
        threshold: 0.99,
        topK: 10,
        maxAgeMs: 5 * 60_000,
      })
    ).toBeNull();
  });

  it("cosine threshold: a below-threshold embedding misses, an at-or-above one hits", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1"],
      resultKinds: ["fact"],
      topK: 10,
    });

    const orthogonalMiss = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_B,
      threshold: 0.95,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(orthogonalMiss).toBeNull();

    const exactHit = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      threshold: 0.95,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(exactHit).toEqual({ resultIds: ["f1"], resultKinds: ["fact"] });
  });

  it("newest-first: a fresher entry is preferred over an older one that would also match", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["older"],
      resultKinds: ["fact"],
      topK: 10,
    });
    vi.advanceTimersByTime(1_000);
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["newer"],
      resultKinds: ["fact"],
      topK: 10,
    });

    const hit = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      threshold: 0.99,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(hit).toEqual({ resultIds: ["newer"], resultKinds: ["fact"] });
  });

  it("skips the write entirely for an empty result set or a resultIds/resultKinds length mismatch", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: [],
      resultKinds: [],
      topK: 10,
    });
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1"],
      resultKinds: [],
      topK: 10,
    });

    const miss = await adapter.lookupQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      threshold: 0.0,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(miss).toBeNull();
  });

  it("is workspace-scoped: a row written for one workspace never serves another's lookup", async () => {
    const adapter = new InMemoryStorageAdapter();
    await adapter.insertQueryCache({
      workspaceId: WS,
      embedding: EMBEDDING_A,
      resultIds: ["f1"],
      resultKinds: ["fact"],
      topK: 10,
    });

    const otherWorkspaceMiss = await adapter.lookupQueryCache({
      workspaceId: "ws-other",
      embedding: EMBEDDING_A,
      threshold: 0.99,
      topK: 10,
      maxAgeMs: 60_000,
    });
    expect(otherWorkspaceMiss).toBeNull();
  });
});
