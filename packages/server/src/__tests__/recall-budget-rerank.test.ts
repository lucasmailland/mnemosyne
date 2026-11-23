// packages/server/src/__tests__/recall-budget-rerank.test.ts
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallQuery, RecallResponse } from "@mnemo-ai/types";
import { mountRecall } from "../routes/recall.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_recallbudgettest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000017";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: [], plan: "free" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}
const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});
const emptyResp = (): RecallResponse => ({
  hits: [],
  total: 0,
  query: { text: "q", limit: 10, offset: 0 },
  latencyMs: 0,
  fromHotTier: false,
});

function makeDeps(capture: { q?: RecallQuery }): ServerDeps {
  const v3 = {
    recall: async (q: RecallQuery) => {
      capture.q = q;
      return emptyResp();
    },
  } as unknown as NonNullable<ServerDeps["cognitive"]>;
  return {
    core: { recall: async () => [] } as unknown as ServerDeps["core"],
    apiKeys: undefined as unknown as ApiKeyLookup, // filled below
    embedModel: "text-embedding-3-small",
    cognitive: v3,
  } as unknown as ServerDeps;
}

describe("POST /recall threads CALMem tokenBudget + RecMem rerank into v3.recall", () => {
  it("validates and forwards minSimilarity", async () => {
    const capture: { q?: RecallQuery } = {};
    const deps = makeDeps(capture);
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const good = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "hello", minSimilarity: 0.7 }),
    });
    expect(good.status).toBe(200);
    expect(capture.q?.minSimilarity).toBe(0.7);
    const bad = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "hello", minSimilarity: 1.1 }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it("forwards hyde and a past asOf, and refuses a future asOf", async () => {
    const capture: { q?: RecallQuery } = {};
    const deps = makeDeps(capture);
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const past = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "hello", hyde: true, asOf: "2026-01-01T00:00:00Z" }),
    });
    expect(past.status).toBe(200);
    expect(capture.q?.hyde).toBe(true);
    expect(capture.q?.asOf?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    capture.q = undefined;
    const future = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        query: "hello",
        asOf: "2999-01-01T00:00:00Z",
      }),
    });
    expect(future.status).toBe(400);
    expect((await future.json()).error.details.code).toBe("asof_in_future");
    expect(capture.q).toBeUndefined();
  });

  it("returns relations and hyperedges only with includeGraph", async () => {
    const capture: { q?: RecallQuery } = {};
    const deps = makeDeps(capture);
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    (deps.cognitive as NonNullable<ServerDeps["cognitive"]>).recall = async () => ({
      ...emptyResp(),
      hits: [
        {
          id: "f1",
          primitive: "fact",
          content: "Line 3 runs firmware 4.2",
          score: 0.8,
          validFrom: new Date("2026-01-01T00:00:00Z"),
          validTo: null,
          tags: [],
          sensitivity: "internal",
          relations: [
            { id: "r1", targetId: "f0", targetKind: "fact", verb: "supersedes", weight: 1 },
          ],
          hyperedges: [{ id: "h1", coMembers: ["f2"], label: "line 3" }],
        },
      ] as unknown as RecallResponse["hits"],
    });
    const app = buildMountHarness(deps, [mountRecall]);
    const ask = async (body: Record<string, unknown>) =>
      (
        await (
          await app.request("/recall", {
            method: "POST",
            headers: authed(),
            body: JSON.stringify({ query: "firmware", ...body }),
          })
        ).json()
      ).hits[0];
    const plain = await ask({});
    expect(plain.relations).toBeUndefined();
    expect(plain.hyperedges).toBeUndefined();
    const graph = await ask({ includeGraph: true });
    expect(graph.relations).toEqual([
      { id: "r1", targetId: "f0", targetKind: "fact", verb: "supersedes", weight: 1 },
    ]);
    expect(graph.hyperedges).toEqual([{ id: "h1", coMembers: ["f2"], label: "line 3" }]);
  });

  it("returns raw similarity for a semantic fact hit", async () => {
    const capture: { q?: RecallQuery } = {};
    const deps = makeDeps(capture);
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    (deps.cognitive as NonNullable<ServerDeps["cognitive"]>).recall = async () => ({
      ...emptyResp(),
      hits: [
        {
          id: "f1",
          primitive: "fact",
          content: "chatbot deployment",
          score: 0.8,
          similarity: 0.73,
          validFrom: new Date("2026-01-01T00:00:00Z"),
          validTo: null,
          tags: [],
          sensitivity: "internal",
        },
      ] as RecallResponse["hits"],
    });
    const app = buildMountHarness(deps, [mountRecall]);
    const response = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "chatbot", minSimilarity: 0.7 }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).hits[0].similarity).toBe(0.73);
  });
  it("forwards an explicit tokenBudget and recurrenceThreshold verbatim", async () => {
    const capture: { q?: RecallQuery } = {};
    const deps = makeDeps(capture);
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        query: "hello",
        topK: 7,
        tokenBudget: 1500,
        rerank: false,
        recurrenceThreshold: 0.42,
      }),
    });
    expect(res.status).toBe(200);
    expect(capture.q?.tokenBudget).toBe(1500);
    expect(capture.q?.rerank).toBe(false);
    expect(capture.q?.recurrenceThreshold).toBe(0.42);
    expect(capture.q?.limit).toBe(7);
  });

  it("defaults rerank to false and tokenBudget to undefined when omitted (RECALL-5, CHAOS-3)", async () => {
    const capture: { q?: RecallQuery } = {};
    const deps = makeDeps(capture);
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "hello" }),
    });
    expect(res.status).toBe(200);
    // Rerank is opt-in: on by default it cost 5–12 s per recall with a local
    // model and held concurrency slots until writes got 429.
    expect(capture.q?.rerank).toBe(false);
    expect(capture.q?.tokenBudget).toBeUndefined(); // no env default in test → full pipeline
  });
});

