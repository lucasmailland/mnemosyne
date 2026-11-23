/**
 * P157 — which model a workspace's completions reach, proven end to end under
 * the non-superuser app role (`mnemo_app`, NOSUPERUSER NOBYPASSRLS, FORCE RLS).
 *
 * With MNEMO_MASTER_KEY set, `session.ts`'s collapse (and capture, the conflict
 * validator, anticipation) resolve their LLM through `LlmConfigResolver` +
 * `buildWorkspaceLlmAdapter`. With no DB config, that resolved to the boot
 * EMBEDDING provider on its built-in default model: Ollama `llama3.3`, which
 * the evaluation stack did not have, so every collapse answered 503 MNEMO_004
 * (LIFECYCLE-1, CHAOS-6) and no episode ever formed (AGENTSIM-2).
 *
 * The providers below are built the way `index.ts` builds them: a keyless
 * Ollama completion provider wrapped by `createLlmAdapter` with the configured
 * model (MNEMO_LLM_PROVIDER/MNEMO_LLM_MODEL), and a separate keyless Ollama
 * embedding provider (MNEMO_EMBED_PROVIDER). Each points at its own fake
 * Ollama, so the test can see which one a collapse reached and what it sent.
 *
 * Requires Docker (testcontainers) and Node 22 (see CLAUDE.md).
 */
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheAdapter, EmbedAdapter, LLMAdapter } from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { LLMProviderLike, ServerDeps } from "../../deps.js";
import { LlmConfigResolver } from "../../config/LlmConfigResolver.js";
import { buildWorkspaceLlmAdapter } from "../../config/WorkspaceLlmAdapter.js";
import { GLOBAL_SENTINEL_ID, PgWorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { createKeyRingAdapter } from "../../encryption/KeyRingAdapter.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test";

const WS = "c1390001-0001-4001-8001-000000000001";
const WS_B = "c1390002-0002-4002-8002-000000000002";
const KEY = "mns_live_llmresolvernonsuperuser01";

/** MNEMO_LLM_MODEL in this deployment. */
const CONFIGURED_MODEL = "mnemo-test-llm";
// A width the schema has a vector table for.
const DIMS = 1024;

// ── Fake Ollama ────────────────────────────────────────────────────────────

interface SeenRequest {
  path: string;
  body: Record<string, unknown>;
}

const SUMMARY = {
  goal: "settle the deploy window",
  outcome: "resolved",
  facts: [
    {
      content: "ledger-api deploys only on Tuesdays",
      topicKey: "ledger-api-deploy-day",
      confidence: 0.9,
    },
  ],
  decisions: [],
  strategies: [],
};

/**
 * Answers /api/generate only for the models it "has" — like a real Ollama,
 * anything else is `404 model '<name>' not found`.
 */
async function startFakeOllama(
  models: string[]
): Promise<{ url: string; seen: SeenRequest[]; server: Server }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      seen.push({ path: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/embed") {
        const input = (body.input as string[]) ?? [];
        res.end(
          JSON.stringify({ embeddings: input.map(() => Array.from({ length: DIMS }, () => 0.1)) })
        );
        return;
      }
      if (req.url === "/api/generate" && models.includes(String(body.model))) {
        res.end(
          JSON.stringify({
            response: JSON.stringify(SUMMARY),
            done: true,
            done_reason: "stop",
            prompt_eval_count: 10,
            eval_count: 10,
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `model '${String(body.model)}' not found` }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, server };
}

function generateCalls(seen: SeenRequest[]): SeenRequest[] {
  return seen.filter((r) => r.path === "/api/generate");
}

// ── Doubles the collapse route needs ───────────────────────────────────────

// Same vector for every text: the RecMem gate scores 1.0 and never skips.
const fakeEmbed: EmbedAdapter = {
  id: "fake-embed",
  model: "fake-model",
  dimensions: DIMS,
  async embed(texts: string[]) {
    return texts.map(
      () => new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)))
    );
  },
  async embedSingle() {
    return new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)));
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

