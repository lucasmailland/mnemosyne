/**
 * End-to-end proof that session collapse — and the §30 anticipation gauge —
 * works under the NON-SUPERUSER, RLS-subject Postgres role production uses
 * (assertSafeDbRole rejects superuser/bypassrls). Collapse runs through an
 * injected DrizzleStorageAdapter (collapse.storage) connected as that role,
 * which sets mnemosyne.workspace_id per transaction. Requires Docker.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AuthContext,
  CacheAdapter,
  EmbedAdapter,
  LLMAdapter,
  LLMInput,
  LLMOutput,
  VectorAdapter,
} from "@mnemo-ai/types";
import { formatActorRef } from "@mnemo-ai/types";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANTICIPATION_SLOT } from "@mnemo-ai/core";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const WS_A = "17e5f9a3-0aaa-0aaa-0aaa-00000000000a";
const WS_B = "17e5f9a3-0bbb-0bbb-0bbb-00000000000b";
const AGENT = "agent-rls";
const SESSION_A = "5e551011-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };

// Mirrors packages/core/src/session/working-memory.ts:workKey (not a root export).
const workKey = (ws: string, agent: string, key: string): string =>
  `mnemo:${ws}:work:${agent}:${key}`;

const SUMMARY = {
  goal: "configure infra",
  outcome: "resolved",
  facts: [{ content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 }],
  decisions: [],
  strategies: [],
  llmTokensUsed: 10,
};
const fakeEmbed: EmbedAdapter = {
  id: "fake-embed",
  model: "fake",
  dimensions: 3,
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0, 0]));
  },
  async embedSingle() {
    return new Float32Array([1, 0, 0]);
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};
const fakeVector: VectorAdapter = {
  id: "fake-vector",
  dimensions: 3,
  async search() {
    return [];
  },
  async upsert() {},
  async delete() {},
  async deleteByFilter() {
    return 0;
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
  async close() {},
};
const fakeLlm: LLMAdapter = {
  id: "fake-llm",
  model: "fake",
  async generate(_i: LLMInput): Promise<LLMOutput> {
    return {
      content: JSON.stringify(SUMMARY),
      tokensUsed: { input: 10, output: 10 },
      model: "fake",
      finishReason: "stop",
    };
  },
  async generateStructured<T>(_i: LLMInput, schema: { parse: (d: unknown) => T }): Promise<T> {
    return schema.parse(SUMMARY);
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};
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
  async get<T>(k: string): Promise<T | null> {
    const v = this.store.get(k);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set<T>(k: string, v: T): Promise<void> {
    this.store.set(k, JSON.stringify(v));
  }
  async delete(k: string): Promise<void> {
    this.store.delete(k);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

let container: StartedTestContainer;
let superUrl: string;
let appUrl: string;
let cognitive: Awaited<ReturnType<typeof import("@mnemo-ai/core/cognitive").createCore>>;
let appStorage: { close?: () => Promise<void> } | undefined;
const fakeCache = new FakeCache();

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  const boot = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await boot.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await boot.end();
  }

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

  // Non-superuser, RLS-subject role with the v3 app grants (mirrors prod's mnemo_v3_app_role).
  const admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='appconn') THEN
          CREATE ROLE appconn LOGIN PASSWORD 'appconn' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
      GRANT mnemo_app_role TO appconn;
      GRANT CONNECT ON DATABASE mnemo TO appconn;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO appconn;
    `);
    // Seed a session + 6 turns in workspace A as superuser (RLS-bypassing), v3 GUC set, schema-qualified.
    await admin.unsafe(`SELECT set_config('mnemosyne.workspace_id', '${WS_A}', false)`);
    // turn_count = the six turns below, as appendTurn keeps it (APP-072: the
    // collapse refuses a snapshot whose count differs from the turns it read).
    await admin`INSERT INTO mnemosyne.mnemo_session (id, workspace_id, agent_id, status, turn_count)
                VALUES (${SESSION_A}, ${WS_A}, ${AGENT}, 'active', 6)`;
    for (let i = 0; i < 6; i++) {
      await admin`INSERT INTO mnemosyne.mnemo_session_turn (workspace_id, session_id, turn_index, role, content)
                  VALUES (${WS_A}, ${SESSION_A}, ${i}, ${i % 2 === 0 ? "user" : "assistant"},
                          ${i === 5 ? "thanks, that worked perfectly" : `message about deploy region ${i}`})`;
    }
  } finally {
    await admin.end();
  }

  const u = new URL(superUrl);
  u.username = "appconn";
  u.password = "appconn";
  appUrl = u.toString();

  // Build a DrizzleStorageAdapter connected as the NON-SUPERUSER role.
  const adapterPg = await import("@mnemo-ai/adapter-postgres");
  const { db, pgClient } = adapterPg.createDrizzleClient(appUrl);
  const storage = new adapterPg.DrizzleStorageAdapter(db);
  appStorage = pgClient as unknown as { close?: () => Promise<void> };

  // THE FIX UNDER TEST: build the v3 cognitive core with the NON-SUPERUSER,
  // RLS-subject `storage` above (flatten-legacy-dual-core Phase 7 — was the
  // legacy factory core's `collapse.storage` injection).
  const outbox: import("@mnemo-ai/types").OutboxAdapter = {
    async append(entry) {
      return storage.appendOutbox(entry);
    },
    async claimBatch(limit) {
      return storage.claimOutbox(limit);
    },
    async markProcessed(ids) {
      return storage.markOutboxProcessed(ids);
    },
    async markFailed(id, error) {
      return storage.markOutboxFailed(id, error);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const noopTelemetry: import("@mnemo-ai/types").Telemetry = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const v3CoreMod = await import("@mnemo-ai/core/cognitive");
  cognitive = v3CoreMod.createCore({
    storage,
    vector: fakeVector,
    embed: fakeEmbed,
    outbox,
    llm: fakeLlm,
    cache: fakeCache,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  await fakeCache.set(workKey(WS_A, AGENT, ANTICIPATION_SLOT), {
    generatedAt: "2026-06-15T10:00:00.000Z",
    items: [{ id: "anticipated-1" }, { id: "anticipated-2" }],
  });
}, 180_000);

afterAll(async () => {
  await appStorage?.close?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

function sweepAuth(workspaceId: string): AuthContext {
  return {
    actorId: formatActorRef("system", "collapse"),
    actorType: "system",
    userId: null,
    workspaceId,
    scopes: ["memory:write", "memory:read", "session:manage"],
  };
}

describe("collapse under a non-superuser RLS role (collapse.storage injected)", () => {
  it("finds the session and returns a non-null anticipation gauge", async () => {
    const result = await cognitive.collapseSession(
      { sessionId: SESSION_A, workspaceId: WS_A, reason: "explicit" },
      sweepAuth(WS_A)
    );
    expect(result.anticipationAccuracy).not.toBeNull();
    expect(typeof result.anticipationAccuracy).toBe("number");
    expect(result.anticipationAccuracy).toBeGreaterThanOrEqual(0);
  });

  it("does NOT collapse a session from another workspace (RLS isolation holds)", async () => {
    // WS_B has no such session; under RLS the read sees nothing → NOT_FOUND throw.
    await expect(
      cognitive.collapseSession(
        { sessionId: SESSION_A, workspaceId: WS_B, reason: "explicit" },
        sweepAuth(WS_B)
      )
    ).rejects.toThrowError(/not found/i);
  });
});
