/**
 * WP-3 — the recall-side SQL, against real Postgres, as a NOSUPERUSER
 * NOBYPASSRLS application role (production runs as mnemo_app under FORCE RLS):
 *
 *   - RECALL-11: recordRecall counts the hit in the same transaction as its log
 *     row (hit_count stayed 0 against 12,836 log rows), atomically.
 *   - AGENTSIM-4: getUnresolvedConflictIds — either end of an open
 *     conflicts_with, never a resolved one, never another workspace's.
 *   - RECALL-7: the non-fact lexical arm falls back to two-of-N content terms
 *     when strict matching finds nothing, like the fact arm; strict stays first.
 *   - Per-arm evidence: `similarity` and `lexicalRank` kept apart.
 *   - RECALL-6: filter.scopeOwner in the FTS arm; candidates carry scopeOwner,
 *     topicKey and subject.
 *
 * Requires Docker + Node 22 (testcontainers).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";

import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "relevance_app";
const APP_PASS = "relevance_app_pass";
const WS = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
const OTHER_WS = "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3";
const DIM = 1536;

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let superClient: ReturnType<typeof createDrizzleClient>;
let appClient: ReturnType<typeof createDrizzleClient>;
let app: DrizzleStorageAdapter;

function unit(index: number): number[] {
  const vec = new Array(DIM).fill(0);
  vec[index] = 1;
  return vec;
}

async function fact(workspaceId: string, statement: string, extra: Record<string, unknown> = {}) {
  return app.createFact({
    workspaceId,
    actorId: "key:relevance",
    scope: "global",
    statement,
    subject: "billing-ownership",
    kind: "other",
    sensitivity: "internal",
    ...extra,
  } as never);
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;
  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl: superUrl, log: () => void 0 });
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);
  superClient = createDrizzleClient(superUrl);
  appClient = createDrizzleClient(appUrl);
  app = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("RECALL-11 — recordRecall counts hits", () => {
  it("hit_count equals the committed log rows under concurrency, and stays in its workspace", async () => {
    const mine = await fact(WS, "Diego approves invoice schema changes.");
    const theirs = await fact(OTHER_WS, "Diego approves invoice schema changes.");

    await Promise.all(
      Array.from({ length: 12 }, (_, rank) =>
        app.recordRecall({
          workspaceId: WS,
          factId: mine.id,
          queryText: "who approves invoice schema changes",
          hitRank: rank % 3,
          tdCredit: 1,
          activationScore: 0.7,
        })
      )
    );

    const [row] = await superSql<Array<{ hit_count: number; logs: number }>>`
      SELECT f.hit_count,
             (SELECT count(*)::int FROM mnemosyne.mnemo_recall_log l
               WHERE l.workspace_id = ${WS} AND l.fact_id = ${mine.id}) AS logs
        FROM mnemosyne.mnemo_fact f WHERE f.id = ${mine.id}
    `;
    expect(row).toEqual({ hit_count: 12, logs: 12 });
    const [other] = await superSql<Array<{ hit_count: number }>>`
      SELECT hit_count FROM mnemosyne.mnemo_fact WHERE id = ${theirs.id}
    `;
    expect(other!.hit_count).toBe(0);
  });
});

describe("AGENTSIM-4 — getUnresolvedConflictIds", () => {
  it("reports either end of an open conflicts_with, not resolved ones or other verbs", async () => {
    const newer = await fact(WS, "Marta approves invoice schema changes.");
    const older = await fact(WS, "Diego took over the billing domain from Marta.");
    const judged = await fact(WS, "Invoices are approved by finance.");
    const judgedOther = await fact(WS, "Finance owns invoice approval.");
    const related = await fact(WS, "The billing runbook lives in Notion.");
    const relatedOther = await fact(WS, "Runbooks live in Notion.");
    const foreign = await fact(OTHER_WS, "A conflict in another workspace.");
    const foreignOther = await fact(OTHER_WS, "Its counterpart.");
    const relate = (sourceId: string, targetId: string, verb: string, workspaceId = WS) =>
      app.createRelation({
        workspaceId,
        sourceId,
        sourceType: "fact",
        targetId,
        targetType: "fact",
        verb,
      } as never);

    await relate(newer.id, older.id, "conflicts_with");
    const resolved = await relate(judged.id, judgedOther.id, "conflicts_with");
    await app.closeRelation(resolved.id, WS);
    await relate(related.id, relatedOther.id, "related");
    await relate(foreign.id, foreignOther.id, "conflicts_with", OTHER_WS);

    const ids = [newer, older, judged, judgedOther, related, relatedOther, foreign].map(
      (f) => f.id
    );
    const contested = await app.getUnresolvedConflictIds(WS, ids);

    expect(contested.sort()).toEqual([newer.id, older.id].sort());
    expect(await app.getUnresolvedConflictIds(WS, [])).toEqual([]);
  });
});

describe("RECALL-7 — relaxed lexical fallback for decisions", () => {
  it("a natural-language question finds the decision strict matching misses", async () => {
    const decision = await app.createDecision({
      workspaceId: WS,
      kind: "policy",
      title: "Atlas retries failed card charges at most 3 times",
      body: "Exponential backoff: 1 min, 10 min, 1 h.",
    });
    const question = "How many times do we retry a failed card charge in Atlas?".split(/\s+/);

    const strict = await app.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: question,
    });
    expect(strict.map((c) => c.id)).not.toContain(decision.id);

    const relaxed = await app.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: question,
      relaxedOnEmpty: true,
    });
    const hit = relaxed.find((c) => c.id === decision.id);
    expect(hit).toBeDefined();
    expect(hit!.lexicalRank).toBeGreaterThan(0);
    expect(hit!.similarity).toBeUndefined();
  });

  it("Spanish works too, and strict matches still win when there are any", async () => {
    const es = await app.createDecision({
      workspaceId: WS,
      kind: "policy",
      title: "Delta guarda los recibos de sueldo en S3 con cifrado SSE-KMS",
      body: "URLs prefirmadas de 15 minutos.",
    });
    const relaxed = await app.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: "¿Dónde guardamos los recibos de sueldo de Delta?".split(/\s+/),
      relaxedOnEmpty: true,
    });
    expect(relaxed.map((c) => c.id)).toContain(es.id);

    const strict = await app.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: ["recibos", "sueldo"],
      relaxedOnEmpty: true,
    });
    expect(strict.map((c) => c.id)).toEqual([es.id]);
  });

  it("keeps the semantic and lexical evidence of one decision apart", async () => {
    const both = await app.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Cosign signatures gate admission",
      body: "Every container image is signed with cosign.",
    });
    await app.updateEmbeddingVector("decision", both.id, WS, unit(3), "test-model");

    const [hit] = (
      await app.recallableCandidates!({
        workspaceId: WS,
        kinds: ["decision"],
        limit: 10,
        embedding: unit(3),
        minSimilarity: 0.9,
        terms: ["cosign"],
      })
    ).filter((c) => c.id === both.id);

    expect(hit!.similarity).toBeCloseTo(1, 3);
    expect(hit!.lexicalRank).toBeGreaterThan(0);
    expect(hit!.lexicalRank).toBeLessThan(1);
    expect(hit!.score).toBe(Math.max(hit!.similarity!, hit!.lexicalRank!));
  });
});

describe("RECALL-6 — ownership in the FTS arm, identity on candidates", () => {
  it("filter.scopeOwner keeps only the owner's rows; legacy unlabelled rows never match", async () => {
    const mine = await fact(WS, "My laptop is a MacBook Pro with 48 GB of RAM.", {
      scopeOwner: "user:u-relevance",
      topicKey: "me/laptop",
      subject: "laptop",
    });
    await fact(WS, "The office laptop pool is Lenovo ThinkPad.");
    await superSql`
      UPDATE mnemosyne.mnemo_fact SET scope_owner = NULL
       WHERE workspace_id = ${WS} AND statement = 'The office laptop pool is Lenovo ThinkPad.'
    `;

    const rows = await app.ftsCandidates!({
      workspaceId: WS,
      terms: ["laptop"],
      limit: 10,
      filter: { scopeOwner: "user:u-relevance" },
    });

    expect(rows.map((r) => r.factId)).toEqual([mine.id]);
    expect(rows[0]).toMatchObject({
      scopeOwner: "user:u-relevance",
      topicKey: "me/laptop",
      subject: "laptop",
    });
  });
});
