/**
 * WP-5 (fact integrity) — real-Postgres proofs, run as a NOSUPERUSER
 * NOBYPASSRLS login role that only inherits `mnemo_app_role`, the way
 * production runs as `mnemo_app` under FORCE RLS. The superuser connection is
 * used only to migrate, seed timestamps and read back raw rows.
 *
 *   - PRIM-3 / CHAOS-8: forget → restore → forget, repeated and concurrent
 *     archives (mnemo_fact_archive primary-key collisions used to 500).
 *   - CHAOS-8: concurrent PATCHes lost revisions and history; the prior
 *     revision is now kept in mnemo_fact_revision and stale preconditions fail.
 *   - PRIM-4: edited and restored facts are re-embedded through the outbox,
 *     late vector jobs cannot undo a newer state, and the repair job sees
 *     open facts without a vector.
 *   - PRIM-8: keyset pagination over timestamps that differ only in
 *     microseconds; the caller's ceiling filters rows AND `total`.
 *   - PRIM-16 (facts): closed rows stay out of the default list.
 *   - RECALL-7: `GET /facts?q=` falls back to a relaxed match for questions.
 *   - CHAOS-5: a fact stored without a vector (embedder down) is findable by
 *     FTS at once and embedded, LSH bands included, by the outbox worker.
 *   - CHAOS-7: a lost `uniq_mnemo_fact_dedup` race is recognisable and the
 *     winner can be read back by its dedup key.
 *
 * Requires Docker — run with Node 22:
 *   pnpm --filter @mnemo-ai/adapter-postgres exec vitest run \
 *     --config vitest.integration.config.ts src/__tests__/integration/fact-integrity.integration.test.ts
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { FactRevisionConflictError, type EmbedAdapter } from "@mnemo-ai/types";
import { createDrizzleClient, DrizzleStorageAdapter } from "../../DrizzleStorageAdapter.js";
import { migrate } from "../../migrate.js";
import { OutboxWorker } from "../../OutboxWorker.js";
import { PgVectorAdapter } from "../../../../adapter-vector/src/PgVectorAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "fact_integrity_app";
const APP_PASSWORD = "fact_integrity_app_pass";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let superUrl: string;
let appUrl: string;
let appClient: ReturnType<typeof createDrizzleClient>;
let storage: DrizzleStorageAdapter;
let vector: PgVectorAdapter;
let superClient: ReturnType<typeof createDrizzleClient>;
let superStorage: DrizzleStorageAdapter;

const MODEL = "fact-integrity-embed";
const FAKE_EMBEDDING = new Float32Array(1536).fill(0.125);
const embedDouble: EmbedAdapter = {
  id: "fact-integrity-embed-double",
  model: MODEL,
  dimensions: 1536,
  async embed(texts: string[]) {
    return texts.map(() => FAKE_EMBEDDING);
  },
  async embedSingle() {
    return FAKE_EMBEDDING;
  },
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  },
};
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
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
  superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => undefined });

  admin = postgres(superUrl, { max: 3, onnotice: () => undefined });
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
  `);
  appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  appClient = createDrizzleClient(appUrl);
  storage = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
  vector = new PgVectorAdapter({ connectionString: appUrl });
  // The outbox claim spans workspaces (no GUC); only the worker's claim runs
  // as the superuser — every write it applies goes through the app-role
  // vector adapter above.
  superClient = createDrizzleClient(superUrl);
  superStorage = new DrizzleStorageAdapter(superClient.db, superClient.pgClient);
}, 180_000);

afterAll(async () => {
  await vector?.close().catch(() => undefined);
  await superClient?.pgClient.end().catch(() => undefined);
  await appClient?.pgClient.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

async function seedFact(
  workspaceId: string,
  statement: string,
  extra: Record<string, unknown> = {}
) {
  return storage.createFact({
    workspaceId,
    scope: "global",
    statement,
    subject: "fact-integrity",
    kind: "other",
    sensitivity: "internal",
    ...extra,
  });
}

async function outboxCount(workspaceId: string, factId: string, eventType: string) {
  const rows = await admin<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_outbox
    WHERE workspace_id = ${workspaceId} AND event_type = ${eventType}
      AND payload->>'id' = ${factId}
  `;
  return rows[0]!.n;
}

describe("PRIM-3 / CHAOS-8 — archiving is repeatable and serialized", () => {
  it("survives two forget → restore cycles and keeps the latest snapshot", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "forget restore forget cycle fixture");

    for (let cycle = 0; cycle < 2; cycle++) {
      await expect(storage.archiveFact(fact.id, ws)).resolves.toBe(true);
      const restored = await storage.updateFact(fact.id, ws, { status: "active", validTo: null });
      expect(restored).toMatchObject({ status: "active" });
    }
    await expect(storage.archiveFact(fact.id, ws)).resolves.toBe(true);

    const [live] = await admin<Array<{ status: string; valid_to: Date | null }>>`
      SELECT status, valid_to FROM mnemosyne.mnemo_fact WHERE id = ${fact.id}
    `;
    expect(live).toMatchObject({ status: "forgotten" });
    expect(live!.valid_to).not.toBeNull();

    const archived = await admin<Array<{ valid_to: Date; status: string }>>`
      SELECT valid_to, status FROM mnemosyne.mnemo_fact_archive WHERE id = ${fact.id}
    `;
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status).toBe("forgotten");
    expect(archived[0]!.valid_to.getTime()).toBe(live!.valid_to!.getTime());
    expect(await outboxCount(ws, fact.id, "vector_delete")).toBe(3);
  });

  it("reports no transition and writes nothing when the fact is already closed", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "already closed fixture");
    await expect(storage.archiveFact(fact.id, ws)).resolves.toBe(true);
    await expect(storage.archiveFact(fact.id, ws)).resolves.toBe(false);
    await expect(storage.archiveFact(crypto.randomUUID(), ws)).resolves.toBe(false);
    expect(await outboxCount(ws, fact.id, "vector_delete")).toBe(1);
  });

  it("lets exactly one of five concurrent archives win, without errors", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "concurrent archive fixture");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => storage.archiveFact(fact.id, ws))
    );
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(4);
    expect(await outboxCount(ws, fact.id, "vector_delete")).toBe(1);
    const archived = await admin`SELECT 1 FROM mnemosyne.mnemo_fact_archive WHERE id = ${fact.id}`;
    expect(archived).toHaveLength(1);
  });
});

async function drainOutbox(): Promise<void> {
  const worker = new OutboxWorker(
    superStorage,
    vector,
    { deletePattern: async () => 0 } as never,
    { enqueue: async () => undefined } as never,
    silentLogger,
    {},
    embedDouble
  );
  for (let i = 0; i < 10; i++) {
    if ((await worker.runBatch()) === 0) break;
  }
}

async function factRow(id: string) {
  const [row] = await admin<
    Array<{
      statement: string;
      revision_count: number;
      embedding: string | null;
      embedding_stale: boolean;
      status: string;
      valid_to: Date | null;
    }>
  >`
    SELECT statement, revision_count, embedding::text AS embedding, embedding_stale, status, valid_to
    FROM mnemosyne.mnemo_fact WHERE id = ${id}
  `;
  return row!;
}

async function upsertJobs(workspaceId: string, factId: string) {
  return admin<Array<{ payload: { text?: string; revision?: number; vector?: unknown } }>>`
    SELECT payload FROM mnemosyne.mnemo_outbox
    WHERE workspace_id = ${workspaceId} AND event_type = 'vector_upsert'
      AND payload->>'id' = ${factId}
    ORDER BY created_at
  `;
}

describe("CHAOS-8 — concurrent PATCH keeps every revision", () => {
  it("serializes five concurrent statement edits: revision 1 → 6 with five history rows", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "the cron fires at 200");
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        storage.updateFact(fact.id, ws, { statement: `the cron fires at 20${n}` })
      )
    );
    expect(results.every((r) => r !== null)).toBe(true);

    const live = await factRow(fact.id);
    expect(live.revision_count).toBe(6);
    const history = await admin<Array<{ revision: number; statement: string }>>`
      SELECT revision, statement FROM mnemosyne.mnemo_fact_revision
      WHERE fact_id = ${fact.id} ORDER BY revision
    `;
    expect(history.map((h) => h.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(history[0]!.statement).toBe("the cron fires at 200");
    // Every statement written survives: four in history plus the live one.
    const written = new Set([...history.slice(1).map((h) => h.statement), live.statement]);
    expect(written).toEqual(new Set([1, 2, 3, 4, 5].map((n) => `the cron fires at 20${n}`)));

    const revisions = (await upsertJobs(ws, fact.id))
      .map((j) => j.payload.revision)
      .filter((r) => r !== 1);
    expect(revisions.sort()).toEqual([2, 3, 4, 5, 6]);
  });

  it("rejects a stale expectedRevision without touching the row", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "precondition fixture v1");
    await storage.updateFact(fact.id, ws, { statement: "precondition fixture v2" });

    await expect(
      storage.updateFact(fact.id, ws, { statement: "stale writer", expectedRevision: 1 })
    ).rejects.toBeInstanceOf(FactRevisionConflictError);

    const live = await factRow(fact.id);
    expect(live).toMatchObject({ statement: "precondition fixture v2", revision_count: 2 });
    const history =
      await admin`SELECT 1 FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`;
    expect(history).toHaveLength(1);

    await expect(
      storage.updateFact(fact.id, ws, { statement: "fresh writer", expectedRevision: 2 })
    ).resolves.toMatchObject({ statement: "fresh writer", revisionCount: 3 });
  });

  it("drops the history with the fact on a hard delete (erasure leaves no copy)", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "erasure fixture v1");
    await storage.updateFact(fact.id, ws, { statement: "erasure fixture v2" });
    await storage.hardDeleteFact(fact.id, ws);
    const history =
      await admin`SELECT 1 FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`;
    expect(history).toHaveLength(0);
  });

  it("isolates history rows by workspace under RLS", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "rls history fixture v1");
    await storage.updateFact(fact.id, ws, { statement: "rls history fixture v2" });
    const other = crypto.randomUUID();
    const seen = await appClient.pgClient.begin(async (tx) => {
      await tx`SELECT set_config('mnemosyne.workspace_id', ${other}, true)`;
      return tx`SELECT 1 FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`;
    });
    expect(seen).toHaveLength(0);
  });
});

describe("PRIM-4 — edits and restores are re-embedded", () => {
  it("re-embeds a PATCHed statement through the outbox", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "embedding fixture before edit");
    await drainOutbox();
    expect((await factRow(fact.id)).embedding).not.toBeNull();

    const updated = await storage.updateFact(fact.id, ws, {
      statement: "embedding fixture after edit",
    });
    expect((await factRow(fact.id)).embedding_stale).toBe(true);
    const jobs = await upsertJobs(ws, fact.id);
    expect(jobs.at(-1)!.payload).toMatchObject({
      text: "embedding fixture after edit",
      revision: updated!.revisionCount,
    });

    await drainOutbox();
    const after = await factRow(fact.id);
    expect(after.embedding).not.toBeNull();
    expect(after.embedding_stale).toBe(false);
    const hits = await vector.search({ workspaceId: ws, vector: FAKE_EMBEDDING, limit: 5 });
    expect(hits.map((h) => h.id)).toContain(fact.id);
  });

  // Review round: a metadata-only update bumps the revision, and the pending
  // job (tagged with the previous revision) is then fenced out by the worker.
  it("keeps a pending re-embed alive across a later metadata-only edit", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "pending re-embed fixture before");
    await drainOutbox();
    await storage.updateFact(fact.id, ws, { statement: "pending re-embed fixture after" });
    await storage.updateFact(fact.id, ws, { pinned: true });
    await storage.updateFact(fact.id, ws, { confidence: 0.9 });
    await drainOutbox();
    const after = await factRow(fact.id);
    expect(after.embedding).not.toBeNull();
    expect(after.embedding_stale).toBe(false);
  });

  it("keeps a deferred first embedding alive across a later metadata-only edit", async () => {
    const ws = crypto.randomUUID();
    const fact = await storage.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "deferred embedding then pinned fixture",
      subject: "general",
      kind: "other",
      vectorJob: { indexLsh: true },
    });
    await storage.updateFact(fact.id, ws, { pinned: true });
    await drainOutbox();
    expect((await factRow(fact.id)).embedding).not.toBeNull();
    const bands = await admin`SELECT 1 FROM mnemosyne.mnemo_fact_lsh WHERE fact_id = ${fact.id}`;
    expect(bands.length).toBeGreaterThan(0);
  });

  it("re-embeds a restored fact, and the late delete from its forget cannot erase it", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "restore embedding fixture");
    await drainOutbox();
    await storage.archiveFact(fact.id, ws);
    // The forget's vector_delete is still queued when the restore lands.
    const restored = await storage.updateFact(fact.id, ws, { status: "active", validTo: null });
    const jobs = await upsertJobs(ws, fact.id);
    expect(jobs.at(-1)!.payload).toMatchObject({
      text: "restore embedding fixture",
      revision: restored!.revisionCount,
    });

    await drainOutbox(); // claims in order: delete (fenced: row is open), then upsert
    const after = await factRow(fact.id);
    expect(after.embedding).not.toBeNull();
    expect(after.embedding_stale).toBe(false);

    // A delete processed AFTER the restore's upsert must not erase it either.
    await vector.delete(fact.id, ws);
    expect((await factRow(fact.id)).embedding).not.toBeNull();
  });

  it("does not let a late upsert re-index a forgotten fact", async () => {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "late upsert fixture");
    await drainOutbox();
    await storage.archiveFact(fact.id, ws);
    await drainOutbox();
    expect((await factRow(fact.id)).embedding).toBeNull();

    const live = await factRow(fact.id);
    await vector.upsert(fact.id, FAKE_EMBEDDING, {
      workspaceId: ws,
      revision: live.revision_count,
      model: MODEL,
    });
    expect((await factRow(fact.id)).embedding).toBeNull();
  });

  // Review round: the first version of this test rewrote every fixture to
  // `embedding_stale = false` with the current model, which hid that the OTHER
  // branches of the OR (stale, NULL model) still let closed and encrypted rows
  // through. Fixtures are now left exactly as the write paths leave them.
  it("offers open plaintext facts without a vector to the repair job, never closed or encrypted ones", async () => {
    const ws = crypto.randomUUID();
    const dek = Buffer.alloc(32, 5);
    const sensitive = new DrizzleStorageAdapter(
      appClient.db,
      appClient.pgClient,
      (_ws, _actor, wrapped) => Buffer.from(wrapped, "base64"),
      () => ({ dek, wrapped: dek.toString("base64") })
    );
    // Restored plaintext fact: stale, vector cleared → must be offered.
    const restoredPlain = await seedFact(ws, "repair restored plaintext fixture");
    await drainOutbox();
    await storage.archiveFact(restoredPlain.id, ws);
    await drainOutbox();
    await storage.updateFact(restoredPlain.id, ws, { status: "active", validTo: null });
    // Deferred plaintext fact: no vector, no model → must be offered.
    const deferred = await seedFact(ws, "repair deferred plaintext fixture");
    // Closed plaintext fact, never embedded → must NOT be offered.
    const closed = await seedFact(ws, "repair closed plaintext fixture");
    await storage.archiveFact(closed.id, ws);
    // Confidential fact, never embedded (no model) → must NOT be offered.
    const secret = await sensitive.createFact({
      workspaceId: ws,
      actorId: "key:repair",
      scope: "global",
      statement: "repair confidential fixture",
      subject: "general",
      kind: "other",
      sensitivity: "confidential",
    });
    // Confidential fact forgotten and restored → stale → must NOT be offered.
    const secretRestored = await sensitive.createFact({
      workspaceId: ws,
      actorId: "key:repair",
      scope: "global",
      statement: "repair confidential restored fixture",
      subject: "general",
      kind: "other",
      sensitivity: "confidential",
    });
    await sensitive.archiveFact(secretRestored.id, ws);
    await sensitive.updateFact(secretRestored.id, ws, { status: "active", validTo: null });

    const ids = (await storage.listStaleEmbeddings("fact", ws, MODEL, 50)).map((c) => c.id);
    expect(ids).toContain(restoredPlain.id);
    expect(ids).toContain(deferred.id);
    expect(ids).not.toContain(closed.id);
    expect(ids).not.toContain(secret.id);
    expect(ids).not.toContain(secretRestored.id);
  });
});

async function stampUpdatedAt(id: string, createdAt: string, updatedAt: string) {
  await admin`ALTER TABLE mnemosyne.mnemo_fact DISABLE TRIGGER mnemo_fact_updated_at`;
  try {
    await admin`
      UPDATE mnemosyne.mnemo_fact
      SET created_at = ${createdAt}::text::timestamptz, updated_at = ${updatedAt}::text::timestamptz
      WHERE id = ${id}
    `;
  } finally {
    await admin`ALTER TABLE mnemosyne.mnemo_fact ENABLE TRIGGER mnemo_fact_updated_at`;
  }
}

describe("PRIM-8 — keyset pagination keeps microsecond precision", () => {
  // Eight rows, five of them inside one millisecond (.412xxx): the cursor used
  // to carry `toISOString()` (milliseconds) and skip or repeat those rows.
  const stamps = [
    "2026-10-17 16:55:21.412266+00",
    "2026-10-17 16:55:21.412300+00",
    "2026-10-17 16:55:21.412500+00",
    "2026-10-17 16:55:21.412818+00",
    "2026-10-17 16:55:21.412999+00",
    "2026-10-17 16:55:21.413000+00",
    "2026-10-17 16:55:20.000001+00",
    "2026-10-17 16:55:22.999999+00",
  ];

  it.each([
    { sortBy: "updated_at" as const, order: "desc" as const },
    { sortBy: "updated_at" as const, order: "asc" as const },
    { sortBy: "created_at" as const, order: "desc" as const },
    { sortBy: "created_at" as const, order: "asc" as const },
  ])("walks every row exactly once ($sortBy $order, pages of 3)", async ({ sortBy, order }) => {
    const ws = crypto.randomUUID();
    for (const [i, stamp] of stamps.entries()) {
      const fact = await seedFact(ws, `pagination precision fixture ${i}`);
      await stampUpdatedAt(fact.id, stamp, stamp);
    }
    // Guard the fixture: a timestamptz-typed parameter would be serialized
    // through a JS Date and lose the microseconds this test is about.
    const stored = await admin<Array<{ u: string }>>`
      SELECT updated_at::text AS u FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${ws} AND updated_at::text LIKE '%.412818%'`;
    expect(stored).toHaveLength(1);
    const column = sortBy === "updated_at" ? admin`updated_at` : admin`created_at`;
    const expected = (
      order === "desc"
        ? await admin<Array<{ id: string }>>`
            SELECT id FROM mnemosyne.mnemo_fact WHERE workspace_id = ${ws}
            ORDER BY ${column} DESC, id DESC`
        : await admin<Array<{ id: string }>>`
            SELECT id FROM mnemosyne.mnemo_fact WHERE workspace_id = ${ws}
            ORDER BY ${column} ASC, id ASC`
    ).map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await storage.queryFactsPage({
        workspaceId: ws,
        sortBy,
        order,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.total).toBe(stamps.length);
      seen.push(...page.items.map((f) => f.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expected);
  });

  it("applies the caller's ceiling to the rows AND to total", async () => {
    const ws = crypto.randomUUID();
    await seedFact(ws, "ceiling visible fixture one");
    await seedFact(ws, "ceiling visible fixture two");
    const hidden = await seedFact(ws, "ceiling hidden fixture");
    // Encrypting needs a DEK; the ceiling only looks at the column.
    await admin`UPDATE mnemosyne.mnemo_fact SET sensitivity = 'restricted' WHERE id = ${hidden.id}`;

    const page = await storage.queryFactsPage({
      workspaceId: ws,
      limit: 2,
      maxSensitivity: "internal",
    });
    expect(page.total).toBe(2);
    expect(page.items.map((f) => f.id)).not.toContain(hidden.id);
    expect(page.nextCursor).toBeNull();
  });
});

describe("PRIM-16 (facts) — the default list holds only current rows", () => {
  it("hides an 'active' row whose validity already ended unless includeClosed", async () => {
    const ws = crypto.randomUUID();
    const live = await seedFact(ws, "current list fixture live");
    const ended = await seedFact(ws, "current list fixture ended");
    // The shape PRIM-15's import produced: status active, valid_to in the past.
    await admin`
      UPDATE mnemosyne.mnemo_fact
      SET valid_from = now() - interval '2 days', valid_to = now() - interval '1 day'
      WHERE id = ${ended.id}
    `;

    const current = await storage.queryFactsPage({ workspaceId: ws, limit: 10, currentOnly: true });
    expect(current.items.map((f) => f.id)).toEqual([live.id]);
    expect(current.total).toBe(1);

    const all = await storage.queryFactsPage({ workspaceId: ws, limit: 10, status: "all" });
    expect(all.items.map((f) => f.id).sort()).toEqual([live.id, ended.id].sort());
  });
});

describe("RECALL-7 — GET /facts?q= relaxes a question that matches nothing strictly", () => {
  it("finds the fact for a natural-language question, and stays strict when strict matches", async () => {
    const ws = crypto.randomUUID();
    const target = await seedFact(ws, "The payments service runs Postgres 16 on Amazon RDS");
    await seedFact(ws, "The billing dashboard is deployed with ArgoCD");

    const strictMiss = await storage.queryFactsPage({
      workspaceId: ws,
      limit: 10,
      q: "which postgres version does the payments service run",
    });
    expect(strictMiss.items.map((f) => f.id)).toEqual([target.id]);
    expect(strictMiss.total).toBe(1);

    const strictHit = await storage.queryFactsPage({ workspaceId: ws, limit: 10, q: "ArgoCD" });
    expect(strictHit.items).toHaveLength(1);
    expect(strictHit.items[0]!.statement).toContain("ArgoCD");
  });
});

describe("CHAOS-5 — a fact stored without a vector is embedded later", () => {
  it("is FTS-findable at once and gets its vector and LSH bands from the worker", async () => {
    const ws = crypto.randomUUID();
    const fact = await storage.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "the settlement batch closes at 23:30 UTC",
      subject: "general",
      kind: "other",
      vectorJob: { indexLsh: true },
    });
    expect((await factRow(fact.id)).embedding).toBeNull();
    const lexical = await storage.queryFactsPage({
      workspaceId: ws,
      limit: 5,
      q: "settlement batch",
    });
    expect(lexical.items.map((f) => f.id)).toEqual([fact.id]);
    const jobs = await upsertJobs(ws, fact.id);
    expect(jobs[0]!.payload).toMatchObject({
      text: "the settlement batch closes at 23:30 UTC",
      indexLsh: true,
    });

    await drainOutbox();
    expect((await factRow(fact.id)).embedding).not.toBeNull();
    const bands = await admin`SELECT 1 FROM mnemosyne.mnemo_fact_lsh WHERE fact_id = ${fact.id}`;
    expect(bands.length).toBeGreaterThan(0);
  });

  it("never queues the ciphertext of a confidential fact for embedding", async () => {
    const ws = crypto.randomUUID();
    const dek = Buffer.alloc(32, 9);
    const sensitive = new DrizzleStorageAdapter(
      appClient.db,
      appClient.pgClient,
      (_ws, _actor, wrapped) => Buffer.from(wrapped, "base64"),
      () => ({ dek, wrapped: dek.toString("base64") })
    );
    const fact = await sensitive.createFact({
      workspaceId: ws,
      actorId: "key:sensitive",
      scope: "global",
      statement: "the vault recovery phrase is kept offline",
      subject: "general",
      kind: "other",
      sensitivity: "confidential",
    });
    expect(await upsertJobs(ws, fact.id)).toHaveLength(0);
  });
});

describe("CHAOS-7 — the dedup race is recognisable and its winner readable", () => {
  it("names uniq_mnemo_fact_dedup on the losing insert and finds the winner by its key", async () => {
    const ws = crypto.randomUUID();
    const input = {
      workspaceId: ws,
      scope: "global" as const,
      statement: "the deploy window is friday at 14:00",
      subject: "general",
      kind: "other" as const,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => storage.createFact(input))
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost.length).toBe(4);
    for (const failure of lost) {
      const cause = (failure.reason as { cause?: { code?: string; constraint_name?: string } })
        .cause;
      expect(cause).toMatchObject({ code: "23505", constraint_name: "uniq_mnemo_fact_dedup" });
    }

    const winner = await storage.findLiveFactByStatement({
      workspaceId: ws,
      scope: "global",
      subject: "general",
      statement: "the deploy window is friday at 14:00",
    });
    expect(winner?.id).toBe((won[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    await expect(
      storage.findLiveFactByStatement({ ...input, scopeRef: "other-project" })
    ).resolves.toBeNull();
  });
});

describe("WP-4 request — a topic-key merge can re-home its successor's provenance", () => {
  it("takes the new sessionId and extractionSource and drops the old episode link", async () => {
    const ws = crypto.randomUUID();
    const episodeId = `mepi_${crypto.randomUUID()}`;
    await admin`
      INSERT INTO mnemosyne.mnemo_episode (id, workspace_id, title, narrative, occurred_at)
      VALUES (${episodeId}, ${ws}, ${"old episode"}, ${"x"}, now())
    `;
    const original = await storage.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "the gateway timeout is 30s",
      subject: "general",
      kind: "other",
      topicKey: "infra/gateway",
      sessionId: "session-old",
    });
    await admin`UPDATE mnemosyne.mnemo_fact SET episode_id = ${episodeId} WHERE id = ${original.id}`;

    const successor = await storage.mergeFactByTopicKey({
      workspaceId: ws,
      topicKey: "infra/gateway",
      statement: "the gateway timeout is 45s",
      sessionId: "session-new",
      extractionSource: "collapse",
    });
    expect(successor).not.toBeNull();
    const [row] = await admin<
      Array<{
        session_id: string | null;
        episode_id: string | null;
        extraction_source: string | null;
      }>
    >`SELECT session_id, episode_id, extraction_source FROM mnemosyne.mnemo_fact WHERE id = ${successor!.id}`;
    expect(row).toEqual({
      session_id: "session-new",
      episode_id: null,
      extraction_source: "collapse",
    });
  });

  it("keeps inheriting both when no sessionId is given", async () => {
    const ws = crypto.randomUUID();
    await storage.createFact({
      workspaceId: ws,
      scope: "global",
      statement: "the queue is kafka",
      subject: "general",
      kind: "other",
      topicKey: "infra/queue",
      sessionId: "session-keep",
    });
    const successor = await storage.mergeFactByTopicKey({
      workspaceId: ws,
      topicKey: "infra/queue",
      statement: "the queue is redpanda",
    });
    const [row] = await admin<Array<{ session_id: string | null }>>`
      SELECT session_id FROM mnemosyne.mnemo_fact WHERE id = ${successor!.id}`;
    expect(row!.session_id).toBe("session-keep");
  });
});

const PROVISION_APP_ROLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "docker",
  "scripts",
  "provision-app-role.mjs"
);
const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Run `fn` as `url`'s role inside the workspace GUC and return the SQLSTATE it fails with. */
async function failureCode(
  url: string,
  ws: string,
  fn: (tx: postgres.TransactionSql) => Promise<unknown>
): Promise<string | undefined> {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await client.begin(async (tx) => {
      await tx`SELECT set_config('mnemosyne.workspace_id', ${ws}, true)`;
      await fn(tx);
    });
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  } finally {
    await client.end();
  }
}

