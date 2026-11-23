/**
 * CHAOS-1: an audit append must never need a second pool connection.
 *
 * `appendAuditEntry` opens a transaction, takes the per-workspace advisory
 * lock and then reads the actor's DEK to encrypt the detail. The DEK read used
 * to open its OWN transaction on the same pool. With N connections and N
 * concurrent audited writes to one workspace, the lock holder waited forever
 * for a connection held by the N-1 transactions queued on its lock: the whole
 * instance hung (40 concurrent writes on the chaos stack, pool max 10).
 *
 * This file reproduces that with a tiny pool, as the production role
 * (NOSUPERUSER NOBYPASSRLS, member of mnemo_app_role, FORCE RLS), and with a
 * deadline so a regression fails instead of hanging CI.
 *
 * Requires Docker. Run with:
 *   pnpm --filter @mnemo-ai/adapter-postgres exec vitest run \
 *     --config vitest.integration.config.ts audit-append-pool
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../schema/index.js";
import { DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { auditHashFields, bufferToHex, computeAuditMerkleHash } from "../merkle.js";
import type { DekProvisioner, DekUnwrapper } from "../repositories/types.js";
import type { AuditLogEntry } from "@mnemo-ai/types";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "mnemo_app_audit_pool";
const APP_PASS = "mnemo_app_audit_pool_pass";
const APP_NAME = "audit-append-pool-test";

const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaa01";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbb01";
const WS_C = "cccccccc-cccc-4ccc-cccc-cccccccccc01";
const ACTOR = "key:audit-pool-actor";

/** How long a bounded append may take before the test calls it a wedge. */
const DEADLINE_MS = 10_000;

let container: StartedTestContainer;
let appUrl: string;
let admin: ReturnType<typeof postgres>;

// Trivial base64 "wrap": this file tests connection use, not crypto.
const dekProvisioner: DekProvisioner = () => {
  const dek = randomBytes(32);
  return { dek, wrapped: dek.toString("base64") };
};
const dekUnwrapper: DekUnwrapper = (_ws, _actor, wrapped) => Buffer.from(wrapped, "base64");

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
  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  // One active DEK per workspace for the same actor id, so a cross-workspace
  // DEK read would decrypt with the wrong key and fail loudly.
  for (const ws of [WS_A, WS_B, WS_C]) {
    const { wrapped } = dekProvisioner(ws, ACTOR);
    await admin.unsafe(
      `INSERT INTO mnemosyne.mnemo_actor_dek (id, workspace_id, actor_id, encrypted_key, status)
       VALUES ($1, $2, $3, decode($4, 'base64'), 'active')`,
      [`dek-${ws}-${ACTOR}`, ws, ACTOR, wrapped]
    );
  }
}, 120_000);

