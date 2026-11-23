import { describe, it, expect } from "vitest";
import { buildAnticipationFeed } from "../anticipation.js";
import type { StorageAdapter } from "@mnemo-ai/types";

type AnticipationStorage = Pick<StorageAdapter, "getSequentialPatterns" | "getPeriodicPatterns" | "getConditionalPatterns" | "getCoOccurrencePatterns">;

const emptyStorage: AnticipationStorage = {
  getSequentialPatterns: async () => [],
  getPeriodicPatterns: async () => [],
  getConditionalPatterns: async () => [],
  getCoOccurrencePatterns: async () => [],
};

// Date.UTC(2026, 5, 15, 10) = Monday 2026-06-15 10:00 UTC → dow=1, hourBucket=floor(10/3)=3
const MON_10AM_UTC = Date.UTC(2026, 5, 15, 10);

describe("buildAnticipationFeed", () => {
  it("returns empty feed when both pattern sources are empty", async () => {
    const feed = await buildAnticipationFeed(emptyStorage, "w", {
      recentlyRecalledId: "p",
      nowMs: MON_10AM_UTC,
    });
    expect(feed.items).toHaveLength(0);
    expect(feed.cue?.recentlyRecalledId).toBe("p");
  });

  it("blends sequential + periodic for the same memory id", async () => {
    const storage: AnticipationStorage = {
      getSequentialPatterns: async () => [
        { workspaceId: "w", predecessorId: "p", successorId: "m1", support: 10, avgLagSeconds: 30, confidence: 0.5 },
      ],
      getPeriodicPatterns: async () => [
        { workspaceId: "w", memoryId: "m1", dayOfWeek: 1, hourBucket: 3, slotRecalls: 8, distinctWeeks: 4, slotShare: 0.5 },
      ],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    };
    const feed = await buildAnticipationFeed(storage, "w", {
      recentlyRecalledId: "p",
      nowMs: MON_10AM_UTC,
    });
    expect(feed.items[0]?.source).toBe("blended");
    // 0.5*0.35 + 0.5*0.25 = 0.30
    expect(feed.items[0]?.score).toBeCloseTo(0.30);
  });

  it("returns only periodic items when no recentlyRecalledId given", async () => {
    const storage: AnticipationStorage = {
      getSequentialPatterns: async () => [],
      getPeriodicPatterns: async () => [
        { workspaceId: "w", memoryId: "m2", dayOfWeek: 1, hourBucket: 3, slotRecalls: 6, distinctWeeks: 3, slotShare: 0.4 },
      ],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    };
    const feed = await buildAnticipationFeed(storage, "w", { nowMs: MON_10AM_UTC });
    expect(feed.cue).toBeNull();
    expect(feed.items.every((i) => i.source === "periodic")).toBe(true);
    expect(feed.items[0]?.id).toBe("m2");
  });
});
