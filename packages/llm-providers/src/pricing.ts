/**
 * Static USD pricing table per model.
 *
 * Why static? Because vendors do not expose a "current price for my account"
 * API. Even the AWS pricing API only covers Bedrock-hosted models, not
 * direct vendor calls. So we ship a snapshot, document the as-of date, and
 * let workspaces override entries via the `overrides` argument if they have
 * a custom enterprise rate.
 *
 * Prices below are USD per 1,000,000 tokens unless otherwise noted.
 * Embedding rates are input-only (embeddings have no output tokens).
 *
 * AS OF: 2026-Q2. Audit quarterly. Out-of-date pricing causes the
 * BudgetGuard to undercount and lets workspaces blow past their caps.
 */

export interface ModelRate {
  /** USD per 1M input tokens. */
  readonly inputUSDPerMillion: number;
  /** USD per 1M output tokens. Omit for embedding-only models. */
  readonly outputUSDPerMillion?: number;
}

// --- OpenAI -----------------------------------------------------------------
// Source: openai.com/api/pricing as of 2026-Q2.
const OPENAI_RATES: Record<string, ModelRate> = {
  // Embeddings
  "text-embedding-3-small": { inputUSDPerMillion: 0.02 },
  "text-embedding-3-large": { inputUSDPerMillion: 0.13 },
  "text-embedding-ada-002": { inputUSDPerMillion: 0.1 },
  // Chat
  "gpt-4o": { inputUSDPerMillion: 2.5, outputUSDPerMillion: 10.0 },
  "gpt-4o-mini": { inputUSDPerMillion: 0.15, outputUSDPerMillion: 0.6 },
  "gpt-4-turbo": { inputUSDPerMillion: 10.0, outputUSDPerMillion: 30.0 },
};

// --- Anthropic --------------------------------------------------------------
// Source: anthropic.com/pricing as of 2026-Q2.
const ANTHROPIC_RATES: Record<string, ModelRate> = {
  "claude-3-5-sonnet-latest": { inputUSDPerMillion: 3.0, outputUSDPerMillion: 15.0 },
  "claude-3-5-sonnet-20241022": { inputUSDPerMillion: 3.0, outputUSDPerMillion: 15.0 },
  "claude-3-5-haiku-latest": { inputUSDPerMillion: 0.8, outputUSDPerMillion: 4.0 },
  "claude-3-5-haiku-20241022": { inputUSDPerMillion: 0.8, outputUSDPerMillion: 4.0 },
  "claude-opus-4-20250514": { inputUSDPerMillion: 15.0, outputUSDPerMillion: 75.0 },
  "claude-3-opus-20240229": { inputUSDPerMillion: 15.0, outputUSDPerMillion: 75.0 },
};

// --- Google -----------------------------------------------------------------
// Source: ai.google.dev/pricing as of 2026-Q2 (paid tier).
const GOOGLE_RATES: Record<string, ModelRate> = {
  // Embeddings
  "text-embedding-004": { inputUSDPerMillion: 0.025 },
  // Chat
  "gemini-1.5-pro": { inputUSDPerMillion: 1.25, outputUSDPerMillion: 5.0 },
  "gemini-1.5-flash": { inputUSDPerMillion: 0.075, outputUSDPerMillion: 0.3 },
  "gemini-2.0-flash": { inputUSDPerMillion: 0.1, outputUSDPerMillion: 0.4 },
};

// --- Cohere -----------------------------------------------------------------
// Source: cohere.com/pricing as of 2026-Q2.
const COHERE_RATES: Record<string, ModelRate> = {
  "embed-english-v3.0": { inputUSDPerMillion: 0.1 },
  "embed-multilingual-v3.0": { inputUSDPerMillion: 0.1 },
  "command-r-plus": { inputUSDPerMillion: 2.5, outputUSDPerMillion: 10.0 },
  "command-r": { inputUSDPerMillion: 0.15, outputUSDPerMillion: 0.6 },
};

// --- Mistral ----------------------------------------------------------------
// Source: mistral.ai/technology/#pricing as of 2026-Q2.
const MISTRAL_RATES: Record<string, ModelRate> = {
  "mistral-embed": { inputUSDPerMillion: 0.1 },
  "mistral-large-latest": { inputUSDPerMillion: 2.0, outputUSDPerMillion: 6.0 },
  "mistral-small-latest": { inputUSDPerMillion: 0.2, outputUSDPerMillion: 0.6 },
};

// --- Voyage -----------------------------------------------------------------
// Source: voyageai.com/pricing as of 2026-Q2.
const VOYAGE_RATES: Record<string, ModelRate> = {
  "voyage-3": { inputUSDPerMillion: 0.06 },
  "voyage-3-large": { inputUSDPerMillion: 0.18 },
  "voyage-3-lite": { inputUSDPerMillion: 0.02 },
  "voyage-code-3": { inputUSDPerMillion: 0.18 },
};

// --- Ollama -----------------------------------------------------------------
// Ollama runs locally → cost is electricity, which we cannot meter from
// userspace. We report zero so BudgetGuard does not block local dev.
const OLLAMA_RATES: Record<string, ModelRate> = {
  "nomic-embed-text": { inputUSDPerMillion: 0 },
  "llama3.3": { inputUSDPerMillion: 0, outputUSDPerMillion: 0 },
  "qwen2.5": { inputUSDPerMillion: 0, outputUSDPerMillion: 0 },
};

/**
 * Master lookup. Provider name → model → rate.
 * Marked `as const` so consumers cannot mutate it; use `overrides` instead.
 */
export const PRICING: Readonly<Record<string, Readonly<Record<string, ModelRate>>>> = {
  openai: OPENAI_RATES,
  anthropic: ANTHROPIC_RATES,
  google: GOOGLE_RATES,
  cohere: COHERE_RATES,
  mistral: MISTRAL_RATES,
  voyage: VOYAGE_RATES,
  ollama: OLLAMA_RATES,
};

/**
 * Compute USD cost for an embedding call. Returns undefined when the model
 * is not in the table — callers should treat that as "cost unknown" rather
 * than zero, because zero would cause BudgetGuard to silently allow runaway
 * spending on a misconfigured model name.
 */
export function estimateEmbedCost(provider: string, model: string, tokens: number): number | undefined {
  const rate = PRICING[provider]?.[model];
  if (!rate) return undefined;
  return (tokens / 1_000_000) * rate.inputUSDPerMillion;
}

/**
 * Compute USD cost for a completion call. Returns undefined for unknown
 * models. See {@link estimateEmbedCost} for the reasoning.
 */
export function estimateCompleteCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number | undefined {
  const rate = PRICING[provider]?.[model];
  if (!rate || rate.outputUSDPerMillion === undefined) return undefined;
  return (tokensIn / 1_000_000) * rate.inputUSDPerMillion + (tokensOut / 1_000_000) * rate.outputUSDPerMillion;
}
