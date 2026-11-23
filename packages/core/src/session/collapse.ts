/**
 * Session collapse pipeline — converts ephemeral conversation turns into durable memory.
 * COGNITIVE_ALGORITHMS.md §2.2.
 *
 * Steps:
 *   1. Load session + turns from storage
 *   2. Minimum viability: skip sessions with < minTurnsForCollapse (default 3)
 *   3. RecMem gate: mean-of-max pairwise cosine similarity measures thematic
 *      coherence. A single-topic session has high mean-of-max (each turn is similar
 *      to at least one other turn). Scattered unrelated turns produce low mean-of-max.
 *      High coherence predicts durable knowledge worth extracting; skip otherwise.
 *   4. Single LLM call → structured SessionCollapseSummary (facts, decisions, strategies)
 *      Single call to avoid multiple LLM round-trips; temperature=0.1 for repeatability.
 *   5. Surprise gate (prediction error) per extracted fact:
 *        PE = 1 − max_similarity_to_existing_knowledge
 *      PE close to 0 means the fact is already known → skip it (not novel enough).
 *      PE close to 1 means genuinely new information → persist it.
 *      Threshold is config.surpriseThreshold (default 0.3 — tunable per deployment).
 *   6. Plan: topic-key collisions resolved, surprise gate, episode narrative —
 *      every read, embedding and search happens before the first write.
 *   7. Atomic persist (LIFECYCLE-8): facts, decisions, strategies, Hebbian
 *      co-occurrence edges (every pair of facts from the session gets "related",
 *      seeding recall's stage-3 relation expansion), the episode, fact→episode
 *      links, the summary and the session's `collapsed` status commit in ONE
 *      transaction via `storage.commitSessionCollapse`. Any failure rolls all of
 *      it back and leaves the session retryable. The same commit re-checks the
 *      session under a row lock, so a session collapses once (LIFECYCLE-7).
 *      Adapters without the port method get the same writes, non-atomically.
 *   8. Post-commit enrichment (hyperedges, hot tier, worth, reflection) —
 *      best-effort; return CollapseResult.
 *
 * Graceful degradation: LLM unavailable → status "failed", session preserved for retry.
 */

import type {
  AuthContext,
  SessionTurn,
  CreateFactInput,
  CreateDecisionInput,
  CreateStrategyInput,
  CreateEpisodeInput,
  MergeDecisionByTopicKeyInput,
  MnemoFact,
  StorageAdapter,
} from "@mnemo-ai/types";
import { PRIMITIVE_SUBTYPES } from "@mnemo-ai/types";
import type { CoreContext } from "../cognitive/context.js";
import { recurrenceSignal } from "../cognitive/recmem.js";
import { reportLlmUsage } from "../cognitive/llm-usage.js";
import { extractionBiasHint } from "../cognitive/knowledge-scheduler.js";
import type { CollapseOutcome } from "../cognitive/outcome.js";
import { OUTCOME_WEIGHTS } from "../cognitive/outcome.js";
import {
  computeOutcome,
  explicitSignal,
  heuristicSignal,
  taskCompletionSignal,
  type OutcomeSignal,
} from "../cognitive/outcome-signal.js";
import { propagateTdCredit } from "../cognitive/worth.js";
import { uniqueViolationConstraint } from "../cognitive/remember.js";
import { gatesFor } from "../cognitive/learningMode.js";
import { runReflectionCycle, REFLECTION_CADENCE } from "../cognitive/self-reflect.js";
import { workKey } from "./working-memory.js";
import { ANTICIPATION_SLOT } from "./anticipation-preinject.js";
import { computeAnticipationAccuracy, type AnticipationSlot } from "./anticipation-accuracy.js";
import { parseJsonReply } from "../llm/parse-json-reply.js";

// ─── Public API types ─────────────────────────────────────────────────────────

export type CollapseReason = "inactivity" | "explicit" | "max_turns" | "max_tokens";

/**
 * RDD-4: Hybrid extraction policy — controls per-turn / collapse dedup behaviour.
 *
 * In "hybrid" mode per-turn facts are tagged extraction_source="per_turn". At collapse,
 * any candidate fact whose topic_key already exists in the per-turn set for this session
 * is skipped (collapseSkipsExisting=true), preventing double-write of the same knowledge.
 */
export interface HybridExtractionPolicy {
  /**
   * Which kinds of facts to extract per-turn.
   * "decisions_only" — only decision-type extractions per turn (default).
   * "all" — extract all kinds per turn.
   */
  perTurnExtracts?: "decisions_only" | "all";
  /**
   * When true (default), collapse skips any output whose topic_key already exists
   * among per-turn facts for this session.
   */
  collapseSkipsExisting?: boolean;
}

export interface CollapsePolicy {
  mode?: "auto" | "explicit" | "hybrid";
  inactivityTimeout?: number;
  maxTurns?: number;
  maxTokens?: number;
  minTurnsForCollapse?: number; // default 3
  requirePin?: boolean;
  extractFacts?: boolean;
  extractDecisions?: boolean;
  extractStrategies?: boolean;
  extractTasks?: boolean;
  recurrenceThreshold?: number; // default 0.6
  skipLlmIfBelowThreshold?: boolean; // default true
  /** RDD-4: hybrid mode dedup policy. Only effective when mode="hybrid". */
  hybridPolicy?: HybridExtractionPolicy;
}

export interface CollapseInput {
  sessionId: string;
  workspaceId: string;
  agentId?: string;
  reason?: CollapseReason;
  collapseHint?: string;
  policy?: CollapsePolicy;
  /**
   * RDD-5: cold-start learning mode gate.
   * When true, the workspace IS in learning mode → worth updates are DISABLED
   * (spec: worthUpdatesDisabled=true during learning mode — avoids premature convergence
   * on near-zero data). Previously this flag had inverted semantics; RDD-5 corrects it.
   *
   * Callers must pass `true` when the workspace is in learning mode.
   * Default (undefined/false) → worth updates run (production mode).
   */
  learningMode?: boolean;
  /** Internal snapshot fence, populated after loading durable turns. */
  expectedTurnCount?: number;
}

export interface CollapseResult {
  status: "skipped" | "completed" | "failed";
  skipReason?: "too_few_turns" | "low_recurrence_signal" | "llm_unavailable" | "no_pin";
  factsCreated: number;
  decisionsCreated: number;
  strategiesCreated: number;
  episodeId?: string;
  /** §11 governance.propagate trigger — the LLM's rated session outcome. Present only on status="completed". */
  outcome?: "resolved" | "partial" | "abandoned" | "failed" | "delegated";
  llmTokensUsed: number;
  /** Number of turns processed (used by the route layer to observe sessionTurnsHistogram). */
  turnsProcessed?: number;
  /**
   * §30 anticipation accuracy feedback: fraction of pre-staged anticipated
   * memories that were found in the extracted fact set. Present only on
   * status="completed" when anticipation pre-injection had run for this session.
   * null when anticipation data was unavailable (no cache, or no prior injection).
   */
  anticipationAccuracy?: number | null;
  /**
   * LIFECYCLE-7: true when the session was already collapsed (before this call,
   * or by a concurrent call that committed first). Nothing was written; the
   * counts are zero because THIS call created nothing.
   */
  alreadyCollapsed?: boolean;
  /**
   * Review round: a skip whose archive was committed together with its
   * provenance episode. The facade does not archive the session again.
   */
  archived?: boolean;
}

// ─── LLM output schema ────────────────────────────────────────────────────────

interface ExtractedFact {
  content: string;
  confidence?: number;
  topicKey?: string;
  subject?: string;
  /** Untrusted model output, like the decision kind: coerced by {@link coerceFactKind}. */
  kind?: string;
}

interface ExtractedDecision {
  title: string;
  body: string;
  /**
   * P132 — `string`, not the union, ON PURPOSE. This object comes out of
   * `JSON.parse` of an LLM reply: declaring it as the union made TypeScript
   * assert something nothing had checked, and that false assurance is what let
   * an invented `"deployment"` reach the INSERT. Coerced by
   * {@link coerceDecisionKind} at the point of use.
   */
  kind?: string;
  topicKey?: string;
}

interface ExtractedStrategy {
  trigger: string;
  action: string;
  context?: string;
}

/**
 * Output budget for the summary call. 2048 truncated every summary of a session
 * with a few hundred turns (facts + decisions + strategies + discoveries), and
 * 8192 still truncated the largest one in production.
 */
const COLLAPSE_SUMMARY_MAX_TOKENS = 16384;

interface SessionCollapseSummary {
  goal?: string;
  /** P132 — untrusted LLM output; see {@link coerceOutcome}. */
  outcome: string;
  facts: ExtractedFact[];
  decisions: ExtractedDecision[];
  strategies: ExtractedStrategy[];
  discoveries?: string[];
  nextSteps?: string[];
  relevantEntities?: string[];
  keyDecisions?: string[];
  llmTokensUsed: number;
}

// ─── Helper functions (exported for testing) ──────────────────────────────────

/** APP-061: the missing-getFact skip is logged once per process. */
let warnedNoGetFact = false;

/**
 * §Hyperedge extraction: after session collapse, ask the LLM to identify n-ary
 * relations among the newly-created facts and persist each group as a hyperedge.
 *
 * Non-fatal: any error (JSON parse failure, LLM timeout, storage error) is
 * caught and logged as a warning. Never throws.
 *
 * No-op when:
 *   - ctx.llm is absent (LLM unavailable)
 *   - fewer than 3 fact IDs were created (not enough members for a hyperedge)
 *   - the storage adapter has no getFact (the prompt could not list the facts)
 */
export async function extractConsolidationHyperedges(
  ctx: CoreContext,
  workspaceId: string,
  createdFactIds: string[],
  turnsText: string
): Promise<void> {
  if (!ctx.llm || createdFactIds.length < 3) return;
  // APP-061: without getFact the prompt could only list indices, never the
  // facts behind them — the fact-less prompt the model answered in prose. Skip
  // the pass instead, and say so once per process.
  const getFact = ctx.storage.getFact?.bind(ctx.storage);
  if (!getFact) {
    if (!warnedNoGetFact) {
      warnedNoGetFact = true;
      ctx.logger.warn("collapse: hyperedge_extract_skipped — storage adapter has no getFact", {
        operation: "collapse.hyperedge_extract",
      });
    }
    return;
  }
  try {
    // APP-061: the prompt used to announce "facts indexed 0 to N" without
    // listing them, so a model had nothing to group and answered in prose
    // (the local default model did every time). Each fact is now listed.
    const listed = await Promise.all(
      createdFactIds.map(async (id, i) => {
        const fact = await getFact(id, workspaceId).catch(() => null);
        return `${i}: ${(fact?.statement ?? "").replace(/\s+/g, " ").slice(0, 300)}`;
      })
    );
    const prompt = [
      "Below are newly-consolidated facts indexed 0 to " + (createdFactIds.length - 1) + ".",
      ...listed,
      "Return a JSON array of arrays of INDICES (0-based); each inner array is a group of facts that together form a single n-ary relation.",
      "Only include groups of 3 or more. Return [] if none. Example: [[0,1,2],[1,3,4]]",
      "Answer with only the JSON array: no prose, no explanation, no code fence.",
      "Context: " + turnsText.slice(0, 500),
    ].join("\n");
    const out = await ctx.llm.generate({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 256,
      temperature: 0,
      task: "summary",
    });
    const raw = out.content.trim();
    // P124: models fence their JSON; the raw parse turned that into a thrown
    // error and lost the whole grouping pass.
    const groups: number[][] = parseJsonReply<number[][]>(raw, "collapse.groups");
    for (const group of groups) {
      if (!Array.isArray(group) || group.length < 3) continue;
      const memberIds = group
        .map((i) => createdFactIds[i])
        .filter((id): id is string => Boolean(id));
      if (memberIds.length < 3) continue;
      await ctx.storage.createHyperedge({
        workspaceId,
        memberIds,
        label: "auto-consolidated",
        description: "Auto-extracted n-ary relation during session consolidation",
      });
    }
  } catch (err) {
    ctx.logger.warn("collapse: hyperedge_extract_failed (non-fatal)", {
      operation: "collapse.hyperedge_extract",
      error: { type: "HyperedgeExtractError", message: String(err) },
    });
  }
}

