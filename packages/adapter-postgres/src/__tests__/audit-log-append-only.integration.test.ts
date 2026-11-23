/**
 * SEC-6 — S3/S4: the audit log and the deletion log are append-only for the
 * application role by GRANT, not only by trigger.
 *
 * S3 promises two layers: the `enforce_audit_immutable` trigger AND no
 * UPDATE/DELETE/TRUNCATE for `mnemo_app_role`. The baseline grants only
 * SELECT, INSERT (0001), but `docker/scripts/provision-app-role.mjs` — the
 * third step of every production migration run — then executes
 * `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne`,
 * and 0015's ALTER DEFAULT PRIVILEGES hands the same to every audit partition
 * created later. Measured on the eval stack: `mnemo_app_role` held UPDATE and
 * DELETE on `mnemo_audit_log`, and the runtime login inherited them.
 *
 * This suite reproduces the production sequence exactly — migrations, then the
 * real provisioning script as a child process — and checks the EFFECTIVE
 * privileges of the `mnemo_app` login (inheritance included) on the parent
 * table, on every partition, and on a partition created afterwards; then runs
 * the provisioning script a second time, as every deploy does.
 */
import { execFile } from "node:child_process";
import { mkdtemp, cp, mkdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../migrate.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PROVISION_SCRIPT = resolve(HERE, "../../../../docker/scripts/provision-app-role.mjs");

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super_audit";
const PG_PASSWORD = "mnemo_super_audit";
const PG_DB = "mnemo_test_audit";
const APP_USER = "mnemo_app";
const APP_PASSWORD = "mnemo_app_audit_pass";

let container: StartedTestContainer;
let raw: ReturnType<typeof postgres>;
let superUrl: string;
let appUrl: string;
let scriptDir: string;

/**
 * Run the real provisioning script as Dockerfile.migrate does. It imports
 * `postgres`, which only resolves from inside a package, so it runs from a
 * temp copy next to a symlink to this package's own `postgres` dependency.
 */
async function provision(): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(scriptDir, "provision-app-role.mjs")],
    {
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: superUrl,
        MNEMO_APP_DB_PASSWORD: APP_PASSWORD,
        MNEMO_APP_DB_USER: APP_USER,
      },
    }
  );
  return stdout;
}

async function auditRelations(): Promise<string[]> {
  const rows = await raw<Array<{ rel: string }>>`
    SELECT 'mnemosyne.mnemo_audit_log' AS rel
    UNION ALL
    SELECT format('%I.%I', n.nspname, c.relname)
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass
  `;
  return rows.map((r) => r.rel);
}

async function privileges(role: string, rel: string) {
  const rows = await raw<
    Array<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }>
  >`
    SELECT has_table_privilege(${role}, ${rel}, 'SELECT')   AS sel,
           has_table_privilege(${role}, ${rel}, 'INSERT')   AS ins,
           has_table_privilege(${role}, ${rel}, 'UPDATE')   AS upd,
           has_table_privilege(${role}, ${rel}, 'DELETE')   AS del,
           has_table_privilege(${role}, ${rel}, 'TRUNCATE') AS trunc
  `;
  return rows[0]!;
}

