/**
 * topicKey-suggest-and-hit-freshness slice (c) — `mapV3HitToV1`
 * (packages/server/src/routes/recall.ts) is an explicit field allowlist:
 * any RecallHit field not named there is silently dropped before it
 * reaches the wire. This test proves `hitFreshness` survives that mapper
 * end-to-end via a real POST /recall call, not just at the type level.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { makeMockCognitive } from "./helpers/mockCognitive.js";
import { vi } from "vitest";

const PLAINTEXT_KEY = "mns_live_hitfreshnesstest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000099";

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key001",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:admin"],
        maxSensitivity: "public",
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

describe("hitFreshness survives mapV3HitToV1 end-to-end (POST /recall)", () => {
  it("forwards hitFreshness for a hit that has it stamped", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: [
        {
          id: "fact-1",
          primitive: "fact",
          content: "some durable fact",
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
          hitFreshness: "recent",
        },
      ],
      total: 1,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "some durable fact", topK: 5 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; hitFreshness?: string }> };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]!.hitFreshness).toBe("recent");
  });

  it("omits hitFreshness (not null) when a hit legitimately lacks it", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: [
        {
          id: "fact-2",
          primitive: "fact",
          content: "federation-received fact, constructed outside buildResponse",
          score: 0.5,
          sensitivity: "public",
          injectionScore: 0,
          provenance: "federation_received",
          origin: "federation:peer-1",
          contested: false,
          validFrom: new Date("2026-08-01T00:00:00Z"),
          validTo: null,
          tags: [],
          relations: [],
          // hitFreshness intentionally absent
        },
      ],
      total: 1,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "federated", topK: 5 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<Record<string, unknown>> };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).not.toHaveProperty("hitFreshness");
  });
});
