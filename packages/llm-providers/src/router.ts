/**
 * LLMRouter — per-task provider dispatch.
 *
 * Why a router? Because the optimal provider for embedding text is rarely
 * the optimal provider for summarizing or judging it. Voyage is best-in-
 * class for retrieval embeddings; Anthropic is best-in-class for nuanced
 * judgments. With a router, a workspace can use both — Voyage for embed,
 * Anthropic for judge — without writing dispatch logic in every call site.
 *
 * Usage:
 *   const router = new LLMRouter({
 *     default: new OpenAIProvider({ apiKey }),
 *     perTask: {
 *       embed: new VoyageProvider({ apiKey: voyageKey }),
 *       judge: new AnthropicProvider({ apiKey: claudeKey }),
 *     },
 *   });
 *   await router.embed({ texts: [...] });          // → Voyage
 *   await router.complete({ prompt, task: "judge" }); // → Anthropic
 *   await router.complete({ prompt });                // → OpenAI (default)
 */

import type {
  LLMProvider,
  LLMCapabilities,
  EmbedRequest,
  EmbedResponse,
  CompleteRequest,
  CompleteResponse,
  CompletionTask,
} from "./types.js";
import { CapabilityNotSupportedError } from "./errors.js";

export type { CompletionTask };

export interface LLMRouterConfig {
  /** Fallback provider used when no per-task override matches. */
  default: LLMProvider;
  /** Optional overrides per task. Embedding has its own slot. */
  perTask?: {
    embed?: LLMProvider;
    judge?: LLMProvider;
    summary?: LLMProvider;
    prefilter?: LLMProvider;
  };
}

/**
 * An LLMProvider that delegates to other providers based on task. Itself
 * satisfies the LLMProvider interface so the router can be passed
 * transparently to @mnemo-ai/core as if it were a single provider.
 */
export class LLMRouter implements LLMProvider {
  public readonly name = "router";
  public readonly capabilities: LLMCapabilities;

  private readonly defaultProvider: LLMProvider;
  private readonly perTask: NonNullable<LLMRouterConfig["perTask"]>;

  constructor(config: LLMRouterConfig) {
    this.defaultProvider = config.default;
    this.perTask = config.perTask ?? {};
    // The router's capabilities are the UNION of all configured providers'
    // capabilities. Callers checking the flags before invocation get
    // accurate answers even when a capability is satisfied only by an
    // override slot.
    const all: LLMProvider[] = [
      this.defaultProvider,
      ...Object.values(this.perTask).filter((p): p is LLMProvider => Boolean(p)),
    ];
    this.capabilities = {
      embed: all.some((p) => p.capabilities.embed),
      complete: all.some((p) => p.capabilities.complete),
      streaming: all.some((p) => p.capabilities.streaming),
      jsonMode: all.some((p) => p.capabilities.jsonMode),
    };
  }

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    const provider = this.perTask.embed ?? this.defaultProvider;
    if (!provider.embed) {
      throw new CapabilityNotSupportedError(provider.name, "embed");
    }
    return provider.embed(input);
  }

  /** Complete on the provider configured for `input.task` (default when unset or unrouted). */
  async complete(input: CompleteRequest): Promise<CompleteResponse> {
    const task = input.task ?? "default";
    const provider =
      task === "judge"
        ? this.perTask.judge
        : task === "summary"
          ? this.perTask.summary
          : task === "prefilter"
            ? this.perTask.prefilter
            : undefined;
    const chosen = provider ?? this.defaultProvider;
    if (!chosen.complete) {
      throw new CapabilityNotSupportedError(chosen.name, "complete");
    }
    // Strip our custom `task` field before delegating — providers do not
    // know about it and zod-strict parsers would reject it.
    const { task: _task, ...rest } = input;
    void _task;
    return chosen.complete(rest);
  }
}
