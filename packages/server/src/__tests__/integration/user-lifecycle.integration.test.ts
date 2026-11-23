/** Migration 0050 against real Postgres, called as a NOSUPERUSER app login. Node >=22 + Docker. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { PostgresUserStatusSource } from "../../user-status.js";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const migrationsDir = resolve(root, "packages/adapter-postgres/migrations/baseline");
const EPOCH = new Date(0);
const NEW_ACTIONS = [
  "login_success",
  "login_failure",
  "user_created",
  "user_disabled",
  "user_enabled",
  "user_offboarded",
  "superadmin_granted",
  "superadmin_revoked",
  "member_added",
  "member_removed",
  "member_role_changed",
  "invitation_created",
  "invitation_revoked",
  "invitation_accepted",
  "link_created",
  "password_changed",
  "password_reset",
  "settings_changed",
  "workspace_opened",
];

let container: StartedTestContainer;
let admin: postgres.Sql;
let client: postgres.Sql;
let counter = 0;

/** A fresh user through the migration owner's provisioning helper. */
const newUser = async (label: string): Promise<string> => {
  counter += 1;
  const [row] =
    await admin`SELECT user_id FROM mnemosyne.mnemo_provision_user(${`${label}-${counter}@lifecycle.test`}, ${label}, 'Personal')`;
  return row!.user_id as string;
};
const seedAdmin = (userId: string) =>
  admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${userId}, 'system:test')`;
const activeAdmins = async () => {
  const [row] = await admin`
    SELECT count(*)::int AS count FROM mnemosyne.mnemo_instance_admin a
    JOIN mnemosyne.mnemo_user u ON u.id = a.user_id WHERE u.disabled_at IS NULL`;
  return row!.count as number;
};
/** Calls run inside a transaction as app_user, the way withMnemoTx reaches the database. */
const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  client.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    return fn(tx);
  }) as Promise<T>;
const revoke = (actor: string, target: string) =>
  asApp((tx) => tx`SELECT mnemosyne.mnemo_instance_revoke_admin(${actor}, ${target})`);
const grant = (actor: string, target: string) =>
  asApp((tx) => tx`SELECT mnemosyne.mnemo_instance_grant_admin(${actor}, ${target})`);
const status = (userId: string) =>
  asApp((tx) => tx`SELECT * FROM mnemosyne.mnemo_user_status(${userId})`);
const isAdmin = async (userId: string) => {
  const [row] = await asApp(
    (tx) => tx`SELECT mnemosyne.mnemo_instance_is_admin(${userId}) AS is_admin`
  );
  return row!.is_admin as boolean;
};
const insertAudit = (
  action: string,
  createdAt = new Date() // determinism-ok: compared with the database clock
) =>
  admin`INSERT INTO mnemosyne.mnemo_audit_log
          (workspace_id, actor_type, actor_id, action, resource, merkle_hash, created_at)
        VALUES ('00000000-0000-0000-0000-000000000000', 'user', 'lifecycle-test', ${action},
                'user', '\\x00'::bytea, ${createdAt})`;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const address = `${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;
  const url = `postgres://mnemo:mnemo@${address}`;
  admin = postgres(url, { onnotice: () => {} });
  await admin`CREATE EXTENSION IF NOT EXISTS vector`;
  await run(
    process.execPath,
    [
      resolve(root, "packages/core/dist/migrate.js"),
      "--migrations-dir",
      resolve(root, "packages/core/migrations"),
      "--database-url",
      url,
    ],
    { timeout: 120_000 }
  );
  await run(process.execPath, [resolve(root, "packages/adapter-postgres/dist/migrate.js")], {
    env: { ...process.env, DATABASE_URL: url },
    timeout: 120_000,
  });
  await admin.unsafe(
    "CREATE ROLE lifecycle_test LOGIN PASSWORD 'lifecycle-test-only' NOSUPERUSER NOBYPASSRLS; GRANT app_user, mnemo_app_role TO lifecycle_test; GRANT USAGE ON SCHEMA mnemosyne TO lifecycle_test;"
  );
  client = postgres(`postgres://lifecycle_test:lifecycle-test-only@${address}`, {
    max: 10,
    onnotice: () => {},
  });
}, 120_000);
afterAll(async () => {
  await client?.end();
  await admin?.end();
  await container?.stop();
});

