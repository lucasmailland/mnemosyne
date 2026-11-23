/**
 * Tier A parity — GET /metrics (JSON) best-effort health block (design.md D3).
 *
 * HTTP characterization contract for the ONE `deps.core` call site in
 * `packages/server/src/routes/metrics.ts` — `GET /metrics`'s best-effort
 * health block, a defensive `deps.core as unknown as Record<string, unknown>`
 * cast probing for a `healthCheck` method via
 * `typeof coreAny["healthCheck"] === "function"`.
 *
 * Investigated first (not assumed, flatten-legacy-dual-core PR13): `CoreLike`
 * (`packages/core/src/factory-types.ts`) never declares `healthCheck` — zero
 * hits across `factory.ts`/`factory-types.ts` — so this branch's `typeof`
 * check ALWAYS evaluates to `false` at runtime; `payload.health` is dead code
 * that never populates, regardless of what `deps.core` is. `mountMetrics`'s
 * other work (uptime/memory/process payload, `refreshSnapshotGauges`,
 * Prometheus text) never touches `deps.core` and is already covered by
 * `unit/metrics-endpoint.test.ts` / `unit/domain-metrics.test.ts` /
 * `unit/snapshot-metrics.test.ts` — not duplicated here.
 *
 * Written and merged green against the legacy dead-code probe FIRST
 * (flatten-legacy-dual-core PR13); the port commit in this same PR then
 * replaced it with a REAL call to `deps.storage.healthCheck()` (v3
 * `StorageAdapter`, already implemented by `DrizzleStorageAdapter` and
 * already used the same way by `routes/health.ts`'s `pingStorage`), guarded
 * on `deps.storage` truthiness (same optional-field pattern PR12's
 * `keys.ts` port established).
 *
 * DISCLOSED exception (design.md D3's zero-`expect()`-diff rule): this is a
 * genuine, intended BEHAVIOR CHANGE, not a pure calling-convention swap —
 * pre-port, `payload.health` is unconditionally absent (dead code always
 * evaluates false); post-port, it is populated with the real storage health
 * check result. The two "health block" tests below are written for each
 * side of that swap and are NOT expected to hold unmodified across the port
 * — every other assertion in this file (status code, base payload shape,
 * that `deps.core`/`deps.storage` is never required to be present) is
 * unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { mountMetrics } from "../../routes/metrics.js";

const PLAINTEXT_KEY = "mns_live_metricsparitytest000001";
const WS_ID = "00000000-0000-0000-0000-000000000f01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  return {
    listActive: async () => [
      {
        id: "metrics-key-001",
        keyHash: await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST),
        workspaceId: WS_ID,
        scopes: [],
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}` };
}

async function buildApp(deps: Partial<ServerDeps> = {}) {
  const fullDeps = {
    apiKeys: await makeKeyLookup(),
    ...deps,
  } as unknown as ServerDeps;
  const app = buildMountHarness(fullDeps, [mountMetrics]);
  return { app };
}

type MetricsBody = {
  uptime_s: number;
  memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number };
  process: { pid: number; node_version: string; platform: string };
  timestamp: string;
  health?: { status: string; latency_ms: number };
  prometheus: string;
};

describe("Tier A parity: GET /metrics (JSON, best-effort health block)", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/metrics");
    expect(res.status).toBe(401);
  });

  it("returns 200 with the base payload shape (uptime/memory/process/timestamp/prometheus)", async () => {
    const { app } = await buildApp();
    const res = await app.request("/metrics", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsBody;
    expect(typeof body.uptime_s).toBe("number");
    expect(typeof body.memory.rss_mb).toBe("number");
    expect(typeof body.memory.heap_used_mb).toBe("number");
    expect(typeof body.memory.heap_total_mb).toBe("number");
    expect(typeof body.process.pid).toBe("number");
    expect(typeof body.process.node_version).toBe("string");
    expect(typeof body.process.platform).toBe("string");
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.prometheus).toBe("string");
  });

  it("DISCLOSED exception — health block: dead-code probe (pre-port), real storage.healthCheck() (post-port)", async () => {
    // Post-port behavior: `deps.storage.healthCheck()` is wired and its
    // result populates `payload.health`. See file header — this is the one
    // intended behavior change this PR makes (dead code → live check).
    const healthCheck = vi.fn().mockResolvedValue({ status: "ok", latencyMs: 5 });
    const { app } = await buildApp({
      storage: { healthCheck } as unknown as ServerDeps["storage"],
    });
    const res = await app.request("/metrics", { headers: authed() });
    const body = (await res.json()) as MetricsBody;
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(body.health).toEqual({ status: "ok", latency_ms: 5 });
  });

  it("degrades gracefully (no health field, still 200) when deps.storage is absent", async () => {
    const { app } = await buildApp();
    const res = await app.request("/metrics", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsBody;
    expect(body.health).toBeUndefined();
  });

  it("degrades gracefully (no health field, still 200) when storage.healthCheck() rejects", async () => {
    const healthCheck = vi.fn().mockRejectedValue(new Error("connection refused"));
    const { app } = await buildApp({
      storage: { healthCheck } as unknown as ServerDeps["storage"],
    });
    const res = await app.request("/metrics", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsBody;
    expect(body.health).toBeUndefined();
  });
});
