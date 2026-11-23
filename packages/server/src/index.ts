import { parseTrafficOriginBindings } from "./provenance.js";
import { createServer } from "node:http";
import { createServer as createH2cServer, type Http2Server } from "node:http2";
import { createWorkspaceRegionLookup } from "./middleware/region.js";
import { connectPolicyInvalidation, pollPolicyChanges } from "./middleware/rbac-policy.js";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import type { MnemoBusEvent, AuthContext } from "@mnemo-ai/types";
import { MNEMO_SPAN_NAMES, formatActorRef, sensitiveTextMayReachEmbedder } from "@mnemo-ai/types";
import { pgSessionTimeoutParams, resolvePgSessionTimeouts } from "@mnemo-ai/types";

import { createApp } from "./app.js";
import type { ApiKeyLookup } from "./auth.js";
import { createKeyRingAdapter } from "./encryption/KeyRingAdapter.js";
import { assertEncryptionAvailable } from "./encryption/assertEncryption.js";
import { assertPepperAvailable } from "./encryption/assertPepper.js";
import { unsafeSwitchesInProduction } from "./boot/unsafe-switches.js";
import { pinClientIpHeaders, readGrpcPort } from "./boot/grpc-port.js";
import { createKeyRingWebhookCipher } from "./encryption/webhookSecretCipher.js";
import type { LLMProviderLike, MnemoCore, ServerDeps } from "./deps.js";
import { logger } from "./logging.js";
import { resolveCollapsePolicy } from "@mnemo-ai/core";
import {
  shouldCollapseUnderPolicy,
  createPostgresSweepDiscovery,
  isLastCollapseAttempt,
} from "./session-sweep.js";
import {
  createManagedEffectExecutor,
  createManagedWorkspaceRotation,
  drainManagedCollapseEffects,
  runManagedSessionWorker,
  emitCollapseAttemptAudit,
  type CollapseAttemptOutcome,
} from "./managed-session-worker.js";
import { emitEvent } from "./events.js";
import { dispatchWebhookEvent } from "./webhookDispatch.js";
import { createOtelTelemetry } from "./telemetry/otel.js";
import { ollamaNumThread } from "./config/ollama-threads.js";
import { createDirectPgProbe, createPoolStallWatchdog } from "./resilience/poolStallWatchdog.js";
import {
  recordLlmUsage,
  hotTierEvictions,
  hotTierSize,
  cacheErrorsTotal,
  coRecallEventsTotal,
  coRecallEventsOverCapTotal,
  coRecallPairsProcessedTotal,
  coRecallPairsSkippedTotal,
  workingMemoryOpsTotal,
  workingMemoryFallbackBytes,
  workingMemoryFallbackEvictionsTotal,
  workingMemoryRedisFallbackTotal,
} from "./metrics/index.js";
import { setAnticipationAccuracy, recordCoRecallTail } from "./metrics.js";
import { dumpToPg, rebuildFromPg } from "./resilience/hotTierDump.js";
import type { HotTierPersistence } from "./resilience/hotTierDump.js";
import { createEmbedAdapter } from "./embed-adapter.js";
import { warmModels } from "./boot/warm-models.js";
import { wireConsolidation } from "./boot/consolidation.js";
import { wirePlugins } from "./boot/plugins.js";
import { wireFederation } from "./boot/federation.js";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { emitAudit } from "./audit-emit.js";
import { wireCrons } from "./boot/crons.js";
import { readShutdownGraceMs } from "./boot/shutdown-grace.js";
import { providerRequiresApiKey } from "./boot/embed-provider.js";
import { applyLlmDailyBudget, parseLlmDailyBudget } from "./boot/llm-budget.js";
import { applyLlmTaskRouting, parseLlmTaskRoutes } from "./boot/llm-router.js";
import {
  isLocalProvider,
  localLlmTasks,
  parseSensitiveTextPolicy,
} from "./boot/sensitive-egress.js";

/**
 * Public re-exports — consumers building on top of @mnemo-ai/server
 * (custom dep wiring, embedding in an existing Hono tree, etc.) only
 * need this entrypoint. No deep imports.
 */
export { createApp } from "./app.js";
export {
  createAuthMiddleware,
  verifyApiKeyToken,
  resolveApiKey,
  hashApiKey,
  BCRYPT_COST,
  type ApiKeyLookup,
  type AuthVariables,
} from "./auth.js";
export {
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitedError,
  InternalServerError,
  NotImplementedError,
  toErrorBody,
  type ErrorBody,
} from "./errors.js";
export { type LLMProviderLike, type ServerDeps, type MnemoCore, type Fact } from "./deps.js";
export { logger, createLogger } from "./logging.js";
export {
  assertEncryptionAvailable,
  type EncryptionPosture,
} from "./encryption/assertEncryption.js";
export {
  type IdempotencyStore,
  type BeginResult,
  type IdempotencyOptions,
  createIdempotencyMiddleware,
} from "./idempotency.js";
export {
  type RateLimitBackend,
  type RateLimitOptions,
  type Plan,
  PLAN_LIMITS,
  createRateLimitMiddleware,
} from "./ratelimit.js";
export {
  CURRENT_API_VERSION,
  VERSION_CHANGES,
  type VersionChange,
  createVersioningMiddleware,
} from "./versioning.js";
import { PostgresUserStatusSource, UserStatusService } from "./user-status.js";
export { UnprocessableEntityError, ServiceUnavailableError } from "./errors.js";

// Read from the manifest so GET /openapi.json and /health never drift from the release.
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const DEFAULT_PORT = 3939;

/**
 * Boot the server when this file is run directly (i.e. via the
 * `mnemosyne-server` bin or `node dist/index.js`). Module consumers that
 * import the package don't trigger this branch.
 *
 * The boot path is intentionally last-mile: it expects the consumer to
 * have provided @mnemo-ai/core and @mnemo-ai/llm-providers as peer
 * deps. We resolve them dynamically so the server library itself can
 * still be imported and unit-tested without those packages installed.
 *
 * TODO(llm-providers): replace the dynamic import shape with a real call
 * once @mnemo-ai/llm-providers ships a stable `createProvider({...})`
 * factory. Today we only stub a not-implemented provider when env vars
 * aren't set, so /recall returns 501 with a clear message instead of
 * crashing the process at boot.
 */
