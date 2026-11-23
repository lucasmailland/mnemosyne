import { describe, it, expect } from "vitest";
import { addEmbeddingNoise } from "../embedding-noise.js";

// Deterministic LCG RNG for reproducible tests.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe("addEmbeddingNoise", () => {
  it("returns the vector unchanged when mode is off", () => {
    const v = [0.1, 0.2, 0.3];
    expect(addEmbeddingNoise(v, { mode: "off", epsilon: 1 })).toEqual(v);
  });

  it("perturbs the vector under laplace mode", () => {
    const v = [0.1, 0.2, 0.3];
    const out = addEmbeddingNoise(v, { mode: "laplace", epsilon: 1, rng: seededRng(42) });
    expect(out).toHaveLength(3);
    expect(out).not.toEqual(v);
    out.forEach((x) => expect(Number.isFinite(x)).toBe(true));
  });

  it("perturbs the vector under gaussian mode", () => {
    const v = [0.1, 0.2, 0.3];
    const out = addEmbeddingNoise(v, { mode: "gaussian", epsilon: 1, rng: seededRng(7) });
    expect(out).not.toEqual(v);
    out.forEach((x) => expect(Number.isFinite(x)).toBe(true));
  });

  it("smaller epsilon (more privacy) yields larger expected perturbation", () => {
    const v = [0, 0, 0, 0, 0, 0, 0, 0];
    const tight = addEmbeddingNoise(v, { mode: "laplace", epsilon: 10, rng: seededRng(1) });
    const loose = addEmbeddingNoise(v, { mode: "laplace", epsilon: 0.1, rng: seededRng(1) });
    const mag = (a: number[]) => Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(mag(loose)).toBeGreaterThan(mag(tight));
  });
});
