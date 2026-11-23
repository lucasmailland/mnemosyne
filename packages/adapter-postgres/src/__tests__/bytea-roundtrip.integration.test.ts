/**
 * The shared drizzle `bytea` type (schema/_custom-types.ts) round-trips real
 * bytes through Postgres. Its writer used to send hex without the `\x` prefix,
 * which Postgres stored as the hex characters, so every merkle_hash held 64
 * ASCII bytes instead of the 32-byte digest.
 *
 * Covers both columns that use the type: mnemo_audit_log.merkle_hash (through
 * the adapter's own append path, as the production role) and
 * mnemo_actor_dek.encrypted_key (through the query builder). Also proves a
 * chain that begins with rows the old writer stored still verifies once new
 * rows hold real bytes: those rows stay, the audit log is append-only.
 *
 * Requires Docker (`test:integration`).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { auditHashFields, computeAuditMerkleHash, verifyAuditChain } from "../merkle.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "mnemo_app_bytea";
const APP_PASS = "mnemo_app_bytea_pass";
const WS_NEW = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01";
const WS_MIXED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let adapter: DrizzleStorageAdapter;

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
  admin = postgres(superUrl, { onnotice: () => void 0, max: 2 });
  await admin.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
  `);
  appClient = postgres(`postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`, {
    max: 3,
    onnotice: () => void 0,
    connection: { search_path: "mnemosyne,public" },
  });
  adapter = new DrizzleStorageAdapter(drizzle(appClient, { schema }), appClient);
}, 120_000);

afterAll(async () => {
  await appClient?.end({ timeout: 2 }).catch(() => void 0);
  await admin?.end({ timeout: 2 }).catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

function append(workspaceId: string, resourceId: string) {
  return adapter.appendAuditEntry({
    workspaceId,
    actorType: "system",
    actorId: "system:bytea-test",
    action: "create",
    resourceKind: "fact",
    resourceId,
    isTerminal: false,
  });
}

async function storedHashes(workspaceId: string): Promise<Buffer[]> {
  const rows = await admin<{ merkle_hash: Buffer }[]>`
    SELECT merkle_hash FROM mnemosyne.mnemo_audit_log
    WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`;
  return rows.map((r) => r.merkle_hash);
}

describe("bytea round-trip", () => {
  it("merkle_hash holds the 32-byte digest and the chain verifies", async () => {
    await append(WS_NEW, "fact-1");
    await append(WS_NEW, "fact-2");

    const entries = await adapter.listAuditLog(WS_NEW, 10);
    const hashes = await storedHashes(WS_NEW);
    expect(hashes.map((h) => h.length)).toEqual([32, 32]);

    // The first entry's digest is exactly what the writer computed.
    const first = entries.find((e) => e.resourceId === "fact-1")!;
    const expected = computeAuditMerkleHash(
      auditHashFields({
        entryId: first.entryUid,
        action: "create",
        resourceKind: "fact",
        resourceId: "fact-1",
        occurredAt: first.createdAt,
      }),
      ""
    );
    expect(hashes[0]!.equals(expected)).toBe(true);
    expect(verifyAuditChain(entries)).toBe(-1);
  });

  it("a chain that starts with rows the old writer stored still verifies", async () => {
    // What the old writer left behind: the ASCII text of the digest's hex.
    const entryUid = randomUUID();
    // Just before the rows written below by the database clock, and inside the
    // audit log's current monthly partition.
    const createdAt = new Date(Date.now() - 60_000); // determinism-ok: must sit in the live partition, before now()
    const digest = computeAuditMerkleHash(
      auditHashFields({
        entryId: entryUid,
        action: "create",
        resourceKind: "fact",
        resourceId: "legacy-1",
        occurredAt: createdAt,
      }),
      ""
    );
    const legacyBytes = Buffer.from(digest.toString("hex"), "latin1");
    await admin`
      INSERT INTO mnemosyne.mnemo_audit_log
        (workspace_id, actor_type, actor_id, action, resource, resource_id,
         is_terminal, merkle_hash, created_at, entry_uid)
      VALUES (${WS_MIXED}, 'system', 'system:bytea-test', 'create', 'fact', 'legacy-1',
              false, ${legacyBytes}, ${createdAt}, ${entryUid})`;

    await append(WS_MIXED, "fact-1");
    await append(WS_MIXED, "fact-2");

    expect((await storedHashes(WS_MIXED)).map((h) => h.length)).toEqual([64, 32, 32]);
    expect(verifyAuditChain(await adapter.listAuditLog(WS_MIXED, 10))).toBe(-1);
  });

  it("encrypted_key round-trips its exact bytes through the query builder", async () => {
    const db = drizzle(admin, { schema });
    const wrapped = randomBytes(60);
    const id = `dek-${WS_NEW}-actor-bytea`;
    await db.insert(schema.actorDekTable).values({
      id,
      workspaceId: WS_NEW,
      actorId: "actor-bytea",
      encryptedKey: wrapped,
      status: "active",
    });

    const [raw] = await admin<{ encrypted_key: Buffer }[]>`
      SELECT encrypted_key FROM mnemosyne.mnemo_actor_dek WHERE id = ${id}`;
    expect(raw!.encrypted_key.equals(wrapped)).toBe(true);

    const [row] = await db
      .select({ encryptedKey: schema.actorDekTable.encryptedKey })
      .from(schema.actorDekTable)
      .where(eq(schema.actorDekTable.id, id));
    expect(Buffer.from(row!.encryptedKey!).equals(wrapped)).toBe(true);
  });
});
