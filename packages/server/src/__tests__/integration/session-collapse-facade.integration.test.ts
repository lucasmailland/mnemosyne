/**
 * flatten-legacy-dual-core PR16 — end-to-end proof that `POST /session/:id/collapse`
 * runs the real 8-step v3 extraction pipeline through the NEW `MnemoCore.
 * collapseSession` facade (`packages/core/src/cognitive/index.ts`), reached via
 * `deps.cognitive` (NOT `deps.core`, the legacy factory client this PR removes
 * `session.ts` from).
 *
 * Unlike the pre-existing `anticipation-gauge-boot.integration.test.ts` (which
 * proves the OLD `CoreLike.collapseSession` factory path still works — untouched
 * by this PR) and `collapse-rls-nonsuperuser.integration.test.ts` (same, under
 * the RLS-subject app role), this test exercises the NEW code added by this PR:
 *   1. `v3CoreMod.createCore({...})` builds the SAME kind of `CoreContext` the
 *      real server boot wires (`packages/server/src/index.ts`), backed by a real
 *      `DrizzleStorageAdapter` (RLS-subject, via `withMnemoTx`), a real
 *      `PgVectorAdapter`, and fake embed/llm adapters.
 *   2. The full HTTP surface: `POST /session/start` → `POST /session/:id/turn`
 *      (×3) → `POST /session/:id/collapse`, all through `createApp()`, proving
 *      the route wiring (`deps.cognitive.collapseSession`, not `deps.core.
 *      collapseSession`) end-to-end.
 *   3. Real DB assertions after collapse: the session is closed AND a real fact
 *      row lands in `mnemosyne.mnemo_fact` — not just a 202 status code.
 *
 * Hermetic & CI-safe: fresh container per run. Requires Docker. Requires Node 22
 * (testcontainers/undici — see CLAUDE.md).
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CacheAdapter, EmbedAdapter, LLMAdapter, LLMInput, LLMOutput } from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const WS = "17e5f9a3-1601-1601-1601-000000001601"; // valid UUID for mnemosyne schema
const PLAINTEXT_KEY = "mns_live_collapsefacadetestkey0001";
const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

const DIMS = 8;

let container: StartedTestContainer;
let databaseUrl: string;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
let pgClient: postgres.Sql;

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

// Identical vector for every text so the RecMem gate's mean-of-max cosine
// similarity is maximal (1.0) — well above the default 0.6 recurrenceThreshold —
// and the pipeline never short-circuits at step 3.
const fakeEmbed: EmbedAdapter = {
  id: "fake-embed",
  model: "fake-model",
  dimensions: DIMS,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(
      () => new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)))
    );
  },
  async embedSingle(): Promise<Float32Array> {
    return new Float32Array(Array.from({ length: DIMS }, () => 1 / Math.sqrt(DIMS)));
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

const SUMMARY = {
  goal: "wrap up the deploy config discussion",
  outcome: "resolved",
  facts: [
    {
      content: "the collapse facade persists this fact for real",
      topicKey: "collapse-facade-e2e",
      confidence: 0.95,
    },
  ],
  decisions: [],
  strategies: [],
  llmTokensUsed: 10,
};
const fakeLlm: LLMAdapter = {
  id: "fake-llm",
  model: "fake-model",
  async generate(_input: LLMInput): Promise<LLMOutput> {
    return {
      content: JSON.stringify(SUMMARY),
      tokensUsed: { input: 10, output: 10 },
      model: "fake-model",
      finishReason: "stop",
    };
  },
  async generateStructured<T>(_input: LLMInput, schema: { parse: (d: unknown) => T }): Promise<T> {
    return schema.parse(SUMMARY);
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

// In-memory CacheAdapter double — required so app.ts's Redis-degradation gate
// (v1.use("/session/*", ...)) lets POST /session/* through instead of 503ing.
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

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  // Stream 1: legacy core migrations → public schema (auth/legacy tables).
  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");

  // Stream 2: v3 adapter-postgres migrations → mnemosyne schema.
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  pgClient = postgres(databaseUrl, { max: 3, onnotice: () => void 0 });
  await pgClient`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_collapse_facade_01"}, ${WS}, ${keyHash}, ${"collapse-facade-test"}, ${"collapse-facade-test"},
            ARRAY['memory:write', 'memory:read', 'memory:delete']::text[])
  `;

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);

  const { db, pgClient: pgC } = adapterPgMod.createDrizzleClient(databaseUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgC, undefined);
  const vectorAdapter = new adapterVectorMod.PgVectorAdapter({
    connectionString: databaseUrl,
    dimensions: DIMS,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const noop = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
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

  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };

  // THE FIX UNDER TEST: MnemoCore.collapseSession (flatten-legacy-dual-core
  // PR16) reuses this SAME CoreContext-shaped dep bundle — no separate
  // collapse-specific wiring, unlike the legacy factory's buildCollapseContext.
  const cognitive = v3CoreMod.createCore({
    storage,
    vector: vectorAdapter,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    llm: fakeLlm,
    cache: new FakeCache(),
    logger: noopLogger,
    telemetry: noop,
  });

  const deps: ServerDeps = {
    // No `core` (legacy factory) wired at all — proves session.ts's collapse
    // route no longer depends on it.
    cognitive,
    storage,
    apiKeys: { close: async () => {} } as unknown as ServerDeps["apiKeys"],
    llm: undefined,
    embedModel: "fake-model",
    cache: new FakeCache(),
    telemetry: noop,
  } as unknown as ServerDeps;

  // Real ApiKeyLookup backed by the seeded row (mirrors recall-cascade's pattern).
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;
  (deps as unknown as { apiKeys: unknown }).apiKeys = apiKeys;

  app = createApp({ deps, version: "collapse-facade-test" });
}, 180_000);

afterAll(async () => {
  await pgClient?.end().catch(() => void 0);
  await apiKeyLookupClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("POST /session/:id/collapse runs the real pipeline via deps.cognitive.collapseSession", () => {
  it("starts a session, appends turns, collapses, and persists a real fact + closes the session", async () => {
    const startRes = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ agentId: "agent-collapse-facade" }),
    });
    expect(startRes.status).toBe(201);
    const { id: sessionId } = (await startRes.json()) as { id: string };
    expect(sessionId).toBeTruthy();

    // minTurnsForCollapse defaults to 3.
    for (let i = 0; i < 3; i++) {
      const turnRes = await app.request(`/session/${sessionId}/turn`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `deploy config discussion turn ${i}`,
        }),
      });
      expect(turnRes.status).toBe(204);
    }

    const collapseRes = await app.request(`/session/${sessionId}/collapse`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ strategy: "explicit" }),
    });
    expect(collapseRes.status).toBe(202);
    const collapseBody = (await collapseRes.json()) as {
      accepted: boolean;
      sessionId: string;
      resumed: boolean;
    };
    // P115 added `status` to the response; this expectation predates it and
    // failed on 9a20d6ea already.
    expect(collapseBody).toEqual({
      accepted: true,
      sessionId,
      resumed: false,
      status: "completed",
    });

    // Real-Postgres proof: the session is closed and a real fact row exists —
    // not just a 202 status code from a mocked facade.
    const sessionRows = await pgClient`
      SELECT status FROM mnemosyne.mnemo_session WHERE id = ${sessionId}
    `;
    expect(sessionRows[0]?.status).toBe("collapsed");

    const factRows = await pgClient`
      SELECT statement FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${WS} AND topic_key = 'collapse-facade-e2e'
    `;
    expect(factRows.length).toBe(1);
    expect(factRows[0]?.statement).toBe("the collapse facade persists this fact for real");
  });

  it("returns 404 when the session does not exist", async () => {
    const res = await app.request("/session/00000000-0000-0000-0000-000000000000/collapse", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
