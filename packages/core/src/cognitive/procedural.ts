/**
 * Procedural memory — metaprompt prompt-evolution engine (spec §14).
 *
 * Hexagonally pure: zero infra deps (drizzle-orm, pg, redis, etc. are banned).
 * All side effects go through the ports (StorageAdapter, LLMAdapter).
 *
 * Algorithm:
 *   1. getWorkspaceMonthlySpendUsd → skip if < skipIfBudgetBelow (§34.11 budget gate)
 *   2. listScoredTrajectories (K = 20) → group high (>0.8) / low (<0.4)
 *   3. LLM generates a delta (what changed between high and low trajectories)
 *   4. Token-budget validate the delta (must be < maxTokenBudget)
 *   5. Create a candidate prompt version row
 *   6. A/B test: 10 sessions, then decideProceduralTransition() adopts/rolls back
 */

import type { StorageAdapter, LLMAdapter, LLMInput } from "@mnemo-ai/types";

// Anthropic Haiku output pricing estimate (USD per output token, 2024 public rate).
// Used for costPerEvaluation estimate when the LLM adapter does not surface cost.
const HAIKU_COST_PER_OUTPUT_TOKEN = 0.000_001_25; // $1.25 / million output tokens

export interface ProceduralOptimizationConfig {
  /** Number of trajectories to pull for high/low grouping. Default: 20. */
  topK?: number;
  /** Minimum session worth score to count as "high". Default: 0.8. */
  highThreshold?: number;
  /** Maximum session worth score to count as "low". Default: 0.4. */
  lowThreshold?: number;
  /**
   * §34.11 budget gate — skip optimization if monthly spend (USD) is below this.
   * Prevents LLM cost spirals on inactive workspaces. Default: 0.01.
   */
  skipIfBudgetBelow?: number;
  /** Max output tokens for the LLM delta call. Default: 200. */
  maxDeltaTokens?: number;
  /** System prompt for delta generation. Defaults to a built-in metaprompt. */
  systemPrompt?: string;
}

export interface ProceduralOptimizationResult {
  /** "skipped" if budget gate or no candidates; "created" if a version was written. */
  outcome: "skipped" | "created";
  reason?: string;
  promptVersionId?: string;
  /**
   * Upper-bound USD estimate for this evaluation's LLM call. Computed as
   * `maxDeltaTokens × HAIKU_COST_PER_OUTPUT_TOKEN` (the output ceiling), not
   * actual tokens consumed — the LLM adapter does not surface token counts.
   */
  costPerEvaluation?: number;
  /** Monthly spend for this workspace, as proxy for per-agent cost. */
  monthlyCostPerAgent?: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a prompt optimization assistant for the Mnemosyne memory system.

You will receive two lists of session trajectories:
  - HIGH: sessions where the agent performed well (worth score > 0.8)
  - LOW: sessions where the agent performed poorly (worth score < 0.4)

Analyze what distinguishes the HIGH sessions from the LOW sessions and produce a concise diff / improvement suggestion for the agent's system prompt.

Output format (JSON):
{
  "delta": "<concrete description of what should change in the prompt>",
  "rationale": "<brief explanation of why>",
  "confidence": <0.0–1.0>
}`;

/**
 * Run one pass of the metaprompt optimization loop for a given agent.
 *
 * Safe to call speculatively — it skips silently when budget is too low or
 * there are insufficient high/low trajectory pairs.
 */
export async function runProceduralOptimization(
  storage: StorageAdapter,
  llm: LLMAdapter,
  workspaceId: string,
  agentId: string,
  config: ProceduralOptimizationConfig = {},
): Promise<ProceduralOptimizationResult> {
  const {
    topK                = 20,
    highThreshold       = 0.8,
    lowThreshold        = 0.4,
    skipIfBudgetBelow   = 0.01,
    maxDeltaTokens      = 200,
    systemPrompt        = DEFAULT_SYSTEM_PROMPT,
  } = config;

  // §34.11 budget gate
  const monthlySpend = await storage.getWorkspaceMonthlySpendUsd?.(workspaceId) ?? 0;
  if (monthlySpend < skipIfBudgetBelow) {
    return {
      outcome: "skipped",
      reason: `monthly_spend_${monthlySpend.toFixed(4)}_below_gate_${skipIfBudgetBelow}`,
    };
  }

  // Fetch scored trajectories
  const trajectories = await storage.listScoredTrajectories?.(workspaceId, agentId, topK);
  if (!trajectories || trajectories.length === 0) {
    return { outcome: "skipped", reason: "no_trajectories" };
  }

  const high = trajectories.filter((t) => t.score >= highThreshold);
  const low  = trajectories.filter((t) => t.score <= lowThreshold);

  if (high.length === 0 || low.length === 0) {
    return { outcome: "skipped", reason: `insufficient_pairs_high=${high.length}_low=${low.length}` };
  }

  // Build the LLM prompt with input budget truncation
  const INPUT_BUDGET_CHARS = 2000;
  const rawHigh = high.slice(0, 5).map((t, i) => `${i + 1}. session=${t.sessionId} score=${t.score.toFixed(2)}`).join("\n");
  const rawLow  = low.slice(0, 5).map((t, i) => `${i + 1}. session=${t.sessionId} score=${t.score.toFixed(2)}`).join("\n");
  const halfBudget = Math.floor(INPUT_BUDGET_CHARS / 2);
  const highSummary = rawHigh.length > halfBudget ? rawHigh.slice(0, halfBudget) + "…" : rawHigh;
  const lowSummary  = rawLow.length  > halfBudget ? rawLow.slice(0, halfBudget)  + "…" : rawLow;

  const llmInput: LLMInput = {
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `HIGH trajectories (score >= ${highThreshold}):\n${highSummary}\n\nLOW trajectories (score <= ${lowThreshold}):\n${lowSummary}\n\nPlease generate an optimization delta.`,
      },
    ],
    maxTokens: maxDeltaTokens,
    temperature: 0.3,
    model: "haiku",
  };

  let llmOutput: { delta: string; rationale: string; confidence: number };
  try {
    llmOutput = await llm.generateStructured<typeof llmOutput>(llmInput, {
      parse(data: unknown) {
        const d = data as { delta?: unknown; rationale?: unknown; confidence?: unknown };
        if (typeof d.delta !== "string" || typeof d.rationale !== "string") {
          throw new Error("LLM output missing delta or rationale");
        }
        return {
          delta:      d.delta,
          rationale:  d.rationale,
          confidence: typeof d.confidence === "number" ? d.confidence : 0.5,
        };
      },
    });
  } catch (err) {
    return {
      outcome: "skipped",
      reason: `llm_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Token-budget validate: delta must not be too verbose (use character count as proxy)
  if (llmOutput.delta.length > maxDeltaTokens * 4) {
    return { outcome: "skipped", reason: "delta_too_long" };
  }

