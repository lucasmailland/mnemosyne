/**
 * Integration test: migration `0029_decision_fts_english.sql`
 * (make-primitives-recallable, design.md D3, tasks.md 3.4).
 *
 * Proves the migrated `mnemo_decision.text_lemmatized` generated column stems
 * English — something the old 'simple' configuration could never do — and that
 * its `ts_rank` scores are comparable to `mnemo_fact.text_lemmatized` (both
 * built with the same configuration).
 *
 * 0029 wrote that configuration as the literal 'english'. Migration 0035 then
 * re-expressed all ten text_lemmatized columns against the named configuration
 * `mnemosyne.mnemo_fts` (`COPY = english`, plus unaccent), so the stemmer is
 * unchanged but the literal is gone. The assertions below check the stemming
 * behaviourally and the wiring by name.
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note and
 * decision-topic-key.integration.test.ts for the same testcontainers pattern
 * this file mirrors. Raw SQL inserts bypass RLS by using the testcontainer's
 * initdb superuser connection (same approach decision-topic-key.integration
 * .test.ts's raw-SQL assertions already rely on).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const WS = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

let container: StartedTestContainer;
let sql: postgres.Sql;

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

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  sql = postgres(databaseUrl, { connection: { search_path: "mnemosyne,public" } });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await container?.stop();
});

describe("migrations 0029+0035: mnemo_decision.text_lemmatized stems English via mnemosyne.mnemo_fts", () => {
  it("stems 'strategy' so a 'strategies' query matches a body that only says 'strategy' — 'simple' could never do this", async () => {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO mnemosyne.mnemo_decision
        (id, workspace_id, kind, title, body, normalized_hash)
      VALUES
        (${id}, ${WS}, 'decision', 'Caching', 'Our caching strategy uses Redis',
         ${"hash-" + id})
    `;

    const matched = await sql<Array<{ id: string }>>`
      SELECT id FROM mnemosyne.mnemo_decision
      WHERE id = ${id}
        AND text_lemmatized @@ plainto_tsquery('english', 'caching strategies')
    `;
    expect(matched).toHaveLength(1);
    expect(matched[0]!.id).toBe(id);

    // Prove the match came from stemming, not from an unrelated predicate:
    // 'simple' does no stemming, so plainto_tsquery('simple', 'strategies')
    // cannot match the stored 'strategi' lexeme. This is the behavioural half
    // of the claim in this test's name, and it holds no matter what the
    // configuration is called.
    const simpleQuery = await sql<Array<{ id: string }>>`
      SELECT id FROM mnemosyne.mnemo_decision
      WHERE id = ${id}
        AND text_lemmatized @@ plainto_tsquery('simple', 'strategies')
    `;
    expect(simpleQuery).toHaveLength(0);

    // And the structural half. Migration 0035 re-expressed this column against
    // the NAMED configuration mnemosyne.mnemo_fts (`COPY = english` plus an
    // unaccent step), so the literal 'english' this assertion used to look for
    // is no longer in the expression — the stemmer is reached through the name
    // now. Asserting on the name is also what migration 0035 wanted: it exists
    // precisely so both the indexing and the querying side have one thing to
    // agree on instead of each spelling a config as a string literal.
    const configRows = await sql<Array<{ def: string }>>`
      SELECT pg_get_expr(a.adbin, a.adrelid) AS def
      FROM pg_attrdef a
      JOIN pg_attribute att ON att.attrelid = a.adrelid AND att.attnum = a.adnum
      WHERE a.adrelid = 'mnemosyne.mnemo_decision'::regclass
        AND att.attname = 'text_lemmatized'
    `;
    expect(configRows[0]!.def).toContain("mnemo_fts");
    expect(configRows[0]!.def).not.toContain("'simple'");
  });

  it("rank is comparable to a fact hit of equivalent lexical strength (Req 3 scenario)", async () => {
    const decisionId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    // Concatenated content is byte-identical across both tables: decision's
    // generated column is to_tsvector('english', title || ' ' || body); the
    // fact's statement carries the same combined text as a single field.
    await sql`
      INSERT INTO mnemosyne.mnemo_decision
        (id, workspace_id, kind, title, body, normalized_hash)
      VALUES
        (${decisionId}, ${WS}, 'decision', 'Caching', 'strategy for scaling reads',
         ${"hash-" + decisionId})
    `;
    await sql`
      INSERT INTO mnemosyne.mnemo_fact
        (id, workspace_id, scope, kind, subject, statement)
      VALUES
        (${factId}, ${WS}, 'global', 'other', 'probe-subject',
         'Caching strategy for scaling reads')
    `;

    const rows = await sql<Array<{ decision_rank: number; fact_rank: number }>>`
      SELECT
        ts_rank(
          (SELECT text_lemmatized FROM mnemosyne.mnemo_decision WHERE id = ${decisionId}),
          plainto_tsquery('english', 'caching strategies')
        )::float8 AS decision_rank,
        ts_rank(
          (SELECT text_lemmatized FROM mnemosyne.mnemo_fact WHERE id = ${factId}),
          plainto_tsquery('english', 'caching strategies')
        )::float8 AS fact_rank
    `;

    const { decision_rank: decisionRank, fact_rank: factRank } = rows[0]!;
    expect(decisionRank).toBeGreaterThan(0);
    expect(factRank).toBeGreaterThan(0);
    // Byte-identical concatenated text under the same 'english' config
    // produces byte-identical tsvectors, hence identical ts_rank.
    expect(decisionRank).toBeCloseTo(factRank, 10);
  });
});
