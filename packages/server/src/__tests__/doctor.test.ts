/**
 * Unit tests for GET /doctor — operational preflight diagnostics.
 *
 * Tests cover:
 *  - Each of the 6 server-side checks: pass / warn / error variants
 *  - Promise.allSettled isolation (one throwing check does not block others)
 *  - Overall worst-of status computation
 *  - 401 on missing bearer token
 *  - checkWorkspaceIdValid's branch logic directly (its "error" branch is
 *    unreachable through the real HTTP route — see
 *    packages/server/src/__tests__/integration/doctor-nonsuperuser.integration.test.ts
 *    for the empirical proof of that — so it's covered here as a pure-function
 *    unit test instead)
 */

import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { buildMountHarness } from "./_mountHarness.js";
import { mountDoctor, checkWorkspaceIdValid } from "../routes/doctor.js";

// migration_version now compares schema_migrations against the migrations/
// bundled with the build (see doctor.ts) — mock that to a fixed filename so
// tests don't depend on the real, ever-growing migrations directory.
vi.mock("@mnemo-ai/adapter-postgres/migrate", () => ({
  listMigrationFilenames: vi.fn().mockResolvedValue(["0075.sql"]),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PLAINTEXT_KEY = "mns_live_doctortestkey00000001xx";
const WS_ID = "12345678-1234-1234-1234-123456789012";

async function makeKeyLookup(workspaceId = WS_ID): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "doctor-key-001", keyHash, workspaceId, scopes: ["memory:read"] },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, ...extra };
}

/**
 * Build a minimal postgres SQL mock that returns the given rows for any
 * query, and supports `.begin(cb)` (checkEmbeddingBacklog runs its
 * mnemo_set_workspace() + COUNT query pair inside a transaction so both
 * hit the same pooled connection — see doctor.ts). `.begin` just invokes
 * the callback with the same mock as `tx`, so callers queue the
 * transaction's queries with the ordinary `.mockResolvedValueOnce()` chain
 * used everywhere else in this file — one entry per query, including the
 * mnemo_set_workspace() call.
 */
