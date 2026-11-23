/**
 * Regression pin for Task 6 (outbox → embedding gap audit).
 *
 * History: a fact's embedding was not reliably applied after remember()/
 * createFact(). Two distinct defects were suspected:
 *
 *   1. ENQUEUE gap — the fact-creation path never appended a `vector_upsert`
 *      outbox row at all. Fixed by commit 2aa94a76 ("fix(core): enqueue
 *      vector_upsert outbox event in createFact primitive").
 *
 *   2. PROCESSING gap — OutboxWorker.processVectorUpsert() used to
 *      `logger.warn(...); return;` on its unfulfillable branches (text-form
 *      payload with no embedder injected, payload with neither vector nor
 *      text, non-fact vector without a model stamp), so the caller's
 *      Promise.allSettled → markOutboxProcessed stamped the entry processed
 *      with no embedding applied. Those branches now throw, routing the
 *      entry through markOutboxFailed → retry → dead-letter reaper. The
 *      second test below pins the no-embedder case: a text-form entry
 *      drained by a worker booted without an embed provider (the
 *      server/src/index.ts embedProvider=undefined wiring) must NOT be
 *      marked processed.
 *
 * flatten-legacy-dual-core Phase 7: originally seeded facts via the legacy
 * `CoreLike.createFact` (`@mnemo-ai/core`'s deleted `createCore().createFact`
 * facade → `primitives/fact.ts#createFact`) — that facade's only production
 * caller (`POST /facts`) was itself deleted in PR8 (D2), so every route this
 * header used to cite (capture.ts/facts.ts/grpc.ts/events.ts/conflicts.ts)
 * has been on the v3 write path (`DrizzleStorageAdapter.createFact` via
 * `deps.cognitive.remember`/`deps.storage`) since well before this Phase.
 * Re-seeded via `storage.createFact` (`FactRepository`, adapter-postgres)
 * directly — same text-form-outbox-payload behavior, proven independently
 * by `fact-outbox-payload.integration.test.ts`'s defect-1 coverage — so this
 * file's defect-2 (`OutboxWorker` no-embedder) coverage, which is NOT
 * `CoreLike`-specific, survives unchanged.
 *
 * This test drives the REAL end-to-end path for defect (1): create a fact
 * through `DrizzleStorageAdapter.createFact` (`FactRepository`) WITHOUT a
 * precomputed embedding, so the fact is inserted with embedding=NULL and
 * the outbox gets a text-form vector_upsert payload — the exact shape that
 * was silently dropped before 2aa94a76. Then it runs the REAL OutboxWorker
 * (packages/adapter-postgres/src/OutboxWorker.ts) against the same
 * database, with a double embed adapter (external service — fair to fake
 * per the task instructions), and asserts BOTH:
 *
 *   (a) the outbox row is processed (processed_at set), AND
 *   (b) mnemosyne.mnemo_fact.embedding IS NOT NULL for that fact.
 *
 * The double assertion is the whole point: the historical bug was (a) true
 * with (b) false.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { EmbedAdapter } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { OutboxWorker } from "../OutboxWorker.js";
import { PgVectorAdapter } from "../../../adapter-vector/src/PgVectorAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;
let sql: ReturnType<typeof postgres>;
let storageClient: ReturnType<typeof createDrizzleClient>;
let storage: DrizzleStorageAdapter;
let vector: PgVectorAdapter;

/** Deterministic fixed-magnitude 1536-dim vector — the embed provider is an
 * external service, so a double returning a fixed vector is fair game per
 * the task instructions. */
const FAKE_EMBEDDING = new Float32Array(1536).fill(0.125);