export function estimateTokens(turn: SessionTurn): number {
  if (typeof turn.tokenCount === "number") return turn.tokenCount;
  return Math.ceil(turn.content.length / 4);
}

export function countPinnedTurns(turns: SessionTurn[]): number {
  return turns.reduce((n, t) => (t.pinned ? n + 1 : n), 0);
}

export function requirePinSatisfied(requirePin: boolean, turns: SessionTurn[]): boolean {
  return !requirePin || countPinnedTurns(turns) >= 1;
}

/**
 * Single read path for the collapse pipeline. When a SessionBuffer is wired on
 * the context, read turns through its DURABLE (PG-backed) accessor so the buffer
 * is the canonical read surface for sessions (§7 step 1) WITHOUT sacrificing the
 * exact pin flags / token counts that only the PG rows carry. No buffer → read
 * straight from storage (unchanged behaviour).
 */
export async function resolveCollapseTurns(
  ctx: {
    storage: { listTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> };
    sessionBuffer?: {
      getDurableTurns(workspaceId: string, sessionId: string): Promise<SessionTurn[]>;
    };
  },
  workspaceId: string,
  sessionId: string
): Promise<SessionTurn[]> {
  if (ctx.sessionBuffer) {
    return ctx.sessionBuffer.getDurableTurns(workspaceId, sessionId);
  }
  return ctx.storage.listTurns(sessionId, workspaceId);
}

export function resolveCollapseReason(
  state: { turnCount: number; tokenCount: number; ageSeconds: number },
  policy: { maxTurns: number; maxTokens: number; inactivityTimeout: number }
): CollapseReason | null {
  if (state.turnCount >= policy.maxTurns) return "max_turns";
  if (state.tokenCount >= policy.maxTokens) return "max_tokens";
  if (state.ageSeconds >= policy.inactivityTimeout) return "inactivity";
  return null;
}

export function mergeScratch(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...(base ?? {}), ...patch };
}

// ─── Collapse prompt builder ──────────────────────────────────────────────────

export function conversationalTurnsForRecurrence(turns: SessionTurn[]): SessionTurn[] {
  return turns.filter(
    (t) =>
      !["agent_message", "task_notification", "pasted_content"].includes(t.turnOrigin ?? "unknown")
  );
}

export function buildCollapsePrompt(turns: SessionTurn[], collapseHint?: string): string {
  const turnText = turns
    .map(
      (t) =>
        `[${t.role.toUpperCase()} turn ${t.turnIndex}; origin=${t.turnOrigin ?? "unknown"}; evidence=${JSON.stringify(t.turnOriginEvidence ?? "unclassified")}]: ${t.content}`
    )
    .join("\n\n");

  const hintBlock = collapseHint ? `\nCOLLAPSE HINT FROM CALLER:\n${collapseHint}\n` : "";

  return [
    "You are a memory extraction assistant. Your task is to extract durable",
    "knowledge from a conversation session. Extract ONLY facts, decisions, and",
    "strategies that represent lasting knowledge worth remembering. Ignore",
    "transient coordination messages and greetings.",
    "Content origin is independent of role and authenticated actor. Agent messages, task notifications and pasted content are not the human user speaking; unknown origin must not be attributed to that user.",
    // LIFECYCLE-13: three overlapping lists with no rule between them produced
    // fact + decision + strategy for one rule (69 rows for 27 items, measured),
    // and strategies the conversation never stated. LIFECYCLE-10: with no
    // permission to return nothing, small talk came back as five junk rows.
    "Put each piece of knowledge in exactly ONE of facts, decisions or strategies:",
    "a decision when it is a choice made with a reason, a strategy only for a",
    "reusable when-X-do-Y rule that the conversation itself states or",
    "demonstrates, and a fact otherwise. Do not restate a decision as a fact or a",
    "strategy. Only extract what the conversation says — never invent strategies,",
    "values or reasons, and do not present a value the conversation replaced as",
    "current. If the session holds nothing worth remembering beyond today (small",
    "talk, greetings, coordination), return empty facts, decisions and strategies.",
    "",
    // Lexical recall matches query words against stored text, so a fact
    // translated to English is invisible to a Spanish query.
    "Write goal, facts, decisions and strategies (trigger and action too) in the",
    "same language as the conversation (the language the user writes in). Do not",
    "translate them, even where the examples below are in English.",
    "Keep code, identifiers, file paths and quoted terms verbatim.",
    "Write every topicKey as a lowercase English kebab-case slug, and use the",
    "outcome and kind values exactly as listed below.",
    // LIFECYCLE-3: generic keys (`deployment-tool` for two different services)
    // make one project's fact supersede another's, workspace-wide.
    "A topicKey names the subject and the attribute, never the value",
    "(ledger-api-deploy-day, not deploy-day or deploys-on-tuesday); reuse the same",
    "key whenever the same attribute of the same subject comes up again.",
    hintBlock,
    // LIFECYCLE-9: this block used to read `"confidence": 0.0-1.0` and
    // `"outcome": "resolved|partial|…"` — a template that is not JSON. Small
    // models copy templates literally, and 4 of 5 failed replies measured with
    // a 4B model contained `"confidence": 0",`. The example below must stay
    // valid JSON (a test parses it); the allowed values live in the rules.
    "Reply with ONLY one JSON object, with no text before or after it, shaped",
    "like this example (the values are illustrations — replace them):",
    "{",
    '  "goal": "one sentence: what this session was trying to accomplish",',
    '  "outcome": "resolved",',
    '  "facts": [{ "content": "ledger-api deploys only on Tuesdays", "kind": "policy", "confidence": 0.9, "topicKey": "ledger-api-deploy-day", "subject": "ledger-api" }, { "content": "The user wants code reviews in Spanish", "kind": "preference", "confidence": 0.8, "subject": "user" }],',
    '  "decisions": [{ "title": "Deploy ledger-api with Argo CD", "body": "the rationale, in full", "kind": "decision", "topicKey": "ledger-api-deploy-tool" }],',
    '  "strategies": [{ "trigger": "a ledger-api deploy fails", "action": "roll back before debugging", "context": "production" }],',
    '  "relevantEntities": ["ledger-api", "Argo CD"],',
    '  "discoveries": ["the deploy job ignored the freeze calendar"],',
    '  "nextSteps": ["add the freeze calendar check to the deploy job"]',
    "}",
    "",
    "Field rules:",
    "- outcome: exactly one of resolved, partial, abandoned, failed, delegated.",
    "- confidence: a plain number from 0 to 1, such as 0.9.",
    // LIFECYCLE-5: the fact kind was never asked for and hardcoded to `other`.
    "- fact kind: exactly one of preference (what someone likes or wants), trait (how someone is",
    "  or works), event (something that happened), relationship (how people, teams or systems",
    "  relate), skill (what someone can do), concern (a risk, worry or open problem),",
    "  architecture (how a system is built or fits together), bugfix (a defect and its root cause",
    "  or fix), config (a setting, value, version or environment detail), discovery (a non-obvious",
    "  behaviour or gotcha that was learned), policy (a standing rule or convention), process (how",
    "  something is done: steps, workflow, procedure), other (only when none of these fits).",
    "- decision kind: exactly one of decision, architecture, policy, process, bugfix, learning, discovery, config.",
    "- relevantEntities: the projects, services, people and tools the session was about, as short names.",
    "- discoveries and nextSteps: at most five short items each.",
    "- topicKey, subject and context are optional: leave a field out rather than writing null or an empty string.",
    "- Any list may be empty ([]) when the session holds nothing of that kind.",
    "",
    "SESSION TURNS:",
    "",
    turnText,
  ].join("\n");
}

// ─── Extraction reply validation (LIFECYCLE-9) ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => nonEmptyString(v) !== undefined);
}

/**
 * LIFECYCLE-9 — check the SHAPE of the parsed reply before anything reads it.
 *
 * It used to be cast (`parseJsonReply<SessionCollapseSummary>`) and trusted.
 * A `facts` that came back as a string was then iterated character by
 * character, and an item without `content` reached the INSERT. The reply is
 * model output; its shape is a claim like any other.
 *
 * Two levels, on purpose:
 *   - a reply that is not an object, or whose lists are not lists, is unusable
 *     as a whole: it throws, which earns the extraction its one retry;
 *   - a malformed ITEM is dropped and the rest are kept — one bad fact must not
 *     cost the session's other twenty. The drop is reported, not silent.
 */
export function validateCollapseSummary(
  value: unknown,
  onDropped?: (list: "facts" | "decisions" | "strategies", count: number) => void
): SessionCollapseSummary {
  if (!isRecord(value)) {
    throw new Error("invalid_extraction: the reply is not a JSON object");
  }
  const list = (name: "facts" | "decisions" | "strategies"): unknown[] => {
    const raw = value[name];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`invalid_extraction: "${name}" is not a list`);
    return raw;
  };
  const rawFacts = list("facts");
  const rawDecisions = list("decisions");
  const rawStrategies = list("strategies");

  const facts: ExtractedFact[] = [];
  for (const item of rawFacts) {
    if (!isRecord(item)) continue;
    const content = nonEmptyString(item.content);
    if (!content) continue;
    const fact: ExtractedFact = { content };
    if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
      fact.confidence = Math.min(1, Math.max(0, item.confidence));
    }
    const topicKey = nonEmptyString(item.topicKey);
    if (topicKey) fact.topicKey = topicKey;
    const subject = nonEmptyString(item.subject);
    if (subject) fact.subject = subject;
    const kind = nonEmptyString(item.kind);
    if (kind) fact.kind = kind;
    facts.push(fact);
  }

  const decisions: ExtractedDecision[] = [];
  for (const item of rawDecisions) {
    if (!isRecord(item)) continue;
    const title = nonEmptyString(item.title);
    const body = nonEmptyString(item.body);
    if (!title || !body) continue;
    const decision: ExtractedDecision = { title, body };
    const kind = nonEmptyString(item.kind);
    if (kind) decision.kind = kind;
    const topicKey = nonEmptyString(item.topicKey);
    if (topicKey) decision.topicKey = topicKey;
    decisions.push(decision);
  }

  const strategies: ExtractedStrategy[] = [];
  for (const item of rawStrategies) {
    if (!isRecord(item)) continue;
    const trigger = nonEmptyString(item.trigger);
    const action = nonEmptyString(item.action);
    if (!trigger || !action) continue;
    const strategy: ExtractedStrategy = { trigger, action };
    const context = nonEmptyString(item.context);
    if (context) strategy.context = context;
    strategies.push(strategy);
  }

  if (onDropped) {
    if (rawFacts.length > facts.length) onDropped("facts", rawFacts.length - facts.length);
    if (rawDecisions.length > decisions.length)
      onDropped("decisions", rawDecisions.length - decisions.length);
    if (rawStrategies.length > strategies.length)
      onDropped("strategies", rawStrategies.length - strategies.length);
  }

  const summary: SessionCollapseSummary = {
    outcome: typeof value.outcome === "string" ? value.outcome : "",
    facts,
    decisions,
    strategies,
    llmTokensUsed: 0,
  };
  const goal = nonEmptyString(value.goal);
  if (goal) summary.goal = goal;
  for (const key of ["discoveries", "nextSteps", "relevantEntities", "keyDecisions"] as const) {
    const items = stringList(value[key]);
    if (items) summary[key] = items;
  }
  return summary;
}

