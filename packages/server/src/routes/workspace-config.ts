import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { GLOBAL_SENTINEL_ID, LLM_CONFIG_KEYS } from "../config/WorkspaceConfigStore.js";
import { BASE_URL_REFUSAL_MESSAGE, checkWorkspaceBaseUrl } from "../config/llm-base-url-guard.js";
import { emitAudit } from "../audit-emit.js";
import { readInstanceSettings } from "../instance-settings.js";
import { resolveProvenance } from "../provenance.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_PROVIDERS = [
  "openai",
  "google",
  "cohere",
  "mistral",
  "voyage",
  "ollama",
  "bedrock",
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mask an API key: return first 8 characters followed by "****".
 * Returns undefined when key is absent (e.g. Ollama, Bedrock).
 */
function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  // APP-075: the last 4 characters, never the first 8 (for a key with no vendor
  // prefix those were 8 real secret characters, shown to every reader).
  return key.length <= 8 ? "****" : "****" + key.slice(-4);
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const BedrockCredentialsSchema = z.object({
  awsAccessKeyId: z.string().min(1),
  awsSecretAccessKey: z.string().min(1),
  awsRegion: z.string().default("us-east-1"),
});

/**
 * Permissive body schema — accepts any provider string so that:
 *   - "anthropic" reaches our handler and can be rejected with 422 (not 400).
 *   - Unknown providers can also be rejected with 422.
 * Provider-specific validation (apiKey required, credentials shape, etc.) is
 * done inside the route handler where we can return the correct HTTP status.
 */
const LlmConfigBodySchema = z
  .object({
    provider: z.string().min(1),
    apiKey: z.string().optional(),
    embedModel: z.string().optional(),
    llmModel: z.string().optional(),
    // Bedrock uses a nested credentials object instead of apiKey
    credentials: BedrockCredentialsSchema.optional(),
    // Generation parameters
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe(
        "Sampling temperature (0=deterministic, 1=balanced, 2=creative). Default: 0.1 for fact extraction."
      ),
    maxTokens: z
      .number()
      .int()
      .min(1)
      .max(32768)
      .optional()
      .describe("Max output tokens per completion call. Default: 1024."),
    // Embedding parameters
    embedDimensions: z
      .number()
      .int()
      .min(64)
      .max(3072)
      .optional()
      .describe(
        "Embedding vector dimensions. Only supported by some models (e.g. OpenAI text-embedding-3-*). Changing this on an existing workspace will corrupt recall — re-index required."
      ),
    embedBatchSize: z
      .number()
      .int()
      .min(1)
      .max(2048)
      .optional()
      .describe("Number of texts per embedding API call. Default: provider max."),
    // OpenAI-compatible base URL override (for Azure, Ollama custom endpoint, proxies)
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Custom base URL for OpenAI-compatible providers (Azure, Ollama, LiteLLM proxy, etc.)."
      ),
  })
  .openapi("LlmConfigBody");

/** Typed view used internally after provider-level validation. */
type StandardBody = {
  provider: "openai" | "google" | "cohere" | "mistral" | "voyage" | "ollama";
  apiKey?: string;
  embedModel?: string;
  llmModel?: string;
};
type BedrockBody = {
  provider: "bedrock";
  credentials: { awsAccessKeyId: string; awsSecretAccessKey: string; awsRegion: string };
  embedModel?: string;
};
type ValidatedBody = StandardBody | BedrockBody;

const LlmConfigResponseSchema = z
  .object({
    ok: z.boolean(),
    warned: z.boolean().optional(),
    warning: z.string().optional(),
    provider: z.string().optional(),
    embedModel: z.string().optional(),
  })
  .openapi("LlmConfigResponse");

const LlmConfigReadSchema = z
  .object({
    provider: z.string().nullable(),
    apiKey: z.string().optional(),
    embedModel: z.string().optional(),
    llmModel: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    embedDimensions: z.number().optional(),
    embedBatchSize: z.number().optional(),
    baseUrl: z.string().optional(),
    source: z.enum(["workspace", "global", "env"]),
    canEdit: z.boolean().describe("Whether this caller may PUT/DELETE the workspace override."),
    editPolicy: z
      .enum(["installation", "workspace_owners"])
      .describe(
        "installation: only installation admins set the model; workspace_owners: the installation lets owners and admins bring their own."
      ),
  })
  .openapi("LlmConfigRead");

