/**
 * @mnemo-ai/adapter-llm
 *
 * Bridges {@link CreatedProvider} (from @mnemo-ai/llm-providers) to the
 * {@link LLMAdapter} hexagonal port (from @mnemo-ai/types).
 *
 * Hexagonal-purity: NO imports from drizzle-orm, pg, redis, or @neondatabase.
 */

import type { CreatedProvider } from "@mnemo-ai/llm-providers";
import type {
  LLMAdapter,
  LLMInput,
  LLMOutput,
  LLMTask,
  SchemaLike,
  HealthStatus,
} from "@mnemo-ai/types";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Flatten an {@link LLMInput} into the single `prompt` string that
 * `CreatedProvider.complete` expects.
 *
 * Format:
 *   [system content if present]
 *   user: <message>
 *   assistant: <message>
 *   ...
 */
function buildPrompt(input: LLMInput): string {
  const parts: string[] = [];
  if (input.system) {
    parts.push(input.system);
  }
  for (const msg of input.messages) {
    parts.push(`${msg.role}: ${msg.content}`);
  }
  return parts.join("\n");
}

/**
 * Map a vendor `finishReason` string to the discriminated union expected by
 * {@link LLMOutput}.
 */
function mapFinishReason(raw: string | undefined): LLMOutput["finishReason"] {
  switch (raw) {
    case "length":
    case "max_tokens":
      return "length";
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    default:
      // Vendor-specific stop reasons ("content_filter", "safety", "error") are
      // collapsed to "stop". Callers should inspect response.content for refusal text.
      return "stop";
  }
}

// ─── LlmProviderAdapter ───────────────────────────────────────────────────────

export interface LlmProviderAdapterOptions {
  /** Logical identifier for this adapter instance. Defaults to `provider.name`. */
  id?: string;
  /**
   * The model name to use for completions.
   * Forwarded as `CompleteRequest.model` and surfaced as `LLMAdapter.model`.
   */
  model: string;
  /** Tasks answered by a provider the operator runs locally (`LLMAdapter.localTasks`). */
  localTasks?: readonly LLMTask[];
}

/**
 * Thin wrapper that makes any {@link CreatedProvider} satisfy the
 * {@link LLMAdapter} port without leaking infrastructure concerns into the
 * core domain.
 */
export class LlmProviderAdapter implements LLMAdapter {
  readonly id: string;
  readonly model: string;
  readonly localTasks?: readonly LLMTask[];

  readonly #provider: CreatedProvider;

  constructor(provider: CreatedProvider, opts: LlmProviderAdapterOptions) {
    this.#provider = provider;
    this.id = opts.id ?? provider.name;
    this.model = opts.model;
    if (opts.localTasks) this.localTasks = opts.localTasks;
  }

  // ─── generate ──────────────────────────────────────────────────────────────

  async generate(input: LLMInput): Promise<LLMOutput> {
    if (input.messages.length === 0) {
      throw new Error(
        `LlmProviderAdapter(${this.id}): LLMInput.messages must contain at least one message.`
      );
    }

    if (typeof this.#provider.complete !== "function") {
      throw new Error(
        `LlmProviderAdapter(${this.id}): underlying provider "${this.#provider.name}" ` +
          `does not support completions (complete is undefined).`
      );
    }

    const response = await this.#provider.complete({
      prompt: buildPrompt(input),
      system: input.system,
      model: this.model,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      task: input.task,
    });

    return {
      content: response.text,
      tokensUsed: {
        input: response.tokensIn,
        output: response.tokensOut,
      },
      model: response.model,
      finishReason: mapFinishReason(response.finishReason),
      // Surface the vendor's real provider id + cost instead of dropping them, so
      // completion-path metrics can record true cost (not zero/"unknown"). costUSD
      // stays undefined when the model is not in the provider's pricing table.
      provider: response.provider,
      ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
    };
  }

  // ─── generateStructured ────────────────────────────────────────────────────

  async generateStructured<T>(input: LLMInput, schema: SchemaLike<T>): Promise<T> {
    if (input.messages.length === 0) {
      throw new Error(
        `LlmProviderAdapter(${this.id}): LLMInput.messages must contain at least one message.`
      );
    }

    // We need to pass json: true to complete when jsonMode is supported.
    // generate() does not expose that flag, so we call complete() directly.
    if (typeof this.#provider.complete !== "function") {
      throw new Error(
        `LlmProviderAdapter(${this.id}): underlying provider "${this.#provider.name}" ` +
          `does not support completions (complete is undefined).`
      );
    }

    const response = await this.#provider.complete({
      prompt: buildPrompt(input),
      system: input.system,
      model: this.model,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      json: this.#provider.capabilities.jsonMode ? true : undefined,
      task: input.task,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch (err) {
      throw new Error(
        `LlmProviderAdapter(${this.id}): provider returned non-JSON content. ` +
          `Parse error: ${err instanceof Error ? err.message : String(err)}. ` +
          `Raw content (first 200 chars): ${response.text.slice(0, 200)}`
      );
    }

    try {
      return schema.parse(parsed);
    } catch (err) {
      throw new Error(
        `LlmProviderAdapter(${this.id}): schema validation failed after JSON parse. ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ─── healthCheck ───────────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthStatus> {
    if (typeof this.#provider.complete !== "function") {
      return { status: "degraded", latencyMs: 0, detail: "complete not supported" };
    }

    const start = Date.now();
    try {
      await this.#provider.complete({
        prompt: "ping",
        model: this.model,
        maxTokens: 1,
        task: "default",
      });
      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * Convenience factory — avoids `new` at call sites.
 *
 * @example
 * ```ts
 * import { createProvider } from "@mnemo-ai/llm-providers";
 * import { createLlmAdapter } from "@mnemo-ai/adapter-llm";
 *
 * const provider = createProvider({ provider: "openai", apiKey: process.env.OPENAI_API_KEY! });
 * const adapter  = createLlmAdapter(provider, { model: "gpt-4o-mini" });
 * ```
 */
export function createLlmAdapter(
  provider: CreatedProvider,
  opts: LlmProviderAdapterOptions
): LLMAdapter {
  return new LlmProviderAdapter(provider, opts);
}

// ─── re-exports ───────────────────────────────────────────────────────────────

export type { LLMAdapter, LLMInput, LLMOutput, LLMMessage, SchemaLike } from "@mnemo-ai/types";