async function expectAppendOnly(role: string): Promise<void> {
  const rels = [...(await auditRelations()), "mnemosyne.mnemo_deletion_log"];
  expect(rels.length).toBeGreaterThan(2); // parent + at least one partition + deletion log
  for (const rel of rels) {
    const p = await privileges(role, rel);
    expect({ rel, upd: p.upd, del: p.del, trunc: p.trunc }).toEqual({
      rel,
      upd: false,
      del: false,
      trunc: false,
    });
  }
  // The app still appends and reads the audit trail through the parent table.
  const parent = await privileges(role, "mnemosyne.mnemo_audit_log");
  expect({ sel: parent.sel, ins: parent.ins }).toEqual({ sel: true, ins: true });
  const deletionLog = await privileges(role, "mnemosyne.mnemo_deletion_log");
  expect(deletionLog.ins).toBe(true);
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;
  appUrl = `postgres://${APP_USER}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  raw = postgres(superUrl, { onnotice: () => void 0, max: 2 });

  scriptDir = await mkdtemp(join(tmpdir(), "mnemo-provision-"));
  await cp(PROVISION_SCRIPT, join(scriptDir, "provision-app-role.mjs"));
  await mkdir(join(scriptDir, "node_modules"));
  // `postgres` does not export ./package.json, so resolve the package directory
  // through this package's own node_modules link instead of require.resolve.
  const postgresPkg = await realpath(resolve(HERE, "../../node_modules/postgres"));
  await symlink(postgresPkg, join(scriptDir, "node_modules", "postgres"), "dir");

  expect(await provision()).toContain("provisioned");
}, 180_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
  if (scriptDir) await rm(scriptDir, { recursive: true, force: true }).catch(() => void 0);
});

describe("SEC-6 — audit and deletion logs are append-only for the app role after provisioning", () => {
  it("REGRESSION: the runtime login (mnemo_app) holds no UPDATE/DELETE/TRUNCATE on the audit log, its partitions or the deletion log", async () => {
    await expectAppendOnly(APP_USER);
  });

  it("the same holds for app_user, the role withMnemoTx switches to", async () => {
    await expectAppendOnly("app_user");
  });

  it("an UPDATE or DELETE issued as mnemo_app is refused by privilege (42501), not left to the trigger", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => void 0 });
    try {
      await expect(
        app.unsafe(`UPDATE mnemosyne.mnemo_audit_log SET action = 'recall'`)
      ).rejects.toMatchObject({ code: "42501" });
      await expect(app.unsafe(`DELETE FROM mnemosyne.mnemo_audit_log`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(app.unsafe(`DELETE FROM mnemosyne.mnemo_deletion_log`)).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await app.end();
    }
  });

  it("a partition created later (monthly rollover) is append-only too", async () => {
    await raw`SELECT mnemosyne.create_audit_partition(2099, 12)`;
    const p = await privileges(APP_USER, "mnemosyne.mnemo_audit_log_y2099m12");
    expect({ upd: p.upd, del: p.del, trunc: p.trunc }).toEqual({
      upd: false,
      del: false,
      trunc: false,
    });
  });

  it("re-running the provisioning script (every deploy does) keeps it that way", async () => {
    expect(await provision()).toContain("provisioned");
    await expectAppendOnly(APP_USER);
  });
});

describe("APP-059 — no app role touches an audit partition directly", () => {
  // A partition addressed by name is checked against its own ACL and has no
  // RLS policy of its own, so a SELECT on it would read every workspace's
  // audit trail. Reads and appends go through the parent, whose RLS applies.
  async function expectNoDirectAccess(role: string): Promise<void> {
    const parts = await raw<{ rel: string }[]>`
      SELECT i.inhrelid::regclass::text AS rel FROM pg_inherits i
      WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass`;
    expect(parts.length).toBeGreaterThan(0);
    for (const { rel } of parts) {
      const p = await privileges(role, rel);
      expect({ rel, sel: p.sel, ins: p.ins }).toEqual({ rel, sel: false, ins: false });
    }
    const parent = await privileges(role, "mnemosyne.mnemo_audit_log");
    expect({ sel: parent.sel, ins: parent.ins }).toEqual({ sel: true, ins: true });
  }

  it("mnemo_app and app_user hold no privilege on any partition", async () => {
    await expectNoDirectAccess(APP_USER);
    await expectNoDirectAccess("app_user");
  });

  it("a direct SELECT on a partition as mnemo_app is refused (42501)", async () => {
    const [first] = await raw<{ rel: string }[]>`
      SELECT i.inhrelid::regclass::text AS rel FROM pg_inherits i
      WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass LIMIT 1`;
    const rel = first!.rel;
    const app = postgres(appUrl, { max: 1, onnotice: () => void 0 });
    try {
      await expect(app.unsafe(`SELECT 1 FROM ${rel} LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await app.end();
    }
  });

  it("holds for a partition created later and after re-provisioning", async () => {
    await raw`SELECT mnemosyne.create_audit_partition(2098, 6)`;
    expect(await provision()).toContain("provisioned");
    await expectNoDirectAccess(APP_USER);
  });
});

