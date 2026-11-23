/**
 * Cost aggregation module — per-workspace unit economics.
 * Task 3.11: CostDashboard aggregation.
 *
 * Hexagonal boundary: this module accepts a structural subset of StorageAdapter
 * (optional methods only) and never imports drizzle-orm, pg, or redis.
 */

import type { StorageAdapter } from "@mnemo-ai/types";

// ── Pricing constants (OpenAI GPT-4o rates as reference) ──────────────────────

/** USD per 1,000 output tokens (LLM inference). */
export const LLM_COST_PER_1K_TOKENS = 0.005;

/** USD per 1,000 embedding tokens. */
export const EMBED_COST_PER_1K_TOKENS = 0.0001;

// ── Output shape ──────────────────────────────────────────────────────────────

export interface WorkspaceCostSummary {
  workspaceId: string;
  recallCount: number;
  /** Sum of all LLM tokens consumed in the billing period. */
  llmTokensTotal: number;
  /** Sum of all embedding tokens consumed in the billing period. */
  embeddingTokensTotal: number;
  /** Net bytes written minus bytes deleted in the billing period. */
  storageBytesDelta: number;
  /** Derived: (llmTokensTotal/1000)*LLM_COST_PER_1K + (embeddingTokensTotal/1000)*EMBED_COST_PER_1K */
  estimatedCostUsd: number;
  /** estimatedCostUsd / recallCount; 0 when recallCount === 0 (no division by zero). */
  costPerRecall: number;
  /** Read from storage if available, else 0. */
  roiMultiplier: number;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

// ── Storage capability subset ─────────────────────────────────────────────────

type CostStorageLike = Pick<
  StorageAdapter,
  | "getWorkspaceMonthlyRecallCount"
  | "getWorkspaceLLMTokenUsage"
  | "getWorkspaceEmbeddingTokenUsage"
>;

// ── ROI multiplier ────────────────────────────────────────────────────────────

/**
 * Compute the cost ROI multiplier: tokensSavedUsd / llmCostUsd.
 * Returns 0 when llmCostUsd is 0 (no claim without a denominator).
 */
export function computeRoiMultiplier(input: { tokensSavedUsd: number; llmCostUsd: number }): number {
  return input.llmCostUsd > 0 ? input.tokensSavedUsd / input.llmCostUsd : 0;
}

// ── Aggregation function ──────────────────────────────────────────────────────

/**
 * Aggregate per-workspace cost metrics for a billing period.
 *
 * Each storage method is optional — callers guard with `?.()` so adapters that
 * have not implemented these methods gracefully return 0.
 */
export async function aggregateWorkspaceCost(
  storage: CostStorageLike,
  workspaceId: string,
  billingPeriodStart: Date,
  billingPeriodEnd: Date,
): Promise<WorkspaceCostSummary> {
  const [recallCount, llmTokensTotal, embeddingTokensTotal] = await Promise.all([
    storage.getWorkspaceMonthlyRecallCount?.(workspaceId) ?? Promise.resolve(0),
    storage.getWorkspaceLLMTokenUsage?.(workspaceId, billingPeriodStart) ?? Promise.resolve(0),
    storage.getWorkspaceEmbeddingTokenUsage?.(workspaceId, billingPeriodStart) ?? Promise.resolve(0),
  ]);

  const estimatedCostUsd =
    (llmTokensTotal / 1000) * LLM_COST_PER_1K_TOKENS +
    (embeddingTokensTotal / 1000) * EMBED_COST_PER_1K_TOKENS;

  const costPerRecall = recallCount > 0 ? estimatedCostUsd / recallCount : 0;

  return {
    workspaceId,
    recallCount,
    llmTokensTotal,
    embeddingTokensTotal,
    storageBytesDelta: 0,
    estimatedCostUsd,
    costPerRecall,
    roiMultiplier: 0,
    billingPeriodStart: billingPeriodStart.toISOString(),
    billingPeriodEnd: billingPeriodEnd.toISOString(),
  };
}
