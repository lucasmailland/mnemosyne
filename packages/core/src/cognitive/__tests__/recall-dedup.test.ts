import { describe, it, expect } from "vitest";
import { dedupByContent } from "../recall-cold.js";
import type { RecallHit } from "@mnemo-ai/types";

function hit(id: string, content: string, score: number): RecallHit {
  return {
    id, primitive: "fact", content, score, sensitivity: "internal", injectionScore: 0,
    provenance: "user_stated", origin: "local", contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null, tags: [], relations: [],
  } as unknown as RecallHit;
}

/**
 * Embed adapter that maps each known content string to a fixed unit vector.
 * Vectors are chosen so "A1" and "A2" are near-identical (cosine ≈ 0.997 > 0.88)
 * while "B" is orthogonal (cosine 0).
 */
function makeEmbed(vectors: Record<string, number[]>) {
  return {
    id: "fake-embed", model: "fake", dimensions: 3,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => new Float32Array(vectors[t] ?? [0, 0, 0]));
    },
    async embedSingle(t: string): Promise<Float32Array> {
      return new Float32Array(vectors[t] ?? [0, 0, 0]);
    },
    async healthCheck() { return { healthy: true } as any; },
  } as any;
}

function ctxWith(embed: any) {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  return { embed, logger } as any;
}

describe("dedupByContent (§17 post-processing cosine>0.88 dedup)", () => {
  const embed = makeEmbed({
    "A one": [1, 0, 0],
    "A two": [0.99, 0.01, 0], // cosine with "A one" ≈ 0.9999 > 0.88
    "B": [0, 1, 0],           // orthogonal to the A cluster
  });

  it("drops a near-duplicate (cosine>0.88), keeping the higher-scored hit", async () => {
    const hits = [hit("a1", "A one", 0.9), hit("a2", "A two", 0.7), hit("b", "B", 0.6)];
    const out = await dedupByContent(ctxWith(embed), hits);
    const ids = out.map((h) => h.id);
    expect(ids).toContain("a1"); // higher score → survives
    expect(ids).not.toContain("a2"); // near-duplicate of a1 → dropped
    expect(ids).toContain("b"); // distinct → kept
  });

  it("keeps the strongest of a duplicate cluster regardless of input order", async () => {
    const hits = [hit("a2", "A two", 0.7), hit("a1", "A one", 0.95)];
    const out = await dedupByContent(ctxWith(embed), hits);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("a1");
  });

  it("returns the set unchanged when nothing is a near-duplicate", async () => {
    const distinct = makeEmbed({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    const hits = [hit("x", "x", 0.9), hit("y", "y", 0.8), hit("z", "z", 0.7)];
    const out = await dedupByContent(ctxWith(distinct), hits);
    expect(out).toHaveLength(3);
  });

  it("is a no-op for sets smaller than 2", async () => {
    const hits = [hit("solo", "A one", 0.9)];
    const out = await dedupByContent(ctxWith(embed), hits);
    expect(out).toEqual(hits);
  });

  it("degrades to the input set if embedding throws", async () => {
    const broken = { embed: async () => { throw new Error("embed down"); } } as any;
    const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
    const hits = [hit("a1", "A one", 0.9), hit("a2", "A two", 0.7)];
    const out = await dedupByContent({ embed: broken, logger } as any, hits);
    expect(out).toEqual(hits);
  });
});
