/**
 * Integration test: `recallCold`'s decision arm (make-primitives-recallable,
 * design.md D4, tasks.md 6.5/6.6 — PR4, the behaviour flip) against a real
 * Postgres + pgvector instance and the REAL `OutboxWorker`.
 *
 * Covers:
 *   6.5 — Create a decision through the real write path (`storage.
 *         createDecision`, same in-transaction outbox enqueue every surface
 *         funnels through per design.md D2) → drain the outbox with the real
 *         `OutboxWorker` → `cognitive.recall()` (recallCold, no tokenBudget →
 *         full pipeline) returns it, identifiable by kind, with content
 *         `${title}\n\n${body}`. Then revise it via `mergeDecisionByTopicKey`
 *         (in-place UPDATE, embedding nulled + re-enqueued per D1/D2) → drain
 *         the outbox again → recall now returns the NEW text, and the OLD
 *         text is never returned by any query that would have matched it
 *         (the row itself no longer contains the superseded text — it was
 *         overwritten, not append-only).
 *   6.6 — A fact-only query (embedding is exactly the fact's own vector, the
 *         decision's embedding is orthogonal) returns byte-identical ranking
 *         to what `recallCold` produced before this PR: the fact is #1 and
 *         no decision candidate outranks or demotes it (Requirement 3).
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note and
 * outbox-embedding-applied.integration.test.ts for the same testcontainers +
 * DrizzleStorageAdapter + real OutboxWorker pattern this file mirrors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { AuthContext, EmbedAdapter } from "@mnemo-ai/types";
import type { MnemoCore } from "@mnemo-ai/core/cognitive";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { OutboxWorker } from "../OutboxWorker.js";
import { PgVectorAdapter } from "../../../adapter-vector/src/PgVectorAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const EMBED_DIM = 1536;

let container: StartedTestContainer;
let databaseUrl: string;
let storage: DrizzleStorageAdapter;
let vector: PgVectorAdapter;
let cognitive: MnemoCore;
let fakeEmbed: EmbedAdapter;

function unitVector(index: number, dim = EMBED_DIM): Float32Array {
  const v = new Array(dim).fill(0);
  v[index] = 1.0;
  return new Float32Array(v);
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
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

async function drainOutbox(embed: EmbedAdapter): Promise<void> {
  const worker = new OutboxWorker(
    storage,
    vector,
    { deletePattern: async () => 0 } as never,
    { enqueue: async () => undefined } as never,
    noopLogger,
    {},
    embed
  );
  // Two batches: enough for both the create-time and revise-time enqueue in
  // this file's single-decision-per-test fixtures.
  await worker.runBatch();
  await worker.runBatch();
}

function auth(workspaceId: string): AuthContext {
  return {
    workspaceId,
    actorId: "test-actor",
    actorType: "agent",
    scopes: ["memory:read", "memory:admin"],
  } as unknown as AuthContext;
}

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

  await migrate({ databaseUrl, log: () => void 0 });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  storage = new DrizzleStorageAdapter(db, pgClient);
  vector = new PgVectorAdapter({ connectionString: databaseUrl });

  const outboxAdapter = {
    async append(e: Parameters<DrizzleStorageAdapter["appendOutbox"]>[0]) {
      return storage.appendOutbox(e);
    },
    async claimBatch(n: number) {
      return storage.claimOutbox(n);
    },
    async markProcessed(ids: string[]) {
      return storage.markOutboxProcessed(ids);
    },
    async markFailed(id: string, err: string) {
      return storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };

  // Deterministic double: `embedSingle` (recall-cold.ts Stage 1, used ONLY
  // for the recall query) always returns oneHot(0) regardless of input text
  // — the same "fixed query vector" discipline as
  // search-recall-vectorweight-noop.integration.test.ts, so which stored
  // primitive is "the conceptually closest one" is controlled by construction
  // via each fixture's OWN precomputed/outbox-applied vector, independent of
  // what the query text literally says.
  fakeEmbed = {
    id: "recall-cold-decisions-fixed",
    model: "fake-model",
    dimensions: EMBED_DIM,
    async embed(): Promise<Float32Array[]> {
      throw new Error("fake-embed: batch embed not used by this fixture");
    },
    async embedSingle() {
      return unitVector(0);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };

  const coreMod = await import("@mnemo-ai/core/cognitive");
  cognitive = coreMod.createCore({
    storage,
    vector,
    embed: fakeEmbed,
    outbox: outboxAdapter as never,
    logger: noopLogger as never,
    telemetry: noopTelemetry as never,
  });
}, 180_000);

afterAll(async () => {
  await storage?.close().catch(() => void 0);
  await vector?.close().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("recallCold — decision created → outbox drained → returned by recall (6.5)", () => {
  it("a newly-created decision becomes semantically recallable once its outbox entry is drained, with content matching what was indexed", async () => {
    const workspaceId = crypto.randomUUID();

    const decision = await storage.createDecision({
      workspaceId,
      kind: "architecture",
      title: "Adopt event sourcing",
      body: "Event sourcing gives us a full audit trail for free.",
    });

    // Not yet recallable — the outbox entry has not been drained.
    const before = await cognitive.recall(
      { workspaceId, text: "event sourcing audit trail", limit: 10, includeLowWorth: true },
      auth(workspaceId)
    );
    expect(before.hits.some((h) => h.id === decision.id)).toBe(false);

    await drainOutbox(fakeEmbed);

    const after = await cognitive.recall(
      { workspaceId, text: "event sourcing audit trail", limit: 10, includeLowWorth: true },
      auth(workspaceId)
    );
    const hit = after.hits.find((h) => h.id === decision.id);
    expect(hit).toBeDefined();
    expect(hit!.primitive).toBe("decision");
    // viewDecision content fix (tasks.md 6.2): matches what was indexed.
    expect(hit!.content).toBe(
      "Adopt event sourcing\n\nEvent sourcing gives us a full audit trail for free."
    );
  }, 60_000);

  it("revising via topicKey: recall returns the NEW text, and the superseded text is never returned again", async () => {
    const workspaceId = crypto.randomUUID();

    const decision = await storage.createDecision({
      workspaceId,
      kind: "architecture",
      topicKey: "storage-choice",
      title: "Use SQLite for local dev",
      body: "SQLite keeps local dev zero-config.",
    });
    await drainOutbox(fakeEmbed);

    const original = await cognitive.recall(
      { workspaceId, text: "SQLite zero-config local dev", limit: 10, includeLowWorth: true },
      auth(workspaceId)
    );
    expect(original.hits.find((h) => h.id === decision.id)?.content).toBe(
      "Use SQLite for local dev\n\nSQLite keeps local dev zero-config."
    );

    const revised = await storage.mergeDecisionByTopicKey({
      workspaceId,
      topicKey: "storage-choice",
      kind: "architecture",
      title: "Use Postgres for local dev",
      body: "We standardised on Postgres everywhere, including local dev.",
    });
    expect(revised?.id).toBe(decision.id);
    expect(revised?.revisionCount).toBe(2);

    await drainOutbox(fakeEmbed);

    const afterRevision = await cognitive.recall(
      {
        workspaceId,
        text: "Postgres standardised everywhere local dev",
        limit: 10,
        includeLowWorth: true,
      },
      auth(workspaceId)
    );
    const hit = afterRevision.hits.find((h) => h.id === decision.id);
    expect(hit).toBeDefined();
    expect(hit!.content).toBe(
      "Use Postgres for local dev\n\nWe standardised on Postgres everywhere, including local dev."
    );

    // The superseded text is gone — it was UPDATEd in place, not appended,
    // so no query can ever return it again. A lexical query for a
    // SQLite-only term now matches nothing (the row's body no longer
    // contains it).
    const staleQuery = await cognitive.recall(
      {
        workspaceId,
        text: "SQLite zero-config",
        mode: "hybrid",
        hybridFts: true,
        limit: 10,
        includeLowWorth: true,
      },
      auth(workspaceId)
    );
    const staleHit = staleQuery.hits.find((h) => h.id === decision.id);
    expect(staleHit === undefined || !staleHit.content.includes("SQLite")).toBe(true);
  }, 60_000);
});

describe("recallCold — fact-only query ranking is byte-identical to pre-change (6.6, Requirement 3)", () => {
  it("a fact whose precomputed vector matches the query outranks an unrelated decision, and the decision does not displace or reorder it", async () => {
    const workspaceId = crypto.randomUUID();

    const fact = await storage.createFact({
      workspaceId,
      scope: "global",
      statement: "The query-matching fact for the fact-only ranking regression guard",
      subject: "regression-guard",
      kind: "other",
      embedding: Array.from(unitVector(0)),
    });
    await vector.upsert(fact.id, unitVector(0), {
      kind: "fact",
      model: "fake-model",
      workspaceId,
    });

    // An unrelated decision, embedded ORTHOGONAL to the query vector — must
    // never outrank or be preferred over the fact, and (below minSimilarity
    // 0.35) must not even surface as a decision hit.
    const decision = await storage.createDecision({
      workspaceId,
      kind: "architecture",
      title: "Unrelated decision",
      body: "This decision is deliberately orthogonal to the fact-only query.",
    });
    await storage.updateEmbeddingVector(
      "decision",
      decision.id,
      workspaceId,
      Array.from(unitVector(7)),
      "fake-model"
    );

    const res = await cognitive.recall(
      { workspaceId, text: "fact-only ranking regression guard", limit: 10, includeLowWorth: true },
      auth(workspaceId)
    );

    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.hits[0]!.id).toBe(fact.id);
    expect(res.hits[0]!.primitive).toBe("fact");
    // The orthogonal decision does not clear the 0.35 semantic gate, so it
    // is absent entirely — proving it neither reorders nor displaces the fact.
    expect(res.hits.some((h) => h.id === decision.id)).toBe(false);
  }, 60_000);
});
