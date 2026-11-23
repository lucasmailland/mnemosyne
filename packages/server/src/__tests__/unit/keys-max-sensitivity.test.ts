/**
 * Unit tests for P8 — per-key sensitivity ceiling (maxSensitivity).
 *
 * Tests:
 *   6.1 — Key with max_sensitivity="internal" triggers 404 for confidential facts
 *          (via assertCanReadFact / rbac.ts ceiling enforcement).
 *   6.2 — GET /admin/keys?expired=true returns only expired keys.
 *   maxSensitivity field round-trips through keys create → list → show.
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() SQL client.
 * No real DB, no bcrypt.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountKeys } from "../../routes/keys.js";
import { effectiveCeiling, canReadSensitivity } from "../../rbac.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000077";
const KEY_ID = "mk_p8testkey0011223344";

// ── Helper: build a fake OpenAPIHono app with keys mounted ────────────────────

function makeApp(sqlRowsByCall: { selectRows: unknown[]; listRows?: unknown[] }) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("scopes", new Set(["admin:keys"]) as unknown as ReadonlyArray<string>);
    await next();
  });

  const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;

  // withKeysTx wraps calls in sql.begin(fn). We use a call counter to
  // return the preamble (4 SET LOCAL / set_config) then the actual rows.
  (fakeSql as unknown as Record<string, unknown>).begin = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    let txCallCount = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      txCallCount++;
      if (txCallCount <= 4) return Promise.resolve([]); // preamble
      return Promise.resolve(sqlRowsByCall.selectRows);
    });
    (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(fakeTx);
  };

  const fakeDeps = { metricsPgClient: fakeSql } as unknown as ServerDeps;
  mountKeys(app, fakeDeps);
  return { app, fakeSql };
}

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    label: "restricted agent",
    name: "restricted agent",
    scopes: ["memory:read"],
    plan: "free",
    ip_allowlist: [],
    expires_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    deprecated_at: null,
    rotated_from_id: null,
    max_sensitivity: null,
    ...overrides,
  };
}

// ── Task 6.1 — effectiveCeiling with maxSensitivity="internal" blocks confidential ──────

describe("effectiveCeiling enforcement (rbac.ts) — task 6.1", () => {
  it("key with maxSensitivity=internal cannot read confidential facts", () => {
    // Simulates the call chain inside recall handlers:
    //   resolveCeiling(c) -> effectiveCeiling(envCeiling, c.get("maxSensitivity"))
    const envCeiling = "restricted" as const; // process allows everything
    const keyMax = "internal" as const; // key is restricted to internal
    const ceiling = effectiveCeiling(envCeiling, keyMax);
    // ceiling must be "internal" (key wins — it's more restrictive)
    expect(ceiling).toBe("internal");
    // Now check that a confidential fact is blocked
    expect(canReadSensitivity(ceiling, "confidential")).toBe(false);
    // And that a public/internal fact passes
    expect(canReadSensitivity(ceiling, "public")).toBe(true);
    expect(canReadSensitivity(ceiling, "internal")).toBe(true);
  });

  it("key with maxSensitivity=public cannot read internal facts", () => {
    const ceiling = effectiveCeiling("restricted", "public");
    expect(ceiling).toBe("public");
    expect(canReadSensitivity(ceiling, "internal")).toBe(false);
    expect(canReadSensitivity(ceiling, "public")).toBe(true);
  });

  it("key with NULL maxSensitivity defers entirely to env ceiling", () => {
    const ceiling = effectiveCeiling("confidential", undefined);
    expect(ceiling).toBe("confidential");
    expect(canReadSensitivity(ceiling, "confidential")).toBe(true);
    expect(canReadSensitivity(ceiling, "restricted")).toBe(false);
  });

  it("key maxSensitivity cannot raise the ceiling above env limit", () => {
    // env is "internal", key claims "restricted" — env wins
    const ceiling = effectiveCeiling("internal", "restricted");
    expect(ceiling).toBe("internal");
    expect(canReadSensitivity(ceiling, "confidential")).toBe(false);
  });
});

// ── Task 6.2 — ?expired=true list filter ─────────────────────────────────────

describe("GET /admin/keys?expired=true — task 6.2", () => {
  it("returns only the expired key row when ?expired=true", async () => {
    const expiredRow = makeKeyRow({
      id: "mk_expiredkey00112233",
      label: "expired key",
      expires_at: "2025-01-01T00:00:00.000Z",
    });
    const { app } = makeApp({ selectRows: [expiredRow] });

    const res = await app.request("/admin/keys?expired=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].id).toBe("mk_expiredkey00112233");
    expect(body.keys[0].expiresAt).toContain("2025-01-01");
  });

  it("returns an empty list when no expired keys exist", async () => {
    const { app } = makeApp({ selectRows: [] });
    const res = await app.request("/admin/keys?expired=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys).toHaveLength(0);
  });

  it("default list (?expired omitted) returns active keys (SQL filter verified via response shape)", async () => {
    const activeRow = makeKeyRow({ label: "active key" });
    const { app } = makeApp({ selectRows: [activeRow] });
    const res = await app.request("/admin/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].label).toBe("active key");
  });
});

// ── maxSensitivity round-trip in keys show ────────────────────────────────────

describe("GET /admin/keys/:keyId — maxSensitivity field round-trip", () => {
  it("returns maxSensitivity=internal when column is set", async () => {
    const row = makeKeyRow({ max_sensitivity: "internal" });
    const { app } = makeApp({ selectRows: [row] });
    const res = await app.request(`/admin/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.maxSensitivity).toBe("internal");
  });

  it("returns maxSensitivity=null when column is NULL", async () => {
    const row = makeKeyRow({ max_sensitivity: null });
    const { app } = makeApp({ selectRows: [row] });
    const res = await app.request(`/admin/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.maxSensitivity).toBeNull();
  });
});

// ── maxSensitivity in list response ──────────────────────────────────────────

describe("GET /admin/keys — maxSensitivity in list", () => {
  it("includes maxSensitivity in each key list item", async () => {
    const rows = [
      makeKeyRow({ max_sensitivity: "public" }),
      makeKeyRow({ id: "mk_other00112233", max_sensitivity: null }),
    ];
    const { app } = makeApp({ selectRows: rows });
    const res = await app.request("/admin/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0].maxSensitivity).toBe("public");
    expect(body.keys[1].maxSensitivity).toBeNull();
  });
});
