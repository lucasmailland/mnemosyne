/**
 * flatten-legacy-dual-core Slice 3c pt.1 (PR10) — ReviewQueueRepository
 * (active-learning review queue, `mnemosyne.mnemo_review_queue`). Backs
 * `routes/review.ts`'s new `deps.storage.{list,countUnresolved,resolve,
 * enqueue}ActiveLearningReview` calls. Real Postgres, not mocked — the
 * highest-risk behavior (idempotent dedup, atomic forgotten-cascade) can
 * only be proven against a real transaction.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "45454545-4545-4545-8545-454545454545";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop().catch(() => void 0);
});

let factCounter = 0;

async function makeFact() {
  factCounter += 1;
  return adapter.createFact({
    workspaceId: WS,
    scope: "global",
    kind: "other",
    subject: `review-queue-test-${factCounter}`,
    statement: `a fact under active-learning review #${factCounter}`,
    confidence: 0.4,
  });
}

describe("ReviewQueueRepository (active-learning review queue)", () => {
  it("enqueue is idempotent per (workspace, factId): a second call dedups to the same open row", async () => {
    const fact = await makeFact();

    const first = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: fact.id,
      reason: "low_confidence",
    });
    const second = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: fact.id,
      reason: "low_confidence",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("enqueue rejects when both or neither of factId/decisionId are supplied", async () => {
    await expect(
      adapter.enqueueActiveLearningReview({ workspaceId: WS, reason: "manual" })
    ).rejects.toThrow(/exactly one/);
    await expect(
      adapter.enqueueActiveLearningReview({
        workspaceId: WS,
        factId: "f1",
        decisionId: "d1",
        reason: "manual",
      })
    ).rejects.toThrow(/exactly one/);
  });

  it("list returns unresolved-only by default, newest first, filterable by reason", async () => {
    const factA = await makeFact();
    const factB = await makeFact();
    const { id: rowA } = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: factA.id,
      reason: "low_confidence",
    });
    await new Promise((r) => setTimeout(r, 10));
    const { id: rowB } = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: factB.id,
      reason: "contradiction",
    });

    const all = await adapter.listActiveLearningReview({ workspaceId: WS });
    const ids = all.map((r) => r.id);
    expect(ids.indexOf(rowB)).toBeLessThan(ids.indexOf(rowA)); // newest first

    const filtered = await adapter.listActiveLearningReview({
      workspaceId: WS,
      reason: "contradiction",
    });
    expect(filtered.every((r) => r.reason === "contradiction")).toBe(true);
    expect(filtered.some((r) => r.id === rowB)).toBe(true);
  });

  it("count reflects only unresolved rows for the workspace", async () => {
    const before = await adapter.countUnresolvedActiveLearningReview(WS);
    const fact = await makeFact();
    await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: fact.id,
      reason: "manual",
    });
    const after = await adapter.countUnresolvedActiveLearningReview(WS);
    expect(after).toBe(before + 1);
  });

  it("resolve('forgotten') atomically cascades the linked fact's status in the same transaction", async () => {
    const fact = await makeFact();
    const { id: reviewId } = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: fact.id,
      reason: "low_confidence",
    });

    const result = await adapter.resolveActiveLearningReview({
      workspaceId: WS,
      reviewId,
      resolvedBy: "key:test",
      resolution: "forgotten",
    });

    expect(result).toEqual({
      resolved: true,
      factId: fact.id,
      decisionId: null,
      cascaded: true,
    });

    const reloaded = await adapter.getFact(fact.id, WS);
    expect(reloaded?.status).toBe("forgotten");
  });

  it("resolve('kept') does NOT cascade — the fact is left untouched", async () => {
    const fact = await makeFact();
    const { id: reviewId } = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: fact.id,
      reason: "low_confidence",
    });

    const result = await adapter.resolveActiveLearningReview({
      workspaceId: WS,
      reviewId,
      resolvedBy: "key:test",
      resolution: "kept",
    });

    expect(result.cascaded).toBe(false);
    const reloaded = await adapter.getFact(fact.id, WS);
    expect(reloaded?.status).toBe("active");
  });

  it("resolve is idempotent: resolving an already-resolved row returns resolved:false", async () => {
    const fact = await makeFact();
    const { id: reviewId } = await adapter.enqueueActiveLearningReview({
      workspaceId: WS,
      factId: fact.id,
      reason: "manual",
    });
    await adapter.resolveActiveLearningReview({
      workspaceId: WS,
      reviewId,
      resolvedBy: "key:test",
      resolution: "dismissed",
    });

    const second = await adapter.resolveActiveLearningReview({
      workspaceId: WS,
      reviewId,
      resolvedBy: "key:test",
      resolution: "kept",
    });

    expect(second.resolved).toBe(false);
    expect(second.factId).toBe(fact.id);
  });

  it("resolve on a never-existing row returns resolved:false with null factId/decisionId", async () => {
    const result = await adapter.resolveActiveLearningReview({
      workspaceId: WS,
      reviewId: "mrev_never_existed",
      resolvedBy: "key:test",
      resolution: "kept",
    });
    expect(result).toEqual({ resolved: false, factId: null, decisionId: null, cascaded: false });
  });
});
