/**
 * P135 — real-Postgres proof that a read filter naming a project matches every
 * spelling of it: `scopeRef` plus `scopeRefAliases` becomes `scope_ref IN (...)`
 * in the five places a scopeRef filter reaches SQL — the fact list, the recall
 * candidate conditions (pointer tier), and the decision, strategy and workflow
 * lists (which keep their "or unscoped" semantics).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../../DrizzleStorageAdapter.js";
import { migrate } from "../../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const SPELLINGS = ["acme", "Acme", "acme-hr"];
const PROJECT = { scopeRef: "acme", scopeRefAliases: ["Acme", "acme-hr"] };

describe("P135 — scopeRef filters accept every spelling of a project", () => {
  let container: StartedTestContainer;
  let adapter: DrizzleStorageAdapter;
  let adapterClient: ReturnType<typeof createDrizzleClient>;

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
    const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
    await migrate({ databaseUrl, log: () => undefined });
    adapterClient = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(adapterClient.db, adapterClient.pgClient);
  }, 120_000);

  afterAll(async () => {
    await adapterClient?.pgClient.end();
    await container?.stop();
  });

  it("queryFactsPage: the canonical name plus aliases, never another project", async () => {
    const workspaceId = crypto.randomUUID();
    for (const scopeRef of [...SPELLINGS, "orchester"]) {
      await adapter.createFact({
        workspaceId,
        scope: "global",
        statement: `payroll note under ${scopeRef}`,
        subject: "payroll",
        kind: "other",
        sensitivity: "internal",
        scopeRef,
      });
    }
    const page = await adapter.queryFactsPage({ workspaceId, ...PROJECT, limit: 50 });
    expect(page.items.map((f) => f.scopeRef).sort()).toEqual([...SPELLINGS].sort());
    expect(page.total).toBe(3);

    const exact = await adapter.queryFactsPage({ workspaceId, scopeRef: "acme", limit: 50 });
    expect(exact.items.map((f) => f.scopeRef)).toEqual(["acme"]);
  });

  it("pointerCandidates: recall's SQL candidate filter accepts the aliases", async () => {
    const workspaceId = crypto.randomUUID();
    for (const scopeRef of ["Acme", "orchester"]) {
      await adapter.createFact({
        workspaceId,
        scope: "global",
        statement: `payroll closes on the twenty fifth for ${scopeRef}`,
        subject: "payroll",
        kind: "other",
        sensitivity: "internal",
        scopeRef,
      });
    }
    const hits = await adapter.pointerCandidates({
      workspaceId,
      terms: ["payroll", "closes"],
      bands: [],
      limit: 10,
      filter: PROJECT,
    });
    expect(hits.map((h) => h.statement)).toEqual(["payroll closes on the twenty fifth for Acme"]);
  });

  it("queryDecisions, queryStrategies, queryWorkflows: aliases plus unscoped rows", async () => {
    const workspaceId = crypto.randomUUID();
    for (const scopeRef of ["Acme", "orchester", undefined]) {
      const tag = scopeRef ?? "none";
      await adapter.createDecision({
        workspaceId,
        title: `decision ${tag}`,
        body: `decided under ${tag}`,
        kind: "decision",
        ...(scopeRef ? { scopeRef } : {}),
      } as never);
      await adapter.createStrategy({
        workspaceId,
        trigger: `when ${tag}`,
        action: `act ${tag}`,
        ...(scopeRef ? { scopeRef } : {}),
      } as never);
      await adapter.createWorkflow({
        workspaceId,
        name: `workflow ${tag}`,
        steps: [{ order: 1, action: "run", expectedDurationMs: 1 }],
        ...(scopeRef ? { scopeRef } : {}),
      } as never);
    }
    const refs = (items: Array<{ scopeRef?: string | null }>) =>
      items.map((i) => i.scopeRef ?? null).sort();

    const decisions = await adapter.queryDecisions({ workspaceId, ...PROJECT });
    const strategies = await adapter.queryStrategies({ workspaceId, ...PROJECT });
    const workflows = await adapter.queryWorkflows({ workspaceId, ...PROJECT });
    for (const page of [decisions, strategies, workflows]) {
      expect(refs(page.items)).toEqual(["Acme", null]);
    }
  });
});
