// flatten-legacy-dual-core PR9f (design.md D6.5) — pure-function proof for
// `traverseGraph`/`findGraphPath`, reproducing legacy `traverseRelations`/
// `findShortestPath`'s (packages/core/src/graph/traverse.ts) exact
// undirected BFS/pathfinding semantics, hop caps, and dismissed/verb
// filters — but over `StorageAdapter.getRelations` instead of a
// `WITH RECURSIVE` CTE. No DB: a small in-memory fake reproduces
// `RelationFilter`'s exact matching semantics (sourceIds/targetIds/verbs/
// validAt), so these tests exercise the SAME filtering contract the real
// adapter implements.
import { describe, it, expect } from "vitest";
import { traverseGraph, findGraphPath } from "../graph/traverse.js";
import type { GraphTraverseDeps } from "../graph/traverse.js";

interface FakeRelationRow {
  sourceId: string;
  targetId: string;
  verb: string;
  judgmentStatus: string;
  validFrom?: Date;
  validTo?: Date | null;
}

function fakeDeps(rows: FakeRelationRow[]): GraphTraverseDeps {
  return {
    storage: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getRelations: async (filter: any) => {
        let items = rows;
        if (filter.sourceIds) {
          const set = new Set(filter.sourceIds);
          items = items.filter((r) => set.has(r.sourceId));
        }
        if (filter.targetIds) {
          const set = new Set(filter.targetIds);
          items = items.filter((r) => set.has(r.targetId));
        }
        if (filter.verbs) {
          const set = new Set(filter.verbs);
          items = items.filter((r) => set.has(r.verb));
        }
        if (filter.validAt) {
          const at = filter.validAt as Date;
          items = items.filter((r) => {
            const from = r.validFrom ?? new Date(0);
            const to = r.validTo ?? null;
            return from <= at && (to === null || to > at);
          });
        }
        return items as never;
      },
    },
  };
}

// Undirected chain A - B - C - D - E - F - G (7 nodes, 6 edges), alternating
// which side is `sourceId` to prove both directions are followed.
const CHAIN: FakeRelationRow[] = [
  { sourceId: "A", targetId: "B", verb: "related", judgmentStatus: "pending" },
  { sourceId: "C", targetId: "B", verb: "related", judgmentStatus: "pending" }, // reversed
  { sourceId: "C", targetId: "D", verb: "related", judgmentStatus: "pending" },
  { sourceId: "E", targetId: "D", verb: "related", judgmentStatus: "pending" }, // reversed
  { sourceId: "E", targetId: "F", verb: "related", judgmentStatus: "pending" },
  { sourceId: "G", targetId: "F", verb: "related", judgmentStatus: "pending" }, // reversed
];

describe("traverseGraph", () => {
  it("discovers an undirected chain, min hop per node, relevance = decay^hop", async () => {
    const hits = await traverseGraph(fakeDeps(CHAIN), "ws1", "A", { maxHops: 3 });
    expect(hits).toEqual([
      { id: "B", hop: 1, relevance: Math.pow(0.6, 1) },
      { id: "C", hop: 2, relevance: Math.pow(0.6, 2) },
      { id: "D", hop: 3, relevance: Math.pow(0.6, 3) },
    ]);
  });

  it("never re-includes the root node itself", async () => {
    const hits = await traverseGraph(fakeDeps(CHAIN), "ws1", "A", { maxHops: 6 });
    expect(hits.some((h) => h.id === "A")).toBe(false);
  });

  it("hard-caps maxHops at 6 even when a larger value is requested", async () => {
    const hits = await traverseGraph(fakeDeps(CHAIN), "ws1", "A", { maxHops: 999 });
    // Chain has 6 hops total (A->G); requesting 999 must still stop at 6, and
    // since the chain is exactly 6 hops long, G (hop 6) IS reached — proving
    // the cap is 6, not lower — but nothing beyond it could ever be (no more
    // edges exist), so this alone doesn't distinguish 6 from "uncapped". The
    // explicit cap is proven directly below with a 7-hop-deep chain.
    expect(hits.map((h) => h.id)).toEqual(["B", "C", "D", "E", "F", "G"]);
    expect(hits[hits.length - 1]).toEqual({ id: "G", hop: 6, relevance: Math.pow(0.6, 6) });
  });

  it("a chain longer than 6 hops is truncated at hop 6 (hard runaway cap)", async () => {
    const longChain: FakeRelationRow[] = [
      { sourceId: "A", targetId: "N1", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N1", targetId: "N2", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N2", targetId: "N3", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N3", targetId: "N4", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N4", targetId: "N5", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N5", targetId: "N6", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N6", targetId: "N7", verb: "related", judgmentStatus: "pending" }, // hop 7 — must NOT appear
    ];
    const hits = await traverseGraph(fakeDeps(longChain), "ws1", "A", { maxHops: 999 });
    expect(hits.map((h) => h.id)).toEqual(["N1", "N2", "N3", "N4", "N5", "N6"]);
    expect(hits.some((h) => h.id === "N7")).toBe(false);
  });

  it("excludes dismissed relations", async () => {
    const rows: FakeRelationRow[] = [
      { sourceId: "A", targetId: "B", verb: "related", judgmentStatus: "dismissed" },
      { sourceId: "A", targetId: "C", verb: "related", judgmentStatus: "pending" },
    ];
    const hits = await traverseGraph(fakeDeps(rows), "ws1", "A", { maxHops: 2 });
    expect(hits).toEqual([{ id: "C", hop: 1, relevance: 0.6 }]);
  });

  it("filters by relation verb", async () => {
    const rows: FakeRelationRow[] = [
      { sourceId: "A", targetId: "B", verb: "related", judgmentStatus: "pending" },
      { sourceId: "A", targetId: "C", verb: "derived_from", judgmentStatus: "pending" },
    ];
    const hits = await traverseGraph(fakeDeps(rows), "ws1", "A", {
      maxHops: 2,
      relations: ["derived_from"],
    });
    expect(hits).toEqual([{ id: "C", hop: 1, relevance: 0.6 }]);
  });

  it("does not infinite-loop on a cycle and reports each node's shortest hop once", async () => {
    // Triangle A-B-C-A.
    const rows: FakeRelationRow[] = [
      { sourceId: "A", targetId: "B", verb: "related", judgmentStatus: "pending" },
      { sourceId: "B", targetId: "C", verb: "related", judgmentStatus: "pending" },
      { sourceId: "C", targetId: "A", verb: "related", judgmentStatus: "pending" },
    ];
    const hits = await traverseGraph(fakeDeps(rows), "ws1", "A", { maxHops: 6 });
    expect(hits).toEqual([
      { id: "B", hop: 1, relevance: 0.6 },
      { id: "C", hop: 1, relevance: 0.6 },
    ]);
  });

  it("respects a custom decay factor", async () => {
    const hits = await traverseGraph(fakeDeps(CHAIN), "ws1", "A", { maxHops: 1, decay: 0.5 });
    expect(hits).toEqual([{ id: "B", hop: 1, relevance: 0.5 }]);
  });

  it("respects validAt — an edge outside the bitemporal window is not followed", async () => {
    const rows: FakeRelationRow[] = [
      {
        sourceId: "A",
        targetId: "B",
        verb: "related",
        judgmentStatus: "pending",
        validFrom: new Date("2026-06-01T00:00:00Z"),
        validTo: null,
      },
    ];
    const before = await traverseGraph(fakeDeps(rows), "ws1", "A", {
      maxHops: 1,
      asOf: new Date("2026-01-01T00:00:00Z"),
    });
    expect(before).toEqual([]);

    const after = await traverseGraph(fakeDeps(rows), "ws1", "A", {
      maxHops: 1,
      asOf: new Date("2026-07-01T00:00:00Z"),
    });
    expect(after).toEqual([{ id: "B", hop: 1, relevance: 0.6 }]);
  });
});

