/**
 * Managed transcript governance, under the role production actually runs as.
 *
 * `packages/adapter-postgres/src/__tests__/managed-session-retention.integration.test.ts`
 * already proves the semantics — cutoff, tombstones, audit, export shape — but it
 * connects as the container's superuser, which BYPASSES row level security. The
 * governance rules here are exactly the ones that must not quietly depend on that:
 *
 *   1. Forgetting an episode also erases the transcript that produced it, so
 *      "forgotten" never means the summary is gone while the raw conversation
 *      stays replayable.
 *   2. Retention erases transcripts and leaves a content-free tombstone.
 *   3. An export can only ever return transcripts that still exist.
 *
 * All three run here through a real NOSUPERUSER / NOBYPASSRLS role holding
 * `mnemo_app_role`, so a missing grant or an RLS policy that silently filters a
 * write fails the test instead of passing under superuser.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test";
const TENANT = "dddd0001-0001-0001-0001-000000000001";
const WS = "dddd0002-0002-0002-0002-000000000002";
const EPISODE = "dddd0003-0003-0003-0003-000000000003";
const SECRET = "SECRET-TRANSCRIPT-CONTENT";

let container: StartedTestContainer;
let superSql: postgres.Sql;
let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let storageClose: (() => Promise<void>) | undefined;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });

  const admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await admin.unsafe(`
      DO $provision$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
          CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END $provision$;
      GRANT mnemo_app_role TO ${APP_USER};
      GRANT app_user       TO ${APP_USER};
      GRANT app_org_user   TO ${APP_USER};
      GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
      GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
      GRANT USAGE ON SCHEMA public    TO ${APP_USER};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO mnemo_app_role;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public    TO app_user;
    `);
  } finally {
    await admin.end();
  }

  superSql = postgres(superUrl, { max: 4, onnotice: () => void 0 });
  await superSql`INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT}, 'Governance')`;
  await superSql`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id) VALUES (${WS}, 'Governance', ${TENANT})`;

  const adapterPgMod = await import("@mnemo-ai/adapter-postgres");
  const { db, pgClient } = adapterPgMod.createDrizzleClient(
    `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`
  );
  storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient);
  storageClose = () => pgClient.end({ timeout: 5 });
}, 240_000);

afterAll(async () => {
  await storageClose?.().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop();
});

beforeEach(async () => {
  await superSql`TRUNCATE mnemosyne.mnemo_session, mnemosyne.mnemo_episode,
    mnemosyne.mnemo_harness_ingestion_event, mnemosyne.mnemo_harness_message_tombstone,
    mnemosyne.mnemo_deletion_log CASCADE`;
});

/** A collapsed managed session with one captured turn, plus its episode. */
async function capturedSession(sessionId: string, terminalAt: string) {
  await superSql`
    INSERT INTO mnemosyne.mnemo_session
      (id, workspace_id, status, source_host, source_session_id, source_client_instance_id,
       source_generation, sensitivity, origin_actor_id, origin_actor_type,
       origin_sensitivity_ceiling, collapsed_at)
    VALUES (${sessionId}, ${WS}, 'collapsed', 'codex', ${`h-${sessionId}`}, 'client-a', 0,
            'internal', 'key:test', 'agent', 'internal', ${terminalAt}::timestamptz)`;
  const [event] = await superSql`
    INSERT INTO mnemosyne.mnemo_harness_ingestion_event
      (workspace_id, event_id, source_host, source_client_instance_id, source_session_id,
       source_generation, enqueue_sequence, event_type, payload_hash, normalization_version,
       occurred_at, origin_actor_id, origin_actor_type, origin_sensitivity_ceiling,
       session_id, ledger_state, acknowledgement)
    VALUES (${WS}, ${`e-${sessionId}`}, 'codex', 'client-a', ${`h-${sessionId}`}, 0, 1,
            'turn.append', ${`p-${sessionId}`}, 1, now(), 'key:test', 'agent', 'internal',
            ${sessionId}, 'accepted',
            ${superSql.json({ eventId: `e-${sessionId}`, status: "accepted", retryable: false })})
    RETURNING id`;
  await superSql`
    INSERT INTO mnemosyne.mnemo_session_turn
      (workspace_id, session_id, turn_index, role, content, source_message_id, content_hash, ingestion_event_id)
    VALUES (${WS}::uuid, ${sessionId}, 0, 'user', ${SECRET}, ${`m-${sessionId}`}, ${`c-${sessionId}`}, ${event!.id})`;
  await superSql`
    INSERT INTO mnemosyne.mnemo_episode (id, workspace_id, title, narrative, occurred_at, source_conversation_id)
    VALUES (${EPISODE}, ${WS}, 'Session', 'Narrative', now(), ${sessionId})`;
}

const remainingTurns = async () =>
  Number((await superSql`SELECT count(*)::int AS n FROM mnemosyne.mnemo_session_turn`)[0]!.n);

describe("managed transcript governance under a non-bypass role", () => {
  it("erases the transcript when its episode is forgotten, leaving no replayable plaintext", async () => {
    await capturedSession("forgotten", "2026-09-01T00:00:00Z");

    const result = await storage.forgetManagedTranscriptForEpisode!({
      workspaceId: WS,
      episodeId: EPISODE,
      actorId: "user:alice",
    });
    expect(result).toMatchObject({ sessionId: "forgotten", turnsRemoved: 1 });
    expect(await remainingTurns()).toBe(0);

    // What remains must not be re-readable as the conversation.
    const [tombstone] = await superSql`
      SELECT * FROM mnemosyne.mnemo_harness_message_tombstone`;
    expect(tombstone).toBeDefined();
    expect(JSON.stringify(tombstone)).not.toContain(SECRET);

    const [audit] = await superSql`
      SELECT actor_id, deletion_type FROM mnemosyne.mnemo_deletion_log`;
    expect(audit).toMatchObject({ actor_id: "user:alice", deletion_type: "hard" });
  });

  it("erases an aged transcript on retention, with the same content-free record", async () => {
    await capturedSession("aged", "2026-01-01T00:00:00Z");

    expect(
      await storage.purgeManagedTurns!({
        workspaceId: WS,
        terminalBefore: new Date("2026-06-01T00:00:00Z"),
        limit: 100,
      })
    ).toBe(1);
    expect(await remainingTurns()).toBe(0);

    const [tombstone] = await superSql`
      SELECT acknowledgement FROM mnemosyne.mnemo_harness_message_tombstone`;
    // The acknowledgement survives so a delayed replay is still answerable.
    expect(tombstone!.acknowledgement).toMatchObject({ status: "accepted" });
    expect(JSON.stringify(tombstone)).not.toContain(SECRET);
  });

  it("never exports a transcript that was already erased, while keeping the session", async () => {
    await capturedSession("exported", "2026-01-01T00:00:00Z");

    expect(await storage.exportManagedTranscripts!({ workspaceId: WS, limit: 100 })).toHaveLength(
      1
    );

    await storage.purgeManagedTurns!({
      workspaceId: WS,
      terminalBefore: new Date("2026-06-01T00:00:00Z"),
      limit: 100,
    });

    const transcripts = await storage.exportManagedTranscripts!({ workspaceId: WS, limit: 100 });
    expect(transcripts).toEqual([]);
    // Metadata outlives the words: the session is still described, without content.
    const sessions = await storage.exportManagedSessions!({ workspaceId: WS, limit: 100 });
    expect(sessions).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(SECRET);
  });
});
