/**
 * Integration test: DrizzleStorageAdapter — fact LSH bands (Wave P).
 *
 * Requires DATABASE_URL environment variable pointing to a live Postgres DB
 * with all migrations applied. Skipped automatically when DATABASE_URL is absent
 * (matches CI Docker-free policy; runs via pnpm test:integration).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";
import { PgVectorAdapter } from "../../../adapter-vector/src/PgVectorAdapter.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
let rawSql: postgres.Sql;
let vector: PgVectorAdapter;

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

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
  rawSql = postgres(databaseUrl, { connection: { search_path: "mnemosyne,public" } });
  vector = new PgVectorAdapter({ connectionString: databaseUrl });
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await vector?.close();
  await rawSql?.end();
  await container?.stop();
});

describe("DrizzleStorageAdapter — fact LSH pointer candidates", () => {
  const WS = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

  it("enforces app_user and the workspace GUC when applying LSH bands", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "RLS fact",
      subject: "lsh",
      kind: "other",
    });
    await rawSql`CREATE OR REPLACE FUNCTION public.require_lsh_rls() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_user <> 'app_user' OR current_setting('mnemosyne.workspace_id',true) <> NEW.workspace_id THEN
          RAISE EXCEPTION 'LSH RLS context missing';
        END IF;
        RETURN NEW;
      END $$`;
    await rawSql`CREATE TRIGGER require_lsh_rls BEFORE INSERT ON mnemosyne.mnemo_fact_lsh
      FOR EACH ROW EXECUTE FUNCTION public.require_lsh_rls()`;
    try {
      await adapter.upsertFactLsh({
        workspaceId: WS,
        factId: fact.id,
        revision: fact.revisionCount,
        bands: [{ bandIdx: 0, bandHash: 123n }],
      });
      const rows =
        await rawSql`SELECT fact_id FROM mnemosyne.mnemo_fact_lsh WHERE fact_id=${fact.id}`;
      expect(rows).toHaveLength(1);
    } finally {
      await rawSql`DROP TRIGGER require_lsh_rls ON mnemosyne.mnemo_fact_lsh`;
    }
  });

  it("upsertFactLsh persists 6 bands and pointerCandidates retrieves by collision", async () => {
    const f = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "LSH integration test fact",
      subject: "lsh",
      kind: "other",
    });

    const bands = Array.from({ length: 6 }, (_, b) => ({ bandIdx: b, bandHash: BigInt(b + 100) }));
    await adapter.upsertFactLsh({
      workspaceId: WS,
      factId: f.id,
      revision: f.revisionCount,
      bands,
    });

    const cands = await adapter.pointerCandidates({
      workspaceId: WS,
      terms: [],
      bands,
      limit: 50,
    });
    expect(cands.map((c) => c.factId)).toContain(f.id);
  });

  it("pointerCandidates FTS arm matches by statement keyword", async () => {
    const f = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "billing cycle refreshed quarterly",
      subject: "billing",
      kind: "other",
    });

    const cands = await adapter.pointerCandidates({
      workspaceId: WS,
      terms: ["billing", "quarterly"],
      bands: [],
      limit: 50,
    });
    expect(cands.map((c) => c.factId)).toContain(f.id);
  });

  it("does not hydrate a closed fact from stale LSH bands", async () => {
    const f = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "stale LSH source",
      subject: "lsh",
      kind: "other",
    });
    const bands = [{ bandIdx: 0, bandHash: 999n }];
    await adapter.upsertFactLsh({
      workspaceId: WS,
      factId: f.id,
      revision: f.revisionCount,
      bands,
    });
    // Closed just after its own valid_from: a Node-clock "now" can precede a
    // valid_from Postgres stamped, and the tstzrange index refuses that.
    await adapter.updateFact(f.id, WS, {
      status: "forgotten",
      validTo: new Date(f.validFrom.getTime() + 1),
    });

    const candidates = await adapter.pointerCandidates({
      workspaceId: WS,
      terms: [],
      bands,
      limit: 50,
    });

    expect(candidates.map((candidate) => candidate.factId)).not.toContain(f.id);
  });

  it("does not return a closed fact from standalone FTS", async () => {
    const f = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "obsolete quarterly forecast",
      subject: "forecast",
      kind: "other",
    });
    // Closed just after its own valid_from: a Node-clock "now" can precede a
    // valid_from Postgres stamped, and the tstzrange index refuses that.
    await adapter.updateFact(f.id, WS, {
      status: "forgotten",
      validTo: new Date(f.validFrom.getTime() + 1),
    });

    const candidates = await adapter.ftsCandidates({
      workspaceId: WS,
      terms: ["obsolete", "quarterly"],
      limit: 50,
    });

    expect(candidates.map((candidate) => candidate.factId)).not.toContain(f.id);
  });

  it("orders standalone FTS by ts_rank before limit and returns the rank", async () => {
    const weak = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "ranking token",
      subject: "fts",
      kind: "other",
    });
    const strong = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "ranking ranking ranking token",
      subject: "fts",
      kind: "other",
    });

    const candidates = await adapter.ftsCandidates({
      workspaceId: WS,
      terms: ["ranking", "token"],
      limit: 1,
      includeLowWorth: true,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.factId).toBe(strong.id);
    expect(candidates[0]?.rank).toBeGreaterThan(0);
    expect(candidates[0]?.factId).not.toBe(weak.id);
  });

  it("globally ranks a stronger FTS match ahead of a full LSH arm", async () => {
    const bands = [{ bandIdx: 0, bandHash: 424242n }];
    for (let index = 0; index < 3; index++) {
      const lsh = await adapter.createFact({
        workspaceId: WS,
        scope: "global",
        statement: `union filler ${index}`,
        subject: "pointer",
        kind: "other",
      });
      await adapter.upsertFactLsh({
        workspaceId: WS,
        factId: lsh.id,
        revision: lsh.revisionCount,
        bands,
      });
    }
    const strong = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "globallyranked globallyranked globallyranked winner",
      subject: "pointer",
      kind: "other",
    });

    const candidates = await adapter.pointerCandidates({
      workspaceId: WS,
      terms: ["globallyranked", "winner"],
      bands,
      limit: 3,
      includeLowWorth: true,
    });

    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.factId).toBe(strong.id);
  });

  it("applies selective FTS predicates before limiting candidates", async () => {
    for (let index = 0; index < 55; index++) {
      await adapter.createFact({
        workspaceId: WS,
        scope: "global",
        statement: `selective common filler ${index}`,
        subject: "fts",
        kind: "other",
        metadata: { tags: ["other"] },
      });
    }
    const wanted = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "selective common wanted",
      subject: "fts",
      kind: "other",
      metadata: { tags: ["wanted"] },
    });

    const candidates = await adapter.ftsCandidates({
      workspaceId: WS,
      terms: ["selective", "common"],
      limit: 1,
      filter: { tags: ["wanted"] },
      includeLowWorth: true,
    });

    expect(candidates.map((candidate) => candidate.factId)).toEqual([wanted.id]);
  });

  it("applies the default worth predicate before the FTS candidate limit", async () => {
    const fillerIds: string[] = [];
    for (let index = 0; index < 55; index++) {
      const filler = await adapter.createFact({
        workspaceId: WS,
        scope: "global",
        statement: `worthgate common filler ${index}`,
        subject: "fts",
        kind: "other",
      });
      fillerIds.push(filler.id);
    }
    // Push fillers to a genuinely LOW (tested-and-failed) worth, not the
    // untested Beta(2,2) prior — the isUntested exemption (see the
    // "recalls an untested fresh fact" tests below) means a merely-untested
    // fact now correctly passes the gate, so this test needs fillers that
    // have actually accumulated evidence of being unhelpful to stay
    // meaningful as a "the worth predicate excludes low-worth facts" check.
    // Evidence as updateWorth records it: 18 failures on top of the (2,2)
    // prior. Untested is "never judged", read from the counters.
    await rawSql`
      UPDATE mnemo_fact SET worth_beta = 20, worth_failure = 18
      WHERE workspace_id = ${WS} AND id = ANY(${fillerIds})
    `;
    const eligible = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "worthgate common eligible",
      subject: "fts",
      kind: "other",
    });
    await adapter.updateWorth(eligible.id, WS, "fact", {
      success: 20,
      failure: 0,
      creditWeight: 1,
    });

    const candidates = await adapter.ftsCandidates({
      workspaceId: WS,
      terms: ["worthgate", "common"],
      limit: 1,
      includeLowWorth: false,
    });

    expect(candidates.map((candidate) => candidate.factId)).toEqual([eligible.id]);
  });

  it("recalls an untested fresh fact via FTS despite the default worth predicate (bootstrapping fix)", async () => {
    // RECALL-WORTH-1: candidateConditions()'s SQL-level `worth > 0.5` used to
    // run BEFORE passesWorthGate()'s JS-level isUntested exemption
    // (packages/core/src/cognitive/worth.ts, 2026-07-22) ever got a chance to
    // apply — a freshly remember()'d fact sits at worth=0.5 exactly (the
    // Beta(2,2) prior), failing the strict `> 0.5` SQL check, so it could
    // never be recalled for the first time via this path. This is the
    // regression test for the SQL-level fix.
    const fresh = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "freshworth untested candidate",
      subject: "fts",
      kind: "other",
    });

    const candidates = await adapter.ftsCandidates({
      workspaceId: WS,
      terms: ["freshworth", "untested"],
      limit: 10,
      includeLowWorth: false,
    });

    expect(candidates.map((candidate) => candidate.factId)).toContain(fresh.id);
  });

  it("recalls an untested fresh fact via pointerCandidates too (bootstrapping fix)", async () => {
    // Same fix, exercised through the actual code path recall-pointer.ts
    // uses (ctx.storage.pointerCandidates), not just the FTS arm directly.
    const fresh = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "freshpointer untested candidate",
      subject: "fts",
      kind: "other",
    });

    const candidates = await adapter.pointerCandidates({
      workspaceId: WS,
      terms: ["freshpointer", "untested"],
      bands: [],
      limit: 10,
      includeLowWorth: false,
    });

    expect(candidates.map((candidate) => candidate.factId)).toContain(fresh.id);
  });

  it("recalls an unjudged fact whose Beta prior was decayed below (2,2)", async () => {
    // Production 2026-11-19: decay relaxes worth_alpha/worth_beta toward 1, so
    // an unjudged fact sits at e.g. (1.9988, 1.9988) with worth 0.5. The old
    // `alpha = 2 AND beta = 2` exemption no longer matched and the SQL worth
    // predicate hid it from FTS and pointer candidates.
    const decayed = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "decayedprior unjudged candidate",
      subject: "fts",
      kind: "other",
    });
    const judged = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "decayedprior judged candidate",
      subject: "fts",
      kind: "other",
    });
    await rawSql`
      UPDATE mnemo_fact SET worth_alpha = 1.9988, worth_beta = 1.9988
      WHERE workspace_id = ${WS} AND id = ${decayed.id}
    `;
    await adapter.updateWorth(judged.id, WS, "fact", { success: 0, failure: 3, creditWeight: 1 });

    const fts = await adapter.ftsCandidates({
      workspaceId: WS,
      terms: ["decayedprior", "candidate"],
      limit: 10,
      includeLowWorth: false,
    });
    const pointer = await adapter.pointerCandidates({
      workspaceId: WS,
      terms: ["decayedprior", "candidate"],
      bands: [],
      limit: 10,
      includeLowWorth: false,
    });

    for (const ids of [fts.map((c) => c.factId), pointer.map((c) => c.factId)]) {
      expect(ids).toContain(decayed.id);
      expect(ids).not.toContain(judged.id);
    }
    const pointerRow = pointer.find((c) => c.factId === decayed.id);
    expect(pointerRow?.worthSuccess).toBe(0);
    expect(pointerRow?.worthFailure).toBe(0);
  });

  it("atomically unions concurrent topic-key metadata and increments every revision", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "base",
      subject: "topic",
      kind: "other",
      topicKey: "concurrent-topic",
      metadata: { owner: "platform", tags: ["base"] },
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        adapter.mergeFactByTopicKey({
          workspaceId: WS,
          topicKey: "concurrent-topic",
          statement: `revision ${index}`,
          metadata: { [`source_${index}`]: true },
          tags: [`tag-${index}`],
        })
      )
    );

    expect(results).toHaveLength(12);
    expect(results.every((result) => result !== null)).toBe(true);
    expect(
      results.map((result) => result?.revisionCount).sort((a, b) => (a ?? 0) - (b ?? 0))
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 2));

    const active = await adapter.queryFacts({
      workspaceId: WS,
      topicKey: "concurrent-topic",
      status: "active",
    });
    expect(active.total).toBe(1);
    const merged = active.items[0]!;
    expect(merged.revisionCount).toBe(13);
    expect(merged.metadata.owner).toBe("platform");
    expect(merged.metadata.tags).toEqual(
      expect.arrayContaining(["base", ...Array.from({ length: 12 }, (_, index) => `tag-${index}`)])
    );
    for (let index = 0; index < 12; index++) {
      expect(merged.metadata[`source_${index}`]).toBe(true);
    }
    const original = await adapter.getFact(fact.id, WS);
    expect(original?.status).toBe("forgotten");
    expect(original?.validTo).not.toBeNull();
  });

  it("keeps concurrent topic statement, embedding model, stale state, and LSH on one winning revision", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "revision base",
      subject: "topic",
      kind: "other",
      topicKey: "revision-consistency",
    });
    const writes = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const merged = await adapter.mergeFactByTopicKey({
          workspaceId: WS,
          topicKey: "revision-consistency",
          statement: `winning statement ${index}`,
        });
        if (!merged) throw new Error("topic merge unexpectedly missed");
        return {
          id: merged.id,
          revision: merged.revisionCount,
          statement: `winning statement ${index}`,
          model: `model-${index}`,
          vector: new Float32Array(1536).fill((index + 1) / 10),
          bands: [{ bandIdx: 0, bandHash: BigInt(9000 + index) }],
        };
      })
    );
    const winner = [...writes].sort((a, b) => b.revision - a.revision)[0]!;

    for (const write of [...writes].sort((a, b) => b.revision - a.revision)) {
      await vector.upsert(winner.id, write.vector, {
        model: write.model,
        revision: write.revision,
        workspaceId: WS,
      });
      await adapter.upsertFactLsh({
        workspaceId: WS,
        factId: winner.id,
        revision: write.revision,
        bands: write.bands,
      });
    }

    const [row] = await rawSql<
      {
        statement: string;
        revision_count: number;
        embedding: string;
        embedding_model: string;
        embedding_stale: boolean;
        bands: string[];
      }[]
    >`
      SELECT f.statement, f.revision_count, f.embedding::text, f.embedding_model, f.embedding_stale,
             array_agg(l.band_hash::text ORDER BY l.band_idx) AS bands
      FROM mnemo_fact f
      LEFT JOIN mnemo_fact_lsh l ON l.workspace_id = f.workspace_id AND l.fact_id = f.id
      WHERE f.workspace_id = ${WS} AND f.id = ${winner.id}
      GROUP BY f.id
    `;
    expect(row).toMatchObject({
      statement: winner.statement,
      revision_count: winner.revision,
      embedding_model: winner.model,
      embedding_stale: false,
      bands: [String(winner.bands[0]!.bandHash)],
    });
    const firstEmbeddingValue = Number(row?.embedding.match(/^\[([^,]+)/)?.[1]);
    expect(firstEmbeddingValue).toBeCloseTo(winner.vector[0]!, 3);
  });

  it("rejects an old LSH replacement that waits behind an uncommitted fact revision", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "before locked revision",
      subject: "topic",
      kind: "other",
      topicKey: "locked-lsh-revision",
    });
    await adapter.upsertFactLsh({
      workspaceId: WS,
      factId: fact.id,
      revision: fact.revisionCount,
      bands: [{ bandIdx: 0, bandHash: 7000n }],
    });

    let revisionCommitted!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      revisionCommitted = resolve;
    });
    let revisionLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      revisionLocked = resolve;
    });
    const merge = rawSql.begin(async (tx) => {
      await tx`SELECT set_config('mnemosyne.workspace_id', ${WS}, true)`;
      await tx`
        UPDATE mnemo_fact
        SET statement = 'after locked revision', revision_count = revision_count + 1,
            embedding = NULL, embedding_model = NULL, embedding_stale = true
        WHERE workspace_id = ${WS} AND id = ${fact.id}
      `;
      await tx`DELETE FROM mnemo_fact_lsh WHERE workspace_id = ${WS} AND fact_id = ${fact.id}`;
      revisionLocked();
      await mayCommit;
    });
    await locked;

    const staleWrite = adapter.upsertFactLsh({
      workspaceId: WS,
      factId: fact.id,
      revision: fact.revisionCount,
      bands: [{ bandIdx: 0, bandHash: 7001n }],
    });
    revisionCommitted();
    await Promise.all([merge, staleWrite]);

    const bands = await rawSql<{ band_hash: string }[]>`
      SELECT band_hash::text
      FROM mnemo_fact_lsh
      WHERE workspace_id = ${WS} AND fact_id = ${fact.id}
    `;
    expect(bands).toEqual([]);
  });
});
