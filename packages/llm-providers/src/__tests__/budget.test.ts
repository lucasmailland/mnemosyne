/**
 * BUD-1 — BudgetGuard.accountFor() used to throw BudgetExceededError on a
 * per-request-cap overage BEFORE recording the spend. The provider call had
 * already happened and was already billed by the vendor at that point, so
 * spentToday silently undercounted real spend on every request that blew
 * the per-request cap. Fixed to record first, then enforce.
 */
import { describe, it, expect } from "vitest";
import { BudgetGuard } from "../budget.js";
import { BudgetExceededError } from "../errors.js";
import type { LLMProvider, CompleteRequest, CompleteResponse } from "../types.js";

function providerReturning(costUSD: number): LLMProvider {
  return {
    name: "mock",
    capabilities: { embed: false, complete: true, streaming: false, jsonMode: false },
    async complete(_input: CompleteRequest): Promise<CompleteResponse> {
      return {
        text: "ok",
        tokensIn: 10,
        tokensOut: 10,
        costUSD,
        model: "mock-model",
        provider: "mock",
      };
    },
  };
}

describe("BudgetGuard.accountFor — per-request-cap overage accounting (BUD-1)", () => {
  it("records the spend AND throws when a single request exceeds the per-request cap", async () => {
    const provider = providerReturning(5.0);
    const guard = new BudgetGuard({ provider, dailyUSDCap: 100, perRequestCap: 1.0 });

    await expect(guard.complete({ prompt: "hi" })).rejects.toThrow(BudgetExceededError);

    // The provider call already happened and was already billed — spend
    // must be recorded even though the request was rejected after the fact.
    expect(guard.getSpentUSD()).toBe(5.0);
  });

  it("fires onSpend with the real cost before throwing on a per-request-cap overage", async () => {
    const provider = providerReturning(5.0);
    const spends: Array<{ delta: number; total: number }> = [];
    const guard = new BudgetGuard({
      provider,
      dailyUSDCap: 100,
      perRequestCap: 1.0,
      onSpend: (delta, total) => spends.push({ delta, total }),
    });

    await expect(guard.complete({ prompt: "hi" })).rejects.toThrow(BudgetExceededError);

    expect(spends).toEqual([{ delta: 5.0, total: 5.0 }]);
  });

  it("does not double count: a normal within-cap request still records once", async () => {
    const provider = providerReturning(0.5);
    const guard = new BudgetGuard({ provider, dailyUSDCap: 100, perRequestCap: 1.0 });

    await guard.complete({ prompt: "hi" });

    expect(guard.getSpentUSD()).toBe(0.5);
  });
});
