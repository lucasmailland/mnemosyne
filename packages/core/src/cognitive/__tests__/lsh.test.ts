import { describe, it, expect } from "vitest";
import { lshBands, LSH_BANDS, LSH_DIMS } from "../lsh.js";

function vec(prefix: number[]): Float32Array {
  const v = new Float32Array(1536);
  for (let i = 0; i < prefix.length && i < 1536; i++) v[i] = prefix[i]!;
  return v;
}

describe("lshBands — SimHash banding over first 64 dims (spec §17)", () => {
  it("returns exactly 6 bands with band indices 0..5", () => {
    const bands = lshBands(vec(Array.from({ length: 64 }, (_, i) => Math.sin(i))));
    expect(bands).toHaveLength(LSH_BANDS);
    expect(bands.map((b) => b.bandIdx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(LSH_DIMS).toBe(64);
  });

  it("is deterministic — same vector ⇒ identical band hashes", () => {
    const v = vec(Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.3)));
    const a = lshBands(v);
    const b = lshBands(v);
    expect(a.map((x) => x.bandHash.toString())).toEqual(b.map((x) => x.bandHash.toString()));
  });

  it("near-identical vectors collide on most bands; orthogonal-ish vectors collide on few", () => {
    const base = Array.from({ length: 64 }, (_, i) => Math.sin(i));
    const near = base.map((x, i) => x + (i % 7 === 0 ? 0.001 : 0));
    const far = Array.from({ length: 64 }, (_, i) => Math.sin(i + 1000) * (i % 2 ? -1 : 1));

    const bBase = lshBands(vec(base));
    const bNear = lshBands(vec(near));
    const bFar = lshBands(vec(far));

    const collide = (x: typeof bBase, y: typeof bBase) =>
      x.filter((bd, i) => bd.bandHash === y[i]!.bandHash).length;

    expect(collide(bBase, bNear)).toBeGreaterThanOrEqual(5);
    expect(collide(bBase, bFar)).toBeLessThan(collide(bBase, bNear));
  });

  it("only the first 64 dims matter (Matryoshka prefix)", () => {
    const prefix = Array.from({ length: 64 }, (_, i) => Math.sin(i));
    const a = vec(prefix);
    const b = vec(prefix);
    b[200] = 999;
    expect(lshBands(a).map((x) => x.bandHash.toString()))
      .toEqual(lshBands(b).map((x) => x.bandHash.toString()));
  });

  it("all 64 dims are consulted — flipping dim 63 changes at least one band hash", () => {
    // Regression guard for the LSH_PLANES_PER_BAND vs LSH_DIMS bug.
    // If planes are only 8-dim, changes at dim 63 would be invisible.
    const base = Array.from({ length: 64 }, (_, i) => Math.sin(i));
    const perturbed = [...base];
    perturbed[63] = -base[63]!; // flip the last Matryoshka dim
    const bBase = lshBands(vec(base));
    const bPerturbed = lshBands(vec(perturbed));
    const different = bBase.some((bd, i) => bd.bandHash !== bPerturbed[i]!.bandHash);
    expect(different).toBe(true);
  });
});
