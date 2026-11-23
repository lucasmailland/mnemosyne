// Shared helper for reporting LLM token/cost usage through the CoreContext hook.
//
// Hexagonal: core never imports the server's metrics layer. The host injects a
// plain `onLlmUsage` function (see CoreContext) and this helper invokes it
// fire-and-forget — a metrics failure must NEVER break a memory operation.
//
// Completions go through the LLMAdapter port. The port now surfaces the vendor's
// estimated cost (`LLMOutput.costUSD`) alongside token counts, so completion-path
// callers emit two reports — `prompt` (input tokens) and `completion` (output
// tokens) — and attach the call's `costUSD` to the `completion` report (once, to
// avoid double-counting). When the model is not priced the cost is undefined and
// the host records zero cost rather than fabricating a rate. Embedding-path usage
// is reported by the host directly.

import type { CoreContext } from "./context.js";

/**
 * Emit prompt + completion token usage for one completion call.
 *
 * No-op when no hook is wired. Never throws: any error from the host's hook is
 * caught and logged at debug, so consolidation/compression/recall continue.
 *
 * @param ctx       the core context carrying the optional onLlmUsage hook + logger
 * @param provider  vendor identity (use `ctx.llm.id`)
 * @param model     model name reported by the call (`out.model`)
 * @param tokensIn  input/prompt tokens (>= 0)
 * @param tokensOut output/completion tokens (>= 0)
 * @param costUSD   vendor-estimated USD cost for the call (`out.costUSD`); omit/undefined when unpriced
 */
export function reportLlmUsage(
  ctx: Pick<CoreContext, "onLlmUsage" | "logger">,
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  costUSD?: number,
): void {
  const hook = ctx.onLlmUsage;
  if (!hook) return;
  try {
    hook({ provider, model, kind: "prompt", tokens: tokensIn });
    // Cost rides on the completion side only — emitting it on both would double
    // the host's llm_cost_microdollars_total for a single call.
    hook({ provider, model, kind: "completion", tokens: tokensOut, costUSD });
  } catch (err) {
    // Metrics are best-effort. Log, never rethrow (no silent swallow).
    ctx.logger.debug("llm-usage: onLlmUsage hook threw — ignoring", {
      operation: "llm.usage_report",
      error: { type: "UsageHookError", message: err instanceof Error ? err.message : String(err) },
    });
  }
}
