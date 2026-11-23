/**
 * openspec change `write-time-conflict-surfacing` — Phase 5, task 5.1.
 *
 * Real-Postgres proof for the write-time `conflicts_with` relation created by
 * `resolveFactContradictions` (`packages/core/src/cognitive/remember.ts`) for
 * `reject`/`review` verdicts. Covers what the in-memory storage adapter used by
 * `remember-conflict-resolve.test.ts` (PR 1) cannot:
 *
 *   1. The exact `ctx.storage.createRelation` call shape (verb `conflicts_with`,
 *      `evidence.detectedBy: "section33_resolver"`) round-trips through the real
 *      `mnemo_relation` table and its jsonb `evidence` column.
 *   2. The relation write is genuinely RLS-scoped: `GraphRepository.createRelation`
 *      opens its OWN transaction and sets `mnemosyne.workspace_id` via
 *      `mnemo_set_workspace(...)` (design.md D-notes), independent of any caller
 *      `withMnemoTx` — a cross-workspace read of the row MUST be denied by RLS even
 *      when queried directly by id (no `WHERE workspace_id = ...` in the query).
 *   3. The row is discoverable by the exact filter `GET /conflicts`
 *      (`packages/server/src/routes/conflicts.ts`) applies — `verb ===
 *      "conflicts_with"` (server-side) `&& validTo === null` (client-side,
 *      MnemoRelation.validTo is `Date | null`, never `undefined`) — read
 *      through `deps.storage.getRelations`, the v3 path PR11
 *      (flatten-legacy-dual-core) ported this route onto, replacing the
 *      original `deps.core.listRelations` read this test proved against.
 *      PR11 originally ported this filter to `=== undefined`, which is
 *      never true for a relation and made GET /conflicts always return an
 *      empty list; this test's own assertion was mistakenly updated to
 *      match that regression instead of catching it. Both are fixed here.
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/adapter-postgres test:integration
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
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
const APP_USER = "section33_app";
const APP_PASS = "section33_app_pass";

const WS_A = "aaaaaaaa-1111-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-2222-4bbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof createDrizzleClient>;

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

  // A genuinely non-superuser, non-BYPASSRLS role — mirrors production's
  // `app_user` (SET LOCAL ROLE target for withMnemoTx). Superuser connections
  // (used by the sibling relation-hyperedge-actor-id.integration.test.ts)
  // bypass FORCE ROW LEVEL SECURITY entirely, so they cannot prove RLS.
  superSql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  await superSql.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
  `);

  appClient = createDrizzleClient(appUrl);
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

/** createFact leaves the vector to the outbox worker; tests set it directly. */
async function setEmbedding(factId: string, vector: number[]): Promise<void> {
  await superSql.unsafe(`UPDATE mnemosyne.mnemo_fact SET embedding = $1::halfvec WHERE id = $2`, [
    `[${vector.join(",")}]`,
    factId,
  ]);
}

describe("section33_resolver conflicts_with relation — real Postgres proof", () => {
  it("persists evidence.detectedBy === 'section33_resolver' and round-trips via v3 getRelations", async () => {
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);

    const created = await appAdapter.createRelation({
      workspaceId: WS_A,
      sourceId: "new_fact_1",
      sourceType: "fact",
      targetId: "existing_fact_1",
      targetType: "fact",
      verb: "conflicts_with",
      evidence: {
        detectedBy: "section33_resolver",
        action: "review",
        verdictReason: "ambiguous trust/recency comparison",
      },
    });

    expect((created.evidence as Record<string, unknown> | null)?.["detectedBy"]).toBe(
      "section33_resolver"
    );
    expect(created.verb).toBe("conflicts_with");

    const [fetched] = await appAdapter.getRelations({
      workspaceId: WS_A,
      sourceId: "new_fact_1",
      targetId: "existing_fact_1",
    });
    expect((fetched?.evidence as Record<string, unknown> | null)?.["detectedBy"]).toBe(
      "section33_resolver"
    );
    expect((fetched?.evidence as Record<string, unknown> | null)?.["action"]).toBe("review");
  });

  it("is discoverable via the exact GET /conflicts filter (verb===conflicts_with && validTo===null) through deps.storage.getRelations", async () => {
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);

    const created = await appAdapter.createRelation({
      workspaceId: WS_A,
      sourceId: "new_fact_2",
      sourceType: "fact",
      targetId: "existing_fact_2",
      targetType: "fact",
      verb: "conflicts_with",
      evidence: { detectedBy: "section33_resolver", action: "reject" },
    });

    // flatten-legacy-dual-core PR11 ported routes/conflicts.ts's
    // listConflictsRoute handler off `deps.core.listRelations` onto the v3
    // `deps.storage.getRelations` port method (server-side `verb` filter,
    // `validTo` still checked client-side — routes/conflicts.ts:141-145).
    const allRelations = await appAdapter.getRelations({
      workspaceId: WS_A,
      verb: "conflicts_with",
    });
    const conflictRelations = allRelations.filter((r) => r.validTo === null);

    const match = conflictRelations.find((r) => r.id === created.id);
    expect(match).toBeDefined();
    expect(match?.sourceId).toBe("new_fact_2");
    expect(match?.targetId).toBe("existing_fact_2");
    expect((match?.evidence as Record<string, unknown> | null)?.["detectedBy"]).toBe(
      "section33_resolver"
    );
  });

  it("is RLS-scoped: a cross-workspace direct-by-id read returns zero rows, same-workspace returns the row", async () => {
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);

    const created = await appAdapter.createRelation({
      workspaceId: WS_A,
      sourceId: "new_fact_3",
      sourceType: "fact",
      targetId: "existing_fact_3",
      targetType: "fact",
      verb: "conflicts_with",
      evidence: { detectedBy: "section33_resolver", action: "review" },
    });

    const appSql = postgres(
      `postgres://${APP_USER}:${APP_PASS}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`,
      { max: 1, onnotice: () => void 0 }
    );

    try {
      // Wrong workspace GUC, no workspace_id filter in the query at all —
      // FORCE ROW LEVEL SECURITY must still deny visibility of the row by id.
      const wrongWorkspaceRows = await appSql.begin(async (tx) => {
        await tx.unsafe(`SELECT mnemosyne.mnemo_set_workspace($1::uuid)`, [WS_B]);
        return tx.unsafe(`SELECT id FROM mnemosyne.mnemo_relation WHERE id = $1`, [created.id]);
      });
      expect(wrongWorkspaceRows).toHaveLength(0);

      // Correct workspace GUC — the same by-id query now succeeds.
      const correctWorkspaceRows = await appSql.begin(async (tx) => {
        await tx.unsafe(`SELECT mnemosyne.mnemo_set_workspace($1::uuid)`, [WS_A]);
        return tx.unsafe(`SELECT id FROM mnemosyne.mnemo_relation WHERE id = $1`, [created.id]);
      });
      expect(correctWorkspaceRows).toHaveLength(1);
    } finally {
      await appSql.end();
    }
  });
});

