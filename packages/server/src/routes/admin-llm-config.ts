import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import { handlePutLlmConfig, maskApiKey, LlmConfigBodySchema } from "./workspace-config.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * PUT/GET /admin/config/llm — global LLM provider configuration.
 *
 * Relocated verbatim from `admin.ts` (docs/archive/openspec/decompose-admin-routes) — pure
 * file-level split, no schema, path, or handler-logic change. Operates on
 * `GLOBAL_SENTINEL_ID` via the same shared `handlePutLlmConfig` handler
 * `workspace-config.ts`'s per-workspace self-service variant also uses.
 */

// ─── Zod schemas ────────────────────────────────────────────────────────────

const AdminLlmConfigReadSchema = z
  .object({
    provider: z.string().nullable(),
    apiKey: z.string().optional(),
    embedModel: z.string().optional(),
    llmModel: z.string().optional(),
    source: z.enum(["workspace", "global", "env"]),
  })
  .openapi("AdminLlmConfigRead");

const AdminLlmConfigResponseSchema = z
  .object({
    ok: z.boolean(),
    warned: z.boolean().optional(),
    warning: z.string().optional(),
  })
  .openapi("AdminLlmConfigResponse");

// ─── Route definitions ──────────────────────────────────────────────────────

const putAdminLlmConfig = createRoute({
  method: "put",
  path: "/admin/config/llm",
  tags: ["admin"],
  summary:
    "Set global LLM provider config (applies to all workspaces without workspace-level override).",
  request: {
    body: {
      content: { "application/json": { schema: LlmConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Global config stored.",
      content: { "application/json": { schema: AdminLlmConfigResponseSchema } },
    },
    400: { description: "Missing required field." },
    422: { description: "Provider not supported." },
    501: { description: "Encryption not configured." },
  },
});

const getAdminLlmConfig = createRoute({
  method: "get",
  path: "/admin/config/llm",
  tags: ["admin"],
  summary: "Read global LLM provider config (API key masked).",
  responses: {
    200: {
      description: "Global LLM config.",
      content: { "application/json": { schema: AdminLlmConfigReadSchema } },
    },
  },
});

// ─── Mount ───────────────────────────────────────────────────────────────────

export function mountAdminLlmConfig(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const pgClient = deps.metricsPgClient;

  // PUT /admin/config/llm — set global LLM config (scope: admin:workspace / memory:admin)
  app.openapi(putAdminLlmConfig, async (c) => {
    const body = c.req.valid("json");

    const result = await handlePutLlmConfig(GLOBAL_SENTINEL_ID, body, deps, pgClient, true);

    // D5: admin_access is mutating-only. Partition on the caller's REAL
    // workspace (c.get("workspaceId")) — never GLOBAL_SENTINEL_ID, which is
    // not a real workspace row and appendAuditEntry requires a genuine
    // workspace UUID. Only emit once the write actually succeeded.
    if (result.status === 200) {
      const provenance = resolveProvenance(c);
      await emitAudit(deps, {
        workspaceId: c.get("workspaceId"),
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "admin_access",
        resourceKind: "admin_config",
        resourceId: "llm",
        isTerminal: false,
        detail: {
          ...(provenance.userId ? { userId: provenance.userId } : {}),
          route: "/admin/config/llm",
          method: "PUT",
          target: "global",
        },
      });
    }

    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        c.header(k, v);
      }
    }

    return c.json(result.body, result.status as 200 | 400 | 422 | 501);
  });

  // GET /admin/config/llm — read global LLM config (key masked)
  app.openapi(getAdminLlmConfig, async (c) => {
    if (!deps.llmConfigResolver || !deps.workspaceConfigStore) {
      return c.json({ provider: null, source: "env" as const }, 200);
    }

    const globalRow = await deps.workspaceConfigStore.get(GLOBAL_SENTINEL_ID, "llm_provider");
    let maskedKey: string | undefined;
    let providerName: string | null = null;
    let embedModel: string | undefined;

    if (globalRow) {
      try {
        const { createKeyRingAdapter } = await import("../encryption/KeyRingAdapter.js");
        const keyRing = createKeyRingAdapter();
        providerName = keyRing.decryptSecret(GLOBAL_SENTINEL_ID, "llm-config", globalRow);

        const embedModelRow = await deps.workspaceConfigStore.get(
          GLOBAL_SENTINEL_ID,
          "embed_model"
        );
        if (embedModelRow) {
          embedModel = keyRing.decryptSecret(GLOBAL_SENTINEL_ID, "llm-config", embedModelRow);
        }

        const apiKeyRow = await deps.workspaceConfigStore.get(GLOBAL_SENTINEL_ID, "llm_api_key");
        if (apiKeyRow) {
          const plainKey = keyRing.decryptSecret(GLOBAL_SENTINEL_ID, "llm-config", apiKeyRow);
          maskedKey = maskApiKey(plainKey);
        }
      } catch {
        // decryption failure — return no key
      }
    }

    return c.json(
      {
        provider: providerName,
        ...(maskedKey !== undefined ? { apiKey: maskedKey } : {}),
        ...(embedModel !== undefined ? { embedModel } : {}),
        source: globalRow ? ("global" as const) : ("env" as const),
      },
      200
    );
  });
}