afterAll(async () => {
  await admin?.end({ timeout: 2 }).catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

function smallPoolAdapter(max: number): {
  adapter: DrizzleStorageAdapter;
  close: () => Promise<void>;
} {
  const pgClient = postgres(appUrl, {
    max,
    onnotice: () => void 0,
    connection: { search_path: "mnemosyne,public", application_name: APP_NAME },
  });
  const db = drizzle(pgClient, { schema });
  return {
    adapter: new DrizzleStorageAdapter(db, pgClient, dekUnwrapper, dekProvisioner),
    close: async () => {
      // A wedged pool never drains on its own: drop its sockets, then kill any
      // backend still queued on the advisory lock, so a regression fails fast
      // instead of hanging the file.
      await pgClient.end({ timeout: 0 }).catch(() => void 0);
      await admin
        .unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`,
          [APP_NAME]
        )
        .catch(() => void 0);
    },
  };
}

async function withinDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: still pending after ${DEADLINE_MS} ms (pool wedged)`)),
      DEADLINE_MS
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function auditEntry(workspaceId: string, i: number): Omit<AuditLogEntry, "id" | "createdAt"> {
  return {
    workspaceId,
    actorId: ACTOR,
    actorType: "agent",
    action: "create",
    resourceKind: "fact",
    resourceId: `fact-${i}`,
    detail: { seq: i, note: `secret detail ${i}` },
    isTerminal: false,
  };
}

/**
 * Index of the first entry that does not extend its predecessor, or -1.
 *
 * Mirrors the writer: each hash commits to the previous row's stored
 * `merkle_hash` (as `bufferToHex` reads it). Today the bytea column holds the
 * hash's hex text rather than its raw bytes (the custom `bytea` type sends hex
 * without the `\x` prefix), so the stored value is compared in either form.
 */
function firstForkedLink(
  rows: Array<{
    entry_uid: string;
    action: string;
    resource: string;
    resource_id: string | null;
    created_at: Date;
    merkle_hash: Buffer | null;
  }>
): number {
  let prev = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const expected = computeAuditMerkleHash(
      auditHashFields({
        entryId: r.entry_uid,
        action: r.action,
        resourceKind: r.resource,
        resourceId: r.resource_id ?? null,
        occurredAt: r.created_at,
      }),
      prev
    ).toString("hex");
    const stored = r.merkle_hash ?? Buffer.alloc(0);
    if (stored.toString("hex") !== expected && stored.toString("utf8") !== expected) return i;
    prev = bufferToHex(stored);
  }
  return -1;
}

async function chainRows(workspaceId: string) {
  const rows = await admin<
    Array<{
      entry_uid: string;
      action: string;
      resource: string;
      resource_id: string | null;
      created_at: Date;
      merkle_hash: Buffer | null;
      metadata: unknown;
    }>
  >`
    SELECT entry_uid, action, resource, resource_id, created_at, merkle_hash, metadata
    FROM mnemosyne.mnemo_audit_log
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at, id
  `;
  return rows;
}

describe("CHAOS-1: audit append and the connection pool", () => {
  it("one encrypted append completes on a one-connection pool", async () => {
    const { adapter, close } = smallPoolAdapter(1);
    try {
      await withinDeadline(
        adapter.appendAuditEntry(auditEntry(WS_A, 0)),
        "single append, pool max 1"
      );
      const rows = await chainRows(WS_A);
      expect(rows).toHaveLength(1);
      // Encrypted with the actor's DEK, not stored in clear.
      expect(JSON.stringify(rows[0]!.metadata)).toContain("enc:v1:");
    } finally {
      await close();
    }
  });

  it("N concurrent audited writes on a pool of N connections all land, chained and decryptable", async () => {
    const POOL = 3;
    const WRITES = 12;
    const { adapter, close } = smallPoolAdapter(POOL);
    try {
      await withinDeadline(
        Promise.all(
          Array.from({ length: WRITES }, (_, i) =>
            adapter.appendAuditEntry(auditEntry(WS_B, i))
          )
        ),
        `${WRITES} concurrent appends, pool max ${POOL}`
      );

      const rows = await chainRows(WS_B);
      expect(rows).toHaveLength(WRITES);
      // The advisory lock still serializes appends: one linear chain, no fork.
      expect(firstForkedLink(rows)).toBe(-1);

      const listed = await withinDeadline(adapter.listAuditLog(WS_B, 100), "listAuditLog");
      expect(listed).toHaveLength(WRITES);
      const seqs = listed.map((e) => (e.detail as { seq?: number } | undefined)?.seq).sort(
        (a, b) => (a ?? 0) - (b ?? 0)
      );
      expect(seqs).toEqual(Array.from({ length: WRITES }, (_, i) => i));
    } finally {
      await close();
    }
  });

  it("the in-transaction DEK read stays scoped to the entry's workspace", async () => {
    const { adapter, close } = smallPoolAdapter(2);
    try {
      await withinDeadline(
        Promise.all([
          adapter.appendAuditEntry(auditEntry(WS_C, 1)),
          adapter.appendAuditEntry(auditEntry(WS_A, 2)),
        ]),
        "two workspaces"
      );
      // Each entry decrypts with its own workspace's DEK (same actor id, distinct keys).
      const c = await adapter.listAuditLog(WS_C, 10);
      expect(c.map((e) => (e.detail as { seq?: number }).seq)).toEqual([1]);
      const a = await adapter.listAuditLog(WS_A, 10);
      expect(a.map((e) => (e.detail as { seq?: number }).seq)).toEqual([0, 2]);
    } finally {
      await close();
    }
  });
});
