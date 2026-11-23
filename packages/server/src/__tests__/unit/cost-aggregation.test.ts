import { describe, it, expect } from "vitest";
import { aggregateWorkspaceCost, LLM_COST_PER_1K_TOKENS, EMBED_COST_PER_1K_TOKENS } from "../../metrics/cost.js";

describe("aggregateWorkspaceCost", () => {
  it("computes estimatedCostUsd from token counts", async () => {
    const storage = {
      getWorkspaceMonthlyRecallCount: async () => 100,
      getWorkspaceLLMTokenUsage: async () => 50_000,
      getWorkspaceEmbeddingTokenUsage: async () => 200_000,
    };
    const result = await aggregateWorkspaceCost(
      storage as any,
      "ws-1",
      new Date("2026-06-01"),
      new Date("2026-06-30"),
    );
    const expectedLlm = (50_000 / 1000) * LLM_COST_PER_1K_TOKENS;
    const expectedEmbed = (200_000 / 1000) * EMBED_COST_PER_1K_TOKENS;
    expect(result.estimatedCostUsd).toBeCloseTo(expectedLlm + expectedEmbed, 6);
    expect(result.costPerRecall).toBeCloseTo((expectedLlm + expectedEmbed) / 100, 6);
    expect(result.recallCount).toBe(100);
  });

  it("handles missing storage methods (graceful degradation)", async () => {
    const result = await aggregateWorkspaceCost(
      {} as any,  // no methods
      "ws-2",
      new Date("2026-06-01"),
      new Date("2026-06-30"),
    );
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.costPerRecall).toBe(0);
    expect(result.recallCount).toBe(0);
  });

  it("handles zero recalls (no division by zero)", async () => {
    const storage = {
      getWorkspaceMonthlyRecallCount: async () => 0,
      getWorkspaceLLMTokenUsage: async () => 10_000,
      getWorkspaceEmbeddingTokenUsage: async () => 0,
    };
    const result = await aggregateWorkspaceCost(storage as any, "ws-3", new Date("2026-06-01"), new Date("2026-06-30"));
    expect(result.costPerRecall).toBe(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });
});
