/**
 * Contract test for `memory_search` (packages/mcp/src/tools/search.ts),
 * proven end-to-end through the REAL `POST /recall` HTTP route
 * (packages/server/src/routes/recall.ts) against a real Postgres + pgvector
 * instance, through a non-superuser `mnemo_app_role`-derived connection —
 * per this repo's rule that any claim touching DB/RLS-adjacent recall
 * behavior must be verified against real Postgres, not mocks.
 *
 * MCP-1 (docs/archive/openspec/tool-promise-remediation/spec.md Requirement 8) — FIXED
 * 2026-07-29. Originally: `packages/server/src/routes/recall.ts` never
 * declared `mode` in its zod schema and never copied `body.vectorWeight`
 * into the `RecallQuery` handed to `deps.cognitive.recall()` — every call,
 * regardless of what was requested, resolved to `mode: "auto"`. Fixed by
 * adding `mode` to the schema and forwarding both `mode` and `vectorWeight`
 * into the query when explicitly supplied (an unconditional forward would
 * have been its own bug: the schema's old `vectorWeight` default of 0.5
 * would have silently changed every caller's default mode from "auto" to
 * "hybrid" — the fix removed that schema-level default instead).
 *
 * `memory_search`'s own promise (search.ts):
 *   "búsqueda semántica pura... 100% semántica/vectorial" — and —
 *   "Cuando el servidor no tiene MNEMO_LLM_API_KEY configurada, cae
 *   automáticamente a búsqueda full-text (FTS)... rankeados por ts_rank."
 *
 * Post-fix, `memory_search` deliberately does NOT send `mode`/`vectorWeight`
 * at all (see search.ts's MCP-1 fix note) — forcing strict `mode:"semantic"`
 * would now genuinely reach the pipeline and throw
 * `semantic_search_unavailable` whenever no embedder is configured,
 * breaking its own FTS-fallback promise. Its actual request body is just
 * `{ query, topK, ...filters }`, resolving to the default `"auto"` mode.
 *
 * This file proves, against real Postgres:
 *
 *   1. REGRESSION PROOF (was: FINDING — no-op): `mode` now genuinely
 *      changes routing. `mode: "lexical"` forces pure-FTS ranking even
 *      WITH an embedder configured (proving the field is no longer
 *      dropped), and `mode: "semantic"` with NO embedder now throws
 *      instead of silently falling back (proving strict semantic is
 *      really enforced, not silently discarded).
 *   2. Scenario 1 (auto-mode ranks by vector similarity, not keyword
 *      overlap): with an embedder configured, using `memory_search`'s REAL
 *      request shape (mode/vectorWeight omitted, i.e. "auto"), a fact whose
 *      PRECOMPUTED vector is set to exactly match the query's embedding —
 *      but whose text shares ZERO keywords with the query — ranks #1,
 *      ahead of a fact stuffed with the query's literal keywords
 *      (near-zero cosine similarity by construction).
 *   3. Scenario 2 (FTS fallback actually engages and is useful): with NO
 *      embedder configured, `memory_search`'s real (auto-mode) request
 *      does NOT error — it returns 200, `debug.searchMode: "fts"`, and now
 *      the KEYWORD-STUFFED fact (real Postgres `ts_rank` over
 *      `text_lemmatized`) outranks the vector-only-close fact — the exact
 *      inverse of (2), proving the FTS path is real `ts_rank` ranking, not
 *      a stub.
 *   4. Parity proof: for a fixed fixture set, a "semantic"-forced call
 *      (embedder configured) and memory_search's real auto-mode call
 *      produce IDENTICAL hit ordering/scores — proving the tool's decision
 *      to omit mode/vectorWeight costs nothing when an embedder is present.
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
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG_USER = "mnemo_super";
const PG_PASSWORD = "mnemo_super";
const PG_DB = "mnemo_test";
const APP_ROLE = "search_app";
const APP_PASSWORD = "search_app_pass";

const TENANT_ID = "tenant-search-contract";
const WS = "9b1f9c00-0000-4000-8000-000000000002";

const KEY = "mns_live_searchcontracthasscope1";
const DIMS = 1536;

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let apiKeyLookupClose: (() => Promise<void>) | undefined;
let appWithEmbed: ReturnType<typeof createApp>;
let appNoEmbed: ReturnType<typeof createApp>;
// Both apps share this SAME storage/vector pair (only their embed adapter
// differs) — see beforeAll.
let v3Storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let v3Vector: import("@mnemo-ai/adapter-vector").PgVectorAdapter;

function authed(headers: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers };
}

/** One-hot vector: 1.0 at `dim`, 0 elsewhere. Orthogonal across distinct dims → cosine 0. */
function oneHot(dim: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[dim] = 1;
  return v;
}

