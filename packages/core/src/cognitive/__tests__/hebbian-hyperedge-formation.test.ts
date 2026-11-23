import { describe, it, expect, vi } from "vitest";
import { maybeFormHebbianHyperedge } from "../recall-cold.js";
import type { RecallHit } from "@mnemo-ai/types";

function hit(id: string, primitive: "fact" | "episode" = "fact", score = 0.9): RecallHit {
  return {
    id, primitive, content: id, score, sensitivity: "internal", injectionScore: 0,
    provenance: "user_stated", origin: "local", contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null, tags: [], relations: [],
  } as unknown as RecallHit;
}

interface StorageOpts {
  coRecall?: Array<{ partnerId: string; coRecallCount: number }>;
  existingHyperedges?: Array<{ id: string; memberIds: string[] }>;
}

function makeCtx(opts: StorageOpts = {}) {
  const createHyperedge = vi.fn(async (input: { memberIds: string[] }) => ({
    id: "he-new", memberIds: input.memberIds,
  }));
  const getCoOccurrencePatterns = vi.fn(async (args: { minCoRecall?: number }) =>
    (opts.coRecall ?? [])
      .filter((c) => c.coRecallCount >= (args.minCoRecall ?? 0))
      .map((c) => ({ workspaceId: "ws", sourceId: "anchor", partnerId: c.partnerId, coRecallCount: c.coRecallCount, hebbianWeight: 1 })),
  );
  const queryHyperedges = vi.fn(async () => ({
    items: (opts.existingHyperedges ?? []).map((h) => ({ ...h, workspaceId: "ws", activationCount: 0, worth: 0.5, validFrom: new Date(), createdAt: new Date(), isRoot: false })), // determinism-ok: throwaway fixture date, not asserted
    total: (opts.existingHyperedges ?? []).length, offset: 0, limit: 50, hasMore: false,
  }));
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const ctx = { storage: { createHyperedge, getCoOccurrencePatterns, queryHyperedges }, logger } as any;
  return { ctx, createHyperedge, getCoOccurrencePatterns, queryHyperedges };
}

describe("maybeFormHebbianHyperedge (spec §15)", () => {
  it("forms a hyperedge from an anchor + ≥2 consistently co-recalled members in the result set", async () => {
    const { ctx, createHyperedge } = makeCtx({
      coRecall: [
        { partnerId: "f-b", coRecallCount: 5 },
        { partnerId: "f-c", coRecallCount: 4 },
      ],
    });
    const served = [hit("f-a"), hit("f-b"), hit("f-c")];
    const id = await maybeFormHebbianHyperedge(ctx, "ws", served);
    expect(id).toBe("he-new");
    expect(createHyperedge).toHaveBeenCalledOnce();
    const memberIds = createHyperedge.mock.calls[0]![0].memberIds;
    expect(new Set(memberIds)).toEqual(new Set(["f-a", "f-b", "f-c"]));
  });

  it("does NOT form when fewer than 3 facts are served", async () => {
    const { ctx, createHyperedge } = makeCtx({ coRecall: [{ partnerId: "f-b", coRecallCount: 9 }] });
    const id = await maybeFormHebbianHyperedge(ctx, "ws", [hit("f-a"), hit("f-b")]);
    expect(id).toBeNull();
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("does NOT form when co-recall counts are below the consistency floor (single co-occurrence)", async () => {
    const { ctx, createHyperedge, getCoOccurrencePatterns } = makeCtx({
      coRecall: [
        { partnerId: "f-b", coRecallCount: 1 },
        { partnerId: "f-c", coRecallCount: 2 },
      ],
    });
    const served = [hit("f-a"), hit("f-b"), hit("f-c")];
    const id = await maybeFormHebbianHyperedge(ctx, "ws", served);
    expect(id).toBeNull();
    // the reader was asked with minCoRecall ≥ 3 → returns nothing → no clique
    expect(getCoOccurrencePatterns.mock.calls[0]![0].minCoRecall).toBeGreaterThanOrEqual(3);
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("ignores co-recall partners that were not served in this same recall event", async () => {
    const { ctx, createHyperedge } = makeCtx({
      coRecall: [
        { partnerId: "f-b", coRecallCount: 5 },
        { partnerId: "f-zz", coRecallCount: 9 }, // strong history but NOT in served set
      ],
    });
    // Only f-a and f-b are served → anchor + 1 partner = 2 members < 3.
    const id = await maybeFormHebbianHyperedge(ctx, "ws", [hit("f-a"), hit("f-b")]);
    expect(id).toBeNull();
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("is idempotent — skips creation when an existing hyperedge already covers the member set", async () => {
    const { ctx, createHyperedge } = makeCtx({
      coRecall: [
        { partnerId: "f-b", coRecallCount: 5 },
        { partnerId: "f-c", coRecallCount: 5 },
      ],
      existingHyperedges: [{ id: "he-old", memberIds: ["f-a", "f-b", "f-c", "f-d"] }],
    });
    const served = [hit("f-a"), hit("f-b"), hit("f-c")];
    const id = await maybeFormHebbianHyperedge(ctx, "ws", served);
    expect(id).toBeNull();
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("only counts fact primitives toward the member set", async () => {
    const { ctx, createHyperedge } = makeCtx({
      coRecall: [{ partnerId: "f-b", coRecallCount: 5 }],
    });
    // 1 fact + 2 episodes served: episodes never join → < 3 facts → no formation.
    const served = [hit("f-a", "fact"), hit("e-1", "episode"), hit("e-2", "episode")];
    const id = await maybeFormHebbianHyperedge(ctx, "ws", served);
    expect(id).toBeNull();
    expect(createHyperedge).not.toHaveBeenCalled();
  });
});
