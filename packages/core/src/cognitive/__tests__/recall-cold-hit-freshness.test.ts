import { describe, it, expect } from "vitest";
import { buildResponse } from "../recall-cold.js";
import type { RecallHit } from "@mnemo-ai/types";

// topicKey-suggest-and-hit-freshness slice (c) — buildResponse() is the
// single choke point (design.md D5) that stamps `hitFreshness` on every
// RecallHit, for BOTH the cold cascade (fromHotTier=false, all 3 cold
// exits) and the hot tier (fromHotTier=true, recall-hot.ts:387 imports
// this same builder). This test exercises the builder directly rather
// than the full pipeline, so it stays fast and deterministic.

function hit(id: string, validFrom: Date): RecallHit {
  return {
    id,
    primitive: "fact",
    content: `content-${id}`,
    score: 0.5,
    sensitivity: "internal",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom,
    validTo: null,
    tags: [],
    relations: [],
  };
}

const now = Date.now(); // determinism-ok: fixed anchor captured once per run for relative day offsets, never compared to a hardcoded value
const dayMs = 24 * 60 * 60 * 1000;

describe("buildResponse() stamps hitFreshness on every hit", () => {
  it("cold path (fromHotTier=false) — stamps a bucket per hit's own validFrom", () => {
    const hits = [
      hit("current", new Date(now - 1 * dayMs)),
      hit("recent", new Date(now - 10 * dayMs)),
      hit("aging", new Date(now - 45 * dayMs)),
      hit("stale", new Date(now - 200 * dayMs)),
    ];

    const response = buildResponse(hits, "query", 10, 0, now, false);

    expect(response.hits.map((h) => h.hitFreshness)).toEqual([
      "current",
      "recent",
      "aging",
      "stale",
    ]);
  });

  it("hot path (fromHotTier=true) — same stamping behavior as cold", () => {
    const hits = [hit("h1", new Date(now - 1 * dayMs)), hit("h2", new Date(now - 200 * dayMs))];

    const response = buildResponse(hits, "query", 10, 0, now, true);

    expect(response.fromHotTier).toBe(true);
    expect(response.hits.map((h) => h.hitFreshness)).toEqual(["current", "stale"]);
  });

  it("stamps every hit — none are skipped, regardless of list length", () => {
    const hits = Array.from({ length: 7 }, (_, i) => hit(`h${i}`, new Date(now - i * dayMs)));
    const response = buildResponse(hits, "query", 10, 0, now, false);

    expect(response.hits).toHaveLength(7);
    for (const h of response.hits) {
      expect(h.hitFreshness).toBeDefined();
      expect(["current", "recent", "aging", "stale"]).toContain(h.hitFreshness);
    }
  });

  it("empty hit list — returns empty hits with no error", () => {
    const response = buildResponse([], "query", 10, 0, now, false);
    expect(response.hits).toEqual([]);
    expect(response.total).toBe(0);
  });

  it("does not mutate the caller's original hit objects", () => {
    const original = hit("h1", new Date(now - 1 * dayMs));
    expect(original).not.toHaveProperty("hitFreshness");
    buildResponse([original], "query", 10, 0, now, false);
    expect(original).not.toHaveProperty("hitFreshness");
  });
});
