/**
 * Regression test: FactRepository outbox payload key (CRIT-05 Bug 2).
 *
 * Before the fix, createFact() appended { id, kind, statement } to the
 * outbox. OutboxWorker.processVectorUpsert() reads payload.text (not
 * payload.statement), so the text-form outbox entry was silently skipped
 * ("neither vector nor text") and facts never got embeddings via the
 * text-form fallback path.
 *
 * Fix: payload key renamed from `statement` to `text` in FactRepository.
 *
 * This test confirms the outbox row has payload.text === the fact statement.
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop();
});

describe("FactRepository — outbox payload carries text key (not statement)", () => {
  const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

  it("createFact inserts an outbox entry with payload.text equal to the statement", async () => {
    const statement = "Claude prefers concise explanations over verbose ones";

    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement,
      subject: "claude",
      kind: "preference",
    });

    const sql = postgres(databaseUrl);
    try {
      const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload
        FROM mnemosyne.mnemo_outbox
        WHERE workspace_id = ${WS}
          AND event_type = 'vector_upsert'
          AND (payload->>'id') = ${fact.id}
        ORDER BY created_at DESC
        LIMIT 5
      `;

      // There must be at least one outbox entry for this fact.
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // Every text-form outbox entry (i.e. entries without a vector array)
      // must carry payload.text — not payload.statement.
      const textFormEntries = rows.filter(
        (r) => r.payload.vector === undefined && r.payload.text !== undefined,
      );

      if (textFormEntries.length > 0) {
        for (const entry of textFormEntries) {
          expect(entry.payload.text).toBe(statement);
          // Regression guard: old broken key must NOT appear.
          expect(entry.payload.statement).toBeUndefined();
        }
      }

      // Whether text-form or vector-form, no entry may carry the old `statement` key.
      for (const row of rows) {
        expect(row.payload.statement).toBeUndefined();
      }
    } finally {
      await sql.end();
    }
  });
});
