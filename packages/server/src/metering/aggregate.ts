/**
 * Billing aggregation — spec §35 lines 4216, 4220–4256.
 *
 * Drains raw meter events from the in-memory queue and folds them into
 * per-(workspaceId, metric, windowStart) totals (5-minute windows).
 * Detects crossed spend thresholds and logs spend alerts.
 */
import type { MeterMetric } from "@mnemo-ai/core/cognitive";
import { crossedThresholds, PLAN_LIMITS, computeUsageStatus, METER_METRICS } from "@mnemo-ai/core/cognitive";
import type { MeterEvent } from "@mnemo-ai/core/cognitive";
import { globalMeterStore } from "./MeterEmitter.js";
import { logger } from "../logging.js";

/** 5-minute window bucket for aggregation. */
function getWindowStart(date: Date): Date {
  const ms = date.getTime();
  const bucket = Math.floor(ms / (5 * 60 * 1000)) * (5 * 60 * 1000);
  return new Date(bucket);
}

/** In-memory usage accumulator (production would use DB). */
const windowAccumulator = new Map<string, number>();
const prevPctMap = new Map<string, number>();

function accumulatorKey(workspaceId: string, metric: MeterMetric, windowStart: Date): string {
  return `${workspaceId}:${metric}:${windowStart.getTime()}`;
}

function getWindowTotal(workspaceId: string, metric: MeterMetric): number {
  // Sum across all windows for MTD approximation (for overage checks we use the current month window)
  let total = 0;
  for (const [key, qty] of windowAccumulator) {
    if (key.startsWith(`${workspaceId}:${metric}:`)) {
      total += qty;
    }
  }
  return total;
}

export function getMonthToDateUsage(workspaceId: string): Partial<Record<MeterMetric, number>> {
  const result: Partial<Record<MeterMetric, number>> = {};
  for (const metric of METER_METRICS) {
    result[metric] = getWindowTotal(workspaceId, metric);
  }
  return result;
}

/** Minimal port surface needed for DB-sourced usage. */
interface UsageStorageLike {
  getMonthToDateUsageFromDb?(workspaceId: string): Promise<Record<string, number>>;
}

/**
 * Month-to-date usage sourced from the durable table (F15). Falls back to the
 * in-memory accumulator when the adapter has no durable backing (tests / boot
 * without storage). Restart-safe: a fresh process with an empty in-memory
 * accumulator still returns correct totals from the DB.
 */
export async function getMonthToDateUsageFromStorage(
  storage: UsageStorageLike,
  workspaceId: string,
): Promise<Partial<Record<MeterMetric, number>>> {
  if (storage.getMonthToDateUsageFromDb) {
    try {
      const dbUsage = await storage.getMonthToDateUsageFromDb(workspaceId);
      const result: Partial<Record<MeterMetric, number>> = {};
      for (const metric of METER_METRICS) {
        result[metric] = dbUsage[metric] ?? 0;
      }
      return result;
    } catch {
      // DB unavailable — fall back to warm in-memory totals rather than 0.
      return getMonthToDateUsage(workspaceId);
    }
  }
  return getMonthToDateUsage(workspaceId);
}

export function aggregateMeterEvents(events?: MeterEvent[]): void {
  const toProcess = events ?? globalMeterStore.drain();
  if (toProcess.length === 0) return;

  for (const event of toProcess) {
    const windowStart = getWindowStart(event.occurredAt);
    const key = accumulatorKey(event.workspaceId, event.metric, windowStart);
    windowAccumulator.set(key, (windowAccumulator.get(key) ?? 0) + event.quantity);
  }

  // Check spend thresholds for affected workspaces
  const affectedWorkspaces = new Set(toProcess.map(e => e.workspaceId));
  for (const workspaceId of affectedWorkspaces) {
    checkSpendAlerts(workspaceId);
  }
}

function checkSpendAlerts(workspaceId: string): void {
  // Use free plan limits as default (in production, look up the workspace plan)
  const limits = PLAN_LIMITS.free;
  const usage = getMonthToDateUsage(workspaceId);
  const status = computeUsageStatus(usage, limits);

  for (const metric of METER_METRICS) {
    const metricStatus = status[metric];
    const prevPctKey = `${workspaceId}:${metric}`;
    const prevPct = prevPctMap.get(prevPctKey) ?? 0;
    const newPct = metricStatus.pct;
    const crossed = crossedThresholds(prevPct, newPct);

    if (crossed.length > 0) {
      for (const threshold of crossed) {
        logger.warn({
          workspaceId,
          metric,
          threshold,
          pct: newPct,
          used: metricStatus.used,
          limit: metricStatus.limit,
        }, "billing.spend_alert");
      }
    }

    prevPctMap.set(prevPctKey, newPct);
  }
}

/** Check if a workspace is in overage for a given metric. Returns the state. */
export function checkOverage(
  workspaceId: string,
  metric: MeterMetric,
  plan: "free" | "pro" | "enterprise" = "free",
): "ok" | "grace" | "throttle" {
  const limits = PLAN_LIMITS[plan];
  const usage = getMonthToDateUsage(workspaceId);
  const status = computeUsageStatus(usage, limits);
  return status[metric].state;
}
