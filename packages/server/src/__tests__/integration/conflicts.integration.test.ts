/**
 * FULL-STACK HTTP contract test for the `memory_judge` MCP tool's server-side
 * surface: GET /conflicts + POST /conflicts/:id/resolve
 * (packages/server/src/routes/conflicts.ts), which packages/mcp/src/tools/judge.ts
 * calls via MnemosyneClient.judge()/resolveConflict().
 *
 * Harness mirrors api.integration.test.ts: a throwaway pgvector/pgvector:pg17
 * testcontainer, real migrations (core + adapter-postgres v3), the real Hono
 * app built with real @mnemo-ai/core deps, driven through app.request(...).
 * Hermetic & CI-safe: every run gets a fresh DB. Requires Docker.
 *
 * Verifies, per the tool-promise audit (docs/archive/openspec/tool-promise-remediation),
 * all 4 resolution strategies against real Postgres:
 *   - supersede_a: only factA is archived; factB survives untouched.
 *   - supersede_b: only factB is archived; factA survives untouched.
 *   - keep_both: neither fact is archived; the conflict itself is dismissed.
 *   - merge: both originals are archived; a new fact carries mergedStatement
 *     with `supersedes` lineage back to both originals — using the SAME
 *     lineage query pattern (`mnemo_relation` rows with relation='supersedes')
 *     as fact-replace.integration.test.ts uses for memory_update's replaceFact path.
 * And: a conflict resolved by ANY of the 4 strategies never reappears in a
 * later action='list' (GET /conflicts) call.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const WS = "c0ffee00-1234-4abc-9def-0123456789ab";
const PLAINTEXT_KEY = "mns_live_conflictstestkey00001";

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo";

let container: StartedTestContainer;
let databaseUrl: string;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let app: ReturnType<typeof createApp>;
// Second app instance wired to a DEDICATED v3 cognitive core (same real
// storage/vector/outbox, same DB) whose `surpriseThreshold` is 0 so the
// write-time §33 flow below never gets deferred to the staging queue by the
// prediction-error gate — this test's two facts intentionally share a fixed,
// identical embedding vector (see `remember-conflict-resolve.test.ts` unit
// coverage for the resolver logic itself; this test proves the real-Postgres
// end-to-end wiring). `app` (above) stays untouched and is still what
// resolves the conflict — proving zero changes to routes/conflicts.ts.
let appForRemember: ReturnType<typeof createApp>;
let sql: ReturnType<typeof postgres>;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...headers,
  };
}

interface FactBody {
  id: string;
  content: string;
  [key: string]: unknown;
}

interface RelationBody {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  [key: string]: unknown;
}

interface ConflictPair {
  relationId: string;
  confidence: number | null;
  factA: { id: string; statement: string };
  factB: { id: string; statement: string };
}

async function createFact(content: string): Promise<FactBody> {
  // flatten-legacy-dual-core PR8 deleted POST /facts (D2 step 2) — the sole
  // write path is now POST /remember, lossless-remapped {content} ->
  // {statement}. Legacy `GET /facts/:id` (used elsewhere in this file) still
  // reads back `content` — both cores share the same physical
  // mnemosyne.mnemo_fact table via `search_path=mnemosyne,public`
  // (packages/core/src/factory.ts), confirmed empirically.
  const res = await app.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ statement: content }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  return { ...body, content: body.statement } as unknown as FactBody;
}

async function getFactStatus(id: string): Promise<number> {
  const res = await app.request(`/facts/${id}`, { headers: authed() });
  return res.status;
}

async function createConflictRelation(sourceId: string, targetId: string): Promise<RelationBody> {
  const res = await app.request("/relations", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({
      sourceKind: "fact",
      sourceId,
      targetKind: "fact",
      targetId,
      relation: "conflicts_with",
      markedByKind: "system",
      reason: "test-seeded conflict",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as RelationBody;
}

async function listConflicts(limit = 20): Promise<{ pairs: ConflictPair[] }> {
  const res = await app.request(`/conflicts?limit=${limit}`, { headers: authed() });
  expect(res.status).toBe(200);
  return (await res.json()) as { pairs: ConflictPair[] };
}

async function resolveConflict(
  relationId: string,
  action: "supersede_a" | "supersede_b" | "keep_both" | "merge",
  mergedStatement?: string
): Promise<{ resolved: boolean; action: string; relationId: string; mergedFactId: string | null }> {
  const res = await app.request(`/conflicts/${relationId}/resolve`, {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ action, ...(mergedStatement ? { mergedStatement } : {}) }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    resolved: boolean;
    action: string;
    relationId: string;
    mergedFactId: string | null;
  };
}

async function findRelationById(id: string): Promise<RelationBody | undefined> {
  const res = await app.request("/relations?limit=500", { headers: authed() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: RelationBody[] };
  return body.items.find((r) => r.id === id);
}

/** Same lineage query pattern as fact-replace.integration.test.ts. */
async function supersedesRelations(
  sourceId: string
): Promise<Array<{ source_id: string; target_id: string; relation: string }>> {
  return sql<Array<{ source_id: string; target_id: string; relation: string }>>`
    SELECT source_id, target_id, relation
    FROM mnemosyne.mnemo_relation
    WHERE workspace_id = ${WS} AND relation = 'supersedes' AND source_id = ${sourceId}
  `;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(databaseUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [MIGRATE_CLI, "--migrations-dir", MIGRATIONS_DIR, "--database-url", databaseUrl],
    { timeout: 90_000 }
  );
  expect(stdout).toContain("done");

  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  sql = postgres(databaseUrl, { max: 3, onnotice: () => void 0 });
  await sql`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_conflicts_test_01"}, ${WS}, ${keyHash}, ${"conflicts-integration-test"},
            ${"conflicts-integration-test"}, ARRAY['memory:read', 'memory:write', 'memory:delete']::text[])
  `;

  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl });
  apiKeyLookupClose = apiKeys.close;

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const DIMS = 1536;
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS));
    },
    async embedSingle() {
      return new Float32Array(DIMS);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(databaseUrl);
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: databaseUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopTelemetry = {
    startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return v3Storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return v3Storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return v3Storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return v3Storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const cognitive = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps: ServerDeps = {
    apiKeys,
    cognitive,
    storage: v3Storage,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  app = createApp({ deps, version: "2.0.0-test" });

  // Dedicated cognitive core + app for the write-time-conflict-surfacing
  // end-to-end test below. A fixed non-zero one-hot embedding (deterministic,
  // identical for both writes — no NaN-cosine risk from an all-zero vector)
  // combined with `surpriseThreshold: 0` guarantees the surprise gate never
  // stages either write (pe === 0 is not < 0), so both facts commit
  // synchronously through the real §33 resolver against real Postgres.
  const fixedEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fixed-embed-e2e",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => {
        const v = new Float32Array(DIMS);
        v[0] = 1;
        return v;
      });
    },
    async embedSingle() {
      const v = new Float32Array(DIMS);
      v[0] = 1;
      return v;
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  // WP-7: a write-time conflict exists only once the fact-pair classifier
  // calls the pair a CONTRADICTION. This stub plays the classifier: the two
  // on-call rotation facts contradict, everything else is COMPATIBLE.
  const classifyingLlm: import("@mnemo-ai/types").LLMAdapter = {
    id: "stub-classifier",
    model: "stub-classifier",
    async generate(input) {
      const prompt = input.messages[0]?.content ?? "";
      const contradicts = prompt.includes("starts Monday") && prompt.includes("starts Friday");
      return {
        content: contradicts ? "CONTRADICTION" : "COMPATIBLE",
        tokensUsed: { input: 1, output: 1 },
        model: "stub-classifier",
        finishReason: "stop" as const,
      };
    },
    async generateStructured() {
      throw new Error("unused");
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const cognitiveForRemember = v3CoreMod.createCore(
    {
      storage: v3Storage,
      vector: v3Vector,
      embed: fixedEmbed,
      outbox: outboxAdapter,
      logger: noopLogger,
      telemetry: noopTelemetry,
      llm: classifyingLlm,
    },
    { surpriseThreshold: 0, writeConflictClassification: true }
  );
  const depsForRemember: ServerDeps = { ...deps, cognitive: cognitiveForRemember };
  appForRemember = createApp({ deps: depsForRemember, version: "2.0.0-test" });
}, 120_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await sql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("memory_judge contract — GET /conflicts + POST /conflicts/:id/resolve", () => {
  it("action='list' surfaces a seeded conflicts_with pair", async () => {
    const factA = await createFact("Conflict-list fact A: rollout window is Tuesday.");
    const factB = await createFact("Conflict-list fact B: rollout window is Thursday.");
    const rel = await createConflictRelation(factA.id, factB.id);

    const { pairs } = await listConflicts();
    const found = pairs.find((p) => p.relationId === rel.id);
    expect(found).toBeDefined();
    expect(found?.factA.id).toBe(factA.id);
    expect(found?.factB.id).toBe(factB.id);
  });

  it("supersede_a archives ONLY factA; factB survives untouched; lineage points factB -> factA", async () => {
    const factA = await createFact("Supersede-a fact A: the API base URL is v1.example.com.");
    const factB = await createFact("Supersede-a fact B: the API base URL is v2.example.com.");
    const rel = await createConflictRelation(factA.id, factB.id);

    const result = await resolveConflict(rel.id, "supersede_a");
    expect(result.resolved).toBe(true);
    expect(result.mergedFactId).toBeNull();

    // factA (the named loser) is archived; factB (untouched) still active.
    expect(await getFactStatus(factA.id)).toBe(404);
    expect(await getFactStatus(factB.id)).toBe(200);

    // Lineage: winner (factB) supersedes loser (factA).
    const lineage = await supersedesRelations(factB.id);
    expect(lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: factB.id,
          target_id: factA.id,
          relation: "supersedes",
        }),
      ])
    );

    // The original conflicts_with relation is no longer that verb.
    const patched = await findRelationById(rel.id);
    expect(patched?.relation).not.toBe("conflicts_with");

    // And it must not resurface in a later list call.
    const { pairs } = await listConflicts();
    expect(pairs.find((p) => p.relationId === rel.id)).toBeUndefined();
  });

  it("supersede_b archives ONLY factB; factA survives untouched; lineage points factA -> factB", async () => {
    const factA = await createFact("Supersede-b fact A: default currency is USD.");
    const factB = await createFact("Supersede-b fact B: default currency is EUR.");
    const rel = await createConflictRelation(factA.id, factB.id);

    const result = await resolveConflict(rel.id, "supersede_b");
    expect(result.resolved).toBe(true);
    expect(result.mergedFactId).toBeNull();

    // factB (the named loser) is archived; factA (untouched) still active.
    expect(await getFactStatus(factA.id)).toBe(200);
    expect(await getFactStatus(factB.id)).toBe(404);

    // Lineage: winner (factA) supersedes loser (factB).
    const lineage = await supersedesRelations(factA.id);
    expect(lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: factA.id,
          target_id: factB.id,
          relation: "supersedes",
        }),
      ])
    );

    const patched = await findRelationById(rel.id);
    expect(patched?.relation).not.toBe("conflicts_with");

    const { pairs } = await listConflicts();
    expect(pairs.find((p) => p.relationId === rel.id)).toBeUndefined();
  });

  it("keep_both archives NEITHER fact but dismisses the conflict from future list calls", async () => {
    const factA = await createFact("Keep-both fact A: support hours are 9-5 EST.");
    const factB = await createFact("Keep-both fact B: support hours are 24/7.");
    const rel = await createConflictRelation(factA.id, factB.id);

    const result = await resolveConflict(rel.id, "keep_both");
    expect(result.resolved).toBe(true);
    expect(result.mergedFactId).toBeNull();

    // Neither fact is archived.
    expect(await getFactStatus(factA.id)).toBe(200);
    expect(await getFactStatus(factB.id)).toBe(200);

    // No supersedes relation was created for either fact by this resolution.
    expect(await supersedesRelations(factA.id)).toHaveLength(0);
    expect(await supersedesRelations(factB.id)).toHaveLength(0);

    const patched = await findRelationById(rel.id);
    expect(patched?.relation).not.toBe("conflicts_with");

    const { pairs } = await listConflicts();
    expect(pairs.find((p) => p.relationId === rel.id)).toBeUndefined();
  });

  it("merge requires mergedStatement (400) and, when provided, supersedes BOTH originals with a lineage-correct new fact", async () => {
    const factA = await createFact("Merge fact A: retention window is 30 days.");
    const factB = await createFact("Merge fact B: retention window is 90 days.");
    const rel = await createConflictRelation(factA.id, factB.id);

    // Missing mergedStatement -> 400.
    const badRes = await app.request(`/conflicts/${rel.id}/resolve`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ action: "merge" }),
    });
    expect(badRes.status).toBe(400);

    const mergedStatement = "Merge fact resolution: retention window is 60 days (reconciled).";
    const result = await resolveConflict(rel.id, "merge", mergedStatement);
    expect(result.resolved).toBe(true);
    expect(typeof result.mergedFactId).toBe("string");
    const mergedFactId = result.mergedFactId as string;

    // Both originals are superseded (archived).
    expect(await getFactStatus(factA.id)).toBe(404);
    expect(await getFactStatus(factB.id)).toBe(404);

    // The merged fact exists and carries the merged statement.
    const mergedRes = await app.request(`/facts/${mergedFactId}`, { headers: authed() });
    expect(mergedRes.status).toBe(200);
    const mergedFact = (await mergedRes.json()) as FactBody;
    expect(mergedFact.content).toBe(mergedStatement);

    // Lineage: merged fact supersedes BOTH originals (same query pattern as
    // fact-replace.integration.test.ts's replaceFact lineage assertion).
    const lineage = await supersedesRelations(mergedFactId);
    const targets = lineage.map((r) => r.target_id).sort();
    expect(targets).toEqual([factA.id, factB.id].sort());
    expect(lineage.every((r) => r.relation === "supersedes")).toBe(true);

    const patched = await findRelationById(rel.id);
    expect(patched?.relation).not.toBe("conflicts_with");

    const { pairs } = await listConflicts();
    expect(pairs.find((p) => p.relationId === rel.id)).toBeUndefined();
  });

  it("resolving one conflict does not affect an unrelated still-open conflict in the same list", async () => {
    const factA = await createFact("Isolation fact A1: timezone default is UTC.");
    const factB = await createFact("Isolation fact B1: timezone default is local.");
    const relResolved = await createConflictRelation(factA.id, factB.id);

    const factC = await createFact("Isolation fact A2: max upload size is 10MB.");
    const factD = await createFact("Isolation fact B2: max upload size is 25MB.");
    const relOpen = await createConflictRelation(factC.id, factD.id);

    await resolveConflict(relResolved.id, "keep_both");

    const { pairs } = await listConflicts(20);
    expect(pairs.find((p) => p.relationId === relResolved.id)).toBeUndefined();
    expect(pairs.find((p) => p.relationId === relOpen.id)).toBeDefined();
  });
});

