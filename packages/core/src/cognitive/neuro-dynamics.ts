// Neuro-dynamics: kind-differentiated decay + Hebbian STDP/homeostatic (Wave Y, §25.2/§25.3)
// Zero infrastructure imports — pure math only. All I/O is done in the adapter layer.

import type { PrimitiveKind, DecayClass } from "@mnemo-ai/types";

export type { DecayClass } from "@mnemo-ai/types";

// ─── §25.2 Decay half-lives ───────────────────────────────────────────────────

export const DECAY_HALF_LIVES: Record<DecayClass, number> = {
  procedural: 173,
  semantic: 58,
  episodic: 35,
  entity: 0,   // immortal — factor is always 1
  reasoning: 90,
};

/**
 * Map from PrimitiveKind to DecayClass.
 *
 * `task` and `hyperedge` are intentionally omitted — they are NOT subject to
 * Beta-evidence/time decay (spec §"Primitive Classification" line 3445-3447:
 * "Task | operational (no decay, lifecycle-based)" — "Tasks don't decay by time —
 * they transition through a state machine"). A stale-task cron (mnemo.task.stale)
 * FLAGS inactive tasks; it never decays their worth. `decayClassForKind('task')`
 * therefore throws by design — see neuro-dynamics-task-decay.test.ts. Do NOT add a
 * task decay curve here: that would contradict the lifecycle model.
 */
const KIND_TO_CLASS: Partial<Record<PrimitiveKind, DecayClass>> = {
  strategy: "procedural",
  workflow: "procedural",
  skill: "procedural",
  fact: "semantic",
  decision: "semantic",
  episode: "episodic",
  event: "episodic",
  entity: "entity",
  reasoning: "reasoning",
};

export function decayClassForKind(kind: PrimitiveKind): DecayClass {
  const cls = KIND_TO_CLASS[kind];
  if (cls === undefined) throw new Error(`no decay class for kind: ${kind}`);
  return cls;
}

// ─── §25.2 Exponential decay factor ──────────────────────────────────────────

/**
 * Returns 2^(−Δd / halfLifeDays).
 * - At Δd=0: always 1.0.
 * - At Δd=halfLife: 0.5.
 * - At halfLife=0 (entity): always 1.0 (immortal).
 */
export function decayFactor(elapsedDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  if (elapsedDays <= 0) return 1;
  return Math.pow(2, -elapsedDays / halfLifeDays);
}

// ─── §25.2 Beta evidence decay ────────────────────────────────────────────────

/**
 * Relax Beta evidence (α, β) toward the uniform prior (1, 1) using the decay factor f.
 *
 *   α' = 1 + (α − 1) * f
 *   β' = 1 + (β − 1) * f
 *
 * At f=1 (Δd=0): no change.
 * At f=0.5 (one half-life): excess over prior halves.
 * The result can never go below the prior (1, 1) since (α-1) ≥ 0 and f ≥ 0.
 */
export function decayEvidence(
  alpha: number,
  beta: number,
  elapsedDays: number,
  halfLifeDays: number,
): { alpha: number; beta: number } {
  const f = decayFactor(elapsedDays, halfLifeDays);
  if (f === 1) return { alpha, beta };
  return {
    alpha: 1 + (alpha - 1) * f,
    beta: 1 + (beta - 1) * f,
  };
}

// ─── §25.3 Hebbian STDP ───────────────────────────────────────────────────────

/**
 * STDP constants (spec §25.3 asymmetric window).
 * A_PLUS < A_MINUS so LTD is slightly stronger than LTP.
 */
export const STDP = {
  A_PLUS: 0.1,
  A_MINUS: 0.12,
  TAU_SECONDS: 20,
} as const;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export interface StdpInput {
  weight: number;
  directionality: number;
  deltaSeconds: number; // positive: A fired before B (causal); negative: B fired first (acausal)
}

export interface StdpResult {
  weight: number;
  directionality: number;
  deltaWeight: number;
}

/**
 * Asymmetric STDP update:
 *   Δw = A+ * exp(−|Δt| / τ)   if Δt ≥ 0 (causal LTP)
 *   Δw = −A− * exp(−|Δt| / τ)  if Δt < 0 (acausal LTD)
 *
 * Directionality is an EMA toward 1 for causal (Δt≥0) or 0 for acausal (Δt<0).
 */
export function stdpUpdate(input: StdpInput): StdpResult {
  const { weight, directionality, deltaSeconds: dt } = input;
  const dw =
    dt >= 0
      ? STDP.A_PLUS * Math.exp(-dt / STDP.TAU_SECONDS)
      : -STDP.A_MINUS * Math.exp(dt / STDP.TAU_SECONDS);
  const newWeight = clamp01(weight + dw);
  const newDir = clamp01(0.9 * directionality + 0.1 * (dt >= 0 ? 1 : 0));
  return { weight: newWeight, directionality: newDir, deltaWeight: dw };
}

// ─── §25.3 Homeostatic percentile normalization ───────────────────────────────

/**
 * Map a list of weights to their averaged percentile ranks in [0, 1].
 * Tied values receive the mean of their rank positions.
 *
 * Usage: weekly rescale run — caller collects all hebbian_weight values for a
 * workspace, calls this, then writes back the normalized values.
 */
export function percentileNormalize(weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const indexed = weights.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w);
  const avgRank = new Array<number>(n);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && indexed[j + 1]!.w === indexed[k]!.w) j++;
    const mean = (k + j) / 2;
    for (let p = k; p <= j; p++) avgRank[indexed[p]!.i] = mean;
    k = j + 1;
  }
  return avgRank.map((r) => r / (n - 1));
}
