/**
 * `createProvider` — one-call factory that returns a concrete LLMProvider
 * instance for the named vendor. Used by @mnemo-ai/server's boot path
 * (see packages/server/src/index.ts) so the host only has to supply
 * `{ provider: "openai", apiKey: "sk-..." }` from env vars instead of
 * picking the right class manually.
 *
 * The factory also exposes an `embed(text, model)` adapter on the
 * returned object so the server's `LLMProviderLike` contract — which
 * accepts a string + model and returns `number[]` — is satisfied
 * without each route having to know about the richer `EmbedRequest`
 * shape used internally.
 */

import { LLMProviderError } from "./errors.js";
import type { EmbedResponse } from "./types.js";
import { AnthropicProvider } from "./anthropic/index.js";
import { BedrockProvider } from "./bedrock/index.js";
import { CohereProvider } from "./cohere/index.js";
import { GoogleProvider } from "./google/index.js";
import { MistralProvider } from "./mistral/index.js";
import { OllamaProvider } from "./ollama/index.js";
import { OpenAIProvider } from "./openai/index.js";
import { VoyageProvider } from "./voyage/index.js";
import type { LLMProvider, ProviderConfig } from "./types.js";

/** Vendor identifiers `createProvider` understands. */
export type ProviderName =
  | "openai"
  | "anthropic"
  | "google"
  | "cohere"
  | "mistral"
  | "voyage"
  | "ollama"
  | "bedrock"
  | "nvidia";

export interface CreateProviderOptions extends ProviderConfig {
  /** Vendor identifier — case-insensitive. */
  provider: string;
  /**
   * Convenience alias for `defaultEmbedModel`. Lets the host pass a
   * single `model` env var (the common case) instead of having to know
   * the embed/complete split.
   */
  model?: string;
  /** Bedrock API Key (base64 token) — simpler alternative to IAM credentials */
  apiKey?: string;
  /** AWS IAM credentials — alternative to apiKey for Bedrock */
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
}

/**
 * The shape returned by `createProvider`.
 *
 * The factory deliberately RESHAPES `embed` to take a single string +
 * model and return just `number[]` — that's the contract
 * @mnemo-ai/server's `LLMProviderLike` consumes (see
 * packages/server/src/deps.ts). The original rich `embed({ texts, model })`
 * is preserved as `embedBatch` for hosts that want the
 * token-count/cost metadata.
 *
 * `name`, `capabilities`, and the optional `complete` are surfaced
 * unchanged so consumers that want the full provider can still reach
 * past the adapter — `created.complete?.({...})` works.
 */
/**
 * Single-string embed result that *preserves* the vendor-reported token count
 * and (when the model is in the static pricing table) the USD cost.
 *
 * This is the same usage data the inner provider already returns on
 * {@link EmbedResponse}; the plain `embed()` reshape throws it away. Hosts that
 * want to meter tokens/cost (e.g. @mnemo-ai/server's observability spine) call
 * {@link CreatedProvider.embedWithUsage} instead of `embed`.
 */
export interface EmbedWithUsageResult {
  /** The embedding vector for the single input string. */
  vector: number[];
  /** Vendor-reported tokens charged for the call (input only — embeddings have no output). */
  tokensUsed: EmbedResponse["tokensUsed"];
  /** Estimated USD cost. Undefined when the model is not in the static pricing table. */
  costUSD?: EmbedResponse["costUSD"];
  /** Exact model the vendor billed (echoed back from the response). */
  model: string;
  /** Vendor name ("openai", "voyage", ...). */
  provider: string;
}

export interface CreatedProvider {
  readonly name: string;
  readonly capabilities: LLMProvider["capabilities"];
  /** Single-string embed for @mnemo-ai/server. Throws if not supported. */
  embed(text: string, model: string): Promise<number[]>;
  /**
   * Single-string embed that ALSO returns the vendor's token usage + cost.
   * Same round-trip as `embed`, but does not discard the metering data. Used
   * by hosts that emit token/cost telemetry. Throws if embeddings unsupported.
   */
  embedWithUsage(text: string, model: string): Promise<EmbedWithUsageResult>;
  /** Original batched embed surface. Forwarded from the inner provider. */
  embedBatch: NonNullable<LLMProvider["embed"]>;
  /** Forwarded chat completion, when the provider supports it. */
  complete?: LLMProvider["complete"];
  /** The model `complete` uses when the request names none. */
  readonly defaultCompleteModel?: string;
}

/**
 * Build a provider instance for the named vendor. Unknown vendor names
 * throw `LLMProviderError` so the server boot path can log a friendly
 * message and exit instead of silently constructing an unusable stub.
 */