/**
 * A vector that is `mainWeight` in the shared `mainDim` direction (the one
 * the fake embedder always returns for queries) plus `otherWeight` in its
 * own distinguishing `otherDim`. cosine-similarity to a pure `oneHot(mainDim)`
 * query is `mainWeight / sqrt(mainWeight^2 + otherWeight^2)` — always > 0 (so
 * it clears `recall-cold.ts`'s `minSimilarity: 0.1` HNSW candidate floor,
 * unlike a fully orthogonal one-hot vector, which gets dropped from the
 * candidate set entirely before scoring even runs) while still being
 * strictly less similar than a perfect match.
 */
function blended(
  mainDim: number,
  mainWeight: number,
  otherDim: number,
  otherWeight: number
): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[mainDim] = mainWeight;
  v[otherDim] = otherWeight;
  return v;
}

/**
 * Creates a fact with a precomputed vector directly via the storage/vector
 * ports (the same two calls `remember()`'s "happy path" makes — Step 1
 * `createFact`, Step 6a synchronous `vector.upsert`), bypassing HTTP
 * `POST /remember`.
 *
 * Why: `POST /remember` → `core/src/cognitive/remember.ts` synchronously
 * awaits `storage.appendAuditEntry` for its audit-chain entry, which runs
 * `SELECT merkle_hash FROM mnemo_audit_log ... FOR UPDATE`. Postgres
 * requires UPDATE privilege (not just SELECT) to take a row lock via
 * `FOR UPDATE`, but the real `mnemo_app_role` used in production
 * (`docker/docker-compose.prod.yml`: `DATABASE_URL_PROD=postgres://mnemo_app@...`)
 * only has SELECT+INSERT on `mnemo_audit_log` — UPDATE/DELETE/TRUNCATE are
 * intentionally revoked (S3, append-only enforcement,
 * `packages/adapter-postgres/migrations/baseline/0001_v3_complete_baseline.sql:5911`).
 * So `POST /remember` 500s under the real least-privilege role — a real
 * gap, but in `memory_remember`'s own contract, not `memory_search`'s; out
 * of scope for this audit. This helper sidesteps it for fixture setup so
 * the actual system under test here (`POST /recall`, under the SAME
 * real non-superuser role) stays honest.
 */
async function rememberWithVector(statement: string, vector: number[]): Promise<string> {
  const fact = await v3Storage.createFact({
    workspaceId: WS,
    scope: "global",
    statement,
    subject: "workspace",
    kind: "other",
    embedding: vector,
  });
  await v3Vector.upsert(fact.id, new Float32Array(vector), {
    kind: "fact",
    model: "fake-model",
    workspaceId: WS,
  });
  return fact.id;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");
  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });

  // Real non-superuser, non-BYPASSRLS application role — same discipline as
  // purge-facts-hard-delete.integration.test.ts / doctor-nonsuperuser.integration.test.ts.
  await admin.unsafe(`
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_ROLE};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_ROLE};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO ${APP_ROLE};
  `);

  await admin`
    INSERT INTO mnemosyne.mnemo_tenant (id, name) VALUES (${TENANT_ID}, ${"Search contract tenant"})
  `;
  await admin`
    INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id)
    VALUES (${WS}, ${"Search contract workspace"}, ${"search-contract"}, ${TENANT_ID})
  `;

  const hash = await bcrypt.hash(KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_search_scope"}, ${WS}, ${hash}, ${"search-scope"}, ${"search-scope"},
       ARRAY['memory:read','memory:write']::text[])
  `;

  const appUrl = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${PG_DB}`;
  const coreMod = await import("@mnemo-ai/core");
  const apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  apiKeyLookupClose = apiKeys.close;

  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);

  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appUrl);
  v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
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

  // Deterministic fake embedder: `embedSingle` (used ONLY for the recall
  // query, recall-cold.ts Stage 1) ALWAYS returns the same fixed vector
  // (one-hot at dim 0), regardless of input text. This is deliberate: it
  // lets us control, by construction, which stored fact is "the
  // conceptually closest one" independent of what the query literally
  // says, isolating vector-similarity ranking from keyword ranking.
  //
  // `embed` (batch) deliberately THROWS instead of also returning a
  // constant vector. recall-cold.ts also calls `ctx.embed.embed()` for two
  // unrelated post-processing steps that re-embed each hit's CONTENT text:
  // §17 near-duplicate suppression (`dedupByContent`, cosine > 0.88) and
  // the RecMem recurrence-signal precompute. A constant embedder would make
  // every hit's content vector identical (cosine 1.0 to every other hit),
  // which `dedupByContent` would then — correctly, given that fake input —
  // collapse down to a single "duplicate" survivor, silently eating
  // `distractor`/`other` in the ranking-comparison tests below even though
  // they are perfectly good, independent candidates. That would be a test
  // artifact of the fake embedder, not a product bug. Both call sites
  // degrade gracefully on a throw (documented at recall-cold.ts:1031-1032
  // and the dedupByContent try/catch), so throwing here is the accurate way
  // to say "no real per-content embedding available" without corrupting
  // ranking via a fake collision.
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed-fixed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(): Promise<Float32Array[]> {
      throw new Error("fake-embed: batch embed not supported in this fixture");
    },
    async embedSingle() {
      return new Float32Array(oneHot(0));
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  // Matches the production "no embed adapter configured" shim exactly
  // (packages/server/src/index.ts, model:"none" branch — what a real
  // deploy looks like with no MNEMO_LLM_API_KEY set).
  const noEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "no-embed",
    model: "none",
    dimensions: DIMS,
    async embed() {
      throw new Error("NO_EMBED_ADAPTER");
    },
    async embedSingle() {
      throw new Error("NO_EMBED_ADAPTER");
    },
    async healthCheck() {
      return { status: "degraded" as const, latencyMs: 0 };
    },
  };

  const cognitiveWithEmbed = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });
  const cognitiveNoEmbed = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: noEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry: noopTelemetry,
  });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const baseDeps = {
    apiKeys,
    llm: undefined,
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  };
  appWithEmbed = createApp({
    deps: { ...baseDeps, cognitive: cognitiveWithEmbed, embedModel: "fake-model" } as ServerDeps,
    version: "search-contract-test-embed",
  });
  appNoEmbed = createApp({
    deps: { ...baseDeps, cognitive: cognitiveNoEmbed, embedModel: "none" } as ServerDeps,
    version: "search-contract-test-noembed",
  });
}, 180_000);

