/**
 * Unit tests for admin global retention config routes:
 *   PUT    /admin/config/retention
 *   GET    /admin/config/retention
 *   DELETE /admin/config/retention
 *
 * Uses in-memory fakes — no real DB, no real KMS.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountAdminRetention } from "../../routes/admin-retention.js";
import type { WorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { GLOBAL_SENTINEL_ID } from "../../config/WorkspaceConfigStore.js";
import { RetentionConfigResolver } from "../../config/RetentionConfigResolver.js";
import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import { toErrorBody } from "../../errors.js";

// ─── Test master key ──────────────────────────────────────────────────────────

const TEST_MASTER_KEY = "b".repeat(64);
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const BOOT_DEFAULTS = {
  internalDays: 730,
  confidentialDays: 365,
  restrictedDays: 90,
  transcriptDays: 30,
};

// ─── In-memory fake WorkspaceConfigStore ─────────────────────────────────────

function makeFakeStore(): WorkspaceConfigStore & { _data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    _data: data,
    async get(workspaceId: string, key: string): Promise<string | null> {
      return data.get(`${workspaceId}:${key}`) ?? null;
    },
    async set(workspaceId: string, key: string, valueEnc: string): Promise<void> {
      data.set(`${workspaceId}:${key}`, valueEnc);
    },
    async delete(workspaceId: string, key: string): Promise<void> {
      data.delete(`${workspaceId}:${key}`);
    },
    async getMany(workspaceId: string, keys: readonly string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const key of keys) {
        const v = data.get(`${workspaceId}:${key}`);
        if (v !== undefined) out.set(key, v);
      }
      return out;
    },
    async replaceGroup(
      workspaceId: string,
      group: readonly string[],
      values: Readonly<Record<string, string>>
    ): Promise<void> {
      for (const key of group) data.delete(`${workspaceId}:${key}`);
      for (const [key, v] of Object.entries(values)) data.set(`${workspaceId}:${key}`, v);
    },
  };
}

// ─── Mock createKeyRingAdapter ────────────────────────────────────────────────

vi.mock("../../encryption/KeyRingAdapter.js", async (importActual) => {
  const actual = await importActual<typeof import("../../encryption/KeyRingAdapter.js")>();
  return {
    ...actual,
    createKeyRingAdapter: () =>
      new actual.KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 }),
  };
});

// ─── App factory ─────────────────────────────────────────────────────────────

function makeAdminApp(overrides: Partial<ServerDeps> = {}, storeOverride?: WorkspaceConfigStore) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["admin:workspace"] as ReadonlyArray<string>);
    // p50-audit-log-emitters PR6: admin routes now call resolveProvenance(c)
    // on the success path before emitting `admin_access` — actorId must be
    // present or resolveProvenance() throws.
    c.set("actorId", "admin-test-actor");
    c.set("actorType", "agent");
    await next();
  });

  const keyRing = new KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 });
  const store = storeOverride ?? makeFakeStore();
  const resolver = new RetentionConfigResolver(store, keyRing, BOOT_DEFAULTS);

  // flatten-legacy-dual-core Phase 9 (task 9.1): this file never exercises
  // GET /admin/stats (confirmed — no route request in this file), so the
  // `vi.mock("@mnemo-ai/core")` that used to stub `getHealthSnapshot` here
  // to avoid a real DB tx was already dead code even before this port;
  // removed rather than migrated.

  const fakeDeps = {
    core: {
      vitals: vi.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        factsLive: 0,
        factsClosed: 0,
        pinnedCount: 0,
        lastRecallAt: null,
        lastWriteAt: null,
        embeddings: { indexed: 0, pending: 0 },
        factsByScopeRef: [],
      }),
    } as unknown as ServerDeps["core"],
    apiKeys: {} as ServerDeps["apiKeys"],
    embedModel: "text-embedding-3-small",
    telemetry: { startSpan: () => ({ end: () => {} }) } as unknown as ServerDeps["telemetry"],
    workspaceConfigStore: store,
    retentionConfigResolver: resolver,
    llmConfigResolver: undefined,
    metricsPgClient: undefined,
    ...overrides,
  } as unknown as ServerDeps;

  mountAdminRetention(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, store, resolver, keyRing };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PUT /admin/config/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 { ok: true } and stores under GLOBAL_SENTINEL_ID", async () => {
    const { app, store } = makeAdminApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    const res = await app.request("/admin/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 500, confidentialDays: 200, restrictedDays: 60 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Values should be stored under GLOBAL_SENTINEL_ID
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_internal_days`)).toBe(true);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_confidential_days`)).toBe(true);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_restricted_days`)).toBe(true);

    // Values should NOT be stored under the workspace ID
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_internal_days`)).toBe(false);
  });

  it("returns 501 when workspaceConfigStore is absent", async () => {
    const { app } = makeAdminApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/admin/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 500 }),
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("supports partial update — only stores provided keys", async () => {
    const { app, store } = makeAdminApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    const res = await app.request("/admin/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 500 }),
    });

    expect(res.status).toBe(200);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_internal_days`)).toBe(true);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_confidential_days`)).toBe(false);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_restricted_days`)).toBe(false);
  });
});

describe("GET /admin/config/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with source:env when no global sentinel row exists", async () => {
    const { app } = makeAdminApp();

    const res = await app.request("/admin/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      internalDays: number;
      confidentialDays: number;
      restrictedDays: number;
      source: string;
    };
    expect(body.source).toBe("env");
    expect(body.internalDays).toBe(730);
    expect(body.confidentialDays).toBe(365);
    expect(body.restrictedDays).toBe(90);
  });

  it("returns source:global when sentinel row exists", async () => {
    const { app, store, keyRing } = makeAdminApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    // Seed global sentinel rows
    const enc = (v: string) => keyRing.encryptSecret(GLOBAL_SENTINEL_ID, "retention-config", v);
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_internal_days`, enc("500"));
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_confidential_days`, enc("200"));
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_restricted_days`, enc("60"));

    const res = await app.request("/admin/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; internalDays: number };
    expect(body.source).toBe("global");
    expect(body.internalDays).toBe(500);
  });

  it("returns source:env when no resolver configured", async () => {
    const { app } = makeAdminApp({
      retentionConfigResolver: undefined,
      workspaceConfigStore: undefined,
    });

    const res = await app.request("/admin/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("env");
  });
});

describe("DELETE /admin/config/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 204 and removes all 3 sentinel keys when they exist", async () => {
    const { app, store, keyRing } = makeAdminApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    // Seed global sentinel row
    const enc = keyRing.encryptSecret(GLOBAL_SENTINEL_ID, "retention-config", "365");
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_internal_days`, enc);
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_confidential_days`, enc);
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_restricted_days`, enc);

    const res = await app.request("/admin/config/retention", { method: "DELETE" });
    expect(res.status).toBe(204);

    // All 3 keys should be gone
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_internal_days`)).toBe(false);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_confidential_days`)).toBe(false);
    expect(fakeStore._data.has(`${GLOBAL_SENTINEL_ID}:retention_restricted_days`)).toBe(false);
  });

  it("returns 404 when no global retention row exists", async () => {
    const { app } = makeAdminApp();

    const res = await app.request("/admin/config/retention", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 501 when store is absent", async () => {
    const { app } = makeAdminApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/admin/config/retention", { method: "DELETE" });
    expect(res.status).toBe(501);
  });
});