// The Redis-degradation gate on /session/* needs a cache that answers.
class FakeCache implements CacheAdapter {
  readonly id = "fake-cache";
  readonly capabilities = {
    sortedSets: false,
    pubSub: false,
    patterns: true,
    atomic: true,
    hashes: false,
  };
  store = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const v = this.store.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

// ── Setup ──────────────────────────────────────────────────────────────────

let container: StartedTestContainer;
let superUrl: string;
let appUrl: string;
let superSql: postgres.Sql;
/** One connection, so a GUC left behind by one transaction is seen by the next. */
let configSql: postgres.Sql;
let apiKeyClose: (() => Promise<void>) | undefined;
let llmOllama: Awaited<ReturnType<typeof startFakeOllama>>;
let embedOllama: Awaited<ReturnType<typeof startFakeOllama>>;
let resolver: LlmConfigResolver;
let bootAdapter: LLMAdapter;
let embedProvider: LLMProviderLike;
let configStore: PgWorkspaceConfigStore;
/** MNEMO_MASTER_KEY set: the resolver is wired. */
let appWithResolver: ReturnType<typeof createApp>;
/** MNEMO_MASTER_KEY unset: no resolver, routes use the boot adapter directly. */
let appWithoutResolver: ReturnType<typeof createApp>;
const savedMasterKey = process.env.MNEMO_MASTER_KEY;

function authed(): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

beforeAll(async () => {
  process.env.MNEMO_MASTER_KEY = "ab".repeat(32);

  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;
  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;

  superSql = postgres(superUrl, { max: 2, onnotice: () => void 0 });
  await superSql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // Same grants as docker/scripts/provision-app-role.mjs (and boot-nonsuperuser).
  await superSql.unsafe(`
    DO $provision$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
        CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $provision$;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT app_user       TO ${APP_USER};
    GRANT app_org_user   TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public    TO ${APP_USER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public    TO app_user;
  `);
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  await superSql`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_llm_resolver_01"}, ${WS}, ${keyHash}, ${"llm-resolver"}, ${"llm-resolver"},
            ARRAY['memory:read','memory:write','memory:admin','admin:workspace']::text[])
  `;
  // admin:workspace: an installation admin's key. Only installation admins may
  // set a workspace's model by default, and only they may point it at a
  // local endpoint like the fake Ollamas below.

  // Two fake Ollamas: the completion host has the configured model; the
  // embedding host has no completion model at all (like bge-m3 only).
  llmOllama = await startFakeOllama([CONFIGURED_MODEL, "workspace-llm"]);
  embedOllama = await startFakeOllama([]);

  const [adapterPgMod, adapterVectorMod, v3CoreMod, providersMod, adapterLlmMod, coreMod] =
    await Promise.all([
      import("@mnemo-ai/adapter-postgres"),
      import("@mnemo-ai/adapter-vector"),
      import("@mnemo-ai/core/cognitive"),
      import("@mnemo-ai/llm-providers"),
      import("@mnemo-ai/adapter-llm"),
      import("@mnemo-ai/core"),
    ]);

  // index.ts: MNEMO_LLM_PROVIDER=ollama (no key) + MNEMO_LLM_MODEL → collapseLlmAdapter.
  const llm = providersMod.createProvider({ provider: "ollama", baseURL: llmOllama.url });
  bootAdapter = adapterLlmMod.createLlmAdapter(llm, { model: CONFIGURED_MODEL });
  // index.ts: MNEMO_EMBED_PROVIDER=ollama (no key) → embedProvider.
  embedProvider = providersMod.createProvider({
    provider: "ollama",
    baseURL: embedOllama.url,
    timeoutMs: 3000,
  }) as unknown as LLMProviderLike;

  const { db, pgClient } = adapterPgMod.createDrizzleClient(appUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient, undefined);
  const vector = new adapterVectorMod.PgVectorAdapter({
    connectionString: appUrl,
    dimensions: DIMS,
  });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopTelemetry = {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outbox: import("@mnemo-ai/types").OutboxAdapter = {
    append: (e) => storage.appendOutbox(e),
    claimBatch: (n) => storage.claimOutbox(n),
    markProcessed: (ids) => storage.markOutboxProcessed(ids),
    markFailed: (id, err) => storage.markOutboxFailed(id, err),
    getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
  };
  const cache = new FakeCache();
  const cognitive = v3CoreMod.createCore({
    storage,
    vector,
    embed: fakeEmbed,
    outbox,
    llm: bootAdapter,
    cache,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyClose = apiKeys.close;

  configSql = postgres(appUrl, { max: 1, onnotice: () => void 0 });
  configStore = new PgWorkspaceConfigStore(configSql);
  resolver = new LlmConfigResolver(configStore, createKeyRingAdapter(), embedProvider, "bge-m3");

  const baseDeps = {
    cognitive,
    storage,
    apiKeys,
    llm: embedProvider,
    embedModel: "bge-m3",
    cache,
    telemetry: noopTelemetry,
    llmAdapter: bootAdapter,
  };
  appWithResolver = createApp({
    deps: {
      ...baseDeps,
      llmConfigResolver: resolver,
      workspaceConfigStore: configStore,
    } as unknown as ServerDeps,
    version: "llm-resolver-test",
  });
  appWithoutResolver = createApp({
    deps: baseDeps as unknown as ServerDeps,
    version: "llm-resolver-test",
  });
}, 180_000);

afterAll(async () => {
  if (savedMasterKey === undefined) delete process.env.MNEMO_MASTER_KEY;
  else process.env.MNEMO_MASTER_KEY = savedMasterKey;
  await configSql?.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await apiKeyClose?.().catch(() => void 0);
  llmOllama?.server.close();
  embedOllama?.server.close();
  await container?.stop().catch(() => void 0);
});

beforeEach(() => {
  llmOllama.seen.length = 0;
  embedOllama.seen.length = 0;
});

/** Start a session, write one fact by hand into it, append 3 turns. */
async function sessionReadyToCollapse(
  app: ReturnType<typeof createApp>,
  tag: string
): Promise<string> {
  const start = await app.request("/session/start", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ agentId: `agent-${tag}` }),
  });
  expect(start.status).toBe(201);
  const { id: sessionId } = (await start.json()) as { id: string };

  const remember = await app.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ statement: `hand-written note for ${tag}`, sessionId }),
  });
  expect(remember.status).toBe(201);

  for (let i = 0; i < 3; i++) {
    const turn = await app.request(`/session/${sessionId}/turn`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${tag}: ledger-api should deploy on Tuesdays only (turn ${i})`,
      }),
    });
    expect(turn.status).toBe(204);
  }
  return sessionId;
}

async function collapse(app: ReturnType<typeof createApp>, sessionId: string): Promise<Response> {
  return app.request(`/session/${sessionId}/collapse`, {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ strategy: "explicit" }),
  });
}

describe("collapse reaches MNEMO_LLM_MODEL, not the embedding provider's default (P157)", () => {
  it("with MNEMO_MASTER_KEY and no workspace config: collapses, forms the episode, links the session's facts", async () => {
    const sessionId = await sessionReadyToCollapse(appWithResolver, "with-resolver");

    const res = await collapse(appWithResolver, sessionId);
    const body = (await res.json()) as Record<string, unknown>;
    expect({ status: res.status, body }).toMatchObject({ status: 202, body: { accepted: true } });

    // The completion host got the configured model, with thinking off (P154).
    const calls = generateCalls(llmOllama.seen);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.body.model === CONFIGURED_MODEL)).toBe(true);
    expect(calls.every((c) => c.body.think === false)).toBe(true);
    // The embedding host was never asked to complete (it used to get `llama3.3`).
    expect(generateCalls(embedOllama.seen)).toEqual([]);

    // AGENTSIM-2: the episode exists and owns the hand-written fact.
    const [session] =
      await superSql`SELECT status FROM mnemosyne.mnemo_session WHERE id = ${sessionId}`;
    expect(session?.status).toBe("collapsed");
    const episodes = await superSql`
      SELECT id FROM mnemosyne.mnemo_episode
      WHERE workspace_id = ${WS} AND source_conversation_id = ${sessionId}
    `;
    expect(episodes.length).toBe(1);
    const facts = await superSql`
      SELECT statement, episode_id FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND session_id = ${sessionId}
    `;
    const handWritten = facts.find((f) => f.statement === "hand-written note for with-resolver");
    expect(handWritten?.episode_id).toBe(episodes[0]?.id);
  });

  it("without MNEMO_MASTER_KEY (no resolver): unchanged, the boot adapter answers", async () => {
    const sessionId = await sessionReadyToCollapse(appWithoutResolver, "without-resolver");

    const res = await collapse(appWithoutResolver, sessionId);
    expect(res.status).toBe(202);

    const calls = generateCalls(llmOllama.seen);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.body.model === CONFIGURED_MODEL)).toBe(true);
    expect(generateCalls(embedOllama.seen)).toEqual([]);
  });
});

// ── LIFECYCLE-2 ─────────────────────────────────────────────────────────────
// PgWorkspaceConfigStore queried mnemo_workspace_config on a bare pooled
// connection. Its FORCE RLS policy casts the `mnemosyne.workspace_id` GUC to
// uuid: unset, writes violate the policy; left as '' by an earlier
// transaction on the same connection, every statement throws `invalid input
// syntax for type uuid: ""`. GET/PUT /config/llm answered 500, and the
// resolver's DB tiers failed in silence.

describe("workspace LLM config under FORCE RLS as mnemo_app (LIFECYCLE-2)", () => {
  it("writes, reads and deletes per workspace and the global row on a recycled connection", async () => {
    const store = new PgWorkspaceConfigStore(configSql);
    // What any pooled connection looks like after one workspace transaction.
    await configSql.begin((tx) => tx`SELECT set_config('mnemosyne.workspace_id', ${WS}, true)`);

    await store.set(WS, "temperature", "blob-a", "test");
    await store.set(WS_B, "temperature", "blob-b", "test");
    await store.set(GLOBAL_SENTINEL_ID, "temperature", "blob-global", "test");
    expect(await store.get(WS, "temperature")).toBe("blob-a");
    expect(await store.get(WS_B, "temperature")).toBe("blob-b");
    expect(await store.get(GLOBAL_SENTINEL_ID, "temperature")).toBe("blob-global");

    await store.set(WS, "temperature", "blob-a2", "test");
    expect(await store.get(WS, "temperature")).toBe("blob-a2");
    await store.delete(WS, "temperature");
    expect(await store.get(WS, "temperature")).toBeNull();
    expect(await store.get(WS_B, "temperature")).toBe("blob-b");

    // The workspace context stays inside each statement's transaction.
    const [row] = await configSql`SELECT current_setting('mnemosyne.workspace_id', true) AS guc`;
    expect(row?.guc ?? "").toBe("");

    await store.delete(WS_B, "temperature");
    await store.delete(GLOBAL_SENTINEL_ID, "temperature");
  });

  it("serves PUT, GET and DELETE /config/llm, and the workspace override reaches collapse", async () => {
    const put = await appWithResolver.request("/config/llm", {
      method: "PUT",
      headers: authed(),
      body: JSON.stringify({
        provider: "ollama",
        llmModel: "workspace-llm",
        embedModel: "workspace-embed",
        baseUrl: llmOllama.url,
      }),
    });
    expect(put.status).toBe(200);

    const get = await appWithResolver.request("/config/llm", { headers: authed() });
    expect(get.status).toBe(200);
    // embedModel only reads back if the stored row decrypts (the env one is bge-m3).
    expect(await get.json()).toMatchObject({
      provider: "ollama",
      embedModel: "workspace-embed",
      source: "workspace",
    });

    // The workspace's own model wins over MNEMO_LLM_MODEL.
    const sessionId = await sessionReadyToCollapse(appWithResolver, "workspace-config");
    expect((await collapse(appWithResolver, sessionId)).status).toBe(202);
    const calls = generateCalls(llmOllama.seen);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.body.model === "workspace-llm")).toBe(true);

    const del = await appWithResolver.request("/config/llm", {
      method: "DELETE",
      headers: authed(),
    });
    expect(del.status).toBe(204);
    const after = await appWithResolver.request("/config/llm", { headers: authed() });
    expect(await after.json()).toMatchObject({ source: "env" });
  });
});

