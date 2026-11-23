/**
 * flatten-legacy-dual-core PR 9c (design.md D6.4) — real-Postgres proof for:
 *
 *   (a) The `evidence`-vs-`metadata` bugfix. BEFORE this PR,
 *       `GraphRepository.createRelation` wrote `evidence: input.metadata ?? {}`
 *       UNCONDITIONALLY — even a pure-Hebbian relation with no judgment intent
 *       (the co-recall / session-collapse call pattern) forced a non-null `{}`
 *       into the judgment overlay's `evidence` column, silently clobbering its
 *       natural unset (`NULL`) state. This test proves the physical row's
 *       `evidence` column is genuinely `NULL` — not `'{}'::jsonb` — when the
 *       caller supplies no evidence, and that an explicit `evidence` payload
 *       round-trips byte-for-byte when the caller does supply one.
 *   (b) `applyRelationJudgment` works end-to-end: create (Hebbian-only) →
 *       judge (sets verb/evidence/reason/confidence/markedBy*) → verify the
 *       row's judgment overlay reflects the judgment while its Hebbian
 *       overlay (hebbianWeight/coRecallCount/directionality) is untouched.
 *
 * Prerequisites: Docker daemon running.
 * Run with: pnpm --filter @mnemo-ai/adapter-postgres test:integration
 * (Node 22 required — testcontainers/undici; see CLAUDE.md.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;

function v3Adapter() {
  const { db, pgClient } = createDrizzleClient(databaseUrl);
  return { adapter: new DrizzleStorageAdapter(db, pgClient), pgClient };
}

let wsCounter = 0;
function freshWorkspaceId(): string {
  wsCounter++;
  return `00000000-0000-0000-0000-${String(wsCounter).padStart(12, "0")}`;
}

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe("D6.4 bugfix — evidence is never forced to '{}' on a pure-Hebbian createRelation", () => {
  it("a relation created with no evidence input has a physically NULL evidence column", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();

    // Mirrors the real co-recall.ts / session/collapse.ts call shape: a
    // pure-Hebbian relation with zero judgment intent, no evidence at all.
    const created = await adapter.createRelation({
      workspaceId: ws,
      sourceId: "fact-hebbian-a",
      sourceType: "fact",
      targetId: "fact-hebbian-b",
      targetType: "fact",
      verb: "related",
      weight: 0.5,
    });

    expect(created.evidence).toBeNull();
    expect(created.judgmentStatus).toBe("pending");

    // Read the raw column directly — the domain-mapper's default-coalescing
    // could otherwise hide a `'{}'::jsonb` regression at the wire boundary.
    const rows = await pgClient.unsafe(
      `SELECT evidence FROM mnemosyne.mnemo_relation WHERE id = $1`,
      [created.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!["evidence"]).toBeNull();
  });

  it("a relation created WITH an explicit evidence payload round-trips it exactly (no clobbering)", async () => {
    const { adapter, pgClient } = v3Adapter();
    const ws = freshWorkspaceId();

    const created = await adapter.createRelation({
      workspaceId: ws,
      sourceId: "fact-evidence-a",
      sourceType: "fact",
      targetId: "fact-evidence-b",
      targetType: "fact",
      verb: "conflicts_with",
      evidence: { detectedBy: "section33_resolver", action: "review" },
    });

    expect(created.evidence).toEqual({ detectedBy: "section33_resolver", action: "review" });

    const rows = await pgClient.unsafe(
      `SELECT evidence FROM mnemosyne.mnemo_relation WHERE id = $1`,
      [created.id]
    );
    expect(rows[0]!["evidence"]).toEqual({ detectedBy: "section33_resolver", action: "review" });
  });
});

describe("applyRelationJudgment — create (Hebbian) → judge → verify state", () => {
  it("judging a pure-Hebbian relation sets the judgment overlay without touching the Hebbian overlay", async () => {
    const { adapter } = v3Adapter();
    const ws = freshWorkspaceId();

    const created = await adapter.createRelation({
      workspaceId: ws,
      sourceId: "fact-judge-a",
      sourceType: "fact",
      targetId: "fact-judge-b",
      targetType: "fact",
      verb: "related",
      weight: 0.5,
    });
    expect(created.judgmentStatus).toBe("pending");
    expect(created.evidence).toBeNull();

    const judged = await adapter.applyRelationJudgment({
      workspaceId: ws,
      id: created.id,
      relation: "not_conflict",
      reason: "Resolved via memory_judge: keep_both",
      evidence: { judgeReasoning: "not actually contradictory" },
      confidence: 0.95,
      markedByKind: "llm_judge",
      markedByModel: "gpt-5",
    });

    expect(judged).not.toBeNull();
    expect(judged!.verb).toBe("not_conflict");
    expect(judged!.judgmentStatus).toBe("judged");
    expect(judged!.reason).toBe("Resolved via memory_judge: keep_both");
    expect(judged!.evidence).toEqual({ judgeReasoning: "not actually contradictory" });
    expect(judged!.confidence).toBe(0.95);
    expect(judged!.markedByKind).toBe("llm_judge");
    expect(judged!.markedByModel).toBe("gpt-5");

    // Hebbian overlay is untouched by the judgment write — the two overlays
    // on the same physical row don't clobber each other's unrelated fields.
    expect(judged!.weight).toBe(created.weight);
    expect(judged!.coRecallCount).toBe(created.coRecallCount);
    expect(judged!.directionality).toBe(created.directionality);
    expect(judged!.sourceId).toBe(created.sourceId);
    expect(judged!.targetId).toBe(created.targetId);

    const [fetched] = await adapter.getRelations({ workspaceId: ws, sourceId: "fact-judge-a" });
    expect(fetched?.judgmentStatus).toBe("judged");
    expect(fetched?.verb).toBe("not_conflict");
  });

  it("returns null for a relation id that does not exist in this workspace", async () => {
    const { adapter } = v3Adapter();
    const ws = freshWorkspaceId();

    const result = await adapter.applyRelationJudgment({
      workspaceId: ws,
      id: "00000000-0000-0000-0000-000000000000",
      relation: "not_conflict",
      markedByKind: "system",
    });

    expect(result).toBeNull();
  });

  it("returns null when the relation exists but in a DIFFERENT workspace (RLS/workspace scoping)", async () => {
    const { adapter } = v3Adapter();
    const wsA = freshWorkspaceId();
    const wsB = freshWorkspaceId();

    const created = await adapter.createRelation({
      workspaceId: wsA,
      sourceId: "fact-scope-a",
      sourceType: "fact",
      targetId: "fact-scope-b",
      targetType: "fact",
      verb: "related",
    });

    const result = await adapter.applyRelationJudgment({
      workspaceId: wsB,
      id: created.id,
      relation: "not_conflict",
      markedByKind: "system",
    });

    expect(result).toBeNull();

    // Confirm the row was NOT mutated by the cross-workspace attempt.
    const [fetched] = await adapter.getRelations({ workspaceId: wsA, sourceId: "fact-scope-a" });
    expect(fetched?.judgmentStatus).toBe("pending");
    expect(fetched?.verb).toBe("related");
  });
});
