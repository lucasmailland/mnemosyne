import type { ServerDeps } from "../deps.js";
import {
  factsTotal,
  worthDistribution,
  sessionsActiveTotal,
  tasksTotal,
  tasksStaleTotal,
  llmCostUsdTotal,
  tokensSavedTotal,
  roiMultiplier,
} from "./index.js";
import { LLM_COST_PER_1K_TOKENS } from "./cost.js";
import { computeRoiMultiplier } from "./cost.js";
import { queueDepth } from "./backpressure.js";
import { applyManagedLifecycleStats } from "./harness.js";

/**
 * Refreshes snapshot gauges from storage aggregates.
 * Called on every Prometheus scrape — must never throw (guarded by caller).
 * Stale gauges are better than a failed scrape.
 */
export async function refreshSnapshotGauges(deps: ServerDeps): Promise<void> {
  const storage = deps.storage;
  if (!storage) return;

  // mnemo_facts_total{type,status}
  if (storage.countFactsByTypeStatus) {
    const rows = await storage.countFactsByTypeStatus();
    for (const { type, status, count } of rows) {
      factsTotal.set({ type, status }, count);
    }
  }

  // mnemo_worth_distribution{bucket}
  if (storage.worthHistogram) {
    const rows = await storage.worthHistogram();
    for (const { bucket, count } of rows) {
      worthDistribution.set({ bucket }, count);
    }
  }

  // mnemo_sessions_active_total
  if (storage.countActiveSessions) {
    const n = await storage.countActiveSessions();
    sessionsActiveTotal.set({}, n);
  }

  // mnemo_tasks_total{status}
  if (storage.countTasksByStatus) {
    const rows = await storage.countTasksByStatus();
    for (const { status, count } of rows) {
      tasksTotal.set({ status }, count);
    }
  }

  // mnemo_tasks_stale_total
  if (storage.countStaleTasks) {
    const n = await storage.countStaleTasks();
    tasksStaleTotal.set({}, n);
  }

  // mnemo_queue_depth — pending outbox entries (queue-depth telemetry §34.8)
  try {
    if (storage.countPendingOutbox) {
      const pending = await storage.countPendingOutbox();
      queueDepth.set({ source: "outbox" }, pending);
    }
  } catch {
    /* metrics refresh is best-effort */
  }

  // Managed lifecycle gauges — rebuilt wholesale from storage so a label that
  // stopped occurring disappears instead of freezing at its last value.
  try {
    if (storage.managedLifecycleStats) {
      applyManagedLifecycleStats(await storage.managedLifecycleStats());
    }
  } catch {
    /* metrics refresh is best-effort */
  }

  // mnemo_roi_multiplier — token-savings $ / LLM spend $ (A4)
  // Unit basis: llmCostUsdTotal is in USD; tokensSavedTotal is in token counts
  // converted to USD via LLM_COST_PER_1K_TOKENS (same rate used for estimatedCostUsd).
  try {
    let totalLlmCostUsd = 0;
    for (const s of llmCostUsdTotal.read()) {
      totalLlmCostUsd += s.value;
    }
    let totalTokensSaved = 0;
    for (const s of tokensSavedTotal.read()) {
      totalTokensSaved += s.value;
    }
    const tokensSavedUsd = (totalTokensSaved / 1000) * LLM_COST_PER_1K_TOKENS;
    roiMultiplier.set({}, computeRoiMultiplier({ tokensSavedUsd, llmCostUsd: totalLlmCostUsd }));
  } catch {
    /* metrics refresh is best-effort */
  }
}
