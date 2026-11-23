/**
 * OpenAI provider — embeddings + chat completions.
 *
 * We hit the REST API directly with native fetch instead of pulling in the
 * official `openai` SDK. The SDK is ~3 MB installed and brings its own
 * fetch polyfill, retry logic, and zod-like validators — none of which we
 * need. By going raw we keep the bundle tiny and let the workspace upgrade
 * OpenAI features on its own schedule.
 *
 * Compatible with Azure OpenAI when `baseURL` is overridden to the Azure
 * endpoint shape. The request body is identical.
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

// --- Response schemas -------------------------------------------------------
// We validate every vendor response. Vendors change shapes silently
// (especially during deprecation windows) and a runtime check is cheaper
// than debugging a `undefined.embedding[0]` crash in production.

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

export class OpenAIProvider implements LLMProvider {
  public readonly name = "openai";
  public readonly capabilities: LLMCapabilities = {
    embed: true,
    complete: true,
    streaming: true, // capability exists in the vendor; mnemosyne does not call it
    jsonMode: true,
  };

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultEmbedModel: string;
  readonly defaultCompleteModel: string;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new LLMProviderError("OpenAIProvider requires apiKey", { provider: "openai" });
    }
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.openai.com/v1";
    this.defaultEmbedModel = config.defaultEmbedModel ?? "text-embedding-3-small";
    this.defaultCompleteModel = config.defaultCompleteModel ?? "gpt-4o-mini";
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
    // Sort by index because OpenAI does not guarantee returned order
    // matches input order when batching — better safe than silently wrong.
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
    if (input.json) {
      // gpt-4o family supports response_format. Older models will 400 — we
      // do not silently downgrade because that would mask a config error.
      body.response_format = { type: "json_object" };
    }

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
      throw new LLMProviderError("OpenAI returned zero choices", { provider: this.name, body: raw });
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