afterAll(async () => {
  await apiKeyLookupClose?.().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

const QUERY_TEXT = "banana rocket spaceship velocity";

// memory_search's PRE-fix request shape (kept only to prove the routing fix
// itself — memory_search no longer sends this; see search.ts's MCP-1 note).
function forcedSemanticBody(topK = 5) {
  return { query: QUERY_TEXT, topK, mode: "semantic", vectorWeight: 1.0 };
}

// memory_search's REAL, current request shape (packages/mcp/src/tools/
// search.ts, post-MCP-1-fix): mode/vectorWeight omitted entirely, resolving
// to the default "auto" mode.
function autoBody(topK = 5) {
  return { query: QUERY_TEXT, topK };
}

describe("MCP-1 routing fix (2026-07-29) — mode/vectorWeight now genuinely reach the ranking pipeline", () => {
  it("mode:'lexical' forces pure-FTS ranking even WITH an embedder configured — proves mode is no longer dropped", async () => {
    const close = await rememberWithVector(
      "Migratory elephants cross the Serengeti every dry season (lexical-mode fixture)",
      oneHot(0)
    );
    const distractor = await rememberWithVector(
      "banana rocket spaceship velocity banana rocket spaceship velocity lexical-mode keyword fixture",
      blended(0, 0.5, 3, 0.5)
    );

    // includeLowWorth:true because both fixtures are brand-new (worth
    // exactly 0.5) and ftsCandidates' worth-gate (worth > 0.5, see the
    // "FINDING" test in Scenario 2 below) has no "untested" exemption,
    // unlike the vector path — orthogonal to what's under test here (mode
    // routing), so bypassed rather than worked around.
    const res = await appWithEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: QUERY_TEXT, topK: 10, mode: "lexical", includeLowWorth: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ id: string; score: number }>;
      debug?: { searchMode?: string };
    };

    // Pre-fix, this route only ever reported "auto" or "fts" — "lexical" was
    // unreachable via HTTP because the field was dropped before parsing.
    expect(body.debug?.searchMode).toBe("lexical");
    const ids = body.hits.map((h) => h.id);
    // The keyword-stuffed fact matches the tsquery and is returned...
    expect(ids).toContain(distractor);
    // ...but `close` shares ZERO keywords with the query, so real FTS
    // (`WHERE text_lemmatized @@ plainto_tsquery(...)`, RecallRepository.
    // ftsCandidates) never returns it as a candidate at all — even though
    // it's the top vector hit (see Scenario 1 below). This is the sharpest
    // possible proof that mode:"lexical" genuinely bypassed the vector
    // cascade rather than silently falling back to it: a fact invisible to
    // keyword search but #1 by cosine similarity is completely absent here.
    expect(ids).not.toContain(close);
  });

  it("mode:'semantic' with NO embedder configured is refused (503 semantic_search_unavailable) instead of silently falling back — strict semantic is genuinely enforced end-to-end", async () => {
    const res = await appNoEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(forcedSemanticBody()),
    });
    // Pre-fix, `mode` never reached recallCold, so this exact body always
    // resolved to "auto" and returned 200 with an FTS fallback. Post-fix,
    // strict "semantic" genuinely reaches recallCold's B5.9 guard, which has
    // no silent fallback by design. The typed error is a retryable 503
    // (WP-3 SemanticSearchUnavailableError, mapped by toErrorBody); it was an
    // opaque 500 before the integration of the eval fixes.
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error).toMatchObject({ code: "semantic_search_unavailable", retryable: true });
  });

  it("a 'semantic'-forced call and memory_search's real auto-mode call produce IDENTICAL ranking when an embedder IS configured — the tool's decision to omit mode/vectorWeight costs nothing", async () => {
    const close = await rememberWithVector(
      "Migratory elephants cross the Serengeti every dry season (parity fixture)",
      oneHot(0)
    );
    const distractor = await rememberWithVector(
      "banana rocket spaceship velocity banana rocket spaceship velocity parity keyword fixture",
      blended(0, 0.5, 3, 0.5)
    );

    const forced = await appWithEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(forcedSemanticBody()),
    });
    expect(forced.status).toBe(200);
    const forcedBody = (await forced.json()) as {
      hits: Array<{ id: string; score: number }>;
      debug?: { searchMode?: string };
    };

    const auto = await appWithEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(autoBody()),
    });
    expect(auto.status).toBe(200);
    const autoRespBody = (await auto.json()) as {
      hits: Array<{ id: string; score: number }>;
      debug?: { searchMode?: string };
    };

    // The labels now correctly differ (proving mode really is threaded
    // through)...
    expect(forcedBody.debug?.searchMode).toBe("semantic");
    expect(autoRespBody.debug?.searchMode).toBe("auto");
    // ...but ranking/scores are identical, since both traverse the same
    // vector cascade when an embedder is available.
    expect(forcedBody.hits.map((h) => h.id)).toEqual(autoRespBody.hits.map((h) => h.id));
    expect(forcedBody.hits.map((h) => h.score)).toEqual(autoRespBody.hits.map((h) => h.score));

    const ids = forcedBody.hits.map((h) => h.id);
    expect(ids).toContain(close);
    expect(ids).toContain(distractor);
  });
});