/** One corrective retry; a second unusable reply fails the collapse (session kept for retry). */
const EXTRACTION_ATTEMPTS = 2;

/**
 * LIFECYCLE-9 — the summary call, with ONE bounded retry for a reply that
 * parsed badly or had the wrong shape.
 *
 * Measured with a 4B model: 18.5% of collapses failed on invalid JSON, and the
 * failure was final — the session sat `active` until the sweep gave up. The
 * retry re-sends the same prompt plus a note naming what was wrong; it does
 * not echo the bad reply back (that doubles the input for a 16k-token reply,
 * and two consecutive user messages are not valid on every provider).
 *
 * Not retried, deliberately: a provider error (the sweep's backoff owns that)
 * and a reply truncated at the output budget (a second call hits the same
 * budget). Both calls are reported to usage metrics and counted.
 */
async function extractCollapseSummary(
  ctx: CoreContext,
  llm: NonNullable<CoreContext["llm"]>,
  prompt: string
): Promise<SessionCollapseSummary> {
  let tokensUsed = 0;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt++) {
    const content =
      attempt === 1
        ? prompt
        : `${prompt}\n\nIMPORTANT: a previous answer to this task could not be used ` +
          `(${(lastError?.message ?? "invalid reply").slice(0, 300)}). Reply with ONLY one ` +
          "valid JSON object as specified above: plain numbers, double-quoted strings, no " +
          "comments, no trailing commas and no text outside the object.";
    const llmOut = await llm.generate({
      messages: [{ role: "user", content }],
      maxTokens: COLLAPSE_SUMMARY_MAX_TOKENS,
      temperature: attempt === 1 ? 0.1 : 0,
      task: "summary",
    });
    // Report token + cost usage to the host's metrics layer (completion path).
    // Fire-and-forget: a metrics failure must never break session collapse.
    reportLlmUsage(
      ctx,
      llm.id,
      llmOut.model,
      llmOut.tokensUsed.input,
      llmOut.tokensUsed.output,
      llmOut.costUSD
    );
    tokensUsed += llmOut.tokensUsed.input + llmOut.tokensUsed.output;
    if (llmOut.finishReason === "length") {
      // A cut-off reply is never valid JSON; say so, or the log blames the parser.
      throw new Error(
        `collapse.summary: reply truncated at ${COLLAPSE_SUMMARY_MAX_TOKENS} output tokens`
      );
    }
    try {
      // P124: this is the one that surfaced it — a fenced reply 503'd the whole
      // collapse and left a four-turn session unextracted.
      const parsed = parseJsonReply<unknown>(llmOut.content, "collapse.summary");
      // Review round: an item validation had to drop is knowledge the model
      // DID find (`{"statement": …}` instead of `{"content": …}`), not an
      // empty answer. Completing without it would lose it for good — the
      // collapse is idempotent now, so nothing re-extracts a collapsed
      // session. A reply with dropped items earns the retry like a malformed
      // one; if the retry still drops items the collapse fails and the
      // session stays retryable. An explicitly empty list drops nothing.
      const dropped: string[] = [];
      const summary = validateCollapseSummary(parsed, (list, count) =>
        dropped.push(`${count} ${list} item(s) missing required fields`)
      );
      if (dropped.length > 0) {
        throw new Error(
          `invalid_extraction: ${dropped.join(", ")} (facts need "content"; decisions ` +
            `"title" and "body"; strategies "trigger" and "action")`
        );
      }
      summary.llmTokensUsed = tokensUsed;
      if (attempt > 1) {
        ctx.logger.info("collapse: extraction reply recovered on retry", {
          operation: "collapse.llm_retry",
          attempt,
        });
      }
      return summary;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      ctx.logger.warn("collapse: extraction reply unusable", {
        operation: "collapse.llm_reply_invalid",
        attempt,
        maxAttempts: EXTRACTION_ATTEMPTS,
        error: { type: "ExtractionReplyError", message: lastError.message },
      });
    }
  }
  throw lastError ?? new Error("collapse.summary: no usable reply");
}

// ─── LLM enum coercion ───────────────────────────────────────────────────────

/**
 * P132 — the LLM's `kind` is a SUGGESTION, and the database disagrees loudly.
 *
 * The prompt lists the eight valid decision kinds, and `extracted.kind ?? "decision"`
 * only ever defended against `undefined`. A model that answers `"deployment"`
 * — which qwen2.5:0.5b did, on the first real session with enough turns to
 * reach extraction — sailed through into the INSERT and hit
 * `mnemo_decision_kind_check`. That aborts the transaction, so the 500 does not
 * lose one decision: it loses the ENTIRE collapse. Facts, strategies, the
 * episode, the session's `collapsed_at` — all rolled back, for one bad string.
 *
 * Coerced rather than skipped: the model found a real decision and only
 * mislabelled its category. Dropping the row would discard content over
 * taxonomy. The fallback is logged, because a model that constantly invents
 * kinds is worth knowing about, and a silent coercion would hide it.
 *
 * `PRIMITIVE_SUBTYPES.decision` is the runtime list the type union mirrors —
 * validating against a hand-written copy here is how the two drift.
 */
export function coerceDecisionKind(
  kind: string | undefined,
  ctx: CoreContext
): CreateDecisionInput["kind"] {
  const valid = PRIMITIVE_SUBTYPES.decision as readonly string[];
  if (kind === undefined) return "decision";
  if (valid.includes(kind)) return kind as CreateDecisionInput["kind"];

  ctx.logger.warn("collapse: LLM returned an unknown decision kind — coerced", {
    operation: "collapse.decision_kind_coerced",
    received: kind,
    coercedTo: "decision",
  });
  return "decision";
}

/**
 * LIFECYCLE-5 — the fact kind, coerced exactly like {@link coerceDecisionKind}:
 * a real fact with a mislabelled category keeps its content and lands as
 * `other`, and the invention is logged. A missing kind is `other` silently —
 * that is the documented default, not a model error.
 */
export function coerceFactKind(
  kind: string | undefined,
  ctx: CoreContext
): CreateFactInput["kind"] {
  const valid = PRIMITIVE_SUBTYPES.fact as readonly string[];
  if (kind === undefined) return "other";
  if (valid.includes(kind)) return kind as CreateFactInput["kind"];

  ctx.logger.warn("collapse: LLM returned an unknown fact kind — coerced", {
    operation: "collapse.fact_kind_coerced",
    received: kind,
    coercedTo: "other",
  });
  return "other";
}

/**
 * P132 — same defect, quieter failure. `outcome` reaches
 * `explicitSignal(summary.outcome as CollapseOutcome)` through a cast, so an
 * invented value does not crash: it becomes an outcome signal nobody defined,
 * and the weight lookup silently misses. `OUTCOME_WEIGHTS` is keyed by the
 * type, so its own keys are the runtime list.
 */
export function coerceOutcome(
  outcome: string | undefined,
  ctx: CoreContext
): CollapseOutcome | undefined {
  if (outcome === undefined) return undefined;
  if (Object.prototype.hasOwnProperty.call(OUTCOME_WEIGHTS, outcome)) {
    return outcome as CollapseOutcome;
  }
  ctx.logger.warn("collapse: LLM returned an unknown outcome — ignored", {
    operation: "collapse.outcome_ignored",
    received: outcome,
  });
  return undefined;
}

// ─── Topic-key collisions inside one extraction (LIFECYCLE-3) ────────────────

/**
 * Exact repeats inside one extraction (same text once case, spacing and Unicode
 * form are ignored) are one item; the first is kept. LIFECYCLE-13: the model
 * repeating itself is not two pieces of knowledge.
 */
export function dedupeExtracted<T>(items: T[], contentOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const content = normalizeExtractedText(contentOf(item));
    if (seen.has(content)) return false;
    seen.add(content);
    return true;
  });
}

/** What the decision unique index compares (`lower(btrim(topic_key))`); used for both kinds. */
export function normalizeTopicKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Comparison form for "is this the same statement": case, spacing and Unicode form ignored. */
export function normalizeExtractedText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * LIFECYCLE-3 (P153) — resolve topic keys across the WHOLE extraction before a
 * single row is written.
 *
 * Every keyed item used to go straight to the topic merge, including rows this
 * same pass had just written: six distinct facts the model put under one key
 * became one live fact, the last one. The key is the model's claim that items
 * are "the same thing"; when the items disagree, that claim is wrong, and the
 * merge turns a wrong label into lost content.
 *
 *   - Exact repeats (same normalised content) are one item: the first is kept.
 *   - Distinct items sharing a normalised key are ambiguous: the key is removed
 *     from ALL of them and each is kept on its own. None of them merges into an
 *     existing row under that key either — picking one to supersede it would be
 *     arbitrary, and the others would then collide with it.
 *
 * No index suffixes (`key-2`): the order the model lists items in is not stable
 * across sessions, so a suffixed key would supersede the wrong row next time.
 */
export function resolveTopicKeyCollisions<T extends { topicKey?: string }>(
  items: T[],
  contentOf: (item: T) => string,
  onAmbiguous?: (topicKey: string, count: number) => void
): T[] {
  const unique: T[] = [];
  for (const item of dedupeExtracted(items, contentOf)) {
    const key = typeof item.topicKey === "string" ? item.topicKey.trim() : "";
    if (key.length === 0 && item.topicKey !== undefined) {
      const { topicKey: _blank, ...rest } = item;
      unique.push(rest as T);
    } else {
      unique.push(item);
    }
  }

  const counts = new Map<string, number>();
  for (const item of unique) {
    if (!item.topicKey) continue;
    const key = normalizeTopicKey(item.topicKey);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) if (count > 1) onAmbiguous?.(key, count);

  return unique.map((item) => {
    if (!item.topicKey || (counts.get(normalizeTopicKey(item.topicKey)) ?? 0) < 2) return item;
    const { topicKey: _ambiguous, ...rest } = item;
    return rest as T;
  });
}

