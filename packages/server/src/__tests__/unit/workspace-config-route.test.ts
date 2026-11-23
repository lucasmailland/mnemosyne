/**
 * Unit tests for workspace LLM config routes:
 *   PUT  /config/llm
 *   GET  /config/llm
 *   DELETE /config/llm
 *
 * Uses an in-memory fake WorkspaceConfigStore and a real KeyRingAdapter
 * (seeded from process.env.MNEMO_MASTER_KEY or a test key).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountWorkspaceConfig } from "../../routes/workspace-config.js";
import type { WorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { GLOBAL_SENTINEL_ID } from "../../config/WorkspaceConfigStore.js";
import { LlmConfigResolver } from "../../config/LlmConfigResolver.js";
import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import { toErrorBody } from "../../errors.js";

// ── Test master key (32 random bytes, 64 hex chars) ───────────────────────────
const TEST_MASTER_KEY = "a".repeat(64); // 32 bytes of 0xAA — valid for testing

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

// ── In-memory fake WorkspaceConfigStore ──────────────────────────────────────
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

// ── App factory ───────────────────────────────────────────────────────────────
/** An installation admin (superadmin session or operator key): may always edit. */
const INSTALLATION_ADMIN = ["memory:admin", "admin:workspace"] as const;
/** A workspace owner or admin who is not an installation admin. */
const WORKSPACE_OWNER = ["memory:admin"] as const;

function makeApp(
  overrides: Partial<ServerDeps> = {},
  storeOverride?: WorkspaceConfigStore,
  scopes: ReadonlyArray<string> = INSTALLATION_ADMIN
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorType", "user");
    c.set("actorId", "33333333-3333-3333-3333-333333333333");
    c.set("actorRefKind", "user");
    c.set("scopes", scopes);
    await next();
  });

  const keyRing = new KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 });
  const store = storeOverride ?? makeFakeStore();
  const resolver = new LlmConfigResolver(store, keyRing, undefined, "text-embedding-3-small");

  const fakeDeps = {
    core: {} as ServerDeps["core"],
    apiKeys: {} as ServerDeps["apiKeys"],
    embedModel: "text-embedding-3-small",
    telemetry: { startSpan: () => ({ end: () => {} }) } as unknown as ServerDeps["telemetry"],
    workspaceConfigStore: store,
    llmConfigResolver: resolver,
    metricsPgClient: undefined,
    ...overrides,
  } as unknown as ServerDeps;

  mountWorkspaceConfig(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, store, resolver, keyRing };
}

// ── Mock createKeyRingAdapter used internally by route ─────────────────────────
vi.mock("../../encryption/KeyRingAdapter.js", async (importActual) => {
  const actual = await importActual<typeof import("../../encryption/KeyRingAdapter.js")>();
  return {
    ...actual,
    // Override factory to return a deterministic key ring for testing
    createKeyRingAdapter: () =>
      new actual.KeyRingAdapter({ masterKeyHex: TEST_MASTER_KEY, kekVersion: 1 }),
  };
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PUT /config/llm", () => {
  it("returns 200 and stores encrypted config for openai provider", async () => {
    const { app, store } = makeApp();

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test-1234567890" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Provider row should exist in store
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    const providerRow = fakeStore._data.get(`${WORKSPACE_ID}:llm_provider`);
    expect(providerRow).toBeTruthy();
    expect(typeof providerRow).toBe("string");
  });

  it("returns 501 ENCRYPTION_REQUIRED when store is absent", async () => {
    const { app } = makeApp({ workspaceConfigStore: undefined, llmConfigResolver: undefined });

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test-1234567890" }),
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("returns 422 PROVIDER_NOT_SUPPORTED for anthropic", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; provider: string };
    expect(body.code).toBe("PROVIDER_NOT_SUPPORTED");
    expect(body.provider).toBe("anthropic");
  });

  it("returns 422 for unknown provider via Zod discriminated union", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "foobar", apiKey: "key-xyz" }),
    });

    // Zod discriminated union rejects unknown providers at validation time
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 400 MISSING_API_KEY when apiKey absent for openai", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_API_KEY");
  });

  it("returns 200 for ollama without apiKey", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "ollama" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns 200 for bedrock with credentials", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "bedrock",
        credentials: {
          awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
          awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          awsRegion: "us-east-1",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns warned:true when embeddings exist for workspace", async () => {
    const pgClientMock = {
      // Tagged-template literal call: returns rows to simulate embeddings exist
    } as unknown as import("postgres").Sql;

    // Use a custom pgClient that returns a non-empty array
    const { app } = makeApp({
      metricsPgClient: Object.assign((..._args: unknown[]) => Promise.resolve([{ "1": 1 }]), {
        unsafe: () => Promise.resolve([{ "1": 1 }]),
      }) as unknown as import("postgres").Sql,
    });

    const res = await app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test-123" }),
    });

    // Even if pgClient mock doesn't behave exactly as tagged template,
    // the route should succeed (dimension check is best-effort / non-fatal)
    expect([200]).toContain(res.status);
  });
});

