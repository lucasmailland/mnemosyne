/**
 * The federation sync tables under the role production runs as.
 *
 * The server refuses to boot as a superuser or a BYPASSRLS role, so it connects
 * as a plain login role holding mnemo_app_role. The RLS policies of
 * mnemo_federated_item and mnemo_sync_tombstone read app.current_workspace_id,
 * which DrizzleSyncStorage never set: under that role every pulled item failed
 * with "unrecognized configuration parameter", and a sync stored nothing. The
 * other integration tests connect as the superuser, which skips RLS.
 *
 * This test drives the sync storage, the job store and the peer store as such a
 * role, and checks that a workspace still sees only its own rows. It also reads
 * the hard-deleted facts the items endpoint serves as tombstones (0068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { DrizzlePeerStore } from "../DrizzlePeerStore.js";
import { DrizzleSyncJobStore } from "../DrizzleSyncJobStore.js";
import { DrizzleSyncStorage } from "../DrizzleSyncStorage.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "federation_app";
const APP_PASS = "federation_app_pass";
const WS_ACME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
const WS_LARKSPUR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01";
const REMOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);
  app = createDrizzleClient(`postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`);
}, 120_000);

afterAll(async () => {
  await app?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("federation storage as the application role", () => {
  it("DrizzleSyncStorage stores, reads, supersedes and tombstones in its own workspace", async () => {
    const storage = new DrizzleSyncStorage(app.db);
    const item = {
      workspaceId: WS_ACME,
      remoteId: REMOTE,
      peerDomain: "acme.example",
      version: 1,
      attribution: "federation_received" as const,
      payload: { statement: "Acme ships on Thursdays" },
    };
    const { localId } = await storage.upsertFederatedItem(item);
    expect(await storage.findByRemoteId(REMOTE, WS_ACME)).toMatchObject({ localId, version: 1 });
    // Another workspace does not see it.
    expect(await storage.findByRemoteId(REMOTE, WS_LARKSPUR)).toBeNull();

    await storage.markSuperseded({
      workspaceId: WS_ACME,
      supersededLocalId: localId,
      remoteId: REMOTE,
      peerDomain: "acme.example",
    });
    const { localId: current } = await storage.upsertFederatedItem({ ...item, version: 2 });
    await storage.archiveLocalItem(current, WS_ACME);
    expect(await storage.findByRemoteId(REMOTE, WS_ACME)).toBeNull();

    await storage.insertDeletionLog({
      workspaceId: WS_ACME,
      remoteId: REMOTE,
      peerDomain: "acme.example",
      reason: "federation_tombstone",
      deletedAt: "2026-11-02T10:00:00.000Z",
    });
    expect(await storage.isInDeletionLog(REMOTE, WS_ACME)).toBe(true);
    expect(await storage.isInDeletionLog(REMOTE, WS_LARKSPUR)).toBe(false);
  });

  it("a malformed workspace id fails closed", async () => {
    const storage = new DrizzleSyncStorage(app.db);
    await expect(storage.findByRemoteId(REMOTE, "not-a-workspace")).rejects.toThrow();
    await expect(
      storage.upsertFederatedItem({
        workspaceId: "not-a-workspace",
        remoteId: REMOTE,
        peerDomain: "acme.example",
        version: 1,
        attribution: "federation_received",
        payload: {},
      })
    ).rejects.toThrow();
  });

  it("DrizzleSyncJobStore and DrizzlePeerStore work too", async () => {
    const jobs = new DrizzleSyncJobStore(app.db);
    await jobs.create({
      id: "job-app-role",
      peerId: "acme.example",
      workspaceId: WS_ACME,
      status: "pending",
      startedAt: "2026-11-02T10:00:00.000Z",
    });
    await jobs.update("job-app-role", WS_ACME, {
      status: "done",
      completedAt: "2026-11-02T10:01:00.000Z",
      outcome: { cursor: "c1" },
    });
    expect(await jobs.lastCursor("acme.example", WS_ACME)).toBe("c1");
    expect(await jobs.lastCursor("acme.example", WS_LARKSPUR)).toBeNull();

    const peers = new DrizzlePeerStore(app.db);
    expect(
      await peers.addPeer({
        peerId: "acme.example",
        pinnedCertDer: new Uint8Array([1, 2, 3]),
        trustWeight: 0.5,
        approvedAt: "2026-11-02T10:00:00.000Z",
        enabled: true,
      })
    ).toBe(true);
    expect((await peers.get("acme.example"))?.trustWeight).toBe(0.5);
  });

  it("queryDeletedFactsPage lists a workspace's hard-deleted facts, with their creation time", async () => {
    const [gone, alsoGone, live, other] = [
      "dddddddd-dddd-4ddd-8ddd-dddddddddd01",
      "dddddddd-dddd-4ddd-8ddd-dddddddddd02",
      "dddddddd-dddd-4ddd-8ddd-dddddddddd03",
      "dddddddd-dddd-4ddd-8ddd-dddddddddd04",
    ];
    await superSql`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, created_at)
      VALUES (${gone}, ${WS_ACME}, 'global', 'other', 'orders', 'Acme order 1', '2026-11-01T09:00:00Z'),
             (${alsoGone}, ${WS_ACME}, 'global', 'other', 'orders', 'Acme order 2', '2026-11-01T10:00:00Z'),
             (${live}, ${WS_ACME}, 'global', 'other', 'orders', 'Acme order 3', '2026-11-01T11:00:00Z'),
             (${other}, ${WS_LARKSPUR}, 'global', 'other', 'orders', 'Larkspur order 1', '2026-11-01T12:00:00Z')`;
    // A log row whose fact still exists is not a deletion to serve.
    await superSql`
      INSERT INTO mnemosyne.mnemo_deletion_log
        (workspace_id, deleted_item_id, deleted_item_type, deletion_type, actor_id)
      VALUES (${WS_ACME}, ${live}, 'fact', 'hard', 'user:acme-admin')`;

    const storage = new DrizzleStorageAdapter(app.db, app.pgClient, undefined);
    const audit = { actorId: "user:acme-admin" };
    // The DELETE hands back the creation time of the row it removed.
    expect(await storage.hardDeleteFact(gone, WS_ACME, audit)).toEqual({
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });
    expect(await storage.hardDeleteFact(alsoGone, WS_ACME, audit)).toEqual({
      createdAt: new Date("2026-11-01T10:00:00Z"),
    });
    expect(await storage.hardDeleteFact(other, WS_LARKSPUR, audit)).toEqual({
      createdAt: new Date("2026-11-01T12:00:00Z"),
    });

    const all = await storage.queryDeletedFactsPage({ workspaceId: WS_ACME, limit: 10 });
    expect(all.map(({ id, createdAt }) => ({ id, createdAt }))).toEqual([
      { id: gone, createdAt: new Date("2026-11-01T09:00:00Z") },
      { id: alsoGone, createdAt: new Date("2026-11-01T10:00:00Z") },
    ]);
    // Keyset: strictly after a row's cursor.
    const rest = await storage.queryDeletedFactsPage({
      workspaceId: WS_ACME,
      cursor: all[0]!.cursor,
      limit: 10,
    });
    expect(rest.map((r) => r.id)).toEqual([alsoGone]);
    expect(
      (await storage.queryDeletedFactsPage({ workspaceId: WS_LARKSPUR, limit: 10 })).map(
        (r) => r.id
      )
    ).toEqual([other]);
    // The log itself stays unreadable to the role, and with no workspace set the
    // function returns nothing.
    await expect(app.pgClient`SELECT 1 FROM mnemosyne.mnemo_deletion_log`).rejects.toThrow(
      /permission denied/
    );
    expect(
      await app.pgClient`SELECT * FROM mnemosyne.mnemo_deleted_facts(NULL, NULL, NULL, 10)`
    ).toHaveLength(0);
  });

  it("a forged cursor reads from the start instead of failing", async () => {
    const storage = new DrizzleStorageAdapter(app.db, app.pgClient, undefined);
    const forged = Buffer.from(JSON.stringify({ v: "not a time", id: "x" })).toString("base64url");
    const deleted = await storage.queryDeletedFactsPage({
      workspaceId: WS_ACME,
      cursor: forged,
      limit: 10,
    });
    expect(deleted.map((r) => r.id)).toEqual([
      "dddddddd-dddd-4ddd-8ddd-dddddddddd01",
      "dddddddd-dddd-4ddd-8ddd-dddddddddd02",
    ]);
    const page = await storage.queryFactsPage({
      workspaceId: WS_ACME,
      status: "all",
      sortBy: "updated_at",
      order: "asc",
      cursor: forged,
      limit: 10,
    });
    expect(page.items.map((f) => f.id)).toEqual(["dddddddd-dddd-4ddd-8ddd-dddddddddd03"]);
  });

  it("the serve mark only rises, per workspace and peer", async () => {
    const storage = new DrizzleStorageAdapter(app.db, app.pgClient, undefined);
    expect(await storage.federationServeMark(WS_ACME, "larkspur.example")).toBeNull();
    await storage.raiseFederationServeMark(
      WS_ACME,
      "larkspur.example",
      new Date("2026-11-02T10:00:00Z")
    );
    await storage.raiseFederationServeMark(
      WS_ACME,
      "larkspur.example",
      new Date("2026-11-01T10:00:00Z")
    );
    expect(await storage.federationServeMark(WS_ACME, "larkspur.example")).toEqual(
      new Date("2026-11-02T10:00:00Z")
    );
    expect(await storage.federationServeMark(WS_ACME, "acme.example")).toBeNull();
    expect(await storage.federationServeMark(WS_LARKSPUR, "larkspur.example")).toBeNull();
  });
});
