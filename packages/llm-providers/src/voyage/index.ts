/**
 * Voyage AI provider — embeddings only.
 *
 * Voyage is widely considered best-in-class for retrieval embeddings as of
 * 2026 — it consistently tops MTEB benchmarks and is the model Anthropic
 * itself recommends. Mnemosyne's "best practice" recipe is:
 *   - Voyage for embeddings (via this provider)
 *   - Anthropic for judgments (via AnthropicProvider)
 * The LLMRouter makes that pairing trivial.
 *
 * Voyage does not offer a chat/completion API; we leave complete undefined.
 */

import { z } from "zod";
import type {
  LLMProvider,
  LLMCapabilities,
  EmbedRequest,
  EmbedResponse,
  ProviderConfig,
} from "../types.js";
import { LLMProviderError } from "../errors.js";
import { httpJson } from "../http.js";
import { estimateEmbedCost } from "../pricing.js";

const EmbedApiResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  model: z.string(),
  usage: z.object({ total_tokens: z.number() }),
});

export class VoyageProvider implements LLMProvider {
  public readonly name = "voyage";
  public readonly capabilities: LLMCapabilities = {
    embed: true,
    complete: false,
    streaming: false,
    jsonMode: false,
  };

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultEmbedModel: string;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new LLMProviderError("VoyageProvider requires apiKey", { provider: "voyage" });
    }
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.voyageai.com/v1";
    this.defaultEmbedModel = config.defaultEmbedModel ?? "voyage-3";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const model = input.model ?? this.defaultEmbedModel;
    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/embeddings`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      // input_type "document" produces vectors tuned for the corpus side
      // of retrieval. For queries the caller should re-embed with
      // input_type "query" — exposing that knob is a future enhancement.
      body: { model, input: input.texts, input_type: "document" },
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
}
