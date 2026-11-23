/**
 * §4 Recall tiering routes (deep re-audit P1-3).
 *
 * Covers POST /recall/hot, /recall/unified, /recall/explain:
 *   - hot tier reads v3.recallHot only (no embed, no cold fallthrough)
 *   - unified blends memory + caller-supplied KB hits, source-normalised
 *   - explain surfaces per-hit scoring signals (worth, injection, contested, …)
 *   - all three 501 when no v3 core is configured
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallHit, RecallResponse } from "@mnemo-ai/types";
import { mountRecallTiering } from "../routes/recallTiering.js";
import { buildMountHarness } from "./_mountHarness.js";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

const PLAINTEXT_KEY = "mns_live_recalltieringtest000001";
const WS_ID = "00000000-0000-0000-0000-000000000018";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

function hit(
  partial: Partial<RecallHit> & { id: string; content: string; score: number }
): RecallHit {
  return {
    primitive: "fact",
    sensitivity: "internal",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    tags: [],
    relations: [],
    ...partial,
  };
}

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

describe("§4 recall tiering routes (P1-3)", () => {
  it("POST /recall/hot returns hot-tier hits and never embeds", async () => {
    let embedCalls = 0;
    const v3 = {
      recallHot: async () => [hit({ id: "f1", content: "hot fact", score: 0.9, worth: 0.9 })],
      recall: async () => {
        embedCalls++;
        return {
          hits: [],
          total: 0,
          query: { text: "", limit: 10, offset: 0 },
          latencyMs: 0,
          fromHotTier: false,
        } satisfies RecallResponse;
      },
    } as unknown as NonNullable<ServerDeps["cognitive"]>;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecallTiering]);

    const res = await app.request("/recall/hot", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; fromHotTier: boolean };
    expect(body.hits).toHaveLength(1);
    expect(body.fromHotTier).toBe(true);
    // recall() (which would embed) must never be hit by the hot path.
    expect(embedCalls).toBe(0);
  });

  it("POST /recall/hot reports a miss as fromHotTier=false with empty hits", async () => {
    const v3 = { recallHot: async () => [] } as unknown as NonNullable<ServerDeps["cognitive"]>;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecallTiering]);

    const res = await app.request("/recall/hot", { method: "POST", headers: authed(), body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; fromHotTier: boolean };
    expect(body.hits).toHaveLength(0);
    expect(body.fromHotTier).toBe(false);
  });

  it("POST /recall/unified blends memory + KB and orders by blended score", async () => {
    const v3 = {
      recall: async () =>
        ({
          hits: [hit({ id: "m1", content: "memory hit", score: 1.0 })],
          total: 1,
          query: { text: "q", limit: 10, offset: 0 },
          latencyMs: 1,
          fromHotTier: false,
        }) satisfies RecallResponse,
    } as unknown as NonNullable<ServerDeps["cognitive"]>;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecallTiering]);

    const res = await app.request("/recall/unified", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        query: "q",
        limit: 10,
        memoryWeight: 0.5,
        kbHits: [{ id: "kb1", content: "kb chunk", score: 42, docId: "d1", docTitle: "Doc 1" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ source: string; id: string; score: number }>;
    };
    expect(body.hits).toHaveLength(2);
    // memoryWeight 0.5, both top of their source → both normalise to 0.5; memory first (stable sort on equal).
    const sources = new Set(body.hits.map((h) => h.source));
    expect(sources.has("memory")).toBe(true);
    expect(sources.has("kb")).toBe(true);
    expect(body.hits[0]!.score).toBeCloseTo(0.5, 5);
  });

  it("POST /recall/explain surfaces the per-hit scoring breakdown", async () => {
    const v3 = {
      recall: async () =>
        ({
          hits: [
            hit({
              id: "e1",
              content: "explainable",
              score: 0.7,
              worth: 0.8,
              worthLowerBound: 0.4,
              injectionScore: 0.1,
              contested: true,
              relations: [
                { id: "r1", targetId: "t1", targetKind: "fact", verb: "related", weight: 1 },
              ],
            }),
          ],
          total: 1,
          query: { text: "q", limit: 10, offset: 0 },
          latencyMs: 1,
          fromHotTier: false,
        }) satisfies RecallResponse,
    } as unknown as NonNullable<ServerDeps["cognitive"]>;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecallTiering]);

    const res = await app.request("/recall/explain", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "q", limit: 10 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{
        explain: {
          worth: number;
          worthLowerBound: number;
          contested: boolean;
          relationCount: number;
        };
      }>;
    };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]!.explain.worth).toBe(0.8);
    expect(body.hits[0]!.explain.worthLowerBound).toBe(0.4);
    expect(body.hits[0]!.explain.contested).toBe(true);
    expect(body.hits[0]!.explain.relationCount).toBe(1);
  });

  it("all three recall-tiering routes return 200 when cognitive core is present", async () => {
    const cognitive = makeMockCognitive({
      recallHot: async () => [],
      recall: async () => ({
        hits: [],
        total: 0,
        query: { text: "q", limit: 10, offset: 0 },
        latencyMs: 0,
        fromHotTier: false,
      }),
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive,
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecallTiering]);

    for (const [path, payload] of [
      ["/recall/hot", "{}"],
      ["/recall/unified", JSON.stringify({ query: "q" })],
      ["/recall/explain", JSON.stringify({ query: "q" })],
    ] as const) {
      const res = await app.request(path, { method: "POST", headers: authed(), body: payload });
      expect(res.status).toBe(200);
    }
  });
});
