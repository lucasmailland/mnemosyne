// Semantic classifier for a pair of fact statements: DUPLICATE, CONTRADICTION
// or COMPATIBLE.
//
// Cosine similarity says two facts talk about the same thing; it cannot say
// whether they agree. "ledger-api requires PostgreSQL 17" sits closer to
// "ledger-api runs on PostgreSQL 15" than to most of its own paraphrases. This
// is the step that tells them apart, and the only one allowed to turn a
// similar pair into a conflict or a duplicate.
//
// Lives in core so the write path (remember) can call it; the consolidation
// package re-exports it for its scheduler and its scoped write-time worker, so
// the three callers share one prompt and one parser.
//
// Cost profile: single-turn, ≤ 50 token output.

import type { LLMTask } from "@mnemo-ai/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SemanticClass = "DUPLICATE" | "CONTRADICTION" | "COMPATIBLE";

export interface ClassifyFactPairResult {
  classification: SemanticClass;
  /**
   * Always true on a returned result. Kept for callers written when an
   * unreadable reply came back as a non-confident COMPATIBLE; such a reply
   * now rejects with {@link FactPairClassificationError} instead.
   */
  confident: boolean;
  /** Raw LLM response (trimmed, upper-cased). Useful for debugging. */
  rawResponse: string;
}

/**
 * The minimal LLM surface the classifier needs. Both the core `LLMAdapter`
 * port and consolidation's `ValidatorLLM` satisfy it structurally.
 */
export interface FactPairClassifierLLM {
  generate(opts: {
    messages: Array<{ role: "user"; content: string }>;
    maxTokens: number;
    temperature: number;
    task?: LLMTask;
  }): Promise<{ content: string }>;
}

/**
 * LIFECYCLE-14 — the classifier could not produce a verdict.
 *
 * This used to be a silent COMPATIBLE. That is a verdict, and callers act on
 * verdicts: the consolidation scheduler persists COMPATIBLE as a
 * `not_conflict` relation and never classifies the pair again, so one model
 * outage left permanent "these do not conflict" judgments behind. A failure is
 * now an error every caller has to handle — skip the pair, log, retry later —
 * and can never be mistaken for an answer.
 */
export class FactPairClassificationError extends Error {
  readonly reason: "llm_error" | "unrecognised_response";
  /** The reply that could not be parsed; empty for `llm_error`. */
  readonly rawResponse: string;

  constructor(reason: "llm_error" | "unrecognised_response", message: string, rawResponse = "") {
    super(message);
    this.name = "FactPairClassificationError";
    this.reason = reason;
    this.rawResponse = rawResponse;
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildClassificationPrompt(statementA: string, statementB: string): string {
  return [
    "Given these two facts:",
    `A: "${statementA}"`,
    `B: "${statementB}"`,
    "",
    "Classify their relationship as one of:",
    "- DUPLICATE: they make the same claim, possibly in different words; neither adds information the other lacks",
    "- CONTRADICTION: they make claims about the same thing that cannot both be true at the same time (a changed value, a reversed choice, a negation)",
    "- COMPATIBLE: anything else, including facts on the same topic about different things (another service, project, person, tenant, environment or time) and facts that add detail without conflicting",
    "",
    "Reply with exactly one word: DUPLICATE, CONTRADICTION, or COMPATIBLE",
  ].join("\n");
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const VALID_CLASSES: ReadonlySet<string> = new Set(["DUPLICATE", "CONTRADICTION", "COMPATIBLE"]);

/**
 * The label, when the reply IS one label and nothing else — case, surrounding
 * quotes or markdown emphasis and a trailing full stop aside. Anything more is
 * unreadable: a verdict fished out of prose turned "NOT DUPLICATE" into
 * DUPLICATE, and a DUPLICATE folds the incoming write into an existing fact.
 * Unreadable is a failure the caller defers, never a guess.
 */
function parseClass(raw: string): SemanticClass | null {
  // A reasoning model may put its reasoning before the answer.
  const answer = raw
    .replace(/<THINK>[\s\S]*?<\/THINK>/g, "")
    .trim()
    .replace(/^[\s*_`"']+|[\s*_`"'.!]+$/g, "");
  return VALID_CLASSES.has(answer) ? (answer as SemanticClass) : null;
}

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Ask the LLM to classify the semantic relationship between two fact statements.
 *
 * Rejects with {@link FactPairClassificationError} when the LLM call fails or
 * its reply is not exactly one label. It never returns a guess.
 *
 * @param llm        - Any LLM with a `generate` method (see {@link FactPairClassifierLLM}).
 * @param statementA - The `statement` of the first fact.
 * @param statementB - The `statement` of the second fact.
 */
export async function classifyFactPair(
  llm: FactPairClassifierLLM,
  statementA: string,
  statementB: string
): Promise<ClassifyFactPairResult> {
  let raw: string;
  try {
    const response = await llm.generate({
      messages: [{ role: "user", content: buildClassificationPrompt(statementA, statementB) }],
      maxTokens: 50,
      temperature: 0,
      task: "judge",
    });
    raw = response.content.trim().toUpperCase();
  } catch (err) {
    throw new FactPairClassificationError(
      "llm_error",
      `fact-pair classification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const classification = parseClass(raw);
  if (!classification) {
    throw new FactPairClassificationError(
      "unrecognised_response",
      "fact-pair classification failed: the reply is not exactly one label",
      raw
    );
  }
  return { classification, confident: true, rawResponse: raw };
}
