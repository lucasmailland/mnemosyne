/**
 * F1 — v3-cognitive-boot integration proof: when the v3 core is built WITH
 * collapse.{embed,vector,llm,cache} (the index.ts fix), `cognitive.collapseSession`
 * runs the real pipeline against a real Postgres and returns a non-null
 * anticipation-accuracy gauge (spec §30).
 *
 * This is the end-to-end guard the unit/pipeline tests can't give: it exercises
 * `MnemoCore.collapseSession` (PR16, `@mnemo-ai/core/cognitive`) through a real
 * DB — the exact path the inactivity sweep / HTTP collapse handler use in
 * production (flatten-legacy-dual-core Phase 7 replaced the legacy
 * `CoreLike.collapseSession` facade this test originally exercised — same
 * pipeline underneath, `runCollapseSessionFacade` in both cases, see PR16's
 * note in legacy-core-usage.test.ts's git history for the byte-for-byte glue
 * migration).
 *
 * Hermetic & CI-safe: throwaway pgvector container + the bundled migrate CLI.
 * Requires Docker (same precondition as the other *.integration.test.ts files).
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

// Mirrors packages/core/src/session/working-memory.ts:workKey (not a root export).
// Collapse reads the anticipation slot at exactly this namespaced key.
const workKey = (ws: string, agent: string, key: string): string =>
  `mnemo:${ws}:work:${agent}:${key}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
// Two migration streams (mirrors recall-cascade.integration.test.ts):
//  1. core CLI + core/migrations → public schema (legacy/auth).
//  2. adapter-postgres CLI → mnemosyne schema (v3 session tables live here).
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

// workspace_id is cast `::uuid` by the RLS policy — must be a real UUID.
const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-anticipation";
const SESSION = "22222222-2222-2222-2222-222222222222";

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

let container: StartedTestContainer;
let databaseUrl: string;
let cognitive: Awaited<ReturnType<typeof import("@mnemo-ai/core/cognitive").createCore>>;
let storageClose: (() => Promise<void>) | undefined;

// ── Fakes: satisfy the collapse adapter ports without external services ──
const fakeEmbed: EmbedAdapter = {
  id: "fake-embed",
  model: "fake",
  dimensions: 3,
  // Identical vectors → maximal recurrence signal so the RecMem gate passes.
  async embed(texts: string[]) {
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

// Collapse summary the pipeline parses out of ctx.llm.generate().content.
const SUMMARY = {
  goal: "configure infra",
  outcome: "resolved",
  facts: [{ content: "deploy-region is us-east-1", topicKey: "deploy-region", confidence: 0.9 }],
  decisions: [],
  strategies: [],
  llmTokensUsed: 10,
};
const fakeLlm: LLMAdapter = {
  id: "fake-llm",
  model: "fake",
  async generate(_input: LLMInput): Promise<LLMOutput> {
    return {
      content: JSON.stringify(SUMMARY),
      tokensUsed: { input: 10, output: 10 },
      model: "fake",
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

// In-memory cache double (Redis-contract-faithful: serialize once / parse once).
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
const fakeCache = new FakeCache();

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // Stream 1: legacy core migrations → public schema.
  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");

  // Stream 2: v3 adapter-postgres migrations → mnemosyne schema (mnemo_session/_turn).
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // The v3 tables live in the `mnemosyne` schema (migrations SET search_path
  // locally). The factory's collapse reads use UNqualified names (FROM
  // mnemo_session), so make `mnemosyne` the DB-default search_path for every
  // subsequent connection (factory pool + seed). Production sets this via the
  // connection string / PGOPTIONS; we replicate it here.
  // Role-level default applies to every NEW connection by this user — including
  // the factory's createCore pool, whose collapse reads use unqualified names.
  const cfg = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await cfg.unsafe(`ALTER ROLE ${PG_USER} SET search_path TO mnemosyne, public`);
    await cfg.unsafe(`ALTER DATABASE ${PG_DB} SET search_path TO mnemosyne, public`);
    // app_user is created by the v3 baseline but its search_path and schema grants
    // may be incomplete (squash baseline dropped grants wholesale — see mnemosyne_squash_baseline_broken).
    // Fix them here so withMnemoTx (SET LOCAL ROLE app_user) can see mnemosyne.mnemo_episode.
    await cfg.unsafe(`ALTER ROLE app_user SET search_path TO mnemosyne, public`);
    await cfg.unsafe(`GRANT USAGE ON SCHEMA mnemosyne TO app_user`);
    await cfg.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne TO app_user`
    );
    await cfg.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO app_user`);
  } finally {
    await cfg.end();
  }

  // Seed a session + 6 turns. Schema-qualified so seeding never depends on
  // search_path. The container's POSTGRES_USER is a superuser, so it BYPASSES RLS
  // (even FORCE) — no workspace GUC needed for the writes OR the factory's reads.
  // (NOTE: in production the app role is non-superuser; collapse reads there need
  // a workspace RLS context — see the separate finding flagged alongside this fix.)
  const seed = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await seed`
      INSERT INTO mnemosyne.mnemo_session (id, workspace_id, agent_id, status, turn_count)
      VALUES (${SESSION}, ${WS}, ${AGENT}, 'active', 6)
    `;
    // turn_count matches the six turns below, as appendTurn and the harness
    // writer keep it. Collapse refuses a snapshot whose count differs from the
    // turns it read (SessionRepository, SESSION_SNAPSHOT_CHANGED); this fixture
    // inserted the turns raw and left it at 0, so it failed on main (APP-072).
    for (let i = 0; i < 6; i++) {
      await seed`
        INSERT INTO mnemosyne.mnemo_session_turn (workspace_id, session_id, turn_index, role, content)
        VALUES (${WS}, ${SESSION}, ${i}, ${i % 2 === 0 ? "user" : "assistant"},
                ${i === 5 ? "thanks, that worked perfectly" : `message about deploy region ${i}`})
      `;
    }
  } finally {
    await seed.end();
  }

  // THE FIX UNDER TEST: build the v3 cognitive core WITH collapse adapters
  // (storage/vector/embed always required; llm/cache optional, wired here).
  const [adapterPgMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const { db, pgClient } = adapterPgMod.createDrizzleClient(databaseUrl);
  const storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient);
  storageClose = () => pgClient.end({ timeout: 5 });
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

  // Pre-stage the anticipation slot at the SAME workKey collapse reads.
  await fakeCache.set(workKey(WS, AGENT, ANTICIPATION_SLOT), {
    generatedAt: "2026-06-15T10:00:00.000Z",
    items: [{ id: "anticipated-1" }, { id: "anticipated-2" }],
  });
}, 180_000);

afterAll(async () => {
  await storageClose?.().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("F1 v3-cognitive-boot: collapseSession returns a non-null anticipation gauge", () => {
  it("collapses the seeded session and yields a real anticipationAccuracy (not null)", async () => {
    const auth: AuthContext = {
      actorId: formatActorRef("system", "collapse"),
      actorType: "system",
      userId: null,
      workspaceId: WS,
      scopes: ["memory:write", "memory:read", "session:manage"],
    };
    const result = await cognitive.collapseSession(
      {
        sessionId: SESSION,
        workspaceId: WS,
        reason: "explicit",
      },
      auth
    );

    // With collapse.cache wired and a slot pre-staged, the §30 step computes a
    // real fraction. (hits=0 here — the extracted fact's UUID won't match the
    // synthetic anticipated ids — so accuracy is 0, but 0 is a REAL number; the
    // regression made it structurally `null`.)
    expect(result.anticipationAccuracy).not.toBeNull();
    expect(typeof result.anticipationAccuracy).toBe("number");
    expect(result.anticipationAccuracy).toBeGreaterThanOrEqual(0);
  });
});
