import type { LLMProviderLike } from "../deps.js";
import type { WorkspaceConfigStore } from "./WorkspaceConfigStore.js";
import type { KeyRingAdapter } from "../encryption/KeyRingAdapter.js";
import { GLOBAL_SENTINEL_ID, LLM_CONFIG_KEYS } from "./WorkspaceConfigStore.js";
import { ollamaNumThread } from "./ollama-threads.js";

/** How long a resolved entry stays cached before a fresh DB lookup. */
const DEFAULT_TTL_MS = 60_000;

/** Which tier answered: the workspace's DB row, the global row, or the boot env. */
export type LlmConfigSource = "workspace" | "global" | "env";

export interface ResolvedLlmConfig {
  provider: LLMProviderLike | null;
  embedModel: string;
  source: LlmConfigSource;
}

/** The slice of the server's pino logger the resolver needs. */
export interface LlmConfigResolverLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

interface CacheEntry extends ResolvedLlmConfig {
  expiresAt: number;
}

/**
 * Resolves the effective LLM provider + embed model for a given workspace using
 * a 3-tier fallback:
 *
 *   1. Workspace-specific DB row in `mnemo_workspace_config`
 *   2. Global sentinel row (workspace_id = all-zeros UUID)
 *   3. Boot-time env-based provider (passed in at construction)
 *
 * `source` says which tier answered. The env tier's provider is the boot
 * EMBEDDING provider, so a caller that needs completions must prefer its own
 * boot completion adapter when `source === "env"` — see
 * `buildWorkspaceLlmAdapter` (P157).
 *
 * Results are cached per-workspaceId with a configurable TTL (default: 60 s).
 * Call `invalidate(workspaceId)` after a PUT/DELETE to flush stale cache entries.
 *
 * Returning `{ provider: null, embedModel }` is valid — it means no embed
 * provider is configured for this workspace and recall will FTS-only degrade.
 */