// ─── write-time-conflict-surfacing: one literal end-to-end flow ─────────────
//
// verify-report gap (CRITICAL): spec.md's "Review verdict is judgeable via
// the existing pipeline" scenario was previously only provable by composing
// two SEPARATELY-passing tests — section33-conflicts-with-relation.
// integration.test.ts (adapter-postgres) proves relation persistence/
// discoverability using hand-seeded fake fact ids, never through a real
// remember() call; and this file's other tests prove POST /conflicts/:id/
// resolve works, but only for relations seeded via POST /relations, never
// one produced by the write-time §33 resolver. Neither test writes a fact
// that itself produces the judgeable relation. This test closes that gap
// with ONE test that does both: POST /remember (real §33 resolver, real
// Postgres) → judge the exact relationId it returns via POST /conflicts/:id/
// resolve (the same, unmodified handler).

interface RememberConflictCandidate {
  id: string;
  subject: string;
  statement: string;
  action: "supersede" | "reject" | "review";
  relationId?: string;
}

interface RememberOut {
  id: string;
  conflict?: {
    judgmentRequired: boolean;
    candidates: RememberConflictCandidate[];
  };
  [key: string]: unknown;
}

async function rememberFact(statement: string, subject: string): Promise<RememberOut> {
  const res = await appForRemember.request("/remember", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ statement, subject }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as RememberOut;
}

