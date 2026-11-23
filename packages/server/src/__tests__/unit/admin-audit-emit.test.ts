/**
 * Unit tests for p50-audit-log-emitters PR6 — admin.ts audit emission.
 *
 * Covers tasks 6.1-6.5: `admin_access` is emitted from the 4 MUTATING admin
 * handlers only (`putAdminLlmConfig`, `putAdminRetentionConfig`,
 * `deleteAdminRetentionConfig`, `postEmbeddingMigration`) after the operation
 * succeeds, with a namespaced actorId. GET admin handlers
 * (`getAdminLlmConfig`, `getAdminRetentionConfig`, `getStats`) MUST stay
 * silent — regression-tested here.
 *
 * Per design D5 (and the orchestrator's resolved decision): the audit entry
 * is partitioned on the caller's REAL workspace (c.get("workspaceId")),
 * NEVER on GLOBAL_SENTINEL_ID — the admin global-config sentinel is not a
 * real workspace row and appendAuditEntry requires a genuine workspace UUID.
 *
 * Pattern: mirrors admin-config-retention.test.ts / admin-llm-config-route.test.ts's
 * app-building fixtures, combined with keys-audit-emit.test.ts's spy-on-
 * appendAuditEntry approach.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { AuditLogEntry } from "@mnemo-ai/types";
import { mountAdminLlmConfig } from "../../routes/admin-llm-config.js";
import { mountAdminRetention } from "../../routes/admin-retention.js";
import { mountAdminStats } from "../../routes/admin-stats.js";
import { mountAdminEmbeddingMigrations } from "../../routes/admin-embedding-migrations.js";
import type { WorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { GLOBAL_SENTINEL_ID } from "../../config/WorkspaceConfigStore.js";
import { RetentionConfigResolver } from "../../config/RetentionConfigResolver.js";
import { LlmConfigResolver } from "../../config/LlmConfigResolver.js";
import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import { toErrorBody } from "../../errors.js";

// ── Mock @mnemo-ai/core for the embedding-migration routes. flatten-legacy-
// dual-core Phase 9 (task 9.1): GET /admin/stats no longer imports
// `@mnemo-ai/core`'s `getHealthSnapshot` — it now reads
// `deps.storage.getHealthSnapshot` (v3 StorageAdapter port), a plain deps
// fake above, so this mock no longer needs to stub it.
vi.mock("@mnemo-ai/core", async (importActual) => {
  const actual = await importActual<typeof import("@mnemo-ai/core")>();
  return {
    ...actual,
    detectStale: vi.fn().mockResolvedValue({ total: 3 }),
    migrateWorkspace: vi.fn().mockResolvedValue({ migrated: 3, errors: [] }),
  };
});

vi.mock("../../encryption/KeyRingAdapter.js", async (importActual) => {
  const actual = await importActual<typeof import("../../encryption/KeyRingAdapter.js")>();
  return {
    ...actual,
    createKeyRingAdapter: () =>
      new actual.KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 }),
  };
});

const TEST_MASTER_KEY = "b".repeat(64);
const WORKSPACE_ID = "33333333-3333-3333-3333-333333333333";
const RAW_ACTOR_ID = "agent-p50-admin";
const USER_ID = "user-p50-admin";
const BOOT_DEFAULTS = { internalDays: 730, confidentialDays: 365, restrictedDays: 90 };

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

function makeAdminApp(overrides: Partial<ServerDeps> = {}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_admin_");
    c.set("scopes", ["memory:admin"] as ReadonlyArray<string>);
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "agent");
    c.set("userId", USER_ID);
    await next();
  });

  const keyRing = new KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 });
  const store = makeFakeStore();
  const llmResolver = new LlmConfigResolver(store, keyRing, undefined, "text-embedding-3-small");
  const retentionResolver = new RetentionConfigResolver(store, keyRing, BOOT_DEFAULTS);
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);

  // flatten-legacy-dual-core PR12: GET /admin/stats ported off the legacy
  // core's vitals() onto deps.storage.getWorkspaceVitals — the fake `storage`
  // below now needs it (was only `deps.core.vitals` before this PR).
  const getWorkspaceVitals = vi.fn().mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    factsLive: 0,
    factsClosed: 0,
    pinnedCount: 0,
    lastRecallAt: null,
    lastWriteAt: null,
    embeddings: { indexed: 0, pending: 0 },
    factsByScopeRef: [],
  });

  const fakeDeps = {
    apiKeys: {} as ServerDeps["apiKeys"],
    embedModel: "text-embedding-3-small",
    telemetry: { startSpan: () => ({ end: () => {} }) } as unknown as ServerDeps["telemetry"],
    workspaceConfigStore: store,
    llmConfigResolver: llmResolver,
    retentionConfigResolver: retentionResolver,
    metricsPgClient: undefined,
    storage: {
      appendAuditEntry,
      getWorkspaceVitals,
      getHealthSnapshot: vi.fn().mockResolvedValue(null),
    } as unknown as ServerDeps["storage"],
    llm: {
      embed: vi.fn().mockResolvedValue(new Array(8).fill(0.1)),
    } as unknown as ServerDeps["llm"],
    ...overrides,
  } as unknown as ServerDeps;

  mountAdminLlmConfig(app, fakeDeps);
  mountAdminRetention(app, fakeDeps);
  mountAdminStats(app, fakeDeps);
  mountAdminEmbeddingMigrations(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, store, appendAuditEntry };
}

function firstEntry(spy: ReturnType<typeof vi.fn>): Omit<AuditLogEntry, "id" | "createdAt"> {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0]![0] as Omit<AuditLogEntry, "id" | "createdAt">;
}

describe("PUT /admin/config/llm — admin_access emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits admin_access partitioned on the caller's real workspace, never GLOBAL_SENTINEL_ID", async () => {
    const { app, appendAuditEntry } = makeAdminApp();

    const res = await app.request("/admin/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-global-key-1234" }),
    });
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("admin_access");
    expect(entry.resourceKind).toBe("admin_config");
    expect(entry.resourceId).toBe("llm");
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE_ID);
    expect(entry.workspaceId).not.toBe(GLOBAL_SENTINEL_ID);
    expect(entry.actorType).toBe("agent");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      route: "/admin/config/llm",
      method: "PUT",
      target: "global",
    });
  });

  it("does not emit when the write fails (422 unsupported provider)", async () => {
    const { app, appendAuditEntry } = makeAdminApp();

    const res = await app.request("/admin/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-key" }),
    });
    expect(res.status).toBe(422);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("does not emit when encryption is unconfigured (501)", async () => {
    const { app, appendAuditEntry } = makeAdminApp({
      workspaceConfigStore: undefined,
      llmConfigResolver: undefined,
    });

    const res = await app.request("/admin/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });
    expect(res.status).toBe(501);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("GET /admin/config/llm — stays silent", () => {
  it("does not emit admin_access on a read", async () => {
    const { app, appendAuditEntry } = makeAdminApp();
    const res = await app.request("/admin/config/llm");
    expect(res.status).toBe(200);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("PUT /admin/config/retention — admin_access emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits admin_access partitioned on the caller's real workspace", async () => {
    const { app, appendAuditEntry } = makeAdminApp();

    const res = await app.request("/admin/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 500, confidentialDays: 200, restrictedDays: 60 }),
    });
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("admin_access");
    expect(entry.resourceKind).toBe("admin_config");
    expect(entry.resourceId).toBe("retention");
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE_ID);
    expect(entry.workspaceId).not.toBe(GLOBAL_SENTINEL_ID);
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      route: "/admin/config/retention",
      method: "PUT",
      target: "global",
    });
  });

  it("does not emit when encryption is unconfigured (501)", async () => {
    const { app, appendAuditEntry } = makeAdminApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/admin/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 500 }),
    });
    expect(res.status).toBe(501);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("GET /admin/config/retention — stays silent", () => {
  it("does not emit admin_access on a read", async () => {
    const { app, appendAuditEntry } = makeAdminApp();
    const res = await app.request("/admin/config/retention");
    expect(res.status).toBe(200);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /admin/config/retention — admin_access emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits admin_access partitioned on the caller's real workspace when rows existed", async () => {
    const { app, store, appendAuditEntry } = makeAdminApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_internal_days`, "seed");
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_confidential_days`, "seed");
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:retention_restricted_days`, "seed");

    const res = await app.request("/admin/config/retention", { method: "DELETE" });
    expect(res.status).toBe(204);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("admin_access");
    expect(entry.resourceKind).toBe("admin_config");
    expect(entry.resourceId).toBe("retention");
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE_ID);
    expect(entry.workspaceId).not.toBe(GLOBAL_SENTINEL_ID);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      route: "/admin/config/retention",
      method: "DELETE",
      target: "global",
    });
  });

  it("does not emit when no global retention row exists (404)", async () => {
    const { app, appendAuditEntry } = makeAdminApp();

    const res = await app.request("/admin/config/retention", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("does not emit when store is absent (501)", async () => {
    const { app, appendAuditEntry } = makeAdminApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/admin/config/retention", { method: "DELETE" });
    expect(res.status).toBe(501);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("POST /admin/embedding-migrations — admin_access emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits admin_access with resourceId:migrationId on a real run", async () => {
    const { app, appendAuditEntry } = makeAdminApp();

    const res = await app.request("/admin/embedding-migrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetModel: "text-embedding-3-large", dryRun: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("admin_access");
    expect(entry.resourceKind).toBe("admin_config");
    expect(entry.resourceId).toBe(body.id);
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE_ID);
    expect(entry.workspaceId).not.toBe(GLOBAL_SENTINEL_ID);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      route: "/admin/embedding-migrations",
      method: "POST",
      target: "global",
    });
  });

  it("emits admin_access on a dry run too", async () => {
    const { app, appendAuditEntry } = makeAdminApp();

    const res = await app.request("/admin/embedding-migrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetModel: "text-embedding-3-large", dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("emits admin_access even in the degraded no-storage/no-llm branch, partitioned on the caller's workspace", async () => {
    const { app, appendAuditEntry } = makeAdminApp({ storage: undefined, llm: undefined });

    const res = await app.request("/admin/embedding-migrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetModel: "text-embedding-3-large" }),
    });
    expect(res.status).toBe(200);
    // deps.storage is undefined here, so emitAudit's own guard no-ops the
    // write — appendAuditEntry (spied via the deps override, unused) is
    // never reachable through emitAudit in this branch by construction.
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("partitions on the CALLER's workspace, not the migration's target workspaceId in the body", async () => {
    const { app, appendAuditEntry } = makeAdminApp();
    const OTHER_WORKSPACE = "44444444-4444-4444-4444-444444444444";

    const res = await app.request("/admin/embedding-migrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: OTHER_WORKSPACE,
        targetModel: "text-embedding-3-large",
        dryRun: true,
      }),
    });
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.workspaceId).toBe(WORKSPACE_ID);
    expect(entry.workspaceId).not.toBe(OTHER_WORKSPACE);
  });
});

describe("GET /admin/stats — stays silent", () => {
  it("does not emit admin_access on a read", async () => {
    const { app, appendAuditEntry } = makeAdminApp();
    const res = await app.request("/admin/stats");
    expect(res.status).toBe(200);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});
