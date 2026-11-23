/**
 * Ollama provider — local embeddings + completions.
 *
 * Ollama runs a localhost HTTP server (default :11434) that exposes any
 * downloaded model. This is the default "offline / privacy-first" provider
 * for Mnemosyne — no API key, no egress, no per-token cost.
 *
 * Trade-offs:
 *   - Quality of local models lags hosted frontier models by a generation.
 *   - First request after `ollama pull` can be slow as the model loads
 *     into memory; we set a higher default timeout (120s) for that reason.
 *   - There is no streaming support exposed here; we wait for full output.
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

const EmbedApiResponse = z.object({
  embeddings: z.array(z.array(z.number())),
  prompt_eval_count: z.number().optional(),
});

const GenerateApiResponse = z.object({
  response: z.string(),
  done: z.boolean().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  done_reason: z.string().optional(),
});

export class OllamaProvider implements LLMProvider {
  public readonly name = "ollama";
  public readonly capabilities: LLMCapabilities = {
    embed: true,
    complete: true,
    // Ollama supports streaming on the wire but we do not expose it.
    streaming: false,
    // Ollama supports a "format=json" flag that we wire up; quality depends
    // on the underlying model.
    jsonMode: true,
  };

  private readonly baseURL: string;
  private readonly defaultEmbedModel: string;
  readonly defaultCompleteModel: string;
  private readonly timeoutMs: number;
  private readonly numThread: number | undefined;

  constructor(config: ProviderConfig) {
    // apiKey intentionally ignored — local server does not authenticate
    this.baseURL = config.baseURL ?? "http://localhost:11434";
    this.defaultEmbedModel = config.defaultEmbedModel ?? "nomic-embed-text";
    this.defaultCompleteModel = config.defaultCompleteModel ?? "llama3.3";
    // Higher default because cold-start can be slow when the model is
    // loaded from disk for the first time.
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.numThread = config.numThread;
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const model = input.model ?? this.defaultEmbedModel;
    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/api/embed`,
      body: {
        model,
        input: input.texts,
        ...(this.numThread ? { options: { num_thread: this.numThread } } : {}),
      },
      timeoutMs: this.timeoutMs,
    });
    const parsed = EmbedApiResponse.parse(raw);
    return {
      vectors: parsed.embeddings,
      tokensUsed: parsed.prompt_eval_count ?? 0,
      costUSD: 0, // local — no cost
      model,
      provider: this.name,
    };
  }

  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    const model = input.model ?? this.defaultCompleteModel;
    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      system: input.system,
      stream: false,
      // P154: a thinking-capable model (qwen3 and others) otherwise spends the
      // num_predict budget on hidden reasoning and returns an empty `response`.
      think: false,
      options: {
        num_predict: input.maxTokens,
        temperature: input.temperature,
        ...(this.numThread ? { num_thread: this.numThread } : {}),
      },
    };
    if (input.json) body.format = "json";

    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/api/generate`,
      body,
      timeoutMs: this.timeoutMs,
    });
    const parsed = GenerateApiResponse.parse(raw);
    if (!parsed.done) {
      // Should be unreachable with stream:false, but defensive nonetheless.
      throw new LLMProviderError("Ollama returned incomplete generation", {
        provider: this.name,
        body: raw,
      });
    }
    return {
      text: parsed.response,
      tokensIn: parsed.prompt_eval_count ?? 0,
      tokensOut: parsed.eval_count ?? 0,
      costUSD: 0,
      model,
      provider: this.name,
      finishReason: parsed.done_reason,
    };
  }
}
