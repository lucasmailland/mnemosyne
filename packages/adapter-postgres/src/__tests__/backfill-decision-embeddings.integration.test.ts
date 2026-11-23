/**
 * Integration test: `scripts/backfill-decision-embeddings.mjs`
 * (make-primitives-recallable, design.md D5, tasks.md 4.3).
 *
 * Proves Requirement 2's scenario end to end against a real Postgres:
 *   - pre-existing decisions (embedding IS NULL / embedding_stale) gain a
 *     text-form `vector_upsert` outbox row
 *   - a second run is a genuine no-op (0 candidates, no duplicate rows)
 *   - validFrom / validTo / revisionCount are byte-identical before and
 *     after — the script is INSERT-only into mnemo_outbox and never
 *     touches mnemo_decision itself.
 *
 * Invokes the script as a real subprocess (`node scripts/backfill-decision-
 * embeddings.mjs`) against the testcontainer's connection string — the
 * same "script invoked in-test" approach design.md's Testing Strategy
 * table calls for, and the only way to prove the actual CLI entrypoint
 * (arg parsing, DATABASE_URL wiring) works, not just its internals.
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note and
 * decision-topic-key.integration.test.ts for the same testcontainers
 * pattern this file mirrors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../migrate.js";

const execFileAsync = promisify(execFile);

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const WS = "12121212-1212-4212-9212-121212121212";

// src/__tests__ -> adapter-postgres -> packages -> repo root -> scripts/...
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const BACKFILL_SCRIPT = join(REPO_ROOT, "scripts", "backfill-decision-embeddings.mjs");

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

async function runBackfill(extraArgs: string[] = []): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(process.execPath, [BACKFILL_SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { stdout };
}

interface Snapshot {
  id: string;
  valid_from: string;
  valid_to: string | null;
  revision_count: number;
}

async function snapshotDecisions(ids: string[]): Promise<Snapshot[]> {
  return sql<Snapshot[]>`
    SELECT id, valid_from, valid_to, revision_count
    FROM mnemosyne.mnemo_decision
    WHERE id = ANY(${ids})
    ORDER BY id
  `;
}

describe("scripts/backfill-decision-embeddings.mjs", () => {
  it("enqueues a vector_upsert outbox row per pre-existing decision, is a no-op on re-run, and never touches validFrom/validTo/revisionCount", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();

    await sql`
      INSERT INTO mnemosyne.mnemo_decision
        (id, workspace_id, kind, title, body, normalized_hash, valid_from, revision_count, embedding_stale)
      VALUES
        (${idA}, ${WS}, 'decision', 'Pre-existing A', 'Written before make-primitives-recallable.',
         ${"hash-" + idA}, '2026-01-01T00:00:00Z', 1, false),
        (${idB}, ${WS}, 'decision', 'Pre-existing B', 'Also written before, and stale.',
         ${"hash-" + idB}, '2026-01-02T00:00:00Z', 4, true)
    `;

    const before = await snapshotDecisions([idA, idB]);
    expect(before).toHaveLength(2);

    // Run 1: both are candidates.
    const run1 = await runBackfill(["--workspace", WS]);
    const summary1 = JSON.parse(run1.stdout.trim().split("\n").pop()!);
    expect(summary1.candidates).toBe(2);
    expect(summary1.enqueued).toBe(2);
    expect(summary1.skipped).toBe(0);

    const outboxAfterRun1 = await sql<
      Array<{ id: string; payload: { id: string; kind: string; text: string } }>
    >`
      SELECT id, payload FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS}::uuid AND event_type = 'vector_upsert' AND (payload->>'kind') = 'decision'
      ORDER BY created_at
    `;
    expect(outboxAfterRun1).toHaveLength(2);
    const payloadIds = outboxAfterRun1.map((o) => o.payload.id).sort();
    expect(payloadIds).toEqual([idA, idB].sort());
    const forA = outboxAfterRun1.find((o) => o.payload.id === idA)!;
    expect(forA.payload.text).toBe("Pre-existing A Written before make-primitives-recallable.");

    // Run 2: no candidates left (both have a pending outbox entry now) — a
    // genuine no-op, not a re-insert.
    const run2 = await runBackfill(["--workspace", WS]);
    const summary2 = JSON.parse(run2.stdout.trim().split("\n").pop()!);
    expect(summary2.candidates).toBe(0);
    expect(summary2.enqueued).toBe(0);

    const outboxAfterRun2 = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_outbox
      WHERE workspace_id = ${WS}::uuid AND event_type = 'vector_upsert' AND (payload->>'kind') = 'decision'
    `;
    expect(Number(outboxAfterRun2[0]!.count)).toBe(2); // still exactly 2, not 4

    // The rows themselves are byte-identical to before — INSERT-only into
    // mnemo_outbox, mnemo_decision was never UPDATEd.
    const after = await snapshotDecisions([idA, idB]);
    expect(after).toEqual(before);
  }, 60_000);

  it("--dry-run reports candidates without inserting anything", async () => {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO mnemosyne.mnemo_decision
        (id, workspace_id, kind, title, body, normalized_hash, valid_from, revision_count)
      VALUES
        (${id}, ${WS}, 'decision', 'Dry run candidate', 'Should not be enqueued.',
         ${"hash-" + id}, '2026-01-03T00:00:00Z', 1)
    `;

    const before = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_outbox
      WHERE event_type = 'vector_upsert' AND (payload->>'id') = ${id}
    `;
    expect(Number(before[0]!.count)).toBe(0);

    const { stdout } = await runBackfill(["--workspace", WS, "--dry-run"]);
    const summary = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(summary.dryRun).toBe(true);
    expect(summary.candidates).toBeGreaterThanOrEqual(1);

    const after = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM mnemosyne.mnemo_outbox
      WHERE event_type = 'vector_upsert' AND (payload->>'id') = ${id}
    `;
    expect(Number(after[0]!.count)).toBe(0);
  }, 60_000);
});
