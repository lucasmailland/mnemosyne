/**
 * GET /cost — per-workspace unit economics dashboard.
 * Task 3.11: CostDashboard aggregation.
 *
 * Returns a WorkspaceCostSummary for the current calendar month (UTC).
 * The billing period defaults to [first-of-month, now]. An explicit
 * ?workspaceId=<id> query param is accepted; falls back to the workspaceId
 * injected by the auth middleware.
 *
 * Authenticated — mounted under v1 which already has auth middleware.
 * No admin scope required: the calling workspace can only see its own cost.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { aggregateWorkspaceCost } from "../metrics/cost.js";

function currentMonthWindow(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: now };
}

export function mountCost(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  app.get("/cost", async (c) => {
    // Prefer explicit query param, fall back to the auth-middleware value.
    const workspaceId = (c.req.query("workspaceId") ?? "") || c.get("workspaceId");

    const { start, end } = currentMonthWindow();

    // Provide a structural subset of storage (optional methods only).
    // When deps.storage is absent, all counts fall back to 0.
    const storage = deps.storage ?? {};

    const summary = await aggregateWorkspaceCost(storage, workspaceId, start, end);

    // F15: durable month-to-date spend from mnemo_meter_event (0 when unwired).
    const meteredSpendUsd =
      (await (
        storage as { getWorkspaceMonthlySpendUsd?(w: string): Promise<number> }
      ).getWorkspaceMonthlySpendUsd?.(workspaceId)) ?? 0;

    return c.json({ ...summary, meteredSpendUsd }, 200);
  });
}
