// Optional ε-differential-privacy noise on embeddings (SECURITY.md §10 poisoning
// / membership-inference defence).  Pure + deterministic when an rng is injected.
// Gated by MNEMO_EMBEDDING_NOISE at the call site; "off" is a no-op passthrough.

export type EmbeddingNoiseMode = "off" | "laplace" | "gaussian";

export interface EmbeddingNoiseConfig {
  mode: EmbeddingNoiseMode;
  /** Privacy budget; smaller = more noise. */
  epsilon: number;
  /** L2 sensitivity of one record's contribution (default 1 for unit-norm). */
  sensitivity?: number;
  /** Injectable RNG for tests; defaults to Math.random. */
  rng?: () => number;
}

// Inverse-CDF Laplace sample with scale b.
function laplace(rng: () => number, b: number): number {
  const u = rng() - 0.5;
  return -b * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// Box–Muller Gaussian sample with stddev sigma.
function gaussian(rng: () => number, sigma: number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function addEmbeddingNoise(vector: number[], config: EmbeddingNoiseConfig): number[] {
  if (config.mode === "off") return vector;
  const rng = config.rng ?? Math.random;
  const sens = config.sensitivity ?? 1;
  const eps = Math.max(config.epsilon, 1e-6);

  if (config.mode === "laplace") {
    const b = sens / eps; // Laplace mechanism scale.
    return vector.map((x) => x + laplace(rng, b));
  }
  // Gaussian mechanism: sigma ∝ sensitivity / epsilon.
  const sigma = sens / eps;
  return vector.map((x) => x + gaussian(rng, sigma));
}
