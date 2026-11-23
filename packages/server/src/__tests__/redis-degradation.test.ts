/**
 * §9 Degradation ladder — spec MEMORY_MODEL.md lines 801-803.
 *
 * When Redis is down:
 *   - Session-mutating ops (POST /session/*) → 503 {error:"redis_unavailable"}
 *   - Recall (POST /recall) → 200 (works on L3+L4)
 *   - Other routes (GET facts, etc.) → unaffected
 *
 * No real Redis connection is needed — we inject a fake CacheAdapter whose
 * healthCheck returns {status:"down"}.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { IdempotencyStore } from "../idempotency.js";
import type { CacheAdapter, CacheCapabilities, HealthStatus } from "@mnemo-ai/types";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAINTEXT_KEY = "mns_live_degradationtest00000001";
const WS_ID = "00000000-0000-0000-0000-000000000024";

// ─── Fake CacheAdapter ────────────────────────────────────────────────────────

function makeCache(status: "ok" | "down"): CacheAdapter {
  return {
    id: "fake-cache-" + status,
    capabilities: {
      sortedSets: false,
      pubSub: false,
      patterns: false,
      atomic: false,
      hashes: false,
    } satisfies CacheCapabilities,
    async get() {
      return null;
    },
    async set() {},
    async delete() {},
    async deletePattern() {
      return 0;
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status, latencyMs: 0 };
    },
    async close() {},
  };
}

// ─── Minimal CoreLike stub ─────────────────────────────────────────────────────

function makeCoreDeps() {
  return {
    recall: async () => [],
    createFact: async () => ({
      id: "f1",
      workspaceId: WS_ID,
      content: "stub",
      attribution: {},
      tags: [],
      pinned: false,
      validFrom: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
      validTo: null,
      createdAt: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
    }),
    getFact: async () => null,
    pinFact: async () => null,
    closeFact: async () => false,
    timeline: async () => ({ events: [], nextCursor: null }),
    vitals: async () => ({
      workspaceId: WS_ID,
      factsLive: 0,
      factsClosed: 0,
      pinnedCount: 0,
      lastRecallAt: null,
      lastWriteAt: null,
      embeddings: { indexed: 0, pending: 0 },
    }),
    graph: async () => ({
      nodes: [],
      edges: [],
      meta: { entityCount: 0, episodeCount: 0, decisionCount: 0, relationCount: 0 },
    }),
    listEntities: async () => [],
    getEntity: async () => null,
    listFactsForEntity: async () => null,
    listEpisodes: async () => [],
    getEpisode: async () => null,
    createEntity: async () => {
      throw new Error("not implemented");
    },
    updateEntity: async () => null,
    entityExists: async () => false,
    listReview: async () => [],
    reviewCount: async () => 0,
    resolveReview: async () => ({
      resolved: false,
      factId: null,
      decisionId: null,
      cascaded: false,
    }),
    audit: async () => [],
    exportWorkspace: async () => ({ facts: [], decisions: [], relations: [], citations: [] }),
    restoreFact: async () => null,
    listDecisions: async () => [],
    getDecision: async () => null,
    listFacts: async () => ({ items: [], nextCursor: null, total: 0 }),
    patchFact: async () => null,
    getFactCitations: async () => null,
    createDecision: async () => {
      throw new Error("not implemented");
    },
    supersedeDecision: async () => false,
    listRelations: async () => [],
    createRelation: async () => {
      throw new Error("not implemented");
    },
    patchRelation: async () => null,
    listCitations: async () => [],
    enqueueReview: async () => ({ id: "r1", inserted: true }),
    startSession: async () => {
      throw new Error("not implemented");
    },
    appendTurn: async () => {},
    collapseSession: async () => {},
    getSessionScratch: async () => ({}),
    propagateGovernanceForSession: async () => {},
    ping: async () => {},
    close: async () => {},
  } as unknown as ServerDeps["core"];
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:write", "memory:read"] },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${PLAINTEXT_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function buildTestApp(
  cacheStatus: "ok" | "down" | "absent",
  replaceSessionScratch = vi.fn(async () => true),
  idempotencyStore?: IdempotencyStore
) {
  const lookup = await makeKeyLookup();
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    core: makeCoreDeps(),
    apiKeys: lookup,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    cognitive: makeMockCognitive(),
    // flatten-legacy-dual-core PR10: startSession/replaceSessionScratch
    // ported off deps.core onto deps.storage.
    storage: {
      createSession: async () => {
        throw new Error("not implemented");
      },
      replaceSessionScratch,
      appendAuditEntry: async () => undefined,
    },
    cache: cacheStatus === "absent" ? undefined : makeCache(cacheStatus),
    idempotencyStore,
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  return {
    app: createApp({ deps, version: "0.0.0-test" }),
    replaceSessionScratch,
  };
}

function makeUnavailableIdempotencyStore() {
  return {
    begin: vi.fn(async () => {
      throw new Error("redis idempotency unavailable");
    }),
    complete: vi.fn(async () => {}),
    recordPhase: vi.fn(async () => {}),
    getRecoveryPoint: vi.fn(async () => null),
  } satisfies IdempotencyStore;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Redis-down degradation ladder (spec lines 801-803)", () => {
  it("POST /session/start returns 503 when Redis is down", async () => {
    const { app } = await buildTestApp("down");
    const res = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ agentId: "test-agent" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("redis_unavailable");
  });

  it("POST /session/:id/turn returns 503 when Redis is down", async () => {
    const { app } = await buildTestApp("down");
    const res = await app.request("/session/some-id/turn", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ role: "user", content: "hello" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("redis_unavailable");
  });

  it("POST /session/:id/collapse returns 503 when Redis is down", async () => {
    const { app } = await buildTestApp("down");
    const res = await app.request("/session/some-id/collapse", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("redis_unavailable");
  });

  it("POST /recall still returns 200 when Redis is down", async () => {
    const { app } = await buildTestApp("down");
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "what is the deploy port", topK: 5 }),
    });
    // Recall is NOT gated on Redis — should still work (200, not 503/401)
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(401);
  });

  it("GET /facts is unaffected when Redis is down", async () => {
    const { app } = await buildTestApp("down");
    const res = await app.request("/facts", {
      method: "GET",
      headers: authed(),
    });
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(401);
  });

  it("session ops succeed when Redis is up", async () => {
    const { app } = await buildTestApp("ok");
    const res = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ agentId: "test-agent" }),
    });
    // Should NOT be 503. It may be 500 (core throws not implemented) but never 503.
    expect(res.status).not.toBe(503);
  });

  it("session ops are 503 when no cache adapter is provided", async () => {
    const { app } = await buildTestApp("absent");
    const res = await app.request("/session/start", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ agentId: "test-agent" }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("redis_unavailable");
  });

  it("bypasses unavailable Redis idempotency for exact durable scratch replacement", async () => {
    const replaceSessionScratch = vi.fn(async () => true);
    const idempotencyStore = makeUnavailableIdempotencyStore();
    const { app } = await buildTestApp("down", replaceSessionScratch, idempotencyStore);

    const res = await app.request("/session/some-id/scratch", {
      method: "POST",
      headers: authed({ "Idempotency-Key": "scratch-replacement" }),
      body: JSON.stringify({ scratch: { durable: true } }),
    });

    expect(res.status).toBe(204);
    expect(replaceSessionScratch).toHaveBeenCalledOnce();
    expect(idempotencyStore.begin).not.toHaveBeenCalled();
    expect(idempotencyStore.complete).not.toHaveBeenCalled();
    expect(idempotencyStore.recordPhase).not.toHaveBeenCalled();
    expect(idempotencyStore.getRecoveryPoint).not.toHaveBeenCalled();
  });

  it("keeps unavailable Redis idempotency fail-closed for a scratch near-match", async () => {
    const idempotencyStore = makeUnavailableIdempotencyStore();
    const { app, replaceSessionScratch } = await buildTestApp("down", undefined, idempotencyStore);

    const res = await app.request("/session/some-id/scratch/extra", {
      method: "POST",
      headers: authed({ "Idempotency-Key": "scratch-near-match" }),
      body: JSON.stringify({ scratch: {} }),
    });

    expect(res.status).toBe(500);
    expect(idempotencyStore.begin).toHaveBeenCalledOnce();
    expect(replaceSessionScratch).not.toHaveBeenCalled();
  });

  for (const cacheStatus of ["down", "absent"] as const) {
    describe(`scratch with Redis ${cacheStatus}`, () => {
      it("reaches the durable writer for the exact route", async () => {
        const replaceSessionScratch = vi.fn(async () => true);
        const { app } = await buildTestApp(cacheStatus, replaceSessionScratch);

        const res = await app.request("/session/some-id/scratch", {
          method: "POST",
          headers: authed(),
          body: JSON.stringify({ scratch: { durable: true } }),
        });

        expect(res.status).toBe(204);
        expect(replaceSessionScratch).toHaveBeenCalledWith({
          workspaceId: WS_ID,
          sessionId: "some-id",
          scratch: { durable: true },
        });
      });

      it("maps a durable writer miss to 404", async () => {
        const replaceSessionScratch = vi.fn(async () => false);
        const { app } = await buildTestApp(cacheStatus, replaceSessionScratch);

        const res = await app.request("/session/missing/scratch", {
          method: "POST",
          headers: authed({ "x-request-id": "scratch-degradation-missing" }),
          body: JSON.stringify({ scratch: { durable: true } }),
        });

        expect(res.status).toBe(404);
        expect(replaceSessionScratch).toHaveBeenCalledOnce();
      });

      it("preserves the canonical 500 when the durable writer rejects", async () => {
        const replaceSessionScratch = vi.fn(async () => {
          throw new Error("postgres down");
        });
        const { app } = await buildTestApp(cacheStatus, replaceSessionScratch);

        const res = await app.request("/session/some-id/scratch", {
          method: "POST",
          headers: authed({ "x-request-id": "scratch-degradation-error" }),
          body: JSON.stringify({ scratch: { durable: true } }),
        });

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({
          error: {
            type: "api_error",
            code: "internal_error",
            message: "Internal server error",
            retryable: false,
            request_id: "scratch-degradation-error",
          },
        });
        expect(replaceSessionScratch).toHaveBeenCalledOnce();
      });

      it.each([
        "/session/start",
        "/session/some-id/turn",
        "/session/some-id/pin",
        "/session/some-id/collapse",
        "/session/some-id/discard",
      ])("keeps %s blocked", async (path) => {
        const { app, replaceSessionScratch } = await buildTestApp(cacheStatus);

        const res = await app.request(path, {
          method: "POST",
          headers: authed(),
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(503);
        expect(replaceSessionScratch).not.toHaveBeenCalled();
      });

      it.each(["/session/some-id/scratch/", "/session/some-id/scratch/extra"])(
        "does not exempt the near-match path %s",
        async (path) => {
          const { app, replaceSessionScratch } = await buildTestApp(cacheStatus);

          const res = await app.request(path, {
            method: "POST",
            headers: authed(),
            body: JSON.stringify({ scratch: {} }),
          });

          expect(res.status).toBe(503);
          expect(replaceSessionScratch).not.toHaveBeenCalled();
        }
      );

      it("does not treat an unrelated scratch path as a session scratch mutation", async () => {
        const { app, replaceSessionScratch } = await buildTestApp(cacheStatus);

        const res = await app.request("/scratch", {
          method: "POST",
          headers: authed(),
          body: JSON.stringify({ scratch: {} }),
        });

        expect(res.status).toBe(404);
        expect(replaceSessionScratch).not.toHaveBeenCalled();
      });
    });
  }
});