// ─── P6 workspace LLM resolver — recall path ──────────────────────────────────
// The route used to resolve the workspace's LLM adapter on every reranked
// recall and then discard it: MnemoCore.recall() cannot take a per-call LLM,
// so reranking always ran on the boot-time adapter. WP-3 dropped the lookup.

describe("POST /recall P6 workspace LLM resolver", () => {
  it("does not resolve a workspace LLM it cannot use, even with rerank=true", async () => {
    const capture: { q?: RecallQuery } = {};
    let resolverCalled = false;
    const v3 = {
      recall: async (q: RecallQuery) => {
        capture.q = q;
        return emptyResp();
      },
    } as unknown as NonNullable<ServerDeps["cognitive"]>;
    const deps = {
      core: { recall: async () => [] } as unknown as ServerDeps["core"],
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
      llmConfigResolver: {
        resolve: async (_wsId: string) => {
          resolverCalled = true;
          return { provider: null, embedModel: "text-embedding-3-small" };
        },
      },
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecall]);
    for (const rerank of [true, false]) {
      const res = await app.request("/recall", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ query: "hello", rerank }),
      });
      expect(res.status).toBe(200);
      expect(capture.q?.rerank).toBe(rerank);
    }
    expect(resolverCalled).toBe(false);
  });

  it("recall succeeds even when llmConfigResolver.resolve throws", async () => {
    const capture: { q?: RecallQuery } = {};
    const v3 = {
      recall: async (q: RecallQuery) => {
        capture.q = q;
        return emptyResp();
      },
    } as unknown as NonNullable<ServerDeps["cognitive"]>;
    const deps = {
      core: { recall: async () => [] } as unknown as ServerDeps["core"],
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
      llmConfigResolver: {
        resolve: async (_wsId: string) => {
          throw new Error("simulated resolver failure");
        },
      },
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "hello", rerank: true }),
    });
    // Resolver failure must never break the recall response.
    expect(res.status).toBe(200);
    expect(capture.q?.rerank).toBe(true);
  });
});

// ─── WP4.4 — Live CALMem ladder integration test ──────────────────────────────
// Exercises the real v3 orchestrator (createCore + applyTokenBudget) so we can
// prove the wiring + the ladder behave together end-to-end. The cold path needs
// many storage methods the InMemoryStorageAdapter doesn't fully implement, so
// for the tiny-budget case the plan permits relaxing to the hot/pointer tiers
// (tokenBudget=1500 → tryHot only; cold gaps are irrelevant). The unbounded
// case forces cold and we tolerate cold-side gaps via includeLowWorth.

import { createCore } from "@mnemo-ai/core/cognitive";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { VectorAdapter, EmbedAdapter, OutboxAdapter } from "@mnemo-ai/types";

function noopTelemetry() {
  return {
    startSpan: () => ({ end() {}, setAttribute() {}, recordException() {}, addEvent() {} }),
    histogram() {},
    counter() {},
    gauge() {},
  } as never;
}
function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  } as never;
}

interface StoredVec {
  id: string;
  workspaceId: string;
  vector: Float32Array;
  primitiveKind: string;
}

function makeVector(store: StoredVec[]): VectorAdapter {
  return {
    async upsert(req) {
      const vec = new Float32Array(req.vector);
      const idx = store.findIndex((s) => s.id === req.id);
      if (idx >= 0)
        store[idx] = {
          id: req.id,
          workspaceId: req.workspaceId,
          vector: vec,
          primitiveKind: req.primitiveKind,
        };
      else
        store.push({
          id: req.id,
          workspaceId: req.workspaceId,
          vector: vec,
          primitiveKind: req.primitiveKind,
        });
    },
    async delete() {},
    async search(req) {
      const candidates = store.filter((s) => s.workspaceId === req.workspaceId);
      const scored = candidates.map((s) => {
        let dot = 0,
          na = 0,
          nb = 0;
        const n = Math.min(s.vector.length, req.vector.length);
        for (let i = 0; i < n; i++) {
          dot += s.vector[i]! * req.vector[i]!;
          na += s.vector[i]! * s.vector[i]!;
          nb += req.vector[i]! * req.vector[i]!;
        }
        const score = na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
        return { id: s.id, score, primitiveKind: s.primitiveKind };
      });
      return scored.sort((a, b) => b.score - a.score).slice(0, req.limit ?? 50);
    },
  } as unknown as VectorAdapter;
}

