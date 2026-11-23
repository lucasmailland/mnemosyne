/**
 * Tier A parity — GET /health, GET /readyz, GET /health/ready (design.md D3).
 *
 * HTTP characterization contract for `packages/server/src/routes/health.ts`.
 * Written and merged green against the legacy `deps.core.ping()`/
 * `deps.core.vitals()` (`CoreLike`) implementation FIRST
 * (flatten-legacy-dual-core PR6); the port commit in this same PR then
 * swapped both checks to `deps.storage.healthCheck()`/
 * `deps.storage.getWorkspaceVitals()` (v3 `StorageAdapter`) with ZERO changes
 * to any `expect(...)` line below — only each `buildApp`'s deps-fake wiring
 * changed (`core: {...}` → `storage: {...}`), per D3's explicit allowance.
 * Asserts only the observable contract: status matrix, response key
 * set/types (via `contracts/health.schema.json` for GET /health), and
 * forwarding.
 *
 * `GET /health/deep`'s admin-auth gate is already exhaustively covered by
 * `unit/health-deep.test.ts` — not duplicated here.
 */
import { Hono } from "hono";
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { loadSchema, validate } from "../_schemaValidate.js";
import { mountVitals, mountProbes } from "../../routes/health.js";

const PLAINTEXT_KEY = "mns_live_healthparitytest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000e01";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "health-key-001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

function vitalsRecord() {
  return {
    workspaceId: WS_ID,
    factsLive: 4,
    factsClosed: 1,
    pinnedCount: 2,
    lastRecallAt: "2026-06-20T00:00:00.000Z",
    lastWriteAt: "2026-06-21T00:00:00.000Z",
    embeddings: { indexed: 3, pending: 1 },
    factsByScopeRef: [{ scopeRef: "project:abc", count: 2 }],
  };
}

describe("Tier A parity: GET /health (mountVitals)", () => {
  async function buildApp(getWorkspaceVitals = vi.fn().mockResolvedValue(vitalsRecord())) {
    const deps = {
      storage: { getWorkspaceVitals },
      apiKeys: await makeKeyLookup(),
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountVitals]);
    return { app, vitals: getWorkspaceVitals };
  }

  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(401);
  });

  it("returns 200 conforming to health.schema.json", async () => {
    const healthSchema = loadSchema("health");
    const { app } = await buildApp();
    const res = await app.request("/health", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const err = validate(body, healthSchema);
    expect(err).toBeNull();
  });

  it("forwards workspaceId to the storage layer", async () => {
    // Disclosed exception to D3's zero-expect()-diff rule (see file header):
    // `StorageAdapter.getWorkspaceVitals(workspaceId: string)` takes a
    // positional string (matching the majority StorageAdapter convention,
    // e.g. `getFact(id, workspaceId)`), not legacy `vitals(args: {workspaceId})`'s
    // options-bag shape. The HTTP-observable contract (response body, status
    // codes) is unchanged — only this one internal call-shape assertion
    // differs, and only because the two dependencies genuinely have
    // different calling conventions, not because behavior changed.
    const { app, vitals } = await buildApp();
    await app.request("/health", { headers: authed() });
    expect(vitals).toHaveBeenCalledWith(WS_ID);
  });

  it("returns the vitals body verbatim, including factsByScopeRef", async () => {
    const { app } = await buildApp();
    const res = await app.request("/health", { headers: authed() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(vitalsRecord());
  });
});

describe("Tier A parity: GET /readyz / GET /health/ready (mountProbes)", () => {
  // mountProbes mounts unauthenticated routes directly on a bare Hono app —
  // matches unit/health-deep.test.ts's existing harness for this mount fn.
  function buildApp(healthCheck: () => Promise<{ status: string; latencyMs: number }>) {
    const app = new Hono();
    const deps = {
      storage: { healthCheck },
      apiKeys: { listActive: async () => [] },
      bus: { emit: () => {} },
      healthAdapters: undefined,
    } as unknown as ServerDeps & { healthAdapters?: undefined };
    mountProbes(app, deps);
    return app;
  }

  it("GET /readyz returns 200 {status:'ready'} when deps.core.ping() resolves", async () => {
    const healthCheck = vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 });
    const app = buildApp(healthCheck);
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("GET /readyz returns 503 {status:'not_ready', error} when deps.core.ping() rejects", async () => {
    const app = buildApp(vi.fn().mockRejectedValue(new Error("connection refused")));
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("not_ready");
    expect(body.error).toBe("connection refused");
  });

  it("GET /health/ready returns 200 ready, with UNPROBED dependencies reported as unknown", async () => {
    // P127 — this expectation changed, and the old one was the bug.
    //
    // It used to assert `degraded: false` and `vector/cache: "ok"` for a
    // fixture that wires NEITHER adapter, which is exactly the claim that made
    // the endpoint useless: with `healthAdapters` unset (its state in every
    // real deployment), the route answered "ok" for dependencies it had never
    // contacted. Stopping redis or ollama changed nothing in the response.
    //
    // An unprobed dependency now reports `unknown` and counts as degraded.
    // The instance still serves — 200, `status: "ready"` — because Postgres is
    // up; it simply stops claiming to know things it does not.
    const app = buildApp(vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }));
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      degraded: boolean;
      checks: { postgres: string; vector: string; cache: string; embed?: string };
    };
    expect(body.status).toBe("ready");
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.vector).toBe("unknown");
    expect(body.checks.cache).toBe("unknown");
    expect(body.checks.embed).toBe("unknown");
    expect(body.degraded).toBe(true);
  });

  it("GET /health/ready returns 503 {status:'not_ready', reason:'postgres_unavailable'} when deps.core.ping() rejects", async () => {
    const app = buildApp(vi.fn().mockRejectedValue(new Error("connection refused")));
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("not_ready");
    expect(body.reason).toBe("postgres_unavailable");
  });
});
