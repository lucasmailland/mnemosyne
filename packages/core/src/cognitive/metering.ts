/**
 * Pure metering math — spec §35 "Billing & Usage Metering" lines 4197–4256.
 *
 * No DB/Redis imports. This module is pure so server + future SDK can share it.
 */

export const METER_METRICS = [
  "recall",
  "write",
  "session",
  "reasoning_hit",
  "embedding",
  "storage_gb",
  "federation_sync",
] as const;

export type MeterMetric = (typeof METER_METRICS)[number];

/** Plan limits per metric (spec §35 lines 4220–4250). */
export interface PlanLimits {
  recall: number;
  write: number;
  session: number;
  reasoning_hit: number;
  embedding: number;
  storage_gb: number;
  federation_sync: number;
}

export const PLAN_LIMITS: Record<"free" | "pro" | "enterprise", PlanLimits> = {
  free: {
    recall: 1000,
    write: 500,
    session: 100,
    reasoning_hit: 200,
    embedding: 1000,
    storage_gb: 1,
    federation_sync: 0,
  },
  pro: {
    recall: 50_000,
    write: 25_000,
    session: 5_000,
    reasoning_hit: 10_000,
    embedding: 50_000,
    storage_gb: 50,
    federation_sync: 1_000,
  },
  enterprise: {
    recall: 10_000_000,
    write: 5_000_000,
    session: 1_000_000,
    reasoning_hit: 2_000_000,
    embedding: 10_000_000,
    storage_gb: 10_000,
    federation_sync: 100_000,
  },
};

export type UsageState = "ok" | "grace" | "throttle";

export interface MetricUsageStatus {
  used: number;
  limit: number;
  pct: number;
  state: UsageState;
}

export type UsageStatus = Record<MeterMetric, MetricUsageStatus>;

/**
 * Compute usage status for each metric.
 * ok = ≤100%, grace = 100–110%, throttle = >110%.
 */
export function computeUsageStatus(
  usage: Partial<Record<MeterMetric, number>>,
  limits: PlanLimits
): UsageStatus {
  const result = {} as UsageStatus;
  for (const metric of METER_METRICS) {
    const used = usage[metric] ?? 0;
    const limit = limits[metric];
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    let state: UsageState = "ok";
    if (pct > 110) state = "throttle";
    else if (pct > 100) state = "grace";
    result[metric] = { used, limit, pct, state };
  }
  return result;
}

/** Spend-alert thresholds — spec §35 line 4254. */
export const SPEND_ALERT_THRESHOLDS = [70, 90, 100] as const;

/**
 * Returns which spend-alert thresholds were crossed when usage moved from prevPct to newPct.
 */
export function crossedThresholds(prevPct: number, newPct: number): number[] {
  return SPEND_ALERT_THRESHOLDS.filter((t) => prevPct < t && newPct >= t);
}

/** Meter event structure. */
export interface MeterEvent {
  workspaceId: string;
  metric: MeterMetric;
  quantity: number;
  occurredAt: Date;
  idempotencyKey?: string;
}

/**
 * Per-metric modeled unit cost in USD — spec §35 (Billing & Usage Metering).
 *
 * These are deterministic modeled rates (NOT realized provider billing), used so
 * that the durable meter pipeline can attribute a `cost_usd` to every event for
 * the spend dashboards and the §34.11 procedural budget gate. They mirror the
 * pricing-constant approach already used in the server cost dashboard
 * (LLM_COST_PER_1K_TOKENS). Pure data — no DB/Redis/IO.
 */
export const METER_UNIT_COST_USD: Record<MeterMetric, number> = {
  recall: 0.00002,
  write: 0.00005,
  session: 0.0001,
  reasoning_hit: 0.00001,
  embedding: 0.0000001,
  storage_gb: 0.1,
  federation_sync: 0.0002,
};

/**
 * Modeled USD cost of a single meter event = unit cost × quantity.
 * Returns 0 (never NaN) when quantity is 0/negative or the metric is unknown.
 */
export function meterEventCostUsd(event: MeterEvent): number {
  const unit = METER_UNIT_COST_USD[event.metric] ?? 0;
  const qty = Number.isFinite(event.quantity) ? event.quantity : 0;
  const cost = unit * qty;
  return Number.isFinite(cost) ? cost : 0;
}

/** Usage snapshot returned by GET /usage. */
export interface UsageSnapshot {
  workspaceId: string;
  plan: "free" | "pro" | "enterprise";
  windowStart: Date;
  metrics: UsageStatus;
}