function makePgMock(rows: Record<string, unknown>[]): unknown {
  // postgres.Sql is called as a tagged-template function.
  const fn = vi.fn().mockResolvedValue(rows);
  (fn as unknown as { begin: unknown }).begin = vi.fn(
    async (cb: (tx: typeof fn) => Promise<unknown>) => cb(fn)
  );
  return fn as unknown;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /doctor", () => {
  it("returns 401 when no bearer token is supplied", async () => {
    const deps = {
      storage: { healthCheck: vi.fn() },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor");
    expect(res.status).toBe(401);
  });

  it("returns 200 with all 6 checks when everything is healthy", async () => {
    const pgMock = makePgMock([{ granted: true }]);
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    // Override each SQL call to return appropriate mock data.
    const sql = deps.metricsPgClient as ReturnType<typeof vi.fn>;
    sql
      // app_user_grants
      .mockResolvedValueOnce([{ granted: true }])
      // schema_shadows
      .mockResolvedValueOnce([])
      // migration_version
      .mockResolvedValueOnce([
        { filename: "0075.sql", applied_at: new Date("2026-06-24T00:00:00Z") },
      ])
      // embedding_backlog
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]);

    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string }[];
      timestamp: string;
    };
    expect(body.status).toBe("ok");
    expect(body.checks).toHaveLength(6);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const byName = Object.fromEntries(body.checks.map((c) => [c.name, c]));
    expect(byName["connectivity"]?.status).toBe("ok");
    expect(byName["app_user_grants"]?.status).toBe("ok");
    expect(byName["schema_shadows"]?.status).toBe("ok");
    expect(byName["migration_version"]?.status).toBe("ok");
    expect(byName["embedding_backlog"]?.status).toBe("ok");
    expect(byName["workspace_id_valid"]?.status).toBe("ok");
  });

  it("migration_version returns error when the DB is missing the latest migration this build expects", async () => {
    // Module-level mock pins the "expected" migration to "0075.sql" — return a
    // schema_migrations set that stops earlier, simulating the exact gap that
    // let our own migrate image go stale: DB behind, server unaware.
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: true }]) // app_user_grants
      .mockResolvedValueOnce([]) // schema_shadows
      .mockResolvedValueOnce([
        { filename: "0050.sql", applied_at: new Date("2026-06-24T00:00:00Z") },
      ]) // migration_version — behind
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]);
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string; message: string; detail?: Record<string, unknown> }[];
    };
    expect(body.status).toBe("error");
    const migration = body.checks.find((c) => c.name === "migration_version");
    expect(migration?.status).toBe("error");
    expect(migration?.message).toContain("0075.sql");
    expect(migration?.detail?.expectedLatest).toBe("0075.sql");
    expect(migration?.detail?.missing).toEqual(["0075.sql"]);
  });

  it("connectivity check returns error when ping() throws", async () => {
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]);
    const deps = {
      storage: { healthCheck: vi.fn().mockRejectedValue(new Error("connection refused")) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string; message: string }[];
    };
    expect(res.status).toBe(200); // always 200 — caller checks status field
    expect(body.status).toBe("error");
    const connectivity = body.checks.find((c) => c.name === "connectivity");
    expect(connectivity?.status).toBe("error");
    expect(connectivity?.message).toContain("connection refused");
  });

  it("app_user_grants returns error when granted=false", async () => {
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: false }]) // app_user_grants
      .mockResolvedValueOnce([]) // schema_shadows
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted // migration_version
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]); // embedding_backlog
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string }[];
    };
    expect(body.status).toBe("error");
    const grant = body.checks.find((c) => c.name === "app_user_grants");
    expect(grant?.status).toBe("error");
  });

  it("app_user_grants returns unknown when query throws (permission denied)", async () => {
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockRejectedValueOnce(new Error("permission denied")) // app_user_grants
      .mockResolvedValueOnce([]) // schema_shadows
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted // migration_version
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]); // embedding_backlog
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string }[];
    };
    const grant = body.checks.find((c) => c.name === "app_user_grants");
    expect(grant?.status).toBe("unknown");
  });

  it("schema_shadows returns warn when shadow tables are found", async () => {
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: true }]) // app_user_grants
      .mockResolvedValueOnce([{ tablename: "mnemo_hyperedge" }]) // schema_shadows — 1 unexpected shadow (APP-049)
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted // migration_version
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]); // embedding_backlog
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string; message: string }[];
    };
    expect(body.status).toBe("warn"); // warn maps to degraded overall
    const shadows = body.checks.find((c) => c.name === "schema_shadows");
    expect(shadows?.status).toBe("warn");
    expect(shadows?.message).toContain("1");
  });

  it("embedding_backlog returns warn when backlog > 0", async () => {
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "42" }]);
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string; message: string }[];
    };
    expect(body.status).toBe("warn");
    const backlog = body.checks.find((c) => c.name === "embedding_backlog");
    expect(backlog?.status).toBe("warn");
    expect(backlog?.message).toContain("42");
  });

  it("workspace_id_valid returns ok for valid UUID workspace id (auth pre-validates)", async () => {
    // Note: the auth middleware validates the workspaceId via isWorkspaceId() before
    // any route handler runs. If the workspaceId is malformed, auth returns 400 and
    // the route is never reached. The workspace_id_valid check is a secondary guard
    // that will always pass when auth has accepted the request.
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "0" }]);
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(), // WS_ID is a valid UUID
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string }[];
    };
    expect(res.status).toBe(200);
    const wsCheck = body.checks.find((c) => c.name === "workspace_id_valid");
    expect(wsCheck?.status).toBe("ok");
  });

  it("Promise.allSettled isolation: one throwing check does not prevent others", async () => {
    // Simulate a completely broken pg mock that always throws.
    const brokenPg = vi.fn().mockRejectedValue(new Error("db kaboom"));
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: brokenPg,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    expect(res.status).toBe(200); // Should not 500
    const body = (await res.json()) as { status: string; checks: { name: string }[] };
    // Should still return exactly 6 checks
    expect(body.checks).toHaveLength(6);
    // connectivity (core.ping succeeded) should pass
    const connectivity = body.checks.find((c) => c.name === "connectivity");
    expect(connectivity?.status).toBe("ok");
  });

  it("overall status is error when any check is error (worst-of)", async () => {
    const pgMock = makePgMock([]) as ReturnType<typeof vi.fn>;
    pgMock
      .mockResolvedValueOnce([{ granted: false }]) // error
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ filename: "0075.sql", applied_at: new Date() }]) // determinism-ok: mock DB row, applied_at not asserted
      .mockResolvedValueOnce([]) // embedding_backlog: mnemo_set_workspace()
      .mockResolvedValueOnce([{ backlog: "5" }]); // warn — error should dominate
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      metricsPgClient: pgMock,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("error");
  });

  it("no metricsPgClient — DB checks return unknown, not error", async () => {
    const deps = {
      storage: { healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }) },
      apiKeys: await makeKeyLookup(),
      embedModel: "",
      // metricsPgClient intentionally absent
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountDoctor]);
    const res = await app.request("/doctor", { headers: authed() });
    const body = (await res.json()) as {
      status: string;
      checks: { name: string; status: string }[];
    };
    expect(res.status).toBe(200);
    const dbChecks = [
      "app_user_grants",
      "schema_shadows",
      "migration_version",
      "embedding_backlog",
    ];
    for (const name of dbChecks) {
      const check = body.checks.find((c) => c.name === name);
      expect(check?.status).toBe("unknown");
    }
  });
});

