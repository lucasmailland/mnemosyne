/**
 * Prospective memory evaluator — pure TypeScript, zero infrastructure imports.
 *
 * HEXAGONAL INVARIANT: This file MUST NOT import from drizzle-orm, postgres,
 * pg, redis, @neondatabase, or any other infrastructure package. All I/O is
 * delegated to the StorageAdapter port injected via ReminderEvalContext.
 *
 * Trigger logic:
 *   - Time trigger:      reminder.triggerAt is set AND triggerAt <= now
 *   - Semantic (vector): a query embedding (supplied or lazily fetched via
 *                        ctx.embedQuery) is available AND
 *                        cosine_sim(conditionEmbedding, queryEmbedding) >= 0.7
 *   - Semantic (LLM):    llm is provided and no embedding is available →
 *                        ask LLM "Does this context satisfy the condition? YES or NO"
 *   - Semantic (FTS):    fallback keyword match when neither embedding nor LLM is available
 *
 * REMIND-1 Part B: `condition` is now OPTIONAL on a reminder (nullable
 * column) — a reminder may be time-only, semantic-only, or both. Combination
 * rule:
 *   - Both `triggerAt` and `condition` present → AND: the reminder fires only
 *     once triggerAt has passed AND the semantic condition matches for that
 *     evaluation. A reminder must not fire on time alone if it also carries a
 *     semantic condition.
 *   - Only `triggerAt` present → fires once the clock has passed, no semantic
 *     check attempted.
 *   - Only `condition` present → the semantic match alone is sufficient.
 */

import type { LLMTask, StorageAdapter, MnemoReminder } from "@mnemo-ai/types";

// ─── Public interfaces ────────────────────────────────────────────────────────

/**
 * Minimal LLM interface the evaluator needs — only `generate()` for YES/NO condition
 * checks. Structurally compatible with `LLMAdapter` from `@mnemo-ai/types`, but
 * declared here as a narrow structural subset to preserve the hexagonal boundary.
 */
export interface ReminderLlmPort {
  generate(input: {
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    maxTokens?: number;
    temperature?: number;
    task?: LLMTask;
  }): Promise<{ content: string }>;
}

export interface ReminderEvalContext {
  /** Storage port — the evaluator never touches the DB directly. */
  storage: StorageAdapter;
  /** Workspace being queried. Used for RLS scoping inside the adapter. */
  workspaceId: string;
  /** Human-readable query text (used for logging / future keyword match). */
  queryText: string;
  /** Optional pre-computed embedding for the current query. Enables vector-based semantic trigger. */
  queryEmbedding?: Float32Array;
  /**
   * Optional LLM port for semantic condition evaluation.
   * When provided and a reminder has no conditionEmbedding, the evaluator asks
   * the LLM to judge whether the current queryText satisfies the condition.
   * Falls back to FTS keyword match when absent.
   */
  llm?: ReminderLlmPort;
  /** Override for "now" — useful in tests. Defaults to Date.now(). */
  nowMs?: number;
  /**
   * Lazy query embedder. Invoked AT MOST ONCE per evaluatePendingReminders()
   * call, and only when a pending reminder actually carries a
   * `conditionEmbedding` AND no `queryEmbedding` was supplied up front.
   * Resolve to `undefined` when no embedder is configured — the evaluator then
   * degrades to the LLM / FTS paths rather than guessing (B5.9: a missing
   * capability degrades visibly, never fabricates a match). Rejections are
   * caught and treated as `undefined` (fail-closed, same as llmConditionMatch).
   *
   * This exists so the recall hot path pays an embed round-trip ONLY when
   * there is genuinely something to compare against — zero pending reminders
   * (the common case) short-circuits before this is ever called.
   */
  embedQuery?: () => Promise<Float32Array | undefined>;
  /**
   * Cosine floor for the vector semantic path. Defaults to
   * {@link DEFAULT_SEMANTIC_THRESHOLD}.
   *
   * This is a property of the EMBEDDING MODEL, not of reminders, which is why
   * it is injectable rather than constant: cosine scales differ enough between
   * models that one number cannot serve them all. Measured on the same
   * should-fire / should-not-fire pair:
   *
   *   mxbai-embed-large   fires 0.7365   noise 0.5125   (gap 0.224)
   *   bge-m3              fires 0.6334   noise 0.3106   (gap 0.323)
   *
   * A 0.7 floor is right for the first and silently disables the second — the
   * reminder simply never triggers, with nothing logged, because not firing is
   * indistinguishable from having no match. Whoever selects the model selects
   * this alongside it.
   */
  semanticThreshold?: number;
}