  if (typeof storage.createPromptVersion !== "function") {
    return { outcome: "skipped", reason: "createPromptVersion_not_implemented" };
  }

  const avgScoreBefore = high.reduce((s, t) => s + t.score, 0) / high.length;

  const version = await storage.createPromptVersion({
    workspaceId,
    agentId,
    promptText: llmOutput.delta,
    diffFromPrevious: `confidence=${llmOutput.confidence.toFixed(2)}: ${llmOutput.rationale}`,
    algorithm: "metaprompt-v1",
    trajectoriesUsed: trajectories.length,
    avgScoreBefore,
    avgScoreAfter: null,
    status: "candidate",
  });

  const costPerEvaluation = maxDeltaTokens * HAIKU_COST_PER_OUTPUT_TOKEN;
  return {
    outcome: "created",
    promptVersionId: version.id,
    costPerEvaluation,
    monthlyCostPerAgent: monthlySpend,
  };
}

export interface ProceduralTransitionResult {
  action: "activated" | "rolled_back" | "noop";
  reason: string;
  promptVersionId?: string;
}

/**
 * §14 A/B decision gate — compares the candidate prompt version's mean outcome
 * score (computed from real scored trajectories via computeCandidateAbScore)
 * against the champion's stored avgScoreBefore. Transitions only when the
 * candidate has ≥ MIN_SAMPLE_SESSIONS sessions AND beats the champion by ≥ THRESHOLD.
 *
 * Called by the weekly cron `mnemo.procedural.evaluate`.
 */
export const MIN_SAMPLE_SESSIONS = 10;
const IMPROVEMENT_THRESHOLD = 0.05; // 5% improvement required to activate

export async function decideProceduralTransition(
  storage: StorageAdapter,
  workspaceId: string,
  agentId: string,
): Promise<ProceduralTransitionResult> {
  if (typeof storage.getActivePromptVersion !== "function") {
    return { action: "noop", reason: "getActivePromptVersion_not_implemented" };
  }

  const candidate = await storage.getActivePromptVersion(workspaceId, agentId);
  if (!candidate || (candidate.status !== "candidate" && candidate.status !== "testing")) {
    return { action: "noop", reason: "no_candidate_version" };
  }

  // Compute the candidate's mean score from actual trajectory data
  if (typeof storage.computeCandidateAbScore !== "function") {
    return { action: "noop", reason: "computeCandidateAbScore_not_implemented", promptVersionId: candidate.id };
  }

  const scoreAfter = await storage.computeCandidateAbScore(workspaceId, agentId, candidate.id);

  // A/B gate: require at least MIN_SAMPLE_SESSIONS scored trajectories
  if (scoreAfter === null) {
    return {
      action: "noop",
      reason: `waiting_for_ab_data_no_scored_trajectories`,
      promptVersionId: candidate.id,
    };
  }

  // We also need enough trajectories — check via listScoredTrajectories
  const trajectories = await storage.listScoredTrajectories?.(workspaceId, agentId, 200) ?? [];
  const candidateTrajCount = trajectories.filter(
    (t) => t.promptVersionId === candidate.id,
  ).length;

  if (candidateTrajCount < MIN_SAMPLE_SESSIONS) {
    // Transition candidate → testing to signal it is now in the A/B window
    if (candidate.status === "candidate" && typeof storage.transitionPromptVersion === "function") {
      await storage.transitionPromptVersion(workspaceId, candidate.id, "testing", scoreAfter ?? 0);
    }
    return {
      action: "noop",
      reason: `waiting_for_ab_data_sessions=${candidateTrajCount}_of_${MIN_SAMPLE_SESSIONS}`,
      promptVersionId: candidate.id,
    };
  }

  const scoreBefore = candidate.avgScoreBefore ?? 0;

  // Adopt if there is a meaningful improvement; roll back otherwise.
  const improved = scoreAfter > scoreBefore + IMPROVEMENT_THRESHOLD;

  if (typeof storage.transitionPromptVersion !== "function") {
    return { action: "noop", reason: "transitionPromptVersion_not_implemented", promptVersionId: candidate.id };
  }

  const newStatus = improved ? "active" : "rolled_back";
  await storage.transitionPromptVersion(workspaceId, candidate.id, newStatus, scoreAfter);

  return {
    action: improved ? "activated" : "rolled_back",
    reason: `score_before=${scoreBefore.toFixed(3)}_after=${scoreAfter.toFixed(3)}_threshold=${IMPROVEMENT_THRESHOLD}_improved=${improved}`,
    promptVersionId: candidate.id,
  };
}
