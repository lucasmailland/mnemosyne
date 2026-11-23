/**
 * federatedRecallCandidates as the app role (NOSUPERUSER NOBYPASSRLS), the way
 * a production server reads: mnemo_federated_item is FORCE RLS on a policy that
 * reads app.current_workspace_id, so a missing GUC would fail every read and
 * recall would silently return no federated item. Also: another workspace's
 * items, a tier above the caller's, an archived item and an unknown tier stay
 * out; the Spanish arm matches; the query uses the 0065 index.
 * Requires Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const WS_A = "aaa00000-0000-4000-8000-000000000065";
const WS_B = "bbb00000-0000-4000-8000-000000000065";

let container: StartedTestContainer;
let superSql: postgres.Sql;
let app: DrizzleStorageAdapter;

async function seed(
  workspaceId: string,
  remoteId: string,
  statement: string,
  sensitivity: string,
  archived = false
) {
  await superSql`
    INSERT INTO mnemosyne.mnemo_federated_item
      (workspace_id, remote_id, peer_domain, version, payload, archived)
    VALUES (${workspaceId}::uuid, ${remoteId}, 'acme.example', 1,
            ${superSql.json({ statement, sensitivity, validFrom: "2026-01-01T00:00:00.000Z", validTo: null })},
            ${archived})`;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const url = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: url, log: () => undefined });
  superSql = postgres(url, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE appconn_65 LOGIN PASSWORD 'appconn_65' NOSUPERUSER NOBYPASSRLS;
    GRANT mnemo_app_role TO appconn_65;
    GRANT CONNECT ON DATABASE mnemo_test TO appconn_65;
  `);
  await seed(WS_A, "r-ships", "Acme ships its larkspur orders on Fridays.", "internal");
  await seed(WS_A, "r-secret", "Larkspur orders carry a confidential discount.", "confidential");
  await seed(WS_A, "r-archived", "Larkspur orders used to ship on Mondays.", "public", true);
  await seed(WS_A, "r-odd", "Larkspur orders tier is made up.", "top-secret");
  await seed(WS_A, "r-es", "Los pedidos de Larkspur se envían los viernes.", "public");
  await seed(WS_B, "r-other", "Larkspur orders of another workspace.", "public");

  const { db, pgClient } = createDrizzleClient(
    url.replace("mnemo_test:mnemo_test@", "appconn_65:appconn_65@")
  );
  app = new DrizzleStorageAdapter(db, pgClient);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("federatedRecallCandidates as the app role", () => {
  it("returns only the workspace's live items at the caller's tiers", async () => {
    const rows = await app.federatedRecallCandidates({
      workspaceId: WS_A,
      terms: ["larkspur", "orders"],
      limit: 10,
      sensitivity: ["public", "internal"],
    });
    expect(rows.map((r) => r.statement)).toEqual(["Acme ships its larkspur orders on Fridays."]);
    expect(rows[0]).toMatchObject({
      peerDomain: "acme.example",
      sensitivity: "internal",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: null,
    });
  });

  it("a tier outside the four reads as restricted", async () => {
    const rows = await app.federatedRecallCandidates({
      workspaceId: WS_A,
      terms: ["made", "up"],
      limit: 10,
      sensitivity: ["public", "internal", "confidential", "restricted"],
    });
    expect(rows.map((r) => r.sensitivity)).toEqual(["restricted"]);
  });

  it("matches in Spanish too", async () => {
    const rows = await app.federatedRecallCandidates({
      workspaceId: WS_A,
      terms: ["pedidos", "envían"],
      limit: 10,
      sensitivity: ["public"],
    });
    expect(rows.map((r) => r.statement)).toEqual([
      "Los pedidos de Larkspur se envían los viernes.",
    ]);
  });

  it("the query can use the 0065 index", async () => {
    const plan = await superSql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx.unsafe(`EXPLAIN SELECT local_id FROM mnemosyne.mnemo_federated_item
        WHERE NOT archived
          AND to_tsvector('mnemosyne.mnemo_fts', payload->>'statement')
              @@ plainto_tsquery('mnemosyne.mnemo_fts', 'larkspur')`);
    });
    expect(JSON.stringify(plan)).toContain("idx_federated_item_fts");
  });
});