describe("accounts stage A — provisioning keeps the definer-only writes definer-only", () => {
  async function expectProtected(role: string): Promise<void> {
    const admin = await privileges(role, "mnemosyne.mnemo_instance_admin");
    expect({ role, ...admin }).toEqual({
      role,
      sel: true,
      ins: false,
      upd: false,
      del: false,
      trunc: false,
    });
    const [columns] = await raw<Array<{ disabled: boolean; epoch: boolean; login: boolean }>>`
      SELECT has_column_privilege(${role}, 'mnemosyne.mnemo_user', 'disabled_at', 'UPDATE') AS disabled,
             has_column_privilege(${role}, 'mnemosyne.mnemo_user', 'sessions_valid_after', 'UPDATE') AS epoch,
             has_column_privilege(${role}, 'mnemosyne.mnemo_user', 'last_login_at', 'UPDATE') AS login`;
    expect({ role, ...columns }).toEqual({ role, disabled: false, epoch: true, login: true });
  }

  it("mnemo_app and app_user cannot write mnemo_instance_admin or mnemo_user.disabled_at", async () => {
    await expectProtected(APP_USER);
    await expectProtected("app_user");
  });

  it("re-running the provisioning script keeps it that way", async () => {
    expect(await provision()).toContain("provisioned");
    await expectProtected(APP_USER);
    await expectProtected("app_user");
  });
});

/**
 * APP-001 (audit 2026-11-22). The baseline creates the 2026 partitions and no
 * DEFAULT; the weekly cron asked for NEXT month only, as the server's own login.
 * That login holds USAGE on the schema, so the CREATE TABLE inside the function
 * was refused and from the first month without a partition every audit INSERT
 * failed: POST /remember answered 500 with the fact already committed. A fresh
 * install made after the last baseline month had no partition for "now" at all.
 */
describe("APP-001 — the runtime login can keep the audit log partitioned", () => {
  function monthAhead(offset: number): { year: number; month: number; name: string } {
    const now = new Date(); // determinism-ok: the runway is relative to the database clock
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    return { year, month, name: `mnemo_audit_log_y${year}m${String(month).padStart(2, "0")}` };
  }

  async function partitionExists(name: string): Promise<boolean> {
    const rows = await raw<Array<{ ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'mnemosyne.mnemo_audit_log'::regclass AND c.relname = ${name}
      ) AS ok`;
    return rows[0]!.ok;
  }

  it("a migrated database already has this month and the two after it", async () => {
    for (const offset of [0, 1, 2]) {
      const m = monthAhead(offset);
      expect({ name: m.name, exists: await partitionExists(m.name) }).toEqual({
        name: m.name,
        exists: true,
      });
    }
  });

  it("mnemo_app, the production login, creates a missing partition itself", async () => {
    const app = postgres(appUrl, {
      max: 1,
      onnotice: () => void 0,
      connection: { search_path: "mnemosyne,public" },
    });
    try {
      await app.unsafe(`SELECT mnemosyne.create_audit_partition(2031, 3)`);
      expect(await partitionExists("mnemo_audit_log_y2031m03")).toBe(true);
      // The cron's call, with the server's own connection settings.
      await app.unsafe(`SELECT mnemosyne.mnemo_audit_create_next_partition()`);
    } finally {
      await app.end();
    }
    const p = await privileges(APP_USER, "mnemosyne.mnemo_audit_log_y2031m03");
    expect({ upd: p.upd, del: p.del, trunc: p.trunc }).toEqual({
      upd: false,
      del: false,
      trunc: false,
    });
  });

  it("works under SET LOCAL ROLE app_user without a search_path (the withMnemoTx shape)", async () => {
    const app = postgres(appUrl, { max: 1, onnotice: () => void 0 });
    try {
      await app.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE app_user`);
        await tx.unsafe(`SELECT mnemosyne.mnemo_audit_create_next_partition()`);
        await tx.unsafe(`SELECT mnemosyne.create_audit_partition(2031, 4)`);
      });
    } finally {
      await app.end();
    }
    expect(await partitionExists("mnemo_audit_log_y2031m04")).toBe(true);
  });

  it("the definer functions pin their search_path and are not callable by PUBLIC", async () => {
    const rows = await raw<
      Array<{ name: string; definer: boolean; cfg: string[] | null; pub: boolean }>
    >`
      SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS cfg,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'mnemosyne'
        AND p.proname IN ('create_audit_partition', 'mnemo_audit_create_next_partition')
      ORDER BY p.proname`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect({ name: r.name, definer: r.definer, pub: r.pub }).toEqual({
        name: r.name,
        definer: true,
        pub: false,
      });
      expect(r.cfg?.some((c) => c.startsWith("search_path=") && c.includes("pg_temp"))).toBe(true);
    }
  });

  it("the definer function still refuses anything that is not a month", async () => {
    await expect(raw`SELECT mnemosyne.create_audit_partition(2031, 13)`).rejects.toThrow(
      /Invalid month/
    );
    await expect(raw`SELECT mnemosyne.create_audit_partition(1, 1)`).rejects.toThrow(
      /Invalid year/
    );
  });
});