export interface TriggeredReminder {
  id: string;
  content: string;
  /** REMIND-1 Part B: null on a time-only reminder (no semantic condition). */
  condition: string | null;
  /** Which trigger(s) fired: temporal, semantic, or both. */
  triggeredBy: "time" | "semantic" | "both";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two float vectors. Returns a value in [-1, 1].
 * Vectors must be non-zero-length; division by zero returns 0.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Default cosine floor for the vector semantic path.
 *
 * Kept at 0.7 — the value calibrated for `text-embedding-3-small` (the
 * documented default model) and `mxbai-embed-large`. Deployments on a model
 * with a different cosine scale override it via
 * `ReminderEvalContext.semanticThreshold`; see that field for the measurements.
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.7;

/**
 * LLM-based semantic condition check.
 *
 * Asks the LLM whether `context` satisfies `condition`. Returns true when the
 * LLM replies with a message that starts with "YES" (case-insensitive). Any
 * error from the LLM is caught and returns false (fail-closed — a broken LLM
 * must not trigger spurious reminders).
 */
async function llmConditionMatch(
  llm: ReminderLlmPort,
  condition: string,
  context: string
): Promise<boolean> {
  try {
    const result = await llm.generate({
      system:
        "You evaluate whether a context message satisfies a reminder condition. " +
        "Reply with exactly YES or NO and nothing else.",
      messages: [
        {
          role: "user",
          content:
            `Condition: "${condition}"\n\nContext: "${context}"\n\n` +
            "Does the context satisfy the condition? Answer YES or NO only.",
        },
      ],
      maxTokens: 5,
      temperature: 0,
      task: "judge",
    });
    return result.content.trim().toUpperCase().startsWith("YES");
  } catch {
    // Fail-closed: LLM errors must not cause spurious triggers.
    return false;
  }
}

/**
 * FTS keyword match — fallback when no embedding and no LLM.
 *
 * Extracts meaningful words (≥ 3 chars) from the condition string and checks
 * whether any of them appear in the context text (case-insensitive). This is
 * deliberately permissive: a single keyword match is sufficient. It handles
 * the common case where the condition is "when user mentions project X" and
 * the context contains "project X".
 */
function ftsKeywordMatch(condition: string, context: string): boolean {
  // Extract words that are at least 3 characters long, ignore common stopwords.
  const STOPWORDS = new Set([
    "the",
    "and",
    "for",
    "are",
    "but",
    "not",
    "you",
    "all",
    "can",
    "her",
    "was",
    "one",
    "our",
    "out",
    "day",
    "get",
    "has",
    "him",
    "his",
    "how",
    "man",
    "new",
    "now",
    "old",
    "see",
    "two",
    "way",
    "who",
    "boy",
    "did",
    "its",
    "let",
    "put",
    "say",
    "she",
    "too",
    "use",
    "when",
    "user",
    "this",
    "that",
    "with",
    "from",
    "have",
    "will",
    "been",
    "they",
    "then",
    "than",
    "what",
    "some",
    "there",
  ]);

  const words = condition
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  if (words.length === 0) return false;

  const ctxLower = context.toLowerCase();
  return words.some((word) => ctxLower.includes(word));
}

// ─── Core evaluation logic ────────────────────────────────────────────────────

/**
 * Evaluate all pending reminders for the workspace against the current query
 * context. For every reminder whose trigger condition(s) are satisfied
 * (AND when both triggerAt and condition are present, condition-only
 * otherwise — see module docstring):
 *   1. It is moved to status='triggered' via storage.dismissReminder().
 *   2. It is appended to the returned list.
 *
 * Semantic condition matching strategy (tried in order, first match wins):
 *   1. Vector cosine similarity — a query embedding is available (either
 *      passed in directly via ctx.queryEmbedding, or lazily fetched via
 *      ctx.embedQuery — at most once per call, memoized across all pending
 *      reminders) AND the reminder carries a conditionEmbedding
 *   2. LLM YES/NO judgment      — ctx.llm is provided and no embedding is available
 *   3. FTS keyword match        — fallback when neither embedding nor LLM is available
 *
 * REMIND-1: `memory_remind_when` promises this runs "en cada ciclo de
 * recall". `packages/server/src/recall/reminders.ts` is that caller — it
 * injects the triggered reminders into the recall result so the agent sees
 * them alongside retrieved memories, with a real query embedding when one is
 * available. The background boot poller (packages/server/src/index.ts) is
 * now a TIME-ONLY sweep: it passes an empty queryText, which makes the FTS
 * path structurally unreachable, and its discovery query only visits
 * reminders with no `condition` at all — every compound (time+condition) or
 * semantic-only reminder is evaluated exclusively on the recall path, which
 * has a real query to judge the condition against.
 */
export async function evaluatePendingReminders(
  ctx: ReminderEvalContext
): Promise<TriggeredReminder[]> {
  const now = new Date(ctx.nowMs ?? Date.now());

  const pending = await ctx.storage.listPendingReminders(ctx.workspaceId, now);

  if (pending.length === 0) return [];

  const triggered: TriggeredReminder[] = [];
  const semanticThreshold = ctx.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;

  // Memoized across the whole batch — one embed call per evaluation, max.
  let resolvedQueryEmbedding = ctx.queryEmbedding;
  let embedAttempted = ctx.queryEmbedding !== undefined;

  for (const reminder of pending) {
    const hasTimeTrigger = reminder.triggerAt !== null;
    const timeMatch = hasTimeTrigger && reminder.triggerAt! <= now;

    // REMIND-1 Part B: `condition` is nullable now (time-only reminders).
    // Treat null/blank as "no semantic condition" — NOT as "an unsatisfiable one".
    const condition = reminder.condition ?? "";
    const hasCondition = condition.trim().length > 0;

    const condEmbeddingRaw =
      reminder.conditionEmbedding !== null && reminder.conditionEmbedding.length > 0
        ? reminder.conditionEmbedding
        : null;

    let semanticMatch = false;
    if (hasCondition) {
      if (condEmbeddingRaw !== null && !embedAttempted && ctx.embedQuery !== undefined) {
        embedAttempted = true;
        try {
          resolvedQueryEmbedding = await ctx.embedQuery();
        } catch {
          resolvedQueryEmbedding = undefined;
        }
      }

      if (resolvedQueryEmbedding !== undefined && condEmbeddingRaw !== null) {
        // Path 1: vector cosine similarity (most accurate, zero LLM cost)
        const condEmbedding = new Float32Array(condEmbeddingRaw);
        const similarity = cosineSimilarity(resolvedQueryEmbedding, condEmbedding);
        semanticMatch = similarity >= semanticThreshold;
      } else if (ctx.llm !== undefined && ctx.queryText.length > 0) {
        // Path 2: LLM YES/NO judgment
        semanticMatch = await llmConditionMatch(ctx.llm, condition, ctx.queryText);
      } else if (ctx.queryText.length > 0) {
        // Path 3: FTS keyword fallback — deterministic, no external calls.
        // NOTE: an empty queryText makes this structurally unreachable. That
        // is how the background poller stays fail-closed BY CONSTRUCTION
        // rather than by the accident that its old "[background-poll]"
        // placeholder happened never to share a keyword with any real
        // condition.
        semanticMatch = ftsKeywordMatch(condition, ctx.queryText);
      }
    }

    let fires: boolean;
    let triggeredBy: TriggeredReminder["triggeredBy"];
    if (hasTimeTrigger && hasCondition) {
      // AND (unchanged, 2026-07-27): a compound reminder must not fire on the
      // clock alone with unrelated context. Only the recall path can satisfy it.
      fires = timeMatch && semanticMatch;
      triggeredBy = "both";
    } else if (hasTimeTrigger) {
      fires = timeMatch;
      triggeredBy = "time";
    } else if (hasCondition) {
      fires = semanticMatch;
      triggeredBy = "semantic";
    } else {
      // Neither trigger — rejected at creation; defensive no-op.
      fires = false;
      triggeredBy = "semantic";
    }
    if (!fires) continue;

    // Transition to 'triggered' state — dismissReminder is a status update,
    // the row is never deleted (security invariant: no DELETE).
    await ctx.storage.dismissReminder(reminder.id, ctx.workspaceId, "triggered");

    triggered.push({
      id: reminder.id,
      content: reminder.content,
      condition: reminder.condition,
      triggeredBy,
    });
  }

  return triggered;
}
