/**
 * TEST-2 — packages/consolidation has thorough unit coverage of the scheduler's
 * orchestration logic (scheduler-orchestration.test.ts etc.) via
 * InMemoryStorageAdapter, and packages/adapter-postgres has its own
 * consolidation-storage.integration.test.ts covering ConsolidationRepository's
 * atomic operations directly against real Postgres. Neither proves the two
 * actually compose: that runConsolidationTick, driving the REAL
 * DrizzleStorageAdapter (not the in-memory fake), produces the same observable
 * merge behavior end-to-end. That's this file's job.
 *
 * Connection-role setup mirrors
 * packages/adapter-postgres/src/__tests__/consolidation-storage.integration.test.ts
 * exactly (a superuser role runs migrations + seeds fixtures; a real non-super,
 * non-bypassrls app role — granted mnemo_app_role — is what the adapter under
 * test actually connects as, so FORCE RLS is genuinely exercised).
 *
 * This file previously had to work around a real bug here: mapRowToFact()
 * (packages/adapter-postgres/src/repositories/mappers.ts) dropped the
 * `embedding` column entirely, so gatherClusters() (which only groups facts
 * when `fact.embedding` is truthy) could never form a cluster against the
 * real adapter — mergedPairs/skippedPairs both came back 0. Now fixed at the
 * source (mappers.ts), so this file drives the real, undecorated `storage`
 * directly — if that mapping regresses, "merges a real gate-passing cluster"
 * below fails again.
 *
 * Requires Docker. Also requires Node >=22 locally — testcontainers'
 * http-wait-strategy import chain hits undici's `webidl.util.markAsUncloneable`,
 * which doesn't exist on Node 20 (this is why ci.yml's integration-test job
 * pins node-version: 22 while every other job stays on 20). Run with:
 *   mise exec node@22 -- pnpm --filter @mnemo-ai/consolidation test:integration
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import { migrate } from "@mnemo-ai/adapter-postgres/migrate";
import { runConsolidationTick, CONSOLIDATION_SYSTEM_ACTOR } from "../scheduler.js";
import type { SchedulerContext } from "../scheduler.js";
import { loadLinkedFactIds } from "../relation-memo.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_USER = "consolidation_scheduler_app";
const APP_PASS = "consolidation_scheduler_app_pass";
const WS = "cccccccc-dddd-4ddd-8ddd-dddddddddddd";

// A dedicated workspace for the deep-mode test (task 2.7) — mode:"deep"
// classifies EVERY gate-passing cluster in the tick, so reusing the shared
// `WS` above would also re-classify facts left active by earlier fast-mode
// tests (which share the same embedding), inflating skippedPairs/mergedPairs
// with a cluster this test doesn't own. A separate workspace keeps the deep
// mode assertions exact without depending on cross-test execution order.
const WS_DEEP_MODE = "dddddddd-eeee-4eee-9eee-eeeeeeeeeeee";

// Identical embedding across the cluster so cosine similarity == 1 >= the
// gate's 0.85 threshold — the actual vector values don't matter, only that
// every member shares one so gatherClusters() groups them together.
const SHARED_EMBEDDING = "[0.10,0.20,0.30,0.40]";

let container: StartedTestContainer;
let superSql: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof createDrizzleClient>;
let storage: DrizzleStorageAdapter;

/**
 * Seed a 3-fact gate-passing cluster directly via SQL. worth_alpha/beta are
 * set below the gate's WORTH_CEILING (0.5) and the scheduler's own
 * WORTH_CANDIDATE_CEILING (0.4): worth = alpha/(alpha+beta) = 1/5 = 0.2.
 * hit_count differs per row so gatherClusters' seed selection (highest
 * hitCount first) deterministically picks `${prefix}-a` as the survivor.
 */
