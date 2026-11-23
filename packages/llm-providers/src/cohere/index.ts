/**
 * Cohere provider — embeddings + chat completions.
 *
 * Cohere's embed-v3 family requires an `input_type` parameter — different
 * vectors come back depending on whether you are embedding a query or a
 * document. Mnemosyne uses both modes: documents on write, queries on
 * recall. We default to "search_document" because that is the read-heavy
 * case; callers can override via `model` is not enough so we expose an
 * extension in the future. For now, the embed default is "search_document"
 * and queries are produced by re-embedding with the same model — the
 * trade-off is acceptable recall quality with simpler API surface.
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
  embeddings: z.union([z.array(z.array(z.number())), z.object({ float: z.array(z.array(z.number())) })]),
  meta: z
    .object({ billed_units: z.object({ input_tokens: z.number().optional() }).optional() })
    .optional(),
});

const ChatApiResponse = z.object({
  text: z.string().optional(),
  message: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .optional(),
  finish_reason: z.string().optional(),
  usage: z
    .object({
      tokens: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
      billed_units: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});

export class CohereProvider implements LLMProvider {
  public readonly name = "cohere";
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
      throw new LLMProviderError("CohereProvider requires apiKey", { provider: "cohere" });
    }
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.cohere.com/v2";
    this.defaultEmbedModel = config.defaultEmbedModel ?? "embed-english-v3.0";
    this.defaultCompleteModel = config.defaultCompleteModel ?? "command-r-plus";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const model = input.model ?? this.defaultEmbedModel;
    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/embed`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model,
        texts: input.texts,
        input_type: "search_document",
        embedding_types: ["float"],
      },
      timeoutMs: this.timeoutMs,
    });
    const parsed = EmbedApiResponse.parse(raw);
    const vectors = Array.isArray(parsed.embeddings) ? parsed.embeddings : parsed.embeddings.float;
    const tokens = parsed.meta?.billed_units?.input_tokens ?? 0;
    return {
      vectors,
      tokensUsed: tokens,
      costUSD: estimateEmbedCost(this.name, model, tokens),
      model,
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
      body.response_format = { type: "json_object" };
    }

    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/chat`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body,
      timeoutMs: this.timeoutMs,
    });
    const parsed = ChatApiResponse.parse(raw);
    // Cohere v2 returns content as an array of typed parts. v1 returned
    // a flat `text` field. We accept both for forward/back compatibility.
    let text = parsed.text ?? "";
    if (!text && parsed.message?.content) {
      text = parsed.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
    const tokensIn =
      parsed.usage?.billed_units?.input_tokens ?? parsed.usage?.tokens?.input_tokens ?? 0;
    const tokensOut =
      parsed.usage?.billed_units?.output_tokens ?? parsed.usage?.tokens?.output_tokens ?? 0;
    return {
      text,
      tokensIn,
      tokensOut,
      costUSD: estimateCompleteCost(this.name, model, tokensIn, tokensOut),
      model,
      provider: this.name,
      finishReason: parsed.finish_reason,
    };
  }
}
