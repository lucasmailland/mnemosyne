import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../../DrizzleStorageAdapter.js";
import { migrate } from "../../migrate.js";
import { OutboxWorker } from "../../OutboxWorker.js";
import { PgVectorAdapter } from "../../../../adapter-vector/src/PgVectorAdapter.js";
import type { OutboxEntry } from "@mnemo-ai/types";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

/** Seed a real mnemo_tenant + mnemo_user row (mnemo_fact.user_id FK requires it). */
async function seedUser(client: ReturnType<typeof postgres>, email: string): Promise<string> {
  const [tenant] = await client<Array<{ id: string }>>`
    INSERT INTO mnemosyne.mnemo_tenant (name, kind, plan) VALUES (${email}, 'personal', 'free')
    RETURNING id
  `;
  const [user] = await client<Array<{ id: string }>>`
    INSERT INTO mnemosyne.mnemo_user (email, personal_tenant_id) VALUES (${email}, ${tenant!.id})
    RETURNING id
  `;
  return user!.id;
}

describe("DrizzleStorageAdapter.replaceFact", () => {
  let container: StartedTestContainer;
  let sql: ReturnType<typeof postgres>;
  let adapter: DrizzleStorageAdapter;
  let adapterClient: ReturnType<typeof createDrizzleClient>;
  let vector: PgVectorAdapter;

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
    const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
    await migrate({ databaseUrl, log: () => undefined });
    sql = postgres(databaseUrl, { max: 5 });
    adapterClient = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(adapterClient.db, adapterClient.pgClient);
    vector = new PgVectorAdapter({ connectionString: databaseUrl });
  }, 120_000);

  afterAll(async () => {
    await adapterClient?.pgClient.end();
    await vector?.close();
    await sql?.end();
    await container?.stop();
  });

  it("atomically closes the source, creates its successor, and queues derived-data work", async () => {
    const workspaceId = crypto.randomUUID();
    const source = await adapter.createFact({
      workspaceId,
      agentId: "source-agent",
      actorId: "owner-1",
      scope: "global",
      scopeOwner: "user:owner-1",
      statement: "Deploy target is us-east-1",
      subject: "deployment",
      kind: "preference",
      confidence: 0.91,
      topicKey: "deploy-target",
      sensitivity: "internal",
      metadata: { source: "integration" },
    });
    await sql`
      INSERT INTO mnemosyne.mnemo_fact_lsh (workspace_id, fact_id, band_idx, band_hash)
      VALUES (${workspaceId}, ${source.id}, 0, 42)
    `;
    const zeroVector = `[${Array.from({ length: 1536 }, () => "0").join(",")}]`;
    await sql.unsafe(`
      INSERT INTO mnemosyne.mnemo_query_cache
        (id, workspace_id, query_embedding, result_memory_ids, result_memory_kinds, top_k)
      VALUES
        ('cache-${source.id}', '${workspaceId}', '${zeroVector}'::vector, ARRAY['${source.id}'], ARRAY['fact'], 10)
    `);
    const replacementHash = createHash("sha256")
      .update("deploy target is eu-west-1|deployment|fact")
      .digest("hex");
    await adapter.upsertFactHash({
      workspaceId,
      statementHash: replacementHash,
      factId: source.id,
    });

    const result = await adapter.replaceFact({
      id: source.id,
      workspaceId,
      statement: "Deploy target is eu-west-1",
      requestedBy: "user-1",
      agentId: "editor-agent",
    });

    expect(result).not.toBeNull();
    expect(result?.previous).toMatchObject({ id: source.id, status: "forgotten" });
    expect(result?.replacement).toMatchObject({
      agentId: "editor-agent",
      actorId: source.actorId,
      statement: "Deploy target is eu-west-1",
      subject: source.subject,
      topicKey: source.topicKey,
      status: "active",
      revisionCount: source.revisionCount + 1,
      embeddingStale: true,
    });
    expect(result?.replacement.id).not.toBe(source.id);
    expect(result?.previous.validTo?.getTime()).toBe(result?.replacement.validFrom.getTime());

    const [relation] = await sql<Array<{ source_id: string; target_id: string; relation: string }>>`
      SELECT source_id, target_id, relation
      FROM mnemosyne.mnemo_relation
      WHERE workspace_id = ${workspaceId} AND relation = 'supersedes'
    `;
    expect(relation).toMatchObject({
      source_id: result?.replacement.id,
      target_id: source.id,
      relation: "supersedes",
    });

    const [hash] = await sql<Array<{ fact_id: string; seen_count: number }>>`
      SELECT fact_id, seen_count FROM mnemosyne.mnemo_fact_hash
      WHERE workspace_id = ${workspaceId} AND statement_hash = ${replacementHash}
    `;
    expect(hash).toMatchObject({ fact_id: result?.replacement.id, seen_count: 2 });

    const outbox = await sql<Array<{ event_type: string; payload: Record<string, unknown> }>>`
      SELECT event_type, payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at
    `;
    expect(outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "vector_delete",
          payload: expect.objectContaining({ id: source.id }),
        }),
        expect.objectContaining({ event_type: "cache_bust" }),
        expect.objectContaining({
          event_type: "vector_upsert",
          payload: expect.objectContaining({
            id: result?.replacement.id,
            text: "Deploy target is eu-west-1",
            revision: result?.replacement.revisionCount,
          }),
        }),
      ])
    );
    const [derivedCounts] = await sql<Array<{ lsh_count: number; cache_count: number }>>`
      SELECT
        (SELECT COUNT(*)::int FROM mnemosyne.mnemo_fact_lsh WHERE fact_id = ${source.id}) AS lsh_count,
        (SELECT COUNT(*)::int FROM mnemosyne.mnemo_query_cache WHERE workspace_id = ${workspaceId}) AS cache_count
    `;
    expect(derivedCounts).toEqual({ lsh_count: 0, cache_count: 0 });
  });

  it("rejects a delayed replacement vector event after a newer topic revision commits", async () => {
    const workspaceId = crypto.randomUUID();
    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "replacement event source",
      subject: "ordering",
      kind: "other",
      topicKey: "replacement-event-ordering",
      sensitivity: "internal",
    });
    const replaced = await adapter.replaceFact({
      id: source.id,
      workspaceId,
      statement: "old replacement statement",
      requestedBy: "user-1",
    });
    if (!replaced) throw new Error("replacement unexpectedly missed");

    const [eventRow] = await sql<
      Array<{
        id: string;
        workspace_id: string;
        event_type: OutboxEntry["eventType"];
        payload: Record<string, unknown>;
        created_at: Date;
        attempts: number;
      }>
    >`
      SELECT id, workspace_id, event_type, payload, created_at, attempts
      FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${workspaceId}
        AND event_type = 'vector_upsert'
        AND payload->>'id' = ${replaced.replacement.id}
    `;
    expect(eventRow?.payload.revision).toBe(replaced.replacement.revisionCount);

    const newer = await adapter.mergeFactByTopicKey({
      workspaceId,
      topicKey: "replacement-event-ordering",
      statement: "newer committed topic statement",
    });
    if (!newer) throw new Error("topic merge unexpectedly missed");
    const newerVector = new Float32Array(1536).fill(0.75);
    await vector.upsert(newer.id, newerVector, {
      workspaceId,
      revision: newer.revisionCount,
      model: "newer-model",
    });

    const delayedEvent: OutboxEntry = {
      id: eventRow!.id,
      workspaceId: eventRow!.workspace_id,
      eventType: eventRow!.event_type,
      payload: eventRow!.payload,
      createdAt: eventRow!.created_at,
      attempts: eventRow!.attempts,
    };
    const storage = {
      claimOutbox: async () => [delayedEvent],
      markOutboxProcessed: async () => undefined,
      markOutboxFailed: async () => undefined,
      reapDeadLetters: async () => 0,
    };
    const worker = new OutboxWorker(
      storage as never,
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
      {
        id: "stub-embed",
        model: "delayed-model",
        dimensions: 1536,
        embed: async () => [],
        embedSingle: async () => new Float32Array(1536).fill(0.25),
        healthCheck: async () => ({ status: "ok" as const, latencyMs: 0 }),
      }
    );

    await expect(worker.runBatch()).resolves.toBe(1);

    const [stored] = await sql<
      Array<{
        revision_count: number;
        embedding: string;
        embedding_model: string;
        embedding_stale: boolean;
      }>
    >`
      SELECT revision_count, embedding::text, embedding_model, embedding_stale
      FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${workspaceId} AND id = ${newer.id}
    `;
    expect(stored).toMatchObject({
      revision_count: newer.revisionCount,
      embedding_model: "newer-model",
      embedding_stale: false,
    });
    const firstEmbeddingValue = Number(stored?.embedding.match(/^\[([^,]+)/)?.[1]);
    expect(firstEmbeddingValue).toBeCloseTo(newerVector[0]!, 3);
  });

  it("allows only one successor when two replacements race", async () => {
    const workspaceId = crypto.randomUUID();
    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "original",
      subject: "race",
      kind: "other",
      sensitivity: "internal",
    });

    const results = await Promise.all([
      adapter.replaceFact({
        id: source.id,
        workspaceId,
        statement: "first",
        requestedBy: "user-1",
      }),
      adapter.replaceFact({
        id: source.id,
        workspaceId,
        statement: "second",
        requestedBy: "user-1",
      }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const facts = await sql<Array<{ status: string; count: number }>>`
      SELECT status, COUNT(*)::int AS count
      FROM mnemosyne.mnemo_fact
      WHERE workspace_id = ${workspaceId}
      GROUP BY status
    `;
    expect(facts).toEqual(
      expect.arrayContaining([
        { status: "active", count: 1 },
        { status: "forgotten", count: 1 },
      ])
    );
  });

  it("returns null when actor isolation cannot see the source", async () => {
    const workspaceId = crypto.randomUUID();
    const source = await adapter.createFact({
      workspaceId,
      actorId: "owner-1",
      scope: "global",
      statement: "private source",
      subject: "ownership",
      kind: "other",
      sensitivity: "internal",
    });

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId,
        statement: "must not apply",
        requestedBy: "owner-2",
        actorIsolationId: "owner-2",
      })
    ).resolves.toBeNull();
    expect(await adapter.getFact(source.id, workspaceId)).toMatchObject({
      statement: "private source",
      status: "active",
    });
  });

  it("does not replace a source whose validity has not started", async () => {
    const workspaceId = crypto.randomUUID();
    const future = new Date(Date.now() + 60_000); // determinism-ok: test date
    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "scheduled source",
      subject: "future",
      kind: "other",
      validFrom: future,
    });

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId,
        statement: "must not create a backwards interval",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();
    expect(await adapter.getFact(source.id, workspaceId)).toMatchObject({
      statement: "scheduled source",
      status: "active",
      validTo: undefined,
    });
  });

  it("returns null when user isolation cannot see a user-owned source", async () => {
    const workspaceId = crypto.randomUUID();
    const owner = await seedUser(sql, `owner1-${workspaceId}@example.com`);
    const other = await seedUser(sql, `owner2-${workspaceId}@example.com`);
    const source = await adapter.createFact({
      workspaceId,
      userId: owner,
      scope: "global",
      statement: "private user-owned source",
      subject: "ownership",
      kind: "other",
      sensitivity: "internal",
    });

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId,
        statement: "must not apply",
        requestedBy: other,
        userIsolationId: other,
      })
    ).resolves.toBeNull();
    expect(await adapter.getFact(source.id, workspaceId)).toMatchObject({
      statement: "private user-owned source",
      status: "active",
    });
  });

  it("replaces a user-owned source when userIsolationId matches", async () => {
    const workspaceId = crypto.randomUUID();
    const owner = await seedUser(sql, `owner-match-${workspaceId}@example.com`);
    const source = await adapter.createFact({
      workspaceId,
      userId: owner,
      scope: "global",
      statement: "private user-owned source",
      subject: "ownership",
      kind: "other",
      sensitivity: "internal",
    });

    const result = await adapter.replaceFact({
      id: source.id,
      workspaceId,
      statement: "replaced by owner",
      requestedBy: owner,
      userIsolationId: owner,
    });

    expect(result).not.toBeNull();
    expect(result?.replacement).toMatchObject({
      statement: "replaced by owner",
      userId: owner,
      status: "active",
    });
  });

  it("does not block a legacy fact with user_id IS NULL when userIsolationId is set", async () => {
    const workspaceId = crypto.randomUUID();
    const someUser = await seedUser(sql, `legacy-${workspaceId}@example.com`);
    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "legacy no-owner source",
      subject: "ownership",
      kind: "other",
      sensitivity: "internal",
    });

    const result = await adapter.replaceFact({
      id: source.id,
      workspaceId,
      statement: "replaced despite unrelated userIsolationId",
      requestedBy: someUser,
      userIsolationId: someUser,
    });

    expect(result).not.toBeNull();
    expect(result?.replacement).toMatchObject({
      statement: "replaced despite unrelated userIsolationId",
      userId: undefined,
      status: "active",
    });
  });

  it("encrypts sensitive replacement text and never queues its plaintext", async () => {
    const workspaceId = crypto.randomUUID();
    const actorId = "sensitive-owner";
    const dek = Buffer.alloc(32, 7);
    const sensitiveAdapter = new DrizzleStorageAdapter(
      adapterClient.db,
      adapterClient.pgClient,
      (_workspaceId, _actorId, wrapped) => Buffer.from(wrapped, "base64"),
      () => ({ dek, wrapped: dek.toString("base64") })
    );
    const source = await sensitiveAdapter.createFact({
      workspaceId,
      actorId,
      scope: "global",
      statement: "old medical statement",
      subject: "patient-42",
      kind: "other",
      sensitivity: "confidential",
    });
    const [storedSource] = await sql<Array<{ subject: string }>>`
      SELECT subject FROM mnemosyne.mnemo_fact WHERE id = ${source.id}
    `;

    const result = await sensitiveAdapter.replaceFact({
      id: source.id,
      workspaceId,
      statement: "new medical statement",
      requestedBy: actorId,
      actorIsolationId: actorId,
    });

    expect(result).not.toBeNull();
    const [storedReplacement] = await sql<Array<{ statement: string; subject: string }>>`
      SELECT statement, subject FROM mnemosyne.mnemo_fact WHERE id = ${result!.replacement.id}
    `;
    expect(storedReplacement?.statement.startsWith("enc:v1:")).toBe(true);
    expect(storedReplacement?.statement).not.toContain("new medical statement");
    expect(storedReplacement?.subject).toBe(storedSource?.subject);

    const replacementOutbox = await sql<Array<{ event_type: string; payload: unknown }>>`
      SELECT event_type, payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${workspaceId}
        AND payload->>'id' = ${result!.replacement.id}
    `;
    expect(replacementOutbox.some((entry) => entry.event_type === "vector_upsert")).toBe(false);
    expect(JSON.stringify(replacementOutbox)).not.toContain("new medical statement");
    const expectedHash = createHash("sha256")
      .update("new medical statement|patient-42|fact")
      .digest("hex");
    const [hash] = await sql<Array<{ fact_id: string }>>`
      SELECT fact_id FROM mnemosyne.mnemo_fact_hash
      WHERE workspace_id = ${workspaceId} AND statement_hash = ${expectedHash}
    `;
    expect(hash?.fact_id).toBe(result!.replacement.id);
  });

  it("rolls back the close and every side effect when successor insertion fails", async () => {
    const workspaceId = crypto.randomUUID();
    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "must survive rollback",
      subject: "rollback",
      kind: "other",
      sensitivity: "internal",
    });
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION mnemosyne.reject_test_successor() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced successor failure';
      END
      $$;
      CREATE TRIGGER reject_test_successor
      BEFORE INSERT ON mnemosyne.mnemo_fact
      FOR EACH ROW
      WHEN (NEW.workspace_id = '${workspaceId}')
      EXECUTE FUNCTION mnemosyne.reject_test_successor();
    `);

    try {
      await expect(
        adapter.replaceFact({
          id: source.id,
          workspaceId,
          statement: "must roll back",
          requestedBy: "user-1",
        })
      ).rejects.toThrow();
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS reject_test_successor ON mnemosyne.mnemo_fact`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS mnemosyne.reject_test_successor()`);
    }

    const [stored] = await sql<Array<{ status: string; valid_to: Date | null }>>`
      SELECT status, valid_to FROM mnemosyne.mnemo_fact WHERE id = ${source.id}
    `;
    expect(stored).toEqual({ status: "active", valid_to: null });
    const [counts] = await sql<Array<{ facts: number; relations: number; outbox: number }>>`
      SELECT
        (SELECT COUNT(*)::int FROM mnemosyne.mnemo_fact WHERE workspace_id = ${workspaceId}) AS facts,
        (SELECT COUNT(*)::int FROM mnemosyne.mnemo_relation WHERE workspace_id = ${workspaceId}) AS relations,
        (SELECT COUNT(*)::int FROM mnemosyne.mnemo_outbox WHERE workspace_id = ${workspaceId}) AS outbox
    `;
    expect(counts).toEqual({ facts: 1, relations: 0, outbox: 1 });
  });

  it("refuses to replace a fact carrying a pending consolidation marker (B6.35)", async () => {
    const workspaceId = crypto.randomUUID();
    const source = await adapter.createFact({
      workspaceId,
      scope: "global",
      statement: "Deploy target is us-east-1",
      subject: "deployment",
      kind: "preference",
      sensitivity: "internal",
      metadata: { source: "integration" },
    });
    // Stamp the pending-consolidation marker directly (as applyConsolidationMerge would).
    await sql`
      UPDATE mnemosyne.mnemo_fact
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{__mnemoConsolidationPending}',
                               ${sql.json({ operationId: "op-1", survivorId: source.id })})
      WHERE id = ${source.id}
    `;

    await expect(
      adapter.replaceFact({
        id: source.id,
        workspaceId,
        statement: "must not apply",
        requestedBy: "user-1",
      })
    ).resolves.toBeNull();

    const [stored] = await sql<Array<{ status: string; valid_to: Date | null; statement: string }>>`
      SELECT status, valid_to, statement FROM mnemosyne.mnemo_fact WHERE id = ${source.id}
    `;
    expect(stored).toMatchObject({
      status: "active",
      valid_to: null,
      statement: "Deploy target is us-east-1",
    });
    const [{ facts }] = await sql<Array<{ facts: number }>>`
      SELECT COUNT(*)::int AS facts FROM mnemosyne.mnemo_fact WHERE workspace_id = ${workspaceId}
    `;
    expect(facts).toBe(1);
  });
});
