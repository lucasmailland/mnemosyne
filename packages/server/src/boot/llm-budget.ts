/**
 * MNEMO_LLM_DAILY_BUDGET_USD — a daily cap on what the server's own completion
 * provider (MNEMO_LLM_*) may spend, built on @mnemo-ai/llm-providers' BudgetGuard.
 *
 * Only completions are capped. Extraction, collapse, rerank, HyDE, conflict
 * checks and capture all degrade when the call throws (the session stays
 * retryable, recall keeps its order), so refusing them is safe. Embeddings are
 * deliberately left out even when they share this provider: they sit on the
 * write path, and blocking them would turn a cost cap into failed writes. They
 * cost a fraction of a completion and still show in mnemo_llm_cost_usd_total.
 *
 * llm-providers is an optional peer dep, so the caller hands in the module it
 * already imported; this file only takes types from it.
 */
import type { BudgetGuard, CreatedProvider } from "@mnemo-ai/llm-providers";
import { llmDailySpendUsd } from "../metrics/index.js";

export const LLM_DAILY_BUDGET_ENV = "MNEMO_LLM_DAILY_BUDGET_USD";

/** The cap in USD, or undefined when unset. Throws on a value that is not a positive number. */
export function parseLlmDailyBudget(env: Record<string, string | undefined>): number | undefined {
  const raw = env[LLM_DAILY_BUDGET_ENV]?.trim();
  if (!raw) return undefined;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(
      `${LLM_DAILY_BUDGET_ENV} must be a positive number of US dollars, got "${raw}"`
    );
  }
  return cap;
}

interface WarnLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Route `provider.complete` through a BudgetGuard, in place, so every holder of
 * the provider (the collapse adapter, consolidation) is capped. Applied after
 * per-task routing, so the cap counts every task's provider. The counter
 * resets at 00:00 UTC. Returns undefined for a provider without completions.
 */
export function applyLlmDailyBudget(
  mod: typeof import("@mnemo-ai/llm-providers"),
  provider: CreatedProvider,
  capUSD: number,
  opts: {
    model: string;
    logger: WarnLogger;
    now?: () => Date;
    /** Per-task providers behind provider.complete (boot/llm-router.ts), checked for pricing too. */
    routed?: ReadonlyArray<{ provider: string; model?: string }>;
  }
): BudgetGuard | undefined {
  const complete = provider.complete;
  if (!complete) return undefined;
  const now = opts.now ?? (() => new Date());

  // An unpriced model reports no cost. "block" would throw away replies that
  // were already billed, so we let them through and say the cap cannot see them.
  for (const used of [{ provider: provider.name, model: opts.model }, ...(opts.routed ?? [])]) {
    if (!used.model || mod.estimateCompleteCost(used.provider, used.model, 0, 0) === undefined) {
      opts.logger.warn(
        { provider: used.provider, model: used.model },
        `llm.budget_unpriced_model — ${LLM_DAILY_BUDGET_ENV} cannot measure this model's spend, so it will not stop it`
      );
    }
  }

  const guard = new mod.BudgetGuard({
    provider: { name: provider.name, capabilities: provider.capabilities, complete },
    dailyUSDCap: capUSD,
    unknownCostPolicy: "allow",
    onSpend: (_delta, total) => llmDailySpendUsd.set({}, total),
  });
  llmDailySpendUsd.set({}, 0);

  const utcDay = (): string => now().toISOString().slice(0, 10);
  let day = utcDay();
  let warned = false;
  provider.complete = async (req) => {
    const today = utcDay();
    if (today !== day) {
      day = today;
      warned = false;
      guard.reset();
      llmDailySpendUsd.set({}, 0);
    }
    try {
      return await guard.complete(req);
    } catch (err) {
      if (err instanceof mod.BudgetExceededError && !warned) {
        warned = true;
        opts.logger.warn(
          { capUSD, spentUSD: err.spentUSD },
          "llm.daily_budget_reached — completions are refused until 00:00 UTC; collapse, rerank, HyDE and conflict checks degrade until then"
        );
      }
      throw err;
    }
  };
  return guard;
}
