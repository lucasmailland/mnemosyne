import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { mountPrometheusEndpoint } from "../../routes/metrics.js";
import type { ServerDeps } from "../../deps.js";
import postgres from "postgres";

describe("OPS-3: USE gauges (PG pool + Redis)", () => {
  let sql: ReturnType<typeof postgres>;
  let app: Hono;

  beforeAll(() => {
    // Create a postgres client for testing
    const connectionString = process.env.DATABASE_URL || "postgres://localhost:5432/mnemosyne_test";
    sql = postgres(connectionString, { max: 10 });

    // Create a minimal Hono app with deps
    app = new Hono();
    const deps: ServerDeps = {
      metricsPgClient: sql,
      cache: {
        healthCheck: async () => ({ status: "ok" as const, latencyMs: 5 }),
        info: async () => ({ usedMemoryBytes: 1048576 }), // 1 MB
      } as any,
    } as any;

    mountPrometheusEndpoint(app, deps);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("refreshes PG pool gauges on scrape", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();

    // Verify PG pool metrics are present
    expect(text).toContain("mnemo_pg_pool_connections_active");
    expect(text).toContain("mnemo_pg_pool_connections_idle");
    expect(text).toContain("mnemo_pg_pool_connections_total");
    expect(text).toContain("mnemo_pg_pool_utilization_ratio");

    // Verify the total is set to the configured max (10)
    expect(text).toMatch(/mnemo_pg_pool_connections_total 10/);
  });

  it("refreshes Redis connection gauge on scrape", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();

    // Verify Redis connection metric is present
    expect(text).toContain("mnemo_redis_connections_active");
    // Since cache.healthCheck() returns "ok", the value should be 1
    expect(text).toMatch(/mnemo_redis_connections_active 1/);
  });

  it("serves metrics at both /metrics and /metrics/prometheus", async () => {
    const res1 = await app.request("/metrics");
    const res2 = await app.request("/metrics/prometheus");

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const text1 = await res1.text();
    const text2 = await res2.text();

    // Both endpoints should return the same content
    expect(text1).toBe(text2);
    expect(text1).toContain("mnemo_pg_pool_connections_total");
  });

  it("returns Prometheus text format content-type", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("handles missing deps gracefully", async () => {
    // Create app without deps
    const bareApp = new Hono();
    const minimalDeps: ServerDeps = {} as any;
    mountPrometheusEndpoint(bareApp, minimalDeps);

    const res = await bareApp.request("/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();

    // Metrics should still render, just with zero/stale values
    expect(text).toContain("# TYPE mnemo_pg_pool_connections_total gauge");
  });
});
