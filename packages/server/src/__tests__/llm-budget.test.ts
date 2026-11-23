/**
 * MNEMO_LLM_DAILY_BUDGET_USD: the BudgetGuard is armed only with the variable,
 * and a capped completion makes its consumer degrade instead of failing.
 */
import { describe, it, expect, vi } from "vitest";
import * as llmProviders from "@mnemo-ai/llm-providers";
import type { CreatedProvider, CompleteRequest } from "@mnemo-ai/llm-providers";
import { createLlmAdapter } from "@mnemo-ai/adapter-llm";
import { maybeRerank } from "@mnemo-ai/core/cognitive";
import { applyLlmDailyBudget, parseLlmDailyBudget } from "../boot/llm-budget.js";
import { llmDailySpendUsd } from "../metrics/index.js";

function fakeProvider(costUSD = 0.6): { provider: CreatedProvider; calls: () => number } {
  let calls = 0;
  const provider = {
    name: "openai",
    capabilities: { embed: true, complete: true, streaming: false, jsonMode: true },
    embed: async () => [1, 0],
    embedWithUsage: async () => ({
      vector: [1, 0],
      tokensUsed: 1,
      model: "m",
      provider: "openai",
    }),
    embedBatch: async () => ({ vectors: [[1, 0]], tokensUsed: 1, model: "m", provider: "openai" }),
    complete: async (req: CompleteRequest) => {
      calls++;
      return {
        text: '["b","a"]',
        tokensIn: 10,
        tokensOut: 5,
        model: req.model ?? "gpt-4o-mini",
        provider: "openai",
        costUSD,
      };
    },
  } as unknown as CreatedProvider;
  return { provider, calls: () => calls };
}

const logger = () => ({ warn: vi.fn() });

describe("parseLlmDailyBudget", () => {
  it("is undefined without the variable, so no guard is armed", () => {
    expect(parseLlmDailyBudget({})).toBeUndefined();
    expect(parseLlmDailyBudget({ MNEMO_LLM_DAILY_BUDGET_USD: " " })).toBeUndefined();
  });

  it("reads a positive amount of dollars", () => {
    expect(parseLlmDailyBudget({ MNEMO_LLM_DAILY_BUDGET_USD: "2.5" })).toBe(2.5);
  });

  it.each(["0", "-1", "five", "Infinity"])("refuses %s", (v) => {
    expect(() => parseLlmDailyBudget({ MNEMO_LLM_DAILY_BUDGET_USD: v })).toThrow(
      /MNEMO_LLM_DAILY_BUDGET_USD/
    );
  });
});

describe("applyLlmDailyBudget", () => {
  it("refuses completions once the day's spend reaches the cap, and warns once", async () => {
    const { provider, calls } = fakeProvider(0.6);
    const log = logger();
    const guard = applyLlmDailyBudget(llmProviders, provider, 1, {
      model: "gpt-4o-mini",
      logger: log,
    });
    expect(guard).toBeDefined();

    await provider.complete!({ prompt: "a" });
    await provider.complete!({ prompt: "b" }); // 1.2 spent: soft cap lets this one land
    await expect(provider.complete!({ prompt: "c" })).rejects.toBeInstanceOf(
      llmProviders.BudgetExceededError
    );
    await expect(provider.complete!({ prompt: "d" })).rejects.toThrow();
    expect(calls()).toBe(2);
    expect(guard!.getSpentUSD()).toBeCloseTo(1.2);
    expect(llmDailySpendUsd.toLines().join("\n")).toContain("mnemo_llm_daily_spend_usd 1.2");
    const reached = log.warn.mock.calls.filter(([, m]) =>
      String(m).includes("daily_budget_reached")
    );
    expect(reached).toHaveLength(1);
  });

  it("resets at 00:00 UTC", async () => {
    const { provider, calls } = fakeProvider(2);
    let now = new Date("2026-11-19T23:59:00Z");
    applyLlmDailyBudget(llmProviders, provider, 1, {
      model: "gpt-4o-mini",
      logger: logger(),
      now: () => now,
    });
    await provider.complete!({ prompt: "a" });
    await expect(provider.complete!({ prompt: "b" })).rejects.toThrow();
    now = new Date("2026-11-20T00:00:01Z");
    await provider.complete!({ prompt: "c" });
    expect(calls()).toBe(2);
  });

  it("says when the model is unpriced, since the cap cannot see its spend", () => {
    const log = logger();
    applyLlmDailyBudget(llmProviders, fakeProvider().provider, 1, {
      model: "acme-local-7b",
      logger: log,
    });
    expect(log.warn.mock.calls[0]?.[1]).toContain("llm.budget_unpriced_model");
  });

  it("leaves embeddings alone so writes never hit the cap", async () => {
    const { provider } = fakeProvider(5);
    const embed = provider.embed;
    applyLlmDailyBudget(llmProviders, provider, 1, { model: "gpt-4o-mini", logger: logger() });
    expect(provider.embed).toBe(embed);
  });

  it("a capped rerank degrades to the original order instead of failing recall", async () => {
    const { provider } = fakeProvider(5);
    applyLlmDailyBudget(llmProviders, provider, 1, { model: "gpt-4o-mini", logger: logger() });
    await provider.complete!({ prompt: "spend the day's budget" });

    const ctx = {
      llm: createLlmAdapter(provider, { model: "gpt-4o-mini" }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<typeof maybeRerank>[0];
    const hits = [
      {
        id: "a",
        content: "Acme ships on Fridays",
        score: 1,
        embedding: [1, 0],
        sensitivity: "internal",
      },
      {
        id: "b",
        content: "Larkspur Robotics ships on Mondays",
        score: 0.9,
        embedding: [1, 0],
        sensitivity: "internal",
      },
    ];
    const outcome: { degraded?: boolean } = {};
    const out = await maybeRerank(
      ctx,
      { text: "when do they ship?", rerank: true, recurrenceThreshold: 0 },
      hits,
      outcome
    );
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
    expect(outcome.degraded).toBe(true);
  });
});
