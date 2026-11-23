// Generative replay validator (TASK-12002, AUDIT_REPORT.md NEW-06; B6.35 evaluative).
//
// After consolidation applies a merged fact, the validator EVALUATES whether the
// survivor can still be recalled. It performs NO durable write — it only selects
// queries, runs recall, and returns an outcome. The scheduler
// (`mergeClusterWithReplay`) owns every durable merge/finalize/rollback decision.
//
// Query sample (B6.35 §Consolidation Flow):
//   - use up to ten distinct recent real queries;
//   - when fewer than five remain, generate exactly the shortfall to reach five;
//   - require five distinct total, otherwise `skipped`.
//
// Outcome (fail-first ratios over the completed sample):
//   - fail / total >= 0.60           → flagged
//   - else pass / total >= 0.80      → boosted
//   - else                           → neutral
//
// Any infrastructure failure (generation rejection, malformed/insufficient
// generation, recall rejection, progress rejection) → `skipped`; infrastructure
// errors are NEVER converted into quality misses.

import type { LLMTask, MnemoFact } from "@mnemo-ai/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal LLM interface the validator needs.
 *
 * The validator-facing message role union is deliberately explicit
 * (`user | assistant | system`). The server bridge (Task 6) performs the typed
 * transformation into the adapter's `LLMInput`; do NOT add a `Function` role or
 * cast here.
 */
export interface ValidatorLLM {
  /** Tasks answered by a provider the operator runs locally (`LLMAdapter.localTasks`). */
  readonly localTasks?: readonly LLMTask[];
  generate(opts: {
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    maxTokens: number;
    temperature: number;
    task?: LLMTask;
  }): Promise<{ content: string; tokensUsed: { input: number; output: number } }>;
}

/** Minimal vector recall interface the validator needs. */
export interface ValidatorRecall {
  search(opts: {
    workspaceId: string;
    text: string;
    limit: number;
  }): Promise<Array<{ id: string; score: number }>>;
}

/**
 * Storage surface the validator needs.
 *
 * Validation performs NO durable write, so this exposes ONLY the read used to
 * prefer real historical queries over synthetic ones.
 */
export interface ValidatorStorage {
  /**
   * Return up to `limit` distinct query texts from the recall log whose fact_id
   * matches any of `factIds`, ordered by recalled_at DESC (most recent first).
   * Returns an empty array when the log is empty or no matching rows exist.
   */
  getRecentQueriesForFacts(
    workspaceId: string,
    factIds: string[],
    limit: number
  ): Promise<string[]>;
}

export interface ReplayValidatorContext {
  llm: ValidatorLLM;
  recall: ValidatorRecall;
  storage: ValidatorStorage;
}

export interface ReplayResult {
  /** Terminal evaluation of the completed (or interrupted) replay. */
  status: "boosted" | "neutral" | "flagged" | "skipped";
  passCount: number;
  failCount: number;
  /**
   * Completed replay: the full planned query sample.
   * Interrupted replay (recall/progress rejection): only the attempted prefix.
   * A rejected recall includes its query; a rejected pre-query progress does not.
   */
  queriesUsed: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TOP_K = 3;
const MAX_REAL_QUERIES = 10;
const MIN_QUERIES = 5;
const FAIL_RATIO_FLAGGED = 0.6; // fail / total >= 0.60 → flagged
const PASS_RATIO_BOOSTED = 0.8; // pass / total >= 0.80 → boosted

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildQueryGenPrompt(statement: string, count: number): string {
  return [
    `Generate ${count} diverse recall queries that should retrieve the following fact from a memory system.`,
    "Each query should be phrased differently (as a question, search term, or paraphrase).",
    `Return ONLY a JSON array of ${count} strings, no other text.`,
    "",
    `Fact: "${statement}"`,
  ].join("\n");
}

/** Trim, drop empties, and dedupe (preserving order), capping at `max`. */
function dedupeTrim(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const q = raw.trim();
    if (q === "" || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/** Parse the LLM response as a JSON string array. Returns null when malformed. */
function parseGeneratedQueries(content: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((q) => typeof q === "string")) {
    return null;
  }
  return parsed as string[];
}

function skipped(queriesUsed: string[], pass = 0, fail = 0): ReplayResult {
  return { status: "skipped", passCount: pass, failCount: fail, queriesUsed };
}

// ─── Validator ────────────────────────────────────────────────────────────────

export async function validateMergedFact(
  fact: MnemoFact,
  ctx: ReplayValidatorContext,
  absorbedFactIds: string[] = [],
  options: { onProgress?: () => Promise<void> } = {}
): Promise<ReplayResult> {
  const { onProgress } = options;
  const allFactIds = [fact.id, ...absorbedFactIds];

  // 1. Prefer up to ten distinct recent real queries.
  let realQueries: string[] = [];
  try {
    realQueries = await ctx.storage.getRecentQueriesForFacts(
      fact.workspaceId,
      allFactIds,
      MAX_REAL_QUERIES
    );
  } catch {
    // Historical-query lookup is non-fatal — fall through to synthetic generation.
    realQueries = [];
  }
  const planned = dedupeTrim(realQueries ?? [], MAX_REAL_QUERIES);

  // 2. Generate exactly the shortfall when fewer than five distinct remain.
  if (planned.length < MIN_QUERIES) {
    const shortfall = MIN_QUERIES - planned.length;
    let out: { content: string };
    try {
      out = await ctx.llm.generate({
        messages: [{ role: "user", content: buildQueryGenPrompt(fact.statement, shortfall) }],
        maxTokens: 512,
        temperature: 0.7,
        task: "default",
      });
    } catch {
      return skipped([]); // generation rejection
    }
    const generated = parseGeneratedQueries(out.content);
    if (generated === null) return skipped([]); // malformed / non-string generation
    // Merge generated queries into the planned set, keeping distinctness.
    const seen = new Set(planned);
    for (const raw of generated) {
      if (planned.length >= MIN_QUERIES) break;
      const q = raw.trim();
      if (q === "" || seen.has(q)) continue;
      seen.add(q);
      planned.push(q);
    }
  }

  // Require five distinct total; otherwise the sample is insufficient.
  if (planned.length < MIN_QUERIES) return skipped([]);

  // 3. Run recall over the planned sample. Append each query immediately BEFORE
  //    recall — after its pre-query progress callback succeeds — so a rejected
  //    recall includes the query but a rejected pre-query progress does not.
  const attempted: string[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const query of planned) {
    if (onProgress) {
      try {
        await onProgress();
      } catch {
        return skipped([...attempted], passCount, failCount); // progress rejection
      }
    }
    attempted.push(query);
    let hits: Array<{ id: string; score: number }>;
    try {
      hits = await ctx.recall.search({ workspaceId: fact.workspaceId, text: query, limit: TOP_K });
    } catch {
      return skipped([...attempted], passCount, failCount); // recall rejection
    }
    if (hits.some((h) => h.id === fact.id)) passCount++;
    else failCount++;
  }

  // 4. Completed sample — evaluate failure before success.
  const total = planned.length;
  let status: ReplayResult["status"];
  if (failCount / total >= FAIL_RATIO_FLAGGED) status = "flagged";
  else if (passCount / total >= PASS_RATIO_BOOSTED) status = "boosted";
  else status = "neutral";

  return { status, passCount, failCount, queriesUsed: planned };
}
