/**
 * ADP-6 — reapDeadLetters() marked any entry with attempts >= maxAttempts as
 * dead-lettered (processedAt set), even one a worker is ACTIVELY retrying
 * right now (claimed_at set, claim still fresh). If that in-flight retry
 * then succeeded, the worker's own markOutboxProcessed call would silently
 * clobber the reaper's dead_letter write (or vice versa, depending on
 * ordering) -- either way the audit trail (last_error) ends up wrong about
 * what actually happened to that entry.
 *
 * Fixed the same way ADP-2 fixed claimOutbox's lease-timeout race: only reap
 * entries whose claim is either absent or has gone stale past
 * OUTBOX_CLAIM_TIMEOUT_MS. A fresh claim means a worker is genuinely still
 * working the entry right now -- reaping it out from under that worker is
 * the bug, not a fix. A stale claim (worker crashed mid-attempt, already at
 * maxAttempts) should still be reaped -- otherwise it's stuck forever, since
 * nothing else will ever clear a claimed_at claimOutbox itself won't reclaim
 * (attempts already exhausted, so it would just be reaped right back out).
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
const WS = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
const MAX_ATTEMPTS = 5;

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

async function insertMaxedOutEntry(claimedAt: "now" | "stale" | null): Promise<string> {
  const rows = await raw<Array<{ id: string }>>`
    INSERT INTO mnemosyne.mnemo_outbox (workspace_id, event_type, payload, attempts)
    VALUES (${WS}, 'cache_bust', '{"pattern":"probe"}'::jsonb, ${MAX_ATTEMPTS})
    RETURNING id
  `;
  const id = rows[0]!.id;
  if (claimedAt === "now") {
    await raw`UPDATE mnemosyne.mnemo_outbox SET claimed_at = now() WHERE id = ${id}`;
  } else if (claimedAt === "stale") {
    await raw`UPDATE mnemosyne.mnemo_outbox SET claimed_at = now() - interval '10 minutes' WHERE id = ${id}`;
  }
  return id;
}

describe("reapDeadLetters(): claim-aware race fix (ADP-6)", () => {
  it("skips a maxed-out entry that is actively (freshly) claimed", async () => {
    const id = await insertMaxedOutEntry("now");

    await adapter.reapDeadLetters(MAX_ATTEMPTS);

    const rows = await raw<Array<{ processed_at: Date | null }>>`
      SELECT processed_at FROM mnemosyne.mnemo_outbox WHERE id = ${id}
    `;
    expect(rows[0]?.processed_at).toBeNull();
  });

  it("reaps a maxed-out entry with a stale claim (worker presumed crashed)", async () => {
    const id = await insertMaxedOutEntry("stale");

    const reaped = await adapter.reapDeadLetters(MAX_ATTEMPTS);

    expect(reaped).toBeGreaterThanOrEqual(1);
    const rows = await raw<Array<{ processed_at: Date | null; last_error: string | null }>>`
      SELECT processed_at, last_error FROM mnemosyne.mnemo_outbox WHERE id = ${id}
    `;
    expect(rows[0]?.processed_at).not.toBeNull();
    expect(rows[0]?.last_error).toContain("dead_letter");
  });

  it("still reaps a maxed-out, genuinely unclaimed entry", async () => {
    const id = await insertMaxedOutEntry(null);

    const reaped = await adapter.reapDeadLetters(MAX_ATTEMPTS);

    expect(reaped).toBeGreaterThanOrEqual(1);
    const rows = await raw<Array<{ processed_at: Date | null }>>`
      SELECT processed_at FROM mnemosyne.mnemo_outbox WHERE id = ${id}
    `;
    expect(rows[0]?.processed_at).not.toBeNull();
  });
});
