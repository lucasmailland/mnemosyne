/**
 * AUDIT-MERKLE (found by WP-2): the weekly `mnemo.audit.merkle` cron runs
 * `verifyAuditChain(listAuditLog(...))` over real rows, and it could never
 * pass:
 *
 *  - the drizzle `bytea` type writes `merkle_hash` as the ASCII text of the
 *    digest's hex (no `\x` prefix), while the verifier compared the stored
 *    bytes with the raw digest — every chain "broke" at index 0;
 *  - `listAuditLog` did not return `entry_uid`, one of the committed fields;
 *  - the writer chains a new entry to the last NON-terminal row, while the
 *    verifier restarted the chain after a terminal (GDPR) row.
 *
 * Proven on real Postgres, as the production role, through the adapter's own
 * append path — and a tampered row is still caught.
 *
 * Requires Docker:
 *   pnpm --filter @mnemo-ai/adapter-postgres exec vitest run \
 *     --config vitest.integration.config.ts audit-merkle-verify
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../schema/index.js";
import { DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { verifyAuditChain } from "../merkle.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "mnemo_app_audit_merkle";
const APP_PASS = "mnemo_app_audit_merkle_pass";
const WS = "dddddddd-dddd-4ddd-dddd-dddddddddd01";

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

async function append(
  action: "create" | "update" | "erasure_initiated",
  resourceId: string,
  isTerminal = false
) {
  await adapter.appendAuditEntry({
    workspaceId: WS,
    actorType: "system",
    actorId: "system:audit-merkle-test",
    action,
    resourceKind: "fact",
    resourceId,
    isTerminal,
  });
}

describe("AUDIT-MERKLE — verifyAuditChain over real rows", () => {
  it("a chain written by appendAuditEntry verifies, across a terminal row", async () => {
    await append("create", "fact-1");
    await append("update", "fact-1");
    await append("erasure_initiated", "fact-1", true);
    await append("create", "fact-2");
    await append("update", "fact-2");

    const entries = await adapter.listAuditLog(WS, 100);
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => typeof e.entryUid === "string")).toBe(true);
    expect(verifyAuditChain(entries)).toBe(-1);
  });

  it("a tampered row is still caught", async () => {
    // The immutability trigger blocks UPDATE; a superuser bypassing it is the
    // tamperer this check exists for.
    await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL session_replication_role = replica");
      await tx`
        UPDATE mnemosyne.mnemo_audit_log SET resource_id = 'fact-evil'
        WHERE workspace_id = ${WS} AND resource_id = 'fact-2' AND action = 'create'
      `;
    });
    const entries = await adapter.listAuditLog(WS, 100);
    const tampered = entries.findIndex((e) => e.resourceId === "fact-evil");
    expect(tampered).toBeGreaterThan(0);
    expect(verifyAuditChain(entries)).toBe(tampered);
  });
});