function logAmbiguousTopicKey(
  ctx: CoreContext,
  kind: "fact" | "decision",
  topicKey: string,
  count: number
): void {
  ctx.logger.warn("collapse: one topicKey on distinct items — key dropped, items kept", {
    operation: "collapse.topic_key_ambiguous",
    kind,
    topicKey,
    count,
  });
}

/**
 * The live fact under a topic key, or null when there is none or the adapter
 * cannot say. Only used to recognise an unchanged statement, so "cannot say"
 * degrades to a merge, never to a skip.
 */
async function findActiveFactByTopicKey(
  ctx: CoreContext,
  workspaceId: string,
  topicKey: string
): Promise<{ statement: string } | null> {
  if (typeof ctx.storage.queryFacts !== "function") return null;
  try {
    const page = await ctx.storage.queryFacts({
      workspaceId,
      topicKey,
      status: "active",
      limit: 1,
    });
    return page?.items?.[0] ?? null;
  } catch (err) {
    ctx.logger.debug("collapse: topic lookup failed — merging without it", {
      operation: "collapse.topic_lookup",
      error: {
        type: "TopicLookupError",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

/** Upper bound on the existing strategies one collapse compares against. */
const STRATEGY_DEDUP_SCAN = 500;

/**
 * Normalised trigger+action of the workspace's active strategies, for exact
 * duplicate detection only. A failure degrades to "nothing known" — a possible
 * duplicate row, never a lost strategy.
 */
async function loadActiveStrategyTexts(
  ctx: CoreContext,
  workspaceId: string,
  textOf: (s: { trigger: string; action: string }) => string
): Promise<Set<string>> {
  if (typeof ctx.storage.queryStrategies !== "function") return new Set();
  try {
    const page = await ctx.storage.queryStrategies({
      workspaceId,
      status: "active",
      limit: STRATEGY_DEDUP_SCAN,
    });
    return new Set((page?.items ?? []).map((s) => textOf(s)));
  } catch (err) {
    ctx.logger.debug("collapse: strategy lookup failed — no strategy dedup", {
      operation: "collapse.strategy_dedup",
      error: {
        type: "StrategyLookupError",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return new Set();
  }
}

// ─── Surprise gate (prediction error) ────────────────────────────────────────

export async function computePE(
  ctx: CoreContext,
  text: string,
  workspaceId: string
): Promise<number> {
  return (await surpriseAndNeighbours(ctx, text, workspaceId)).pe;
}

/**
 * Same values as `remember()`'s write-time scoped conflict check
 * (core/src/cognitive/remember.ts): a neighbour this close is worth asking the
 * classifier about, and a fact gets at most this many candidates.
 */
const SCOPED_CONFLICT_SIMILARITY_THRESHOLD = 0.85;
const SCOPED_CONFLICT_MAX_NEIGHBOURS = 3;

/**
 * Numbers and identifier-like tokens (a digit, or upper case after the first
 * letter: RS256, EdDSA, PostgreSQL, 15m), lower-cased. Plain words — however
 * reworded — are not values.
 */
function valueTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}_./:-]+/u)) {
    const token = raw.replace(/[.:/-]+$/u, "");
    if (token.length === 0) continue;
    if (/\p{N}/u.test(token) || /\p{Lu}/u.test(token.slice(1))) out.add(token.toLowerCase());
  }
  return out;
}

/**
 * Review round — true when `next` replaces a value `previous` states: each
 * carries a value-like token the other lacks ("EdDSA" for "RS256", "500" for
 * "300"). A rewording around the same values is not a change.
 */
export function isValueChange(next: string, previous: string): boolean {
  const a = valueTokens(next);
  const b = valueTokens(previous);
  const onlyNext = [...a].some((t) => !b.has(t));
  const onlyPrevious = [...b].some((t) => !a.has(t));
  return onlyNext && onlyPrevious;
}

/**
 * Whether a low-PE fact changes a value one of its close neighbours states.
 * Reads at most SCOPED_CONFLICT_MAX_NEIGHBOURS facts; an unreadable neighbour
 * counts as no change (the old behaviour — the gate applies).
 */
async function changesAValue(
  ctx: CoreContext,
  workspaceId: string,
  content: string,
  closeNeighbours: Array<{ id: string; score: number }>
): Promise<boolean> {
  if (closeNeighbours.length === 0 || typeof ctx.storage.getFact !== "function") return false;
  for (const neighbour of closeNeighbours) {
    const fact = await ctx.storage.getFact(neighbour.id, workspaceId).catch(() => null);
    if (fact && fact.status === "active" && isValueChange(content, fact.statement)) {
      ctx.logger.debug(
        "collapse: low-PE fact changes a known value — kept for the conflict check",
        {
          operation: "collapse.surprise_value_change",
          neighbourId: neighbour.id,
          score: neighbour.score,
        }
      );
      return true;
    }
  }
  return false;
}

/** One vector search, read twice: the surprise gate's PE and the conflict-check candidates. */
async function surpriseAndNeighbours(
  ctx: CoreContext,
  text: string,
  workspaceId: string
): Promise<{ pe: number; neighbours: Array<{ id: string; score: number }> }> {
  const [embedding] = await ctx.embed.embed([text]);
  if (!embedding) return { pe: 1.0, neighbours: [] };
  const hits = await ctx.vector.search({
    workspaceId,
    vector: embedding,
    limit: 5,
    minSimilarity: 0,
  });
  if (hits.length === 0) return { pe: 1.0, neighbours: [] };
  const maxSim = Math.max(...hits.map((h) => h.score));
  return { pe: 1.0 - maxSim, neighbours: hits.map((h) => ({ id: h.id, score: h.score })) };
}

// ─── Persist (LIFECYCLE-7 / LIFECYCLE-8) ─────────────────────────────────────

interface PlannedFact {
  input: CreateFactInput;
  /** PE below the threshold: only written when it supersedes a keyed predecessor. */
  belowSurprise: boolean;
  pe: number;
  /** Close neighbours for the write-time scoped conflict check (empty: no job). */
  conflictCandidates: Array<{ id: string; score: number }>;
}

interface PlannedDecision {
  input: CreateDecisionInput;
  merge: MergeDecisionByTopicKeyInput | null;
}

type EpisodePlan = Omit<CreateEpisodeInput, "linkedFactIds">;

interface CollapsePlan {
  workspaceId: string;
  sessionId: string;
  surpriseThreshold: number;
  facts: PlannedFact[];
  decisions: PlannedDecision[];
  strategies: CreateStrategyInput[];
  episode: EpisodePlan | null;
  /** The session summary minus `episodeId`, which only exists once the episode does. */
  summary: Record<string, unknown>;
}

interface PersistedCollapse {
  createdFactIds: string[];
  decisionsCreated: number;
  strategiesCreated: number;
  episodeId?: string;
}

/**
 * Every durable write of one collapse, against whatever `storage` it is handed:
 * the transaction-bound adapter from `commitSessionCollapse`, or `ctx.storage`
 * on adapters without one. No reads that need a model, no embedding, no LLM —
 * those happened while planning — so a transaction around this is short.
 *
 * Nothing in here is "non-fatal" any more. The episode, its fact links and the
 * summary used to be wrapped in catch-and-log, so a failure produced a
 * `completed` collapse missing exactly the artefacts the context layer reads;
 * now it rolls the whole collapse back and the session stays retryable.
 */
async function persistCollapsePlan(
  ctx: CoreContext,
  storage: StorageAdapter,
  plan: CollapsePlan
): Promise<PersistedCollapse> {
  const { workspaceId, sessionId } = plan;
  const createdFactIds: string[] = [];
  // Q-1: live facts an extracted statement repeated exactly. Linked to the
  // episode, never re-written, and not counted as created.
  const reusedFactIds: string[] = [];
  let decisionsCreated = 0;
  let strategiesCreated = 0;

  for (const planned of plan.facts) {
    const { input } = planned;
    // P125 — honour `topicKey` the way `remember()` does, instead of always
    // inserting.
    //
    // `topicKey` exists so that saying the same thing twice UPDATES rather than
    // duplicates, and `mnemo_fact` enforces it with a unique index over active
    // rows. The explicit write path respected that; this one — the automatic
    // one, which runs unattended at the end of every session — went straight to
    // `createFact`. A second session about the same topic therefore violated
    // `idx_fact_topic_active_unique`, and because the violation aborts the
    // persist transaction it took the WHOLE session's extraction with it, not
    // just the colliding fact. Verified against a real container before fixing:
    // a 500 with `internal_error` and nothing extracted.
    //
    // The unattended path failing is the worse half: nobody is watching, and it
    // gets more likely the more the system is used on recurring topics.
    let merged: MnemoFact | null = null;
    if (input.topicKey) {
      try {
        merged = await storage.mergeFactByTopicKey({
          workspaceId,
          topicKey: input.topicKey,
          statement: input.statement,
          // The successor belongs to THIS session, so this collapse's
          // linkSessionFactsToEpisode links it to the new episode (WP-5 made
          // the merge take both; without them it inherits the predecessor's).
          sessionId,
          extractionSource: "collapse",
        });
      } catch (err) {
        // Q-1: the new value is already live in another row (same scope and
        // subject as the predecessor, which the successor inherits). The merge
        // ran in its own savepoint, so the predecessor is untouched and the
        // transaction is still usable. That row is reused and the predecessor
        // stays live: superseding it with a row this session did not write
        // needs a port the adapters do not have. The row's close neighbours
        // still go to the scoped conflict check, as for a written fact.
        const live = await liveDuplicateAfterMerge(storage, err, input);
        if (!live) throw err;
        reuseLiveFact(ctx, reusedFactIds, live.id, "merge");
        await enqueueScopedConflictCheck(storage, workspaceId, live.id, planned.conflictCandidates);
        continue;
      }
    }
    if (merged) {
      // A merge is a bitemporal supersede (P76): the prior row is closed and a
      // successor created, linked by `supersedes`. The session keeps the
      // successor's id, so the episode's linkedFactIds name the row that is
      // actually live.
      ctx.logger.debug("collapse: merged into the existing fact for this topic", {
        operation: "collapse.topic_merge",
        topicKey: input.topicKey,
        factId: merged.id,
      });
      createdFactIds.push(merged.id);
      await enqueueScopedConflictCheck(storage, workspaceId, merged.id, planned.conflictCandidates);
      continue;
    }
    if (planned.belowSurprise) {
      ctx.logger.debug("collapse: fact below surprise threshold — skipped", {
        operation: "collapse.surprise",
        pe: planned.pe,
        surpriseThreshold: plan.surpriseThreshold,
        topicKey: input.topicKey,
      });
      continue;
    }
    // Q-1 — `uniq_mnemo_fact_dedup` allows one live row per scope, scopeRef,
    // subject and statement. A statement an earlier session or a remember()
    // already stored made this INSERT fail, and inside the one persist
    // transaction that aborted the whole collapse: a 500, nothing written, the
    // session left `active` (2 of 6 re-collapses with the real model). Same
    // answer as remember()'s exact dedup: the live row is reused.
    const live = await findLiveDuplicate(storage, input);
    if (live) {
      reuseLiveFact(ctx, reusedFactIds, live.id, "check");
      continue;
    }
    let fact: MnemoFact;
    try {
      fact = await storage.createFact(input);
    } catch (err) {
      // A writer that committed the statement after the check above (a
      // concurrent remember() or collapse). The INSERT ran in its own
      // savepoint, so the transaction is still usable, and under READ
      // COMMITTED the next statement sees the winner's row.
      const winner =
        uniqueViolationConstraint(err) === "uniq_mnemo_fact_dedup"
          ? await findLiveDuplicate(storage, input)
          : null;
      if (!winner) throw err;
      reuseLiveFact(ctx, reusedFactIds, winner.id, "race");
      continue;
    }
    createdFactIds.push(fact.id);
    await enqueueScopedConflictCheck(storage, workspaceId, fact.id, planned.conflictCandidates);
    // No vector_upsert append here: createFact and mergeFactByTopicKey enqueue
    // it (with the text) inside their own transaction. A second `{ id, kind }`
    // job carried neither vector nor text and always failed.
  }

  // Same trap as the fact loop above, one table over. `mnemo_decision` has a
  // partial unique index — `uniq_mnemo_decision_topic` on
  // `(workspace_id, lower(btrim(topic_key)))` where the row is active — and
  // this loop went straight to `createDecision`, so any two extracted
  // decisions normalising to one topic key aborted the whole pass.
  //
  // Merge-first mirrors `mergeFactByTopicKey` above; the 23505 catch mirrors
  // `remember()`, and covers the case merge-first cannot see — a concurrent
  // writer landing between our read and our insert. (Same-pass collisions no
  // longer reach here: resolveTopicKeyCollisions settled them while planning.)
  for (const { input, merge } of plan.decisions) {
    const merged = merge ? await storage.mergeDecisionByTopicKey(merge) : null;
    if (merged) {
      ctx.logger.debug("collapse: merged into the existing decision for this topic", {
        operation: "collapse.decision_topic_merge",
        topicKey: input.topicKey,
        decisionId: merged.id,
      });
      decisionsCreated++;
      continue;
    }

    try {
      await storage.createDecision(input);
    } catch (err: unknown) {
      const isTopicKeyRace =
        merge !== null &&
        err instanceof Error &&
        (err.message.includes("uniq_mnemo_decision_topic") || err.message.includes("23505"));
      if (!isTopicKeyRace) throw err;

      const winner = await storage.mergeDecisionByTopicKey(merge);
      if (!winner) throw err;
    }
    decisionsCreated++;
  }

  for (const strategyInput of plan.strategies) {
    await storage.createStrategy(strategyInput);
    strategiesCreated++;
  }

  // ── Hebbian co-occurrence ──────────────────────────────────────────────────
  // Update relation strength for all pairs of created facts that co-occurred
  // in the same session. This feeds the STDP learning path.
  if (createdFactIds.length >= 2) {
    for (let i = 0; i < createdFactIds.length; i++) {
      for (let j = i + 1; j < createdFactIds.length; j++) {
        try {
          await storage.createRelation({
            workspaceId,
            sourceId: createdFactIds[i]!,
            sourceType: "fact",
            targetId: createdFactIds[j]!,
            targetType: "fact",
            verb: "related",
          });
        } catch {
          // Duplicate relations are silently ignored — the DB UNIQUE constraint
          // or equivalent will reject them; this is expected during replay.
          // (The adapter runs each insert in its own savepoint, so a rejected
          // one does not poison the surrounding collapse transaction.)
        }
      }
    }
  }

  // ── Linking episode (spec §7 step 5) ───────────────────────────────────────
  let episodeId: string | undefined;
  if (plan.episode && storage.createEpisode) {
    const episode = await storage.createEpisode({
      ...plan.episode,
      // Q-1: a reused row is linked from the episode only. Its own
      // `episode_id` names the context that wrote it, and stays.
      linkedFactIds: [...createdFactIds, ...reusedFactIds],
    });
    episodeId = episode.id;

    // P109 — write the link on the FACT side too.
    //
    // Until now the episode recorded the link only on its own side
    // (`linkedFactIds`), and `mnemo_fact.episode_id` was left null by every
    // write path in the codebase. `preferSourceEpisode` (recall-cold.ts,
    // spec §17 "prefer source episode") reads exactly that column on every
    // cold recall to surface the episode above the bare fact — so it ran on
    // every query, found null, and returned unchanged. The enrichment was
    // fully implemented and permanently inert.
    //
    // Keyed on sessionId, not on createdFactIds, so it also captures the
    // facts an agent wrote mid-session through remember(): those carry the
    // same session id and are exactly the ones that most need their context,
    // since nothing about them says what the session was about.
    if (typeof storage.linkSessionFactsToEpisode === "function") {
      const linked = await storage.linkSessionFactsToEpisode(workspaceId, sessionId, episode.id);
      ctx.logger.debug("collapse: linked session facts to episode", {
        operation: "collapse.episode_link",
        sessionId,
        episodeId: episode.id,
        linked,
        extracted: createdFactIds.length,
      });
    }
  }

  // ── Persist SessionCollapseSummary to mnemo_session ────────────────────────
  if (storage.updateSessionSummary) {
    await storage.updateSessionSummary({
      sessionId,
      workspaceId,
      summary: { ...plan.summary, episodeId },
      factCount: createdFactIds.length,
    });
  }

  return {
    createdFactIds,
    decisionsCreated,
    strategiesCreated,
    ...(episodeId ? { episodeId } : {}),
  };
}

/**
 * Q-1 — the live row `uniq_mnemo_fact_dedup` says `input` would duplicate, or
 * null. Same key as the index (scope, scopeRef, subject, statement, owner, tier).
 */
async function findLiveDuplicate(
  storage: StorageAdapter,
  input: CreateFactInput
): Promise<MnemoFact | null> {
  if (typeof storage.findLiveFactByStatement !== "function") return null;
  return storage.findLiveFactByStatement({
    workspaceId: input.workspaceId,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    subject: input.subject,
    statement: input.statement,
    // APP-009 (final review I5): the rest of the identity, with the defaults
    // the row is stored with — the same sentence owned by a user, or kept at
    // another tier, is a different fact and must not be reused.
    scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
    sensitivity: input.sensitivity ?? "internal",
  });
}

/**
 * Q-1 — after a topic merge failed on `uniq_mnemo_fact_dedup`, the live row its
 * successor would have duplicated. The successor inherits the predecessor's
 * scope, scopeRef and subject, so the lookup takes them from the predecessor,
 * which the failed merge left live.
 */
async function liveDuplicateAfterMerge(
  storage: StorageAdapter,
  err: unknown,
  input: CreateFactInput
): Promise<MnemoFact | null> {
  if (uniqueViolationConstraint(err) !== "uniq_mnemo_fact_dedup" || !input.topicKey) return null;
  const page = await storage.queryFacts({
    workspaceId: input.workspaceId,
    topicKey: input.topicKey,
    status: "active",
    limit: 1,
  });
  const predecessor = page.items[0];
  if (!predecessor) return null;
  return findLiveDuplicate(storage, {
    ...input,
    scope: predecessor.scope,
    scopeRef: predecessor.scopeRef ?? undefined,
    subject: predecessor.subject,
  });
}

function reuseLiveFact(
  ctx: CoreContext,
  reusedFactIds: string[],
  factId: string,
  via: "check" | "race" | "merge"
): void {
  if (!reusedFactIds.includes(factId)) reusedFactIds.push(factId);
  ctx.logger.debug("collapse: extracted statement is already live — reusing that fact", {
    operation: "collapse.exact_duplicate",
    factId,
    via,
  });
}

/**
 * LIFECYCLE-11 (collapse half) — the same `scoped_semantic_conflict_check` job
 * `remember()` enqueues for a fact with close neighbours. The collapse wrote
 * facts through createFact/mergeFactByTopicKey and never ran any conflict
 * check: a session that said "now EdDSA" left "signs with RS256" active and
 * unrelated. Appended through the persist step's storage, so it commits or
 * rolls back with the fact.
 */
async function enqueueScopedConflictCheck(
  storage: StorageAdapter,
  workspaceId: string,
  factId: string,
  candidates: Array<{ id: string; score: number }>
): Promise<void> {
  const others = candidates.filter((c) => c.id !== factId);
  if (others.length === 0 || typeof storage.appendOutbox !== "function") return;
  await storage.appendOutbox({
    workspaceId,
    eventType: "queue_job",
    payload: {
      job: "scoped_semantic_conflict_check",
      data: { factId, workspaceId, candidates: others },
    },
  });
}

/**
 * LIFECYCLE-7 — the answer for a session that is already collapsed: nothing is
 * extracted again. A repeated `memory_episode_end`, a hook and an agent both
 * ending the session, or a client retry used to re-run the whole pipeline and
 * write a second episode plus duplicate decisions and strategies.
 */
function alreadyCollapsedResult(turnsProcessed: number, llmTokensUsed: number): CollapseResult {
  return {
    status: "completed",
    alreadyCollapsed: true,
    factsCreated: 0,
    decisionsCreated: 0,
    strategiesCreated: 0,
    llmTokensUsed,
    turnsProcessed,
    anticipationAccuracy: null,
  };
}

// ─── Provenance episode for a skipped session (AGENTSIM-2) ───────────────────

/** Upper bound on the hand-written facts one provenance episode lists. */
const PROVENANCE_EPISODE_FACT_LIMIT = 200;

/**
 * AGENTSIM-2 (server part) — the facts an agent wrote by hand with this
 * `sessionId` get an episode even when the pipeline skips the session.
 *
 * A pure-MCP agent (episode_start → remember(sessionId) → episode_end) sends
 * no turns, so every one of its sessions returned `too_few_turns` before an
 * episode existed and its facts kept `episode_id` null (0/58 measured), though
 * the protocol promises they are linked. Nothing is extracted; this only gives
 * the existing facts their context.
 *
 * Only when the session has active facts not yet linked to any episode. The
 * episode carries no model output and no copied statement: a fact may be
 * confidential and the episode is not. Run against the storage it is handed —
 * inside {@link skippedResult}'s commit, so the check, the episode, the links
 * and the archive are one transaction, and the session row lock makes a
 * concurrent second skip see the facts already linked (review round).
 */
async function linkHandWrittenFactsOnSkip(
  ctx: CoreContext,
  storage: StorageAdapter,
  session: { agentId?: string; label?: string | null },
  input: CollapseInput,
  skipReason: NonNullable<CollapseResult["skipReason"]>
): Promise<string | undefined> {
  const { workspaceId, sessionId } = input;
  if (typeof storage.queryFacts !== "function" || typeof storage.createEpisode !== "function") {
    return undefined;
  }
  const page = await storage.queryFacts({
    workspaceId,
    sessionId,
    status: "active",
    limit: PROVENANCE_EPISODE_FACT_LIMIT,
  });
  const unlinked = (page?.items ?? []).filter((f) => !f.episodeId).map((f) => f.id);
  if (unlinked.length === 0) return undefined;

  const episode = await storage.createEpisode({
    workspaceId,
    agentId: input.agentId ?? session.agentId,
    title: session.label ?? "Session without extraction",
    narrative:
      `Session ended without an extraction (${skipReason}). ` +
      `${unlinked.length} fact(s) were written during it.`,
    occurredAt: new Date(),
    linkedFactIds: unlinked,
    topics: [],
    sourceConversationId: sessionId,
  });
  if (typeof storage.linkSessionFactsToEpisode === "function") {
    await storage.linkSessionFactsToEpisode(workspaceId, sessionId, episode.id);
  }
  ctx.logger.info("collapse: skipped session's hand-written facts linked to an episode", {
    operation: "collapse.provenance_episode",
    sessionId,
    episodeId: episode.id,
    facts: unlinked.length,
    skipReason,
  });
  return episode.id;
}

/**
 * A skipped result. With a transactional adapter the provenance episode and
 * the archive commit together under the session lock (`archived: true` tells
 * the facade not to archive again); a provenance failure rolls that commit
 * back and leaves the archive to the facade, so the skip itself never turns
 * into an error and never leaves an orphan episode.
 */
async function skippedResult(
  ctx: CoreContext,
  session: { agentId?: string; label?: string | null },
  input: CollapseInput,
  skipReason: NonNullable<CollapseResult["skipReason"]>
): Promise<CollapseResult> {
  const skipped: CollapseResult = {
    status: "skipped",
    skipReason,
    factsCreated: 0,
    decisionsCreated: 0,
    strategiesCreated: 0,
    llmTokensUsed: 0,
  };
  try {
    if (typeof ctx.storage.commitSessionCollapse === "function") {
      const commit = await ctx.storage.commitSessionCollapse(
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          expectedTurnCount: input.expectedTurnCount,
          terminalStatus: "archived",
          archiveReason: skipReason,
        },
        (storage) => linkHandWrittenFactsOnSkip(ctx, storage, session, input, skipReason)
      );
      if (!commit.committed) {
        // A concurrent full collapse won: the session is not skipped any more.
        if (commit.status === "collapsed") return alreadyCollapsedResult(0, 0);
        return skipped;
      }
      return {
        ...skipped,
        archived: true,
        ...(commit.value ? { episodeId: commit.value } : {}),
      };
    }
    const episodeId = await linkHandWrittenFactsOnSkip(
      ctx,
      ctx.storage,
      session,
      input,
      skipReason
    );
    return { ...skipped, ...(episodeId ? { episodeId } : {}) };
  } catch (err) {
    if ((err as { code?: string }).code === "SESSION_SNAPSHOT_CHANGED") throw err;
    ctx.logger.warn("collapse: provenance episode failed (skip unaffected)", {
      operation: "collapse.provenance_episode",
      sessionId: input.sessionId,
      error: {
        type: "ProvenanceEpisodeError",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return skipped;
  }
}

// ─── Main collapse pipeline ───────────────────────────────────────────────────

export async function collapseSession(
  input: CollapseInput,
  ctx: CoreContext,
  _auth: AuthContext
): Promise<CollapseResult> {
  const { sessionId, workspaceId, agentId, reason, policy = {} } = input;

  // RDD-5: load workspace operational mode → honor learning-mode gates.
  let gates = gatesFor(null); // null → learning defaults (conservative)
  if (ctx.storage.getWorkspaceMode) {
    const modeRow = await ctx.storage.getWorkspaceMode(workspaceId).catch(() => null);
    gates = gatesFor(
      modeRow
        ? {
            workspaceId,
            mode: modeRow.mode,
            sessionCount: modeRow.sessionCount,
            promoteAt: modeRow.promoteAt,
            startedAt: modeRow.startedAt,
            factCount: modeRow.factCount,
            entityCount: modeRow.entityCount,
          }
        : null
    );
    if (input.learningMode === undefined) input.learningMode = !gates.worthUpdates;
  }

  const minTurns = policy.minTurnsForCollapse ?? 3;
  const recurrenceThreshold = policy.recurrenceThreshold ?? 0.6;
  const skipIfBelowThreshold = policy.skipLlmIfBelowThreshold ?? true;
  const surpriseThreshold = ctx.config.surpriseThreshold;
  const mode = policy.mode ?? "auto";
  const requirePin = mode === "hybrid" ? true : (policy.requirePin ?? false);
  // LIFECYCLE-5: declared on the policy and in the agent profile, never read.
  const extractFacts = policy.extractFacts ?? true;
  const extractDecisions = policy.extractDecisions ?? true;
  const extractStrategies = policy.extractStrategies ?? true;

  // ── Step 1: Load session and turns ──────────────────────────────────────────
  const session = await ctx.storage.getSession(sessionId, workspaceId);
  if (!session) {
    ctx.logger.warn("collapse: session not found", { operation: "collapse.load", sessionId });
    return {
      status: "failed",
      skipReason: undefined,
      factsCreated: 0,
      decisionsCreated: 0,
      strategiesCreated: 0,
      llmTokensUsed: 0,
    };
  }

  // LIFECYCLE-7: a collapsed session has been turned into knowledge already.
  // Running the pipeline again extracted it a second time — a new episode, and
  // decisions and strategies written twice. (An ARCHIVED session is different:
  // it was skipped or discarded, and an explicit collapse may still extract it.)
  if (session.status === "collapsed") {
    ctx.logger.info("collapse: session already collapsed — nothing to do", {
      operation: "collapse.already_collapsed",
      sessionId,
    });
    return alreadyCollapsedResult(session.turnCount, 0);
  }

  const turns = await resolveCollapseTurns(ctx, workspaceId, sessionId);
  input = { ...input, expectedTurnCount: turns.length };

  // ── Step 2: Minimum viability check ─────────────────────────────────────────
  if (turns.length < minTurns) {
    ctx.logger.info("collapse: skipped — too few turns", {
      operation: "collapse.viability",
      sessionId,
      turnCount: turns.length,
      minTurns,
    });
    return skippedResult(ctx, session, input, "too_few_turns");
  }

  // ── Step 2b: requirePin gate (spec §7) ──────────────────────────────────────
  if (!requirePinSatisfied(requirePin, turns)) {
    ctx.logger.info("collapse: skipped — requirePin and no pinned turns", {
      operation: "collapse.requirePin",
      sessionId,
    });
    return skippedResult(ctx, session, input, "no_pin");
  }

  // ── Step 3: RecMem gate — shared recurrence signal (v3/recmem.ts) ─────────────
  //
  // The gate exists to save LLM tokens on the AUTOMATIC sweep: a session with no
  // sustained theme is not worth an extraction round-trip. That rationale is
  // sound, and P115 did not remove the gate — it removed the two situations
  // where the gate was destroying content it had no business judging.
  //
  //   1. An EXPLICIT collapse is not a candidate for token-saving. Somebody
  //      asked for this session to be turned into knowledge; spending the tokens
  //      is their call, not the heuristic's. Before this, `POST /session/:id/collapse`
  //      could return 202 accepted:true and quietly throw the session away.
  //   2. A non-semantic embedder makes the signal meaningless. With
  //      MNEMO_EMBED_STUB the cosines are hash noise: measured 0.58 for a
  //      progressing conversation and 0.50 for a near-verbatim repetitive one —
  //      backwards. A gate reading noise is not a gate, it is a dice roll, and
  //      this one closes sessions.
  //
  // Both are logged rather than silent: a gate that stands down should say so,
  // or the next person measuring collapse rates has no idea why it never fires.
  const explicitCollapse = input.reason === "explicit";
  const semanticEmbeddings = ctx.embed.semantic !== false;

  if (turns.length >= 2 && !explicitCollapse && semanticEmbeddings) {
    const embeddings = await ctx.embed.embed(turns.map((t) => t.content));
    const sustainedSignal = recurrenceSignal(embeddings);
    const conversational = new Set(conversationalTurnsForRecurrence(turns));
    const conversationEmbeddings = embeddings.filter((_, i) => conversational.has(turns[i]!));
    // P142 supplies a clean, labelled signal for P115 calibration. It does not
    // change the existing gate or decide a new threshold without that evidence.
    ctx.logger.info("collapse: recurrence signal by content origin", {
      operation: "collapse.recmem_origin",
      sessionId,
      turnCount: turns.length,
      conversationalTurnCount: conversational.size,
      sustainedSignal,
      conversationalSignal:
        conversationEmbeddings.length >= 2 ? recurrenceSignal(conversationEmbeddings) : null,
    });

    if (sustainedSignal < recurrenceThreshold && skipIfBelowThreshold) {
      ctx.logger.info("collapse: skipped — low recurrence signal", {
        operation: "collapse.recmem",
        sessionId,
        sustainedSignal,
        recurrenceThreshold,
      });
      return skippedResult(ctx, session, input, "low_recurrence_signal");
    }
  } else if (turns.length >= 2 && !semanticEmbeddings) {
    ctx.logger.warn("collapse: RecMem gate stood down — embeddings are not semantic", {
      operation: "collapse.recmem",
      sessionId,
      embedId: ctx.embed.id,
    });
  }

  // ── Step 4–5: LLM extraction ─────────────────────────────────────────────────
  if (!ctx.llm) {
    ctx.logger.warn("collapse: LLM adapter unavailable", { operation: "collapse.llm", sessionId });
    return {
      status: "failed",
      skipReason: "llm_unavailable",
      factsCreated: 0,
      decisionsCreated: 0,
      strategiesCreated: 0,
      llmTokensUsed: 0,
    };
  }

  // ── Step 2b: UCE scheduler bias (spec §7 step 2, §10) ─────────────────────────
  let biasHint = "";
  try {
    const dist = await ctx.storage.getKnowledgeDistribution(workspaceId);
    biasHint = extractionBiasHint(dist);
  } catch (err) {
    ctx.logger.debug("collapse: knowledge distribution unavailable — no bias hint", {
      operation: "collapse.scheduler",
      error: { type: "SchedulerError", message: err instanceof Error ? err.message : String(err) },
    });
  }

  let summary: SessionCollapseSummary;
  try {
    const prompt = buildCollapsePrompt(turns, input.collapseHint) + biasHint;
    summary = await extractCollapseSummary(ctx, ctx.llm, prompt);
    // P132 — normalise the untrusted enum ONCE, here, rather than at each of the
    // five places that go on to read it. Coercing per use site is how one of
    // them gets missed, which is exactly what happened on the first attempt at
    // this fix: the worth-signal branch was guarded and the persisted summary
    // was not.
    summary.outcome = coerceOutcome(summary.outcome, ctx) ?? "";
  } catch (err) {
    ctx.logger.error("collapse: LLM extraction failed", {
      operation: "collapse.llm",
      error: { type: "LLMError", message: err instanceof Error ? err.message : String(err) },
    });
    return {
      status: "failed",
      skipReason: "llm_unavailable",
      factsCreated: 0,
      decisionsCreated: 0,
      strategiesCreated: 0,
      llmTokensUsed: 0,
    };
  }

  // ── Step 6: Plan the writes — surprise gate + RDD-4 dedup gate ─────────────
  //
  // LIFECYCLE-8: everything that READS, embeds or searches happens here, before
  // the first write. Step 7 then only writes, which is what lets it run inside
  // one database transaction without holding a connection across model calls.
  //
  // RDD-4: In hybrid mode, fetch the per-turn topic_keys for this session so we
  // can skip collapse outputs whose topic_key is already covered by a per-turn fact.
  // This prevents the same knowledge being written twice (once per-turn, once at collapse).
  const hybridPolicy = policy.hybridPolicy ?? {};
  const collapseSkipsExisting = hybridPolicy.collapseSkipsExisting ?? true;
  let perTurnTopicKeys: Set<string> = new Set();
  if (mode === "hybrid" && collapseSkipsExisting && ctx.storage.listSessionTopicKeysBySource) {
    try {
      const keys = await ctx.storage.listSessionTopicKeysBySource(
        workspaceId,
        sessionId,
        "per_turn"
      );
      perTurnTopicKeys = new Set(keys);
      ctx.logger.debug("collapse: loaded per-turn topic keys for dedup", {
        operation: "collapse.hybrid_dedup",
        sessionId,
        keyCount: perTurnTopicKeys.size,
      });
    } catch (err) {
      ctx.logger.warn("collapse: hybrid dedup topic-key fetch failed (non-fatal)", {
        operation: "collapse.hybrid_dedup",
        error: { type: "DedupError", message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const extractedFacts = resolveTopicKeyCollisions(
    extractFacts ? (summary.facts ?? []) : [],
    (f) => f.content,
    (topicKey, count) => logAmbiguousTopicKey(ctx, "fact", topicKey, count)
  );

  // LIFECYCLE-13: a fact that restates a decision word for word is the same
  // knowledge twice; the decision, which carries the reason, is kept.
  const decisionTexts = new Set(
    extractDecisions
      ? (summary.decisions ?? []).flatMap((d) => [
          normalizeExtractedText(d.title),
          normalizeExtractedText(d.body),
        ])
      : []
  );

  const plannedFacts: PlannedFact[] = [];
  for (const extracted of extractedFacts) {
    if (decisionTexts.has(normalizeExtractedText(extracted.content))) {
      ctx.logger.debug("collapse: fact restates an extracted decision — skipped", {
        operation: "collapse.cross_type_dedup",
      });
      continue;
    }

    // RDD-4 dedup gate: skip collapse output if per-turn already covered this topic_key
    if (extracted.topicKey && perTurnTopicKeys.has(extracted.topicKey)) {
      ctx.logger.debug("collapse: skipped — topic_key already covered by per-turn extraction", {
        operation: "collapse.hybrid_dedup",
        topicKey: extracted.topicKey,
      });
      continue;
    }

    // LIFECYCLE-4: a keyed statement identical to the live one is not news —
    // merging it would only write a revision that says the same thing.
    if (extracted.topicKey) {
      const live = await findActiveFactByTopicKey(ctx, workspaceId, extracted.topicKey);
      if (
        live &&
        normalizeExtractedText(live.statement) === normalizeExtractedText(extracted.content)
      ) {
        ctx.logger.debug("collapse: keyed fact unchanged — skipped", {
          operation: "collapse.topic_unchanged",
          topicKey: extracted.topicKey,
        });
        continue;
      }
    }

    // Surprise gate: skip facts that are too similar to existing knowledge.
    //
    // LIFECYCLE-4 (P76 in collapse) — but NOT before a keyed fact has had its
    // chance to supersede. "300 → 500 requests per minute" is the textbook
    // low-PE, high-importance update: the two statements are near-identical
    // vectors, so the gate called the new value "already known" and the stale
    // one stayed live. `remember()` merges first and gates keyless writes only;
    // the collapse now does the same. The gate still applies to a keyed fact
    // with nothing to supersede (decided at persist time, under the lock).
    const { pe, neighbours } = await surpriseAndNeighbours(ctx, extracted.content, workspaceId);
    const closeNeighbours = neighbours
      .filter((n) => n.score >= SCOPED_CONFLICT_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, SCOPED_CONFLICT_MAX_NEIGHBOURS);
    // Review round: low PE means "close to something known", which a
    // duplicate is and a CHANGED VALUE also is ("now EdDSA" vs "RS256" at
    // 0.90 with the default 0.15 threshold). A changed value is exactly what
    // the conflict check exists for, so it is kept and checked, not gated.
    const belowSurprise =
      pe < surpriseThreshold &&
      !(await changesAValue(ctx, workspaceId, extracted.content, closeNeighbours));
    if (belowSurprise && !extracted.topicKey) {
      ctx.logger.debug("collapse: fact below surprise threshold — skipped", {
        operation: "collapse.surprise",
        pe,
        surpriseThreshold,
      });
      continue;
    }

    plannedFacts.push({
      input: {
        workspaceId,
        agentId: agentId ?? session.agentId,
        scope: "global",
        statement: extracted.content,
        subject: extracted.subject ?? "general",
        kind: coerceFactKind(extracted.kind, ctx),
        confidence: extracted.confidence ?? 0.8,
        extractionSource: "collapse",
        sessionId,
        topicKey: extracted.topicKey,
      },
      belowSurprise,
      pe,
      conflictCandidates: ctx.config.scopedConflictCheckEnabled === false ? [] : closeNeighbours,
    });
  }

  const plannedDecisions: PlannedDecision[] = [];
  if (extractDecisions) {
    const extractedDecisions = resolveTopicKeyCollisions(
      summary.decisions ?? [],
      (d) => `${d.title}\n${d.body}`,
      (topicKey, count) => logAmbiguousTopicKey(ctx, "decision", topicKey, count)
    );
    for (const extracted of extractedDecisions) {
      const decisionInput: CreateDecisionInput = {
        workspaceId,
        agentId: agentId ?? session.agentId,
        kind: coerceDecisionKind(extracted.kind, ctx),
        title: extracted.title,
        body: extracted.body,
        topicKey: extracted.topicKey,
      };
      plannedDecisions.push({
        input: decisionInput,
        merge: extracted.topicKey
          ? {
              workspaceId,
              topicKey: extracted.topicKey,
              title: extracted.title,
              body: extracted.body,
              kind: decisionInput.kind,
            }
          : null,
      });
    }
  }

  const plannedStrategies: CreateStrategyInput[] = [];
  if (extractStrategies) {
    const strategyText = (s: { trigger: string; action: string }) =>
      normalizeExtractedText(`${s.trigger}\n${s.action}`);
    const known = await loadActiveStrategyTexts(ctx, workspaceId, strategyText);
    for (const extracted of dedupeExtracted(
      summary.strategies ?? [],
      (s) => `${s.trigger}\n${s.action}`
    )) {
      // LIFECYCLE-13: strategies had no dedup at all, so every session that
      // restated a rule added it again.
      if (known.has(strategyText(extracted))) {
        ctx.logger.debug("collapse: strategy already stored — skipped", {
          operation: "collapse.strategy_dedup",
        });
        continue;
      }
      plannedStrategies.push({
        workspaceId,
        agentId: agentId ?? session.agentId,
        trigger: extracted.trigger,
        action: extracted.action,
        context: extracted.context,
      });
    }
  }

  // ── Step 6b: Episode narrative + delta link (reads only) ───────────────────
  //
  // P109 slice 1b — the guard used to also require `createdFactIds.length > 0`,
  // so a session where LLM extraction happened to find nothing got no episode
  // at all. That is exactly the case the context layer is for: an agent can
  // write twenty facts by hand through remember(), and those carry a sessionId
  // but no context until an episode exists for the fact→episode link to point
  // at.
  //
  // Reaching this line already means the session was substantive by the
  // system's own definition: the viability check passed (turns >= minTurns) and
  // the LLM produced a summary. Extraction finding zero NEW facts says
  // something about novelty, not about whether the session happened.
  //
  // The trade is more episode rows, some with an empty `linkedFactIds`. They
  // are not empty of value: each carries the session's narrative, and
  // linkSessionFactsToEpisode attaches every fact written during the session,
  // extracted or hand-written.
  let episodePlan: EpisodePlan | null = null;
  if (typeof ctx.storage.createEpisode === "function") {
    const narrativeLines = [
      summary.goal ? `Goal: ${summary.goal}` : null,
      `Outcome: ${summary.outcome}`,
      summary.discoveries?.length ? `Discoveries: ${summary.discoveries.join("; ")}` : null,
    ].filter((l): l is string => l !== null);
    const narrative = narrativeLines.join("\n");
    // DELTAMEM §16 — delta-encode against the nearest existing episode when
    // similar (> 0.85). Port-only; falls back to a root episode otherwise.
    const { computeDeltaEpisodeLink } = await import("../cognitive/delta-episode.js");
    // P109: the delta link is an ENRICHMENT, and it must not be able to cost
    // the episode.
    //
    // Its own contract already says so — "falls back to a root episode
    // otherwise" — but a THROW is not a fallback. This call sat bare inside
    // the episode try/catch, so any failure inside it skipped
    // `createEpisode` entirely and the handler below logged the loss as
    // "non-fatal". Measured: a workspace whose embedding model had changed
    // held episodes at one vector width and queried at another; pgvector
    // refuses to compare them, the neighbour lookup threw, and the collapse
    // reported `completed` with facts extracted and NO EPISODE — the one
    // artefact the whole context layer exists to produce.
    //
    // Degrading to a root episode is the documented behaviour for "no similar
    // neighbour". An unreachable neighbour is the same situation: no
    // neighbour. A flat episode is worth immeasurably more than none.
    let deltaLink: Awaited<ReturnType<typeof computeDeltaEpisodeLink>> = {};
    try {
      deltaLink = await computeDeltaEpisodeLink(ctx, workspaceId, narrative);
    } catch (deltaErr) {
      ctx.logger.warn("collapse: delta-episode link unavailable — writing a root episode", {
        operation: "collapse.episode_delta",
        sessionId,
        error: {
          type: "DeltaEpisodeError",
          message: deltaErr instanceof Error ? deltaErr.message : String(deltaErr),
        },
      });
    }
    episodePlan = {
      workspaceId,
      agentId: agentId ?? session.agentId,
      title: summary.goal ?? "Session collapse",
      narrative,
      occurredAt: new Date(),
      topics: summary.relevantEntities ?? [],
      sourceConversationId: sessionId,
      ...deltaLink,
    };
  }

  // ── Step 7: Persist — ONE transaction when the adapter offers it ──────────
  //
  // LIFECYCLE-8: the header of this file promised "atomic persist" while every
  // write committed on its own. A failure mid-way (measured: the first
  // createStrategy) left six facts and a decision live with no episode, no
  // relations and no summary; the retry then extracted again and wrote
  // paraphrased duplicates next to them. Now the facts, decisions, strategies,
  // relations, episode, fact→episode links, summary and the session's
  // `collapsed` status commit together or not at all, and a failure in any of
  // them is fatal (the session stays retryable) instead of a logged
  // "non-fatal" partial success.
  //
  // LIFECYCLE-7: the same commit re-checks the session under a row lock, so two
  // collapses that raced past the status check above cannot both write: the
  // second finds the session already collapsed and writes nothing.
  const plan: CollapsePlan = {
    workspaceId,
    sessionId,
    surpriseThreshold,
    facts: plannedFacts,
    decisions: plannedDecisions,
    strategies: plannedStrategies,
    episode: episodePlan,
    summary: {
      goal: summary.goal,
      outcome: summary.outcome,
      discoveries: summary.discoveries ?? [],
      nextSteps: summary.nextSteps ?? [],
      relevantEntities: summary.relevantEntities ?? [],
      // Derived from the decisions actually extracted rather than requested as a
      // second, overlapping list (LIFECYCLE-13); a model-supplied list still wins.
      keyDecisions: summary.keyDecisions ?? plannedDecisions.map((d) => d.input.title),
      turnsProcessed: turns.length,
      pinsUsed: countPinnedTurns(turns),
      llmTokensUsed: summary.llmTokensUsed,
      collapseReason: reason,
    },
  };

  let persisted: PersistedCollapse;
  if (typeof ctx.storage.commitSessionCollapse === "function") {
    const commit = await ctx.storage.commitSessionCollapse(
      {
        workspaceId,
        sessionId,
        expectedTurnCount: input.expectedTurnCount,
        topicLocks: {
          facts: plannedFacts.flatMap((f) => (f.input.topicKey ? [f.input.topicKey] : [])),
          decisions: plannedDecisions.flatMap((d) => (d.input.topicKey ? [d.input.topicKey] : [])),
        },
      },
      (storage) => persistCollapsePlan(ctx, storage, plan)
    );
    if (!commit.committed) {
      ctx.logger.info("collapse: session collapsed by a concurrent run — nothing written", {
        operation: "collapse.already_collapsed",
        sessionId,
        status: commit.status,
      });
      return alreadyCollapsedResult(turns.length, summary.llmTokensUsed);
    }
    persisted = commit.value;
  } else {
    // Adapters without a transactional commit (test doubles, older adapters):
    // same writes, same order, same fatality — just not atomic.
    persisted = await persistCollapsePlan(ctx, ctx.storage, plan);
    // ── Step 8: Close session ──────────────────────────────────────────────
    await ctx.storage.closeSession(sessionId, workspaceId);
  }
  const { createdFactIds, decisionsCreated, strategiesCreated, episodeId } = persisted;

  // ── Step 7.7: LLM hyperedge extraction ──────────────────────────────────────
  // Ask the LLM to identify n-ary relations among the newly-created facts and
  // persist each valid group (≥3 members) as a hyperedge. Non-fatal: any error
  // is caught inside extractConsolidationHyperedges. No-op when LLM is absent.
  {
    const turnsText = turns.map((t) => t.content).join("\n");
    await extractConsolidationHyperedges(ctx, workspaceId, createdFactIds, turnsText);
  }

  // ── Step 6 (hot-promote): ACT-R boost for each new fact (spec §7 step 6) ────
  // RDD-5: hotTier gate — disabled during learning mode (insufficient signal).
  if (gates.hotTier && ctx.cache?.zincrby) {
    const { bumpHotTierScore } = await import("../cognitive/recall-hot.js");
    await Promise.allSettled(createdFactIds.map((id) => bumpHotTierScore(ctx, workspaceId, id)));
  }

  // ── Step 7.6 (T4 / RDD-1): Outcome → worth propagation ──────────────────────
  // Propagate the session outcome as a worth delta to all facts created this session.
  // RDD-1: builds a 3-signal OutcomeSignal array (explicit + heuristic; task_completion
  // would be wired here once task linkage is available in the session context) and uses
  // the confidence-weighted computeOutcome() combiner. This ensures worth also moves on
  // sessions where the user never explicitly rates them (heuristic-only sessions).
  //
  // RDD-5 guard: skip worth updates when the workspace is in cold-start learning mode
  // (worthUpdatesDisabled=true per spec §Resolved Design Decisions). The learningMode
  // flag on CollapseInput carries this; when set to true, worth updates are SKIPPED.
  if (
    createdFactIds.length > 0 &&
    input.learningMode !== true &&
    typeof ctx.storage.updateWorth === "function"
  ) {
    // Build signal set: always include heuristic (free proxy); include explicit if present
    const signals: OutcomeSignal[] = [];

    if (summary.outcome) {
      signals.push(explicitSignal(summary.outcome as CollapseOutcome));
    }

    // RDD-1: task_completion proxy — count linked tasks for this session.
    try {
      const linked = await ctx.storage.listTasksForSession?.(workspaceId, sessionId);
      if (linked && linked.length > 0) {
        const completed = linked.filter((t) => t.status === "completed").length;
        const tc = taskCompletionSignal(linked.length, completed);
        if (tc) signals.push(tc);
      }
    } catch (err) {
      ctx.logger.debug("collapse: task-completion signal unavailable", {
        operation: "collapse.task_signal",
        error: {
          type: "TaskSignalError",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }

    // Heuristic: inspect turn data for social/behavioral signals
    const lastTurn = turns[turns.length - 1];
    const lastUserContent = lastTurn?.content?.toLowerCase() ?? "";
    signals.push(
      heuristicSignal({
        endedWithThanks: /\b(thank(s| you)|cheers|perfect|awesome|great|appreciate)\b/.test(
          lastUserContent
        ),
        repeatedQuestion:
          turns.length >= 4 &&
          turns.filter((t) => t.role === "user" && t.content.includes("?")).length >=
            Math.ceil(turns.length * 0.5),
        manyTurnsNoResolve: turns.length > 20 && summary.outcome !== "resolved",
        shortAndStopped: turns.length <= 3,
      })
    );

    // Combine signals via confidence-weighted mean → [0,1] score → WorthDelta
    const combinedScore = computeOutcome(signals);
    const delta = {
      success: combinedScore,
      failure: 1 - combinedScore,
      creditWeight: 1.0,
    };
    await Promise.allSettled(
      createdFactIds.map((id) =>
        ctx.storage.updateWorth(id, workspaceId, "fact", delta).catch((err) => {
          ctx.logger.warn("collapse: outcome worth update failed (non-fatal)", {
            operation: "collapse.outcome_worth",
            factId: id,
            outcome: summary.outcome,
            error: {
              type: "WorthError",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        })
      )
    );

    // C11: TD(λ) credit propagation — each created fact triggers back-propagation
    // to its predecessor facts recalled during the session. Happens after direct
    // worth update so predecessors compound rather than race with this session's signal.
    await Promise.allSettled(
      createdFactIds.map((id) =>
        propagateTdCredit(ctx, workspaceId, sessionId, id, delta).catch((err) => {
          ctx.logger.warn("collapse: td-credit propagation failed (non-fatal)", {
            operation: "collapse.td_credit",
            factId: id,
            error: {
              type: "TdCreditError",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        })
      )
    );
  }

  // RDD-5: bump workspace mode counters so graduation criteria can be evaluated.
  await ctx.storage
    .incrementWorkspaceModeCounters?.(workspaceId, {
      factCount: createdFactIds.length,
      sessionCount: 1,
    })
    .catch(() => undefined);

  // RDD-5: check graduation criteria and promote to production if any criterion is met.
  {
    const { runGraduationTick } = await import("../cognitive/graduation.js");
    await runGraduationTick(ctx.storage, ctx.outbox, ctx.logger, workspaceId).catch((err) => {
      ctx.logger.warn("collapse: graduation tick failed (non-fatal)", {
        operation: "collapse.graduation",
        error: {
          type: "GraduationError",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  }

  // §13 reflection auto-cadence: increment the per-agent collapse counter and
  // fire a full reflection cycle every REFLECTION_CADENCE collapses. Best-effort:
  // a missing port method or absent agentId is a silent no-op (never blocks collapse).
  const reflectAgentId = agentId ?? session.agentId;
  if (reflectAgentId && ctx.storage.incrementSessionsSinceReflection) {
    try {
      const n = await ctx.storage.incrementSessionsSinceReflection(workspaceId, reflectAgentId);
      if (n >= REFLECTION_CADENCE) {
        await runReflectionCycle(ctx, { workspaceId, scopes: [] }, reflectAgentId);
      }
    } catch (err) {
      ctx.logger.warn("collapse: reflection auto-cadence failed (non-fatal)", {
        operation: "collapse.reflect",
        error: { type: "ReflectError", message: String(err) },
      });
    }
  }

  // ── Step 8b: Anticipation accuracy feedback (§30) ───────────────────────────
  // Read the pre-staged anticipation feed from the cache using the same namespaced
  // key that WorkingMemory writes. Compare against extracted fact IDs to compute
  // accuracy = hits / total_anticipated. This is a recall-proxy: extraction of a
  // fact that was anticipated signals the anticipation engine was on-target. Falls
  // back gracefully when cache is absent or no anticipation was pre-staged.
  let anticipationAccuracy: number | null = null;
  const effectiveAgentId = agentId ?? session.agentId;
  if (ctx.cache && effectiveAgentId) {
    try {
      // F1 Bug B: read the SAME field preinject stages (.id, per AnticipatedMemory
      // in v3/anticipation.ts) — the old code read .memoryId, which is undefined on
      // the staged shape, forcing accuracy to 0. The slot is an object (F1 Bug A:
      // preinject now passes the object, the adapter serializes exactly once).
      const slot = await ctx.cache.get<AnticipationSlot>(
        workKey(workspaceId, effectiveAgentId, ANTICIPATION_SLOT)
      );
      anticipationAccuracy = computeAnticipationAccuracy(slot, createdFactIds);
    } catch (err) {
      // non-fatal — accuracy stays null; surface for observability rather than swallow.
      ctx.logger.warn("collapse: anticipation accuracy compute failed (non-fatal)", {
        operation: "collapse.anticipation",
        error: { type: "AnticipationError", message: String(err) },
      });
    }
  }

  ctx.logger.info("collapse: completed", {
    operation: "collapse.complete",
    sessionId,
    reason,
    factsCreated: createdFactIds.length,
    decisionsCreated,
    strategiesCreated,
    llmTokensUsed: summary.llmTokensUsed,
    anticipationAccuracy,
  });

  // §7 step 7 — remove the session's ephemeral Redis footprint now that durable
  // knowledge has been extracted. Best-effort (TTL reaps it otherwise).
  if (ctx.sessionBuffer) {
    await ctx.sessionBuffer.clear(workspaceId, sessionId).catch(() => undefined);
  }

  return {
    status: "completed",
    factsCreated: createdFactIds.length,
    decisionsCreated,
    strategiesCreated,
    ...(episodeId ? { episodeId } : {}),
    llmTokensUsed: summary.llmTokensUsed,
    turnsProcessed: turns.length,
    anticipationAccuracy,
  };
}
