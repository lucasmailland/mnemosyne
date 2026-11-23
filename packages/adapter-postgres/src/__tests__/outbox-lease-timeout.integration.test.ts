/**
 * ADP-2 — claimOutbox() set claimed_at but never expired it. A worker that
 * crashes after claiming an entry (before markOutboxProcessed/markOutboxFailed
 * runs) leaves that row claimed forever — invisible to every future
 * claimOutbox() call, and never reaches the dead-letter reaper either, since
 * that only fires for processed/failed rows, not stuck-claimed ones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const WS = "90909090-9090-4909-8909-909090909090";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
let raw: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });

  const client = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  raw = client.pgClient;
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop().catch(() => void 0);
});

async function insertOutboxEntry(): Promise<string> {
  const rows = await raw<Array<{ id: string }>>`
    INSERT INTO mnemosyne.mnemo_outbox (workspace_id, event_type, payload)
    VALUES (${WS}, 'cache_bust', '{"pattern":"probe"}'::jsonb)
    RETURNING id
  `;
  return rows[0]!.id;
}

describe("claimOutbox(): lease timeout (ADP-2)", () => {
  it("reclaims entries whose claim is older than the timeout", async () => {
    const id = await insertOutboxEntry();
    // Simulate a worker that claimed the entry then crashed before
    // markOutboxProcessed/markOutboxFailed ever ran.
    await raw`
      UPDATE mnemosyne.mnemo_outbox
      SET claimed_at = now() - interval '10 minutes'
      WHERE id = ${id}
    `;

    const claimed = await adapter.claimOutbox(10);

    expect(claimed.some((e) => e.id === id)).toBe(true);
  });

  it("does NOT reclaim entries whose claim is fresh", async () => {
    const id = await insertOutboxEntry();
    await raw`
      UPDATE mnemosyne.mnemo_outbox
      SET claimed_at = now() - interval '30 seconds'
      WHERE id = ${id}
    `;

    const claimed = await adapter.claimOutbox(10);

    expect(claimed.some((e) => e.id === id)).toBe(false);
  });

  it("still claims genuinely unclaimed entries", async () => {
    const id = await insertOutboxEntry();

    const claimed = await adapter.claimOutbox(10);

    expect(claimed.some((e) => e.id === id)).toBe(true);
  });
});
