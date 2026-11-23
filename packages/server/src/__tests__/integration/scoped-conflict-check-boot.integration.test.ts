/**
 * openspec change `auto-trigger-scoped-consolidation` — Phase 5, task 5.1.
 *
 * Real-Postgres proof that the write-time scoped semantic conflict check is
 * genuinely LIVE at boot — not merely unit-tested in isolation (PR 1) or
 * manually verified via a boot-log grep (PR 2). This reconstructs the exact
 * PRODUCTION wiring order from `packages/server/src/index.ts`:
 *
 *   1. shedding-wrapped job queue is created
 *   2. `wireConsolidation({ ..., queue })` is called — it registers the
 *      `scoped_semantic_conflict_check` handler against that SAME queue
 *      instance via `queue.process(...)`
 *   3. ONLY THEN does the `OutboxWorker` start draining
 *
 * If step 2 ever regresses to run AFTER step 3 (the exact bug this change's
 * design.md open question identified — see `boot/consolidation.ts` and
 * `index.ts`'s `jobQueue`/`schedStop` hoisting comments), any
 * `scoped_semantic_conflict_check` job appended in the gap is silently
 * dropped: `InMemoryQueueAdapter.enqueue()` no-ops when no handler is
 * registered yet, and the outbox worker still marks the entry processed.
 *
 * End-to-end path proven here:
 *   `cognitive.remember()` (real v3 core) → write-time neighbour ≥0.85
 *   cosine similarity → nested `queue_job` outbox row → real `OutboxWorker`
 *   drains it → real (shedding-wrapped) `InMemoryQueueAdapter.enqueue()` →
 *   the handler registered by the REAL `wireConsolidation()` → fake LLM
 *   returns CONTRADICTION → `conflicts_with` relation persisted to real
 *   Postgres with `metadata.detectedBy === "scoped_write_time_check"`.
 *
 * A second describe block pins the regression this test guards against: when
 * `queue.process()` is never called (registration skipped/misordered), the
 * exact same write sequence produces ZERO relations — proving the handler's
 * effect is caused by registration, not by some other code path.
 *
 * Hermetic & CI-safe: throwaway pgvector testcontainer + the bundled migrate
 * CLI (programmatic `migrate()` from `@mnemo-ai/adapter-postgres/migrate` —
 * only the v3 `mnemosyne` schema stream is needed; this test never touches
 * the legacy v2 core or public schema).
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/server test:integration -- scoped-conflict-check-boot
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
 */
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  AuthContext,
  CacheAdapter,
  EmbedAdapter,
  Logger,
  QueueAdapter,
} from "@mnemo-ai/types";
import type { LLMProviderLike, ServerDeps } from "../../deps.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

// Distinct workspaces per describe block so the two scenarios can never
// cross-contaminate each other's relation reads even though they share one
// container/database.
const WS_REGISTERED = "c0ffee00-0000-4000-8000-000000000001";
const WS_UNREGISTERED = "c0ffee00-0000-4000-8000-000000000002";

// P117: createFact refuses a width with no vector table behind it, so this
// has to be one of SUPPORTED_EMBED_DIMENSIONS (it was 3, and every write in
// this file failed before reaching the code under test).
const DIMS = 1024;
// Identical vectors → cosine similarity 1.0, well above the 0.85 scoped-
// conflict threshold. surpriseThreshold is overridden to 0 below so the
// write-time novelty gate never stages (and thereby skips creating) the
// second fact — see the inline note at the `createCore` call site.
const FIXED_VECTOR = new Float32Array(DIMS);
FIXED_VECTOR[0] = 1;

let container: StartedTestContainer;
let databaseUrl: string;

const AUTH = (workspaceId: string): AuthContext => ({
  workspaceId,
  actorId: "test-agent",
  actorType: "agent",
  scopes: ["memory:write"] as never,
});