describe("memory_search — Scenario 1: ranks by vector similarity, not keyword overlap (embedder configured)", () => {
  it("a vector-close-but-keyword-unrelated fact outranks a keyword-stuffed-but-vector-distant fact", async () => {
    const close = await rememberWithVector(
      "Migratory elephants cross the Serengeti every dry season (vector-close fixture)",
      oneHot(0)
    );
    // cosine(query, distractor) = 0.5/sqrt(0.5^2+0.5^2) ≈ 0.707 — clears the
    // minSimilarity:0.1 HNSW floor (a fully orthogonal one-hot vector would
    // be dropped from the candidate set before scoring ever runs) but is
    // still strictly less similar than `close`'s perfect match.
    const distractor = await rememberWithVector(
      "banana rocket spaceship velocity banana rocket spaceship velocity keyword-stuffed fixture",
      blended(0, 0.5, 3, 0.5)
    );
    // cosine(query, other) = 0.2/sqrt(0.2^2+0.8^2) ≈ 0.243 — weakest but still > 0.1.
    const other = await rememberWithVector(
      "Quarterly revenue report is due next Friday afternoon (unrelated fixture)",
      blended(0, 0.2, 4, 0.8)
    );

    const res = await appWithEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(autoBody(10)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; score: number }> };

    const byId = new Map(body.hits.map((h) => [h.id, h.score]));
    expect(byId.has(close)).toBe(true);
    expect(byId.has(distractor)).toBe(true);
    expect(byId.has(other)).toBe(true);

    // The query embeds to the SAME vector as `close` (oneHot(0), by
    // construction of the fake embedder) and is only partially aligned with
    // `distractor`/`other` — despite `distractor` sharing every keyword with
    // the query text and `close` sharing none. Earlier `it` blocks in this
    // file share the same workspace/DB and may also place same-scored
    // fixtures ahead in a global top-hit tie, so assert relative order
    // among just this test's 3 candidates rather than global hits[0].
    expect(byId.get(close)!).toBeGreaterThan(byId.get(distractor)!);
    expect(byId.get(distractor)!).toBeGreaterThan(byId.get(other)!);
  });
});

