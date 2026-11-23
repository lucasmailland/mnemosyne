/**
 * §11 governance demote against real Postgres: a fact with confident low worth
 * is demoted by governanceSweep, and the sweep's archive-candidate review is
 * filed once, not once per run (the cron re-flags the same fact every day).
 *
 * Requires Docker and a built `@mnemo-ai/core` — run via:
 *   pnpm --filter @mnemo-ai/adapter-postgres test:integration -- governance-demote-idempotent
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { governanceSweep } from "@mnemo-ai/core/cognitive";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";

let container: StartedTestContainer;
let adapter: DrizzleStorageAdapter;
let raw: ReturnType<typeof createDrizzleClient>["pgClient"];

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
  await migrate({ databaseUrl, log: () => void 0 });
  const client = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(client.db, client.pgClient);
  raw = client.pgClient;
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop().catch(() => void 0);
});

describe("governance demote: one pending review per fact", () => {
  it("two sweeps in a row demote twice but enqueue a single review", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "Acme's staging cluster runs on port 9999",
      subject: "acme-staging",
      kind: "other",
    });
    // 38 unreinforced recalls on top of the Beta(2,2) prior: Wilson upper ≈ 0.16.
    await raw`UPDATE mnemosyne.mnemo_fact SET worth_alpha = 2, worth_beta = 40 WHERE id = ${fact.id}`;

    const deps = { storage: adapter, maxHotTierSize: 1000 };
    const first = await governanceSweep(deps, WS);
    const second = await governanceSweep(deps, WS);
    expect(first.demote).toBe(1);
    expect(second.demote).toBe(1);

    const rows = await raw<Array<{ status: string }>>`
      SELECT status FROM mnemosyne.mnemo_review_item
      WHERE workspace_id = ${WS} AND primitive_id = ${fact.id}
        AND reason = 'low_worth_archive_candidate'`;
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("files a new review once the previous one is no longer pending", async () => {
    await adapter.enqueueReview({
      workspaceId: WS,
      primitiveKind: "task",
      primitiveId: "task_acme_1",
      reason: "stale_task",
    });
    await raw`UPDATE mnemosyne.mnemo_review_item SET status = 'resolved' WHERE primitive_id = 'task_acme_1'`;
    await adapter.enqueueReview({
      workspaceId: WS,
      primitiveKind: "task",
      primitiveId: "task_acme_1",
      reason: "stale_task",
    });
    const rows = await raw<Array<{ status: string }>>`
      SELECT status FROM mnemosyne.mnemo_review_item
      WHERE primitive_id = 'task_acme_1' ORDER BY created_at`;
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "resolved"]);
  });

  it("enqueueReviewItem (event-driven callers) still files every call", async () => {
    const item = {
      workspaceId: WS,
      primitiveId: "fact_acme_2",
      reason: "contradiction",
    };
    await adapter.enqueueReviewItem({ ...item, detail: { contradictsFactId: "a" } });
    await adapter.enqueueReviewItem({ ...item, detail: { contradictsFactId: "b" } });
    const rows = await raw`
      SELECT 1 FROM mnemosyne.mnemo_review_item WHERE primitive_id = 'fact_acme_2'`;
    expect(rows).toHaveLength(2);
  });
});
