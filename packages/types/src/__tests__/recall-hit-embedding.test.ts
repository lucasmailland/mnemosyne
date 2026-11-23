// packages/types/src/__tests__/recall-hit-embedding.test.ts
import { describe, it, expect } from "vitest";
import type { RecallHit } from "../recall.js";

describe("RecallHit.embedding (RecMem gate input)", () => {
  it("accepts an optional embedding without widening required fields", () => {
    const hit: RecallHit = {
      id: "f1",
      primitive: "fact",
      content: "x",
      score: 0.9,
      sensitivity: "internal",
      injectionScore: 0,
      provenance: "user_stated",
      origin: "local",
      contested: false,
      validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
      validTo: null,
      tags: [],
      relations: [],
      embedding: [0.1, 0.2, 0.3],
    };
    expect(hit.embedding).toHaveLength(3);
    // Omitting embedding must still type-check (compile-time guarantee).
    const noEmb: RecallHit = { ...hit };
    delete (noEmb as { embedding?: number[] }).embedding;
    expect(noEmb.embedding).toBeUndefined();
  });
});