export function createProvider(opts: CreateProviderOptions): CreatedProvider {
  const name = (opts.provider ?? "").toLowerCase();

  // Build the base ProviderConfig. We forward `model` into
  // `defaultEmbedModel` (and `defaultCompleteModel`) so a single CLI
  // flag covers the common case without forcing the host to know which
  // method ends up calling the provider.
  const config: ProviderConfig = {
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.defaultEmbedModel !== undefined
      ? { defaultEmbedModel: opts.defaultEmbedModel }
      : opts.model !== undefined
        ? { defaultEmbedModel: opts.model }
        : {}),
    ...(opts.defaultCompleteModel !== undefined
      ? { defaultCompleteModel: opts.defaultCompleteModel }
      : opts.model !== undefined
        ? { defaultCompleteModel: opts.model }
        : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.numThread !== undefined ? { numThread: opts.numThread } : {}),
  };

  let inner: LLMProvider;
  switch (name) {
    case "openai":
      inner = new OpenAIProvider(config);
      break;
    case "anthropic":
      inner = new AnthropicProvider(config);
      break;
    case "google":
    case "gemini":
      inner = new GoogleProvider(config);
      break;
    case "cohere":
      inner = new CohereProvider(config);
      break;
    case "mistral":
      inner = new MistralProvider(config);
      break;
    case "voyage":
      inner = new VoyageProvider(config);
      break;
    case "ollama":
      inner = new OllamaProvider(config);
      break;
    case "bedrock":
      inner = new BedrockProvider({
        apiKey: opts.apiKey, // Bedrock API Key (base64 token)
        awsAccessKeyId: opts.awsAccessKeyId, // IAM alternative
        awsSecretAccessKey: opts.awsSecretAccessKey,
        awsRegion: opts.awsRegion ?? "us-east-1",
        defaultEmbedModel: config.defaultEmbedModel,
        defaultCompleteModel: opts.model, // llmModel from P6 config
      });
      break;
    case "nvidia":
      // NVIDIA NIM / Triton exposes an OpenAI-compatible API. Alias to
      // OpenAIProvider with the canonical NIM base URL so users only need to
      // set provider=nvidia and an NVIDIA API key — no manual baseURL required.
      inner = new OpenAIProvider({
        ...config,
        baseURL: config.baseURL ?? "https://integrate.api.nvidia.com/v1",
      });
      break;
    default:
      throw new LLMProviderError(
        `Unknown LLM provider "${opts.provider}". Supported: openai, anthropic, google, cohere, mistral, voyage, ollama, bedrock, nvidia.`,
        { provider: name || "unknown" }
      );
  }

  if (typeof inner.embed !== "function") {
    // We still build the wrapper for non-embed providers (Anthropic) so
    // callers can interrogate `capabilities`, but `embed()` itself
    // throws on call — failing late at use-site is more actionable than
    // failing at boot, and the server's recall route already handles
    // a missing LLM gracefully by 501-ing.
  }

  const innerEmbed = inner.embed;
  const created: CreatedProvider = {
    name: inner.name,
    capabilities: inner.capabilities,
    async embed(text: string, model: string): Promise<number[]> {
      if (typeof innerEmbed !== "function") {
        throw new LLMProviderError(`Provider "${inner.name}" does not support embeddings.`, {
          provider: inner.name,
        });
      }
      const res = await innerEmbed.call(inner, { texts: [text], model });
      const vec = res.vectors[0];
      if (!vec) {
        throw new LLMProviderError(`Provider "${inner.name}" returned no embedding vector.`, {
          provider: inner.name,
        });
      }
      return vec;
    },
    async embedWithUsage(text: string, model: string): Promise<EmbedWithUsageResult> {
      if (typeof innerEmbed !== "function") {
        throw new LLMProviderError(`Provider "${inner.name}" does not support embeddings.`, {
          provider: inner.name,
        });
      }
      const res = await innerEmbed.call(inner, { texts: [text], model });
      const vec = res.vectors[0];
      if (!vec) {
        throw new LLMProviderError(`Provider "${inner.name}" returned no embedding vector.`, {
          provider: inner.name,
        });
      }
      // Surface the vendor's real usage instead of discarding it. `costUSD` is
      // already undefined when the model is not in the pricing table (see
      // estimateEmbedCost) — we forward that "unknown" signal verbatim.
      return {
        vector: vec,
        tokensUsed: res.tokensUsed,
        ...(res.costUSD !== undefined ? { costUSD: res.costUSD } : {}),
        model: res.model,
        provider: res.provider,
      };
    },
    embedBatch: (async (req) => {
      if (typeof innerEmbed !== "function") {
        throw new LLMProviderError(`Provider "${inner.name}" does not support embeddings.`, {
          provider: inner.name,
        });
      }
      return innerEmbed.call(inner, req);
    }) as NonNullable<LLMProvider["embed"]>,
    ...(inner.complete ? { complete: inner.complete.bind(inner) } : {}),
    ...(inner.complete && inner.defaultCompleteModel
      ? { defaultCompleteModel: inner.defaultCompleteModel }
      : {}),
  };

  return created;
}
