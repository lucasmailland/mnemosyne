/**
 * Anthropic provider — completion only.
 *
 * Anthropic does NOT offer a first-party embeddings API as of 2026-Q2.
 * Their docs explicitly recommend Voyage AI for embeddings; we follow
 * that suit. So this class only implements complete().
 *
 * Anthropic's Messages API differs from OpenAI's in several annoying ways:
 *   - system prompt is a top-level field, not a message
 *   - the user must always send `max_tokens` (no default)
 *   - the response shape is `content[]` of content blocks, not a single message
 *   - there is no native JSON mode — we instruct via the prompt instead
 */

import { z } from "zod";
import type {
  LLMProvider,
  LLMCapabilities,
  CompleteRequest,
  CompleteResponse,
  ProviderConfig,
} from "../types.js";
import { LLMProviderError } from "../errors.js";
import { httpJson } from "../http.js";
import { estimateCompleteCost } from "../pricing.js";

const MessagesApiResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  model: z.string(),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export class AnthropicProvider implements LLMProvider {
  public readonly name = "anthropic";
  public readonly capabilities: LLMCapabilities = {
    embed: false,
    complete: true,
    streaming: true,
    // No native JSON mode — we set this true because we DO support a JSON
    // request via prompt-coaxing. Callers should still validate the output.
    jsonMode: true,
  };

  private readonly apiKey: string;
  private readonly baseURL: string;
  readonly defaultCompleteModel: string;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new LLMProviderError("AnthropicProvider requires apiKey", { provider: "anthropic" });
    }
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.anthropic.com/v1";
    this.defaultCompleteModel = config.defaultCompleteModel ?? "claude-3-5-haiku-latest";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    const model = input.model ?? this.defaultCompleteModel;

    // Anthropic requires max_tokens. We default to 1024 if not provided —
    // small enough not to surprise on cost, big enough for most judgments.
    const maxTokens = input.maxTokens ?? 1024;

    // JSON coaxing: when the caller asks for JSON, prepend an instruction
    // to the system prompt. The model is well-trained for this — but we
    // still document that callers must validate, since there's no schema
    // contract from the vendor.
    let system = input.system;
    if (input.json) {
      const jsonHint =
        "You MUST respond with a single valid JSON object and nothing else. No prose, no markdown fences.";
      system = system ? `${system}\n\n${jsonHint}` : jsonHint;
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: input.prompt }],
      temperature: input.temperature,
    };
    if (system) body.system = system;

    const raw = await httpJson({
      provider: this.name,
      url: `${this.baseURL}/messages`,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      timeoutMs: this.timeoutMs,
    });
    const parsed = MessagesApiResponse.parse(raw);
    // Concatenate text blocks. Tool-use blocks etc. are dropped — Mnemosyne
    // judgments never use tools so this is intentional.
    const text = parsed.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    return {
      text,
      tokensIn: parsed.usage.input_tokens,
      tokensOut: parsed.usage.output_tokens,
      costUSD: estimateCompleteCost(this.name, model, parsed.usage.input_tokens, parsed.usage.output_tokens),
      model: parsed.model,
      provider: this.name,
      finishReason: parsed.stop_reason ?? undefined,
    };
  }
}