// ── Review round: a configuration is one unit ───────────────────────────────
// Once stored config decrypts and takes effect, two lifecycle defects become
// live. (1) PUT wrote each key in its own transaction and the resolver read
// each key in its own transaction, so a cold resolve during a rotation could
// pair the NEW api key with the OLD endpoint. (2) DELETE removed five of the
// ten keys, so a later PUT without `baseUrl` resurrected the old proxy URL
// and sent the new key and the prompts there.
//
// OpenAI-compatible endpoints here are fake hosts: fetch is stubbed for any
// URL that is not this machine, so the test records where each request would
// have gone, and with which key, without leaving the process.

interface Outbound {
  url: string;
  authorization: string | null;
}

const outbound: Outbound[] = [];
const realFetch = globalThis.fetch;
/** OpenAIProvider's own base URL, used when the config sets no baseUrl. */
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

function stubRemoteFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    outbound.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        model: "gpt-test",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
}

async function putOpenAiConfig(apiKey: string, baseUrl?: string): Promise<void> {
  const res = await appWithResolver.request("/config/llm", {
    method: "PUT",
    headers: authed(),
    body: JSON.stringify({
      provider: "openai",
      apiKey,
      llmModel: "gpt-test",
      ...(baseUrl ? { baseUrl } : {}),
    }),
  });
  expect(res.status).toBe(200);
}

