/**
 * Unit tests for admin global LLM config routes:
 *   PUT  /admin/config/llm
 *   GET  /admin/config/llm
 *
 * Uses in-memory fakes — no real DB, no real KMS.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountAdminLlmConfig } from "../../routes/admin-llm-config.js";
import type { WorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { GLOBAL_SENTINEL_ID } from "../../config/WorkspaceConfigStore.js";
import { LlmConfigResolver } from "../../config/LlmConfigResolver.js";
import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import { toErrorBody } from "../../errors.js";

const TEST_MASTER_KEY = "b".repeat(64);
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

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

// Mock createKeyRingAdapter to use the test master key
vi.mock("../../encryption/KeyRingAdapter.js", async (importActual) => {
  const actual = await importActual<typeof import("../../encryption/KeyRingAdapter.js")>();
  return {
    ...actual,
    createKeyRingAdapter: () =>
      new actual.KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 }),
  };
});

function makeAdminApp(overrides: Partial<ServerDeps> = {}, storeOverride?: WorkspaceConfigStore) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["memory:admin"] as ReadonlyArray<string>);
    // p50-audit-log-emitters PR6: admin routes now call resolveProvenance(c)
    // on the success path before emitting `admin_access` — actorId must be
    // present or resolveProvenance() throws.
    c.set("actorId", "admin-test-actor");
    c.set("actorType", "agent");
    await next();
  });

  const keyRing = new KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 });
  const store = storeOverride ?? makeFakeStore();
  const resolver = new LlmConfigResolver(store, keyRing, undefined, "text-embedding-3-small");

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
      }),
    } as unknown as ServerDeps["core"],
    apiKeys: {} as ServerDeps["apiKeys"],
    embedModel: "text-embedding-3-small",
    telemetry: { startSpan: () => ({ end: () => {} }) } as unknown as ServerDeps["telemetry"],
    workspaceConfigStore: store,
    llmConfigResolver: resolver,
    metricsPgClient: undefined,
    ...overrides,
  } as unknown as ServerDeps;

  // flatten-legacy-dual-core Phase 9 (task 9.1): this file never exercises
  // GET /admin/stats (confirmed — no route request in this file), so the
  // `vi.mock("@mnemo-ai/core")` that used to stub `getHealthSnapshot` here
  // to avoid a real DB tx was already dead code even before this port;
  // removed rather than migrated.
  mountAdminLlmConfig(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, store, resolver, keyRing };
}

describe("PUT /admin/config/llm", () => {
  it("stores global config at GLOBAL_SENTINEL_ID", async () => {
    const { app, store } = makeAdminApp();

    const res = await app.request("/admin/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-global-key-1234" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    const providerRow = fakeStore._data.get(`${GLOBAL_SENTINEL_ID}:llm_provider`);
    expect(providerRow).toBeTruthy();
  });

  it("returns 501 when store absent", async () => {
    const { app } = makeAdminApp({ workspaceConfigStore: undefined, llmConfigResolver: undefined });

    const res = await app.request("/admin/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });

    expect(res.status).toBe(501);
  });

  it("returns 422 for anthropic (no embeddings API)", async () => {
    const { app } = makeAdminApp();

    const res = await app.request("/admin/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-key" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("PROVIDER_NOT_SUPPORTED");
  });
});

describe("GET /admin/config/llm", () => {
  it("returns source:env when no global config exists", async () => {
    const { app } = makeAdminApp();

    const res = await app.request("/admin/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; provider: unknown };
    expect(body.source).toBe("env");
  });

  it("returns global config with masked key", async () => {
    const { app, store, keyRing } = makeAdminApp();
    const fakeStore = store as ReturnType<typeof makeFakeStore>;

    const providerEnc = keyRing.encryptSecret(GLOBAL_SENTINEL_ID, "llm-config", "openai");
    const apiKeyEnc = keyRing.encryptSecret(GLOBAL_SENTINEL_ID, "llm-config", "sk-global-key-xyz");
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:llm_provider`, providerEnc);
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:llm_api_key`, apiKeyEnc);

    const res = await app.request("/admin/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; provider: string; apiKey?: string };
    expect(body.source).toBe("global");
    expect(body.provider).toBe("openai");
    // APP-075: masked to the last 4 characters.
    expect(body.apiKey).toBe("****-xyz");
  });
});
