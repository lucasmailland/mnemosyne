import { describe, it, expect, vi } from "vitest";
import { recordCoRecall } from "../co-recall.js";

function fakeStorage() {
  const relations = new Map<string, any>();
  return {
    relations,
    getRelations: vi.fn(async ({ sourceId, targetId }: any) =>
      [...relations.values()].filter((r) => r.sourceId === sourceId && r.targetId === targetId)
    ),
    createRelation: vi.fn(async (input: any) => {
      const rel = { id: `rel-${relations.size + 1}`, ...input };
      relations.set(rel.id, rel);
      return rel;
    }),
    recordCoRecallStdp: vi.fn(async () => undefined),
  } as any;
}

describe("recordCoRecall (co-occurrence / Hebbian STDP)", () => {
  it("no-ops for fewer than 2 facts", async () => {
    const s = fakeStorage();
    const n = await recordCoRecall(s, "ws", ["only-one"]);
    expect(n).toBe(0);
    expect(s.recordCoRecallStdp).not.toHaveBeenCalled();
  });

  it("creates a relation and records co-recall for a pair", async () => {
    const s = fakeStorage();
    const n = await recordCoRecall(s, "ws", ["A", "B"], 1_000);
    expect(n).toBe(1);
    expect(s.createRelation).toHaveBeenCalledTimes(1);
    expect(s.recordCoRecallStdp).toHaveBeenCalledWith("ws", "rel-1", new Date(1000));
  });

  it("records all C(n,2) pairs and reuses existing relations", async () => {
    const s = fakeStorage();
    await recordCoRecall(s, "ws", ["A", "B", "C"], 2_000); // 3 pairs
    expect(s.recordCoRecallStdp).toHaveBeenCalledTimes(3);
    // second call with same set should reuse relations (no new createRelation)
    s.createRelation.mockClear();
    await recordCoRecall(s, "ws", ["A", "B", "C"], 3_000);
    expect(s.createRelation).not.toHaveBeenCalled();
    expect(s.recordCoRecallStdp).toHaveBeenCalledTimes(6);
  });

  it("caps the pair explosion at CO_RECALL_TOP_K (≤15 pairs for 8 ids)", async () => {
    const s = fakeStorage();
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    await recordCoRecall(s, "ws", ids, 4_000);
    // top-K=6 → C(6,2)=15
    expect(s.recordCoRecallStdp).toHaveBeenCalledTimes(15);
  });
});

// p60-corecall-stdp-convergence PR2 (D3) — onTail hook: measures what
// Option 1's cap gives up, reported through the same fire-and-forget host
// hook pattern as onHotTierEvict/onCacheError.
describe("recordCoRecall — onTail hook (p60 D3)", () => {
  it("is not emitted for fewer than 2 ids", async () => {
    const s = fakeStorage();
    const onTail = vi.fn();
    await recordCoRecall(s, "ws", ["only-one"], 1_000, onTail);
    expect(onTail).not.toHaveBeenCalled();
  });

  it("reports skippedPairs === 0 when candidateFacts <= CO_RECALL_TOP_K", async () => {
    const s = fakeStorage();
    const onTail = vi.fn();
    await recordCoRecall(s, "ws", ["a", "b", "c"], 1_000, onTail);
    expect(onTail).toHaveBeenCalledTimes(1);
    expect(onTail).toHaveBeenCalledWith({
      workspaceId: "ws",
      candidateFacts: 3,
      capK: 6,
      processedPairs: 3, // C(3,2)
      skippedPairs: 0,
    });
  });

  it("reports processedPairs 15 / skippedPairs 30 for n=10 candidates (cap=6)", async () => {
    const s = fakeStorage();
    const onTail = vi.fn();
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    await recordCoRecall(s, "ws", ids, 1_000, onTail);
    expect(onTail).toHaveBeenCalledTimes(1);
    expect(onTail).toHaveBeenCalledWith({
      workspaceId: "ws",
      candidateFacts: 10,
      capK: 6,
      processedPairs: 15, // C(6,2)
      skippedPairs: 30, // C(10,2) - C(6,2) = 45 - 15
    });
  });

  it("counts candidateFacts from the distinct id set (dedup before slicing)", async () => {
    const s = fakeStorage();
    const onTail = vi.fn();
    // duplicate "a" should not inflate candidateFacts
    await recordCoRecall(s, "ws", ["a", "a", "b", "c"], 1_000, onTail);
    expect(onTail).toHaveBeenCalledWith(
      expect.objectContaining({ candidateFacts: 3, processedPairs: 3, skippedPairs: 0 })
    );
  });

  it("a throwing hook never breaks recordCoRecall's return value", async () => {
    const s = fakeStorage();
    const onTail = vi.fn(() => {
      throw new Error("boom");
    });
    const n = await recordCoRecall(s, "ws", ["a", "b", "c"], 1_000, onTail);
    expect(n).toBe(3);
    expect(s.recordCoRecallStdp).toHaveBeenCalledTimes(3);
  });
});
