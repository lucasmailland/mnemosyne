/**
 * GET /usage — billing usage snapshot.
 * spec §35 lines 4253, 4220–4250.
 *
 * F15: usage is sourced from the durable mnemo_meter_event table via
 * getMonthToDateUsageFromStorage so it survives restarts and is consistent
 * across replicas. Falls back to the in-memory accumulator when no durable
 * storage is wired (tests / boot without storage).
 */
import { Hono } from "hono";
import type { AuthVariables } from "../auth.js";
import { getMonthToDateUsageFromStorage } from "../metering/aggregate.js";
import { computeUsageStatus, PLAN_LIMITS } from "@mnemo-ai/core/cognitive";

interface UsageRouterDeps {
  storage?: { getMonthToDateUsageFromDb?(workspaceId: string): Promise<Record<string, number>> };
}

export function buildUsageRouter(deps: UsageRouterDeps): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  router.get("/", async (c) => {
    const workspaceId = c.var.workspaceId;
    const plan = c.var.plan ?? "free";
    const limits = PLAN_LIMITS[plan];
    const usage = await getMonthToDateUsageFromStorage(deps.storage ?? {}, workspaceId);
    const metrics = computeUsageStatus(usage, limits);

    return c.json({
      workspaceId,
      plan,
      windowStart: new Date().toISOString(),
      metrics,
    });
  });

  return router;
}
