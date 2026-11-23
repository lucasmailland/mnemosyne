import { describe, it, expect, vi } from "vitest";
import { LLMRouter } from "../router.js";
import { BudgetGuard } from "../budget.js";
import { CapabilityNotSupportedError, BudgetExceededError } from "../errors.js";
import type {
  LLMProvider,
  EmbedRequest,
  EmbedResponse,
  CompleteRequest,
  CompleteResponse,
} from "../types.js";

/**
 * Tiny fake provider factory. We deliberately do NOT mock fetch here —
 * the router and budget guard are pure logic on top of the LLMProvider
 * interface, so we test them at that boundary.
 */
function fakeProvider(opts: {
  name: string;
  embedCost?: number;
  completeCost?: number;
  hasEmbed?: boolean;
  hasComplete?: boolean;
}): LLMProvider {
  const provider: LLMProvider = {
    name: opts.name,
    capabilities: {
      embed: opts.hasEmbed ?? true,
      complete: opts.hasComplete ?? true,
      streaming: false,
      jsonMode: false,
    },
  };
  if (opts.hasEmbed !== false) {
    (provider as { embed: LLMProvider["embed"] }).embed = async (input: EmbedRequest): Promise<EmbedResponse> => ({
      vectors: input.texts.map(() => [0.1, 0.2, 0.3]),
      tokensUsed: 10,
      costUSD: opts.embedCost ?? 0.001,
      model: "fake-embed",
      provider: opts.name,
    });
  }
  if (opts.hasComplete !== false) {
    (provider as { complete: LLMProvider["complete"] }).complete = async (
      input: CompleteRequest,
    ): Promise<CompleteResponse> => ({
      text: `echo:${input.prompt}`,
      tokensIn: 5,
      tokensOut: 7,
      costUSD: opts.completeCost ?? 0.01,
      model: "fake-complete",
      provider: opts.name,
    });
  }
  return provider;
}

describe("LLMRouter", () => {
  it("routes embed to perTask.embed when set", async () => {
    const def = fakeProvider({ name: "openai" });
    const embedProvider = fakeProvider({ name: "voyage" });
    const router = new LLMRouter({ default: def, perTask: { embed: embedProvider } });

    const result = await router.embed({ texts: ["hello"] });
    expect(result.provider).toBe("voyage");
    expect(result.vectors).toHaveLength(1);
  });

  it("falls back to default when perTask override is missing", async () => {
    const def = fakeProvider({ name: "openai" });
    const router = new LLMRouter({ default: def });

    const result = await router.complete({ prompt: "hi" });
    expect(result.provider).toBe("openai");
    expect(result.text).toBe("echo:hi");
  });

  it("routes complete to perTask.judge when task='judge'", async () => {
    const def = fakeProvider({ name: "openai" });
    const judgeProvider = fakeProvider({ name: "anthropic" });
    const router = new LLMRouter({ default: def, perTask: { judge: judgeProvider } });

    const result = await router.complete({ prompt: "judge this", task: "judge" });
    expect(result.provider).toBe("anthropic");
  });

  it("throws CapabilityNotSupportedError when provider lacks embed", async () => {
    const def = fakeProvider({ name: "anthropic", hasEmbed: false });
    const router = new LLMRouter({ default: def });

    await expect(router.embed({ texts: ["x"] })).rejects.toBeInstanceOf(CapabilityNotSupportedError);
  });

  it("union of capabilities reflects all providers", () => {
    const def = fakeProvider({ name: "anthropic", hasEmbed: false });
    const embed = fakeProvider({ name: "voyage", hasComplete: false });
    const router = new LLMRouter({ default: def, perTask: { embed } });

    expect(router.capabilities.embed).toBe(true);
    expect(router.capabilities.complete).toBe(true);
  });
});

describe("BudgetGuard", () => {
  it("tracks spend and fires onSpend", async () => {
    const provider = fakeProvider({ name: "openai", completeCost: 0.05 });
    const onSpend = vi.fn();
    const guard = new BudgetGuard({ provider, dailyUSDCap: 1.0, onSpend });

    await guard.complete!({ prompt: "a" });
    await guard.complete!({ prompt: "b" });

    expect(guard.getSpentUSD()).toBeCloseTo(0.1);
    expect(onSpend).toHaveBeenCalledTimes(2);
  });

  it("throws BudgetExceededError once daily cap is reached", async () => {
    const provider = fakeProvider({ name: "openai", completeCost: 0.6 });
    const guard = new BudgetGuard({ provider, dailyUSDCap: 1.0 });

    await guard.complete!({ prompt: "a" }); // spent 0.6
    await guard.complete!({ prompt: "b" }); // spent 1.2 (still allowed — soft cap)
    await expect(guard.complete!({ prompt: "c" })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("rejects when per-request cap is exceeded", async () => {
    const provider = fakeProvider({ name: "openai", completeCost: 0.5 });
    const guard = new BudgetGuard({ provider, dailyUSDCap: 100, perRequestCap: 0.1 });

    await expect(guard.complete!({ prompt: "expensive" })).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
