import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { buildUsageRouter } from "../routes/usage.js";
import { toErrorBody } from "../errors.js";

function app(storage: unknown, plan: "free" | "pro" | "enterprise" = "free") {
  const a = new Hono<{ Variables: { workspaceId: string; plan: string } }>();
  a.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400);
  });
  a.use("*", async (c, next) => {
    c.set("workspaceId", "ws-db");
    c.set("plan", plan);
    await next();
  });
  a.route("/usage", buildUsageRouter({ storage } as never));
  return a;
}

describe("GET /usage reads durable (DB) usage (F15)", () => {
  it("returns metrics sourced from storage.getMonthToDateUsageFromDb", async () => {
    const storage = { getMonthToDateUsageFromDb: vi.fn(async () => ({ recall: 250 })) };
    const res = await app(storage).request("/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: Record<string, { used: number; limit: number }> };
    expect(body.metrics.recall.used).toBe(250);
    expect(body.metrics.recall.limit).toBe(1000); // free plan
    expect(storage.getMonthToDateUsageFromDb).toHaveBeenCalledWith("ws-db");
  });
});
