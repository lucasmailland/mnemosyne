/**
 * P4-B: recall without MNEMO_LLM_API_KEY falls back to FTS (not 501).
 *
 * When MNEMO_LLM_PROVIDER / MNEMO_LLM_API_KEY are absent, the v3 recall-cold
 * stage detects ctx.embed.model === "none" and falls back to full-text search
 * via ftsCandidates. The route returns 200 with a debug.searchMode === "fts"
 * field instead of 501.
 *
 * A caller-supplied precomputed vector bypasses the embed adapter entirely;
 * that path is still 200 as before (no change).
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallQuery, RecallResponse } from "@mnemo-ai/types";
import { mountRecall } from "../routes/recall.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_noembedtest0000000001";
const WS_ID = "00000000-0000-0000-0000-000000000016";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:read"], plan: "free" },
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

/**
 * Build a v3 stub where the embed adapter returns model "none" (no-embed stub
 * convention used in production). recall-cold detects this and routes to FTS.
 */
function makeNoEmbedV3(ftsHits: RecallResponse["hits"] = []): NonNullable<ServerDeps["cognitive"]> {
  return {
    recall: async (q: RecallQuery): Promise<RecallResponse> => {
      // Simulate recallCold FTS fallback: when no embedding and embed.model === "none"
      // the real recall-cold returns FTS results. We test the behaviour here by
      // returning an FTS-mode response directly from the stub.
      if (!q.embedding) {
        return {
          hits: ftsHits,
          total: ftsHits.length,
          query: { text: q.text, limit: q.limit ?? 10, offset: q.offset ?? 0 },
          latencyMs: 1,
          fromHotTier: false,
          searchMode: "fts",
        };
      }
      return {
        hits: [],
        total: 0,
        query: { text: q.text, limit: q.limit ?? 10, offset: 0 },
        latencyMs: 0,
        fromHotTier: false,
        searchMode: "vector",
      };
    },
  } as unknown as NonNullable<ServerDeps["cognitive"]>;
}

describe("POST /recall without embedder falls back to FTS (P4-B)", () => {
  it("returns 200 with searchMode=fts when no embed adapter is configured", async () => {
    const ftsHit = {
      id: "fact-001",
      content: "The user prefers dark mode",
      score: 0.8,
      validFrom: new Date().toISOString(), // determinism-ok: fixture stub, not asserted,
      validTo: null,
      tags: [],
      sensitivity: "internal",
    };
    const v3 = makeNoEmbedV3([ftsHit as unknown as RecallResponse["hits"][number]]);

    const deps = {
      core: { recall: async () => [] } as unknown as ServerDeps["core"],
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRecall]);

    // No `vector` field → FTS fallback path → 200 with searchMode fts
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "dark mode preference" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; debug: { searchMode?: string } };
    expect(body.debug.searchMode).toBe("fts");
    expect(body.hits).toHaveLength(1);
  });

  it("returns 200 with empty hits when FTS finds nothing (no embed, no match)", async () => {
    const v3 = makeNoEmbedV3([]);

    const deps = {
      core: { recall: async () => [] } as unknown as ServerDeps["core"],
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRecall]);

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "xyzzy nothing matches" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; debug: { searchMode?: string } };
    expect(body.debug.searchMode).toBe("fts");
    expect(body.hits).toHaveLength(0);
  });

  it("returns 200 with searchMode=vector when a precomputed vector is supplied", async () => {
    const v3 = makeNoEmbedV3([]);

    const deps = {
      core: { recall: async () => [] } as unknown as ServerDeps["core"],
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: v3,
    } as unknown as ServerDeps;

    const app = buildMountHarness(deps, [mountRecall]);

    // Supply a precomputed 1536-dim vector → v3.recall uses it directly → 200 vector mode
    const vector = Array.from({ length: 1536 }, () => 0.001);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "what did we decide about pricing?", vector }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[]; debug: { searchMode?: string } };
    expect(body.debug.searchMode).toBe("vector");
  });
});
