/**
 * MNEMO_LLM_<TASK>_*: which provider answers each engine completion, and that
 * without those variables nothing changes.
 */
import { describe, it, expect, vi } from "vitest";
import * as llmProviders from "@mnemo-ai/llm-providers";
import type {
  CompleteRequest,
  CreatedProvider,
  CreateProviderOptions,
} from "@mnemo-ai/llm-providers";
import { createLlmAdapter } from "@mnemo-ai/adapter-llm";
import { classifyFactPair, maybeRerank } from "@mnemo-ai/core/cognitive";
import { applyLlmTaskRouting, parseLlmTaskRoutes } from "../boot/llm-router.js";
import { applyLlmDailyBudget } from "../boot/llm-budget.js";

type Call = { vendor: string; req: CompleteRequest };

/** A provider that records every completion it receives in `calls`. */
function stubProvider(
  calls: Call[],
  vendor: string,
  defaultCompleteModel: string,
  costUSD = 0.01
): CreatedProvider {
  return {
    name: vendor,
    capabilities: { embed: true, complete: true, streaming: false, jsonMode: false },
    defaultCompleteModel,
    embed: async () => [1, 0],
    embedWithUsage: async () => ({ vector: [1, 0], tokensUsed: 1, model: "e", provider: vendor }),
    embedBatch: async () => ({ vectors: [[1, 0]], tokensUsed: 1, model: "e", provider: vendor }),
    complete: async (req: CompleteRequest) => {
      calls.push({ vendor, req });
      return {
        text: "COMPATIBLE",
        tokensIn: 1,
        tokensOut: 1,
        model: req.model ?? defaultCompleteModel,
        provider: vendor,
        costUSD,
      };
    },
  } as unknown as CreatedProvider;
}

/** The llm-providers module with createProvider replaced by stubs; LLMRouter is the real one. */
function stubModule(calls: Call[], costUSD?: number) {
  const created: CreateProviderOptions[] = [];
  const mod = {
    LLMRouter: llmProviders.LLMRouter,
    createProvider: (opts: CreateProviderOptions) => {
      created.push(opts);
      return stubProvider(calls, opts.provider, opts.model ?? `${opts.provider}-default`, costUSD);
    },
  };
  return { mod, created };
}

const BASE = { MNEMO_LLM_PROVIDER: "openai", MNEMO_LLM_API_KEY: "sk-acme" };

describe("parseLlmTaskRoutes", () => {
  it("asks for no routes without MNEMO_LLM_<TASK>_* (docker passes them empty)", () => {
    expect(parseLlmTaskRoutes({})).toEqual({});
    expect(parseLlmTaskRoutes({ ...BASE, MNEMO_LLM_MODEL: "gpt-4o" })).toEqual({});
    expect(
      parseLlmTaskRoutes({ ...BASE, MNEMO_LLM_JUDGE_PROVIDER: "", MNEMO_LLM_SUMMARY_MODEL: " " })
    ).toEqual({});
  });

  it("gives another vendor only its own key, never the default's key, base URL or model", () => {
    const routes = parseLlmTaskRoutes({
      ...BASE,
      MNEMO_LLM_BASE_URL: "https://llm.acme.example/v1",
      MNEMO_LLM_MODEL: "gpt-4o",
      MNEMO_LLM_JUDGE_PROVIDER: "anthropic",
      MNEMO_LLM_JUDGE_API_KEY: "sk-ant-acme",
    });
    expect(routes).toEqual({ judge: { provider: "anthropic", apiKey: "sk-ant-acme" } });
  });

  it("lets a task on the default vendor inherit its key, base URL and model", () => {
    const routes = parseLlmTaskRoutes({
      ...BASE,
      MNEMO_LLM_BASE_URL: "https://llm.acme.example/v1",
      MNEMO_LLM_MODEL: "gpt-4o",
      MNEMO_LLM_SUMMARY_MODEL: "gpt-4o-mini",
      MNEMO_LLM_PREFILTER_API_KEY: "sk-acme-cheap",
    });
    expect(routes).toEqual({
      summary: {
        provider: "openai",
        apiKey: "sk-acme",
        baseURL: "https://llm.acme.example/v1",
        model: "gpt-4o-mini",
      },
      prefilter: {
        provider: "openai",
        apiKey: "sk-acme-cheap",
        baseURL: "https://llm.acme.example/v1",
        model: "gpt-4o",
      },
    });
  });

  it("refuses a route that would silently fall back to the default", () => {
    expect(() => parseLlmTaskRoutes({ ...BASE, MNEMO_LLM_JUDGE_PROVIDER: "anthropic" })).toThrow(
      /MNEMO_LLM_JUDGE_API_KEY/
    );
    expect(() => parseLlmTaskRoutes({ MNEMO_LLM_SUMMARY_PROVIDER: "openai" })).toThrow(
      /MNEMO_LLM_PROVIDER/
    );
  });

  it("needs no key for a local Ollama", () => {
    expect(parseLlmTaskRoutes({ ...BASE, MNEMO_LLM_PREFILTER_PROVIDER: "ollama" })).toEqual({
      prefilter: { provider: "ollama" },
    });
  });
});