describe("PRIM-5 — the default subject alone never makes a vectorless fact a candidate (real Postgres)", () => {
  it("skips NULL-vector and wrong-width `general` rows, keeps a specific-subject one, stays RLS-scoped", async () => {
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
    const nonce = crypto.randomUUID();

    // A restored fact has no embedding (PRIM-4); this is that row.
    const nullVector = await appAdapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      kind: "other",
      subject: "general",
      statement: `halcyonmint deploys run on Fridays ${nonce}`,
    });
    // A vector of another width is "no usable vector" too (P117/P118).
    const wrongWidth = await appAdapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      kind: "other",
      subject: "general",
      statement: `plumvault backups rotate weekly ${nonce}`,
    });
    await setEmbedding(wrongWidth.id, new Array(1024).fill(0.03));
    // Positive control: a SPECIFIC subject still produces the candidate.
    const broker = await appAdapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      kind: "other",
      subject: `broker-${nonce}`,
      statement: "el broker de mensajes es RabbitMQ",
    });

    const query = new Array(1536).fill(0.02);
    const withVector = await appAdapter.findContradictingFacts(WS_A, {
      subject: "general",
      statement: "The quibblemoor service listens on port 8080",
      embedding: query,
      limit: 50,
    });
    const withoutVector = await appAdapter.findContradictingFacts(WS_A, {
      subject: "general",
      statement: "The quibblemoor service listens on port 8080",
      limit: 50,
    });
    for (const found of [withVector, withoutVector]) {
      const ids = found.map((f) => f.id);
      expect(ids).not.toContain(nullVector.id);
      expect(ids).not.toContain(wrongWidth.id);
    }

    const specific = await appAdapter.findContradictingFacts(WS_A, {
      subject: `broker-${nonce}`,
      statement: "el broker de mensajes es Kafka",
      embedding: query,
      limit: 50,
    });
    expect(specific.map((f) => f.id)).toContain(broker.id);

    const otherWorkspace = await appAdapter.findContradictingFacts(WS_B, {
      subject: `broker-${nonce}`,
      statement: "el broker de mensajes es Kafka",
      embedding: query,
      limit: 50,
    });
    expect(otherWorkspace).toEqual([]);
  });
});

describe("a zero vector is not a perfect match (real Postgres)", () => {
  it("never returns a fact whose cosine is NaN, and never ranks it first", async () => {
    // pgvector's cosine distance against an all-zero vector is NaN, and
    // Postgres orders NaN ABOVE every number and treats `NaN >= 0.55` as true.
    // One zero-vector row therefore came back as the top candidate for every
    // write, pushing real candidates out of the limit.
    const appAdapter = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
    const nonce = crypto.randomUUID();
    const unit = new Array(1024).fill(0);
    unit[0] = 1;

    const zero = await appAdapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      kind: "other",
      subject: `zero-${nonce}`,
      statement: `zero vector fact ${nonce}`,
    });
    await setEmbedding(zero.id, new Array(1024).fill(0));
    const close = await appAdapter.createFact({
      workspaceId: WS_A,
      scope: "global",
      kind: "other",
      subject: `close-${nonce}`,
      statement: `close vector fact ${nonce}`,
    });
    await setEmbedding(close.id, unit);

    const found = await appAdapter.findContradictingFacts(WS_A, {
      subject: `query-${nonce}`,
      statement: "an unrelated incoming statement",
      embedding: unit,
      limit: 1,
    });
    expect(found.map((f) => f.id)).toEqual([close.id]);

    const all = await appAdapter.findContradictingFacts(WS_A, {
      subject: `query-${nonce}`,
      statement: "an unrelated incoming statement",
      embedding: unit,
      limit: 50,
    });
    expect(all.map((f) => f.id)).not.toContain(zero.id);
  });
});