describe("0050 user lifecycle", () => {
  beforeEach(async () => {
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin`;
  });

  it("forces RLS on mnemo_instance_admin and app_user cannot select it directly", async () => {
    const [rls] =
      await admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'mnemosyne.mnemo_instance_admin'::regclass`;
    expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const [policies] =
      await admin`SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'mnemosyne' AND tablename = 'mnemo_instance_admin'`;
    expect(policies!.count).toBe(0);

    const user = await newUser("rls");
    await seedAdmin(user);
    expect(await asApp((tx) => tx`SELECT * FROM mnemosyne.mnemo_instance_admin`)).toHaveLength(0);
    await expect(
      asApp(
        (tx) =>
          tx`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${user}, ${user}) ON CONFLICT DO NOTHING`
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp((tx) => tx`DELETE FROM mnemosyne.mnemo_instance_admin RETURNING user_id`)
    ).rejects.toMatchObject({ code: "42501" });
    expect(await activeAdmins()).toBe(1);
  });

  it("reports status for a user", async () => {
    const user = await newUser("status");
    const rows = await status(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disabled_at: null, is_superadmin: false });
    expect(rows[0]!.sessions_valid_after).toEqual(EPOCH);
    const [profile] =
      await admin`SELECT last_login_at, disabled_at FROM mnemosyne.mnemo_user WHERE id = ${user}`;
    expect(profile).toMatchObject({ last_login_at: null, disabled_at: null });

    await seedAdmin(user);
    expect((await status(user))[0]).toMatchObject({ is_superadmin: true });
    expect(await status("no-such-user")).toHaveLength(0);
  });

  it("PostgresUserStatusSource returns normalized Dates and null for unknown users", async () => {
    const user = await newUser("source");
    const source = new PostgresUserStatusSource(client);
    expect(await source.load(user)).toEqual({
      disabledAt: null,
      sessionsValidAfter: EPOCH,
      isSuperadmin: false,
    });
    await seedAdmin(user);
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${user}`;
    const loaded = await source.load(user);
    expect(loaded?.disabledAt).toBeInstanceOf(Date);
    expect(loaded?.sessionsValidAfter).toBeInstanceOf(Date);
    expect(loaded?.isSuperadmin).toBe(false); // a disabled superadmin does not count;
    expect(await source.load("no-such-user")).toBeNull();
  });

  it("counts only existing, enabled users as superadmins", async () => {
    const user = await newUser("disabled-admin");
    await seedAdmin(user);
    expect(await isAdmin(user)).toBe(true);
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${user}`;
    expect(await isAdmin(user)).toBe(false);
    expect(await isAdmin("no-such-user")).toBe(false);
    expect(await isAdmin(await newUser("plain"))).toBe(false);
  });

  it("refuses to revoke the last superadmin", async () => {
    const a = await newUser("last");
    await seedAdmin(a);
    await expect(revoke(a, a)).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("last_superadmin"),
    });
    // A disabled superadmin does not keep the installation administrable.
    const dormant = await newUser("dormant");
    await seedAdmin(dormant);
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${dormant}`;
    await expect(revoke(a, a)).rejects.toMatchObject({ code: "23514" });
    expect(await activeAdmins()).toBe(1);
  });

  it("refuses a grant from a non-superadmin", async () => {
    const outsider = await newUser("outsider");
    const target = await newUser("target");
    await expect(grant(outsider, target)).rejects.toMatchObject({ code: "42501" });
    await expect(grant(outsider, outsider)).rejects.toMatchObject({ code: "42501" });
    const a = await newUser("granter");
    await seedAdmin(a);
    await expect(revoke(outsider, a)).rejects.toMatchObject({ code: "42501" });
    // A disabled superadmin can no longer act.
    await seedAdmin(target);
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${target}`;
    await expect(grant(target, outsider)).rejects.toMatchObject({ code: "42501" });
    const [rows] = await admin`SELECT count(*)::int AS count FROM mnemosyne.mnemo_instance_admin`;
    expect(rows!.count).toBe(2);
  });

  it("grants and revokes, ending the revoked user's sessions", async () => {
    const a = await newUser("grantor");
    const b = await newUser("grantee");
    await seedAdmin(a);
    await grant(a, b);
    await grant(a, b); // idempotent
    const [row] =
      await admin`SELECT granted_by FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${b}`;
    expect(row!.granted_by).toBe(a);
    expect(await isAdmin(b)).toBe(true);
    expect((await status(b))[0]!.sessions_valid_after).toEqual(EPOCH);

    const before = Date.now(); // determinism-ok: compared with the database clock
    await revoke(a, b);
    expect(await isAdmin(b)).toBe(false);
    const after = (await status(b))[0]!;
    expect(after.is_superadmin).toBe(false);
    expect((after.sessions_valid_after as Date).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect((await status(a))[0]!.sessions_valid_after).toEqual(EPOCH);
  });

  it("never leaves zero superadmins under concurrent mutual revocation", async () => {
    const a = await newUser("mutual-a");
    const b = await newUser("mutual-b");
    await seedAdmin(a);
    await seedAdmin(b);
    // Hold the functions' lock so both calls are in flight at once, then let go.
    const gate = await admin.reserve();
    try {
      await gate`SELECT pg_advisory_lock(hashtext('mnemo_instance_admin'))`;
      const results = Promise.allSettled([revoke(a, b), revoke(b, a)]);
      // Bounded: a function that skips the lock never waits, and must still fail below.
      for (let tries = 0; tries < 200; tries++) {
        const [row] =
          await admin`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        if ((row!.count as number) >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await gate`SELECT pg_advisory_unlock(hashtext('mnemo_instance_admin'))`;
      const settled = await results;
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        code: "23514",
        message: expect.stringContaining("last_superadmin"),
      });
    } finally {
      gate.release();
    }
    expect(await activeAdmins()).toBe(1);
  });

  it("accepts every new audit action", async () => {
    for (const action of NEW_ACTIONS) await insertAudit(action);
    const [count] =
      await admin`SELECT count(*)::int AS count FROM mnemosyne.mnemo_audit_log WHERE actor_id = 'lifecycle-test' AND action IN ${admin(NEW_ACTIONS)}`;
    expect(count!.count).toBe(NEW_ACTIONS.length);
    await expect(insertAudit("not_an_action")).rejects.toMatchObject({ code: "23514" });
    await expect(insertAudit("recall")).resolves.toBeDefined();

    // Every partition carries the widened CHECK, including one created after 0050.
    await admin`SELECT mnemosyne.create_audit_partition(2027, 1)`;
    const partitions = await admin`
      SELECT c.relname, pg_get_constraintdef(k.oid) AS def
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      LEFT JOIN pg_constraint k ON k.conrelid = c.oid AND k.conname = 'mnemo_audit_log_action_check'
      WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass`;
    expect(partitions.length).toBeGreaterThan(12);
    for (const part of partitions) {
      expect(part.def, part.relname as string).toContain("workspace_opened");
      expect(part.def, part.relname as string).toContain("ip_denied");
    }
    await insertAudit("workspace_opened", new Date("2027-01-15T00:00:00Z"));
    await expect(
      insertAudit("not_an_action", new Date("2027-01-15T00:00:00Z"))
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("restricts every 0050 function to the app roles and pins its search_path", async () => {
    const functions = await admin`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
             has_function_privilege('mnemo_app_role', p.oid, 'EXECUTE') AS app_role_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'mnemosyne'
        AND p.proname IN ('mnemo_user_status', 'mnemo_instance_is_admin',
                          'mnemo_instance_grant_admin', 'mnemo_instance_revoke_admin')`;
    expect(functions).toHaveLength(4);
    for (const fn of functions) {
      expect(fn, fn.proname as string).toMatchObject({
        prosecdef: true,
        public_exec: false,
        app_user_exec: true,
        app_role_exec: true,
        proconfig: ["search_path=mnemosyne, pg_temp"],
      });
    }
  });

  it("reverts with the down migration and re-applies", async () => {
    const up = await readFile(resolve(migrationsDir, "0050_user_lifecycle_superadmin.sql"), "utf8");
    const down = await readFile(
      resolve(migrationsDir, "0050_user_lifecycle_superadmin.down.sql"),
      "utf8"
    );
    // Rows written with 0050 actions stay: the audit log is append-only.
    await insertAudit("login_success");
    // The down file carries its own BEGIN/COMMIT, so it needs a dedicated connection.
    const conn = await admin.reserve();
    try {
      await conn.unsafe(down);
    } finally {
      conn.release();
    }
    const [state] = await admin`
      SELECT to_regclass('mnemosyne.mnemo_instance_admin') AS tbl,
             to_regprocedure('mnemosyne.mnemo_user_status(text)') AS status_fn,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_schema = 'mnemosyne' AND table_name = 'mnemo_user'
                 AND column_name IN ('disabled_at', 'sessions_valid_after', 'last_login_at')) AS cols`;
    expect(state).toMatchObject({ tbl: null, status_fn: null, cols: 0 });
    await expect(insertAudit("login_success")).rejects.toMatchObject({ code: "23514" });
    await insertAudit("recall");

    await admin.begin((tx) => tx.unsafe(up));
    const user = await newUser("reapplied");
    expect(await status(user)).toHaveLength(1);
    await insertAudit("login_success");
  });
});
