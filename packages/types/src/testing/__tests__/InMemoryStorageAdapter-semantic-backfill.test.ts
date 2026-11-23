// flatten-legacy-dual-core PR9g (design.md D6.5) — proof that
// `InMemoryStorageAdapter.backfillSemanticNeighbors` mirrors
// `GraphRepository.backfillSemanticNeighbors`'s (adapter-postgres) semantics:
// per-fact top-k/threshold cosine over active embedded facts, delete-then-
// insert idempotency, and (once backfilled) a real `includeSemantic` overlay
// on `getGraphSnapshot` — projected to entity pairs, same LEAST/GREATEST +
// max-cosine dedup as the real adapter's `loadSemanticEdges`.
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WS = "ws-semantic-backfill";

/** 4-dim unit vectors so cosine is trivial to reason about by hand. */
const BASE = [1, 0, 0, 0];
const NEAR = [0.99, 0.14, 0, 0]; // cosine(BASE, NEAR) ~ 0.99, well above threshold
const ORTHOGONAL = [0, 1, 0, 0]; // cosine(BASE, ORTHOGONAL) = 0, well below threshold

async function seedEmbeddedFacts(adapter: InMemoryStorageAdapter) {
  const ea = await adapter.createEntity({ workspaceId: WS, name: "EA", kind: "concept" });
  const eb = await adapter.createEntity({ workspaceId: WS, name: "EB", kind: "concept" });
  const ec = await adapter.createEntity({ workspaceId: WS, name: "EC", kind: "concept" });

  const fa = await adapter.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "fact a",
    subject: "s",
    kind: "trait",
    entityId: ea.id,
  });
  const fb = await adapter.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "fact b",
    subject: "s",
    kind: "trait",
    entityId: eb.id,
  });
  const fc = await adapter.createFact({
    workspaceId: WS,
    scope: "global",
    statement: "fact c",
    subject: "s",
    kind: "trait",
    entityId: ec.id,
  });

  adapter.setFactEmbedding(fa.id, BASE);
  adapter.setFactEmbedding(fb.id, NEAR);
  adapter.setFactEmbedding(fc.id, ORTHOGONAL);

  return { ea, eb, ec, fa, fb, fc };
}

describe("InMemoryStorageAdapter.backfillSemanticNeighbors", () => {
  it("links near-duplicate facts and excludes orthogonal ones below threshold", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seedEmbeddedFacts(adapter);

    const written = await adapter.backfillSemanticNeighbors({
      workspaceId: WS,
      k: 8,
      threshold: 0.75,
    });

    // Both directions (fa->fb top-1 neighbour, fb->fa top-1 neighbour) pass
    // threshold; fa/fb's edges to the orthogonal fc do not — matches
    // GraphRepository's un-deduped, per-fact top-k write semantics.
    expect(written).toBe(2);
  });

  it("is idempotent across repeated backfills", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seedEmbeddedFacts(adapter);

    const first = await adapter.backfillSemanticNeighbors({ workspaceId: WS });
    const second = await adapter.backfillSemanticNeighbors({ workspaceId: WS });

    expect(second).toBe(first);
  });

  it("scopes the backfill to the given workspace only", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seedEmbeddedFacts(adapter);

    const written = await adapter.backfillSemanticNeighbors({ workspaceId: "ws-other" });
    expect(written).toBe(0);
  });

  it("getGraphSnapshot(includeSemantic: true) projects the backfilled edges to entity pairs", async () => {
    const adapter = new InMemoryStorageAdapter();
    const { ea, eb, ec } = await seedEmbeddedFacts(adapter);
    await adapter.backfillSemanticNeighbors({ workspaceId: WS, k: 8, threshold: 0.75 });

    const snapshot = await adapter.getGraphSnapshot({ workspaceId: WS, includeSemantic: true });
    const semanticEdges = snapshot.edges.filter((e) => e.relation === "semantically_related");

    expect(semanticEdges).toHaveLength(1);
    const pair = [semanticEdges[0]!.source, semanticEdges[0]!.target].sort();
    expect(pair).toEqual([ea.id, eb.id].sort());
    expect(semanticEdges[0]!.provenance).toBe("semantic_knn");
    expect(pair).not.toContain(ec.id);
  });

  it("getGraphSnapshot omits the semantic overlay when includeSemantic is not set", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seedEmbeddedFacts(adapter);
    await adapter.backfillSemanticNeighbors({ workspaceId: WS, k: 8, threshold: 0.75 });

    const snapshot = await adapter.getGraphSnapshot({ workspaceId: WS });
    expect(snapshot.edges.some((e) => e.relation === "semantically_related")).toBe(false);
  });
});
