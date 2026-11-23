/**
 * BudgetGuard — wrap any provider with a USD cap.
 *
 * Why a wrapper instead of a middleware? Because providers are passed to
 * @mnemo-ai/core via the LLMProvider interface — there is no method
 * interception layer. By making the guard itself implement LLMProvider,
 * a workspace can drop it in anywhere a provider goes, including inside
 * a LLMRouter (you can budget-guard per-task providers independently).
 *
 * State model:
 *   - In-memory daily counter, reset by external bookkeeping (a daily
 *     cron, or the process restart at midnight in a serverless context).
 *   - We do NOT persist state. Workspaces that need durable budget tracking
 *     should layer their own accounting on top using `onSpend` callback.
 *
 * Race safety:
 *   - We increment the counter AFTER the provider returns the spend, so
 *     concurrent requests can briefly exceed the cap by the in-flight
 *     amount. For Mnemosyne's use case (background memory pipelines), that
 *     is acceptable. A strict-enforcement variant could pre-debit and
 *     refund on error — left as future work.
 */

import type {
  LLMProvider,
  LLMCapabilities,
  EmbedRequest,
  EmbedResponse,
  CompleteRequest,
  CompleteResponse,
} from "./types.js";
import { BudgetExceededError } from "./errors.js";

export interface BudgetGuardConfig {
  /** The provider being wrapped. The guard adds spend tracking on top. */
  provider: LLMProvider;
  /** Hard daily ceiling in USD. Resets only when `reset()` is called. */
  dailyUSDCap: number;
  /** Per-request hard ceiling. Rejects a single call estimated above this. */
  perRequestCap?: number;
  /** Hook fired after every successful call with the incremental spend. */
  onSpend?: (delta: number, totalToday: number) => void;
  /**
   * What to do when the provider returns costUSD === undefined (unknown
   * model). "block" is safest in production. "allow" is convenient in dev.
   * Default: "block".
   */
  unknownCostPolicy?: "block" | "allow";
}

export class BudgetGuard implements LLMProvider {
  public readonly name: string;
  public readonly capabilities: LLMCapabilities;

  private readonly provider: LLMProvider;
  private readonly dailyUSDCap: number;
  private readonly perRequestCap?: number;
  private readonly onSpend?: (delta: number, totalToday: number) => void;
  private readonly unknownCostPolicy: "block" | "allow";
  private spentToday = 0;

  constructor(config: BudgetGuardConfig) {
    this.provider = config.provider;
    this.dailyUSDCap = config.dailyUSDCap;
    this.perRequestCap = config.perRequestCap;
    this.onSpend = config.onSpend;
    this.unknownCostPolicy = config.unknownCostPolicy ?? "block";
    // Expose the underlying provider's identity and capabilities — the
    // guard is transparent from the caller's perspective.
    this.name = `${config.provider.name}+budget`;
    this.capabilities = config.provider.capabilities;
  }

  /** Manually reset the in-memory daily counter — call from a midnight cron. */
  reset(): void {
    this.spentToday = 0;
  }

  /** Inspect current spend. Useful for telemetry / dashboards. */
  getSpentUSD(): number {
    return this.spentToday;
  }

  /** Inspect remaining headroom. Negative if somehow overshot. */
  getRemainingUSD(): number {
    return this.dailyUSDCap - this.spentToday;
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    if (!this.provider.embed) {
      throw new BudgetExceededError(`Underlying ${this.provider.name} does not support embed`, {
        capUSD: this.dailyUSDCap,
        spentUSD: this.spentToday,
        scope: "per-request",
      });
    }
    this.assertHeadroom();
    const response = await this.provider.embed(input);
    this.accountFor(response.costUSD);
    return response;
  }

  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    if (!this.provider.complete) {
      throw new BudgetExceededError(`Underlying ${this.provider.name} does not support complete`, {
        capUSD: this.dailyUSDCap,
        spentUSD: this.spentToday,
        scope: "per-request",
      });
    }
    this.assertHeadroom();
    const response = await this.provider.complete(input);
    this.accountFor(response.costUSD);
    return response;
  }

  /** Throw if we are already at or past the daily cap. */
  private assertHeadroom(): void {
    if (this.spentToday >= this.dailyUSDCap) {
      throw new BudgetExceededError(
        `Daily budget cap of $${this.dailyUSDCap} reached (spent $${this.spentToday.toFixed(4)})`,
        { capUSD: this.dailyUSDCap, spentUSD: this.spentToday, scope: "daily" }
      );
    }
  }

  /**
   * Apply the post-call spend and enforce per-request + daily caps.
   *
   * BUD-1: by the time this runs, the provider call already happened and
   * was actually billed — the money is already spent regardless of what
   * this method decides next. So `spentToday`/`onSpend` are updated FIRST,
   * unconditionally, and only then do we check whether this request
   * exceeded a cap. Throwing before recording used to undercount real
   * spend on every request that blew the per-request cap.
   */
  private accountFor(costUSD: number | undefined): void {
    if (costUSD === undefined) {
      if (this.unknownCostPolicy === "block") {
        throw new BudgetExceededError(
          `Provider returned undefined cost (unknown model). Refusing to track spend under "block" policy.`,
          { capUSD: this.dailyUSDCap, spentUSD: this.spentToday, scope: "per-request" }
        );
      }
      return; // policy=allow → silently ignore
    }
    this.spentToday += costUSD;
    if (this.onSpend) {
      try {
        this.onSpend(costUSD, this.spentToday);
      } catch {
        // Swallow user callback errors — telemetry should never break
        // the request path.
      }
    }
    if (this.perRequestCap !== undefined && costUSD > this.perRequestCap) {
      throw new BudgetExceededError(
        `Single request cost $${costUSD.toFixed(4)} exceeds per-request cap $${this.perRequestCap}`,
        { capUSD: this.perRequestCap, spentUSD: costUSD, scope: "per-request" }
      );
    }
    if (this.spentToday > this.dailyUSDCap) {
      // Note: we still let THIS request through (it already succeeded),
      // but the next assertHeadroom() will reject. This makes the daily
      // cap a soft post-fact ceiling rather than a hard pre-debit.
    }
  }
}