describe("review round — mnemo_fact_revision is append-only for the app role", () => {
  async function seedHistory() {
    const ws = crypto.randomUUID();
    const fact = await seedFact(ws, "append-only history fixture v1");
    await storage.updateFact(fact.id, ws, { statement: "append-only history fixture v2" });
    return { ws, fact };
  }

  it("denies UPDATE and DELETE straight after the migrations", async () => {
    const { ws, fact } = await seedHistory();
    expect(
      await failureCode(
        appUrl,
        ws,
        (tx) =>
          tx`UPDATE mnemosyne.mnemo_fact_revision SET statement = 'rewritten' WHERE fact_id = ${fact.id}`
      )
    ).toBe("42501");
    expect(
      await failureCode(
        appUrl,
        ws,
        (tx) => tx`DELETE FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`
      )
    ).toBe("42501");
  });

  it("still denies them to mnemo_app after the provisioning script re-grants table DML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wp5-provision-"));
    try {
      await copyFile(PROVISION_APP_ROLE, join(dir, "provision-app-role.mjs"));
      await symlink(join(ADAPTER_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
      execFileSync(process.execPath, [join(dir, "provision-app-role.mjs")], {
        env: {
          ...process.env,
          DATABASE_URL: superUrl,
          MNEMO_APP_DB_PASSWORD: "wp5-provision-pass",
          MNEMO_APP_DB_USER: "mnemo_app",
        },
        stdio: "pipe",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const mnemoAppUrl = superUrl.replace(
      `${PG_USER}:${PG_PASSWORD}@`,
      "mnemo_app:wp5-provision-pass@"
    );

    // The production role can still write and read history through the
    // repository, and a hard delete still cascades into it.
    const prodClient = createDrizzleClient(mnemoAppUrl);
    try {
      const prod = new DrizzleStorageAdapter(prodClient.db, prodClient.pgClient);
      const ws = crypto.randomUUID();
      const fact = await prod.createFact({
        workspaceId: ws,
        scope: "global",
        statement: "provisioned history fixture v1",
        subject: "general",
        kind: "other",
      });
      await prod.updateFact(fact.id, ws, { statement: "provisioned history fixture v2" });

      expect(
        await failureCode(
          mnemoAppUrl,
          ws,
          (tx) =>
            tx`UPDATE mnemosyne.mnemo_fact_revision SET statement = 'rewritten' WHERE fact_id = ${fact.id}`
        )
      ).toBe("42501");
      expect(
        await failureCode(
          mnemoAppUrl,
          ws,
          (tx) => tx`DELETE FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`
        )
      ).toBe("42501");
      const [kept] = await admin<Array<{ statement: string }>>`
        SELECT statement FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`;
      expect(kept!.statement).toBe("provisioned history fixture v1");

      await prod.hardDeleteFact(fact.id, ws);
      const gone =
        await admin`SELECT 1 FROM mnemosyne.mnemo_fact_revision WHERE fact_id = ${fact.id}`;
      expect(gone).toHaveLength(0);
    } finally {
      await prodClient.pgClient.end();
    }
  });
});

// APP-009 (audit 2026-11-22). The dedup index was (workspace, scope, scopeRef,
// subject, md5(statement)): one live row per sentence no matter who owned it or
// at which tier it was kept. Two users' identical personal preference, or the
// same sentence kept public and internal, collided, and the loser of the
// collision was handed the other row's id.
describe("APP-009 — owner and sensitivity are part of the dedup key", () => {
  const base = (ws: string) => ({
    workspaceId: ws,
    scope: "global" as const,
    statement: "prefers tabs over spaces",
    subject: "general",
    kind: "other" as const,
  });

  it("keeps the same sentence once per owner", async () => {
    const ws = crypto.randomUUID();
    const u1 = await storage.createFact({ ...base(ws), scopeOwner: "user:u1" });
    const u2 = await storage.createFact({ ...base(ws), scopeOwner: "user:u2" });
    expect(u2.id).not.toBe(u1.id);
    const found = await storage.findLiveFactByStatement({
      workspaceId: ws,
      scope: "global",
      subject: "general",
      statement: "prefers tabs over spaces",
      scopeOwner: "user:u2",
      sensitivity: "internal",
    });
    expect(found?.id).toBe(u2.id);
  });

  it("keeps the same sentence once per sensitivity tier", async () => {
    const ws = crypto.randomUUID();
    const internal = await storage.createFact({ ...base(ws), sensitivity: "internal" });
    const pub = await storage.createFact({ ...base(ws), sensitivity: "public" });
    expect(pub.id).not.toBe(internal.id);
    const found = await storage.findLiveFactByStatement({
      workspaceId: ws,
      scope: "global",
      subject: "general",
      statement: "prefers tabs over spaces",
      scopeOwner: `workspace:${ws}`,
      sensitivity: "public",
    });
    expect(found?.id).toBe(pub.id);
  });

  it("still refuses a second live row with the same full identity, under the same constraint name", async () => {
    const ws = crypto.randomUUID();
    await storage.createFact({ ...base(ws), scopeOwner: "user:u1" });
    const again = await storage.createFact({ ...base(ws), scopeOwner: "user:u1" }).then(
      () => null,
      (e: { cause?: { code?: string; constraint_name?: string } }) => e.cause
    );
    expect(again).toMatchObject({ code: "23505", constraint_name: "uniq_mnemo_fact_dedup" });
  });
});
