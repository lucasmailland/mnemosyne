/**
 * AB3 — Usage route + overage throttle tests.
 * spec §35 lines 4220–4256.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildUsageRouter } from "../routes/usage.js";
import { globalMeterStore, emitMeter } from "../metering/MeterEmitter.js";
import { aggregateMeterEvents, checkOverage } from "../metering/aggregate.js";
import { toErrorBody } from "../errors.js";

function buildUsageApp(workspaceId = "ws-test", plan: "free" | "pro" | "enterprise" = "free") {
  const app = new Hono<{ Variables: { workspaceId: string; plan: string } }>();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as any);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId", workspaceId);
    c.set("plan", plan);
    await next();
  });
  app.route("/usage", buildUsageRouter({}));
  return app;
}

describe("GET /usage — spec §35 lines 4220–4253", () => {
  beforeEach(() => {
    // Drain the global store to reset state
    globalMeterStore.drain();
  });

  it("returns per-metric used/limit/pct for the key's plan", async () => {
    emitMeter("ws-test", "recall", 100);
    aggregateMeterEvents();

    const app = buildUsageApp("ws-test", "free");
    const res = await app.request("/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.workspaceId).toBe("ws-test");
    expect(body.plan).toBe("free");
    expect(body.metrics.recall.used).toBeGreaterThanOrEqual(100);
    expect(body.metrics.recall.limit).toBe(1000); // free plan
    expect(body.metrics.recall.state).toBe("ok");
  });
});

describe("checkOverage — spec §35 line 4252", () => {
  it("returns throttle state when >110% usage", () => {
    // Manually push events to exceed free limit (1000 recall)
    const events = Array.from({ length: 1101 }, () => ({
      workspaceId: "ws-overage",
      metric: "recall" as const,
      quantity: 1,
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));
    aggregateMeterEvents(events);

    const state = checkOverage("ws-overage", "recall", "free");
    expect(state).toBe("throttle");
  });

  it("returns grace state when between 100–110%", () => {
    const events = Array.from({ length: 1050 }, () => ({
      workspaceId: "ws-grace",
      metric: "recall" as const,
      quantity: 1,
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));
    aggregateMeterEvents(events);

    const state = checkOverage("ws-grace", "recall", "free");
    expect(state).toBe("grace");
  });
});