describe("findGraphPath", () => {
  it("finds the shortest undirected path through a chain, with edge verbs", async () => {
    const result = await findGraphPath(fakeDeps(CHAIN), "ws1", "A", "D", { maxHops: 6 });
    expect(result.path).toEqual(["A", "B", "C", "D"]);
    // Edges echo the RAW stored source_id/target_id (matches legacy
    // `findShortestPath`'s re-query), not walk order — the B-C edge is
    // physically stored as C->B (see CHAIN's "reversed" comment above).
    expect(result.edges).toEqual([
      { source: "A", target: "B", relation: "related" },
      { source: "C", target: "B", relation: "related" },
      { source: "C", target: "D", relation: "related" },
    ]);
  });

  it("returns { path: [from], edges: [] } when from === to", async () => {
    const result = await findGraphPath(fakeDeps(CHAIN), "ws1", "A", "A");
    expect(result).toEqual({ path: ["A"], edges: [] });
  });

  it("returns an empty path when unreachable within maxHops", async () => {
    const result = await findGraphPath(fakeDeps(CHAIN), "ws1", "A", "G", { maxHops: 2 });
    expect(result).toEqual({ path: [], edges: [] });
  });

  it("hard-caps maxHops at 6", async () => {
    const longChain: FakeRelationRow[] = [
      { sourceId: "A", targetId: "N1", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N1", targetId: "N2", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N2", targetId: "N3", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N3", targetId: "N4", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N4", targetId: "N5", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N5", targetId: "N6", verb: "related", judgmentStatus: "pending" },
      { sourceId: "N6", targetId: "N7", verb: "related", judgmentStatus: "pending" }, // hop 7
    ];
    const unreachable = await findGraphPath(fakeDeps(longChain), "ws1", "A", "N7", {
      maxHops: 999,
    });
    expect(unreachable).toEqual({ path: [], edges: [] });

    const reachable = await findGraphPath(fakeDeps(longChain), "ws1", "A", "N6", {
      maxHops: 999,
    });
    expect(reachable.path).toEqual(["A", "N1", "N2", "N3", "N4", "N5", "N6"]);
  });

  it("excludes dismissed relations from pathfinding", async () => {
    const rows: FakeRelationRow[] = [
      { sourceId: "A", targetId: "B", verb: "related", judgmentStatus: "dismissed" },
      { sourceId: "A", targetId: "C", verb: "related", judgmentStatus: "pending" },
      { sourceId: "C", targetId: "B", verb: "related", judgmentStatus: "pending" },
    ];
    const result = await findGraphPath(fakeDeps(rows), "ws1", "A", "B", { maxHops: 6 });
    expect(result.path).toEqual(["A", "C", "B"]);
  });
});

describe("sensitivity ceiling", () => {
  it("both walks pass maxSensitivity to every getRelations call", async () => {
    const filters: Array<{ maxSensitivity?: string }> = [];
    const deps: GraphTraverseDeps = {
      storage: {
        getRelations: async (filter) => {
          filters.push(filter);
          return fakeDeps(CHAIN).storage.getRelations(filter);
        },
      },
    };
    await traverseGraph(deps, "ws1", "A", { maxHops: 2, maxSensitivity: "internal" });
    await findGraphPath(deps, "ws1", "A", "D", { maxHops: 3, maxSensitivity: "internal" });
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((f) => f.maxSensitivity === "internal")).toBe(true);
  });
});
