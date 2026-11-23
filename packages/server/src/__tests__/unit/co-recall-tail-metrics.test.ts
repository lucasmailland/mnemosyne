import { describe, it, expect } from "vitest";
import { recordCoRecallTail, getMetricsSnapshot } from "../../metrics.js";

const WS = "ws-co-recall-tail-1";

describe("co-recall tail metrics accumulator (p60-corecall-stdp-convergence PR2, D3)", () => {
  it("accumulates a single report into getMetricsSnapshot().co_recall_tail", () => {
    const before = getMetricsSnapshot().co_recall_tail;

    recordCoRecallTail({
      workspaceId: WS,
      candidateFacts: 10,
      capK: 6,
      processedPairs: 15,
      skippedPairs: 30,
    });

    const after = getMetricsSnapshot().co_recall_tail;
    expect(after.events).toBe(before.events + 1);
    expect(after.events_over_cap).toBe(before.events_over_cap + 1);
    expect(after.pairs_processed).toBe(before.pairs_processed + 15);
    expect(after.pairs_skipped).toBe(before.pairs_skipped + 30);
  });

  it("does not count events_over_cap when candidateFacts <= capK", () => {
    const before = getMetricsSnapshot().co_recall_tail;

    recordCoRecallTail({
      workspaceId: WS,
      candidateFacts: 3,
      capK: 6,
      processedPairs: 3,
      skippedPairs: 0,
    });

    const after = getMetricsSnapshot().co_recall_tail;
    expect(after.events).toBe(before.events + 1);
    expect(after.events_over_cap).toBe(before.events_over_cap); // unchanged
    expect(after.pairs_processed).toBe(before.pairs_processed + 3);
    expect(after.pairs_skipped).toBe(before.pairs_skipped);
  });

  it("accumulates across repeated calls (module-global counters never reset)", () => {
    const before = getMetricsSnapshot().co_recall_tail;

    for (let i = 0; i < 3; i++) {
      recordCoRecallTail({
        workspaceId: WS,
        candidateFacts: 8,
        capK: 6,
        processedPairs: 15,
        skippedPairs: 13,
      });
    }

    const after = getMetricsSnapshot().co_recall_tail;
    expect(after.events).toBe(before.events + 3);
    expect(after.events_over_cap).toBe(before.events_over_cap + 3);
    expect(after.pairs_processed).toBe(before.pairs_processed + 45);
    expect(after.pairs_skipped).toBe(before.pairs_skipped + 39);
  });
});
