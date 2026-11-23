import { describe, it, expect } from "vitest";
import { buildAnticipationFeed } from "../anticipation.js";
import type { StorageAdapter } from "@mnemo-ai/types";

type S = Pick<StorageAdapter,
  "getSequentialPatterns" | "getPeriodicPatterns" | "getConditionalPatterns" | "getCoOccurrencePatterns">;

const MON_10AM_UTC = Date.UTC(2026, 5, 15, 10); // dow=1, hourBucket=3

function storage(over: Partial<S> = {}): S {
  return {
    getSequentialPatterns: async () => [],
    getPeriodicPatterns: async () => [],
    getConditionalPatterns: async () => [],
    getCoOccurrencePatterns: async () => [],
    ...over,
  };
}

describe("buildAnticipationFeed — 4-way blend (spec §30)", () => {
  it("surfaces a conditional prediction from the current query context", async () => {
    const s = storage({
      getConditionalPatterns: async () => [
        { workspaceId: "w", queryKey: "production", factId: "runbook-1", coReturns: 9, queryTotal: 10, confidence: 0.9 },
      ],
    });
    const feed = await buildAnticipationFeed(s, "w", { queryContext: "production", nowMs: MON_10AM_UTC });
    const item = feed.items.find((i) => i.id === "runbook-1");
    expect(item).toBeDefined();
    expect(item!.source).toBe("conditional");
    expect(item!.score).toBeCloseTo(0.9 * 0.25);
  });

  it("surfaces a co-occurrence partner of the cue", async () => {
    const s = storage({
      getCoOccurrencePatterns: async () => [
        { workspaceId: "w", sourceId: "p", partnerId: "co-1", coRecallCount: 12, hebbianWeight: 0.8 },
      ],
    });
    const feed = await buildAnticipationFeed(s, "w", { recentlyRecalledId: "p", nowMs: MON_10AM_UTC });
    const item = feed.items.find((i) => i.id === "co-1");
    expect(item).toBeDefined();
    expect(item!.source).toBe("co-occurrence");
    expect(item!.score).toBeGreaterThan(0);
  });

  it("blends all four sources additively for one shared id", async () => {
    const s = storage({
      getSequentialPatterns:   async () => [{ workspaceId: "w", predecessorId: "p", successorId: "m", support: 9, avgLagSeconds: 30, confidence: 1 }],
      getPeriodicPatterns:     async () => [{ workspaceId: "w", memoryId: "m", dayOfWeek: 1, hourBucket: 3, slotRecalls: 8, distinctWeeks: 4, slotShare: 1 }],
      getConditionalPatterns:  async () => [{ workspaceId: "w", queryKey: "q", factId: "m", coReturns: 9, queryTotal: 10, confidence: 1 }],
      getCoOccurrencePatterns: async () => [{ workspaceId: "w", sourceId: "p", partnerId: "m", coRecallCount: 12, hebbianWeight: 1 }],
    });
    const feed = await buildAnticipationFeed(s, "w", { recentlyRecalledId: "p", queryContext: "q", nowMs: MON_10AM_UTC });
    const m = feed.items.find((i) => i.id === "m")!;
    expect(m.source).toBe("blended");
    // 1*0.35 + 1*0.25 + 1*0.25 + min(1, 12/10)*0.15 = 1.0
    expect(m.score).toBeCloseTo(1.0, 2);
  });
});
