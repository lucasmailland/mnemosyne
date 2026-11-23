// flatten-legacy-dual-core PR9f (design.md D6.5) — pure-function proof for
// `assembleGraphSnapshot`, mirroring legacy `buildGraphData`'s
// focus-neighbourhood + meta-count tail (packages/core/src/graph/query.ts).
import { describe, it, expect } from "vitest";
import { assembleGraphSnapshot } from "../graph-assembly.js";
import type { GraphNode, GraphEdge } from "../relations.js";

function node(id: string, kind: GraphNode["kind"]): GraphNode {
  return {
    id,
    kind,
    label: id,
    mentionCount: 0,
    factCount: 0,
    avgMemoryStrength: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target, relation: "related", confidence: 0.7, provenance: null };
}

describe("assembleGraphSnapshot", () => {
  it("without focusEntityId returns all nodes/edges with correct per-kind meta counts", () => {
    const nodes = [
      node("e1", "entity"),
      node("e2", "entity"),
      node("ep1", "episode"),
      node("d1", "decision"),
    ];
    const edges = [edge("r1", "e1", "e2")];
    const snapshot = assembleGraphSnapshot(nodes, edges);
    expect(snapshot.nodes).toEqual(nodes);
    expect(snapshot.edges).toEqual(edges);
    expect(snapshot.meta).toEqual({
      entityCount: 2,
      episodeCount: 1,
      decisionCount: 1,
      relationCount: 1,
    });
  });

  it("with focusEntityId restricts to the focus node + its 1-hop neighbours (both edge directions)", () => {
    const nodes = [
      node("hub", "entity"),
      node("neighborOut", "entity"),
      node("neighborIn", "entity"),
      node("stranger", "entity"),
    ];
    const edges = [
      edge("r1", "hub", "neighborOut"), // hub is source
      edge("r2", "neighborIn", "hub"), // hub is target
      edge("r3", "neighborOut", "stranger"), // 2-hop away — excluded
    ];
    const snapshot = assembleGraphSnapshot(nodes, edges, { focusEntityId: "hub" });
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(["hub", "neighborIn", "neighborOut"]);
    expect(snapshot.edges.map((e) => e.id).sort()).toEqual(["r1", "r2"]);
    expect(snapshot.meta).toEqual({
      entityCount: 3,
      episodeCount: 0,
      decisionCount: 0,
      relationCount: 2,
    });
  });

  it("focus on a node with no edges returns just that node, zero edges", () => {
    const nodes = [node("lonely", "entity"), node("other", "entity")];
    const snapshot = assembleGraphSnapshot(nodes, [], { focusEntityId: "lonely" });
    expect(snapshot.nodes.map((n) => n.id)).toEqual(["lonely"]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.meta).toEqual({
      entityCount: 1,
      episodeCount: 0,
      decisionCount: 0,
      relationCount: 0,
    });
  });
});
