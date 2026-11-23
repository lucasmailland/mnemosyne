/**
 * TEST-1: this file used to gate every test on `process.env.MNEMO_TEST_DATABASE_URL`,
 * which is never set in either CI job, and kept the `.test.ts` suffix, which the
 * unit vitest.config.ts doesn't exclude — so it ran, immediately skipped every
 * test, and reported green without exercising anything. Converted to the
 * standard testcontainers boot pattern (see fresh-install-migrate.integration.test.ts)
 * and renamed *.integration.test.ts so `pnpm test:integration` actually runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { sql } from "drizzle-orm";
import { createDrizzleClient, DrizzleStorageAdapter } from "../index.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;

describe("DrizzleStorageAdapter.updateWorth — Beta-Bernoulli (Wave C)", () => {
  let db: ReturnType<typeof createDrizzleClient>["db"];
  let client: ReturnType<typeof createDrizzleClient>["pgClient"];
  let adapter: DrizzleStorageAdapter;
  const workspaceId = crypto.randomUUID();
  const factId = crypto.randomUUID();

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
    const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;
    await migrate({ databaseUrl, log: () => void 0 });

    ({ db, pgClient: client } = createDrizzleClient(databaseUrl));
    adapter = new DrizzleStorageAdapter(db, client);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_fact
          (id, workspace_id, scope, statement, subject, kind, attribution)
        VALUES (${factId}, ${workspaceId}, 'global', 'test fact', 'ws', 'event', 'objective_fact')
        ON CONFLICT (id) DO NOTHING
      `);
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => void 0);
    await container?.stop().catch(() => void 0);
  });

  const readFact = async () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx.execute<{ worth: string; worth_alpha: string; worth_beta: string }>(
        sql`SELECT worth, worth_alpha, worth_beta FROM mnemosyne.mnemo_fact WHERE id = ${factId}`
      );
    });

  it("default worth is α/(α+β) = 0.5 when α=β=2.0 (prior only)", async () => {
    const rows = await readFact();
    expect(parseFloat(rows[0]!.worth_alpha)).toBeCloseTo(2.0);
    expect(parseFloat(rows[0]!.worth_beta)).toBeCloseTo(2.0);
    expect(parseFloat(rows[0]!.worth)).toBeCloseTo(0.5);
  });

  it("updateWorth with success increments α, not raw success", async () => {
    await adapter.updateWorth(factId, workspaceId, "fact", {
      success: 1,
      failure: 0,
      creditWeight: 1,
    });
    const rows = await readFact();
    expect(parseFloat(rows[0]!.worth_alpha)).toBeCloseTo(3.0);
    expect(parseFloat(rows[0]!.worth_beta)).toBeCloseTo(2.0);
    expect(parseFloat(rows[0]!.worth)).toBeCloseTo(0.6);
  });

  it("updateWorth with failure increments β, not raw failure", async () => {
    await adapter.updateWorth(factId, workspaceId, "fact", {
      success: 0,
      failure: 1,
      creditWeight: 1,
    });
    const rows = await readFact();
    expect(parseFloat(rows[0]!.worth_alpha)).toBeCloseTo(3.0);
    expect(parseFloat(rows[0]!.worth_beta)).toBeCloseTo(3.0);
    expect(parseFloat(rows[0]!.worth)).toBeCloseTo(0.5);
  });

  it("creditWeight scales the bump fractionally", async () => {
    await adapter.updateWorth(factId, workspaceId, "fact", {
      success: 1,
      failure: 0,
      creditWeight: 0.5,
    });
    const rows = await readFact();
    expect(parseFloat(rows[0]!.worth_alpha)).toBeCloseTo(3.5);
  });
});