async function bootFromEnv(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  // DATABASE_URL is the canonical name shared by the docker stack, .env.example,
  // and the core migrate CLI. MNEMO_DATABASE_URL is kept as a back-compat fallback.
  const databaseUrl = process.env.DATABASE_URL ?? process.env.MNEMO_DATABASE_URL;
  if (!databaseUrl) {
    logger.error("DATABASE_URL is not set. Refusing to start.");
    process.exit(1);
  }

  // Dev-only switches that weaken security are fatal in production (R-24).
  const unsafeSwitches = unsafeSwitchesInProduction(process.env);
  if (unsafeSwitches.length > 0) {
    logger.error(
      { switches: unsafeSwitches },
      `${unsafeSwitches.join(" and ")} must not be true with NODE_ENV=production. Refusing to start.`
    );
    process.exit(1);
  }

  let shutdownGraceMs: number;
  try {
    shutdownGraceMs = readShutdownGraceMs(process.env);
  } catch (err) {
    logger.error({ err }, "Invalid MNEMO_SHUTDOWN_GRACE_MS. Refusing to start.");
    process.exit(1);
  }

  let grpcPort: number | undefined;
  try {
    grpcPort = readGrpcPort(process.env, port);
  } catch (err) {
    logger.error({ err }, "Invalid MNEMO_GRPC_PORT. Refusing to start.");
    process.exit(1);
  }

  // Dashboard session secret: absent = dashboard disabled (fine); present but
  // shorter than 32 bytes = misconfiguration — crash with a clear message
  // instead of minting weakly-signed session cookies.
  try {
    const { readDashboardSecret } = await import("./dashboard-session.js");
    readDashboardSecret();
  } catch (err) {
    logger.error({ err }, "Invalid MNEMO_DASHBOARD_SECRET. Refusing to start.");
    process.exit(1);
  }

  // ---- Core wiring (peer dep) ----
  // We pin the dynamic specifier so bundlers (tsup) keep it external.
  // If the peer isn't installed, fail with a readable message instead of
  // a node MODULE_NOT_FOUND splat.
  //
  // flatten-legacy-dual-core Phase 7: the legacy `CoreLike`/`factory.ts`
  // wiring this block used to build (`core`/`coreMod.createCore()`) is
  // deleted. `apiKeys`/`assertSafeDbRole` come straight from
  // `api-key-lookup.ts` now. `setDb()` is NOT dead weight, even though
  // `deps.core` is gone: `packages/core/src/tx.ts`'s `withMnemoTx` — the
  // canonical RLS transaction boundary (CLAUDE.md "RLS mechanics") — is
  // used directly by THIS file's own concurrent-session probe / session-
  // sweep governance queries below, resolving its DB client through
  // `getDb()`'s registry, the SAME registration `factory.ts`'s
  // `createCore()` used to perform as a side effect. Replicated here
  // verbatim now that `createCore()` itself is gone.
  //
  // flatten-legacy-dual-core Phase 9 (task 9.4, Requirement 8): the "every
  // remaining db/schema-backed v1 module" this comment used to name
  // (entity/episode/citation/review/primitives/etc) was fully deleted by
  // PR20 (Phase 8) — `packages/core/src/db/schema/*` itself is now
  // physically deleted too (18 files; see `@mnemo-ai/core`'s `db/types.ts`
  // header comment for the investigation). `mod.schema` below is `{}`.
  // Every raw-SQL query this file (and `tx.ts`) runs through the
  // registered client is unaffected — none ever used Drizzle's `.query.*`
  // relational API.
  let apiKeys: ApiKeyLookup;
  // Own postgres-js pool backing the `setDb()` registration below — torn
  // down alongside the other DB pools on graceful shutdown.
  let coreDbClientForShutdown: import("postgres").Sql | undefined;
  try {
    const mod = await import("@mnemo-ai/core");
    if (typeof mod.createApiKeyLookup !== "function") {
      throw new Error("@mnemo-ai/core does not export createApiKeyLookup. Upgrade the peer dep.");
    }

    // Reject superuser / bypassrls connections — they silently bypass all RLS
    // policies, making workspace isolation worthless.
    // Set MNEMO_ALLOW_UNSAFE_DB_ROLE=true to suppress (CI / local dev only).
    if (process.env.MNEMO_ALLOW_UNSAFE_DB_ROLE !== "true") {
      if (typeof mod.assertSafeDbRole === "function") {
        await mod.assertSafeDbRole({ databaseUrl });
      }
    } else {
      logger.warn("MNEMO_ALLOW_UNSAFE_DB_ROLE=true — DB role safety check suppressed");
    }

    apiKeys = mod.createApiKeyLookup({ databaseUrl });

    // Register the singleton DB client `withMnemoTx`/`getDb()` need.
    // Own pool, bound to @mnemo-ai/core's own schema — mirrors exactly
    // what the deleted `factory.ts`'s `createCore()` used to do
    // (`drizzlePg(client, { schema })` + `setDb(db)`).
    const { drizzle: drizzlePgForSetDb } = await import("drizzle-orm/postgres-js");
    const { default: postgresForSetDb } = await import("postgres");
    coreDbClientForShutdown = postgresForSetDb(databaseUrl, {
      max: 10,
      connect_timeout: 10,
      // PG-TIMEOUTS: same statement/lock/idle-in-transaction limits as the
      // storage pools (MNEMO_PG_*_TIMEOUT_MS).
      connection: {
        search_path: "mnemosyne,public",
        ...pgSessionTimeoutParams(resolvePgSessionTimeouts(process.env)),
      },
    });
    const coreDb = drizzlePgForSetDb(coreDbClientForShutdown, { schema: mod.schema });
    mod.setDb(coreDb as never);
  } catch (err) {
    logger.error({ err }, "Failed to wire @mnemo-ai/core peer dep");
    process.exit(1);
  }

  // ---- LLM provider wiring (peer dep, optional) ----
  let llm: LLMProviderLike | undefined;
  // F1: LLMAdapter bridge for the factory collapse pipeline. collapseSession needs
  // ctx.llm to run extraction (step 4-5) before it can reach the §30 anticipation
  // accuracy step (step 8b); without it collapse returns status:"llm_unavailable".
  let collapseLlmAdapter: import("@mnemo-ai/types").LLMAdapter | undefined;
  const providerName = process.env.MNEMO_LLM_PROVIDER;
  const apiKey = process.env.MNEMO_LLM_API_KEY;
  // A mistyped cap must not leave the operator believing spend is capped.
  let llmDailyBudgetUSD: number | undefined;
  try {
    llmDailyBudgetUSD = parseLlmDailyBudget(process.env);
  } catch (err) {
    logger.error({ err }, "Invalid MNEMO_LLM_DAILY_BUDGET_USD. Refusing to start.");
    process.exit(1);
  }
  // Per-task completion providers (MNEMO_LLM_<TASK>_*). A route that cannot
  // work is fatal: it must not quietly fall back to the default provider.
  let llmTaskRoutes: import("./boot/llm-router.js").LlmTaskRoutes;
  try {
    llmTaskRoutes = parseLlmTaskRoutes(process.env);
  } catch (err) {
    logger.error({ err }, "Invalid MNEMO_LLM_<TASK>_* routing. Refusing to start.");
    process.exit(1);
  }
  // SECURITY.md §7: which providers may receive confidential+ plaintext. A typo
  // must not leave the operator believing that text stays in.
  let sensitiveTextToProviders: import("@mnemo-ai/types").SensitiveTextPolicy;
  try {
    sensitiveTextToProviders = parseSensitiveTextPolicy(process.env);
  } catch (err) {
    logger.error({ err }, "Invalid MNEMO_SENSITIVE_TEXT_TO_PROVIDERS. Refusing to start.");
    process.exit(1);
  }
  // OLLAMA-KEY: a local Ollama takes no key, so it must not need a placeholder.
  if (providerName && (apiKey || !providerRequiresApiKey(providerName))) {
    try {
      const mod = await import("@mnemo-ai/llm-providers");
      const llmBaseURL = process.env.MNEMO_LLM_BASE_URL;
      const provider = mod.createProvider({
        provider: providerName,
        ...(apiKey ? { apiKey } : {}),
        ...(llmBaseURL ? { baseURL: llmBaseURL } : {}),
        ...ollamaNumThread(),
      });
      llm = provider;
      // MNEMO_LLM_MODEL unset → the provider's own default. A hardcoded
      // OpenAI name here sent `gpt-4o-mini` to Bedrock or Ollama, and since
      // P157 this adapter also answers workspace collapses.
      const completeModel =
        // || not ??: compose passes an empty value when the user sets none.
        process.env.MNEMO_LLM_MODEL || provider.defaultCompleteModel || "gpt-4o-mini";
      // Before the budget, so the cap counts what every task's provider spends.
      // An unknown vendor in a route is fatal, like a route without its key.
      let routed: ReturnType<typeof applyLlmTaskRouting>;
      try {
        routed = applyLlmTaskRouting(mod, provider, llmTaskRoutes, ollamaNumThread());
      } catch (err) {
        logger.error({ err }, "Invalid MNEMO_LLM_<TASK>_PROVIDER. Refusing to start.");
        process.exit(1);
      }
      if (routed.length > 0) logger.info({ routes: routed }, "llm.task_routing_enabled");
      if (llmDailyBudgetUSD !== undefined) {
        applyLlmDailyBudget(mod, provider, llmDailyBudgetUSD, {
          model: completeModel,
          logger,
          routed,
        });
        logger.info({ capUSD: llmDailyBudgetUSD }, "llm.daily_budget_enabled");
      }
      // F1: bridge the genuine CreatedProvider to the LLMAdapter port (no cast) so
      // the factory collapse pipeline can run LLM extraction and reach §30.
      try {
        const adapterLlmMod = await import("@mnemo-ai/adapter-llm");
        collapseLlmAdapter = adapterLlmMod.createLlmAdapter(provider, {
          model: completeModel,
          // The same endpoint the default provider was created with, and the
          // same routes the router was wired from.
          localTasks: localLlmTasks(
            { provider: providerName, ...(llmBaseURL ? { baseURL: llmBaseURL } : {}) },
            llmTaskRoutes
          ),
        });
      } catch (bridgeErr) {
        logger.warn(
          { err: bridgeErr },
          "llm.collapse_adapter_init_failed — collapse will skip LLM extraction (anticipation gauge stays null)"
        );
      }
      logger.info({ provider: providerName }, "llm.provider_ready");
    } catch (err) {
      // Non-fatal: missingProviderWarnings below says what that leaves off.
      logger.warn({ err, provider: providerName }, "llm.provider_init_failed");
    }
  }

  // ---- Embed provider resolution ----
  // Delegates to the testable helper in ./boot/embed-provider.ts which returns
  // a discriminated-union resolution record. This function is the single source
  // of truth for the priority chain — tests for this logic live in
  // src/__tests__/embed-provider-resolution.test.ts.
  const {
    resolveEmbedProviderConfig,
    resolveVectorUrl,
    resolveEmbedDimensions,
    missingProviderWarnings,
  } = await import("./boot/embed-provider.js");
  const embedResolution = resolveEmbedProviderConfig(
    process.env as Record<string, string | undefined>,
    !!llm
  );
  const embedDimensions = resolveEmbedDimensions(process.env as Record<string, string | undefined>);

  let embedProvider: LLMProviderLike | undefined;
  // SECURITY.md §7: whether the embedder runs on the operator's own machine or
  // network. Embeddings that fall back to MNEMO_LLM_PROVIDER go to its default.
  let embedLocal = providerName
    ? isLocalProvider(providerName, process.env.MNEMO_LLM_BASE_URL || undefined)
    : false;

  if (embedResolution.kind === "dedicated") {
    try {
      const embedMod = await import("@mnemo-ai/llm-providers");
      embedProvider = embedMod.createProvider({
        provider: embedResolution.providerName,
        ...(embedResolution.apiKey ? { apiKey: embedResolution.apiKey } : {}),
        ...(embedResolution.baseURL ? { baseURL: embedResolution.baseURL } : {}),
        // P128 follow-up: the provider's own AbortController, which is the only
        // layer that CANCELS the request rather than just giving up on waiting
        // for it. Its default is 60s — twelve times the 5s breaker that wraps
        // recall, so a hung embed could never fail early enough for the FTS
        // fallback to run. Set only on the DEDICATED embed provider: when
        // MNEMO_EMBED_PROVIDER is unset the embedder shares the completion
        // provider, where a long timeout is correct for generation and must not
        // be shortened from here. The adapter-level deadline covers that case.
        timeoutMs: Number(process.env.MNEMO_EMBED_TIMEOUT_MS ?? 3000),
        ...ollamaNumThread(),
      });
      embedLocal = isLocalProvider(embedResolution.providerName, embedResolution.baseURL);
      logger.info({ provider: embedResolution.providerName }, "embed.provider_ready");
    } catch (embedInitErr) {
      logger.warn(
        { err: embedInitErr, provider: embedResolution.providerName },
        "embed.provider_init_failed — falling back to MNEMO_LLM_PROVIDER"
      );
      embedProvider = llm;
    }
  } else if (embedResolution.kind === "fallback_missing_key") {
    logger.warn(
      { provider: embedResolution.providerName },
      "MNEMO_EMBED_PROVIDER set but MNEMO_EMBED_API_KEY missing — falling back to MNEMO_LLM_PROVIDER for embeddings"
    );
    embedProvider = llm;
  } else {
    // kind === "fallback_no_config" or "stub" (stub handled below)
    embedProvider = embedResolution.kind === "fallback_no_config" ? llm : undefined;
  }

  // MNEMO_EMBED_STUB=true: deterministic hash-based stub embed adapter for CI/test
  // environments that have no real LLM or embed provider. Derives 1536-dim float32
  // vectors from SHA-256(text) so remember + recall both work without external API
  // calls. NOT for production — vectors are not semantically meaningful.
  // IMPORTANT: only activates when embedProvider is still undefined after resolution
  // above. If MNEMO_EMBED_PROVIDER is set (even falling back to llm), stub must NOT
  // override the resolved provider.
  // P115: remembered so createEmbedAdapter can mark the port `semantic: false`.
  // Consumers that make irreversible decisions from cosine similarity (the
  // RecMem collapse gate) must be able to tell hash noise from meaning.
  let usingStubEmbeddings = false;

  if (!embedProvider && process.env.MNEMO_EMBED_STUB === "true") {
    usingStubEmbeddings = true;
    embedLocal = true; // in-process hash, no provider at all
    const { createHash } = await import("node:crypto");
    embedProvider = {
      embed: async (text: string, _model: string): Promise<number[]> => {
        const hash = createHash("sha256").update(text).digest();
        // Derive 1536 floats from the 32-byte hash via cyclic expansion.
        // Normalize to unit length so cosine similarity is well-defined.
        const raw: number[] = [];
        for (let i = 0; i < 1536; i++) {
          const b0 = hash[i % 32] ?? 0;
          const b1 = hash[(i + 1) % 32] ?? 0;
          raw.push((b0 ^ (b1 << 1)) / 127.5 - 1.0);
        }
        const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
        return raw.map((v) => v / norm);
      },
    };
    logger.warn(
      "MNEMO_EMBED_STUB=true — hash-based stub embeddings active (CI/test only, NOT for production)"
    );
  }

  // D8: no provider is the default until the operator connects one, so say
  // what is missing instead of failing the boot.
  for (const line of missingProviderWarnings(
    !!collapseLlmAdapter,
    usingStubEmbeddings
      ? "stub"
      : !embedProvider
        ? "none"
        : (embedProvider as { capabilities?: { embed?: boolean } }).capabilities?.embed === false
          ? "cannot_embed"
          : "ready",
    (embedProvider as { name?: string } | undefined)?.name
  )) {
    logger.warn(line);
  }

  // ---- §11 Embedding-noise wrapper (SECURITY.md §10: membership-inference defence) ----
  // MNEMO_EMBEDDING_NOISE=<mode>:<epsilon>  e.g. "laplace:0.5", "gaussian:1.0", "off"
  // Wraps embedProvider.embed in-place so ALL callers (routes + embedAdapter)
  // transparently get noise. Targets embedProvider (not llm) — noise is a
  // vector-storage defence; applying it to completions degrades LLM quality for
  // no security benefit.
  if (embedProvider) {
    const noiseEnv = (process.env.MNEMO_EMBEDDING_NOISE ?? "off").trim();
    if (noiseEnv !== "off") {
      const [rawMode, rawEps] = noiseEnv.split(":");
      const noiseMode = rawMode === "laplace" || rawMode === "gaussian" ? rawMode : null;
      const noiseEpsilon = rawEps ? Math.max(parseFloat(rawEps), 1e-6) : 1.0;
      if (noiseMode) {
        const { addEmbeddingNoise } = await import("@mnemo-ai/core");
        const origEmbed = embedProvider.embed.bind(embedProvider);
        const capturedMode = noiseMode;
        const capturedEps = noiseEpsilon;
        embedProvider.embed = async (text: string, model: string) => {
          const vec = await origEmbed(text, model);
          return addEmbeddingNoise(vec, { mode: capturedMode, epsilon: capturedEps });
        };
        // Wrap embedWithUsage too (when present) so the §11 membership-inference
        // defence applies on the token/cost-metered path as well — otherwise
        // callers preferring embedWithUsage would silently skip noise.
        const origEmbedWithUsage = embedProvider.embedWithUsage?.bind(embedProvider);
        if (origEmbedWithUsage) {
          embedProvider.embedWithUsage = async (text: string, model: string) => {
            const usage = await origEmbedWithUsage(text, model);
            return {
              ...usage,
              vector: addEmbeddingNoise(usage.vector, { mode: capturedMode, epsilon: capturedEps }),
            };
          };
        }
        logger.info({ mode: noiseMode, epsilon: noiseEpsilon }, "embedding_noise.enabled");
      } else {
        logger.warn({ value: noiseEnv }, "MNEMO_EMBEDDING_NOISE: unknown mode — noise disabled");
      }
    }
  }

  // ---- cognitive core wiring ----
  // Dynamically imported so the server boots even if adapter-vector or
  // adapter-llm are not installed. Init failure is fatal — server does not start.
  let cognitive: MnemoCore;
  let storageForDeps: import("@mnemo-ai/types").StorageAdapter | undefined;
  // F12: webhook secret cipher — built inside the v3 try-block when
  // MNEMO_MASTER_KEY is configured. Hoisted here so the deps literal can read it
  // outside the try-block's scope.
  let webhookSecretCipher:
    import("./encryption/webhookSecretCipher.js").WebhookSecretCipher | undefined;
  let hotTierCache: import("@mnemo-ai/types").CacheAdapter | undefined;
  let metricsPgClientRef: import("postgres").Sql | undefined;
  // §19 concurrent-session probe — wired inside the v3 try-block once `db` exists.
  // When the try-block fails, remains undefined → assertRbacLimitsWired degrades
  // gracefully unless NODE_ENV=production or MNEMO_REQUIRE_RBAC_LIMITS=true.
  let activeSessionsRef: ServerDeps["activeSessions"];
  // RDD-5: OutboxAdapter for the graduation cron — assigned inside the v3 try-block
  // where the real Drizzle-backed shim is constructed; remains undefined if the
  // v3 boot block fails (cron will no-op gracefully via the `deps.outbox` optional guard).
  let outboxAdapter: import("@mnemo-ai/types").OutboxAdapter | undefined;
  // P6: dynamic LLM config resolver — hoisted so the deps literal can reference it.
  let llmConfigResolverRef: import("./config/LlmConfigResolver.js").LlmConfigResolver | undefined;
  let workspaceConfigStoreRef:
    import("./config/WorkspaceConfigStore.js").WorkspaceConfigStore | undefined;
  // P29: per-workspace retention config resolver — hoisted so deps literal can reference it.
  let retentionConfigResolverRef:
    import("./config/RetentionConfigResolver.js").RetentionConfigResolver | undefined;
  // MNEMO_VECTOR_URL: separate pgvector connection string for split-DB deployments.
  // Falls back to DATABASE_URL. Hoisted to outer scope so all PgVectorAdapter
  // instantiations (main, collapse, outbox worker) share the same resolved value.
  // Migrations ALWAYS use DATABASE_URL — never this variable.
  // resolveVectorUrl is imported above in the embed-provider resolution block.
  const vectorUrlOuter = resolveVectorUrl(
    process.env as Record<string, string | undefined>,
    databaseUrl
  );
  // Telemetry is always present — a noop shim when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
  // Declared here (outer scope) so deps can reference it regardless of whether
  // the v3 core try-block succeeds.
  const _noopSpanForTelemetry: import("@mnemo-ai/types").Span = {
    setAttribute: () => {},
    setStatus: () => {},
    end: () => {},
  };
  let telemetryRef: import("@mnemo-ai/types").Telemetry = {
    startSpan: () => _noopSpanForTelemetry,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);

  const poolConfig = adapterPgMod.makePoolConfigFromEnv(
    process.env as Record<string, string | undefined>
  );
  const { db, pgClient, replicaDb } = adapterPgMod.createDrizzlePool(poolConfig);
  metricsPgClientRef = pgClient;

  // C1/C9 + F8: build DekUnwrapper + DekProvisioner for PII column encryption.
  // FAIL-CLOSED: in production (NODE_ENV=production) or when
  // MNEMO_REQUIRE_ENCRYPTION=true, a missing/malformed master key is fatal —
  // assertEncryptionAvailable throws and we let it propagate so boot aborts
  // rather than silently storing confidential facts as plaintext. In dev
  // convenience mode it returns "disabled" and we warn-and-degrade as before.
  let dekUnwrapper: ((wsId: string, actorId: string, wrapped: string) => Buffer) | undefined;
  let dekProvisioner:
    ((wsId: string, actorId: string) => { dek: Buffer; wrapped: string }) | undefined;
  const encryptionPosture = assertEncryptionAvailable(
    process.env as Record<string, string | undefined>
  );
  if (encryptionPosture === "enabled") {
    const keyRing = createKeyRingAdapter();
    dekUnwrapper = (wsId, actorId, wrapped) => keyRing.unwrapDek(wsId, actorId, wrapped);
    dekProvisioner = (wsId, actorId) => {
      const dek = keyRing.generateDek();
      const wrapped = keyRing.wrapDek(wsId, actorId, dek);
      return { dek, wrapped };
    };
    webhookSecretCipher = createKeyRingWebhookCipher(keyRing);
    // P6: dynamic LLM config resolver — wired when both keyRing and pgClient are ready.
    try {
      const { PgWorkspaceConfigStore } = await import("./config/WorkspaceConfigStore.js");
      const { LlmConfigResolver } = await import("./config/LlmConfigResolver.js");
      const configStore = new PgWorkspaceConfigStore(pgClient);
      workspaceConfigStoreRef = configStore;
      const embedModelAtBoot = process.env.MNEMO_EMBED_MODEL ?? "text-embedding-3-small";
      // P6: LlmConfigResolver receives embedProvider as bootProvider so the
      // P6 workspace fallback chain operates on the correct embed provider.
      // Completions do NOT come from it: with no DB config,
      // buildWorkspaceLlmAdapter returns collapseLlmAdapter (MNEMO_LLM_*), P157.
      llmConfigResolverRef = new LlmConfigResolver(
        configStore,
        keyRing,
        embedProvider,
        embedModelAtBoot,
        logger
      );
      logger.info("llm_config_resolver.ready");
      const { completionFallsBackToEmbedProvider } =
        await import("./config/WorkspaceLlmAdapter.js");
      if (completionFallsBackToEmbedProvider(collapseLlmAdapter, embedProvider)) {
        logger.warn(
          { provider: (embedProvider as { name?: string } | undefined)?.name },
          "llm.completion_uses_embed_provider — no completion adapter from MNEMO_LLM_PROVIDER/MNEMO_LLM_MODEL, so collapse, conflict checks and capture run on the embedding provider's default completion model and credentials. Set MNEMO_LLM_PROVIDER and MNEMO_LLM_MODEL."
        );
      }
    } catch (p6Err) {
      logger.warn({ err: p6Err }, "llm_config_resolver.init_failed — dynamic LLM config disabled");
    }
    // P29: retention config resolver — instantiated when configStore + keyRing are ready.
    if (workspaceConfigStoreRef) {
      try {
        const { RetentionConfigResolver } = await import("./config/RetentionConfigResolver.js");
        const { parseRetentionConfig } = await import("./cron/retention-purge.js");
        const retentionEnvDefaults = parseRetentionConfig(process.env);
        retentionConfigResolverRef = new RetentionConfigResolver(
          workspaceConfigStoreRef,
          keyRing,
          retentionEnvDefaults
        );
        logger.info("retention_config_resolver.ready");
      } catch (p29Err) {
        logger.warn(
          { err: p29Err },
          "retention_config_resolver.init_failed — per-workspace retention config disabled"
        );
      }
    }
  } else {
    logger.warn(
      "MNEMO_MASTER_KEY not set — PII column encryption disabled (confidential/restricted facts stored as plaintext). Set NODE_ENV=production or MNEMO_REQUIRE_ENCRYPTION=true to enforce."
    );
  }

  // H3: FAIL-CLOSED pepper gate — MNEMO_KEY_PEPPER blinds API tokens before
  // DB storage. An empty or short pepper means a compromised DB exposes raw
  // tokens. Fatal in production; warn-and-degrade in dev.
  const pepperPosture = assertPepperAvailable(process.env as Record<string, string | undefined>);
  if (pepperPosture === "weak") {
    logger.warn(
      "MNEMO_KEY_PEPPER is unset or < 32 chars — API token blinding is weak. " +
        "Set NODE_ENV=production or MNEMO_REQUIRE_PEPPER=true to enforce a strong pepper."
    );
  }

  const storage = new adapterPgMod.DrizzleStorageAdapter(
    db,
    pgClient,
    dekUnwrapper,
    dekProvisioner,
    replicaDb ?? undefined
  );
  storageForDeps = storage;

  // §19 concurrent-session probe: count active sessions for a specific
  // workspace+actor pair. Used by assertRbacLimitsWired and the RBAC
  // middleware to enforce maxSessionsConcurrent limits.
  // Uses withMnemoTx so FORCE RLS isolates the count to the caller's
  // workspace (RLS invariant — never query mnemo_* workspace-scoped
  // tables without activating the workspace GUC).
  activeSessionsRef = {
    async countActive(workspaceId: string, actorId: string): Promise<number> {
      const { withMnemoTx } = await import("@mnemo-ai/core");
      const { sql: drizzleSql } = await import("drizzle-orm");
      return withMnemoTx(workspaceId, async (tx) => {
        const rows = await tx.execute(drizzleSql`
            SELECT COUNT(*)::int AS count
            FROM mnemosyne.mnemo_session
            WHERE workspace_id = ${workspaceId}
              AND agent_id   = ${actorId}
              AND status     = 'active'
          `);
        return (rows as unknown as Array<{ count: number }>)[0]?.count ?? 0;
      });
    },
  };

  // EmbedAdapter shim: wraps embedProvider (LLMProviderLike: embed(text, model): number[])
  // into the EmbedAdapter port (embed(texts: string[]): Float32Array[]).
  // Uses embedProvider (not llm) so a dedicated embed-only provider (e.g. Voyage, NVIDIA)
  // is used for all vector storage. When no embed provider is configured we install a
  // stub that throws NO_EMBED_ADAPTER so the recall route can 501 with an actionable
  // message instead of crashing.
  // ADP-5: forwards embedWithUsage's real token/cost accounting to recordLlmUsage,
  // the same metrics the completion side (onLlmUsage hook below) already gets.
  const embedModel = process.env.MNEMO_EMBED_MODEL ?? "text-embedding-3-small";
  const embedAdapter = createEmbedAdapter(
    embedProvider,
    embedModel,
    embedDimensions,
    (usage) => {
      recordLlmUsage({
        provider: usage.provider,
        model: usage.model,
        kind: "embedding",
        tokens: usage.tokens,
        operation: "embed",
        ...(usage.costUSD !== undefined ? { costUSD: usage.costUSD } : {}),
      });
    },
    // P115: propagate "these vectors are hash noise" into the type system.
    // `usingStubEmbeddings` is set where the stub is built above; only this boot
    // path knows the difference, and until now nothing downstream could.
    !usingStubEmbeddings
  );
  // OutboxAdapter shim: DrizzleStorageAdapter implements StorageAdapter which
  // has appendOutbox/claimOutbox/markOutboxProcessed/markOutboxFailed — we map
  // those to the OutboxAdapter port names the v3 context expects.
  outboxAdapter = {
    async append(entry) {
      return storage.appendOutbox(entry);
    },
    async claimBatch(limit) {
      return storage.claimOutbox(limit);
    },
    async markProcessed(ids) {
      return storage.markOutboxProcessed(ids);
    },
    async markFailed(id, error) {
      return storage.markOutboxFailed(id, error);
    },
    async getStats() {
      // Minimal: derive stats from claimBatch peek (best-effort — no blocking query)
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };

  // No-op Logger that forwards to the server's pino logger
  const v3Logger: import("@mnemo-ai/types").Logger = {
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
    info: (msg, ctx) => logger.info(ctx ?? {}, msg),
    warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => logger.error(ctx ?? {}, msg),
    fatal: (msg, ctx) => logger.fatal(ctx ?? {}, msg),
    child: (bindings) => {
      const child = logger.child(bindings);
      return {
        debug: (msg, ctx) => child.debug(ctx ?? {}, msg),
        info: (msg, ctx) => child.info(ctx ?? {}, msg),
        warn: (msg, ctx) => child.warn(ctx ?? {}, msg),
        error: (msg, ctx) => child.error(ctx ?? {}, msg),
        fatal: (msg, ctx) => child.fatal(ctx ?? {}, msg),
        child: (b) => v3Logger.child({ ...bindings, ...b }),
      };
    },
  };

  // Telemetry: real OTel adapter when OTEL_EXPORTER_OTLP_ENDPOINT is set,
  // otherwise a no-op shim so the server boots without a collector.
  const NOOP_SPAN: import("@mnemo-ai/types").Span = {
    setAttribute: () => {},
    setStatus: () => {},
    end: () => {},
  };
  const NOOP_TELEMETRY: import("@mnemo-ai/types").Telemetry = {
    startSpan: () => NOOP_SPAN,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const v3Telemetry: import("@mnemo-ai/types").Telemetry =
    (await createOtelTelemetry({ serviceName: "mnemosyne-server", serviceVersion: VERSION })) ??
    NOOP_TELEMETRY;
  telemetryRef = v3Telemetry;

  // Optional Redis hot-tier cache. Gated on MNEMO_REDIS_URL so the server
  // boots without Redis; when absent, recall uses the cold 7-stage cascade.
  const redisUrl = process.env.MNEMO_REDIS_URL;
  if (redisUrl) {
    try {
      const adapterRedisMod = await import("@mnemo-ai/adapter-redis");
      hotTierCache = new adapterRedisMod.RedisCacheAdapter({ url: redisUrl }, logger);
      logger.info("cognitive.hot_tier=redis");
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, "cognitive.hot_tier=disabled — adapter-redis unavailable");
    }
  } else {
    logger.info("cognitive.hot_tier=disabled — set MNEMO_REDIS_URL to enable");
  }
  // §19 RBAC: a policy write drops the cached policy on every replica through
  // Redis pub/sub at once; the Postgres change log (pollPolicyChanges, below)
  // does it within a second without Redis or when a message is lost.
  const policyBus = hotTierCache;
  if (policyBus?.publish && policyBus.subscribe) {
    connectPolicyInvalidation({
      publish: (channel, message) => policyBus.publish!(channel, message),
      subscribe: (channel, handler) => policyBus.subscribe!(channel, handler),
    }).catch((err) => {
      logger.warn({ err }, "rbac.policy_invalidation=disabled — other replicas wait for the TTL");
    });
  }

  // F1: a single PgVectorAdapter instance shared by the v3 recall core AND the
  // factory collapse pipeline (collapseSession's ctx.vector).
  // Uses vectorUrlOuter (= MNEMO_VECTOR_URL ?? DATABASE_URL) so all PgVectorAdapter
  // instances route to the same vector endpoint.
  //
  // mnemo_fact.embedding is an unconstrained halfvec column as of migration
  // 0009 (dropped the fixed-dimension HNSW indexes first, then unconstrained
  // the type — see that migration's header for the "column does not have
  // dimensions" pitfall it works around). Migration 0010 restores indexed
  // cosine search as dimension-scoped partial HNSW indexes (currently 1536
  // and 1024), so a single PgVectorAdapter instance configured with the
  // active provider's `dimensions` handles every provider directly against
  // this one column — no separate per-dimension storage needed.
  const pgVectorAdapter = new adapterVectorMod.PgVectorAdapter({
    connectionString: vectorUrlOuter,
    dimensions: embedDimensions,
  });
  cognitive = v3CoreMod.createCore(
    {
      storage,
      vector: pgVectorAdapter,
      // SECURITY.md §7: core reads `local` to decide where confidential+ text may go.
      embed: { ...embedAdapter, local: embedLocal },
      outbox: outboxAdapter,
      cache: hotTierCache,
      logger: v3Logger,
      telemetry: v3Telemetry,
      // P6: wire boot-time LLM adapter into v3 core so maybeRerank (recall-cold.ts)
      // activates when query.rerank=true. Without this ctx.llm is undefined and
      // reranking is silently skipped on every cold-recall call.
      // Per-call workspace LLM override is documented as a TODO in recall.ts —
      // MnemoCore.recall() does not currently accept a per-call LLM argument.
      ...(collapseLlmAdapter ? { llm: collapseLlmAdapter } : {}),
      // Completion-path token/cost metrics (OPS-02). Core calls this hook
      // after each metered LLM call; we forward to the same Prometheus
      // counters the embed path uses (mnemo_llm_tokens_total{provider,model,kind}
      // / mnemo_llm_cost_microdollars_total{provider,model}). Plain injected
      // function — core never imports the metrics layer (hexagonal). The hook
      // emits prompt/completion sides; the LLMAdapter port now surfaces the
      // vendor's costUSD on the completion side, so recordLlmUsage records real
      // cost when the model is priced (zero only when costUSD is undefined).
      onLlmUsage: (usage) => {
        recordLlmUsage({
          provider: usage.provider,
          model: usage.model,
          kind: usage.kind,
          tokens: usage.tokens,
          ...(usage.costUSD !== undefined ? { costUSD: usage.costUSD } : {}),
        });
      },
      // F19: hot-tier eviction → Prometheus. Core's telemetry.counter is a
      // no-op stub on the server, so this hook is the live path for
      // mnemo_hot_tier_evictions_total + mnemo_hot_tier_size. Hexagonal:
      // plain injected function, core never imports the metrics layer.
      onHotTierEvict: (report) => {
        hotTierEvictions.inc({}, report.evicted);
        hotTierSize.set({ workspace: report.workspaceId }, report.size);
      },
      // P59: L3/embedding cache-port failures → Prometheus. Core's
      // telemetry.counter is a no-op stub on the server, so this hook is the
      // live path for mnemo_cache_errors_total{cache,op}. Hexagonal: plain
      // injected function, core never imports the metrics layer.
      onCacheError: (report) => {
        cacheErrorsTotal.inc({ cache: report.cache, op: report.op });
      },
      // p60-corecall-stdp-convergence PR2: co-recall tail measurement →
      // Prometheus (4 counters) + the JSON /metrics snapshot accumulator.
      // Core's telemetry.counter is a no-op stub on the server, so this hook
      // is the live path. Hexagonal: plain injected function, core never
      // imports the metrics layer.
      onCoRecallTail: (report) => {
        coRecallEventsTotal.inc({});
        if (report.candidateFacts > report.capK) coRecallEventsOverCapTotal.inc({});
        coRecallPairsProcessedTotal.inc({}, report.processedPairs);
        coRecallPairsSkippedTotal.inc({}, report.skippedPairs);
        recordCoRecallTail(report);
      },
    },
    {
      surpriseThreshold: Number(process.env.MNEMO_SURPRISE_THRESHOLD ?? 0.15),
      hotTierTtlSeconds: Number(process.env.MNEMO_HOT_TIER_TTL ?? 86400),
      embeddingNoise: {
        mode: (process.env.MNEMO_EMBEDDING_NOISE as "off" | "laplace" | "gaussian") ?? "off",
        epsilon: Number(process.env.MNEMO_EMBEDDING_NOISE_EPSILON ?? "1"),
      },
      // auto-trigger-scoped-consolidation: global kill switch for the write-time
      // scoped semantic conflict check outbox append. Default-on — only an
      // explicit "false" disables it.
      scopedConflictCheckEnabled: process.env.MNEMO_SCOPED_CONFLICT_CHECK_ENABLED !== "false",
      // WP-7: LLM classification of every fact write against its closest
      // facts (up to 3 calls per write). Opt-in — only an explicit "true".
      writeConflictClassification: process.env.MNEMO_WRITE_CONFLICT_CLASSIFICATION === "true",
      sensitiveTextToProviders,
    }
  );

  logger.info("cognitive.core_ready");

  // flatten-legacy-dual-core Phase 7: the deferred legacy factory-core build
  // that used to live here (`coreMod.createCore({databaseUrl, collapse: {...}})`,
  // assigned to `core`/`deps.core`) is deleted. `cognitive` (built above via
  // `v3CoreMod.createCore()`) already exposes `collapseSession` (PR16) over the
  // SAME `storage`/`pgVectorAdapter`/`embedAdapter`/`hotTierCache` instances the
  // legacy factory's `buildCollapseContext` used to re-wrap — no capability lost.

  // §37 Hot-tier rebuild — reload Redis ZSet from PG snapshot on boot.
  // Must run after hotTierCache and storageForDeps are both set, before
  // serving traffic. Best-effort: errors are logged, never thrown.
  if (hotTierCache && storageForDeps) {
    rebuildFromPg(hotTierCache, storageForDeps as unknown as HotTierPersistence).catch((err) =>
      logger.warn({ err }, "hot_tier_rebuild.boot_failed")
    );
  }

  // §4 Bus singleton — must be created before deps so bus: busRef is valid.
  const { createEventBus } = await import("@mnemo-ai/core");
  const busRef = createEventBus();

  // §35 WS replay buffer — records every emitted event so reconnecting clients
  // can catch up. Requires Redis list ops (lpushCapped / lrange). When hotTierCache
  // is absent or lacks list ops, createReplayBuffer falls back to a no-op.
  let replayBuffer: import("./resilience/replayBuffer.js").ReplayBuffer | undefined;
  try {
    const { createReplayBuffer } = await import("./resilience/replayBuffer.js");
    replayBuffer = createReplayBuffer(
      hotTierCache ??
        ({
          // Stub CacheAdapter when Redis is absent — all ops are no-ops.
          id: "no-op-cache",
          capabilities: {
            sortedSets: false,
            pubSub: false,
            patterns: false,
            atomic: false,
            hashes: false,
          },
          async get() {
            return null;
          },
          async set() {},
          async delete() {},
          async deletePattern() {
            return 0;
          },
          async healthCheck() {
            return { status: "ok" as const, latencyMs: 0 };
          },
          async close() {},
        } as import("@mnemo-ai/types").CacheAdapter),
      { maxEvents: 200, ttlSeconds: 3600 }
    );
    if (hotTierCache?.lpushCapped) {
      logger.info("ws_replay.enabled");
    } else {
      logger.info("ws_replay.degraded — no Redis, replay buffer is a no-op");
    }
  } catch (replayErr) {
    logger.warn({ err: replayErr }, "ws_replay.init_failed — replay disabled");
  }

  // §34.8 Job-shedding gate is instantiated below, where the QueueAdapter and
  // the outbox worker's PG client are both in scope (createSheddingQueue wrap).

  // Rate limiting: Redis-backed when MNEMO_REDIS_URL is set (C3 fix).
  const redisUrlForRL = process.env.MNEMO_REDIS_URL;
  let rateLimitBackend: import("./ratelimit.js").RateLimitBackend | undefined;
  if (redisUrlForRL) {
    try {
      const { RedisRateLimitBackend } = await import("./ratelimitRedis.js");
      rateLimitBackend = new RedisRateLimitBackend(redisUrlForRL);
      logger.info("rate_limit.redis_backend_ready");
    } catch (rlErr) {
      logger.warn({ err: rlErr }, "rate_limit.redis_backend_failed — rate limiting disabled");
    }
  } else {
    logger.info("rate_limit.disabled — set MNEMO_REDIS_URL to enable");
  }

  // Idempotency (spec §RDD9): multi-phase recovery-point store. Selection:
  //   MNEMO_IDEMPOTENCY_STORE=postgres + DB → DrizzleIdempotencyStore (durable
  //     recovery_point in PG); else MNEMO_REDIS_URL → RedisIdempotencyStore
  //     (multi-replica shared recovery_point); else InMemory (dev/test only).
  let idempotencyStore: import("./idempotency.js").IdempotencyStore;
  const redisUrlForIdp = process.env.MNEMO_REDIS_URL;
  const { selectIdempotencyStoreKind, InMemoryIdempotencyStore } =
    await import("./idempotencyMemory.js");
  const idpKind = selectIdempotencyStoreKind({
    idempotencyStoreEnv: process.env.MNEMO_IDEMPOTENCY_STORE,
    redisUrl: redisUrlForIdp,
    databaseUrl,
  });
  if (idpKind === "postgres") {
    try {
      const { createDrizzleClient, DrizzleIdempotencyStore } =
        await import("@mnemo-ai/adapter-postgres");
      const { db: idpDb } = createDrizzleClient(databaseUrl);
      idempotencyStore = new DrizzleIdempotencyStore(idpDb);
      logger.info("idempotency.postgres_store_ready");
    } catch (idpErr) {
      logger.warn(
        { err: idpErr },
        "idempotency.postgres_store_failed — falling back to in-memory (multi-replica unsafe)"
      );
      idempotencyStore = new InMemoryIdempotencyStore();
    }
  } else if (idpKind === "redis") {
    try {
      const { RedisIdempotencyStore } = await import("./RedisIdempotencyStore.js");
      idempotencyStore = new RedisIdempotencyStore(redisUrlForIdp!);
      logger.info("idempotency.redis_store_ready");
    } catch (idpErr) {
      logger.warn(
        { err: idpErr },
        "idempotency.redis_store_failed — falling back to in-memory (multi-replica unsafe)"
      );
      idempotencyStore = new InMemoryIdempotencyStore();
    }
  } else {
    logger.warn(
      "idempotency.in_memory — set MNEMO_REDIS_URL or MNEMO_IDEMPOTENCY_STORE=postgres for multi-replica safe idempotency"
    );
    idempotencyStore = new InMemoryIdempotencyStore();
  }

  const { createCircuitBreakers } = await import("./resilience/circuitBreakers.js");

  // §19 RBAC stores — per-agent access policies + approval requests.
  // Built on their own drizzle client so they survive even if v3 core init
  // failed above. Both are optional: absent → RBAC middleware not mounted.
  let accessPolicies: import("@mnemo-ai/types").AccessPolicyStore | undefined;
  let approvals: import("@mnemo-ai/types").ApprovalStore | undefined;
  let breakGlass: import("@mnemo-ai/types").BreakGlassStore | undefined;
  let purgePolicyChanges: (() => Promise<number>) | undefined;
  try {
    const adapterPgMod = await import("@mnemo-ai/adapter-postgres");
    const { db: rbacDb } = adapterPgMod.createDrizzleClient(databaseUrl);
    const pgPolicies = new adapterPgMod.DrizzleAccessPolicyStore(rbacDb);
    accessPolicies = pgPolicies;
    // A policy write on another replica drops the cached policy here within a
    // second, with or without Redis (migration 0067; see pollPolicyChanges).
    pollPolicyChanges((afterSeq) => pgPolicies.changesSince(afterSeq));
    purgePolicyChanges = () => pgPolicies.purgeChanges();
    approvals = new adapterPgMod.DrizzleApprovalStore(rbacDb);
    breakGlass = new adapterPgMod.DrizzleBreakGlassStore(rbacDb);
    logger.info("rbac.stores_ready");
  } catch (rbacErr) {
    logger.warn({ err: rbacErr }, "rbac.stores_unavailable — RBAC middleware will not be mounted");
  }

  // §29 L0 Working Memory — one instance per server process, backed by the
  // Redis cache adapter when available. Falls back to an in-process LRU map
  // when cache is absent (WorkingMemory handles the fallback internally).
  let workingMemory: import("@mnemo-ai/core").WorkingMemory | undefined;
  {
    const { WorkingMemory } = await import("@mnemo-ai/core");
    type WMMetrics = import("@mnemo-ai/core").WorkingMemoryMetrics;
    const wmMetrics: WMMetrics = {
      incOp: (backend: "redis" | "fallback", op: string, result: "hit" | "miss" | "ok" | "error") =>
        workingMemoryOpsTotal.inc({ backend, op, result }),
      setFallbackBytes: (bytes: number) => workingMemoryFallbackBytes.set({}, bytes),
      incEviction: () => workingMemoryFallbackEvictionsTotal.inc({}),
      incRedisFallback: (op: string) => workingMemoryRedisFallbackTotal.inc({ op }),
    };
    workingMemory = new WorkingMemory(hotTierCache ?? null, logger, wmMetrics);
    logger.info("working_memory.ready");
  }

  // §7/§9 L1 — write-through session buffer over durable PG sessions.
  // Built whenever storage exists; cache may be null (PG-only degradation).
  let sessionBuffer: import("@mnemo-ai/core").SessionBuffer | undefined;
  if (storageForDeps) {
    const { SessionBuffer } = await import("@mnemo-ai/core");
    // flatten-legacy-dual-core Phase 7: `storageForDeps` (a `StorageAdapter`)
    // satisfies `SessionScratchStore` directly — `replaceSessionScratch` was
    // already a v3 port method (PR10); `getSessionScratch` is the read-side
    // twin added this Phase (`@mnemo-ai/types` ports.ts), replacing the
    // legacy `CoreLike.{replaceSessionScratch,getSessionScratch}` pair.
    sessionBuffer = new SessionBuffer(
      hotTierCache ?? null,
      storageForDeps,
      storageForDeps,
      v3Logger
    );
    logger.info("session_buffer.ready");
  }

  // §6 dark-launch (spec §35 line 4011): optionally enable the scoped-key (mk_*)
  // auth scheme ALONGSIDE the live mns_* scheme. Off by default — ops set
  // MNEMO_SCOPED_AUTH=1 only after scoped keys have been issued. When enabled,
  // mns_* keys keep working unchanged; mk_* keys verify via ScopedApiKeyAdapter.
  // The store is wired with or without the flag: POST /admin/scoped-keys
  // issues into it, so keys exist before verification is switched on.
  let scopedAuthAdapter: import("@mnemo-ai/types").AuthAdapter | undefined;
  let scopedKeyStore: import("@mnemo-ai/types").ApiKeyStore | undefined;
  try {
    const { createDrizzleClient, DrizzleApiKeyStore } = await import("@mnemo-ai/adapter-postgres");
    scopedKeyStore = new DrizzleApiKeyStore(createDrizzleClient(databaseUrl).db);
    if (process.env.MNEMO_SCOPED_AUTH === "1") {
      const { ScopedApiKeyAdapter } = await import("./auth/ScopedApiKeyAdapter.js");
      scopedAuthAdapter = new ScopedApiKeyAdapter({
        store: scopedKeyStore,
        anomalyDetection: process.env.MNEMO_SCOPED_AUTH_ANOMALY === "1",
      });
      logger.info("auth.scoped_scheme_enabled");
    }
  } catch (err) {
    logger.error({ err }, "auth.scoped_scheme_init_failed — continuing with mns_* only");
  }

  // PG-TIMEOUTS / CHAOS-1: liveness learns about a wedged pool from this
  // watchdog — pool can't `SELECT 1` while a fresh connection can, for
  // MNEMO_LIVENESS_POOL_STALL_MS (default 60 s, 0 disables). A database
  // outage never trips it.
  const poolStallWatchdog = storageForDeps
    ? createPoolStallWatchdog({
        probePool: async () => {
          const h = await storageForDeps!.healthCheck();
          if (h.status !== "ok") throw new Error(h.status);
        },
        probeDirect: createDirectPgProbe(databaseUrl!),
        probeTimeoutMs: 5_000,
        stallAfterMs: Number(process.env.MNEMO_LIVENESS_POOL_STALL_MS ?? 60_000) || 0,
      })
    : undefined;
  poolStallWatchdog?.start();

  const deps: ServerDeps = {
    trafficOrigins: parseTrafficOriginBindings(process.env.MNEMO_TRAFFIC_ORIGINS),
    apiKeys,
    scopedAuthAdapter,
    scopedKeyStore,
    llm,
    sensitiveTextToProviders,
    embedModel: process.env.MNEMO_EMBED_MODEL ?? "text-embedding-3-small",
    cognitive,
    storage: storageForDeps,
    bus: busRef,
    replay: replayBuffer,
    cache: hotTierCache,
    rateLimitBackend,
    idempotencyStore,
    circuitBreakers: createCircuitBreakers(),
    accessPolicies,
    approvals,
    breakGlass,
    workingMemory,
    sessionBuffer,
    webhookSecretCipher,
    activeSessions: activeSessionsRef,
    metricsPgClient: metricsPgClientRef,
    userStatus: metricsPgClientRef
      ? new UserStatusService(new PostgresUserStatusSource(metricsPgClientRef))
      : undefined,
    telemetry: telemetryRef,
    // P127 — the health route's per-dependency probes. This was never wired,
    // and because `routes/health.ts` defaulted an absent adapter to
    // `{ status: "ok" }`, `/health/ready` reported `vector: ok` and
    // `cache: ok` in every deployment without having contacted either. Two of
    // three checks were constants; `degraded` is derived from them, so it could
    // never be true and its alerting branch was unreachable.
    //
    // Only `storage` looked healthy for a real reason: its branch falls back to
    // `pingStorage(deps)` rather than to a literal, which is why stopping
    // Postgres was the only outage this endpoint ever noticed.
    //
    // `embed` is included because it is the dependency whose loss is total —
    // with the provider unreachable, `POST /remember` and `POST /recall` both
    // 500 while the probe answered `ready`. Each entry is conditional: an
    // adapter that genuinely is not configured must report `unknown`, which is
    // an honest "nobody looked", not the `ok` that used to be implied.
    healthAdapters: {
      ...(storageForDeps ? { storage: storageForDeps } : {}),
      ...(pgVectorAdapter ? { vector: pgVectorAdapter } : {}),
      ...(hotTierCache ? { cache: hotTierCache } : {}),
      ...(embedAdapter ? { embed: embedAdapter } : {}),
      ...(poolStallWatchdog ? { poolStall: poolStallWatchdog } : {}),
    },
    ...(collapseLlmAdapter ? { llmAdapter: collapseLlmAdapter } : {}),
    ...(llmConfigResolverRef ? { llmConfigResolver: llmConfigResolverRef } : {}),
    ...(workspaceConfigStoreRef ? { workspaceConfigStore: workspaceConfigStoreRef } : {}),
    ...(retentionConfigResolverRef ? { retentionConfigResolver: retentionConfigResolverRef } : {}),
  };

  // ---- OutboxWorker (C5 fix) — drain the transactional outbox ----
  // Must start AFTER deps so it can use the same storage/vector/cache adapters.
  // jobQueue is hoisted out of the try block below so wireConsolidation (registration
  // of the scoped-conflict-check handler) can run — and register against the SAME
  // queue instance — strictly before outboxWorker.start(). Without this, jobs drained
  // in the window between start() and registration are marked processed and lost
  // forever (auto-trigger-scoped-consolidation design §D6 / open question, resolved).
  let jobQueue: import("@mnemo-ai/types").QueueAdapter | undefined;
  // schedStop is likewise hoisted: wireConsolidation is now called from inside the
  // try block below (before outboxWorker.start()), but its stop() handle is still
  // read much later by the graceful-shutdown handler at function scope.
  let schedStop: (() => void) | undefined;
  let outboxWorker: import("@mnemo-ai/adapter-postgres").OutboxWorker | undefined;
  // Shared cluster-wide pool utilisation — updated every 2 s by readPgStatActivityUtil
  // so both the outbox shedding queue and the cron shedGate see the same pressure signal.
  let lastUtil = 0;
  let utilTimer: ReturnType<typeof setInterval> | undefined;
  // The same reading drives the HTTP fleet shedder (ratelimit.ts): all replicas
  // share the database, so its busy-connection share is the fleet's load.
  deps.fleetUtil = () => lastUtil;
  if (storageForDeps) {
    try {
      const [adapterPgMod, adapterVectorMod] = await Promise.all([
        import("@mnemo-ai/adapter-postgres"),
        import("@mnemo-ai/adapter-vector"),
      ]);
      const { InMemoryQueueAdapter } = await import("./queueMemory.js");
      const baseQueue = new InMemoryQueueAdapter();
      const { db: owDb, pgClient: owPgClient } = adapterPgMod.createDrizzleClient(databaseUrl);
      // §34.8 Job-shedding gate (deep re-audit P0-5) — shed low-priority
      // background jobs when the PG pool saturates so critical work keeps
      // flowing. poolUtil now uses pg_stat_activity for cluster-wide visibility
      // (previously it was blind to connections from other replicas). A 2 s
      // cached timer avoids hammering the DB on every shedding check.
      const { createSheddingQueue } = await import("./resilience/sheddingQueue.js");
      const { readPgPoolStats, readPgStatActivityUtil } = await import("./metrics/pgPool.js");
      // Cache pg_stat_activity util; refreshed every 2 s for cluster-wide visibility.
      utilTimer = setInterval(async () => {
        lastUtil = await readPgStatActivityUtil(owPgClient);
        // Fallback: if pg_stat_activity returned 0 but local pool has pressure, use local.
        if (lastUtil === 0) {
          const { active, total } = readPgPoolStats(owPgClient);
          if (total > 0) lastUtil = active / total;
        }
      }, 2_000);
      (utilTimer as { unref?: () => void }).unref?.();
      const queue = createSheddingQueue(baseQueue, {
        poolUtil: () => lastUtil,
      });
      jobQueue = queue;

      // ---- Consolidation scheduler (optional peer dep) ----
      // invariant: completion provider — never embedProvider.
      // Voyage/embed-only providers have no complete(); passing them would silently
      // break session collapse LLM extraction (see design §wireConsolidation invariant).
      //
      // MUST run (and register the scoped-conflict-check handler against `queue`)
      // strictly before `outboxWorker.start()` below — see the `jobQueue` comment
      // above. This also fixes the same pre-existing loss window for the two other
      // orphaned queue_job producer `anomaly_review`, which shared the same
      // at-risk window. (`staging_evaluation` was removed outright in P74 — it
      // discarded writes into a path that had no consumer and no storage.)
      const schedStopObj = await wireConsolidation({
        databaseUrl,
        storageForDeps,
        llm,
        v3: cognitive,
        deps,
        queue: jobQueue,
        sensitiveTextToProviders,
        ...(dekUnwrapper ? { dekUnwrapper } : {}),
      });
      schedStop = schedStopObj?.stop.bind(schedStopObj);

      // P111 — `mnemo.hot.rebuild` had no consumer. graduation.ts appends it when
      // a workspace graduates out of learning mode, precisely so the hot tier is
      // rebuilt against the now-production corpus; with no handler registered the
      // job was enqueued and dropped, and the tier kept serving whatever it had.
      //
      // Registered here, in the same pre-`outboxWorker.start()` window as the
      // scoped-conflict handler above, so a job appended during boot is not
      // drained before its consumer exists.
      //
      // `rebuildFromPg` reloads every snapshot rather than one workspace's — the
      // job carries a workspaceId the rebuild cannot use. That is acceptable
      // precisely because graduation is a once-per-workspace-lifetime event, not
      // a hot path; narrowing the rebuild would be a change to hotTierDump, not
      // to this wiring.
      if (jobQueue && hotTierCache && storageForDeps) {
        try {
          const cacheForRebuild = hotTierCache;
          const persistenceForRebuild = storageForDeps as unknown as HotTierPersistence;
          await jobQueue.process("mnemo.hot.rebuild", async () => {
            await rebuildFromPg(cacheForRebuild, persistenceForRebuild);
          });
          logger.info("hot_tier_rebuild.registered");
        } catch (err) {
          // Non-fatal, matching the scoped-conflict handler's posture.
          logger.warn({ err }, "hot_tier_rebuild.registration_failed");
        }
      }

      const owStorage = new adapterPgMod.DrizzleStorageAdapter(owDb, owPgClient);
      // Uses vectorUrlOuter (= MNEMO_VECTOR_URL ?? DATABASE_URL) so the outbox worker
      // routes vector writes to the same endpoint as the main recall core.
      // Same PgVectorAdapter config as pgVectorAdapter above — must stay in sync
      // with it (both must resolve to the same dimension for a given workspace)
      // or writes here would produce vectors reads never match.
      const owVector = new adapterVectorMod.PgVectorAdapter({
        connectionString: vectorUrlOuter,
        dimensions: embedDimensions,
      });
      const owCache =
        hotTierCache ??
        ({
          id: "no-op-cache",
          capabilities: {
            sortedSets: false,
            pubSub: false,
            patterns: false,
            atomic: false,
            hashes: false,
          },
          async get() {
            return null;
          },
          async set() {},
          async delete() {},
          async deletePattern() {
            return 0;
          },
          async healthCheck() {
            return { status: "ok" as const, latencyMs: 0 };
          },
          async close() {},
        } as import("@mnemo-ai/types").CacheAdapter);
      // Embedder for the vector_upsert handler so it can index text-form
      // payloads (non-fact primitives enqueued as { id, kind, text } without a
      // precomputed vector). Uses embedProvider (not llm) so a dedicated embed
      // provider is used consistently across all embed call sites.
      // Left undefined when no embed provider is configured — the worker then
      // logs-and-skips text-form payloads instead of dropping them.
      const owEmbedModel = process.env.MNEMO_EMBED_MODEL ?? "text-embedding-3-small";
      const owEmbed: import("@mnemo-ai/types").EmbedAdapter | undefined = embedProvider
        ? {
            id: "llm-provider-embed",
            model: owEmbedModel,
            dimensions: embedDimensions,
            local: embedLocal,
            async embed(texts: string[]): Promise<Float32Array[]> {
              const results = await Promise.all(
                texts.map((t) => embedProvider!.embed(t, owEmbedModel))
              );
              return results.map((vec) => new Float32Array(vec));
            },
            async embedSingle(text: string): Promise<Float32Array> {
              const vec = await embedProvider!.embed(text, owEmbedModel);
              return new Float32Array(vec);
            },
            async healthCheck() {
              return { status: "ok" as const, latencyMs: 0 };
            },
          }
        : undefined;
      outboxWorker = new adapterPgMod.OutboxWorker(
        owStorage,
        owVector,
        owCache,
        queue,
        {
          debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
          info: (msg, ctx) => logger.info(ctx ?? {}, msg),
          warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
          error: (msg, ctx) => logger.error(ctx ?? {}, msg),
          fatal: (msg, ctx) => logger.fatal(ctx ?? {}, msg),
          child: () => ({
            debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
            info: (msg, ctx) => logger.info(ctx ?? {}, msg),
            warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
            error: (msg, ctx) => logger.error(ctx ?? {}, msg),
            fatal: (msg, ctx) => logger.fatal(ctx ?? {}, msg),
            child: () => ({
              debug: () => {},
              info: () => {},
              warn: () => {},
              error: () => {},
              fatal: () => {},
              child: () => ({}) as never,
            }),
          }),
        },
        // config: defaults (batchSize/pollIntervalMs/maxRetries); the policy
        // makes text-form jobs re-read the row's tier (SECURITY.md §7).
        { sensitiveTextToProviders },
        // Inject the embedder so the vector_upsert handler can index text-form
        // payloads (non-fact primitives whose producers enqueue { id, kind, text }
        // without a precomputed vector). Without this, those payloads are skipped.
        owEmbed
      );
      outboxWorker.start();
      logger.info("outbox_worker.started");
    } catch (owErr) {
      logger.warn({ err: owErr }, "outbox_worker.start_failed — outbox events will not be drained");
    }
  }

  const app = createApp({ deps, version: VERSION });

  // §4 WebSocket subscriptions — mount /memory/ws and wire injectWebSocket.
  // createWsHandler requires the real Hono app instance to intercept upgrades.
  const { createWsHandler } = await import("./ws.js");
  const wsHandler = createWsHandler(app, {
    bus: busRef,
    apiKeys,
    replay: replayBuffer,
    userStatus: deps.userStatus,
    ...(deps.metricsPgClient
      ? { lookupRegion: createWorkspaceRegionLookup(deps.metricsPgClient) }
      : {}),
  });
  wsHandler.mount(app);

  // Wave R: Build path-dispatching http.Server so Hono and Connect share one port.
  const { createConnectHandler, GRPC_PATH_PREFIX } = await import("./grpc.js");
  const connectHandler = createConnectHandler(deps);
  const honoListener = getRequestListener(app.fetch);

  const httpServer = createServer((req, res) => {
    if (req.url && req.url.startsWith(GRPC_PATH_PREFIX)) {
      connectHandler(req, res);
    } else {
      honoListener(req, res);
    }
  });

  // MNEMO_GRPC_PORT: a second, cleartext HTTP/2 listener with only the Connect
  // handler, for what HTTP/1.1 cannot carry (the bidi Session and
  // FederationSync, and the gRPC protocol). Same interceptors, same auth.
  // Client-IP headers on this port count only from MNEMO_TRUSTED_PROXY_IP
  // (pinClientIpHeaders): it may be exposed without the proxy in front of PORT.
  let grpcServer: Http2Server | undefined;
  if (grpcPort !== undefined) {
    const trustedProxyIp = process.env.MNEMO_TRUSTED_PROXY_IP?.trim() || undefined;
    grpcServer = createH2cServer((req, res) => {
      pinClientIpHeaders(req, trustedProxyIp);
      return connectHandler(req, res);
    });
    grpcServer.on("error", (err) => {
      logger.error({ err, port: grpcPort }, "server.grpc_h2c_listen_failed");
      process.exit(1);
    });
    grpcServer.listen(grpcPort, () => {
      logger.info({ port: grpcPort }, "server.grpc_h2c_listening");
    });
  }

  httpServer.listen(port, () => {
    logger.info({ port, version: VERSION }, "server.listening");

    // P134 — pull the model cold start off the first request. Fire-and-forget
    // and AFTER listen(), so a slow or unreachable provider delays nothing:
    // the server is already accepting traffic when this runs.
    warmModels({
      embed: embedAdapter,
      ...(collapseLlmAdapter ? { llm: collapseLlmAdapter } : {}),
      logger,
    });

    // Setup wizard: check if unbootstrapped and generate a one-time token.
    void (async () => {
      try {
        const dbUrl = process.env["DATABASE_URL"] ?? process.env["MNEMO_DATABASE_URL"];
        if (!dbUrl) return;
        const { default: postgres } = (await import("postgres")) as unknown as {
          default: (
            url: string,
            opts?: Record<string, unknown>
          ) => {
            (tpl: TemplateStringsArray, ...v: unknown[]): Promise<Array<{ count: number }>>;
            end(opts?: { timeout?: number }): Promise<void>;
          };
        };
        const sql = postgres(dbUrl, {
          max: 1,
          idle_timeout: 5,
          connect_timeout: 10,
          connection: { search_path: "mnemosyne,public" },
        });
        try {
          const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
          const count = rows[0]?.count ?? 0;
          if (count === 0) {
            const { generateSetupToken } = await import("./routes/bootstrap.js");
            const token = generateSetupToken();
            const setupUrl = `http://localhost:${port}/setup?token=${token}`;
            logger.info(
              { event: "setup_required", setupUrl, tokenExpiresInMinutes: 15 },
              `\n\n  ╔══════════════════════════════════════════════════════════╗\n  ║  MNEMOSYNE SETUP REQUIRED                                ║\n  ║  Open in your browser:                                   ║\n  ║  ${setupUrl.padEnd(56)}  ║\n  ║  Token expires in 15 minutes.                            ║\n  ╚══════════════════════════════════════════════════════════╝\n`
            );
          }
        } finally {
          await sql.end({ timeout: 3 });
        }
      } catch (setupErr) {
        logger.warn(
          { err: setupErr },
          "setup_wizard.token_check_failed — continuing without setup token"
        );
      }
    })();
  });

  // §4 WS: inject the WebSocket upgrade handler into the http.Server.
  // MUST happen after httpServer is created.
  wsHandler.injectWebSocket(httpServer);

  // ---- Reminder evaluation polling (30 s, time-only sweep) ----
  // REMIND-1: this poller can ONLY fire reminders with no semantic condition
  // at all (condition IS NULL/blank) — it has no real query context, so it
  // passes an EMPTY queryText, which makes the evaluator's FTS keyword path
  // structurally unreachable (fail-closed BY CONSTRUCTION, not by luck).
  // Every compound (time+condition) or semantic-only reminder is evaluated
  // exclusively on the recall path (packages/server/src/recall/reminders.ts),
  // which has a real query to judge the condition against — that's where
  // memory_remind_when's "en cada ciclo de recall" promise is kept.
  // Errors are caught and logged at warn; they NEVER crash the process.
  let reminderPollInterval: ReturnType<typeof setInterval> | undefined;
  if (storageForDeps) {
    const storage = storageForDeps;

    const pollReminders = async (): Promise<void> => {
      try {
        const workspaceIds = await storage.listDueReminderWorkspaceIds();

        if (workspaceIds.length === 0) return;

        const { evaluatePendingReminders } = await import("@mnemo-ai/core");

        let totalTriggered = 0;
        for (const workspaceId of workspaceIds) {
          try {
            const triggered = await evaluatePendingReminders({
              storage,
              workspaceId,
              // Empty, not a placeholder string: makes the evaluator's FTS
              // keyword path structurally unreachable, so this sweep is
              // fail-closed BY CONSTRUCTION. Discovery already
              // only selects condition-less rows, so every reminder this
              // loop sees fires (or doesn't) on time alone.
              queryText: "",
              // No queryEmbedding, no llm — this is a time-only sweep.
            });
            totalTriggered += triggered.length;
            for (const t of triggered) {
              const traceId = "";
              emitEvent(
                busRef,
                "reminder.triggered",
                { workspaceId, id: t.id, content: t.content, triggeredBy: t.triggeredBy },
                traceId,
                `reminder.${workspaceId}`,
                replayBuffer
              );
              void dispatchWebhookEvent(deps, workspaceId, "reminder.triggered", {
                id: t.id,
                content: t.content,
                workspaceId,
              });
            }
          } catch (wsErr) {
            logger.warn({ wsErr, workspaceId }, "reminders.poll_workspace_error");
          }
        }

        if (totalTriggered > 0) {
          logger.info({ count: totalTriggered }, "reminders.poll_triggered");
        }
      } catch (err) {
        logger.warn({ err }, "reminders.poll_error");
      }
    };

    reminderPollInterval = setInterval(() => {
      pollReminders().catch((err) => {
        logger.warn({ err }, "reminders.poll_unhandled");
      });
    }, 30_000);

    logger.info("reminders.poller_started");
  } else {
    logger.warn("reminders.poller_skipped — storage not available");
  }

  // ---- §11 governance.propagate queue (pre-Wave-Y standalone interval) --------
  // Stores {workspaceId, sessionId} for every rated collapse so the 60s drain
  // interval can walk their provenance DAG and update worth credits without
  // blocking the session-sweep path.
  // TODO: fold into Wave Y's cron registry as mnemo.governance.propagate.
  const governanceQueue: Array<{ workspaceId: string; sessionId: string }> = [];

  // ---- Session inactivity sweep (5 min, collapses sessions open > 30 min) ----
  // Runs every 5 minutes and auto-collapses any session whose started_at is
  // older than 30 minutes and whose status is still 'open'.
  // Errors are caught and logged at warn; they NEVER crash the process.
  // Wave Y2: sweepInactiveSessions is hoisted here so it can be passed to
  // buildCronJobs as collapseStaleSessions (registered as mnemo.session.collapse).
  // The standalone sessionSweepInterval is removed; the registry fires it instead.
  const discoverLegacySweep = storageForDeps
    ? createPostgresSweepDiscovery({
        storage: storageForDeps,
        sessionBuffer: deps.sessionBuffer,
        cache: deps.cache,
      })
    : undefined;
  const sweepInactiveSessions = async (): Promise<
    import("./cron/jobs.js").SessionSweepTally | void
  > => {
    if (!storageForDeps || !discoverLegacySweep) return;
    try {
      const staleSessions = (await discoverLegacySweep()).map((session) => ({
        id: session.id,
        workspace_id: session.workspaceId,
        agent_id: session.agentId ?? null,
        turn_count: session.turnCount,
        token_count: session.tokenCount,
        age_seconds: session.inactivitySeconds,
        collapse_attempts: session.collapseAttempts ?? 0,
      }));
      if (staleSessions.length === 0) return;

      // LIFECYCLE-14: the tick used to end in `cron.tick_ok` whatever happened
      // to its collapses. The tally goes back to the cron job, which fails the
      // tick when any collapse failed.
      let collapsed = 0;
      let skipped = 0;
      let failed = 0;
      let abandoned = 0;
      for (const session of staleSessions) {
        // Only a throw from the collapse itself is a recorded attempt.
        let collapseInFlight = false;
        let attemptStart = 0;
        let attemptReason = "auto";
        const auditAttempt = (extra: CollapseAttemptOutcome) =>
          emitCollapseAttemptAudit((entry) => emitAudit({ storage: storageForDeps }, entry), {
            workspaceId: session.workspace_id,
            sessionId: session.id,
            operationId: `collapse:${session.workspace_id}:${session.id}`,
            attempt: session.collapse_attempts + 1,
            reason: attemptReason,
            startedAt: attemptStart,
            ...extra,
          });
        try {
          // Resolve this session's agent CollapsePolicy (documented defaults when
          // storage or agentId is unavailable). This is the source of truth for
          // both the trigger decision AND the pipeline thresholds.
          let policy = resolveCollapsePolicy(null);
          if (storageForDeps && session.agent_id) {
            const profile = await storageForDeps
              .getAgentProfile(session.workspace_id, session.agent_id)
              .catch(() => null);
            policy = resolveCollapsePolicy(profile);
          }

          const reason = shouldCollapseUnderPolicy(
            {
              turnCount: session.turn_count,
              tokenCount: session.token_count,
              ageSeconds: session.age_seconds,
            },
            policy
          );
          // Pre-filter caught it but the per-agent policy says "not yet" — skip.
          if (reason === null) continue;

          // Resolve workspace LLM override for the collapse (P6 dynamic config).
          let sweepLlmOverride: import("@mnemo-ai/types").LLMAdapter | undefined;
          if (deps?.llmConfigResolver) {
            const { buildWorkspaceLlmAdapter } = await import("./config/WorkspaceLlmAdapter.js");
            sweepLlmOverride =
              (await buildWorkspaceLlmAdapter(
                session.workspace_id,
                deps.llmConfigResolver,
                deps.llmAdapter
              )) ?? undefined;
          }
          // flatten-legacy-dual-core Phase 7: `deps.cognitive.collapseSession`
          // (PR16) replaces the legacy `core.collapseSession` — same 8-step
          // pipeline, same close/throw result-handling glue, now requiring an
          // explicit `AuthContext`. The session sweep has no per-request
          // caller identity (it's a background timer), so it synthesizes the
          // same `system:collapse` actor the legacy factory used to build
          // internally (`factory.ts`'s own `collapseSession`).
          const sweepAuth: AuthContext = {
            actorId: formatActorRef("system", "collapse"),
            actorType: "system",
            userId: null,
            workspaceId: session.workspace_id,
            scopes: ["memory:write", "memory:read", "session:manage"],
          };
          attemptReason = reason;
          attemptStart = Date.now();
          collapseInFlight = true;
          const sweepResult = await cognitive.collapseSession(
            {
              sessionId: session.id,
              workspaceId: session.workspace_id,
              strategy: "auto",
              reason,
              policy,
              ...(sweepLlmOverride ? { llmOverride: sweepLlmOverride } : {}),
            },
            sweepAuth
          );
          collapseInFlight = false;
          await auditAttempt({
            outcome:
              sweepResult.status === "completed" || sweepResult.status === "skipped"
                ? sweepResult.status
                : "failed",
            result: sweepResult as unknown as Record<string, unknown>,
          });
          if (sweepResult.status !== "completed") {
            if (sweepResult.status === "skipped") {
              skipped++;
              await deps.sessionBuffer
                ?.clear(session.workspace_id, session.id)
                .catch(() => undefined);
            }
            continue;
          }
          if (sweepResult?.anticipationAccuracy != null) {
            setAnticipationAccuracy(session.workspace_id, sweepResult.anticipationAccuracy);
          }
          collapsed++;
          // §4 Bus: emit session.collapsed for each auto-collapsed session.
          emitEvent(
            busRef,
            "session.collapsed",
            { sessionId: session.id, workspaceId: session.workspace_id, reason },
            "",
            `session.${session.id}`,
            replayBuffer
          );
          // OPS-6: fan-out webhook_fire outbox entries for session.collapsed.
          void dispatchWebhookEvent(deps, session.workspace_id, "session.collapsed", {
            sessionId: session.id,
            workspaceId: session.workspace_id,
            reason,
          });

          // Drop the session's Redis footprint now that it is collapsed (§7 step 7).
          if (deps.sessionBuffer) {
            await deps.sessionBuffer.clear(session.workspace_id, session.id).catch(() => undefined);
          }

          // §11 governance.propagate — enqueue only for rated sessions (outcome !== "abandoned").
          // Uses withMnemoTx so FORCE RLS applies (RLS invariant — never query mnemo_*
          // workspace-scoped tables outside a workspace-scoped transaction).
          let sessionOutcome: string | null = null;
          {
            const { withMnemoTx } = await import("@mnemo-ai/core");
            const { sql: drizzleSql } = await import("drizzle-orm");
            const outcomeRows = await withMnemoTx(session.workspace_id, async (tx) =>
              tx.execute(drizzleSql`
                  SELECT context_snapshot->>'outcome' AS outcome
                  FROM mnemosyne.mnemo_session
                  WHERE id = ${session.id} AND workspace_id = ${session.workspace_id}
                  LIMIT 1
                `)
            );
            sessionOutcome =
              (outcomeRows as unknown as Array<{ outcome: string | null }>)[0]?.outcome ?? null;
          }
          if (sessionOutcome !== "abandoned") {
            governanceQueue.push({ workspaceId: session.workspace_id, sessionId: session.id });
          }
        } catch (sessionErr) {
          if ((sessionErr as { code?: string }).code === "SESSION_SNAPSHOT_CHANGED") {
            logger.info({ sessionId: session.id }, "session_sweep.snapshot_changed_retry");
            continue;
          }
          failed++;
          if (collapseInFlight) await auditAttempt({ outcome: "failed", error: sessionErr });
          logger.warn(
            { err: sessionErr, sessionId: session.id, workspaceId: session.workspace_id },
            "session_sweep.collapse_error"
          );
          // LIFECYCLE-14: after the last attempt the sweep never selects the
          // session again, so it used to sit `active` forever, looking like
          // "pending retry". Archive it with the reason instead; an explicit
          // collapse can still extract it later.
          if (collapseInFlight && isLastCollapseAttempt(session.collapse_attempts)) {
            await storageForDeps
              .archiveSession?.(session.id, session.workspace_id, "collapse_failed")
              .then(() => {
                abandoned++;
                logger.warn(
                  {
                    sessionId: session.id,
                    workspaceId: session.workspace_id,
                    attempts: session.collapse_attempts + 1,
                  },
                  "session_sweep.collapse_abandoned"
                );
              })
              .catch(() => undefined);
          }
        }
      }

      const tally = { total: staleSessions.length, collapsed, skipped, failed, abandoned };
      if (collapsed > 0) {
        logger.info({ count: collapsed, total: staleSessions.length }, "session_sweep.collapsed");
      }
      if (failed > 0) logger.warn(tally, "session_sweep.tick");
      else logger.info(tally, "session_sweep.tick");
      return tally;
    } catch (err) {
      logger.warn({ err }, "session_sweep.error");
      // LIFECYCLE-14 review round: a discovery failure is a failed tick too.
      throw err;
    }
  };
  // ── Managed session recovery (host harness v1) ───────────────────────────────
  // Independent of the legacy sweep above: managed sessions are claimed under a
  // lease, prepared with no transaction held, and committed atomically. Gated by
  // the instance kill switch, so an unqualified deployment runs nothing.
  //
  // The lease owner identifies THIS process. It must be stable for the process
  // lifetime (so its own heartbeats keep validating its claims) and unique across
  // processes (so a restarted or parallel replica cannot mutate a claim it does
  // not hold).
  const managedLeaseOwner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const runManagedSessions =
    storageForDeps && process.env.MNEMO_HARNESS_V1_ENABLED === "true"
      ? createManagedWorkspaceRotation({
          listWorkspaceIds: () => storageForDeps!.listWorkspaceIds(),
          runWorkspace: async (workspaceId) => {
            await runManagedSessionWorker(
              {
                workspaceId,
                leaseOwner: managedLeaseOwner,
                limit: 25,
                leaseMs: 120_000,
                inactivityMs: 30 * 60 * 1000,
                provisionalGraceMs: 5_000,
              },
              {
                storage: storageForDeps as never,
                // Preparation runs outside any transaction; the facade owns the
                // CoreContext so this path cannot drift from every other core call.
                prepare: (input, auth) => cognitive.prepareManagedCollapse(input, auth),
                audit: (entry) => emitAudit({ storage: storageForDeps }, entry),
              }
            );
          },
          drainWorkspace: async (workspaceId) => {
            await drainManagedCollapseEffects(
              { workspaceId, leaseOwner: managedLeaseOwner, limit: 100, leaseMs: 120_000 },
              {
                storage: storageForDeps as never,
                execute: createManagedEffectExecutor({
                  context: { ...(hotTierCache ? { cache: hotTierCache } : {}), config: {} },
                  storage: storageForDeps as never,
                  bus: busRef,
                  ...(deps.replay ? { replay: deps.replay } : {}),
                  ...(webhookSecretCipher ? { webhookSecretCipher } : {}),
                }),
              }
            );
          },
          onWorkspaceError: (workspaceId, err) =>
            logger.warn({ err, workspaceId }, "managed_session_worker.workspace_error"),
        })
      : undefined;

  // NOTE: the standalone setInterval is removed — the cron registry fires
  // sweepInactiveSessions as mnemo.session.collapse (5 min interval).
  if (!storageForDeps) {
    logger.warn(
      "session_sweep.skipped — storage not available (cron registry will skip mnemo.session.collapse)"
    );
  }

  // ---- §11 governance.propagate drain (60s interval, pre-Wave-Y) ---------------
  // Drains the governanceQueue filled by the session sweep. Each entry gets a
  // provenance-DAG walk (≤5 hops) to update worth counters with λ^depth credit.
  const governancePropagateInterval = setInterval(() => {
    const batch = governanceQueue.splice(0, governanceQueue.length);
    if (batch.length === 0) return;
    for (const { workspaceId, sessionId } of batch) {
      cognitive.propagateGovernanceForSession(workspaceId, sessionId).catch((err) => {
        logger.warn({ err, workspaceId, sessionId }, "governance.propagate_error");
      });
    }
  }, 60_000); // mnemo.governance.propagate (60s drain)
  (
    governancePropagateInterval as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();

  // ── §28 cron registry (Wave Y2) ──────────────────────────────────────────────
  // Metacognition refresh, anticipation mining, and session collapse are now
  // all registered inside the declarative registry (see packages/server/src/cron/).
  // The inline metacognitionTimer and anticipationMineInterval blocks have been
  // folded into registry jobs mnemo.metacognition.refresh and mnemo.anticipate.mine.
  // Session sweep is the collapseStaleSessions closure passed to buildCronJobs.

  // ---- Consolidation scheduler (optional peer dep) ----
  // Wiring moved into the outbox-worker try block above (before
  // outboxWorker.start()) so scoped-conflict-check registration always
  // precedes outbox draining — see the `jobQueue`/`schedStop` comments there.
  // When storageForDeps is unset, the outbox block above is skipped entirely,
  // so consolidation never wires — this matches the pre-existing behavior of
  // the outbox block itself, which also requires storageForDeps.

  // ---- Plugin loader (optional peer dep) ----
  const pluginLoader = await wirePlugins({ deps });

  // ---- Federation (optional peer dep) ----
  await wireFederation({ databaseUrl, deps });

  // ── §28 cron registry startup (Wave Y2) ──────────────────────────────────────
  let cronRegistry: { stop(): void } | undefined;
  if (storageForDeps) {
    cronRegistry = await wireCrons({
      databaseUrl,
      storageForDeps: storageForDeps!,
      // Pass embedProvider as the llm param: wireCrons uses this for embed-only
      // operations (indexing cron jobs). The param name is preserved for backward
      // compat with the wireCrons interface; it receives embedProvider here so
      // embed-only providers (Voyage, NVIDIA) work correctly in cron embed paths.
      llm: embedProvider,
      outboxAdapter,
      sweepInactiveSessions,
      ...(runManagedSessions ? { runManagedSessions } : {}),
      idempotencyStore,
      deps,
      webhookSecretCipher,
      lastUtil: () => lastUtil,
      pluginLoader,
      // The cron re-embeds with embedProvider, whose locality is embedLocal.
      sensitiveTextToEmbedder: sensitiveTextMayReachEmbedder(sensitiveTextToProviders, {
        local: embedLocal,
      }),
      ...(purgePolicyChanges ? { purgePolicyChanges } : {}),
    });
  }

  // Graceful shutdown. SIGTERM is what k8s sends; SIGINT is Ctrl-C.
  // We stop accepting new connections then give in-flight requests up to
  // MNEMO_SHUTDOWN_GRACE_MS (default 45s)
  // to drain (Wave V: extended from 10s to allow OTel flush + hot-tier dump).
  // The consolidation scheduler is stopped first so the outbox and any
  // in-flight tick drains before the HTTP server closes.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      logger.info({ sig }, "server.shutdown_requested");

      // Wave V §22: flush OTel telemetry spans/metrics before closing.
      // Best-effort, 5s budget — we never block shutdown on this.
      const telemetryFlushTimeout = setTimeout(() => {
        logger.warn("server.telemetry_flush_timeout");
      }, 5_000);
      telemetryFlushTimeout.unref();
      // If a Telemetry adapter is wired, flush it.
      const depsAny = deps as unknown as Record<string, unknown>;
      if (
        depsAny["telemetry"] &&
        typeof (depsAny["telemetry"] as Record<string, unknown>)["shutdown"] === "function"
      ) {
        ((depsAny["telemetry"] as Record<string, unknown>)["shutdown"] as () => Promise<void>)()
          .then(() => {
            clearTimeout(telemetryFlushTimeout);
            logger.info("server.telemetry_flush_complete");
          })
          .catch((err) => {
            clearTimeout(telemetryFlushTimeout);
            logger.warn({ err }, "server.telemetry_flush_failed");
          });
      } else {
        clearTimeout(telemetryFlushTimeout);
      }

      // Shut down plugins first, before stopping the consolidation scheduler.
      if (pluginLoader) {
        // Build a minimal shutdown context — state/recall are best-effort during shutdown.
        import("./plugins/context.js")
          .then(({ buildPluginContext: bpcShutdown }) => {
            const shutdownCtx = bpcShutdown({
              pluginId: "__shutdown__",
              config: {},
              workspaceId: "default",
              deps,
              logger: {
                info: (o, m) => logger.info(o, m),
                warn: (o, m) => logger.warn(o, m),
                error: (o, m) => logger.error(o, m),
              },
            });
            pluginLoader!.runShutdown(shutdownCtx).catch(() => {
              /* already logged inside runShutdown */
            });
          })
          .catch(() => undefined);
        // NOTE: the plugin sync setInterval was removed — mnemo.plugin.sync is now
        // registered in the cron registry and stopped via cronRegistry.stop() below.
      }

      // Clear the reminder polling interval so no tick fires during drain.
      if (reminderPollInterval !== undefined) {
        clearInterval(reminderPollInterval);
      }

      // Stop the cron registry (Wave Y2 — replaces sessionSweepInterval,
      // metacognitionTimer, and anticipationMineInterval which were removed).
      if (cronRegistry) {
        try {
          cronRegistry.stop();
        } catch {
          /* ignore */
        }
      }

      // Clear the pg_stat_activity utilisation polling timer (RDD-9).
      if (utilTimer !== undefined) clearInterval(utilTimer);
      poolStallWatchdog?.stop();

      // Stop the outbox worker before closing DB connections.
      if (outboxWorker) {
        outboxWorker.stop();
      }

      // Close the setDb() pool (withMnemoTx/getDb() registry, see the
      // "Core wiring" block above).
      if (coreDbClientForShutdown) {
        coreDbClientForShutdown.end({ timeout: 5 }).catch(() => undefined);
      }

      // Clear the governance.propagate drain interval.
      clearInterval(governancePropagateInterval);

      // §37 Hot-tier dump — persist Redis ZSet → PG before closing Redis.
      // This is a best-effort async operation; we don't await it (the force-exit
      // timer above ensures we never hang shutdown indefinitely).
      if (hotTierCache && storageForDeps) {
        const dumpPersistence = storageForDeps as unknown as HotTierPersistence;
        // Enumerate through the SECURITY DEFINER function (migration 0041): a
        // direct cross-workspace SELECT returns nothing under FORCE RLS for the
        // application role, which silently turned this dump into a no-op.
        const storage = storageForDeps;
        const listWsIds = (): Promise<string[]> => storage.listWorkspaceIds().catch(() => []);
        dumpToPg(hotTierCache, dumpPersistence, listWsIds).catch((err) =>
          logger.warn({ err }, "hot_tier_dump.shutdown_failed")
        );
      }

      // Close the Redis hot-tier cache connection (non-blocking).
      if (
        hotTierCache &&
        typeof (hotTierCache as { close?: () => Promise<void> }).close === "function"
      ) {
        (hotTierCache as { close: () => Promise<void> }).close().catch(() => {
          /* ignore */
        });
      }

      // Stop the consolidation scheduler next (non-blocking).
      if (schedStop) {
        try {
          schedStop();
        } catch {
          /* ignore */
        }
      }

      // Force-kill timer, MNEMO_SHUTDOWN_GRACE_MS (default 45s, Wave V): long
      // enough for OTel flush (up to 5s) + hot-tier dump (up to 30s) before we
      // hard-exit. The platform's kill timeout (k8s terminationGracePeriodSeconds,
      // Fly kill_timeout) must be longer.
      const forceExit = setTimeout(() => {
        logger.warn("server.shutdown_force_exit");
        process.exit(1);
      }, shutdownGraceMs);
      forceExit.unref();

      grpcServer?.close();
      (httpServer as HttpServer).close((err?: Error) => {
        if (err) {
          logger.error({ err }, "server.shutdown_error");
          process.exit(1);
        } else {
          logger.info("server.shutdown_complete");
          process.exit(0);
        }
      });
    });
  }
}

import { readFileSync, realpathSync } from "node:fs";

function isMainModule(): boolean {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  const currentFilePath = fileURLToPath(import.meta.url);
  try {
    const realArgv = realpathSync(process.argv[1]);
    const realCurrent = realpathSync(currentFilePath);
    return realArgv === realCurrent;
  } catch {
    return import.meta.url === `file://${process.argv[1] ?? ""}`;
  }
}

if (isMainModule()) {
  bootFromEnv().catch((err) => {
    logger.error({ err }, "server.boot_failed");
    process.exit(1);
  });
}