describe("applyLlmTaskRouting", () => {
  it("leaves the provider untouched when nothing is routed", () => {
    const calls: Call[] = [];
    const provider = stubProvider(calls, "openai", "gpt-4o-mini");
    const complete = provider.complete;
    const { mod, created } = stubModule(calls);
    expect(applyLlmTaskRouting(mod, provider, {})).toEqual([]);
    expect(provider.complete).toBe(complete);
    expect(created).toEqual([]);
  });

  it("sends each engine completion to its task's provider, with that provider's model", async () => {
    const calls: Call[] = [];
    const provider = stubProvider(calls, "openai", "gpt-4o-mini");
    const { mod } = stubModule(calls);
    const routed = applyLlmTaskRouting(mod, provider, {
      judge: { provider: "anthropic", apiKey: "sk-ant-acme", model: "claude-haiku-4-5" },
      summary: { provider: "google", apiKey: "g-acme" },
    });
    expect(routed).toEqual([
      { task: "judge", provider: "anthropic", model: "claude-haiku-4-5" },
      { task: "summary", provider: "google", model: "google-default" },
    ]);

    const llm = createLlmAdapter(provider, { model: "gpt-4o" });
    // Engine call sites: conflict classification and rerank are judgments.
    await classifyFactPair(llm, "Acme ships on Fridays", "Acme ships on Mondays");
    await maybeRerank(
      { llm, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never,
      { text: "when does Acme ship?", rerank: true, recurrenceThreshold: 0 },
      [
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
      ] as never,
      {}
    );
    await llm.generate({ messages: [{ role: "user", content: "collapse" }], task: "summary" });
    // prefilter has no route and an untagged call is "default": both stay on the default.
    await llm.generate({ messages: [{ role: "user", content: "hyde" }], task: "prefilter" });
    await llm.generate({ messages: [{ role: "user", content: "untagged" }] });

    expect(calls.map((c) => [c.vendor, c.req.model, c.req.task])).toEqual([
      ["anthropic", undefined, undefined],
      ["anthropic", undefined, undefined],
      ["google", undefined, undefined],
      ["openai", "gpt-4o", undefined],
      ["openai", "gpt-4o", undefined],
    ]);
  });

  it("keeps the daily budget counting every task's provider", async () => {
    const calls: Call[] = [];
    const provider = stubProvider(calls, "openai", "gpt-4o-mini", 0.6);
    const { mod } = stubModule(calls, 0.6);
    const routed = applyLlmTaskRouting(mod, provider, {
      judge: { provider: "anthropic", apiKey: "sk-ant-acme" },
    });
    const guard = applyLlmDailyBudget(llmProviders, provider, 1, {
      model: "gpt-4o-mini",
      logger: { warn: vi.fn() },
      routed,
    });

    await provider.complete!({ prompt: "a", task: "judge" });
    await provider.complete!({ prompt: "b" });
    await expect(provider.complete!({ prompt: "c", task: "judge" })).rejects.toBeInstanceOf(
      llmProviders.BudgetExceededError
    );
    expect(calls.map((c) => c.vendor)).toEqual(["anthropic", "openai"]);
    expect(guard!.getSpentUSD()).toBeCloseTo(1.2);
  });
});