async function seedGatePassingCluster(
  prefix: string,
  workspaceId: string = WS
): Promise<{
  survivorId: string;
  absorbedIds: string[];
}> {
  await superSql`
    INSERT INTO mnemosyne.mnemo_fact
      (id, workspace_id, scope, kind, subject, statement, sensitivity, status,
       hit_count, embedding, worth_alpha, worth_beta, worth_success, worth_failure)
    VALUES
      (${`${prefix}-a`}, ${workspaceId}, 'global', 'other', 'test-subject', ${`${prefix} statement a`},
       'internal', 'active', 3, ${SHARED_EMBEDDING}::halfvec, 1.0, 4.0, 0, 0),
      (${`${prefix}-b`}, ${workspaceId}, 'global', 'other', 'test-subject', ${`${prefix} statement b`},
       'internal', 'active', 2, ${SHARED_EMBEDDING}::halfvec, 1.0, 4.0, 0, 0),
      (${`${prefix}-c`}, ${workspaceId}, 'global', 'other', 'test-subject', ${`${prefix} statement c`},
       'internal', 'active', 1, ${SHARED_EMBEDDING}::halfvec, 1.0, 4.0, 0, 0)
  `;
  return { survivorId: `${prefix}-a`, absorbedIds: [`${prefix}-b`, `${prefix}-c`] };
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

  appClient = createDrizzleClient(appUrl);
  storage = new DrizzleStorageAdapter(appClient.db, appClient.pgClient);
}, 120_000);