/** A resolver that never serves from cache: every call reads the DB. */
function coldResolver(store: PgWorkspaceConfigStore = configStore): LlmConfigResolver {
  const saved = process.env.MNEMO_LLM_CONFIG_TTL_SECONDS;
  process.env.MNEMO_LLM_CONFIG_TTL_SECONDS = "0";
  try {
    return new LlmConfigResolver(store, createKeyRingAdapter(), embedProvider, "bge-m3");
  } finally {
    if (saved === undefined) delete process.env.MNEMO_LLM_CONFIG_TTL_SECONDS;
    else process.env.MNEMO_LLM_CONFIG_TTL_SECONDS = saved;
  }
}

async function completeOnce(r: LlmConfigResolver): Promise<void> {
  const adapter = await buildWorkspaceLlmAdapter(WS, r, bootAdapter);
  await adapter!.generate({ messages: [{ role: "user", content: "ping" }] });
}

describe("workspace LLM config lifecycle is atomic (review round)", () => {
  beforeEach(() => {
    outbound.length = 0;
    stubRemoteFetch();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await appWithResolver.request("/config/llm", { method: "DELETE", headers: authed() });
  });

  it("never pairs a rotated api key with the other endpoint while resolves run concurrently", async () => {
    const endpoints = [
      { apiKey: "sk-rotation-key-a", baseUrl: "http://proxy-a.invalid/v1" },
      { apiKey: "sk-rotation-key-b", baseUrl: "http://proxy-b.invalid/v1" },
    ];
    // Readers on their own multi-connection pool, as in production, so their
    // reads really run while the writer's statements commit.
    const readerSql = postgres(appUrl, { max: 10, onnotice: () => void 0 });
    const cold = coldResolver(new PgWorkspaceConfigStore(readerSql));
    await putOpenAiConfig(endpoints[0]!.apiKey, endpoints[0]!.baseUrl);

    const ROUNDS = 20;
    const READERS = 6;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const next = endpoints[(round + 1) % 2]!;
        await Promise.all([
          putOpenAiConfig(next.apiKey, next.baseUrl),
          ...Array.from({ length: READERS }, () => completeOnce(cold)),
        ]);
      }
    } finally {
      await readerSql.end();
    }

    expect(outbound).toHaveLength(ROUNDS * READERS);
    const mismatched = outbound.filter((o) => {
      const endpoint = endpoints.find((e) => o.url.startsWith(e.baseUrl));
      return !endpoint || o.authorization !== `Bearer ${endpoint.apiKey}`;
    });
    expect(mismatched).toEqual([]);
  });

  it("DELETE then a PUT without baseUrl does not resurrect the old proxy", async () => {
    await putOpenAiConfig("sk-old-key-for-proxy", "http://old-proxy.invalid/v1");
    const del = await appWithResolver.request("/config/llm", {
      method: "DELETE",
      headers: authed(),
    });
    expect(del.status).toBe(204);
    await putOpenAiConfig("sk-new-key-direct");

    await completeOnce(coldResolver());

    expect(outbound).toEqual([
      { url: `${OPENAI_DEFAULT_BASE}/chat/completions`, authorization: "Bearer sk-new-key-direct" },
    ]);
  });

  it("a PUT without baseUrl over an existing config drops the old proxy too", async () => {
    await putOpenAiConfig("sk-old-key-for-proxy", "http://old-proxy.invalid/v1");
    await putOpenAiConfig("sk-new-key-direct");

    await completeOnce(coldResolver());

    expect(outbound.map((o) => o.url)).toEqual([`${OPENAI_DEFAULT_BASE}/chat/completions`]);
  });

  it("DELETE /config/llm keeps the workspace's retention settings", async () => {
    // Retention windows live in the same table, under their own keys.
    await configStore.set(WS, "retention_internal_days", "retention-blob", "test");
    await putOpenAiConfig("sk-some-key", "http://proxy.invalid/v1");

    const del = await appWithResolver.request("/config/llm", {
      method: "DELETE",
      headers: authed(),
    });
    expect(del.status).toBe(204);

    const rows = await superSql`
      SELECT key FROM mnemosyne.mnemo_workspace_config WHERE workspace_id = ${WS} ORDER BY key
    `;
    expect(rows.map((r) => r.key)).toEqual(["retention_internal_days"]);
    await configStore.delete(WS, "retention_internal_days");
  });
});