export class LlmConfigResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  /**
   * Bumped by every invalidate(). A lookup that started before the bump read
   * the config a PUT/DELETE has just replaced, so it must not fill the cache.
   */
  private generation = 0;

  constructor(
    private readonly store: WorkspaceConfigStore,
    private readonly kms: KeyRingAdapter,
    private readonly bootProvider: LLMProviderLike | undefined,
    private readonly bootEmbedModel: string,
    private readonly logger?: LlmConfigResolverLogger
  ) {
    const ttlEnv = process.env["MNEMO_LLM_CONFIG_TTL_SECONDS"];
    this.ttlMs = ttlEnv ? Number(ttlEnv) * 1_000 : DEFAULT_TTL_MS;
  }

  /**
   * Resolve the LLM provider + embed model for the given workspace.
   * Returns a cached result when within TTL; otherwise performs DB lookups.
   */
  async resolve(workspaceId: string): Promise<ResolvedLlmConfig> {
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() < cached.expiresAt) {
      return { provider: cached.provider, embedModel: cached.embedModel, source: cached.source };
    }
    const generation = this.generation;

    // Tier 1: workspace-specific row
    const tier1 = await this._loadFromDb(workspaceId);

    // Tier 2: global sentinel
    const tier2 = tier1 ? null : await this._loadFromDb(GLOBAL_SENTINEL_ID);

    // Tier 3: boot-time env provider (always resolves — provider may be null)
    const resolved: ResolvedLlmConfig = tier1
      ? { ...tier1, source: "workspace" }
      : tier2
        ? { ...tier2, source: "global" }
        : { provider: this.bootProvider ?? null, embedModel: this.bootEmbedModel, source: "env" };

    if (generation === this.generation) {
      this.cache.set(workspaceId, { ...resolved, expiresAt: Date.now() + this.ttlMs });
    }

    return resolved;
  }

  /**
   * Flush cached entries for the given workspace AND the global sentinel.
   * Call after any PUT/DELETE on the workspace or admin config endpoints.
   */
  invalidate(workspaceId: string): void {
    this.generation++;
    this.cache.delete(workspaceId);
    this.cache.delete(GLOBAL_SENTINEL_ID);
  }

  private async _loadFromDb(
    workspaceId: string
  ): Promise<{ provider: LLMProviderLike; embedModel: string } | null> {
    // "read" until the rows are in; "decode" once decrypting and building start.
    let stage: "read" | "decode" = "read";
    try {
      // One snapshot of the whole configuration: read key by key, a lookup
      // racing a rotation could pair the new API key with the old endpoint.
      const rows = await this.store.getMany(workspaceId, LLM_CONFIG_KEYS);
      const row = (key: (typeof LLM_CONFIG_KEYS)[number]): string | null => rows.get(key) ?? null;
      const providerEnc = row("llm_provider");
      const credEnc = row("llm_credentials");
      const embedModelEnc = row("embed_model");
      const llmModelEnc = row("llm_model");
      const temperatureEnc = row("temperature");
      const maxTokensEnc = row("max_tokens");
      const embedDimsEnc = row("embed_dimensions");
      const embedBatchEnc = row("embed_batch_size");
      const baseUrlEnc = row("base_url");
      stage = "decode";

      if (!providerEnc) return null;

      const dec = (enc: string | null): string | undefined =>
        enc ? this.kms.decryptSecret(workspaceId, "llm-config", enc) : undefined;

      const providerName = dec(providerEnc)!;
      const embedModel = dec(embedModelEnc) ?? this.bootEmbedModel;
      const llmModel = dec(llmModelEnc);
      const baseUrl = dec(baseUrlEnc);

      // Numeric optional params
      const temperatureRaw = dec(temperatureEnc);
      const maxTokensRaw = dec(maxTokensEnc);
      const embedDimsRaw = dec(embedDimsEnc);
      const embedBatchRaw = dec(embedBatchEnc);

      const temperature = temperatureRaw !== undefined ? parseFloat(temperatureRaw) : undefined;
      const maxTokens = maxTokensRaw !== undefined ? parseInt(maxTokensRaw, 10) : undefined;
      const embedDimensions = embedDimsRaw !== undefined ? parseInt(embedDimsRaw, 10) : undefined;
      const embedBatchSize = embedBatchRaw !== undefined ? parseInt(embedBatchRaw, 10) : undefined;

      let apiKey: string | undefined;
      const extraOpts: Record<string, unknown> = {};

      if (providerName === "bedrock") {
        const credEnc2 = credEnc;
        if (!credEnc2) {
          // Try apiKey (Bedrock API Key mode)
          const keyEnc = row("llm_api_key");
          if (!keyEnc) return null;
          apiKey = this.kms.decryptSecret(workspaceId, "llm-config", keyEnc);
        } else {
          const creds = JSON.parse(
            this.kms.decryptSecret(workspaceId, "llm-config", credEnc2)
          ) as Record<string, string>;
          Object.assign(extraOpts, creds);
        }
      } else if (providerName !== "ollama") {
        const keyEnc = row("llm_api_key");
        if (!keyEnc) return null;
        apiKey = this.kms.decryptSecret(workspaceId, "llm-config", keyEnc);
      }

      // Pass all configured parameters to createProvider
      if (llmModel) extraOpts.model = llmModel;
      if (baseUrl) extraOpts.baseURL = baseUrl;
      if (temperature !== undefined) extraOpts.temperature = temperature;
      if (maxTokens !== undefined) extraOpts.maxTokens = maxTokens;
      if (embedDimensions !== undefined) extraOpts.embedDimensions = embedDimensions;
      if (embedBatchSize !== undefined) extraOpts.embedBatchSize = embedBatchSize;

      const { createProvider } = await import("@mnemo-ai/llm-providers");
      const provider = createProvider({
        provider: providerName,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(extraOpts as Record<string, string>),
        ...ollamaNumThread(),
      }) as unknown as LLMProviderLike;

      return { provider, embedModel };
    } catch (err) {
      // A failure is not "no config": swallowing it hid LIFECYCLE-2, where every
      // lookup failed under RLS and the env tier answered forever. Still fall
      // back, since a broken row must not take completions down. Past the read,
      // log the error's name only: a JSON SyntaxError quotes its input, which
      // there is a decrypted secret.
      this.logger?.warn(
        {
          workspaceId,
          stage,
          errorName: errorName(err),
          ...(stage === "read" ? { error: errorMessage(err) } : {}),
        },
        "llm_config_resolver.lookup_failed — falling back to the next tier"
      );
      return null;
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