const noopLogger: Logger = {
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

class NoopCache implements CacheAdapter {
  readonly id = "noop-cache";
  readonly capabilities = {
    sortedSets: false,
    pubSub: false,
    patterns: false,
    atomic: false,
    hashes: false,
  };
  async get<T>(): Promise<T | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async deletePattern(): Promise<number> {
    return 0;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

function makeFakeEmbed(): EmbedAdapter {
  return {
    id: "fake-embed",
    model: "fake-embed-model",
    dimensions: DIMS,
    async embed(texts: string[]) {
      return texts.map(() => FIXED_VECTOR);
    },
    async embedSingle() {
      return FIXED_VECTOR;
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
}

/** Fake LLM: `embed` unused (LLMProviderLike shape only), `generate` always
 * returns CONTRADICTION so the handler under test creates a relation
 * whenever it actually resolves this LLM. */
function makeFakeLlm(): LLMProviderLike & {
  generate: (
    opts: unknown
  ) => Promise<{ content: string; tokensUsed: { input: number; output: number } }>;
} {
  return {
    async embed() {
      return [0];
    },
    async generate() {
      return { content: "CONTRADICTION", tokensUsed: { input: 1, output: 1 } };
    },
  };
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs; // determinism-ok: bounded polling deadline, never compared to a fixed value
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    const elapsed = Date.now(); // determinism-ok: same bounded polling deadline check
    if (elapsed > deadline) {
      throw new Error(`waitFor: timed out after ${opts.timeoutMs}ms waiting for a truthy result`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
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

  // Only the v3 (`mnemosyne` schema) migration stream — this test never
  // touches the legacy v2 core or the public schema.
  const { migrate } = await import("@mnemo-ai/adapter-postgres/migrate");
  const result = await migrate({ databaseUrl, log: () => void 0 });
  expect(result.applied.length + result.skipped.length).toBeGreaterThan(0);
}, 180_000);

afterAll(async () => {
  await container?.stop().catch(() => void 0);
});

describe("scoped conflict check is registered before the outbox drains (real boot order)", () => {
  let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
  let pgClient: postgres.Sql;
  let vectorAdapter: import("@mnemo-ai/adapter-vector").PgVectorAdapter;
  let outboxWorker: import("@mnemo-ai/adapter-postgres").OutboxWorker;
  let schedStop: (() => void) | undefined;
  let cognitive: import("../../deps.js").MnemoCore;

  beforeAll(async () => {
    const [
      adapterPgMod,
      adapterVectorMod,
      v3CoreMod,
      { wireConsolidation },
      { InMemoryQueueAdapter },
      { createSheddingQueue },
    ] = await Promise.all([
      import("@mnemo-ai/adapter-postgres"),
      import("@mnemo-ai/adapter-vector"),
      import("@mnemo-ai/core/cognitive"),
      import("../../boot/consolidation.js"),
      import("../../queueMemory.js"),
      import("../../resilience/sheddingQueue.js"),
    ]);

    const client = adapterPgMod.createDrizzleClient(databaseUrl);
    pgClient = client.pgClient;
    storage = new adapterPgMod.DrizzleStorageAdapter(client.db, client.pgClient);
    vectorAdapter = new adapterVectorMod.PgVectorAdapter({
      connectionString: databaseUrl,
      dimensions: DIMS,
    });

    // Build the real v3 core FIRST — wireConsolidation (below) destructures
    // its `v3` param synchronously and requires it truthy to wire
    // `replayValidator.llm`, so it must already exist at call time.
    cognitive = v3CoreMod.createCore(
      {
        storage,
        vector: vectorAdapter,
        embed: makeFakeEmbed(),
        outbox: {
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
        },
        logger: noopLogger,
        telemetry: noopTelemetry,
      },
      // surpriseThreshold: 0 — the two facts below share an IDENTICAL
      // embedding (cosine similarity 1.0) so the scoped-conflict-check
      // candidate qualifies (>=0.85), but the default surprise gate
      // (surpriseThreshold 0.15 → stage when pe < 0.15, i.e. similarity >
      // 0.85) would otherwise STAGE the second fact instead of creating
      // it, and a staged write never reaches the scoped-conflict-check
      // outbox append at all. Disabling the gate isolates the exact
      // behaviour this test proves.
      { surpriseThreshold: 0 }
    );

    // ── Step 1: queue creation (mirrors index.ts's `createSheddingQueue`) ──
    const baseQueue = new InMemoryQueueAdapter();
    const queue: QueueAdapter = createSheddingQueue(baseQueue, { poolUtil: () => 0 });

    // ── Step 2: wireConsolidation registers the handler against `queue` ──
    // (real production function — not a hand-rolled stand-in for it).
    const fakeDeps = {} as unknown as ServerDeps;

    const schedStopObj = await wireConsolidation({
      databaseUrl,
      storageForDeps: storage,
      llm: makeFakeLlm(),
      v3: cognitive,
      deps: fakeDeps,
      queue,
    });
    schedStop = schedStopObj?.stop;

    // ── Step 3: OutboxWorker starts draining — strictly AFTER registration ──
    outboxWorker = new adapterPgMod.OutboxWorker(
      storage,
      vectorAdapter,
      new NoopCache(),
      queue,
      noopLogger,
      {
        pollIntervalMs: 50,
      }
    );
    outboxWorker.start();
  }, 120_000);

  afterAll(async () => {
    outboxWorker?.stop();
    schedStop?.();
    await vectorAdapter?.close().catch(() => void 0);
    await pgClient?.end().catch(() => void 0);
  });

  it("creates a conflicts_with relation with metadata.detectedBy=scoped_write_time_check", async () => {
    // Distinct `subject` values AND zero shared vocabulary in the statements
    // — the fake embed adapter returns an IDENTICAL vector for both
    // regardless of text, so embedding similarity (the thing this test
    // proves) is unaffected by either choice. Both are required to keep
    // §33's INDEPENDENT `findContradictingFacts` (same-subject exact-match
    // OR FTS overlap on lemmatized text) from ALSO firing and creating an
    // unrelated `conflicts_with` relation that would confound this
    // assertion — §33 and this scoped check are different populations
    // (design.md); this test isolates the scoped-check population only.
    const first = await cognitive.remember(
      {
        workspaceId: WS_REGISTERED,
        kind: "fact",
        subject: "scoped-check-subject-a",
        content: "The lighthouse keeper repaints the beacon every spring.",
        sensitivity: "internal",
      },
      AUTH(WS_REGISTERED)
    );
    expect(first.staged).not.toBe(true);

    const second = await cognitive.remember(
      {
        workspaceId: WS_REGISTERED,
        kind: "fact",
        subject: "scoped-check-subject-b",
        content: "Quarterly tax filings are due by the fifteenth of April.",
        sensitivity: "internal",
      },
      AUTH(WS_REGISTERED)
    );
    expect(second.staged).not.toBe(true);

    const relations = await waitFor(
      async () => {
        const rows = await storage.getRelations({
          workspaceId: WS_REGISTERED,
          sourceId: second.id,
          verb: "conflicts_with",
        });
        return rows.length > 0 ? rows : undefined;
      },
      { timeoutMs: 10_000, intervalMs: 100 }
    );

    expect(relations).toHaveLength(1);
    expect(relations[0]?.targetId).toBe(first.id);
    // flatten-legacy-dual-core PR9c (D6.4) renamed MnemoRelation.metadata ->
    // evidence (the real physical column; metadata was a fiction that
    // silently aliased onto it). This is a direct deps.storage.getRelations
    // caller, not an HTTP round-trip through routes/relations.ts, so PR9c's
    // repo-wide metadata->evidence fan-out search (scoped to core/
    // consolidation/adapter-postgres) missed this file — found and fixed here.
    expect(relations[0]?.evidence?.["detectedBy"]).toBe("scoped_write_time_check");
  });
});

describe("regression guard — no relation is created when registration is skipped", () => {
  let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
  let pgClient: postgres.Sql;
  let vectorAdapter: import("@mnemo-ai/adapter-vector").PgVectorAdapter;
  let outboxWorker: import("@mnemo-ai/adapter-postgres").OutboxWorker;
  let cognitive: import("../../deps.js").MnemoCore;

  beforeAll(async () => {
    const [
      adapterPgMod,
      adapterVectorMod,
      v3CoreMod,
      { InMemoryQueueAdapter },
      { createSheddingQueue },
    ] = await Promise.all([
      import("@mnemo-ai/adapter-postgres"),
      import("@mnemo-ai/adapter-vector"),
      import("@mnemo-ai/core/cognitive"),
      import("../../queueMemory.js"),
      import("../../resilience/sheddingQueue.js"),
    ]);

    const client = adapterPgMod.createDrizzleClient(databaseUrl);
    pgClient = client.pgClient;
    storage = new adapterPgMod.DrizzleStorageAdapter(client.db, client.pgClient);
    vectorAdapter = new adapterVectorMod.PgVectorAdapter({
      connectionString: databaseUrl,
      dimensions: DIMS,
    });

    const baseQueue = new InMemoryQueueAdapter();
    const queue: QueueAdapter = createSheddingQueue(baseQueue, { poolUtil: () => 0 });

    // DELIBERATELY skip `wireConsolidation()` / `queue.process(...)` — this
    // is the "registration absent/misordered" case task 5.4 pins as a
    // regression guard: the outbox worker drains the exact same job, but
    // `InMemoryQueueAdapter.enqueue()` finds no handler and silently no-ops.
    outboxWorker = new adapterPgMod.OutboxWorker(
      storage,
      vectorAdapter,
      new NoopCache(),
      queue,
      noopLogger,
      {
        pollIntervalMs: 50,
      }
    );

    cognitive = v3CoreMod.createCore(
      {
        storage,
        vector: vectorAdapter,
        embed: makeFakeEmbed(),
        outbox: {
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
        },
        logger: noopLogger,
        telemetry: noopTelemetry,
      },
      { surpriseThreshold: 0 }
    );

    outboxWorker.start();
  }, 120_000);

  afterAll(async () => {
    outboxWorker?.stop();
    await vectorAdapter?.close().catch(() => void 0);
    await pgClient?.end().catch(() => void 0);
  });

  it("never creates the relation, even after the outbox has had time to drain", async () => {
    // Same distinct-subject / no-shared-vocabulary rationale as the positive
    // scenario — isolates this test from §33's independent (and unrelated)
    // conflict detection.
    const first = await cognitive.remember(
      {
        workspaceId: WS_UNREGISTERED,
        kind: "fact",
        subject: "scoped-check-subject-a",
        content: "The lighthouse keeper repaints the beacon every spring.",
        sensitivity: "internal",
      },
      AUTH(WS_UNREGISTERED)
    );
    const second = await cognitive.remember(
      {
        workspaceId: WS_UNREGISTERED,
        kind: "fact",
        subject: "scoped-check-subject-b",
        content: "Quarterly tax filings are due by the fifteenth of April.",
        sensitivity: "internal",
      },
      AUTH(WS_UNREGISTERED)
    );

    // Bounded wait — several multiples of the 50ms poll interval — for the
    // job to have been claimed and (silently) dropped.
    await sleep(2_000);

    const relations = await storage.getRelations({
      workspaceId: WS_UNREGISTERED,
      sourceId: second.id,
      verb: "conflicts_with",
    });
    expect(relations).toHaveLength(0);

    // Sanity: the outbox entry itself WAS claimed/processed (queue.enqueue
    // no-ops without throwing — it does not leave the entry stuck pending).
    // This proves the absence of a relation is caused by "no handler
    // registered", not by the outbox worker failing to run at all.
    const pending = await storage.claimOutbox(50);
    expect(pending.find((e) => e.workspaceId === WS_UNREGISTERED)).toBeUndefined();
  });
});

// SECURITY.md §7: the policy reaches the scoped check through the real
// wireConsolidation(). A confidential pair goes to the (external) judge only
// under MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=all.
describe.each([
  ["all", "c0ffee00-0000-4000-8000-000000000003", 1],
  [undefined, "c0ffee00-0000-4000-8000-000000000004", 0],
] as const)("confidential pair, sensitiveTextToProviders=%s", (policy, ws, expected) => {
  let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
  let pgClient: postgres.Sql;
  let vectorAdapter: import("@mnemo-ai/adapter-vector").PgVectorAdapter;
  let outboxWorker: import("@mnemo-ai/adapter-postgres").OutboxWorker;
  let schedStop: (() => void) | undefined;
  let cognitive: import("../../deps.js").MnemoCore;
  const judged: string[] = [];
  // Trivial base64 "wrap", as auth-gdpr.integration: this proves the policy, not the wrap crypto.
  const dekProvisioner = () => {
    const dek = randomBytes(32);
    return { dek, wrapped: dek.toString("base64") };
  };
  const dekUnwrapper = (_ws: string, _actor: string, wrapped: string) =>
    Buffer.from(wrapped, "base64");

  beforeAll(async () => {
    const [adapterPgMod, adapterVectorMod, v3CoreMod, { wireConsolidation }, queueMod, shed] =
      await Promise.all([
        import("@mnemo-ai/adapter-postgres"),
        import("@mnemo-ai/adapter-vector"),
        import("@mnemo-ai/core/cognitive"),
        import("../../boot/consolidation.js"),
        import("../../queueMemory.js"),
        import("../../resilience/sheddingQueue.js"),
      ]);
    const client = adapterPgMod.createDrizzleClient(databaseUrl);
    pgClient = client.pgClient;
    // Facts are sealed at rest; the scoped check opens them with the same unwrapper.
    storage = new adapterPgMod.DrizzleStorageAdapter(
      client.db,
      client.pgClient,
      dekUnwrapper,
      dekProvisioner
    );
    vectorAdapter = new adapterVectorMod.PgVectorAdapter({
      connectionString: databaseUrl,
      dimensions: DIMS,
    });
    cognitive = v3CoreMod.createCore(
      {
        storage,
        vector: vectorAdapter,
        embed: makeFakeEmbed(),
        outbox: {
          append: (e) => storage.appendOutbox(e),
          claimBatch: (n) => storage.claimOutbox(n),
          markProcessed: (ids) => storage.markOutboxProcessed(ids),
          markFailed: (id, err) => storage.markOutboxFailed(id, err),
          getStats: async () => ({ pending: 0, failed: 0, oldestPendingMs: 0 }),
        },
        logger: noopLogger,
        telemetry: noopTelemetry,
      },
      { surpriseThreshold: 0, ...(policy ? { sensitiveTextToProviders: policy } : {}) }
    );
    const queue = shed.createSheddingQueue(new queueMod.InMemoryQueueAdapter(), {
      poolUtil: () => 0,
    });
    const llm = makeFakeLlm();
    const recordingLlm = {
      ...llm,
      async generate(opts: unknown) {
        judged.push(JSON.stringify(opts));
        return llm.generate(opts);
      },
    };
    schedStop = (
      await wireConsolidation({
        databaseUrl,
        storageForDeps: storage,
        llm: recordingLlm,
        v3: cognitive,
        deps: {} as unknown as ServerDeps,
        queue,
        dekUnwrapper,
        ...(policy ? { sensitiveTextToProviders: policy } : {}),
      })
    )?.stop;
    outboxWorker = new adapterPgMod.OutboxWorker(
      storage,
      vectorAdapter,
      new NoopCache(),
      queue,
      noopLogger,
      {
        pollIntervalMs: 50,
      }
    );
    outboxWorker.start();
  }, 120_000);

  afterAll(async () => {
    outboxWorker?.stop();
    schedStop?.();
    await vectorAdapter?.close().catch(() => void 0);
    await pgClient?.end().catch(() => void 0);
  });

  it(`the judge receives the pair ${expected ? "and flags it" : "never"}`, async () => {
    await cognitive.remember(
      {
        workspaceId: ws,
        kind: "fact",
        subject: "scoped-check-subject-a",
        content: "Larkspur Robotics pays its contractors through Acme Bank.",
        sensitivity: "confidential",
      },
      AUTH(ws)
    );
    const second = await cognitive.remember(
      {
        workspaceId: ws,
        kind: "fact",
        subject: "scoped-check-subject-b",
        content: "Quarterly bonuses are wired on the last Friday of the month.",
        sensitivity: "confidential",
      },
      AUTH(ws)
    );
    const relations = async () =>
      storage.getRelations({ workspaceId: ws, sourceId: second.id, verb: "conflicts_with" });
    if (expected) {
      await waitFor(async () => ((await relations()).length > 0 ? true : undefined), {
        timeoutMs: 10_000,
        intervalMs: 100,
      });
    } else {
      await sleep(2_000);
      const pending = await storage.claimOutbox(50);
      expect(pending.find((e) => e.workspaceId === ws)).toBeUndefined();
    }
    expect(await relations()).toHaveLength(expected);
    expect(judged.some((p) => p.includes("Acme Bank"))).toBe(expected === 1);
  });
});
