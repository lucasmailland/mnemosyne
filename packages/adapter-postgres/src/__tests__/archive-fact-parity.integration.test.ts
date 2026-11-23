/**
 * DB-2 — archiveFact() full column parity with mnemo_fact.
 *
 * Two independent gaps, both verified against a real Postgres container:
 *   (a) 0011 added 16 of 19 columns missing from mnemo_fact_archive after the
 *       2026-06 squash; embedding_version, linked_memory_ids, scope_owner
 *       remained missing on both the DB and the Drizzle schema.
 *   (b) archiveFact() never copied `embedding` even though the column
 *       existed post-0011 — every archived fact silently lost its vector.
 *
 * embedding_version / linked_memory_ids are populated by the legacy
 * packages/core write path (packages/core/src/db/schema/fact.ts,
 * packages/core/src/factory.ts) directly against the SAME mnemosyne.mnemo_fact
 * table the v3 FactRepository reads/archives — so a fact created that way and
 * later archived via the v3 path was losing real, already-present data, not
 * hypothetical future data.
 *
 * Requires Docker — run via:
 *   pnpm --filter @mnemo-ai/adapter-postgres test:integration -- archive-fact-parity
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";

let container: StartedTestContainer;
let databaseUrl: string;
let adapter: DrizzleStorageAdapter;
let raw: ReturnType<typeof createDrizzleClient>["pgClient"];

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

  const client = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  raw = client.pgClient;
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop().catch(() => void 0);
});

describe("archiveFact(): full column parity (DB-2)", () => {
  it("mnemo_fact_archive has every column mnemo_fact has", async () => {
    const rows = await raw<Array<{ column_name: string }>>`
      WITH live AS (SELECT column_name FROM information_schema.columns
                    WHERE table_schema='mnemosyne' AND table_name='mnemo_fact'),
           arch AS (SELECT column_name FROM information_schema.columns
                    WHERE table_schema='mnemosyne' AND table_name='mnemo_fact_archive')
      SELECT column_name FROM live EXCEPT SELECT column_name FROM arch
    `;
    expect(rows).toEqual([]);
  });

  it("archiveFact() copies the embedding vector, not NULL", async () => {
    const vec = Array(1536).fill(0.25);
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "fact with an embedding",
      subject: "probe",
      kind: "other",
    });
    // createFact() never writes the embedding synchronously (see FactRepository
    // — it only queues a vector_upsert outbox entry). The real write path is
    // updateEmbeddingVector, called by the OutboxWorker or, for facts,
    // synchronously by cognitive/remember.ts's Step 6a. Call it directly so
    // this test doesn't depend on outbox draining.
    await adapter.updateEmbeddingVector("fact", fact.id, WS, vec, "test-embed-model");

    await adapter.archiveFact(fact.id, WS);

    const rows = await raw<Array<{ embedding: string | null; embedding_model: string | null }>>`
      SELECT embedding::text AS embedding, embedding_model
      FROM mnemosyne.mnemo_fact_archive WHERE id = ${fact.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).not.toBeNull();
    expect(rows[0]?.embedding_model).toBe("test-embed-model");
  });

  it("archiveFact() copies scope_owner", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "fact with scope owner",
      subject: "probe",
      kind: "other",
      scopeOwner: "user:probe-user",
    });

    await adapter.archiveFact(fact.id, WS);

    const rows = await raw<Array<{ scope_owner: string | null }>>`
      SELECT scope_owner FROM mnemosyne.mnemo_fact_archive WHERE id = ${fact.id}
    `;
    expect(rows[0]?.scope_owner).toBe("user:probe-user");
  });

  it("archiveFact() copies embedding_version and linked_memory_ids populated by the legacy write path", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "fact touched by the legacy path",
      subject: "probe",
      kind: "other",
    });

    // Simulate the legacy packages/core write path (packages/core/src/db/schema/fact.ts,
    // factory.ts) populating these two columns directly on the shared table —
    // the v3 CreateFactInput port has no field for either, by design (B4
    // migration-lifecycle columns), but the columns are real and shared.
    await raw`
      UPDATE mnemosyne.mnemo_fact
      SET embedding_version = 'v2026-legacy-embed', linked_memory_ids = ARRAY['mfact_linked_1','mfact_linked_2']
      WHERE id = ${fact.id}
    `;

    await adapter.archiveFact(fact.id, WS);

    const rows = await raw<
      Array<{ embedding_version: string | null; linked_memory_ids: string[] | null }>
    >`
      SELECT embedding_version, linked_memory_ids
      FROM mnemosyne.mnemo_fact_archive WHERE id = ${fact.id}
    `;
    expect(rows[0]?.embedding_version).toBe("v2026-legacy-embed");
    expect(rows[0]?.linked_memory_ids).toEqual(["mfact_linked_1", "mfact_linked_2"]);
  });
});
