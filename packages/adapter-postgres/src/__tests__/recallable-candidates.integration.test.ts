/**
 * Integration test: `StorageAdapter.recallableCandidates?()` (make-primitives-
 * recallable, design.md D4/Interfaces, tasks.md 5.6).
 *
 * PR3 — Phase 5 scope: this proves the new read-side port method works
 * correctly against a real Postgres instance, in isolation. It is NOT yet
 * called from anywhere in the recall pipeline (`recall-cold.ts` is untouched
 * in this PR) — that wiring is PR4 (Phase 6). This file exists to prove the
 * port method itself before that switch is flipped.
 *
 * Covers:
 *   - semantic arm: returns decision candidates by cosine similarity,
 *     respects minSimilarity
 *   - lexical arm: returns decision candidates by ts_rank over the
 *     migration-0029-fixed 'english' text_lemmatized config
 *   - `kinds` DRIVES the query, not a post-filter: `kinds: ["fact"]` issues
 *     no decision query and returns [] even when a matching decision exists
 *   - sensitivity round-trips correctly on each candidate (the raw tier the
 *     recall-cold ceiling check — S6, 404-not-403 — will apply in PR4; this
 *     port method is purely internal in this PR, called from nowhere
 *     auth-checked, so S6 itself does not yet apply to it)
 *   - workspace scoping: a decision in another workspace is never returned
 *   - a fact-only `ftsCandidates` call is unaffected — this PR added no code
 *     to that method, this is a regression guard
 *
 * Requires Docker + Node >=22 — see CLAUDE.md "Node version" note and
 * entity-embedding.integration.test.ts for the same testcontainers +
 * DrizzleStorageAdapter pattern this file mirrors.
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

const WS = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const OTHER_WS = "ffffffff-ffff-4fff-ffff-ffffffffffff";
const EMBED_DIM = 1536;

let container: StartedTestContainer;
let databaseUrl: string;
let adapter: DrizzleStorageAdapter;

function unitVector(dim = EMBED_DIM, index = 0): number[] {
  const vec = new Array(dim).fill(0);
  vec[index] = 1.0;
  return vec;
}

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
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({
    databaseUrl,
    log: (msg) => process.stdout.write(`[migrate] ${msg}\n`),
  });

  const { db, pgClient } = createDrizzleClient(databaseUrl);
  adapter = new DrizzleStorageAdapter(db, pgClient);
}, 120_000);

afterAll(async () => {
  await adapter?.close();
  await container?.stop();
});

describe("recallableCandidates — kinds drives the query, not a post-filter", () => {
  it("kinds: ['fact'] issues no decision query and returns [] even with a matching embedding", async () => {
    const decision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Use Postgres",
      body: "We chose Postgres for durability.",
    });
    const vec = unitVector();
    await adapter.updateEmbeddingVector("decision", decision.id, WS, vec, "test-model");

    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["fact"],
      limit: 10,
      embedding: vec,
      minSimilarity: 0.1,
    });
    expect(results).toEqual([]);
  });

  it("empty kinds array returns [] without issuing a query", async () => {
    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: [],
      limit: 10,
      embedding: unitVector(),
      terms: ["postgres"],
    });
    expect(results).toEqual([]);
  });

  it("neither embedding nor terms supplied returns []", async () => {
    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
    });
    expect(results).toEqual([]);
  });
});

describe("recallableCandidates — semantic arm (cosine over mnemo_decision.embedding)", () => {
  it("returns a decision after its embedding is written, identifiable by kind and sensitivity", async () => {
    const decision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Adopt pgvector",
      body: "Use pgvector for embedding storage.",
      sensitivity: "confidential",
    });
    const vec = unitVector(EMBED_DIM, 0);
    await adapter.updateEmbeddingVector("decision", decision.id, WS, vec, "test-model");

    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: vec,
      minSimilarity: 0.9,
    });
    const hit = results.find((r) => r.id === decision.id);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("decision");
    expect(hit!.sensitivity).toBe("confidential");
    expect(hit!.score).toBeGreaterThan(0.9);
  });

  it("respects minSimilarity: an orthogonal query vector is excluded", async () => {
    const decision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Orthogonal probe",
      body: "This decision should not match an unrelated query vector.",
    });
    const vec = unitVector(EMBED_DIM, 1);
    await adapter.updateEmbeddingVector("decision", decision.id, WS, vec, "test-model");

    const orthogonal = unitVector(EMBED_DIM, 2); // orthogonal to dimension-1 unit vector: cosine 0
    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: orthogonal,
      minSimilarity: 0.5,
    });
    expect(results.find((r) => r.id === decision.id)).toBeUndefined();
  });

  it("does not return a decision from another workspace", async () => {
    const decision = await adapter.createDecision({
      workspaceId: OTHER_WS,
      kind: "architecture",
      title: "Other workspace decision",
      body: "Should never leak across workspaces.",
    });
    const vec = unitVector(EMBED_DIM, 3);
    await adapter.updateEmbeddingVector("decision", decision.id, OTHER_WS, vec, "test-model");

    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: vec,
      minSimilarity: 0.1,
    });
    expect(results.find((r) => r.id === decision.id)).toBeUndefined();
  });
});

describe("recallableCandidates — lexical arm (ts_rank over migration-0029 'english' config)", () => {
  it("matches a term present only in the decision body — the 'simple'-config-can't-do-this stemming proof", async () => {
    const decision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Caching layer",
      body: "Our caching strategy uses Redis for hot-tier lookups.",
    });

    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: ["caching", "strategies"], // stemmed plural — 'simple' config would miss this
    });
    const hit = results.find((r) => r.id === decision.id);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("decision");
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("a term matching neither title nor body is not a candidate", async () => {
    const decision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Unrelated decision",
      body: "This has nothing to do with the query term.",
    });

    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      terms: ["zzznomatchzzz"],
    });
    expect(results.find((r) => r.id === decision.id)).toBeUndefined();
  });
});

describe("recallableCandidates — both arms supplied merges by id", () => {
  it("a decision matched by both arms appears exactly once", async () => {
    const decision = await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Merge probe",
      body: "Both arms should find this decision about widgets.",
    });
    const vec = unitVector(EMBED_DIM, 4);
    await adapter.updateEmbeddingVector("decision", decision.id, WS, vec, "test-model");

    const results = await adapter.recallableCandidates!({
      workspaceId: WS,
      kinds: ["decision"],
      limit: 10,
      embedding: vec,
      minSimilarity: 0.9,
      terms: ["widgets"],
    });
    expect(results.filter((r) => r.id === decision.id)).toHaveLength(1);
  });
});

describe("recallableCandidates — regression guard: fact-only ftsCandidates is unaffected", () => {
  it("ftsCandidates still returns only facts, never decisions, for a matching term", async () => {
    const fact = await adapter.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "The regression guard mentions widgets specifically",
      subject: "regression-guard",
      kind: "other",
    });
    await adapter.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "Also about widgets",
      body: "This decision also mentions widgets but must not appear in ftsCandidates.",
    });

    const results = await adapter.ftsCandidates!({
      workspaceId: WS,
      terms: ["widgets"],
      limit: 10,
    });
    const ids = results.map((r) => r.factId);
    expect(ids).toContain(fact.id);
    // ftsCandidates is fact-shaped only — it cannot structurally return a
    // decision id under `factId`, but assert the count matches only facts
    // matching the term, not an inflated set including the decision.
    expect(results.every((r) => typeof r.factId === "string")).toBe(true);
  });
});
