/**
 * Google Gemini provider — embeddings + chat completions.
 *
 * Uses Google's "Generative Language API" (generativelanguage.googleapis.com),
 * NOT Vertex AI. Vertex requires GCP service-account auth and a project ID,
 * which is a much heavier integration. Workspaces that need Vertex can
 * subclass this provider and override the URL/auth — but the default path
 * uses a simple API key, matching the OpenAI/Anthropic ergonomic baseline.
 *
 * Gemini's API names tokens "candidateTokenCount" / "promptTokenCount"
 * which we normalize to tokensIn/tokensOut.
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
  embedding: z.object({ values: z.array(z.number()) }),
});

const BatchEmbedApiResponse = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
});

const GenerateApiResponse = z.object({
  candidates: z.array(
    z.object({
      content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }),
      finishReason: z.string().optional(),
    }),
  ),
  usageMetadata: z.object({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    totalTokenCount: z.number().optional(),
  }),
  modelVersion: z.string().optional(),
});

export class GoogleProvider implements LLMProvider {
  public readonly name = "google";
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
      throw new LLMProviderError("GoogleProvider requires apiKey", { provider: "google" });
    }
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://generativelanguage.googleapis.com/v1beta";
    this.defaultEmbedModel = config.defaultEmbedModel ?? "text-embedding-004";
    this.defaultCompleteModel = config.defaultCompleteModel ?? "gemini-2.0-flash";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const model = input.model ?? this.defaultEmbedModel;
    // Gemini batches via a different endpoint than single. We always batch
    // for consistency, even if there is only one input — the API accepts it.
    const requests = input.texts.map((t) => ({
      model: `models/${model}`,
      content: { parts: [{ text: t }] },
    }));
    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/models/${model}:batchEmbedContents`,
      body: { requests },
      // The key travels in a header: a URL query ends up in proxy and tracing logs.
      headers: { "x-goog-api-key": this.apiKey },
      timeoutMs: this.timeoutMs,
    });
    const parsed = BatchEmbedApiResponse.parse(raw);
    // Gemini does NOT report token usage on the embed endpoint. We
    // approximate as 1 token per 4 characters — close enough for cost
    // estimation, but flagged here so callers know the costUSD is approximate.
    const approxTokens = input.texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return {
      vectors: parsed.embeddings.map((e) => e.values),
      tokensUsed: approxTokens,
      costUSD: estimateEmbedCost(this.name, model, approxTokens),
      model,
      provider: this.name,
    };
  }

  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    const model = input.model ?? this.defaultCompleteModel;
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        maxOutputTokens: input.maxTokens,
        temperature: input.temperature,
        ...(input.json ? { responseMimeType: "application/json" } : {}),
      },
    };
    if (input.system) {
      // systemInstruction is the canonical Gemini field; do NOT merge into messages.
      body.systemInstruction = { parts: [{ text: input.system }] };
    }

    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/models/${model}:generateContent`,
      body,
      headers: { "x-goog-api-key": this.apiKey },
      timeoutMs: this.timeoutMs,
    });
    const parsed = GenerateApiResponse.parse(raw);
    const first = parsed.candidates[0];
    if (!first) {
      throw new LLMProviderError("Google returned zero candidates", { provider: this.name, body: raw });
    }
    const text = first.content.parts.map((p) => p.text ?? "").join("");
    const tokensIn = parsed.usageMetadata.promptTokenCount ?? 0;
    const tokensOut = parsed.usageMetadata.candidatesTokenCount ?? 0;
    return {
      text,
      tokensIn,
      tokensOut,
      costUSD: estimateCompleteCost(this.name, model, tokensIn, tokensOut),
      model: parsed.modelVersion ?? model,
      provider: this.name,
      finishReason: first.finishReason,
    };
  }
}
// Silence unused-import warning when consumers only use one entry point.
void EmbedApiResponse;
