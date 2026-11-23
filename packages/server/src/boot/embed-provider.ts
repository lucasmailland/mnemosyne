/**
 * resolveEmbedProviderConfig — pure, side-effect-free helper that reads
 * process.env for embed provider split configuration and returns an
 * instruction record. The actual provider construction (network I/O,
 * dynamic imports) happens in the caller (bootFromEnv) to keep this
 * module unit-testable.
 */

import { assertSupportedEmbedDimension } from "@mnemo-ai/types";

export type EmbedProviderResolution =
  /**
   * Use MNEMO_EMBED_PROVIDER + MNEMO_EMBED_API_KEY for a dedicated provider.
   * `apiKey` is undefined only for a provider that takes none (Ollama).
   */
  | { kind: "dedicated"; providerName: string; apiKey: string | undefined; baseURL: string | undefined }
  /** MNEMO_EMBED_PROVIDER set but key absent — fall back to LLM provider */
  | { kind: "fallback_missing_key"; providerName: string }
  /** Neither embed var set — fall back to LLM provider (original behavior) */
  | { kind: "fallback_no_config" }
  /** MNEMO_EMBED_STUB=true without a dedicated embed provider */
  | { kind: "stub" };

/**
 * Whether the named provider needs an API key to be usable. Ollama is a local
 * server that ignores credentials (OLLAMA-KEY): demanding one made operators
 * set a placeholder, or recall without `vector` answered 501.
 */
export function providerRequiresApiKey(providerName: string): boolean {
  return providerName.toLowerCase() !== "ollama";
}

/**
 * Resolves the embed provider configuration from environment variables.
 *
 * Priority chain:
 *  1. MNEMO_EMBED_PROVIDER + MNEMO_EMBED_API_KEY → dedicated embed provider
 *     (the key is optional for a provider that takes none — Ollama)
 *  2. MNEMO_EMBED_PROVIDER set, key absent → warn + fall back to llm
 *  3. No dedicated provider and MNEMO_EMBED_STUB=true → stub
 *  4. Neither set → fall back to llm (original behavior)
 *
 * @param env - environment variable record (defaults to process.env)
 * @param hasLlm - whether a unified LLM provider was successfully created
 */
export function resolveEmbedProviderConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  _hasLlm: boolean
): EmbedProviderResolution {
  const embedProviderName = env["MNEMO_EMBED_PROVIDER"];
  const embedApiKey = env["MNEMO_EMBED_API_KEY"];
  const embedBaseURL = env["MNEMO_EMBED_BASE_URL"];

  if (embedProviderName) {
    if (!embedApiKey && providerRequiresApiKey(embedProviderName)) {
      return { kind: "fallback_missing_key", providerName: embedProviderName };
    }
    return {
      kind: "dedicated",
      providerName: embedProviderName,
      apiKey: embedApiKey,
      baseURL: embedBaseURL,
    };
  }

  // No MNEMO_EMBED_PROVIDER set — check for stub
  if (env["MNEMO_EMBED_STUB"] === "true") {
    return { kind: "stub" };
  }

  return { kind: "fallback_no_config" };
}

/**
 * Returns the effective vector connection string.
 * MNEMO_VECTOR_URL overrides DATABASE_URL for all PgVectorAdapter instances.
 * Migrations ALWAYS use DATABASE_URL — never this value.
 *
 * @param env - environment variable record (defaults to process.env)
 * @param databaseUrl - the resolved DATABASE_URL (already validated as non-empty)
 */
export function resolveVectorUrl(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  databaseUrl: string
): string {
  return env["MNEMO_VECTOR_URL"] ?? databaseUrl;
}

/**
 * Resolves the embedding dimensions for the vector adapter and embed adapter.
 *
 * Priority:
 *  1. MNEMO_EMBED_DIMENSIONS (explicit numeric override)
 *  2. Auto-detection based on provider / model name (e.g. Bedrock Titan/Cohere -> 1024)
 *  3. Default to 1536 (OpenAI / standard)
 *
 * @param env - environment variable record (defaults to process.env)
 */
export function resolveEmbedDimensions(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): number {
  const rawDimensions = env["MNEMO_EMBED_DIMENSIONS"];
  if (rawDimensions) {
    const parsed = parseInt(rawDimensions, 10);
    if (!isNaN(parsed) && parsed > 0) {
      // P117: `> 0` used to be the whole check, and that is how a stack ended up
      // configured at 768 — a width with no vector table and no index behind it.
      // Facts wrote fine and became impossible to soft-delete. Refuse it HERE,
      // at boot, where it is still just a wrong environment variable: the
      // operator gets a message naming the setting and the legal values, instead
      // of a 500 on DELETE /facts/:id weeks later, on data that already exists.
      //
      // Deliberately a throw and not a fallback. Silently rounding 768 up to
      // 1536 would embed with one width and store under another — corruption
      // dressed as resilience.
      assertSupportedEmbedDimension(parsed, "MNEMO_EMBED_DIMENSIONS");
      return parsed;
    }
  }

  const provider = env["MNEMO_EMBED_PROVIDER"] ?? env["MNEMO_LLM_PROVIDER"];
  const model = env["MNEMO_EMBED_MODEL"] ?? "";

  if (
    provider === "bedrock" ||
    model.startsWith("amazon.titan") ||
    model.startsWith("cohere.embed")
  ) {
    return 1024;
  }

  return 1536;
}

/** The embedder boot ended up with: a real one, the hash stub, none, or a provider that cannot embed. */
export type EmbedderState = "ready" | "stub" | "none" | "cannot_embed";

/**
 * D8: the stack runs on whatever provider the operator connects, so a boot with
 * none, or only half of one, is normal. One warning per missing half, saying
 * what stops working and what to set; [] when nothing is missing. The stub
 * embedder logs its own warning.
 */
export function missingProviderWarnings(
  hasCompletion: boolean,
  embedder: EmbedderState,
  embedderName?: string
): string[] {
  const lines: string[] = [];
  if (!hasCompletion) {
    lines.push(
      "llm.no_completion_provider — MNEMO_LLM_PROVIDER is not set (or has no MNEMO_LLM_API_KEY): " +
        "session collapse, conflict checks, rerank and capture extraction are off. " +
        "Set MNEMO_LLM_PROVIDER, MNEMO_LLM_API_KEY and MNEMO_LLM_MODEL (docker/.env.example)."
    );
  }
  if (embedder === "none") {
    lines.push(
      "embed.no_provider — no embedder: recall falls back to full-text and POST /remember " +
        "without `vector` answers 501. Set MNEMO_EMBED_PROVIDER (or a MNEMO_LLM_PROVIDER " +
        "that embeds) with its key and MNEMO_EMBED_MODEL (docker/.env.example)."
    );
  } else if (embedder === "cannot_embed") {
    lines.push(
      `embed.provider_cannot_embed — "${embedderName ?? "unknown"}" has no embeddings: writes ` +
        "are stored without a vector and recall falls back to full-text. Set " +
        "MNEMO_EMBED_PROVIDER, MNEMO_EMBED_API_KEY and MNEMO_EMBED_MODEL (docker/.env.example)."
    );
  }
  return lines;
}
