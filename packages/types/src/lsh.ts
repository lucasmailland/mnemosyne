export const LSH_DIMS = 64;
export const LSH_BANDS = 6;
export const LSH_PLANES_PER_BAND = 8;
const LSH_SEED = 0x9e3779b9;

// Deterministic xorshift32 PRNG seeded with LSH_SEED
function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

// Pre-generate sign random-projection hyperplanes: 6 bands × 8 planes × 64 dims.
// All bands project the SAME 64-dim embedding prefix; bands differ only by their planes.
const PLANES: number[][][] = [];
{
  let rng = LSH_SEED;
  for (let b = 0; b < LSH_BANDS; b++) {
    const band: number[][] = [];
    for (let p = 0; p < LSH_PLANES_PER_BAND; p++) {
      const plane: number[] = [];
      for (let d = 0; d < LSH_DIMS; d++) {
        rng = xorshift32(rng);
        plane.push(rng & 1 ? 1 : -1);
      }
      band.push(plane);
    }
    PLANES.push(band);
  }
}

// FNV-1a 64-bit band hash
function fnv1a64(bandIdx: number, sketch: number, spaceId?: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const str = spaceId ? `${spaceId}:${bandIdx}` : `${bandIdx}`;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ BigInt(str.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  h = (h ^ BigInt(sketch & 0xff)) & mask;
  h = (h * prime) & mask;
  return h;
}

export interface LshBand {
  bandIdx: number;
  bandHash: bigint;
}

export function lshBands(embedding: Float32Array | number[], spaceId?: string): LshBand[] {
  const out: LshBand[] = [];
  for (let b = 0; b < LSH_BANDS; b++) {
    let sketch = 0;
    for (let p = 0; p < LSH_PLANES_PER_BAND; p++) {
      const plane = PLANES[b]![p]!;
      let dot = 0;
      for (let d = 0; d < plane.length; d++) {
        dot += (embedding[d] ?? 0) * plane[d]!; // all bands use the same 64-dim prefix
      }
      if (dot >= 0) sketch |= 1 << p;
    }
    out.push({ bandIdx: b, bandHash: fnv1a64(b, sketch, spaceId) });
  }
  return out;
}
