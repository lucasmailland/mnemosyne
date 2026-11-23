/**
 * B8 — hyperedge worth decay finally has a real caller
 * (docs/archive/openspec/complete-mcp-tools spec.md Requirement 7, tasks.md Phase 7).
 *
 * The TD(λ) `updateWorth("hyperedge", ...)` mechanism already exists
 * (`RecallRepository.ts:172-187`, mirrored in `InMemoryStorageAdapter`) but
 * nothing in the recall path ever called it — hyperedge `worth` was frozen
 * at its 0.5 creation default forever. `recordHyperedgeCoActivation` closes
 * that gap: fired via `setImmediate` whenever `hits.length >= 2` (originally
 * alongside a server-side co-recall STDP helper at the same call site; that
 * helper was deleted by p60-corecall-stdp-convergence — core's
 * `recordCoRecall` is now the sole co-recall STDP writer), it loads
 * the served hits' hyperedges via `getRecallStructures` and credits/debits
 * `worth` based on how many members of each hyperedge were actually served.
 *
 * These tests are RED against the pre-fix `recall.ts` (no such helper exists
 * / is never wired) and GREEN once `recordHyperedgeCoActivation` is
 * implemented and fired from the route.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallHit } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

const PLAINTEXT_KEY = "mns_live_hyperedgecoactivate0001";
const WS_ID = "00000000-0000-0000-0000-dd0000000001";

function makeHit(overrides: Partial<RecallHit> & { id: string }): RecallHit {
  return {
    primitive: "fact",
    content: `content for ${overrides.id}`,
    score: 0.9,
    sensitivity: "public",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date("2026-08-01T00:00:00Z"),
    validTo: null,
    tags: [],
    relations: [],
    ...overrides,
  } as unknown as RecallHit;
}

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-hyperedge-coactivation",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:admin"],
        maxSensitivity: "restricted",
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

/** The helper is fired via `setImmediate` — flush the macrotask queue before asserting. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("POST /recall — hyperedge co-activation (B8)", () => {
  it("2+ hyperedge members present in served hits increases worth, clamped to [0,1]", async () => {
    const storage = new InMemoryStorageAdapter();
    const hyperedge = await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-a", "fact-b", "fact-c"],
    });
    expect(hyperedge.worth).toBe(0.5);

    const recall = vi.fn().mockResolvedValue({
      hits: [makeHit({ id: "fact-a" }), makeHit({ id: "fact-b" })],
      total: 2,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      storage,
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "co-activation test", topK: 5 }),
    });
    expect(res.status).toBe(200);

    await flush();

    const updated = await storage.getHyperedge(hyperedge.id, WS_ID);
    // TD(λ) step: +0.1 for a success credit (2 members present >= 2 threshold).
    expect(updated?.worth).toBeCloseTo(0.6, 5);
  });

  it("exactly 1 hyperedge member present decreases worth, clamped at 0 (never negative)", async () => {
    const storage = new InMemoryStorageAdapter();
    const hyperedge = await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-x", "fact-y", "fact-z"],
    });
    // Push worth down to the floor before the recall-triggered weaken so the
    // clamp itself is exercised, not just the raw arithmetic.
    for (let i = 0; i < 4; i++) {
      await storage.updateWorth(hyperedge.id, WS_ID, "hyperedge", {
        success: 0,
        failure: 1,
        creditWeight: 1,
      });
    }
    const preRecall = await storage.getHyperedge(hyperedge.id, WS_ID);
    expect(preRecall?.worth).toBeCloseTo(0.1, 5); // 0.5 - 4*0.1

    const recall = vi.fn().mockResolvedValue({
      hits: [makeHit({ id: "fact-x" }), makeHit({ id: "unrelated-fact" })],
      total: 2,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      storage,
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "co-activation test", topK: 5 }),
    });
    expect(res.status).toBe(200);
    await flush();

    let updated = await storage.getHyperedge(hyperedge.id, WS_ID);
    expect(updated?.worth).toBeCloseTo(0, 5); // 0.1 - 0.1 clamps to exactly 0

    // Fire a second recall from the floor — must stay clamped, never go negative.
    const res2 = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "co-activation test 2", topK: 5 }),
    });
    expect(res2.status).toBe(200);
    await flush();
    updated = await storage.getHyperedge(hyperedge.id, WS_ID);
    expect(updated?.worth).toBe(0);
  });

  it("fewer than 2 served hits never invokes updateWorth for any hyperedge", async () => {
    const storage = new InMemoryStorageAdapter();
    const hyperedge = await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-p", "fact-q", "fact-r"],
    });
    const updateWorthSpy = vi.spyOn(storage, "updateWorth");

    const recall = vi.fn().mockResolvedValue({
      hits: [makeHit({ id: "fact-p" })], // only 1 hit served — below the 2-hit threshold
      total: 1,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      storage,
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "single hit test", topK: 5 }),
    });
    expect(res.status).toBe(200);
    await flush();

    expect(updateWorthSpy).not.toHaveBeenCalled();
    const unchanged = await storage.getHyperedge(hyperedge.id, WS_ID);
    expect(unchanged?.worth).toBe(0.5);
  });

  it("zero served hits never invokes updateWorth for any hyperedge", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-m", "fact-n", "fact-o"],
    });
    const updateWorthSpy = vi.spyOn(storage, "updateWorth");

    const recall = vi.fn().mockResolvedValue({
      hits: [],
      total: 0,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      storage,
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "no hits test", topK: 5 }),
    });
    expect(res.status).toBe(200);
    await flush();

    expect(updateWorthSpy).not.toHaveBeenCalled();
  });
});