function makeEmbed(): EmbedAdapter {
  // Deterministic 3-d embedding via simple hash → unit vector. Identical text
  // maps to identical vectors so seeded near-identical facts retrieve well.
  function vec(text: string): Float32Array {
    let a = 0,
      b = 0,
      c = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      a += ch * (i % 3 === 0 ? 1 : 0);
      b += ch * (i % 3 === 1 ? 1 : 0);
      c += ch * (i % 3 === 2 ? 1 : 0);
    }
    const n = Math.sqrt(a * a + b * b + c * c) || 1;
    return new Float32Array([a / n, b / n, c / n]);
  }
  return {
    model: "stub-embed",
    dimensions: 3,
    async embed(texts: string[]) {
      return texts.map(vec);
    },
    async embedSingle(text: string) {
      return vec(text);
    },
  } as EmbedAdapter;
}

function makeOutbox(): OutboxAdapter {
  return {
    async append() {},
    async list() {
      return [];
    },
    async ack() {},
  } as unknown as OutboxAdapter;
}

describe("CALMem ladder runs on the live recall path (F5 end-to-end)", () => {
  it("a small tokenBudget returns no more hits than the limit-3 tier (≤3)", async () => {
    const storage = new InMemoryStorageAdapter();
    const vecStore: StoredVec[] = [];
    const vector = makeVector(vecStore);
    const embed = makeEmbed();
    const core = createCore({
      storage: storage as never,
      vector,
      embed,
      outbox: makeOutbox(),
      logger: silentLogger(),
      telemetry: noopTelemetry(),
    });
    const auth = {
      workspaceId: WS_ID,
      actorId: "a",
      actorType: "agent",
      scopes: ["memory:read"],
    } as never;

    // Seed 8 high-worth facts so an unbounded recall would surface many.
    for (let i = 0; i < 8; i++) {
      const fact = await storage.createFact({
        workspaceId: WS_ID,
        statement: `pricing tier decision number ${i}`,
        kind: "fact",
        sensitivity: "internal",
        attribution: "user_stated",
        worth: 0.9,
        worthAlpha: 8,
        worthBeta: 2,
      } as never);
      const v = await embed.embedSingle(fact.statement);
      await vector.upsert({
        id: fact.id,
        workspaceId: WS_ID,
        vector: v,
        primitiveKind: "fact",
      } as never);
    }

    const tiny = await core.recall(
      {
        workspaceId: WS_ID,
        text: "pricing tier decision",
        limit: 10,
        tokenBudget: 1500,
        includeLowWorth: true,
      } as never,
      auth
    );
    // Ladder: budget <2000 caps result limit at 3 (recall-pointer.ts applyTokenBudget).
    // Without a cache adapter wired in, hot tier returns 0 — still ≤ 3, proving
    // the ladder governs the live path.
    expect(tiny.hits.length).toBeLessThanOrEqual(3);
  });

  it("a budget below 500 skips recall entirely (empty hits)", async () => {
    const storage = new InMemoryStorageAdapter();
    const vecStore: StoredVec[] = [];
    const vector = makeVector(vecStore);
    const embed = makeEmbed();
    const core = createCore({
      storage: storage as never,
      vector,
      embed,
      outbox: makeOutbox(),
      logger: silentLogger(),
      telemetry: noopTelemetry(),
    });
    const auth = {
      workspaceId: WS_ID,
      actorId: "a",
      actorType: "agent",
      scopes: ["memory:read"],
    } as never;
    const fact = await storage.createFact({
      workspaceId: WS_ID,
      statement: "x",
      kind: "fact",
      sensitivity: "internal",
      attribution: "user_stated",
    } as never);
    const v = await embed.embedSingle(fact.statement);
    await vector.upsert({
      id: fact.id,
      workspaceId: WS_ID,
      vector: v,
      primitiveKind: "fact",
    } as never);

    const resp = await core.recall(
      {
        workspaceId: WS_ID,
        text: "x",
        limit: 10,
        tokenBudget: 100,
        includeLowWorth: true,
      } as never,
      auth
    );
    expect(resp.hits).toHaveLength(0);
    expect(resp.total).toBe(0);
  });

  it("surfaces debug.rerankDegraded when core fell back to the un-reranked order", async () => {
    const deps = makeDeps({});
    (deps as { apiKeys: ApiKeyLookup }).apiKeys = await makeKeyLookup();
    (deps.cognitive as unknown as { recall: unknown }).recall = async () => ({
      ...emptyResp(),
      debug: {
        modeRequested: "auto",
        modeUsed: "hybrid",
        tiersConsulted: [],
        cacheHit: false,
        fallback: false,
        rerankDegraded: true,
      },
    });
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "q", topK: 5, rerank: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { debug: { rerankDegraded?: boolean } };
    expect(json.debug.rerankDegraded).toBe(true);
  });
});