// ─── Route definitions ────────────────────────────────────────────────────────

const putWorkspaceConfig = createRoute({
  method: "put",
  path: "/config/llm",
  tags: ["config"],
  summary: "Set workspace LLM provider config.",
  request: {
    body: {
      content: { "application/json": { schema: LlmConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Config stored successfully.",
      content: { "application/json": { schema: LlmConfigResponseSchema } },
    },
    400: { description: "Missing required field (e.g. apiKey for non-ollama provider)." },
    403: {
      description:
        "LLM_CONFIG_INSTALLATION_ONLY: the installation does not let workspace owners set their own model.",
    },
    422: { description: "Provider not supported or validation error (incl. a refused baseUrl)." },
    501: { description: "Encryption not configured." },
  },
});

const getWorkspaceConfig = createRoute({
  method: "get",
  path: "/config/llm",
  tags: ["config"],
  summary: "Read workspace LLM provider config (API key masked).",
  responses: {
    200: {
      description: "Current workspace LLM config.",
      content: { "application/json": { schema: LlmConfigReadSchema } },
    },
  },
});

const deleteWorkspaceConfig = createRoute({
  method: "delete",
  path: "/config/llm",
  tags: ["config"],
  summary: "Remove workspace LLM config override (falls back to global/env).",
  responses: {
    204: { description: "Config removed." },
    403: {
      description:
        "LLM_CONFIG_INSTALLATION_ONLY: the installation does not let workspace owners change the model.",
    },
    404: { description: "No workspace config row exists." },
  },
});

// ─── Who may change a workspace's model ──────────────────────────────────────

type LlmEditPolicy = "installation" | "workspace_owners";

/**
 * Installation admins (scope admin:workspace: a superadmin's password session,
 * an operator admin key) always may. Anyone else with the route's own scope
 * (memory:admin, i.e. a workspace owner or admin) only when the installation
 * setting workspaceLlmOverride is on.
 */
async function llmEditPermission(
  scopes: ReadonlyArray<string> | undefined,
  deps: ServerDeps
): Promise<{ canEdit: boolean; installationAdmin: boolean; policy: LlmEditPolicy }> {
  const installationAdmin = scopes?.includes("admin:workspace") === true;
  let policy: LlmEditPolicy = "installation";
  try {
    if ((await readInstanceSettings(deps)).workspaceLlmOverride) policy = "workspace_owners";
  } catch {
    // Unreadable settings keep the safe default: installation admins only.
  }
  return { canEdit: installationAdmin || policy === "workspace_owners", installationAdmin, policy };
}

const INSTALLATION_ONLY_BODY = {
  code: "LLM_CONFIG_INSTALLATION_ONLY",
  message:
    "The model is set by the installation. A superadmin can change it, or allow workspace owners to set their own in Installation > Settings.",
} as const;

/** The host of a base URL for the audit trail (never the path, which may carry a token). */
function baseUrlHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
}

// ─── Shared logic helpers ─────────────────────────────────────────────────────

/**
 * Core PUT logic shared by workspace and admin endpoints.
 *
 * @param workspaceId   The workspace (or GLOBAL_SENTINEL_ID for admin).
 * @param rawBody       The validated-but-permissive request body from Zod.
 * @param isGlobal      When true, dimension check spans ALL workspaces.
 */
async function handlePutLlmConfig(
  workspaceId: string,
  rawBody: z.infer<typeof LlmConfigBodySchema>,
  deps: ServerDeps,
  pgClient: import("postgres").Sql | undefined,
  isGlobal: boolean,
  /** False for a workspace owner who is not an installation admin: baseUrl is checked. */
  trustedCaller = true
): Promise<{
  status: 200 | 400 | 422 | 501;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}> {
  // 1. Encryption gate
  if (!deps.workspaceConfigStore || !deps.llmConfigResolver) {
    return {
      status: 501,
      body: { code: "ENCRYPTION_REQUIRED", message: "MNEMO_MASTER_KEY is not configured." },
    };
  }

  const providerStr = rawBody.provider.toLowerCase();

  // 2. Reject Anthropic (no embeddings API) — returns 422 even though Zod would
  //    not normally enforce this at the schema level.
  if (providerStr === "anthropic") {
    return {
      status: 422,
      body: {
        code: "PROVIDER_NOT_SUPPORTED",
        provider: "anthropic",
        reason: "Anthropic does not provide an embeddings API — use voyage provider instead",
      },
    };
  }

  // 3. Reject unknown providers with 422
  if (!SUPPORTED_PROVIDERS.includes(providerStr as (typeof SUPPORTED_PROVIDERS)[number])) {
    return {
      status: 422,
      body: {
        code: "PROVIDER_NOT_SUPPORTED",
        provider: providerStr,
        reason: `Unknown provider. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
      },
    };
  }

  // 4. Validate apiKey requirement for non-ollama / non-bedrock
  if (providerStr !== "ollama" && providerStr !== "bedrock") {
    if (!rawBody.apiKey) {
      return {
        status: 400,
        body: {
          code: "MISSING_API_KEY",
          message: "apiKey is required for provider " + providerStr,
        },
      };
    }
  }

  // 5. For Bedrock, validate credentials structure
  if (providerStr === "bedrock") {
    const creds = rawBody.credentials;
    if (!creds?.awsAccessKeyId || !creds?.awsSecretAccessKey) {
      return {
        status: 400,
        body: {
          code: "MISSING_CREDENTIALS",
          message:
            "credentials.awsAccessKeyId and credentials.awsSecretAccessKey are required for bedrock provider",
        },
      };
    }
  }

  // 6. A workspace owner who is not an installation admin may only reach the
  //    public internet: a base URL is checked, and Ollama (which defaults to
  //    the server's own localhost) needs one.
  if (!trustedCaller) {
    if (providerStr === "ollama" && !rawBody.baseUrl) {
      return {
        status: 422,
        body: {
          code: "BASE_URL_REQUIRED",
          message: "ollama needs a public https:// baseUrl; the default is the server's localhost.",
        },
      };
    }
    if (rawBody.baseUrl) {
      const refusal = await checkWorkspaceBaseUrl(rawBody.baseUrl);
      if (refusal) {
        return { status: 422, body: { code: refusal, message: BASE_URL_REFUSAL_MESSAGE[refusal] } };
      }
    }
  }

  // Narrow to typed view for the rest of the function
  const body = rawBody as unknown as ValidatedBody;

  // 4. Encrypt and persist config rows
  // We need the keyRing — it is only available via the server's encryption module.
  // Access it by dynamically importing from the config module context.
  // The keyRing is stored in the deps indirectly: we can reach it through the
  // resolver's internal kms by importing the KeyRingAdapter factory.
  // In practice the route uses the keyRing wired at boot. We store a reference
  // in the deps indirectly — but we cannot access it from ServerDeps directly.
  // Instead, we rely on the LlmConfigResolver knowing the keyRing and we call
  // a helper that encodes the config into the store.
  //
  // To avoid leaking the keyRing into ServerDeps (not in the design), we use
  // dynamic import of the server's KeyRingAdapter factory here. However, that
  // factory reads from process.env directly. This is intentional: the route
  // creates a transient ring for the put operation, which is safe because boot
  // already validated the key.

  let keyRing: import("../encryption/KeyRingAdapter.js").KeyRingAdapter;
  try {
    const { createKeyRingAdapter } = await import("../encryption/KeyRingAdapter.js");
    keyRing = createKeyRingAdapter();
  } catch {
    return {
      status: 501,
      body: { code: "ENCRYPTION_REQUIRED", message: "MNEMO_MASTER_KEY is not configured." },
    };
  }

  const store = deps.workspaceConfigStore;
  // The whole configuration is written as one unit (see LLM_CONFIG_KEYS):
  // every key this PUT does not set is removed in the same transaction, so
  // nothing of the previous configuration — an old base_url, a stale key —
  // survives next to the new one, and no reader sees half of each.
  const values: Record<string, string> = {};

  // Encrypt and store provider name
  values.llm_provider = keyRing.encryptSecret(workspaceId, "llm-config", providerStr);

  if (providerStr === "bedrock") {
    const bedrockBody = body as BedrockBody;
    const credsJson = JSON.stringify(bedrockBody.credentials);
    values.llm_credentials = keyRing.encryptSecret(workspaceId, "llm-config", credsJson);
  } else if (providerStr !== "ollama") {
    const stdBody = body as StandardBody;
    values.llm_api_key = keyRing.encryptSecret(workspaceId, "llm-config", stdBody.apiKey!);
  }

  const embedModel = (body as { embedModel?: string }).embedModel;
  if (embedModel) {
    values.embed_model = keyRing.encryptSecret(workspaceId, "llm-config", embedModel);
  }

  const llmModel = (body as { llmModel?: string }).llmModel;
  if (llmModel) {
    values.llm_model = keyRing.encryptSecret(workspaceId, "llm-config", llmModel);
  }

  // Generation parameters
  const rawBody2 = rawBody as z.infer<typeof LlmConfigBodySchema>;
  if (rawBody2.temperature !== undefined) {
    values.temperature = keyRing.encryptSecret(
      workspaceId,
      "llm-config",
      String(rawBody2.temperature)
    );
  }
  if (rawBody2.maxTokens !== undefined) {
    values.max_tokens = keyRing.encryptSecret(
      workspaceId,
      "llm-config",
      String(rawBody2.maxTokens)
    );
  }
  if (rawBody2.embedDimensions !== undefined) {
    values.embed_dimensions = keyRing.encryptSecret(
      workspaceId,
      "llm-config",
      String(rawBody2.embedDimensions)
    );
  }
  if (rawBody2.embedBatchSize !== undefined) {
    values.embed_batch_size = keyRing.encryptSecret(
      workspaceId,
      "llm-config",
      String(rawBody2.embedBatchSize)
    );
  }
  if (rawBody2.baseUrl) {
    values.base_url = keyRing.encryptSecret(workspaceId, "llm-config", rawBody2.baseUrl);
  }

  await store.replaceGroup(workspaceId, LLM_CONFIG_KEYS, values, "api");

  // 5. Invalidate cache
  deps.llmConfigResolver.invalidate(workspaceId);

  // 6. Check for dimension mismatch (warn-only, never blocks)
  let warned = false;
  let warning: string | undefined;

  if (pgClient) {
    try {
      // Intentional admin bypass: this route requires memory:admin scope and the
      // dimension-mismatch check is a best-effort warning (never blocks the write).
      // Both branches read only the boolean EXISTS — no sensitive fact content is
      // returned. The global branch is a cross-workspace existence probe; the
      // workspace branch applies an application-layer workspace_id predicate which
      // is equivalent to RLS scoping for a boolean EXISTS check (no data leaks).
      let rows: Array<Record<string, unknown>>;
      if (isGlobal) {
        rows = await pgClient<Array<Record<string, unknown>>>`
          SELECT 1 FROM mnemosyne.mnemo_fact
          WHERE embedding IS NOT NULL
          LIMIT 1
        `;
      } else {
        rows = await pgClient<Array<Record<string, unknown>>>`
          SELECT 1 FROM mnemosyne.mnemo_fact
          WHERE workspace_id = ${workspaceId}
            AND embedding IS NOT NULL
          LIMIT 1
        `;
      }
      if (rows.length > 0) {
        warned = true;
        warning =
          "Existing embeddings detected. Switching providers may cause dimension mismatch. " +
          "Re-index facts after changing the embed model.";
      }
    } catch {
      // Non-fatal — dimension check is best-effort
    }
  }

  const responseBody: Record<string, unknown> = { ok: true };
  if (warned) {
    responseBody.warned = true;
    responseBody.warning = warning;
  }

  const headers: Record<string, string> = {};
  if (warned) headers["X-Mnemo-Embed-Warning"] = "true";

  return { status: 200, body: responseBody, headers };
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountWorkspaceConfig(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET the pg client from deps (it's exposed as metricsPgClient)
  const pgClient = deps.metricsPgClient;

  // PUT /config/llm — set workspace LLM config
  app.openapi(putWorkspaceConfig, async (c) => {
    const workspaceId = c.get("workspaceId");
    const body = c.req.valid("json");

    const permission = await llmEditPermission(c.get("scopes"), deps);
    if (!permission.canEdit) return c.json(INSTALLATION_ONLY_BODY, 403 as never);

    const result = await handlePutLlmConfig(
      workspaceId,
      body,
      deps,
      pgClient,
      false,
      permission.installationAdmin
    );

    if (result.status === 200) {
      // Who pointed this workspace's memories at which provider. No secret:
      // the key and credentials stay out, the base URL is reduced to its host.
      const provenance = resolveProvenance(c);
      await emitAudit(deps, {
        workspaceId,
        actorType: provenance.actorType,
        actorId: provenance.actorId,
        action: "settings_changed",
        resourceKind: "llm_config",
        resourceId: workspaceId,
        detail: {
          change: "set",
          provider: body.provider.toLowerCase(),
          ...(body.llmModel ? { llmModel: body.llmModel } : {}),
          ...(body.embedModel ? { embedModel: body.embedModel } : {}),
          ...(baseUrlHost(body.baseUrl) ? { baseUrlHost: baseUrlHost(body.baseUrl) } : {}),
          installationAdmin: permission.installationAdmin,
        },
        isTerminal: false,
      });
    }

    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        c.header(k, v);
      }
    }

    return c.json(result.body, result.status as 200 | 400 | 422 | 501);
  });

  // GET /config/llm — read workspace config (key masked)
  app.openapi(getWorkspaceConfig, async (c) => {
    const workspaceId = c.get("workspaceId");

    const permission = await llmEditPermission(c.get("scopes"), deps);
    const access = { canEdit: permission.canEdit, editPolicy: permission.policy };

    if (!deps.llmConfigResolver) {
      return c.json({ provider: null, source: "env" as const, ...access }, 200);
    }

    const resolved = await deps.llmConfigResolver.resolve(workspaceId);

    // Determine source: if no db row, it came from env
    // We check the config store to distinguish workspace vs global vs env
    let source: "workspace" | "global" | "env" = "env";
    let maskedKey: string | undefined;
    let llmModel: string | undefined;

    if (deps.workspaceConfigStore) {
      const wsRow = await deps.workspaceConfigStore.get(workspaceId, "llm_provider");
      if (wsRow) {
        source = "workspace";
        // Decrypt the api key for masking
        try {
          const { createKeyRingAdapter } = await import("../encryption/KeyRingAdapter.js");
          const keyRing = createKeyRingAdapter();
          const apiKeyRow = await deps.workspaceConfigStore.get(workspaceId, "llm_api_key");
          if (apiKeyRow) {
            const plainKey = keyRing.decryptSecret(workspaceId, "llm-config", apiKeyRow);
            maskedKey = maskApiKey(plainKey);
          }
          const modelRow = await deps.workspaceConfigStore.get(workspaceId, "llm_model");
          if (modelRow) llmModel = keyRing.decryptSecret(workspaceId, "llm-config", modelRow);
        } catch {
          // decryption failure — return no key
        }
      } else {
        const globalRow = await deps.workspaceConfigStore.get(GLOBAL_SENTINEL_ID, "llm_provider");
        if (globalRow) {
          source = "global";
          try {
            const { createKeyRingAdapter } = await import("../encryption/KeyRingAdapter.js");
            const keyRing = createKeyRingAdapter();
            const apiKeyRow = await deps.workspaceConfigStore.get(
              GLOBAL_SENTINEL_ID,
              "llm_api_key"
            );
            if (apiKeyRow) {
              const plainKey = keyRing.decryptSecret(GLOBAL_SENTINEL_ID, "llm-config", apiKeyRow);
              maskedKey = maskApiKey(plainKey);
            }
            const modelRow = await deps.workspaceConfigStore.get(GLOBAL_SENTINEL_ID, "llm_model");
            if (modelRow)
              llmModel = keyRing.decryptSecret(GLOBAL_SENTINEL_ID, "llm-config", modelRow);
          } catch {
            // decryption failure — return no key
          }
        }
      }
    }

    const providerName = resolved.provider
      ? ((resolved.provider as { name?: string }).name ?? null)
      : null;

    // The env tier completes with the boot completion provider: its model is
    // MNEMO_LLM_MODEL, else that provider's own default (see index.ts).
    if (source === "env") {
      llmModel =
        process.env.MNEMO_LLM_MODEL ||
        (deps.llm as { defaultCompleteModel?: string } | undefined)?.defaultCompleteModel ||
        undefined;
    }

    return c.json(
      {
        provider: providerName,
        // APP-075: only a caller who may replace the key sees which one is set.
        ...(maskedKey !== undefined && access.canEdit ? { apiKey: maskedKey } : {}),
        embedModel: resolved.embedModel,
        ...(llmModel ? { llmModel } : {}),
        source,
        ...access,
      },
      200
    );
  });

  // DELETE /config/llm — remove workspace config override
  app.openapi(deleteWorkspaceConfig, async (c) => {
    const workspaceId = c.get("workspaceId");

    if (!(await llmEditPermission(c.get("scopes"), deps)).canEdit) {
      return c.json(INSTALLATION_ONLY_BODY, 403 as never);
    }

    if (!deps.workspaceConfigStore) {
      return c.json({ code: "NOT_FOUND" }, 404 as never);
    }

    // Check if any config row exists for this workspace
    const existing = await deps.workspaceConfigStore.get(workspaceId, "llm_provider");
    if (!existing) {
      return c.json({ code: "NOT_FOUND" }, 404 as never);
    }

    // Delete every LLM config key in one transaction. Five of them used to be
    // left behind (base_url among them), so the next PUT without a baseUrl
    // sent its key to the old proxy. Retention keys are not in the group.
    await deps.workspaceConfigStore.replaceGroup(workspaceId, LLM_CONFIG_KEYS, {});

    // Invalidate cache
    deps.llmConfigResolver?.invalidate(workspaceId);

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action: "settings_changed",
      resourceKind: "llm_config",
      resourceId: workspaceId,
      detail: { change: "removed" },
      isTerminal: false,
    });

    return new Response(null, { status: 204 });
  });
}

// ─── Retention config routes ──────────────────────────────────────────────────

const RetentionConfigBodySchema = z
  .object({
    internalDays: z.number().int().min(1).max(36500).optional(),
    confidentialDays: z.number().int().min(1).max(36500).optional(),
    restrictedDays: z.number().int().min(1).max(36500).optional(),
    /** Managed raw-transcript window, in days. */
    transcriptDays: z.number().int().min(1).max(36500).optional(),
  })
  .openapi("RetentionConfigBody");

const RetentionConfigReadSchema = z
  .object({
    internalDays: z.number().int(),
    confidentialDays: z.number().int(),
    restrictedDays: z.number().int(),
    transcriptDays: z.number().int(),
    source: z.enum(["workspace", "global", "env"]),
  })
  .openapi("RetentionConfigRead");

const putRetentionConfig = createRoute({
  method: "put",
  path: "/config/retention",
  tags: ["config"],
  summary: "Set workspace retention window config (partial update).",
  request: {
    body: {
      content: { "application/json": { schema: RetentionConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Config stored successfully.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: { description: "Validation error — day value out of range." },
    501: { description: "Encryption not configured." },
  },
});

const getRetentionConfig = createRoute({
  method: "get",
  path: "/config/retention",
  tags: ["config"],
  summary: "Read effective workspace retention window config.",
  responses: {
    200: {
      description: "Effective retention config with source.",
      content: { "application/json": { schema: RetentionConfigReadSchema } },
    },
  },
});

const deleteRetentionConfig = createRoute({
  method: "delete",
  path: "/config/retention",
  tags: ["config"],
  summary: "Remove workspace retention config override (falls back to global/env).",
  responses: {
    204: { description: "Config removed." },
    404: { description: "No workspace retention config row exists." },
    501: { description: "Encryption not configured." },
  },
});

/**
 * Core PUT logic shared by workspace and admin retention endpoints.
 *
 * @param workspaceId   The workspace (or GLOBAL_SENTINEL_ID for admin).
 * @param body          The validated request body from Zod (all fields optional).
 * @param deps          ServerDeps.
 */
export async function handlePutRetentionConfig(
  workspaceId: string,
  body: z.infer<typeof RetentionConfigBodySchema>,
  deps: ServerDeps
): Promise<{
  status: 200 | 400 | 501;
  body: Record<string, unknown>;
}> {
  // 1. Encryption gate
  if (!deps.workspaceConfigStore || !deps.retentionConfigResolver) {
    return {
      status: 501,
      body: { code: "ENCRYPTION_REQUIRED", message: "MNEMO_MASTER_KEY is not configured." },
    };
  }

  let keyRing: import("../encryption/KeyRingAdapter.js").KeyRingAdapter;
  try {
    const { createKeyRingAdapter } = await import("../encryption/KeyRingAdapter.js");
    keyRing = createKeyRingAdapter();
  } catch {
    return {
      status: 501,
      body: { code: "ENCRYPTION_REQUIRED", message: "MNEMO_MASTER_KEY is not configured." },
    };
  }

  const store = deps.workspaceConfigStore;

  // Store only the keys that are present in the body (partial update)
  if (body.internalDays !== undefined) {
    const enc = keyRing.encryptSecret(workspaceId, "retention-config", String(body.internalDays));
    await store.set(workspaceId, "retention_internal_days", enc, "api");
  }
  if (body.confidentialDays !== undefined) {
    const enc = keyRing.encryptSecret(
      workspaceId,
      "retention-config",
      String(body.confidentialDays)
    );
    await store.set(workspaceId, "retention_confidential_days", enc, "api");
  }
  if (body.restrictedDays !== undefined) {
    const enc = keyRing.encryptSecret(workspaceId, "retention-config", String(body.restrictedDays));
    await store.set(workspaceId, "retention_restricted_days", enc, "api");
  }
  if (body.transcriptDays !== undefined) {
    const enc = keyRing.encryptSecret(workspaceId, "retention-config", String(body.transcriptDays));
    await store.set(workspaceId, "retention_transcript_days", enc, "api");
  }

  // Invalidate cache so next resolution is fresh
  deps.retentionConfigResolver.invalidate(workspaceId);

  return { status: 200, body: { ok: true } };
}

/**
 * Mount retention config routes on an existing Hono app.
 * Called from app.ts alongside mountWorkspaceConfig.
 */
export function mountRetentionConfig(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // PUT /config/retention — set workspace retention windows (partial)
  app.openapi(putRetentionConfig, async (c) => {
    const workspaceId = c.get("workspaceId");
    const body = c.req.valid("json");

    const result = await handlePutRetentionConfig(workspaceId, body, deps);
    return c.json(result.body, result.status as 200 | 400 | 501);
  });

  // GET /config/retention — read effective retention config
  app.openapi(getRetentionConfig, async (c) => {
    const workspaceId = c.get("workspaceId");

    if (!deps.retentionConfigResolver) {
      // No resolver — fall back to env vars via parseRetentionConfig
      const { parseRetentionConfig } = await import("../cron/retention-purge.js");
      const env = parseRetentionConfig(process.env);
      return c.json(
        {
          internalDays: env.internalDays,
          confidentialDays: env.confidentialDays,
          restrictedDays: env.restrictedDays,
          transcriptDays: env.transcriptDays,
          source: "env" as const,
        },
        200
      );
    }

    const resolved = await deps.retentionConfigResolver.resolve(workspaceId);
    return c.json(
      {
        internalDays: resolved.internalDays,
        confidentialDays: resolved.confidentialDays,
        restrictedDays: resolved.restrictedDays,
        transcriptDays: resolved.transcriptDays,
        source: resolved.source,
      },
      200
    );
  });

  // DELETE /config/retention — remove workspace retention override
  app.openapi(deleteRetentionConfig, async (c) => {
    const workspaceId = c.get("workspaceId");

    if (!deps.workspaceConfigStore || !deps.retentionConfigResolver) {
      return c.json(
        { code: "ENCRYPTION_REQUIRED", message: "MNEMO_MASTER_KEY is not configured." },
        501 as never
      );
    }

    // Check if any retention row exists for this workspace
    const existing = await deps.workspaceConfigStore.get(workspaceId, "retention_internal_days");
    if (!existing) {
      return c.json({ code: "NOT_FOUND" }, 404 as never);
    }

    // Delete all 3 retention keys
    await Promise.all([
      deps.workspaceConfigStore.delete(workspaceId, "retention_internal_days"),
      deps.workspaceConfigStore.delete(workspaceId, "retention_confidential_days"),
      deps.workspaceConfigStore.delete(workspaceId, "retention_restricted_days"),
    ]);

    // Invalidate cache
    deps.retentionConfigResolver.invalidate(workspaceId);

    return new Response(null, { status: 204 });
  });
}

// ─── Admin global config routes (shared logic) ────────────────────────────────

export { handlePutLlmConfig, maskApiKey, LlmConfigBodySchema, RetentionConfigBodySchema };
