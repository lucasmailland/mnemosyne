/**
 * WP-3 — what makes a recall hit rank where it does, and when recall has
 * nothing relevant to say.
 *
 * The 2026-10-17 evaluation measured default recall at 21–37% top-1 on a
 * corpus where raw bge-m3 cosine scored 92% (RECALL-1, AGENTSIM-1). The cold
 * score was `(tanh(activation)·0.4 + cosine·0.6) · worth`: 40% of it came from
 * how recently a memory had been recalled, which ignores the query, and every
 * served hit raised its own activation for the next query. Relevance now comes
 * first. Activation and worth stay as bounded priors that can reorder near-ties
 * and nothing else: together they move a score by at most +7%/−5%.
 */

/**
 * Most a memory's recent recalls can add: ×(1 + 0.02·tanh A). Big enough to
 * break a tie between equally similar memories in favour of the one in use,
 * too small to lift an unrelated memory over a relevant one.
 */
export const ACTIVATION_TIE_BREAK = 0.02;

/**
 * Worth (the TD(λ) usefulness posterior, 0.5 = no evidence) as a prior:
 * ×(1 + 0.1·(worth − 0.5)), i.e. 0.95–1.05. Served facts with evidence already
 * have worth > 0.5 (the serving gate drops the rest), so it can only nudge.
 * It used to multiply the score outright, which let a useful but unrelated
 * fact outrank a relevant one by up to 2×.
 */
export const WORTH_PRIOR_WEIGHT = 0.1;

export function activationFactor(activation: number): number {
  return 1 + ACTIVATION_TIE_BREAK * (activation > 0 ? Math.tanh(activation) : 0);
}

export function worthFactor(worth: number | undefined): number {
  return 1 + WORTH_PRIOR_WEIGHT * ((worth ?? 0.5) - 0.5);
}

/** Cosine of two vectors; 0 when either is empty or zero. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Calibrated "nothing relevant" floors per embedding model: the cosine at or
 * above which a hit counts as relevant for `RecallResponse.nothingRelevant`.
 * Cosine scales differ by model, so there is deliberately no global default —
 * a model missing here gets no floor until `MNEMO_RECALL_RELEVANCE_FLOOR` sets
 * one, and `nothingRelevant` then only reports an empty result.
 *
 * bge-m3 — 0.50, from the BENCH-1 corpora (src/benchmark/relevance): 3 of the
 * 101 questions with a stored answer put that answer below 0.50 (short keyword
 * queries: 0.44, 0.46; one paraphrase: 0.47), and off-topic questions land at
 * 0.30–0.38. Questions about the same projects with no stored answer score
 * 0.53–0.65 — inside the range of correct answers (0.44–0.80), so no cosine
 * floor can flag them without hiding real answers. The floor is set to flag
 * only clear misses: a false "nothing relevant" makes an agent drop a correct
 * memory, which costs more than reading a weak hit.
 */
export const DEFAULT_RELEVANCE_FLOORS: Readonly<Record<string, number>> = {
  "bge-m3": 0.5,
};

/** "BAAI/bge-m3", "bge-m3:latest", "bge-m3:567m" → "bge-m3". */
export function normalizeEmbedModel(model: string): string {
  const name = model.trim().toLowerCase();
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return base.includes(":") ? base.slice(0, base.indexOf(":")) : base;
}

export function defaultRelevanceFloor(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return DEFAULT_RELEVANCE_FLOORS[normalizeEmbedModel(model)];
}

/**
 * Whether recall found nothing that clears the floor. `similarities` are the
 * raw cosines of every eligible candidate (before pagination); `eligibleCount`
 * counts the eligible candidates, including ones without a cosine. Without a
 * floor only an empty result says "nothing".
 */
export function isNothingRelevant(
  similarities: ReadonlyArray<number | undefined>,
  floor: number | undefined,
  eligibleCount: number
): boolean {
  if (eligibleCount === 0) return true;
  if (floor === undefined) return false;
  return !similarities.some((s) => s !== undefined && s >= floor);
}

/**
 * CHAOS-5 — strict `semantic` recall could not embed the query (no embedder
 * configured, or the provider did not answer). Typed so the HTTP layer can map
 * it to a 503 with a stable code instead of a bare 500; `cause` keeps the
 * provider's own error for the logs.
 */
export class SemanticSearchUnavailableError extends Error {
  readonly code = "semantic_search_unavailable" as const;
  readonly retryable = true;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(`semantic_search_unavailable: ${reason}`);
    this.name = "SemanticSearchUnavailableError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isSemanticSearchUnavailableError(
  err: unknown
): err is SemanticSearchUnavailableError {
  return (
    err instanceof SemanticSearchUnavailableError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "semantic_search_unavailable")
  );
}
