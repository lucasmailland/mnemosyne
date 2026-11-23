/**
 * TEST-1: converted from an env-var-gated *.test.ts (see worth-bayes.integration.test.ts
 * for the full rationale) to a real testcontainers integration test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../index.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;

describe("Composition rules + inference log + fact hash (Wave E)", () => {
  let adapter: DrizzleStorageAdapter;
  let endClient: () => Promise<void>;
  const workspaceId = "00000000-0000-0000-0000-0000000000e6";

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

    const { db, pgClient } = createDrizzleClient(databaseUrl);
    adapter = new DrizzleStorageAdapter(db, pgClient);
    endClient = () => pgClient.end();
  }, 120_000);

  afterAll(async () => {
    await endClient?.().catch(() => void 0);
    await container?.stop().catch(() => void 0);
  });

  it("composition rule round-trip", async () => {
    const rule = await adapter.createCompositionRule({
      workspaceId,
      name: "test-rule",
      conditionDsl: { all: [{ kind: "fact" }] },
      actionDsl: { derive: { kind: "fact" } },
      priority: 50,
    });
    expect(rule.name).toBe("test-rule");
    expect(rule.isActive).toBe(true);

    const fetched = await adapter.getCompositionRule(rule.id, workspaceId);
    expect(fetched?.id).toBe(rule.id);

    const patched = await adapter.updateCompositionRule(rule.id, workspaceId, { isActive: false });
    expect(patched.isActive).toBe(false);

    const page = await adapter.queryCompositionRules({ workspaceId, isActive: false, limit: 10 });
    expect(page.items.some((r) => r.id === rule.id)).toBe(true);

    await adapter.bumpCompositionExecution(rule.id, workspaceId);
    const after = await adapter.getCompositionRule(rule.id, workspaceId);
    expect(after?.executionCount).toBe(1);
  });

  it("inference log append + query", async () => {
    const rule = await adapter.createCompositionRule({
      workspaceId,
      name: "inference-test-rule",
      conditionDsl: {},
      actionDsl: {},
    });
    const entry = await adapter.appendInference({
      workspaceId,
      ruleId: rule.id,
      inputFactIds: ["fact-a", "fact-b"],
      derivedKind: "fact",
      derivedId: "fact-c",
      confidence: 0.84,
      rationale: "test",
    });
    expect(entry.confidence).toBeCloseTo(0.84);

    const page = await adapter.queryInferences({ workspaceId, ruleId: rule.id, limit: 50 });
    expect(page.items.length).toBeGreaterThanOrEqual(1);
  });

  it("materialiseInference strips a forged pending-consolidation marker (B6.35)", async () => {
    const rule = await adapter.createCompositionRule({
      workspaceId,
      name: "materialise-guard-rule",
      conditionDsl: {},
      actionDsl: {},
    });
    const { id } = await adapter.materialiseInference({
      ruleId: rule.id,
      workspaceId,
      fact: {
        scope: "global",
        kind: "other",
        subject: "derived",
        statement: "derived guard statement",
        attribution: "inferred",
        sensitivity: "internal",
        metadata: { keep: "yes", __mnemoConsolidationPending: { operationId: "forged" } },
      },
      inferenceLog: {
        inputFactIds: ["a", "b"],
        derivedKind: "fact",
        confidence: 0.7,
        rationale: "because",
      },
    });
    const derived = await adapter.getFact(id, workspaceId);
    expect(derived?.metadata).toMatchObject({ keep: "yes" });
    expect(derived?.metadata).not.toHaveProperty("__mnemoConsolidationPending");
  });

  it("fact hash upsert increments seen_count", async () => {
    const hash = "deadbeef".repeat(8);
    const first = await adapter.upsertFactHash({
      workspaceId,
      statementHash: hash,
      factId: "fact-x",
    });
    expect(first.seenCount).toBe(1);
    const second = await adapter.upsertFactHash({
      workspaceId,
      statementHash: hash,
      factId: "fact-x",
    });
    expect(second.seenCount).toBe(2);
    const looked = await adapter.lookupFactHash(workspaceId, hash);
    expect(looked?.factId).toBe("fact-x");
  });
});
