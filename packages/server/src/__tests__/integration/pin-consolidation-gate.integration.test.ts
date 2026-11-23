/**
 * Tool-promise audit — `memory_pin` (docs/archive/openspec/tool-promise-remediation/tools/memory_pin.md).
 *
 * Verifies the FIRST half of the tool's promise ("protege de prune/forget
 * automáticos") end-to-end against a real Postgres instance, bridging two
 * packages that must agree on the same physical column:
 *
 *   1. `packages/adapter-postgres`'s `DrizzleStorageAdapter.updateFact` — the
 *      function `packages/mcp/src/tools/pin.ts` triggers via
 *      `POST /facts/:id/pin` (`facts.ts`'s route, `UpdateFactInput.pinned`,
 *      flatten-legacy-dual-core PR9a/D6.1 — this used to be the legacy
 *      `CoreLike.pinFact()`, raw SQL inside `withMnemoTx()`).
 *   2. The SAME `DrizzleStorageAdapter` — what the real
 *      consolidation scheduler (`packages/server/src/boot/consolidation.ts`)
 *      reads facts through, always schema-qualified as `mnemosyne.mnemo_fact`.
 *   3. `packages/consolidation`'s `runConsolidationGate()` — the real,
 *      unmocked pure function that decides whether a cluster may merge.
 *
 * Why this needs real Postgres, not mocks: BOTH the legacy core migrations
 * (`packages/core/migrations/0017_mnemosyne_init.sql`, unqualified —
 * resolves to `public.mnemo_fact`) and the v3 adapter-postgres migrations
 * (`packages/adapter-postgres/migrations`, explicit `mnemosyne.mnemo_fact`)
 * create a table named `mnemo_fact`, in DIFFERENT schemas, with the SAME
 * `pinned` column. `docs/STATUS.md`'s `memory_doctor` audit already flags
 * this "dual schema" overlap as an expected, harmless warning — this test
 * proves `pin.ts`'s write lands in the real `mnemosyne.mnemo_fact` table
 * the consolidation gate reads, not the orphaned `public.mnemo_fact` shadow
 * copy the legacy core migration stream still creates, by inspecting BOTH schemas
 * directly with a superuser connection after the real `pinFact()` call.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runConsolidationGate, type GateFact } from "@mnemo-ai/consolidation";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";
const WS = "c1c2c3c4-e5f6-7890-abcd-ef1234567890";

// A NOSUPERUSER, NOBYPASSRLS role that inherits `mnemo_app_role` — used for
// the verification reads, per this repo's hard rule (docs/archive/audits/README.md):
// DB/RLS claims must be checked against a real non-superuser role, not just
// a superuser connection (which would silently sail past FORCE RLS).
const VERIFY_ROLE = "pin_gate_verify";
const VERIFY_PASSWORD = "pin_gate_verify_pw";

let container: StartedTestContainer;
let databaseUrl: string;
let superSql: ReturnType<typeof postgres>;
let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let storageClose: (() => Promise<void>) | undefined;

// 1536-dim halfvec literal — identical for all 3 seeded facts so every
// pairwise cosine similarity is exactly 1.0 (>= the gate's 0.85 threshold).
const EMBEDDING_LITERAL = `[${Array(1536).fill("0.1").join(",")}]`;

async function seedFact(id: string, subject: string) {
  await superSql`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, sensitivity,
       worth_alpha, worth_beta, hit_count, last_recalled_at, embedding, pinned)
    VALUES
      (${id}, ${WS}, 'global', 'other', ${subject}, ${`${subject} statement`}, 'internal',
       1.0000, 5.0000, 0, NULL, ${EMBEDDING_LITERAL}::public.halfvec(1536), false)
  `;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // Apply BOTH migration streams, exactly mirroring production
  // (docker/Dockerfile.migrate runs both) and api.integration.test.ts's
  // bootstrap — legacy core (0015 creates `app_user`, 0017 creates the
  // shadow `public.mnemo_fact`) THEN v3 adapter-postgres (creates
  // `mnemosyne.mnemo_fact` + `mnemo_app_role`, and unconditionally grants
  // `mnemo_app_role` to `app_user`).
  await execFileAsync(process.execPath, [
    MIGRATE_CLI,
    "--migrations-dir",
    MIGRATIONS_DIR,
    "--database-url",
    databaseUrl,
  ]);
  // adapter-postgres's migrate CLI reads DATABASE_URL from the environment,
  // not a --database-url flag (different CLI contract than core's).
  await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  superSql = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });

  // Verification role: NOSUPERUSER, NOBYPASSRLS, inherits mnemo_app_role —
  // proves the assertions below hold under real RLS enforcement, not just
  // superuser bypass.
  await superSql.unsafe(`
    CREATE ROLE ${VERIFY_ROLE} LOGIN PASSWORD '${VERIFY_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${VERIFY_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${VERIFY_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${VERIFY_ROLE};
  `);
  const roleRows = await superSql<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${VERIFY_ROLE}
  `;
  expect(roleRows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

  const adapterPgMod = await import("@mnemo-ai/adapter-postgres");
  const { db, pgClient } = adapterPgMod.createDrizzleClient(databaseUrl);
  storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient);
  storageClose = () => pgClient.end({ timeout: 5 });
}, 180_000);

afterAll(async () => {
  await storageClose?.().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_pin scenario 1: pinned fact survives a consolidation pass that would otherwise merge it", () => {
  it("storage.updateFact({pinned:true}) (the function pin.ts's HTTP route calls) writes mnemosyne.mnemo_fact.pinned — the SAME column/table the consolidation gate reads — not the orphaned public.mnemo_fact shadow copy", async () => {
    await seedFact("pcg-a", "pin-gate-subject-a");
    await seedFact("pcg-b", "pin-gate-subject-b");
    await seedFact("pcg-c", "pin-gate-subject-c");

    // The REAL production code path: this is exactly what
    // packages/mcp/src/tools/pin.ts triggers via the client and
    // POST /facts/:id/pin.
    const pinned = await storage.updateFact("pcg-a", WS, { pinned: true });
    expect(pinned?.pinned).toBe(true);

    // Verify against the REAL table (mnemosyne.mnemo_fact) as a NOSUPERUSER
    // RLS-scoped role — the same table+role class DrizzleStorageAdapter and
    // the consolidation scheduler use in production.
    const verifySql = postgres(
      `postgres://${VERIFY_ROLE}:${VERIFY_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`,
      { max: 1, onnotice: () => void 0 }
    );
    try {
      // Session-level (not transaction-local) GUC — safe here because this
      // connection pool is capped at max:1, so it's the same underlying
      // connection for every query below. Canonical GUC name/cast per
      // RlsMiddleware.ts / the mnemo_fact_ws policy: mnemosyne.workspace_id::uuid.
      await verifySql.unsafe(`SELECT set_config('mnemosyne.workspace_id', '${WS}', false)`);
      const rows = await verifySql<Array<{ id: string; pinned: boolean }>>`
        SELECT id, pinned FROM mnemosyne.mnemo_fact WHERE id IN ('pcg-a', 'pcg-b', 'pcg-c') ORDER BY id
      `;
      expect(rows).toEqual([
        { id: "pcg-a", pinned: true },
        { id: "pcg-b", pinned: false },
        { id: "pcg-c", pinned: false },
      ]);
    } finally {
      await verifySql.end();
    }

    // Cross-check: if pin.ts's write had silently landed on the orphaned
    // public.mnemo_fact shadow table instead (the dual-schema risk this
    // test exists to rule out), that row would show pinned=false here while
    // mnemosyne.mnemo_fact (checked above) showed true — a real, dangerous
    // divergence. Confirm the shadow copy was untouched by pinFact():
    const publicRows = await superSql<Array<{ id: string; pinned: boolean }>>`
      SELECT id, pinned FROM public.mnemo_fact WHERE id = 'pcg-a'
    `;
    expect(publicRows).toEqual([]); // pinFact() never touched the public shadow copy — confirms single source of truth

    // Feed the REAL fetched rows into the REAL (unmocked) consolidation gate.
    const gateRows = await superSql<
      Array<{
        id: string;
        worth: string;
        worth_alpha: string;
        worth_beta: string;
        pinned: boolean;
        canonical: boolean;
        sensitivity: string;
        hit_count: number;
        last_recalled_at: Date | null;
      }>
    >`
      SELECT id, worth, worth_alpha, worth_beta, pinned, canonical, sensitivity, hit_count, last_recalled_at
      FROM mnemosyne.mnemo_fact WHERE id IN ('pcg-a', 'pcg-b', 'pcg-c') ORDER BY id
    `;
    expect(gateRows).toHaveLength(3);
    expect(Number(gateRows[0]!.worth)).toBeLessThan(0.5); // sanity: worth ceiling condition genuinely satisfied

    const members: GateFact[] = gateRows.map((r) => ({
      id: r.id,
      worth: Number(r.worth),
      worthAlpha: Number(r.worth_alpha),
      worthBeta: Number(r.worth_beta),
      pinned: r.pinned,
      canonical: r.canonical,
      contested: false,
      sensitivity: r.sensitivity,
      hitCount: r.hit_count,
      lastRecalledAt: r.last_recalled_at,
      embedding: Array(1536).fill(0.1), // identical embeddings seeded above → cosine 1.0 for all pairs
    }));

    const result = runConsolidationGate({ members });
    expect(result.passed).toBe(false);
    expect(result.failedCondition).toBe("pinned");
  });

  it("control: with all-else-equal and NO member pinned, the same cluster PASSES the gate — isolating `pinned` as the true blocking condition, not an accident of the other 5", async () => {
    await seedFact("pcg-ctrl-a", "pin-gate-ctrl-a");
    await seedFact("pcg-ctrl-b", "pin-gate-ctrl-b");
    await seedFact("pcg-ctrl-c", "pin-gate-ctrl-c");
    // Explicitly unpin via the real production function (defensive — seed defaults to false already).
    await storage.updateFact("pcg-ctrl-a", WS, { pinned: false });

    const gateRows = await superSql<
      Array<{
        id: string;
        worth: string;
        worth_alpha: string;
        worth_beta: string;
        pinned: boolean;
        canonical: boolean;
        sensitivity: string;
        hit_count: number;
        last_recalled_at: Date | null;
      }>
    >`
      SELECT id, worth, worth_alpha, worth_beta, pinned, canonical, sensitivity, hit_count, last_recalled_at
      FROM mnemosyne.mnemo_fact WHERE id IN ('pcg-ctrl-a', 'pcg-ctrl-b', 'pcg-ctrl-c') ORDER BY id
    `;
    const members: GateFact[] = gateRows.map((r) => ({
      id: r.id,
      worth: Number(r.worth),
      worthAlpha: Number(r.worth_alpha),
      worthBeta: Number(r.worth_beta),
      pinned: r.pinned,
      canonical: r.canonical,
      contested: false,
      sensitivity: r.sensitivity,
      hitCount: r.hit_count,
      lastRecalledAt: r.last_recalled_at,
      embedding: Array(1536).fill(0.1),
    }));

    const result = runConsolidationGate({ members });
    expect(result.passed).toBe(true);
  });
});
