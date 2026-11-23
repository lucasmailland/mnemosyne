/**
 * WorkspaceLlmAdapter — wraps LlmConfigResolver to produce a per-request
 * LLMAdapter that uses the workspace's configured provider (DB config →
 * global config → env fallback).
 *
 * Used by capture.ts and other routes that need completions scoped to
 * the calling workspace rather than the boot-time global provider.
 */
import type { LLMAdapter, LLMInput, LLMOutput } from "@mnemo-ai/types";
import type { LLMProviderLike } from "../deps.js";
import type { LlmConfigResolver } from "./LlmConfigResolver.js";

/**
 * Keep truncation visible: a hardcoded "stop" let a reply cut at maxTokens
 * reach the JSON parser looking like a model that answered badly.
 */
export function toFinishReason(raw: string | undefined): LLMOutput["finishReason"] {
  if (raw === "length" || raw === "max_tokens") return "length";
  if (raw === "tool_use" || raw === "tool_calls") return "tool_use";
  return "stop";
}

/**
 * Boot diagnostic: true when a workspace without DB config will run its
 * completions on the embedding provider, because MNEMO_LLM_PROVIDER /
 * MNEMO_LLM_MODEL produced no completion adapter. That fallback is kept for
 * deployments that rely on it, but it uses the embedding provider's built-in
 * default model and credentials, so boot warns about it.
 */
export function completionFallsBackToEmbedProvider(
  bootAdapter: LLMAdapter | undefined,
  embedProvider: LLMProviderLike | undefined
): boolean {
  return (
    !bootAdapter &&
    typeof (embedProvider as { complete?: unknown } | undefined)?.complete === "function"
  );
}

/**
 * Build an LLMAdapter for a specific workspace by resolving its configured
 * provider. Returns null when no provider with completion support is available.
 *
 * `bootAdapter` is the env completion adapter (MNEMO_LLM_PROVIDER +
 * MNEMO_LLM_MODEL). It answers whenever the workspace has no DB config.
 */
/** buildWorkspaceLlmAdapter's wrappers, keyed by the provider object they wrap. */
const wrappedProviders = new WeakMap<object, LLMAdapter>();

export async function buildWorkspaceLlmAdapter(
  workspaceId: string,
  resolver: LlmConfigResolver,
  bootAdapter: LLMAdapter | undefined
): Promise<LLMAdapter | null> {
  const { provider, source } = await resolver.resolve(workspaceId);

  // P157 (LIFECYCLE-1, CHAOS-6, AGENTSIM-2): the env tier's provider is the
  // boot EMBEDDING provider. Wrapping it ran collapse, conflict checks and
  // capture on that provider's built-in default model (Ollama `llama3.3`,
  // Bedrock Haiku) with the embedding credentials, ignoring MNEMO_LLM_*.
  if (source === "env" && bootAdapter) return bootAdapter;

  // The resolved provider may come from DB config (workspace or global) or
  // the boot env. If it has a complete() method, wrap it as an LLMAdapter.
  const effectiveProvider = provider;

  if (
    effectiveProvider &&
    "complete" in effectiveProvider &&
    typeof (effectiveProvider as { complete?: unknown }).complete === "function"
  ) {
    // One adapter object per resolved provider (the resolver caches the
    // provider for its TTL): callers that key state by adapter object, such as
    // remember()'s classifier pause after a failure, see a stable identity
    // instead of a new wrapper on every request.
    const memo = wrappedProviders.get(effectiveProvider);
    if (memo) return memo;
    const p = effectiveProvider as {
      complete(input: {
        prompt: string;
        system?: string;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        task?: LLMInput["task"];
      }): Promise<{
        text: string;
        tokensIn: number;
        tokensOut: number;
        model: string;
        provider: string;
        finishReason?: string;
      }>;
    };
    const wrapped = {
      generate: async (input: LLMInput): Promise<LLMOutput> => {
        const userContent = input.messages.map((m) => m.content).join("\n\n");
        const result = await p.complete({
          prompt: userContent,
          system: input.system,
          model: input.model,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
          task: input.task,
        });
        return {
          content: result.text,
          tokensUsed: { input: result.tokensIn, output: result.tokensOut },
          model: result.model,
          finishReason: toFinishReason(result.finishReason),
          provider: result.provider,
        };
      },
    } as LLMAdapter;
    wrappedProviders.set(effectiveProvider, wrapped);
    return wrapped;
  }

  // Fall back to the boot-time adapter
  return bootAdapter ?? null;
}
