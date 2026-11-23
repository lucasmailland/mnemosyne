/**
 * Integration test: migration 0030_p64_reasoning_bitemporality.sql.
 *
 * Proves against a real Postgres:
 *   - createReasoning sets valid_from, leaves valid_to NULL
 *   - archiveReasoning (forget()-equivalence) closes valid_to alongside status
 *   - the migration's two backfill UPDATEs converge a legacy row correctly
 *     and are idempotent — re-running them a second time changes nothing
 *
 * Mirrors backfill-decision-embeddings.integration.test.ts's "no-op on
 * re-run" style (design.md Testing Strategy table).
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { migrate } from "../migrate.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const WS = "44444444-4444-4444-4444-444444444444";

let container: StartedTestContainer;
let sql: postgres.Sql;
let databaseUrl: string;

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

  sql = postgres(databaseUrl, { connection: { search_path: "mnemosyne,public" } });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

interface ReasoningSnapshot {
  id: string;
  valid_from: string;
  valid_to: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

async function snapshotReasoning(ids: string[]): Promise<ReasoningSnapshot[]> {
  return sql<ReasoningSnapshot[]>`
    SELECT id, valid_from, valid_to, status, created_at, updated_at
    FROM mnemosyne.mnemo_reasoning
    WHERE id = ANY(${ids})
    ORDER BY id
  `;
}

// Re-runs migration 0030's two backfill UPDATEs verbatim, without touching
// the ALTER TABLE step (already applied by beforeAll's migrate()). This is
// how the backfill-convergence case simulates "the migration ran against a
// legacy row" without needing a second, un-migrated container.
async function reapplyBackfill(): Promise<void> {
  await sql`
    UPDATE mnemosyne.mnemo_reasoning
       SET valid_from = created_at
     WHERE valid_from != created_at
  `;
  await sql`
    UPDATE mnemosyne.mnemo_reasoning
       SET valid_to = GREATEST(updated_at, created_at)
     WHERE valid_to IS NULL
       AND status IN ('archived', 'pruned')
  `;
}

describe("migration 0030 — reasoning bitemporality", () => {
  it("createReasoning sets valid_from and archiveReasoning closes valid_to (forget()-equivalence)", async () => {
    const { db, pgClient } = createDrizzleClient(databaseUrl);
    const adapter = new DrizzleStorageAdapter(db, pgClient);

    const created = await adapter.createReasoning({
      workspaceId: WS,
      question: "Does the migration wire real columns end to end?",
      chain: [{ step: 1, reasoning: "Insert through the real adapter" }],
      conclusion: "Yes, if this assertion passes",
    });

    expect(created.validFrom).toBeInstanceOf(Date);
    expect(created.validTo).toBeUndefined();

    await adapter.archiveReasoning(created.id, WS);

    const archived = await adapter.getReasoning(created.id, WS);
    expect(archived?.status).toBe("archived");
    expect(archived?.validTo).toBeInstanceOf(Date);
    expect((archived!.validTo as Date).getTime()).toBeGreaterThanOrEqual(
      archived!.validFrom.getTime()
    );

    await pgClient.end();
  }, 60_000);

  it("backfill converges a legacy row (wrong valid_from, archived with valid_to NULL) and is a no-op on re-run", async () => {
    const id = crypto.randomUUID();

    // Simulate a row that predates 0030's ALTER: created_at in the past,
    // valid_from wrongly defaulted to "now" (as a fresh column DEFAULT would
    // do for any pre-existing row before the backfill ran), status
    // 'archived' with valid_to still NULL (the exact "day one drift" 0030's
    // header describes).
    await sql`
      INSERT INTO mnemosyne.mnemo_reasoning
        (id, workspace_id, question, chain, conclusion, status, created_at, updated_at, valid_from, valid_to)
      VALUES
        (${id}, ${WS}, 'legacy question', '[]'::jsonb, 'legacy conclusion', 'archived',
         '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', now(), NULL)
    `;

    const before = await snapshotReasoning([id]);
    expect(before).toHaveLength(1);
    expect(before[0]!.valid_to).toBeNull();

    await reapplyBackfill();

    const converged = await snapshotReasoning([id]);
    expect(converged[0]!.valid_from).toEqual(converged[0]!.created_at);
    expect(converged[0]!.valid_to).not.toBeNull();
    expect(new Date(converged[0]!.valid_to!).toISOString()).toBe(
      new Date(converged[0]!.updated_at).toISOString()
    );

    // Second run: idempotent — nothing changes.
    await reapplyBackfill();
    const secondRun = await snapshotReasoning([id]);
    expect(secondRun).toEqual(converged);
  }, 60_000);

  it("backfill leaves a quarantined row's valid_to untouched (reversible hold, not a close — D3)", async () => {
    const id = crypto.randomUUID();

    await sql`
      INSERT INTO mnemosyne.mnemo_reasoning
        (id, workspace_id, question, chain, conclusion, status, created_at, updated_at, valid_from, valid_to)
      VALUES
        (${id}, ${WS}, 'quarantined question', '[]'::jsonb, 'quarantined conclusion', 'quarantined',
         '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', now(), NULL)
    `;

    await reapplyBackfill();

    const row = await snapshotReasoning([id]);
    expect(row[0]!.status).toBe("quarantined");
    expect(row[0]!.valid_to).toBeNull();
  }, 60_000);
});
