/**
 * Mistral provider — embeddings + chat completions.
 *
 * Mistral's API shape is OpenAI-compatible for both endpoints, which makes
 * this provider almost a copy of OpenAIProvider. We keep it separate so
 * pricing, defaults, and capability flags are tracked independently — and
 * so future Mistral-specific features (e.g. safe-mode, function calls)
 * have a place to live without contaminating the OpenAI class.
 */

import { z } from "zod";
import type {
  LLMProvider,
  LLMCapabilities,
  EmbedRequest,
  EmbedResponse,
  CompleteRequest,
  CompleteResponse,
  ProviderConfig,
} from "../types.js";
import { LLMProviderError } from "../errors.js";
import { httpJson } from "../http.js";
import { estimateEmbedCost, estimateCompleteCost } from "../pricing.js";

const EmbedApiResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  model: z.string(),
  usage: z.object({ prompt_tokens: z.number(), total_tokens: z.number() }),
});

const ChatApiResponse = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

export class MistralProvider implements LLMProvider {
  public readonly name = "mistral";
  public readonly capabilities: LLMCapabilities = {
    embed: true,
    complete: true,
    streaming: true,
    jsonMode: true,
  };

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultEmbedModel: string;
  readonly defaultCompleteModel: string;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new LLMProviderError("MistralProvider requires apiKey", { provider: "mistral" });
    }
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.mistral.ai/v1";
    this.defaultEmbedModel = config.defaultEmbedModel ?? "mistral-embed";
    this.defaultCompleteModel = config.defaultCompleteModel ?? "mistral-large-latest";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const model = input.model ?? this.defaultEmbedModel;
    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/embeddings`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: { model, input: input.texts },
      timeoutMs: this.timeoutMs,
    });
    const parsed = EmbedApiResponse.parse(raw);
    const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
    return {
      vectors: ordered.map((d) => d.embedding),
      tokensUsed: parsed.usage.total_tokens,
      costUSD: estimateEmbedCost(this.name, model, parsed.usage.total_tokens),
      model: parsed.model,
      provider: this.name,
    };
  }

  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    const model = input.model ?? this.defaultCompleteModel;
    const messages: Array<{ role: string; content: string }> = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.prompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
    };
    if (input.json) body.response_format = { type: "json_object" };

    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/chat/completions`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body,
      timeoutMs: this.timeoutMs,
    });
    const parsed = ChatApiResponse.parse(raw);
    const first = parsed.choices[0];
    if (!first) {
      throw new LLMProviderError("Mistral returned zero choices", { provider: this.name, body: raw });
    }
    return {
      text: first.message.content ?? "",
      tokensIn: parsed.usage.prompt_tokens,
      tokensOut: parsed.usage.completion_tokens,
      costUSD: estimateCompleteCost(this.name, model, parsed.usage.prompt_tokens, parsed.usage.completion_tokens),
      model: parsed.model,
      provider: this.name,
      finishReason: first.finish_reason ?? undefined,
    };
  }
}
