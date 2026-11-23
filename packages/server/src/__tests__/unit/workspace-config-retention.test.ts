/**
 * Unit tests for workspace retention config routes:
 *   PUT    /config/retention
 *   GET    /config/retention
 *   DELETE /config/retention
 *
 * Uses an in-memory fake WorkspaceConfigStore and a real KeyRingAdapter
 * (seeded from a test key).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountRetentionConfig } from "../../routes/workspace-config.js";
import type { WorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { RetentionConfigResolver } from "../../config/RetentionConfigResolver.js";
import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import { toErrorBody } from "../../errors.js";

// ─── Test master key ──────────────────────────────────────────────────────────

const TEST_MASTER_KEY = "b".repeat(64); // 32 bytes of 0xBB — valid for testing

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

// ─── App factory ─────────────────────────────────────────────────────────────

function makeApp(overrides: Partial<ServerDeps> = {}, storeOverride?: WorkspaceConfigStore) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["memory:admin"] as ReadonlyArray<string>);
    await next();
  });

  const keyRing = new KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 });
  const store = storeOverride ?? makeFakeStore();
  const resolver = new RetentionConfigResolver(store, keyRing, BOOT_DEFAULTS);

  const fakeDeps = {
    core: {} as ServerDeps["core"],
    apiKeys: {} as ServerDeps["apiKeys"],
    embedModel: "text-embedding-3-small",
    telemetry: { startSpan: () => ({ end: () => {} }) } as unknown as ServerDeps["telemetry"],
    workspaceConfigStore: store,
    retentionConfigResolver: resolver,
    ...overrides,
  } as unknown as ServerDeps;

  mountRetentionConfig(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, store, resolver, keyRing };
}

// ─── Mock createKeyRingAdapter used internally by route ───────────────────────

vi.mock("../../encryption/KeyRingAdapter.js", async (importActual) => {
  const actual = await importActual<typeof import("../../encryption/KeyRingAdapter.js")>();
  return {
    ...actual,
    createKeyRingAdapter: () =>
      new actual.KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 }),
  };
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PUT /config/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. PUT → 200 { ok: true }
  it("returns 200 { ok: true } and stores encrypted values", async () => {
    const { app, store } = makeApp();

    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 365, confidentialDays: 180, restrictedDays: 30 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Rows should be stored in the store
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_internal_days`)).toBe(true);
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_confidential_days`)).toBe(true);
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_restricted_days`)).toBe(true);
  });

  // 2. PUT → 501 when deps.workspaceConfigStore is undefined
  it("returns 501 ENCRYPTION_REQUIRED when store is absent", async () => {
    const { app } = makeApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 365 }),
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  // 3. PUT with internalDays < 1 → 400 (Zod validation)
  it("returns 400 when internalDays is 0 (below min:1)", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 0 }),
    });

    expect(res.status).toBe(400);
  });

  // 4. PUT with internalDays > 36500 → 400 (Zod validation)
  it("returns 400 when internalDays exceeds max:36500", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ internalDays: 36501 }),
    });

    expect(res.status).toBe(400);
  });

  // 5. Partial PUT — only sets provided keys
  it("only stores provided keys (partial update)", async () => {
    const { app, store } = makeApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restrictedDays: 45 }),
    });

    expect(res.status).toBe(200);
    // Only restrictedDays should be stored
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_restricted_days`)).toBe(true);
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_internal_days`)).toBe(false);
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_confidential_days`)).toBe(false);
  });
});

describe("GET /config/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 4. GET /config/retention → 200 with resolved values
  it("returns 200 with resolved values and source field", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/retention");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      internalDays: number;
      confidentialDays: number;
      restrictedDays: number;
      source: string;
    };
    expect(typeof body.internalDays).toBe("number");
    expect(typeof body.confidentialDays).toBe("number");
    expect(typeof body.restrictedDays).toBe("number");
    expect(["workspace", "global", "env"]).toContain(body.source);
  });

  it("returns source:env when no store / resolver configured", async () => {
    const { app } = makeApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; internalDays: number };
    expect(body.source).toBe("env");
    expect(body.internalDays).toBe(730); // BOOT default
  });

  it("returns source:workspace when workspace config exists", async () => {
    const { app, store, keyRing } = makeApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    // Seed workspace rows
    const enc = (v: string) => keyRing.encryptSecret(WORKSPACE_ID, "retention-config", v);
    fakeStore._data.set(`${WORKSPACE_ID}:retention_internal_days`, enc("200"));
    fakeStore._data.set(`${WORKSPACE_ID}:retention_confidential_days`, enc("100"));
    fakeStore._data.set(`${WORKSPACE_ID}:retention_restricted_days`, enc("30"));

    const res = await app.request("/config/retention");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; internalDays: number };
    expect(body.source).toBe("workspace");
    expect(body.internalDays).toBe(200);
  });
});

describe("DELETE /config/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 5. DELETE → 204 when row exists
  it("returns 204 when retention row exists and deletes all keys", async () => {
    const { app, store, keyRing } = makeApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    // Seed a retention row
    const enc = keyRing.encryptSecret(WORKSPACE_ID, "retention-config", "365");
    fakeStore._data.set(`${WORKSPACE_ID}:retention_internal_days`, enc);

    const res = await app.request("/config/retention", { method: "DELETE" });
    expect(res.status).toBe(204);

    // Rows should be removed
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_internal_days`)).toBe(false);
  });

  // 6. DELETE → 404 when no row exists
  it("returns 404 when no retention row exists", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/retention", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 501 when store is absent", async () => {
    const { app } = makeApp({
      workspaceConfigStore: undefined,
      retentionConfigResolver: undefined,
    });

    const res = await app.request("/config/retention", { method: "DELETE" });
    expect(res.status).toBe(501);
  });
});

describe("managed transcript retention over HTTP", () => {
  it("stores transcriptDays encrypted like every other window", async () => {
    const { app, store } = makeApp();

    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcriptDays: 7 }),
    });

    expect(res.status).toBe(200);
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    expect(fakeStore._data.has(`${WORKSPACE_ID}:retention_transcript_days`)).toBe(true);
    // Never the plaintext number: the window is stored through the key ring.
    expect(String(fakeStore._data.get(`${WORKSPACE_ID}:retention_transcript_days`))).not.toBe("7");
  });

  it("rejects a window that would purge transcripts on sight", async () => {
    const { app } = makeApp();
    const res = await app.request("/config/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcriptDays: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("reports the resolved window on read", async () => {
    const { app } = makeApp();
    const res = await app.request("/config/retention");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transcriptDays: 30 });
  });
});
