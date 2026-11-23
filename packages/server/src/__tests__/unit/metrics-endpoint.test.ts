/**
 * App-level tests for GET /metrics and GET /metrics/prometheus routes (OPS-4).
 *
 * Tests that both routes:
 * - Return Prometheus text format with correct content-type
 * - Return identical content (they are aliased to the same handler)
 * - Include expected metric families
 */

import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { mountPrometheusEndpoint } from "../../routes/metrics.js";
import type { ServerDeps } from "../../deps.js";

function buildApp(): Hono {
  const app = new Hono();

  // Minimal deps for the Prometheus endpoint
  const deps = {
    metricsPgClient: undefined,
    cache: undefined,
    storage: undefined,
  } as unknown as ServerDeps;

  mountPrometheusEndpoint(app, deps);
  return app;
}

describe("Prometheus metrics endpoints (OPS-4)", () => {
  it("GET /metrics returns prometheus text with version 0.0.4 content type", async () => {
    const app = buildApp();
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");
    expect(contentType).toContain("charset=utf-8");
    const text = await res.text();
    expect(text).toContain("# HELP mnemo_requests_total");
  });

  it("GET /metrics/prometheus returns prometheus text with version 0.0.4 content type", async () => {
    const app = buildApp();
    const res = await app.request("/metrics/prometheus");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");
    expect(contentType).toContain("charset=utf-8");
    const text = await res.text();
    expect(text).toContain("# HELP mnemo_requests_total");
  });

  it("GET /metrics and GET /metrics/prometheus return identical content", async () => {
    const app = buildApp();

    const res1 = await app.request("/metrics");
    const text1 = await res1.text();

    const res2 = await app.request("/metrics/prometheus");
    const text2 = await res2.text();

    expect(text1).toBe(text2);
  });

  it("Both endpoints include core metric families", async () => {
    const app = buildApp();

    for (const path of ["/metrics", "/metrics/prometheus"]) {
      const res = await app.request(path);
      const text = await res.text();

      // Check for key metric families
      expect(text).toContain("# TYPE mnemo_requests_total counter");
      expect(text).toContain("# TYPE mnemo_recall_duration_seconds histogram");
      expect(text).toContain("# TYPE mnemo_hot_tier_size gauge");
    }
  });
});

describe("Prometheus metrics endpoints — access (R-04)", () => {
  const deps = { metricsPgClient: undefined, cache: undefined } as unknown as ServerDeps;
  function appWith(env: Record<string, string | undefined>): Hono {
    const app = new Hono();
    mountPrometheusEndpoint(app, deps, env);
    return app;
  }

  it("in production without MNEMO_METRICS_TOKEN both paths answer 404", async () => {
    const app = appWith({ NODE_ENV: "production" });
    for (const path of ["/metrics", "/metrics/prometheus"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it("with a token, only the matching bearer gets the metrics", async () => {
    for (const NODE_ENV of ["production", "development"]) {
      const app = appWith({ NODE_ENV, MNEMO_METRICS_TOKEN: "s3cret-token" });
      for (const path of ["/metrics", "/metrics/prometheus"]) {
        expect((await app.request(path)).status).toBe(401);
        const wrong = await app.request(path, { headers: { Authorization: "Bearer nope" } });
        expect(wrong.status).toBe(401);
        const ok = await app.request(path, { headers: { Authorization: "Bearer s3cret-token" } });
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain("# HELP mnemo_requests_total");
      }
    }
  });

  it("outside production without a token the endpoints stay open", async () => {
    const app = appWith({ NODE_ENV: "development" });
    expect((await app.request("/metrics/prometheus")).status).toBe(200);
  });
});
