/**
 * RLS-safety proof for DrizzleSyncStorage.markSuperseded.
 *
 * Spins up a pgvector:pg17 container, applies all v3 migrations (including
 * 0073 which creates mnemo_sync_supersession), then:
 *
 *  1. Creates `appconn_73` NOSUPERUSER NOBYPASSRLS + GRANTs mnemo_app_role —
 *     the same pattern as collapse-rls-nonsuperuser.integration.test.ts.
 *  2. Seeds a federated item as superuser (bypassing RLS).
 *  3. Calls DrizzleSyncStorage.markSuperseded() as `appconn_73` (non-superuser).
 *  4. Asserts (via superuser) that the supersession row was written and the
 *     prior item is archived — proving the method works without SUPERUSER or
 *     BYPASSRLS.
 *  5. Asserts that a second workspace cannot see the supersession row (RLS
 *     tenant isolation).
 *  6. Asserts idempotency: calling markSuperseded again is a no-op (onConflictDoNothing).
 *
 * Prerequisites: Docker daemon running.
 * Run with:  pnpm --filter @mnemo-ai/adapter-postgres test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleSyncStorage } from "../DrizzleSyncStorage.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER  = "mnemo_test";
const PG_PASS  = "mnemo_test";
const PG_DB    = "mnemo_test";

// Two distinct workspaces — WS_A for the actual test, WS_B for isolation proof.
const WS_A = "aaa00000-0000-0000-0000-000000000073";
const WS_B = "bbb00000-0000-0000-0000-000000000073";

const REMOTE_ID   = "r-supersession-test-73";
const PEER_DOMAIN = "peer.example.com";

let container:  StartedTestContainer;
let superUrl:   string;
let appStorage: DrizzleSyncStorage;   // connected as NOSUPERUSER appconn_73
let superSql:   postgres.Sql;         // superuser for seeding + inspection
let localId:    string;               // UUID of the seeded federated item

beforeAll(async () => {
  // ── 1. Start container ───────────────────────────────────────────────────
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER:     PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
      POSTGRES_DB:       PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;

  // ── 2. Apply all v3 migrations (including 0073_sync_supersession) ────────
  await migrate({
    databaseUrl: superUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });

  // ── 3. Create NOSUPERUSER role with mnemo_app_role ───────────────────────
  await superSql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appconn_73') THEN
        CREATE ROLE appconn_73 LOGIN PASSWORD 'appconn_73' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
    GRANT mnemo_app_role TO appconn_73;
    GRANT CONNECT ON DATABASE ${PG_DB} TO appconn_73;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO appconn_73;
  `);

  // ── 4. Seed a federated item as superuser (bypasses RLS) ─────────────────
  // Set both GUCs so the INSERT passes the 0011 federated_item policy too.
  await superSql.unsafe(`SELECT set_config('mnemosyne.workspace_id', '${WS_A}', false)`);
  await superSql.unsafe(`SELECT set_config('app.current_workspace_id', '${WS_A}', false)`);

  const rows = await superSql<{ local_id: string }[]>`
    INSERT INTO mnemosyne.mnemo_federated_item
      (workspace_id, remote_id, peer_domain, version, attribution, payload, archived)
    VALUES
      (${WS_A}::uuid, ${REMOTE_ID}, ${PEER_DOMAIN}, 1, 'federation_received', '{}'::jsonb, false)
    RETURNING local_id
  `;
  localId = rows[0]!.local_id;

  // ── 5. Build DrizzleSyncStorage connected as appconn_73 (NOSUPERUSER) ────
  const appConnUrl = superUrl
    .replace(`//${PG_USER}:${PG_PASS}@`, `//appconn_73:appconn_73@`);
  const { db } = createDrizzleClient(appConnUrl);
  appStorage = new DrizzleSyncStorage(db);
}, 180_000);

afterAll(async () => {
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("DrizzleSyncStorage.markSuperseded — RLS-safe under NOSUPERUSER NOBYPASSRLS", () => {

  it("writes the supersession row as mnemo_app_role (non-superuser, no bypassrls)", async () => {
    // THE CORE ASSERTION: markSuperseded must NOT require superuser or bypassrls.
    await expect(appStorage.markSuperseded({
      workspaceId:       WS_A,
      supersededLocalId: localId,
      remoteId:          REMOTE_ID,
      peerDomain:        PEER_DOMAIN,
    })).resolves.not.toThrow();

    // Inspect via superuser: the supersession row must exist.
    const rows = await superSql<{
      workspace_id: string;
      remote_id:    string;
      superseded_local_id: string;
      peer_domain:  string;
    }[]>`
      SELECT workspace_id::text, remote_id, superseded_local_id, peer_domain
      FROM mnemosyne.mnemo_sync_supersession
      WHERE remote_id = ${REMOTE_ID} AND workspace_id = ${WS_A}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.remote_id).toBe(REMOTE_ID);
    expect(rows[0]!.superseded_local_id).toBe(localId);
    expect(rows[0]!.peer_domain).toBe(PEER_DOMAIN);
  });

  it("archives (retains) the prior federated item — it is kept, not deleted", async () => {
    // The prior item must remain in the table with archived=true.
    const rows = await superSql<{ local_id: string; archived: boolean }[]>`
      SELECT local_id, archived
      FROM mnemosyne.mnemo_federated_item
      WHERE local_id = ${localId}::uuid
    `;
    expect(rows).toHaveLength(1);         // retained (not deleted)
    expect(rows[0]!.archived).toBe(true); // and archived
  });

  it("markSuperseded is idempotent — second call is a no-op (onConflictDoNothing)", async () => {
    // Calling again must not throw, and must not create a duplicate row.
    await expect(appStorage.markSuperseded({
      workspaceId:       WS_A,
      supersededLocalId: localId,
      remoteId:          REMOTE_ID,
      peerDomain:        PEER_DOMAIN,
    })).resolves.not.toThrow();

    const rows = await superSql<{ count: string }[]>`
      SELECT count(*)::text FROM mnemosyne.mnemo_sync_supersession
      WHERE remote_id = ${REMOTE_ID} AND workspace_id = ${WS_A}::uuid
    `;
    expect(rows[0]!.count).toBe("1");
  });

  it("workspace RLS isolation: WS_B appconn cannot see WS_A supersession rows", async () => {
    // WS_B has no rows.
    const wsBRows = await superSql<{ workspace_id: string }[]>`
      SELECT workspace_id::text FROM mnemosyne.mnemo_sync_supersession
      WHERE workspace_id = ${WS_B}::uuid
    `;
    expect(wsBRows).toHaveLength(0);

    // An appconn connection scoped to WS_B must not be able to read WS_A rows.
    const appConnUrl = superUrl
      .replace(`//${PG_USER}:${PG_PASS}@`, `//appconn_73:appconn_73@`);
    const { db: dbB } = createDrizzleClient(appConnUrl);
    const storageB = new DrizzleSyncStorage(dbB);

    // markSuperseded with WS_B workspaceId sets GUC to WS_B → can't touch WS_A rows.
    // We use a non-existent supersededLocalId so the archive UPDATE is a no-op,
    // but the INSERT into mnemo_sync_supersession goes through (WS_B scoped).
    const dummyLocalId = "00000000-0000-0000-0000-000000000000";
    await storageB.markSuperseded({
      workspaceId:       WS_B,
      supersededLocalId: dummyLocalId,
      remoteId:          "r-wsb-only",
      peerDomain:        PEER_DOMAIN,
    });

    // WS_A row still has count=1 — WS_B write didn't pollute WS_A.
    const wsARows = await superSql<{ count: string }[]>`
      SELECT count(*)::text FROM mnemosyne.mnemo_sync_supersession
      WHERE workspace_id = ${WS_A}::uuid AND remote_id = ${REMOTE_ID}
    `;
    expect(wsARows[0]!.count).toBe("1");

    // WS_B has its own row from the above call.
    const wsBNewRows = await superSql<{ count: string }[]>`
      SELECT count(*)::text FROM mnemosyne.mnemo_sync_supersession
      WHERE workspace_id = ${WS_B}::uuid
    `;
    expect(wsBNewRows[0]!.count).toBe("1");
  });
});