const embedDouble: EmbedAdapter = {
  id: "outbox-embedding-test-double",
  model: "test-embed-model",
  dimensions: 1536,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => FAKE_EMBEDDING);
  },
  async embedSingle(): Promise<Float32Array> {
    return FAKE_EMBEDDING;
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  sql = postgres(databaseUrl, { max: 5 });

  // Real storage adapter + real vector adapter, same container — this is
  // exactly what the production OutboxWorker is constructed with in
  // packages/server/src/index.ts (owStorage / owVector).
  storageClient = createDrizzleClient(databaseUrl);
  storage = new DrizzleStorageAdapter(storageClient.db, storageClient.pgClient);
  vector = new PgVectorAdapter({ connectionString: databaseUrl });
}, 120_000);

afterAll(async () => {
  await storage?.close().catch(() => void 0);
  await vector?.close().catch(() => void 0);
  await sql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("outbox vector_upsert: processed implies applied (real createFact -> real OutboxWorker)", () => {
  it("embeds a fact created via storage.createFact (no precomputed vector) once the outbox is drained", async () => {
    const workspaceId = crypto.randomUUID();

    // Mirrors the production v3 write path exactly (deps.cognitive.remember /
    // deps.storage.createFact): no `embedding` field, so FactRepository takes
    // the text-form outbox payload branch instead of a precomputed vector-form one.
    const fact = await storage.createFact({
      workspaceId,
      scope: "global",
      statement: "The outbox worker must actually embed facts it claims to process",
      subject: "outbox-regression",
      kind: "other",
      metadata: { source: "outbox-embedding-applied.integration.test" },
    });

    // Sanity: freshly inserted fact has no embedding yet — everything from
    // here on is the async outbox path's responsibility.
    const [beforeRow] = await sql<Array<{ embedding: string | null }>>`
      SELECT embedding::text AS embedding
      FROM mnemosyne.mnemo_fact
      WHERE id = ${fact.id} AND workspace_id = ${workspaceId}
    `;
    expect(beforeRow?.embedding).toBeNull();

    // The outbox row must exist and be unprocessed, carrying a text-form
    // payload (the shape 2aa94a76 fixed the ENQUEUE side for).
    const [outboxBefore] = await sql<
      Array<{
        id: string;
        payload: Record<string, unknown>;
        processed_at: Date | null;
      }>
    >`
      SELECT id, payload, processed_at
      FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${workspaceId}
        AND event_type = 'vector_upsert'
        AND (payload->>'id') = ${fact.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(
      outboxBefore,
      "createFact must enqueue a vector_upsert outbox row (defect 1 regression)"
    ).toBeDefined();
    expect(outboxBefore?.processed_at).toBeNull();
    expect(outboxBefore?.payload.text).toBe(
      "The outbox worker must actually embed facts it claims to process"
    );
    expect(outboxBefore?.payload.vector).toBeUndefined();

    // Run the REAL OutboxWorker — same class, same wiring shape (storage +
    // vector + cache + queue + logger + embed) as production server boot.
    const worker = new OutboxWorker(
      storage,
      vector,
      { deletePattern: async () => 0 } as never,
      { enqueue: async () => undefined } as never,
      {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      },
      {},
      embedDouble
    );

    const processedCount = await worker.runBatch();
    expect(processedCount).toBeGreaterThanOrEqual(1);

    // Assertion (a): the outbox entry is marked processed.
    const [outboxAfter] = await sql<
      Array<{ processed_at: Date | null; attempts: number; last_error: string | null }>
    >`
      SELECT processed_at, attempts, last_error
      FROM mnemosyne.mnemo_outbox
      WHERE id = ${outboxBefore!.id}
    `;
    expect(outboxAfter?.last_error).toBeNull();
    expect(outboxAfter?.processed_at).not.toBeNull();

    // Assertion (b): the embedding was actually applied to mnemo_fact —
    // this is the assertion the historical bug would have failed even
    // though (a) held.
    const [afterRow] = await sql<
      Array<{ embedding: string | null; embedding_model: string | null }>
    >`
      SELECT embedding::text AS embedding, embedding_model
      FROM mnemosyne.mnemo_fact
      WHERE id = ${fact.id} AND workspace_id = ${workspaceId}
    `;
    expect(afterRow?.embedding).not.toBeNull();
    expect(afterRow?.embedding_model).toBe("test-embed-model");
    const firstValue = Number(afterRow?.embedding?.match(/^\[([^,]+)/)?.[1]);
    expect(firstValue).toBeCloseTo(FAKE_EMBEDDING[0]!, 3);
  });

  it("does NOT mark a text-form entry processed when the worker has no embedder (defect 2 regression)", async () => {
    const workspaceId = crypto.randomUUID();

    const fact = await storage.createFact({
      workspaceId,
      scope: "global",
      statement: "A worker without an embedder must fail this entry, not ack it",
      subject: "outbox-regression",
      kind: "other",
      metadata: { source: "outbox-embedding-applied.integration.test" },
    });

    const [outboxBefore] = await sql<Array<{ id: string; attempts: number }>>`
      SELECT id, attempts
      FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${workspaceId}
        AND event_type = 'vector_upsert'
        AND (payload->>'id') = ${fact.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(outboxBefore).toBeDefined();

    // Same wiring as production when server/src/index.ts resolves
    // embedProvider to undefined: the OutboxWorker is constructed WITHOUT an
    // embed adapter (7th ctor arg omitted).
    const workerWithoutEmbedder = new OutboxWorker(
      storage,
      vector,
      { deletePattern: async () => 0 } as never,
      { enqueue: async () => undefined } as never,
      {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      },
      {}
    );

    await workerWithoutEmbedder.runBatch();

    // The invariant under test: "processed ⇒ embedding applied". With no
    // embedder the embedding CANNOT be applied, so the entry must NOT be
    // marked processed — it must take the markOutboxFailed retry path.
    const [outboxAfter] = await sql<
      Array<{
        processed_at: Date | null;
        attempts: number;
        last_error: string | null;
      }>
    >`
      SELECT processed_at, attempts, last_error
      FROM mnemosyne.mnemo_outbox
      WHERE id = ${outboxBefore!.id}
    `;
    expect(
      outboxAfter?.processed_at,
      "entry must not be acked without applying the embedding"
    ).toBeNull();
    expect(outboxAfter?.attempts).toBe(outboxBefore!.attempts + 1);
    expect(outboxAfter?.last_error).toMatch(/embedder/i);

    const [factRow] = await sql<Array<{ embedding: string | null }>>`
      SELECT embedding::text AS embedding
      FROM mnemosyne.mnemo_fact
      WHERE id = ${fact.id} AND workspace_id = ${workspaceId}
    `;
    expect(factRow?.embedding).toBeNull();

    // Recoverability: the failed entry stays claimable (after its backoff),
    // so a correctly-wired worker drains it and applies the embedding.
    // Clear the backoff stamp instead of sleeping through it.
    await sql`
      UPDATE mnemosyne.mnemo_outbox
      SET next_attempt_at = NULL
      WHERE id = ${outboxBefore!.id}
    `;

    const workerWithEmbedder = new OutboxWorker(
      storage,
      vector,
      { deletePattern: async () => 0 } as never,
      { enqueue: async () => undefined } as never,
      {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      },
      {},
      embedDouble
    );
    await workerWithEmbedder.runBatch();

    const [recovered] = await sql<Array<{ processed_at: Date | null }>>`
      SELECT processed_at FROM mnemosyne.mnemo_outbox WHERE id = ${outboxBefore!.id}
    `;
    expect(recovered?.processed_at).not.toBeNull();

    const [factAfter] = await sql<Array<{ embedding: string | null }>>`
      SELECT embedding::text AS embedding
      FROM mnemosyne.mnemo_fact
      WHERE id = ${fact.id} AND workspace_id = ${workspaceId}
    `;
    expect(factAfter?.embedding).not.toBeNull();
  });
});
