import { describe, it, expect, vi } from "vitest";
import { preinjectAnticipation } from "../anticipation-preinject.js";

describe("preinjectAnticipation (spec §30 pre-injection)", () => {
  it("stages the top-N anticipated ids into the L0 working-memory slot", async () => {
    const workSet = vi.fn().mockResolvedValue(undefined);
    const storage = {
      getSequentialPatterns: async () => [{ workspaceId: "w", predecessorId: "p", successorId: "m1", support: 9, avgLagSeconds: 10, confidence: 0.9 }],
      getPeriodicPatterns: async () => [],
      getConditionalPatterns: async () => [],
      getCoOccurrencePatterns: async () => [],
    } as any;
    const workingMemory = { workSet, workGet: vi.fn() } as any;

    const staged = await preinjectAnticipation({
      storage, workingMemory, workspaceId: "w", agentId: "agent-1",
      recentlyRecalledId: "p", topN: 3, lookAheadMinutes: 30, nowMs: Date.UTC(2026, 5, 15, 10),
    });

    expect(staged.map((s) => s.id)).toContain("m1");
    expect(workSet).toHaveBeenCalledOnce();
    const callArgs = workSet.mock.calls[0];
    // WorkingMemory.workSet signature is (ws, agent, key, value, ttlSeconds)
    // The slot key "anticipation" is one of the args; TTL is lookAhead*60
    expect(callArgs).toContain("anticipation");
    expect(callArgs).toContain(30 * 60);
  });

  it("filters out items below the score floor", async () => {
    const workSet = vi.fn().mockResolvedValue(undefined);
    const storage = {
      getSequentialPatterns: async () => [{ workspaceId: "w", predecessorId: "p", successorId: "weak", support: 5, avgLagSeconds: 10, confidence: 0.05 }],
      getPeriodicPatterns: async () => [], getConditionalPatterns: async () => [], getCoOccurrencePatterns: async () => [],
    } as any;
    const staged = await preinjectAnticipation({
      storage, workingMemory: { workSet } as any, workspaceId: "w", agentId: "a",
      recentlyRecalledId: "p", minScore: 0.1, nowMs: Date.UTC(2026, 5, 15, 10),
    });
    expect(staged).toHaveLength(0);
    expect(workSet).not.toHaveBeenCalled();
  });
});
