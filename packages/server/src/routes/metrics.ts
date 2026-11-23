// GET /metrics — lightweight operational metrics endpoint.
// Returns process-level and app-level stats in a structured JSON payload,
// PLUS Prometheus text-format metrics at GET /metrics/prometheus (bearer
// MNEMO_METRICS_TOKEN; see metricsAccess below).
//
// Intentionally NOT OpenAPI-documented (internal ops endpoint) and mounted
// AFTER auth middleware for the JSON path.
//
// Security note: process memory figures are non-sensitive but still scoped
// behind auth to avoid leaking instance topology to unauthenticated callers.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { Hono } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { renderBackpressureMetrics } from "../metrics/backpressure.js";
import { refreshSnapshotGauges } from "../metrics/snapshot.js";
import { renderAdapterMetrics } from "@mnemo-ai/adapter-postgres";
import { renderRedisMetrics, redisMemoryUsed } from "@mnemo-ai/adapter-redis";
import {
  renderMetrics,
  pgPoolConnectionsActive,
  pgPoolConnectionsIdle,
  pgPoolConnectionsTotal,
  pgPoolUtilizationRatio,
  redisConnectionsActive,
} from "../metrics/index.js";
import { readPgPoolStats } from "../metrics/pgPool.js";

export interface MetricsPayload {
  uptime_s: number;
  memory: {
    rss_mb: number;
    heap_used_mb: number;
    heap_total_mb: number;
  };
  process: {
    pid: number;
    node_version: string;
    platform: string;
  };
  health?: {
    status: "ok" | "degraded" | "down";
    latency_ms: number;
  };
  timestamp: string;
}

/**
 * Who may scrape the Prometheus endpoints:
 * - MNEMO_METRICS_TOKEN set → only a request with `Authorization: Bearer <token>`
 *   (anything else gets 401), in any environment.
 * - no token and NODE_ENV=production → nobody: 404, as if the route did not exist.
 * - no token outside production → open, for local dev and the observability stack.
 */
export function metricsAccess(
  authorization: string | undefined,
  env: Record<string, string | undefined>
): "allow" | "unauthorized" | "not_found" {
  const token = env.MNEMO_METRICS_TOKEN;
  if (!token) return env.NODE_ENV === "production" ? "not_found" : "allow";
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  // Compare digests so the comparison is constant-time and length-independent.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(presented), digest(token)) ? "allow" : "unauthorized";
}

/**
 * Mount the Prometheus scrape endpoints at GET /metrics/prometheus and
 * GET /metrics (alias). Call this on the bare Hono app (before the API auth
 * middleware): access is decided by metricsAccess(), not by API keys.
 *
 * OPS-3: refreshes PG pool and Redis USE gauges on each scrape.
 * OPS-4: /metrics is an alias served by the same handler.
 *
 * Even with a token, keep these off the public internet when you can (edge
 * proxy rule or network policy on /metrics*).
 */
export function mountPrometheusEndpoint(
  app: Hono,
  deps: ServerDeps,
  env: Record<string, string | undefined> = process.env
): void {
  const prometheusHandler = async (c: Context) => {
    const access = metricsAccess(c.req.header("authorization"), env);
    if (access === "not_found") return c.text("Not Found", 404);
    if (access === "unauthorized") {
      return c.text("Unauthorized", 401, { "WWW-Authenticate": 'Bearer realm="metrics"' });
    }
    // OPS-3: refresh PG pool USE gauges
    if (deps.metricsPgClient) {
      try {
        const { active, idle, total } = readPgPoolStats(deps.metricsPgClient);
        pgPoolConnectionsActive.set({}, active);
        pgPoolConnectionsIdle.set({}, idle);
        pgPoolConnectionsTotal.set({}, total);
        pgPoolUtilizationRatio.set({}, total > 0 ? active / total : 0);
      } catch {
        /* non-fatal: stale gauges are better than a failed scrape */
      }
    }
    // OPS-3: refresh Redis connectivity gauge
    if (deps.cache) {
      try {
        const h = await deps.cache.healthCheck();
        redisConnectionsActive.set({}, h.status === "ok" ? 1 : 0);
      } catch {
        redisConnectionsActive.set({}, 0);
      }
    }
    // Refresh redis memory gauge
    if (deps.cache?.info) {
      try {
        const info = await deps.cache.info();
        if (info.usedMemoryBytes !== null) {
          redisMemoryUsed.set({}, info.usedMemoryBytes);
        }
      } catch {
        /* non-fatal: stale gauge */
      }
    }
    // OPS-3: refresh governance snapshot gauges from storage
    try {
      await refreshSnapshotGauges(deps);
    } catch {
      /* non-fatal: stale gauges are better than a failed scrape */
    }
    const combined =
      renderMetrics() +
      "\n" +
      renderBackpressureMetrics() +
      "\n" +
      renderAdapterMetrics() +
      "\n" +
      renderRedisMetrics();
    return c.text(combined, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  };
  // OPS-4: serve same handler at both paths
  app.get("/metrics/prometheus", prometheusHandler);
  app.get("/metrics", prometheusHandler);
}

export function mountMetrics(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.get("/metrics", async (c) => {
    const mem = process.memoryUsage();

    // mnemo_requests_total is emitted globally by the app.ts timing middleware
    // (bounded route label) — no ad-hoc inc here (would double-count this route).

    const payload: MetricsPayload = {
      uptime_s: Math.round(process.uptime()),
      memory: {
        rss_mb: +(mem.rss / 1024 / 1024).toFixed(2),
        heap_used_mb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
        heap_total_mb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
      },
      process: {
        pid: process.pid,
        node_version: process.version,
        platform: process.platform,
      },
      timestamp: new Date().toISOString(),
    };

    // Best-effort storage health check — skip on error, don't block metrics.
    // flatten-legacy-dual-core PR13: this used to be a cast of the legacy
    // core to `unknown as Record<string, unknown>`, duck-type-probing for a
    // `healthCheck` method — dead code, since the legacy `CoreLike` (built by
    // `factory.ts`) never implements `healthCheck` (confirmed zero hits
    // across `factory.ts`/`factory-types.ts`), so the probe always evaluated
    // false at runtime. Replaced with a real call to the v3
    // `StorageAdapter.healthCheck()` (already implemented by
    // `DrizzleStorageAdapter`, and already used the same way by
    // `routes/health.ts`'s `pingStorage`), guarded on `deps.storage`
    // truthiness like every other optional-`deps.storage` handler in this
    // codebase (see `admin.ts`/`keys.ts`).
    if (deps.storage) {
      try {
        const health = await deps.storage.healthCheck();
        payload.health = {
          status: health.status,
          latency_ms: health.latencyMs,
        };
      } catch {
        // Storage health unavailable; metrics still returned without it.
      }
    }

    // OPS-3: refresh governance snapshot gauges from storage
    try {
      await refreshSnapshotGauges(deps);
    } catch {
      /* non-fatal: stale gauges are better than a failed scrape */
    }

    return c.json(
      {
        ...payload,
        // Prometheus text for all metric families
        prometheus:
          renderMetrics() +
          "\n" +
          renderBackpressureMetrics() +
          "\n" +
          renderAdapterMetrics() +
          "\n" +
          renderRedisMetrics(),
      },
      200
    );
  });
}
