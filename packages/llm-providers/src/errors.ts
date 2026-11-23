/**
 * Typed error hierarchy for LLM provider failures.
 *
 * Why a hierarchy instead of a single error class with a `code` field?
 * Because callers want to handle these very differently:
 *   - RateLimitedError → exponential backoff and retry
 *   - BudgetExceededError → surface to user, do NOT retry
 *   - ContextOverflowError → re-chunk the input and retry with smaller batches
 *   - LLMProviderError (generic) → bubble up, log, surface
 *
 * Using `instanceof` for dispatch is more ergonomic than parsing string codes.
 */

export class LLMProviderError extends Error {
  /** Vendor name where the error originated. */
  public readonly provider: string;
  /** HTTP status if applicable. */
  public readonly status?: number;
  /** Raw vendor response body — useful for debugging unexpected errors. */
  public readonly body?: unknown;

  constructor(
    message: string,
    opts: { provider: string; status?: number; body?: unknown; cause?: unknown } = { provider: "unknown" },
  ) {
    super(message, { cause: opts.cause });
    this.name = "LLMProviderError";
    this.provider = opts.provider;
    this.status = opts.status;
    this.body = opts.body;
  }
}

/**
 * Vendor returned 429 or equivalent. Callers should back off.
 * `retryAfterMs` is parsed from the vendor's Retry-After header when present.
 */
export class RateLimitedError extends LLMProviderError {
  public readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { provider: string; status?: number; body?: unknown; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts);
    this.name = "RateLimitedError";
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Input exceeded the model's context window. Retrying without changes is
 * pointless — caller must chunk or summarize the input first.
 */
export class ContextOverflowError extends LLMProviderError {
  public readonly tokenLimit?: number;
  public readonly tokensRequested?: number;

  constructor(
    message: string,
    opts: { provider: string; status?: number; body?: unknown; tokenLimit?: number; tokensRequested?: number; cause?: unknown },
  ) {
    super(message, opts);
    this.name = "ContextOverflowError";
    this.tokenLimit = opts.tokenLimit;
    this.tokensRequested = opts.tokensRequested;
  }
}

/**
 * Thrown by {@link BudgetGuard} — NOT by providers themselves. Indicates
 * the workspace has hit its spending cap. There is nothing the system can
 * do to recover automatically; the operator must raise the cap or wait
 * for the next budget window.
 */
export class BudgetExceededError extends Error {
  public readonly capUSD: number;
  public readonly spentUSD: number;
  public readonly scope: "daily" | "per-request";

  constructor(message: string, opts: { capUSD: number; spentUSD: number; scope: "daily" | "per-request" }) {
    super(message);
    this.name = "BudgetExceededError";
    this.capUSD = opts.capUSD;
    this.spentUSD = opts.spentUSD;
    this.scope = opts.scope;
  }
}

/**
 * Caller asked for a capability the provider does not implement
 * (e.g. embed() on Anthropic). The router throws this when no fallback exists.
 */
export class CapabilityNotSupportedError extends Error {
  public readonly provider: string;
  public readonly capability: "embed" | "complete" | "streaming" | "jsonMode";

  constructor(provider: string, capability: "embed" | "complete" | "streaming" | "jsonMode") {
    super(`Provider "${provider}" does not support capability "${capability}"`);
    this.name = "CapabilityNotSupportedError";
    this.provider = provider;
    this.capability = capability;
  }
}
