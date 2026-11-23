import { describe, it, expect } from "vitest";
import { dedupeNearDuplicates } from "../recall-hot.js";
import type { RecallHit } from "@mnemo-ai/types";

function hit(id: string, content: string, score: number): RecallHit {
  return {
    id, primitive: "fact", content, score,
    sensitivity: "internal", injectionScore: 0, provenance: "user_stated",
    origin: "local", contested: false, validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null,
    tags: [], relations: [], worth: 0.5, worthLowerBound: 0.3,
  } as unknown as RecallHit;
}

describe("§17 hot-tier near-duplicate suppression", () => {
  it("drops a near-duplicate, keeping the higher-ranked hit", () => {
    const hits = [
      hit("a", "deploy pipeline uses blue green rollout for the api service", 0.9),
      hit("b", "deploy pipeline uses blue green rollout for the api service now", 0.8), // ~0.91 dup of a
      hit("c", "postgres connection pool size is twenty", 0.7),
    ];
    const out = dedupeNearDuplicates(hits, 0.88);
    const ids = out.map((h) => h.id);
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    expect(ids).not.toContain("b"); // suppressed as near-dup of a
  });

  it("keeps all hits when none are near-duplicates", () => {
    const hits = [
      hit("a", "alpha fact about caching", 0.9),
      hit("b", "beta fact about networking", 0.8),
      hit("c", "gamma fact about storage", 0.7),
    ];
    expect(dedupeNearDuplicates(hits, 0.88)).toHaveLength(3);
  });

  it("is a no-op on empty input", () => {
    expect(dedupeNearDuplicates([], 0.88)).toEqual([]);
  });
});