describe("memory_search — Scenario 2: FTS fallback engages and is useful (no embedder configured)", () => {
  it("does NOT error (200, not 501) and reports debug.searchMode:'fts'", async () => {
    await rememberWithVector(
      "Migratory elephants cross the Serengeti (fts-no-error fixture)",
      oneHot(0)
    );

    const res = await appNoEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(autoBody()),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; debug?: { searchMode?: string } };
    expect(body.debug?.searchMode).toBe("fts");
  });

  it("a brand-new, never-recalled fact that matches every query keyword IS visible via memory_search's real FTS-fallback call (RECALL-WORTH-1 fix, PR #192)", async () => {
    // Fresh facts get worth_alpha=worth_beta=2.0 (Beta(2,2) neutral prior) →
    // worth = exactly 0.5. The vector-search path (recall-cold.ts's main
    // branch) exempts such untested facts from the worth gate via
    // `isUntested` (see passesWorthGate() in core/src/cognitive/worth.ts).
    // `ftsCandidates`'s SQL (adapter-postgres RecallRepository.ftsCandidates,
    // gated by `candidateConditions()`) used to have NO such exemption — it
    // applied `worth > 0.5 AND wilson_lower_bound >= 0.3` unconditionally
    // whenever `includeLowWorth !== true`, and `memory_search` never sends
    // `includeLowWorth` (its schema doesn't expose that field at all), so a
    // brand-new fact was unconditionally invisible to it via the FTS
    // fallback path — see docs/STATUS.md's `memory_search` row (2026-07-28)
    // and packages/adapter-postgres/src/repositories/RecallRepository.ts's
    // `candidateConditions()`, fixed in PR #192 to mirror the same
    // `isUntested` exemption in SQL.
    const distractor = await rememberWithVector(
      "banana rocket spaceship velocity banana rocket spaceship velocity worth-gate finding fixture",
      oneHot(1)
    );

    const searchLikeRes = await appNoEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify(autoBody(10)), // exactly what memory_search sends — no includeLowWorth
    });
    expect(searchLikeRes.status).toBe(200);
    const autoRespBody_ = (await searchLikeRes.json()) as {
      hits: Array<{ id: string }>;
      debug?: { searchMode?: string };
    };
    expect(autoRespBody_.debug?.searchMode).toBe("fts");
    // The fact is a complete keyword match and is present, with no
    // includeLowWorth workaround needed.
    expect(autoRespBody_.hits.map((h) => h.id)).toContain(distractor);

    // Still visible with includeLowWorth:true too — the exemption doesn't
    // regress the explicit opt-in path.
    const withIncludeLowWorth = await appNoEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ ...autoBody(10), includeLowWorth: true }),
    });
    expect(withIncludeLowWorth.status).toBe(200);
    const withIncludeLowWorthBody = (await withIncludeLowWorth.json()) as {
      hits: Array<{ id: string }>;
    };
    expect(withIncludeLowWorthBody.hits.map((h) => h.id)).toContain(distractor);
  });

  it("ranks by real ts_rank over text_lemmatized once the worth gate is bypassed — the keyword-stuffed fact outranks the vector-only-close one (inverse of Scenario 1), proving FTS is genuinely engaged, not a stub", async () => {
    const close = await rememberWithVector(
      "Migratory elephants cross the Serengeti every dry season (fts-inverse fixture)",
      oneHot(0)
    );
    const distractor = await rememberWithVector(
      "banana rocket spaceship velocity banana rocket spaceship velocity fts-inverse keyword fixture",
      oneHot(1)
    );

    // includeLowWorth:true here ONLY to get both brand-new fixtures past the
    // worth gate proven absent above — orthogonal to what's under test in
    // THIS assertion (ts_rank ordering), which does not depend on worth.
    const res = await appNoEmbed.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ ...autoBody(10), includeLowWorth: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ id: string; score: number }>;
      debug?: { searchMode?: string };
    };

    expect(body.debug?.searchMode).toBe("fts");
    const ids = body.hits.map((h) => h.id);
    expect(ids).toContain(distractor);
    // The keyword-stuffed fact must rank strictly above the vector-only-close
    // fact under FTS — vector similarity cannot influence ranking here since
    // no embedder is configured (embed.embedSingle would throw if called).
    const distractorIdx = ids.indexOf(distractor);
    const closeIdx = ids.indexOf(close);
    expect(distractorIdx).toBeGreaterThanOrEqual(0);
    if (closeIdx >= 0) {
      expect(distractorIdx).toBeLessThan(closeIdx);
    }
  });
});