describe("checkWorkspaceIdValid — direct unit test of the branch logic", () => {
  // The route-level tests above (and the real integration suite) can only
  // ever exercise the "ok" branch, because auth always hands the route a
  // pre-validated UUID. These tests prove the "error" branch itself is
  // correct, real code — not dead/unreachable logic — even though nothing
  // in the live system can trigger it.
  it("reports ok for a well-formed UUID", () => {
    const result = checkWorkspaceIdValid("12345678-1234-1234-1234-123456789012");
    expect(result.status).toBe("ok");
    expect(result.name).toBe("workspace_id_valid");
  });

  it("reports ok for an uppercase UUID (case-insensitive)", () => {
    const result = checkWorkspaceIdValid("ABCDEF12-1234-1234-1234-123456789ABC");
    expect(result.status).toBe("ok");
  });

  it("reports error for a malformed workspace_id and names it in the message", () => {
    const result = checkWorkspaceIdValid("not-a-valid-uuid");
    expect(result.status).toBe("error");
    expect(result.message).toContain("not-a-valid-uuid");
  });

  it("reports error for an empty string", () => {
    const result = checkWorkspaceIdValid("");
    expect(result.status).toBe("error");
  });

  it("reports error for a cuid2-shaped id (the legacy, non-UUID id format)", () => {
    const result = checkWorkspaceIdValid("clh3x9k2e0000qzrmn831p59k");
    expect(result.status).toBe("error");
  });
});

// APP-049 (audit 2026-11-22): memory_doctor warned on every fresh install
// because both migration streams create mnemo_fact, mnemo_entity, ... in public
// and mnemosyne. Those expected legacy shadows are reported as ok; any other
// shadow (a table that should exist in one schema only) still warns.
describe("schema_shadows tells the expected legacy tables from a real shadow", () => {
  async function shadowCheck(tables: string[]) {
    const { checkSchemaShadowsForTests } = await import("../routes/doctor.js");
    const client = vi.fn().mockResolvedValue(tables.map((tablename) => ({ tablename })));
    return checkSchemaShadowsForTests({ metricsPgClient: client } as never);
  }

  it("is ok when only the legacy stream's tables are shadowed", async () => {
    const r = await shadowCheck(["mnemo_fact", "mnemo_entity", "mnemo_api_keys"]);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatchObject({ shadowCount: 3, unexpected: [] });
  });

  it("warns, naming it, when a table outside that set is shadowed", async () => {
    const r = await shadowCheck(["mnemo_fact", "mnemo_hyperedge"]);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatchObject({ shadowCount: 2, unexpected: ["mnemo_hyperedge"] });
  });
});