describe("write-time conflict surfacing → memory_judge, one literal end-to-end flow", () => {
  it("a review verdict's write-time conflicts_with relation is directly resolvable via the existing memory_judge pipeline, zero changes to routes/conflicts.ts", async () => {
    const subject = "e2e-write-time-conflict-subject";

    const factA = await rememberFact(
      "E2E write-time fact A: the on-call rotation starts Monday.",
      subject
    );
    // Nothing to contradict yet — no conflict field at all.
    expect(factA.conflict).toBeUndefined();

    const factB = await rememberFact(
      "E2E write-time fact B: the on-call rotation starts Friday.",
      subject
    );

    // POST /remember ran the REAL §33 resolver (resolveFactContradictions)
    // synchronously against real Postgres. Both facts share the same default
    // attribution ("user_stated" — the HTTP route never forwards a
    // provenance override), so trust is equal and decideAutoResolution's
    // trust-anchor rule is skipped; validFrom necessarily differs (factA was
    // committed first) so the recency rule fires with confidence exactly
    // 0.7, which is NOT > the 0.7 auto-resolve threshold → action "review".
    expect(factB.conflict).toBeDefined();
    expect(factB.conflict!.judgmentRequired).toBe(true);
    const candidate = factB.conflict!.candidates.find((c) => c.id === factA.id);
    expect(candidate).toBeDefined();
    expect(candidate!.action).toBe("review");
    expect(typeof candidate!.relationId).toBe("string");
    const relationId = candidate!.relationId as string;

    // The write-time resolver's relation is a real row, discoverable via the
    // exact filter GET /conflicts already applies — using `app`, NOT
    // `appForRemember`, i.e. the same unmodified deps/app every other test in
    // this file uses.
    const beforeResolve = await listConflicts();
    expect(beforeResolve.pairs.find((p) => p.relationId === relationId)).toBeDefined();

    // memory_judge (action="resolve") maps to POST /conflicts/:id/resolve —
    // the SAME, unmodified handler that consolidation-detected conflicts use.
    const result = await resolveConflict(relationId, "keep_both");
    expect(result.resolved).toBe(true);
    expect(result.action).toBe("keep_both");
    expect(result.relationId).toBe(relationId);

    // Neither fact was archived by keep_both, and the relation never
    // resurfaces — proving the full write → surface → judge → resolve round
    // trip for a write-time candidate, in one literal test.
    expect(await getFactStatus(factA.id)).toBe(200);
    expect(await getFactStatus(factB.id)).toBe(200);
    const afterResolve = await listConflicts();
    expect(afterResolve.pairs.find((p) => p.relationId === relationId)).toBeUndefined();
  });

  it("a write that is merely similar (classified COMPATIBLE) asks for no judgment and leaves no pending conflict", async () => {
    // CLIENTS-9 / AGENTSIM-3: identical embeddings (cosine 1.0) used to be
    // enough for judgmentRequired:true. Similarity is a candidate, never a
    // verdict.
    const before = await listConflicts();
    const fact = await rememberFact(
      "E2E write-time fact C: the on-call rotation is tracked in PagerDuty.",
      "e2e-write-time-conflict-subject"
    );

    expect(fact.conflict).toBeUndefined();
    const after = await listConflicts();
    expect(after.pairs.filter((p) => p.factA.id === fact.id || p.factB.id === fact.id)).toEqual([]);
    expect(after.pairs.length).toBe(before.pairs.length);
  });
});
