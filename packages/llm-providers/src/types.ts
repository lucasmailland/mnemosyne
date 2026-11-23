/**
 * Public type contract for any Mnemosyne LLM provider.
 *
 * This file defines the *only* surface that @mnemo-ai/core depends on.
 * Concrete provider classes (OpenAI, Anthropic, etc.) implement it. By
 * keeping this interface narrow and capability-flagged, we let the core
 * library mix and match providers per task without a giant pile of
 * vendor-specific code paths.
 *
 * Trade-off: we intentionally do NOT expose streaming, function calling,
 * vision, tools, or any other vendor-specific capability through this
 * surface — those are out of scope for cognitive memory. If a workspace
 * needs them, they can talk to the vendor SDK directly. Mnemosyne only
 * needs two primitives: embed and complete.
 */

export interface LLMCapabilities {
  /** Provider can turn text into vectors. */
  readonly embed: boolean;
  /** Provider can produce a text completion / judgment. */
  readonly complete: boolean;
  /** Provider supports incremental token streaming (not used by core yet, but useful for telemetry). */
  readonly streaming: boolean;
  /** Provider can return guaranteed-JSON output via a native mode. */
  readonly jsonMode: boolean;
}

export interface EmbedRequest {
  /** One or more strings to embed in a single API round-trip. */
  readonly texts: string[];
  /** Override the provider's default embedding model. */
  readonly model?: string;
}

export interface EmbedResponse {
  /** One vector per input string, in the same order. */
  readonly vectors: number[][];
  /** Tokens charged by the vendor for the call (input only — embeddings have no output tokens). */
  readonly tokensUsed: number;
  /** Estimated USD cost. Undefined when the model is not in our static pricing table. */
  readonly costUSD?: number;
  /** Echoed back so callers can log which exact model produced the vector. */
  readonly model: string;
  /** Vendor name — useful for routing logs. */
  readonly provider: string;
}

/**
 * Logical task names used to route completions (see {@link LLMRouter}).
 * Embeddings have a single task ("embed") which is implicit on embed().
 */
export type CompletionTask = "judge" | "summary" | "prefilter" | "default";

export interface CompleteRequest {
  /** The user-facing prompt. */
  readonly prompt: string;
  /** Optional system message — set the role / persona. */
  readonly system?: string;
  /** Override the provider's default chat/completion model. */
  readonly model?: string;
  /** Cap on output tokens. Providers translate this to their own param name. */
  readonly maxTokens?: number;
  /** 0.0 = deterministic, 1.0 = creative. Mnemosyne judgments default to ~0.1. */
  readonly temperature?: number;
  /** When true, request JSON-mode output. Provider throws if not supported. */
  readonly json?: boolean;
  /** Routing hint for LLMRouter, which strips it. A single provider ignores it. */
  readonly task?: CompletionTask;
}

export interface CompleteResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUSD?: number;
  readonly model: string;
  readonly provider: string;
  /** Vendor-reported stop reason ("stop", "length", "content_filter", ...). Surfaced for debugging. */
  readonly finishReason?: string;
}

/**
 * The contract every provider implements.
 *
 * Both methods are optional because we have embedding-only providers
 * (Voyage) and completion-only providers (Anthropic). Callers must check
 * `capabilities` before invoking. The {@link LLMRouter} does this check
 * automatically and routes around providers that lack a capability.
 */
export interface LLMProvider {
  /** Vendor identifier — "openai", "anthropic", "google", etc. Used for logging and telemetry. */
  readonly name: string;
  /** Capability flags so the router knows what this provider can do. */
  readonly capabilities: LLMCapabilities;
  /** The model `complete` uses when the request names none. Absent when the provider cannot complete. */
  readonly defaultCompleteModel?: string;

  /** Convert text → vector. Optional. */
  embed?(input: EmbedRequest): Promise<EmbedResponse>;

  /** Generate a completion. Optional. */
  complete?(input: CompleteRequest): Promise<CompleteResponse>;
}

/**
 * Common constructor options every provider accepts.
 *
 * `baseURL` is here so workspaces can point at:
 *   - a corporate proxy (Azure OpenAI, AWS Bedrock proxy)
 *   - a local emulator (Ollama, vLLM)
 *   - a test mock (MSW, nock)
 * Without baseURL override, providers hit their canonical public endpoint.
 */
export interface ProviderConfig {
  /** API key. Required for hosted providers; ignored by Ollama. */
  readonly apiKey?: string;
  /** Override the base URL — useful for proxies, Azure, local LLM servers, tests. */
  readonly baseURL?: string;
  /** Default model for embed() when no model is passed in the request. */
  readonly defaultEmbedModel?: string;
  /** Default model for complete() when no model is passed in the request. */
  readonly defaultCompleteModel?: string;
  /** HTTP timeout in milliseconds. Defaults to 60_000. */
  readonly timeoutMs?: number;
  /**
   * Ollama only: threads per request (`options.num_thread`). Unset leaves the
   * choice to Ollama, which takes every core it sees. Inside a container or VM
   * that count includes efficiency cores and oversubscribes: a bge-m3 embed
   * measured 3.8-5.5s at 15 threads against 0.12s at 4 on the same machine.
   */
  readonly numThread?: number;
}