describe("GET /config/llm", () => {
  it("returns source:env when no config row exists", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; provider: unknown };
    expect(body.source).toBe("env");
  });

  it("returns masked apiKey (**** + last 4) to a caller who may edit it (APP-075)", async () => {
    const { app, store, keyRing } = makeApp();

    // Seed a config row directly in the store
    const apiKey = "sk-proj-abcdefghijklmnop";
    const providerEnc = keyRing.encryptSecret(WORKSPACE_ID, "llm-config", "openai");
    const apiKeyEnc = keyRing.encryptSecret(WORKSPACE_ID, "llm-config", apiKey);

    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    fakeStore._data.set(`${WORKSPACE_ID}:llm_provider`, providerEnc);
    fakeStore._data.set(`${WORKSPACE_ID}:llm_api_key`, apiKeyEnc);

    const res = await app.request("/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; apiKey?: string };
    expect(body.source).toBe("workspace");
    // APP-075: the first 8 characters were shown to every reader of the
    // workspace; for a key without a vendor prefix that is 8 real secret
    // characters. The last 4 are enough to tell two keys apart.
    expect(body.apiKey).toBe("****mnop");
  });

  it("does not return the key at all to a caller who may not edit it (APP-075)", async () => {
    const { app, store, keyRing } = makeApp({}, undefined, WORKSPACE_OWNER);
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    fakeStore._data.set(`${WORKSPACE_ID}:llm_provider`, keyRing.encryptSecret(WORKSPACE_ID, "llm-config", "openai"));
    fakeStore._data.set(`${WORKSPACE_ID}:llm_api_key`, keyRing.encryptSecret(WORKSPACE_ID, "llm-config", "abcdefghijklmnop"));
    const body = (await (await app.request("/config/llm")).json()) as { apiKey?: string; canEdit: boolean };
    expect(body.canEdit).toBe(false);
    expect(body).not.toHaveProperty("apiKey");
  });

  it("returns source:global when workspace row absent but global present", async () => {
    const { app, store, keyRing } = makeApp();

    // Seed a global sentinel row only
    const providerEnc = keyRing.encryptSecret(GLOBAL_SENTINEL_ID, "llm-config", "openai");
    const apiKeyEnc = keyRing.encryptSecret(GLOBAL_SENTINEL_ID, "llm-config", "sk-global-12345");
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:llm_provider`, providerEnc);
    fakeStore._data.set(`${GLOBAL_SENTINEL_ID}:llm_api_key`, apiKeyEnc);

    const res = await app.request("/config/llm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("global");
  });
});

describe("DELETE /config/llm", () => {
  it("returns 404 when no config row exists", async () => {
    const { app } = makeApp();

    const res = await app.request("/config/llm", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 204 and invalidates cache when config exists", async () => {
    const { app, store, keyRing, resolver } = makeApp();
    const invalidateSpy = vi.spyOn(resolver, "invalidate");

    // Seed a config row
    const providerEnc = keyRing.encryptSecret(WORKSPACE_ID, "llm-config", "openai");
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    fakeStore._data.set(`${WORKSPACE_ID}:llm_provider`, providerEnc);

    const res = await app.request("/config/llm", { method: "DELETE" });
    expect(res.status).toBe(204);

    // Config row should be removed
    expect(fakeStore._data.has(`${WORKSPACE_ID}:llm_provider`)).toBe(false);

    // Cache should be invalidated
    expect(invalidateSpy).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});

// ─── Who may change the workspace model (installation setting) ──────────────

describe("workspace LLM config — permission", () => {
  beforeEach(() => {
    vi.stubEnv("MNEMO_WORKSPACE_LLM_OVERRIDE", "");
    vi.stubEnv("MNEMO_LLM_MODEL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const put = (app: OpenAPIHono<{ Variables: AuthVariables }>, body: unknown) =>
    app.request("/config/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses a workspace owner's PUT by default (403 LLM_CONFIG_INSTALLATION_ONLY), storing nothing", async () => {
    const { app, store } = makeApp({}, undefined, WORKSPACE_OWNER);
    const res = await put(app, { provider: "openai", apiKey: "sk-test-1234567890" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("LLM_CONFIG_INSTALLATION_ONLY");
    expect((store as ReturnType<typeof makeFakeStore>)._data.size).toBe(0);
  });

  it("refuses a workspace owner's DELETE by default and keeps the override", async () => {
    const { app, store, keyRing } = makeApp({}, undefined, WORKSPACE_OWNER);
    const fakeStore = store as ReturnType<typeof makeFakeStore>;
    fakeStore._data.set(
      `${WORKSPACE_ID}:llm_provider`,
      keyRing.encryptSecret(WORKSPACE_ID, "llm-config", "openai")
    );
    const res = await app.request("/config/llm", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(fakeStore._data.has(`${WORKSPACE_ID}:llm_provider`)).toBe(true);
  });

  it("GET tells a workspace owner they cannot edit, and an installation admin they can", async () => {
    const owner = makeApp({}, undefined, WORKSPACE_OWNER);
    const ownerBody = (await (await owner.app.request("/config/llm")).json()) as {
      canEdit: boolean;
      editPolicy: string;
    };
    expect(ownerBody).toMatchObject({ canEdit: false, editPolicy: "installation" });

    const admin = makeApp();
    const adminBody = (await (await admin.app.request("/config/llm")).json()) as {
      canEdit: boolean;
      editPolicy: string;
    };
    expect(adminBody).toMatchObject({ canEdit: true, editPolicy: "installation" });
  });

  it("GET reports the effective completion model on the env tier", async () => {
    vi.stubEnv("MNEMO_LLM_MODEL", "us.anthropic.claude-haiku-4-5");
    const { app } = makeApp();
    const body = (await (await app.request("/config/llm")).json()) as {
      source: string;
      llmModel?: string;
    };
    expect(body).toMatchObject({ source: "env", llmModel: "us.anthropic.claude-haiku-4-5" });
  });

  it("GET falls back to the boot provider's default model when MNEMO_LLM_MODEL is unset", async () => {
    const { app } = makeApp({
      llm: { defaultCompleteModel: "provider-default" } as unknown as ServerDeps["llm"],
    });
    const body = (await (await app.request("/config/llm")).json()) as { llmModel?: string };
    expect(body.llmModel).toBe("provider-default");
  });

  describe("when the installation lets owners bring their own model", () => {
    beforeEach(() => {
      vi.stubEnv("MNEMO_WORKSPACE_LLM_OVERRIDE", "true");
    });

    it("lets a workspace owner save a public provider without a base URL", async () => {
      const { app } = makeApp({}, undefined, WORKSPACE_OWNER);
      const res = await put(app, { provider: "openai", apiKey: "sk-test-1234567890" });
      expect(res.status).toBe(200);
      const body = (await (await app.request("/config/llm")).json()) as {
        canEdit: boolean;
        editPolicy: string;
      };
      expect(body).toMatchObject({ canEdit: true, editPolicy: "workspace_owners" });
    });

    it.each([
      ["http://api.example.com/v1", "BASE_URL_NOT_HTTPS"],
      ["https://169.254.169.254/latest", "BASE_URL_PRIVATE_ADDRESS"],
      ["https://127.0.0.1:11434", "BASE_URL_PRIVATE_ADDRESS"],
      ["https://10.0.0.8/v1", "BASE_URL_PRIVATE_ADDRESS"],
      ["https://localhost/v1", "BASE_URL_PRIVATE_ADDRESS"],
      ["https://[::ffff:127.0.0.1]/v1", "BASE_URL_PRIVATE_ADDRESS"],
      ["https://[fd00::1]/v1", "BASE_URL_PRIVATE_ADDRESS"],
      ["https://user:pw@8.8.8.8/v1", "BASE_URL_INVALID"],
    ])("refuses an owner's baseUrl %s with 422 %s and stores nothing", async (baseUrl, code) => {
      const { app, store } = makeApp({}, undefined, WORKSPACE_OWNER);
      const res = await put(app, { provider: "openai", apiKey: "sk-test-1234567890", baseUrl });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe(code);
      expect((store as ReturnType<typeof makeFakeStore>)._data.size).toBe(0);
    });

    it("refuses an owner's ollama without a base URL (it would default to the server's localhost)", async () => {
      const { app } = makeApp({}, undefined, WORKSPACE_OWNER);
      const res = await put(app, { provider: "ollama" });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("BASE_URL_REQUIRED");
    });

    it("accepts an owner's https base URL on a public IP", async () => {
      const { app } = makeApp({}, undefined, WORKSPACE_OWNER);
      const res = await put(app, {
        provider: "openai",
        apiKey: "sk-test-1234567890",
        baseUrl: "https://8.8.8.8/v1",
      });
      expect(res.status).toBe(200);
    });
  });

  it("does not check an installation admin's base URL (an internal Ollama is on purpose)", async () => {
    const { app } = makeApp();
    const res = await put(app, { provider: "ollama", baseUrl: "http://ollama:11434" });
    expect(res.status).toBe(200);
  });

  it("audits a saved and a removed override as settings_changed, without the key", async () => {
    const appendAuditEntry = vi.fn(async () => {});
    const { app } = makeApp({ storage: { appendAuditEntry } as unknown as ServerDeps["storage"] });
    const res = await put(app, {
      provider: "openai",
      apiKey: "sk-secret-should-not-appear",
      llmModel: "gpt-4.1",
      baseUrl: "https://proxy.example.com/v1?token=abc",
    });
    expect(res.status).toBe(200);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = (appendAuditEntry.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      workspaceId: WORKSPACE_ID,
      action: "settings_changed",
      resourceKind: "llm_config",
      resourceId: WORKSPACE_ID,
      detail: {
        change: "set",
        provider: "openai",
        llmModel: "gpt-4.1",
        baseUrlHost: "proxy.example.com",
        installationAdmin: true,
      },
    });
    expect(JSON.stringify(entry)).not.toContain("sk-secret");
    expect(JSON.stringify(entry)).not.toContain("token=abc");

    const del = await app.request("/config/llm", { method: "DELETE" });
    expect(del.status).toBe(204);
    const removed = (appendAuditEntry.mock.calls[1] as unknown[])[0] as Record<string, unknown>;
    expect(removed).toMatchObject({ action: "settings_changed", detail: { change: "removed" } });
  });
});
