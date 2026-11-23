/**
 * B4.1 — HTTP route coverage fill-in: observability/infra surface
 * (design.md "B4. Coverage fill-in", spec.md Requirement 13).
 *
 * Exercises every GET-only health/metrics/docs/dashboard route against a
 * real running server via the B3 `live-surface` harness. All routes in this
 * file are read-only (safe to call freely, no fixture teardown needed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

describe("observability routes (B4.1)", () => {
  it("GET /health/live — unauthenticated liveness probe", async () => {
    const res = await fetch(`${surface.baseUrl}/health/live`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; pid: number };
    expect(body.status).toBe("alive");
    expect(typeof body.pid).toBe("number");
  });

  it("GET /healthz — unauthenticated liveness alias", async () => {
    const res = await fetch(`${surface.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz — unauthenticated readiness (legacy alias)", async () => {
    const res = await fetch(`${surface.baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("GET /health/ready — canonical readiness with per-dependency checks", async () => {
    const res = await fetch(`${surface.baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { postgres: string } };
    expect(body.status).toBe("ready");
    expect(body.checks.postgres).toBe("ok");
  });

  it("GET /canary/slo-gate — unauthenticated CI SLO gate", async () => {
    const res = await fetch(`${surface.baseUrl}/canary/slo-gate`);
    expect([200, 409]).toContain(res.status);
    const body = (await res.json()) as { allow: boolean };
    expect(typeof body.allow).toBe("boolean");
  });

  it("GET /health/deep — authenticated deep health (requires memory:admin)", async () => {
    const res = await surface.http("GET", "/health/deep");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { postgres: { status: string } } };
    // The harness wires no `healthAdapters` (no cache/vector health-check
    // adapters), so vector/cache report "unknown" — a real, non-"ok" status
    // that correctly degrades the overall verdict. Postgres IS real and
    // reachable, so it alone must read "ok".
    expect(body.status).toBe("degraded");
    expect(body.checks.postgres.status).toBe("ok");
  });

  it("GET /health/deep — rejects a missing bearer token", async () => {
    const res = await fetch(`${surface.baseUrl}/health/deep`);
    expect(res.status).toBe(401);
  });

  it("GET /health/history — authenticated readiness ring buffer", async () => {
    const res = await surface.http("GET", "/health/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("GET /health/cognitive — authenticated cognitive health snapshot", async () => {
    const res = await surface.http("GET", "/health/cognitive");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; computedAt: string };
    expect(body.workspaceId).toBe(surface.workspaceId);
    expect(typeof body.computedAt).toBe("string");
  });

  it("GET /metrics — Prometheus text exposition format", async () => {
    const res = await surface.http("GET", "/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# HELP");
  });

  it("GET /metrics/prometheus — same exposition, explicit alias", async () => {
    const res = await surface.http("GET", "/metrics/prometheus");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# HELP");
  });

  it("GET /dashboard — unauthenticated status HTML page", async () => {
    const res = await fetch(`${surface.baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<html");
  });

  it("GET /openapi.json — authenticated OpenAPI document", async () => {
    const res = await surface.http("GET", "/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it("GET /docs — authenticated Swagger UI page", async () => {
    const res = await surface.http("GET", "/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /cost — authenticated workspace cost dashboard", async () => {
    const res = await surface.http("GET", "/cost");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meteredSpendUsd: number };
    expect(typeof body.meteredSpendUsd).toBe("number");
  });

  it("GET /usage — authenticated billing usage snapshot", async () => {
    const res = await surface.http("GET", "/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; plan: string };
    expect(body.workspaceId).toBe(surface.workspaceId);
    expect(typeof body.plan).toBe("string");
  });
});