afterAll(async () => {
  await appClient?.pgClient.end().catch(() => void 0);
  await superSql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("runConsolidationTick against the real DrizzleStorageAdapter (TEST-2)", () => {
  it("merges a real gate-passing cluster end-to-end (fast mode)", async () => {
    const { survivorId, absorbedIds } = await seedGatePassingCluster("sched-merge");

    const ctx: SchedulerContext = {
      storage,
      actor: CONSOLIDATION_SYSTEM_ACTOR,
      listWorkspaceIds: async () => [WS],
      getReplayValidator: async () => ({
        llm: {
          generate: vi.fn().mockResolvedValue({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          }),
        },
        recall: { search: vi.fn(async () => [{ id: survivorId, score: 1 }]) },
        // Real adapter method — no real recall_log rows exist yet, so this
        // legitimately returns [] and forces the synthetic-query path above.
        storage: {
          getRecentQueriesForFacts: (...args) => storage.getRecentQueriesForFacts(...args),
        },
      }),
    };

    const result = await runConsolidationTick(ctx, WS);

    expect(result.availability).toBe("ready");
    expect(result.errors).toBe(0);
    expect(result.mergedPairs).toBe(1);
    expect(result.skippedPairs).toBe(0);

    // Real Postgres state, not just the in-memory return value.
    const rows = await superSql<
      Array<{ id: string; status: string; valid_to: Date | null; merged_into_id: string | null }>
    >`
      SELECT id, status, valid_to, merged_into_id FROM mnemosyne.mnemo_fact
      WHERE id = ANY(${[survivorId, ...absorbedIds]})
      ORDER BY id
    `;
    const survivorRow = rows.find((r) => r.id === survivorId)!;
    expect(survivorRow.status).toBe("active");
    expect(survivorRow.valid_to).toBeNull();
    for (const absorbedId of absorbedIds) {
      const row = rows.find((r) => r.id === absorbedId)!;
      expect(row.status).toBe("merged");
      expect(row.valid_to).not.toBeNull();
      expect(row.merged_into_id).toBe(survivorId);
    }
  });

  it("rolls back a real cluster when replay fails (validation miss)", async () => {
    const { survivorId, absorbedIds } = await seedGatePassingCluster("sched-rollback");

    const ctx: SchedulerContext = {
      storage,
      actor: CONSOLIDATION_SYSTEM_ACTOR,
      listWorkspaceIds: async () => [WS],
      getReplayValidator: async () => ({
        llm: {
          generate: vi.fn().mockResolvedValue({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          }),
        },
        // Every synthetic query misses (fail/total = 1.0 >= 0.60) -> "flagged" -> rollback.
        recall: { search: vi.fn(async () => []) },
        storage: {
          getRecentQueriesForFacts: (...args) => storage.getRecentQueriesForFacts(...args),
        },
      }),
    };

    const result = await runConsolidationTick(ctx, WS);

    expect(result.errors).toBe(0);
    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBe(1);

    const rows = await superSql<Array<{ id: string; status: string; valid_to: Date | null }>>`
      SELECT id, status, valid_to FROM mnemosyne.mnemo_fact
      WHERE id = ANY(${[survivorId, ...absorbedIds]})
      ORDER BY id
    `;
    // A rolled-back merge restores every participant to its pre-merge state.
    for (const row of rows) {
      expect(row.status).toBe("active");
      expect(row.valid_to).toBeNull();
    }
  });

  it("deep mode: COMPATIBLE pairs write real not_conflict relations and are memoized on a later tick (task 2.7)", async () => {
    const { survivorId, absorbedIds } = await seedGatePassingCluster(
      "sched-deep-memo",
      WS_DEEP_MODE
    );

    // Both absorbed facts classify COMPATIBLE — nothing merges on tick 1, so
    // all three facts remain active and the SAME cluster can reform on tick 2,
    // which is what actually exercises the "later tick reuses memo" scenario
    // (a merged-away fact would never re-form a >=3 member cluster).
    const generate = vi.fn((opts: { messages: Array<{ content: string }> }) => {
      const content = opts.messages[0]?.content ?? "";
      if (content.includes("Classify")) {
        return Promise.resolve({ content: "COMPATIBLE", tokensUsed: { input: 10, output: 5 } });
      }
      return Promise.resolve({
        content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
        tokensUsed: { input: 0, output: 0 },
      });
    });
    const ctx: SchedulerContext = {
      storage,
      actor: CONSOLIDATION_SYSTEM_ACTOR,
      mode: "deep",
      listWorkspaceIds: async () => [WS_DEEP_MODE],
      getReplayValidator: async () => ({
        llm: { generate },
        recall: { search: vi.fn(async () => [{ id: survivorId, score: 1 }]) },
        storage: {
          getRecentQueriesForFacts: (...args) => storage.getRecentQueriesForFacts(...args),
        },
      }),
    };

    const firstResult = await runConsolidationTick(ctx, WS_DEEP_MODE);

    expect(firstResult.errors).toBe(0);
    expect(firstResult.mergedPairs).toBe(0);
    expect(firstResult.skippedPairs).toBe(1);

    // Real Postgres relation round-trip: loadLinkedFactIds (the same helper
    // the scheduler itself uses) sees the rows this tick just wrote via the
    // real DrizzleStorageAdapter — not a mock, an actual round-trip.
    const memoAfterFirstTick = await loadLinkedFactIds(storage, WS_DEEP_MODE, survivorId, [
      "conflicts_with",
      "not_conflict",
    ]);
    for (const absorbedId of absorbedIds) {
      expect(memoAfterFirstTick.has(absorbedId)).toBe(true);
    }

    const relationsAfterFirstTick = await storage.getRelations({
      workspaceId: WS_DEEP_MODE,
      sourceId: survivorId,
      verb: "not_conflict",
    });
    expect(relationsAfterFirstTick).toHaveLength(2);
    for (const relation of relationsAfterFirstTick) {
      expect(relation.evidence).toMatchObject({
        detectedBy: "semantic_classifier",
        consolidationMode: "deep",
      });
    }

    // All three facts are still active — nothing merged.
    const rowsAfterFirstTick = await superSql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM mnemosyne.mnemo_fact
      WHERE id = ANY(${[survivorId, ...absorbedIds]})
    `;
    for (const row of rowsAfterFirstTick) expect(row.status).toBe("active");

    const classifyCallsAfterFirstTick = generate.mock.calls.filter((c) =>
      (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes("Classify")
    ).length;
    expect(classifyCallsAfterFirstTick).toBe(2);

    // Simulated second tick against the SAME real storage: the cluster
    // reforms identically, but both pairs are now memoized via the real
    // relation rows just written — a memo hit, not a re-classification, and
    // no new relation write.
    const secondResult = await runConsolidationTick(ctx, WS_DEEP_MODE);

    expect(secondResult.errors).toBe(0);
    expect(secondResult.mergedPairs).toBe(0);
    expect(secondResult.skippedPairs).toBe(1);
    const classifyCallsAfterSecondTick = generate.mock.calls.filter((c) =>
      (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content.includes("Classify")
    ).length;
    expect(classifyCallsAfterSecondTick).toBe(classifyCallsAfterFirstTick); // zero NEW calls
    const relationsAfterSecondTick = await storage.getRelations({
      workspaceId: WS_DEEP_MODE,
      sourceId: survivorId,
      verb: "not_conflict",
    });
    expect(relationsAfterSecondTick).toHaveLength(2); // no new write
  });
});
