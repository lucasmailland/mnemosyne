/**
 * RecMem — recurrence-gated LLM invocation (arXiv:2605.16045; spec
 * MEMORY_IMPROVEMENT.md:84, :140, :561). A single shared definition of the
 * recurrence signal so the collapse gate (session/collapse.ts) and the recall
 * rerank gate (v3/recall-cold.ts) use byte-for-byte identical math. Pure: no
 * I/O, no ctx — just vectors in, decision out.
 *
 * Signal: mean over rows of the row-wise MAX pairwise cosine (excluding the
 * diagonal). A single-topic set scores high (every item resembles at least one
 * other); a scattered set scores low. High signal predicts durable knowledge
 * worth paying for an LLM call; low signal → skip the call (the 87% saving).
 */

type VecLike = number[] | Float32Array;

function cosine(a: VecLike, b: VecLike): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    dot += a[k]! * b[k]!;
    normA += a[k]! * a[k]!;
    normB += b[k]! * b[k]!;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Mean-of-max pairwise cosine. N<2 → 1.0 (trivially coherent). */
export function recurrenceSignal(embeddings: VecLike[]): number {
  const N = embeddings.length;
  if (N < 2) return 1.0;
  let totalMax = 0;
  for (let i = 0; i < N; i++) {
    let rowMax = 0;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const c = cosine(embeddings[i]!, embeddings[j]!);
      if (c > rowMax) rowMax = c;
    }
    totalMax += rowMax;
  }
  return totalMax / N;
}

export interface RecmemOptions {
  recurrenceThreshold?: number;      // default 0.6 (spec MEMORY_IMPROVEMENT.md:652)
  skipLlmIfBelowThreshold?: boolean; // default true (spec :653)
  /** Size of the LLM prompt that WOULD be sent — used to estimate tokens saved on skip. */
  wouldBePromptChars?: number;
}

export interface RecmemDecision {
  signal: number;
  threshold: number;
  skipped: boolean;
  /** Deterministic estimate: wouldBePromptChars/4 when skipped, else 0. */
  estimatedTokensSaved: number;
}

const CHARS_PER_TOKEN = 4;

export function decideRecmem(embeddings: VecLike[], opts: RecmemOptions = {}): RecmemDecision {
  const threshold = opts.recurrenceThreshold ?? 0.6;
  const skipIfBelow = opts.skipLlmIfBelowThreshold ?? true;
  const signal = recurrenceSignal(embeddings);
  const skipped = signal < threshold && skipIfBelow;
  const estimatedTokensSaved = skipped ? Math.round((opts.wouldBePromptChars ?? 0) / CHARS_PER_TOKEN) : 0;
  return { signal, threshold, skipped, estimatedTokensSaved };
}
