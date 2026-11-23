/**
 * Key Management API — P7
 *
 * POST   /admin/keys                — create a new API key (scoped mk_live_/mk_test_)
 * GET    /admin/keys                — list all keys for workspace (secrets masked)
 * DELETE /admin/keys/:keyId         — revoke a key
 * GET    /admin/keys/:keyId         — show a single key's metadata (no secret)
 * POST   /admin/keys/:keyId/rotate  — rotate a key with 7-day grace window
 * GET    /me                        — introspect the current authenticated key (P13)
 *
 * All routes require scope `admin:keys`.
 */

import { randomBytes } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import bcrypt from "bcrypt";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { BadRequestError, ForbiddenError } from "../errors.js";
import { toIso } from "../schemas.js";
import { forgetKeyAuth } from "../auth-cache-registry.js";
import { DEPRECATION_GRACE_MS } from "../auth-evaluate.js";
import { getUserPersonalWorkspaceId } from "../recall/multi-level.js";
import { BCRYPT_COST, computeLookupHash, generateKeySecret } from "./_key-secret.js";
import { ceilingBeyondCaller, KNOWN_SCOPES, scopesBeyondCaller } from "./_user-token.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

// Wrap key-management queries in a postgres.js transaction with the workspace
// GUCs set so FORCE RLS on mnemo_api_keys applies correctly.
// Uses sql.begin() (postgres.js native) rather than withMnemoTx (Drizzle) since
// keys.ts operates on the raw metricsPgClient, not a Drizzle instance.
function withKeysTx<T>(
  pgSql: import("postgres").Sql,
  workspaceId: string,
  fn: (tx: import("postgres").TransactionSql) => Promise<T>,
  opts?: { userId?: string | null; tenantId?: string | null }
): Promise<T> {
  return pgSql.begin(async (tx) => {
    // Always downgrade to app_user so FORCE RLS on mnemo_api_keys activates.
    // Mirrors withMnemoTx behavior. If the pool connection is not a member of
    // app_user the SET LOCAL will throw, surfacing the misconfiguration loudly
    // rather than silently skipping RLS enforcement.
    await tx`SET LOCAL ROLE app_user`;
    await tx`SET LOCAL search_path TO mnemosyne, public`;
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`;
    if (opts?.userId) {
      await tx`SELECT set_config('mnemosyne.actor_user_id', ${opts.userId}, true)`;
    }
    if (opts?.tenantId) {
      await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${opts.tenantId}, true)`;
    }
    return fn(tx);
  }) as Promise<T>;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const KeyListItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    plan: z.string(),
    ipAllowlist: z.array(z.string()),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    deprecatedAt: z.iso.datetime().nullable().openapi({
      description: "When the key was rotated. Null for a key that was never rotated.",
    }),
    sunsetAt: z.iso.datetime().nullable().openapi({
      description:
        "When a rotated key stops working (rotation + 7 days). Null for a key that was never rotated.",
    }),
    maxSensitivity: z.string().nullable().optional(),
  })
  .openapi("ApiKeyListItem");

const CreateKeyBodySchema = z
  .object({
    label: z.string().min(1).max(80).openapi({ description: "Human-readable label for this key" }),
    scopes: z
      .array(z.string())
      .min(1)
      .openapi({
        description: "Permission scopes for this key",
        example: ["memory:read", "memory:write"],
      }),
    expiresIn: z
      .string()
      .regex(/^\d+[dhm]$/)
      .optional()
      .openapi({ description: "TTL: 30d, 8h, 60m", example: "30d" }),
    ipAllowlist: z
      .array(z.string())
      .optional()
      .openapi({ description: "CIDR ranges allowed for this key", example: ["10.0.0.0/8"] }),
    plan: z.enum(["free", "pro", "enterprise"]).optional().default("free"),
    test: z
      .boolean()
      .optional()
      .default(false)
      .openapi({ description: "Use mk_test_ prefix (isolated from production)" }),
    maxSensitivity: z
      .enum(["public", "internal", "confidential", "restricted"])
      .optional()
      .openapi({
        description:
          "Per-key sensitivity ceiling. NULL = no per-key restriction (workspace ceiling applies).",
      }),
    federation: z.boolean().optional().default(false).openapi({
      description:
        'Issue an mk_fed_ key, the bearer a federation peer pulls from this server with (give it to that peer). Scopes must be exactly ["memory:federation"].',
    }),
    keyKind: z
      .enum(["workspace", "user", "tenant", "admin"])
      .optional()
      .default("workspace")
      .openapi({
        description: "Key kind: workspace (single workspace) or user (multi-workspace user token).",
      }),
  })
  .openapi("CreateApiKeyBody");

const CreateKeyResponseSchema = z
  .object({
    id: z.string(),
    key: z.string().openapi({ description: "Full API key — shown ONCE, never retrievable again" }),
    label: z.string(),
    scopes: z.array(z.string()),
    plan: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    maxSensitivity: z.string().nullable().optional(),
  })
  .openapi("CreateApiKeyResponse");

const MeResponseSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string().nullable(),
    keyId: z.string().openapi({
      description:
        "The authenticating API key's own row id (mnemo_api_keys.id) — the credential, " +
        "NOT reliably a userId. Use `userId` below for the platform account, when present. " +
        "Named `actorId` before this field; renamed for accuracy (pre-1.0, no alias).",
    }),
    actorType: z.enum(["agent", "user", "system", "federation"]).openapi({
      description: "What kind of principal this key authenticates as.",
    }),
    scopes: z.array(z.string()),
    plan: z.string(),
    keyPrefix: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    ipAllowlist: z.array(z.string()),
    userId: z
      .string()
      .nullable()
      .openapi({ description: "User ID bound to this key. Null for workspace-only keys." }),
    personalWorkspaceId: z.string().nullable().openapi({
      description:
        "UUID of the user's personal workspace. Null when userId is absent or personal workspace is not yet created.",
    }),
    personalFactsLive: z.number().int().nullable().openapi({
      description:
        "Count of active facts in the personal workspace. Null when personal workspace is unavailable.",
    }),
    tenantId: z.string().nullable().openapi({
      description:
        "Tenant ID bound to this key. Null for keys with no tenant binding. Used by GET /tenants/:tenantId/workspaces (memory_workspace's tenant-fallback listing).",
    }),
    workspaceRole: z.string().nullable().openapi({
      description:
        "Caller's membership role in the current workspace (owner/admin/write/read), when resolvable. Null for keys with no user binding, or when the user has no membership row for this workspace (narrowing degrades to the key's own static scopes in that case — see `effectiveScopes`).",
    }),
    effectiveScopes: z.array(z.string()).openapi({
      description:
        "Same value as `scopes` — named explicitly so a caller doesn't need to know that `scopes` is already the workspace-role-narrowed set, not the key's raw static scope list.",
    }),
  })
  .openapi("MeResponse");

const KeyDetailSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    scopes: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    deprecatedAt: z.iso.datetime().nullable(),
    rotatedFromId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    maxSensitivity: z.string().nullable().optional(),
  })
  .openapi("KeyDetailResponse");

const RotateKeyResponseSchema = z
  .object({
    newKey: z
      .string()
      .openapi({ description: "Full plaintext new key — shown ONCE, never retrievable again" }),
    newKeyId: z.string(),
    oldKeySunsetAt: z.iso.datetime().openapi({
      description: "ISO timestamp — old key remains valid until this date (7 days grace)",
    }),
  })
  .openapi("RotateKeyResponse");

// ─── Route definitions ────────────────────────────────────────────────────────

const createKeyRoute = createRoute({
  method: "post",
  path: "/admin/keys",
  tags: ["keys"],
  summary: "Create a new API key for the current workspace.",
  request: {
    body: {
      content: { "application/json": { schema: CreateKeyBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Key created. The `key` field is shown once — store it immediately.",
      content: { "application/json": { schema: CreateKeyResponseSchema } },
    },
    400: { description: "Invalid request body, or a scope that does not exist." },
    403: {
      description:
        "Insufficient scope (admin:keys required), or the request grants a scope or sensitivity ceiling the caller does not hold.",
    },
  },
});

const listKeysRoute = createRoute({
  method: "get",
  path: "/admin/keys",
  tags: ["keys"],
  summary: "List all API keys for the current workspace (secrets masked).",
  request: {
    query: z.object({
      expired: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "When 'true', return only expired keys (exclusive filter)." }),
    }),
  },
  responses: {
    200: {
      description: "Key list.",
      content: { "application/json": { schema: z.object({ keys: z.array(KeyListItemSchema) }) } },
    },
  },
});

const revokeKeyRoute = createRoute({
  method: "delete",
  path: "/admin/keys/:keyId",
  tags: ["keys"],
  summary: "Revoke an API key.",
  request: { params: z.object({ keyId: z.string() }) },
  responses: {
    200: {
      description: "Key revoked.",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), revokedAt: z.iso.datetime() }),
        },
      },
    },
    404: { description: "Key not found or already revoked." },
  },
});

const showKeyRoute = createRoute({
  method: "get",
  path: "/admin/keys/:keyId",
  tags: ["keys"],
  summary: "Retrieve full metadata for a single API key (no secret).",
  request: { params: z.object({ keyId: z.string() }) },
  responses: {
    200: {
      description: "Key metadata.",
      content: { "application/json": { schema: KeyDetailSchema } },
    },
    403: { description: "Insufficient scope (admin:keys required)." },
    404: { description: "Key not found or belongs to a different workspace." },
  },
});

const rotateKeyRoute = createRoute({
  method: "post",
  path: "/admin/keys/:keyId/rotate",
  tags: ["keys"],
  summary: "Rotate an API key. The old key remains valid for 7 days.",
  request: {
    params: z.object({ keyId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().optional() }).openapi("RotateKeyBody"),
        },
      },
      required: false,
    },
  },
  responses: {
    201: {
      description: "New key created. Old key valid until `oldKeySunsetAt`.",
      content: { "application/json": { schema: RotateKeyResponseSchema } },
    },
    400: { description: "Invalid request." },
    403: {
      description:
        "Insufficient scope (admin:keys required), or the key holds a scope or ceiling the caller does not.",
    },
    404: { description: "Key not found." },
    409: { description: "Key is already revoked or deprecated and cannot be rotated." },
    422: { description: "Key is expired and cannot be rotated." },
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["auth"],
  summary: "Introspect the current authenticated key — workspace, scopes, plan, TTL.",
  responses: {
    200: {
      description: "Current key identity.",
      content: { "application/json": { schema: MeResponseSchema } },
    },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// SEC-1 / AUTH-ADMIN-KEYS-SUBSET. A key-management call may only hand out
// authority its caller already holds. Both the create and the rotate handler
// return a fresh plaintext secret, so both are minting: create with the scopes
// in the body, rotate with the scopes of the key being rotated. Before this,
// a `memory:read + admin:keys` key minted a `memory:hard_delete` key that then
// physically deleted a fact its creator was refused; rotating the owner's key
// gave the same result by another door. `POST /tenants/:t/users/:u/tokens`
// already enforced this (user-tokens.ts).
// The helpers (KNOWN_SCOPES, scopesBeyondCaller, ceilingBeyondCaller) are
// shared with the user-token routes: routes/_user-token.ts.

/**
 * The scopes a caller may put into a key it mints or rotates. A dashboard
 * password session (actorRefKind "user") holds `admin:workspace` only while its
 * user is a superadmin right now (resolveLiveSession). A key outlives that
 * status and is never re-checked against it, so a session never passes the
 * scope on: a revoked superadmin would keep installation-wide authority
 * (PUT /admin/config/llm, /admin/retention) through the key.
 */
export function mintableCallerScopes(
  c: Context<{ Variables: AuthVariables }>,
  held: Iterable<string>
): string[] {
  const scopes = [...held];
  return c.get("actorRefKind") === "user" ? scopes.filter((s) => s !== "admin:workspace") : scopes;
}

function parseTtl(expiresIn: string): Date {
  const n = parseInt(expiresIn.slice(0, -1), 10);
  const unit = expiresIn.slice(-1);
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() + n * (msMap[unit] ?? 86_400_000));
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountKeys(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  const sql = deps.metricsPgClient;

  // GET /me — key introspection (P13)
  app.openapi(meRoute, async (c) => {
    const { workspaceId, actorId: rawKeyId, actorType, scopes, userId: ctxUserId } = getAuthCtx(c);
    const keyId = rawKeyId ?? "unknown";
    const plan = c.get("plan") ?? "free";

    // Derive prefix from the key's own row id (auth.ts's `actorId`, renamed
    // `keyId` on this response — it's the credential's id, not a userId).
    let expiresAt: string | null = null;
    let ipAllowlist: string[] = [];
    let keyPrefix = "unknown";

    let workspaceName: string | null = null;
    let resolvedUserId: string | null = ctxUserId ?? null;

    if (sql && keyId !== "unknown") {
      try {
        type KeyRow = {
          expires_at: string | null;
          ip_allowlist: string[] | null;
          id: string;
          workspace_name: string | null;
          user_id: string | null;
        };
        const rows = await withKeysTx(
          sql,
          workspaceId,
          (tx) =>
            tx<KeyRow[]>`
              SELECT k.id, k.expires_at::text, k.ip_allowlist,
                     w.name AS workspace_name,
                     k.user_id
              FROM mnemo_api_keys k
              LEFT JOIN mnemo_workspace w ON w.id = k.workspace_id
              WHERE k.id = ${keyId} AND k.workspace_id = ${workspaceId}
              LIMIT 1
            `,
          { userId: ctxUserId, tenantId: c.get("tenantId") }
        );
        if (rows[0]) {
          expiresAt = toIso(rows[0].expires_at);
          ipAllowlist = rows[0].ip_allowlist ?? [];
          workspaceName = rows[0].workspace_name ?? null;
          // Prefer DB-sourced userId over auth context (auth middleware may not populate it)
          if (rows[0].user_id) resolvedUserId = rows[0].user_id;
        }
      } catch {
        /* best effort */
      }
    }

    // Infer prefix from keyId naming convention (bootstrap_xxx → mns_live_, etc.)
    if (keyId.startsWith("bootstrap_")) keyPrefix = "mns_live_";
    else if (keyId.startsWith("mk_test")) keyPrefix = "mk_test_";
    else if (keyId.startsWith("mk_fed_")) keyPrefix = "mk_fed_";
    else if (keyId.startsWith("mk_")) keyPrefix = "mk_live_";
    else keyPrefix = "mns_live_";

    // Resolve personal workspace ID when userId is known (P10)
    let personalWorkspaceId: string | null = null;
    if (sql && resolvedUserId) {
      personalWorkspaceId = await getUserPersonalWorkspaceId(sql, resolvedUserId).catch(() => null);
    }

    // Fetch live fact count for personal workspace (REQ-P10-006).
    // flatten-legacy-dual-core PR12: ported off the legacy core's vitals()
    // onto the v3 StorageAdapter port (getWorkspaceVitals, added in PR6) —
    // same aggregate query, now implemented in adapter-postgres's
    // FactRepository. `deps.storage` is optional on `ServerDeps` (unlike the
    // the legacy required `core` field was), so this degrades to null
    // exactly like the pre-existing `.catch(() => null)` best-effort branch
    // already did.
    let personalFactsLive: number | null = null;
    if (personalWorkspaceId && deps.storage) {
      const vitals = await deps.storage.getWorkspaceVitals(personalWorkspaceId).catch(() => null);
      personalFactsLive = vitals?.factsLive ?? null;
    }

    return c.json(
      {
        workspaceId,
        workspaceName,
        keyId,
        actorType: actorType ?? "agent",
        scopes: Array.from(scopes),
        plan,
        keyPrefix,
        expiresAt,
        ipAllowlist,
        userId: resolvedUserId,
        personalWorkspaceId,
        personalFactsLive,
        tenantId: c.get("tenantId") ?? null,
        // `scopes` above is already narrowed by workspace role (auth.ts S4) —
        // `effectiveScopes` restates it under a self-documenting name so a
        // caller doesn't have to know that internal detail to trust it.
        workspaceRole: c.get("workspaceRole") ?? null,
        effectiveScopes: Array.from(scopes),
      },
      200
    );
  });

  if (!sql) return; // remaining routes need DB access

  // POST /admin/keys
  app.openapi(createKeyRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const userId = c.get("userId") ?? null;
    const tenantId = c.get("tenantId") ?? null;
    const body = c.req.valid("json");
    const { scopes: callerScopes, maxSensitivity: callerCeiling } = getAuthCtx(c);

    // SEC-1: validate before any bcrypt work or INSERT. An unknown string
    // (`*`, `root`, `memory:*`) is not a scope; storing it was not inert —
    // /admin/harness/quiesce honours `*`.
    const unknownScopes = body.scopes.filter((s) => !KNOWN_SCOPES.has(s));
    if (unknownScopes.length > 0) {
      throw new BadRequestError(`Unknown scope(s): ${unknownScopes.join(", ")}`, {
        code: "unknown_scope",
        unknown: unknownScopes,
      });
    }
    const disallowed = scopesBeyondCaller(body.scopes, mintableCallerScopes(c, callerScopes));
    if (disallowed.length > 0) {
      throw new ForbiddenError(
        `Cannot grant scopes the caller doesn't have: ${disallowed.join(", ")}`,
        { disallowed }
      );
    }
    // A capped caller that names no ceiling gets its own cap, not an uncapped key.
    const maxSensitivity = body.maxSensitivity ?? callerCeiling ?? null;
    if (ceilingBeyondCaller(maxSensitivity, callerCeiling)) {
      throw new ForbiddenError(
        `Cannot grant a sensitivity ceiling above the caller's own (${callerCeiling})`,
        { requested: maxSensitivity, callerCeiling }
      );
    }

    // A federation key is only ever a peer's pull credential: one scope, a
    // workspace key, never a test key (the peer gate requires the mk_fed_ class).
    if (
      body.federation &&
      (body.scopes.length !== 1 ||
        body.scopes[0] !== "memory:federation" ||
        body.keyKind !== "workspace" ||
        body.test)
    ) {
      throw new BadRequestError(
        'A federation key holds exactly ["memory:federation"] and is a workspace, non-test key',
        undefined,
        "federation"
      );
    }
    const isUserToken = body.keyKind === "user";
    const prefix = body.federation
      ? "mk_fed"
      : isUserToken
        ? body.test
          ? "uk_test"
          : "uk_live"
        : body.test
          ? "mk_test"
          : "mk_live";
    const plainKey = generateKeySecret(prefix);
    const keyHash = await bcrypt.hash(plainKey, BCRYPT_COST);
    const lookupHash = computeLookupHash(plainKey);
    const keyId = isUserToken
      ? `uk_${randomBytes(8).toString("hex")}`
      : body.federation
        ? `mk_fed_${randomBytes(8).toString("hex")}`
        : `mk_${randomBytes(8).toString("hex")}`;
    const now = new Date();
    const expiresAt = body.expiresIn ? parseTtl(body.expiresIn) : null;
    const nowIso = now.toISOString();
    const expiresAtIso = expiresAt?.toISOString() ?? null;

    await withKeysTx(
      sql,
      workspaceId,
      (tx) =>
        tx`
        INSERT INTO mnemo_api_keys
          (id, workspace_id, user_id, tenant_id, key_kind, key_hash, lookup_hash, name, label, scopes, plan, ip_allowlist, expires_at, max_sensitivity, created_at)
        VALUES (
          ${keyId},
          ${workspaceId},
          ${userId},
          ${tenantId},
          ${body.keyKind ?? "workspace"},
          ${keyHash},
          ${lookupHash},
          ${body.label},
          ${body.label},
          ${tx.array(body.scopes)},
          ${body.plan},
          ${tx.array(body.ipAllowlist ?? [])},
          ${expiresAtIso},
          ${maxSensitivity},
          ${nowIso}
        )
      `
    );

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "key_create",
      resourceKind: "api_key",
      resourceId: keyId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        label: body.label,
        scopes: body.scopes,
        keyKind: body.keyKind ?? "workspace",
        plan: body.plan,
        expiresAt: expiresAtIso,
      },
    });

    return c.json(
      {
        id: keyId,
        key: plainKey,
        label: body.label,
        scopes: body.scopes,
        plan: body.plan,
        expiresAt: expiresAtIso,
        createdAt: nowIso,
        maxSensitivity,
      },
      201
    );
  });

  // GET /admin/keys
  app.openapi(listKeysRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const expiredParam = c.req.query("expired");
    const onlyExpired = expiredParam === "true";

    type KeyRow = {
      id: string;
      label: string;
      name: string;
      scopes: string[];
      plan: string;
      ip_allowlist: string[] | null;
      expires_at: string | null;
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
      deprecated_at: string | null;
      max_sensitivity: string | null;
    };

    const rows = onlyExpired
      ? await withKeysTx(
          sql,
          workspaceId,
          (tx) =>
            tx<KeyRow[]>`
            SELECT id, label, name, scopes, plan, ip_allowlist,
                   expires_at::text, created_at::text, last_used_at::text, revoked_at::text,
                   deprecated_at::text, max_sensitivity
            FROM mnemo_api_keys
            WHERE workspace_id = ${workspaceId}
              AND expires_at IS NOT NULL
              AND expires_at < now()
              AND revoked_at IS NULL
            ORDER BY created_at DESC
          `
        )
      : await withKeysTx(
          sql,
          workspaceId,
          (tx) =>
            tx<KeyRow[]>`
            SELECT id, label, name, scopes, plan, ip_allowlist,
                   expires_at::text, created_at::text, last_used_at::text, revoked_at::text,
                   deprecated_at::text, max_sensitivity
            FROM mnemo_api_keys
            WHERE workspace_id = ${workspaceId}
              AND (expires_at IS NULL OR expires_at >= now())
              AND revoked_at IS NULL
            ORDER BY created_at DESC
          `
        );

    const keys = rows.map((r) => ({
      id: r.id,
      label: r.label ?? "",
      name: r.name ?? r.label ?? r.id,
      prefix: r.id.startsWith("mk_test")
        ? "mk_test_"
        : r.id.startsWith("mk_fed_")
          ? "mk_fed_"
          : r.id.startsWith("mk_")
            ? "mk_live_"
            : "mns_live_",
      scopes: r.scopes ?? [],
      plan: r.plan ?? "free",
      ipAllowlist: r.ip_allowlist ?? [],
      expiresAt: toIso(r.expires_at),
      createdAt: toIso(r.created_at) ?? r.created_at,
      lastUsedAt: toIso(r.last_used_at),
      revokedAt: toIso(r.revoked_at),
      deprecatedAt: toIso(r.deprecated_at),
      sunsetAt: r.deprecated_at
        ? new Date(Date.parse(toIso(r.deprecated_at)!) + DEPRECATION_GRACE_MS).toISOString()
        : null,
      maxSensitivity: r.max_sensitivity ?? null,
    }));

    return c.json({ keys }, 200);
  });

  // DELETE /admin/keys/:keyId
  app.openapi(revokeKeyRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { keyId } = c.req.valid("param");
    const revokedAt = new Date();
    const revokedAtIso = revokedAt.toISOString();

    type UpdateResult = { id: string };
    const rows = await withKeysTx(
      sql,
      workspaceId,
      (tx) =>
        tx<UpdateResult[]>`
        UPDATE mnemo_api_keys
        SET revoked_at = ${revokedAtIso}
        WHERE id = ${keyId}
          AND workspace_id = ${workspaceId}
          AND revoked_at IS NULL
        RETURNING id
      `
    );

    if (!rows[0]) {
      return c.json(
        { error: "not_found", message: "Key not found or already revoked" } as never,
        404
      );
    }
    // Committed. The auth middleware caches a verified token for 60 s: without
    // this the revoked key would keep working until that entry expired.
    forgetKeyAuth(keyId);

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "key_revoke",
      resourceKind: "api_key",
      resourceId: keyId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        revokedAt: revokedAtIso,
      },
    });

    return c.json({ ok: true, revokedAt: revokedAtIso }, 200);
  });

  // GET /admin/keys/:keyId
  app.openapi(showKeyRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { keyId } = c.req.valid("param");

    type KeyRow = {
      id: string;
      label: string;
      scopes: string[];
      ip_allowlist: string[] | null;
      expires_at: string | null;
      last_used_at: string | null;
      revoked_at: string | null;
      deprecated_at: string | null;
      rotated_from_id: string | null;
      created_at: string;
      max_sensitivity: string | null;
    };

    const rows = await withKeysTx(
      sql,
      workspaceId,
      (tx) =>
        tx<KeyRow[]>`
        SELECT id, label, scopes, ip_allowlist,
               expires_at::text, last_used_at::text, revoked_at::text,
               deprecated_at::text, rotated_from_id, created_at::text,
               max_sensitivity
        FROM mnemo_api_keys
        WHERE id = ${keyId}
          AND workspace_id = ${workspaceId}
        LIMIT 1
      `
    );

    if (!rows[0]) {
      return c.json({ error: "not_found", message: "Key not found" } as never, 404);
    }

    const r = rows[0];
    return c.json(
      {
        id: r.id,
        label: r.label ?? "",
        scopes: r.scopes ?? [],
        ipAllowlist: r.ip_allowlist ?? [],
        expiresAt: toIso(r.expires_at),
        lastUsedAt: toIso(r.last_used_at),
        revokedAt: toIso(r.revoked_at),
        deprecatedAt: toIso(r.deprecated_at),
        rotatedFromId: r.rotated_from_id ?? null,
        createdAt: toIso(r.created_at) ?? r.created_at,
        maxSensitivity: r.max_sensitivity ?? null,
      },
      200
    );
  });

  // POST /admin/keys/:keyId/rotate
  app.openapi(rotateKeyRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { keyId } = c.req.valid("param");
    const { scopes: callerScopes, maxSensitivity: callerCeiling } = getAuthCtx(c);

    type KeyRow = {
      id: string;
      label: string;
      scopes: string[];
      plan: string;
      ip_allowlist: string[] | null;
      expires_at: string | null;
      revoked_at: string | null;
      deprecated_at: string | null;
      max_sensitivity: string | null;
      user_id: string | null;
      tenant_id: string | null;
      key_kind: string | null;
    };

    const now = new Date();
    const nowIso = now.toISOString();
    // The old key works until deprecated_at + DEPRECATION_GRACE_MS (auth-evaluate.ts),
    // so deprecated_at is the rotation time, not the sunset: storing the sunset
    // there made rotated keys last 14 days while the response promised 7.
    const sunset = new Date(now.getTime() + DEPRECATION_GRACE_MS);
    const sunsetIso = sunset.toISOString();

    type RotateResult =
      | { ok: true; newKeyId: string; plainKey: string }
      | { ok: false; code: 403 | 404 | 409 | 422; error: string; message: string };

    let generatedPlainKey = "";
    let generatedNewKeyId = "";

    const result = await withKeysTx(sql, workspaceId, async (tx) => {
      const rows = await tx<KeyRow[]>`
        SELECT id, label, scopes, plan, ip_allowlist,
               expires_at::text, revoked_at::text, deprecated_at::text, max_sensitivity,
               user_id, tenant_id, key_kind
        FROM mnemo_api_keys
        WHERE id = ${keyId}
          AND workspace_id = ${workspaceId}
        LIMIT 1
      `;

      if (!rows[0]) {
        return {
          ok: false,
          code: 404,
          error: "not_found",
          message: "Key not found",
        } as RotateResult;
      }

      const old = rows[0];

      if (old.revoked_at) {
        return {
          ok: false,
          code: 409,
          error: "key_revoked",
          message: "Key is already revoked and cannot be rotated",
        } as RotateResult;
      }
      if (old.deprecated_at) {
        return {
          ok: false,
          code: 409,
          error: "key_deprecated",
          message: "Key has already been rotated and cannot be rotated again",
        } as RotateResult;
      }
      if (old.expires_at && new Date(old.expires_at) < now) {
        return {
          ok: false,
          code: 422,
          error: "key_expired",
          message: "Key is expired and cannot be rotated",
        } as RotateResult;
      }
      // SEC-1: the response carries a new plaintext secret with the OLD key's
      // scopes and ceiling — rotating is minting, so the same subset rule holds.
      const beyond = scopesBeyondCaller(old.scopes ?? [], mintableCallerScopes(c, callerScopes));
      if (beyond.length > 0 || ceilingBeyondCaller(old.max_sensitivity ?? null, callerCeiling)) {
        return {
          ok: false,
          code: 403,
          error: "forbidden",
          message:
            beyond.length > 0
              ? `Cannot rotate a key holding scopes the caller doesn't have: ${beyond.join(", ")}`
              : "Cannot rotate a key whose sensitivity ceiling is above the caller's own",
        } as RotateResult;
      }

      const isUserToken = old.key_kind === "user" || keyId.startsWith("uk_");
      const isTest = keyId.includes("_test_");
      // A federation key rotates into another federation key.
      const isFederation = keyId.startsWith("mk_fed_");
      const prefix = isFederation
        ? "mk_fed"
        : isUserToken
          ? isTest
            ? "uk_test"
            : "uk_live"
          : isTest
            ? "mk_test"
            : "mk_live";
      const plainKey = generateKeySecret(prefix);
      const keyHash = await bcrypt.hash(plainKey, BCRYPT_COST);
      const lookupHash = computeLookupHash(plainKey);
      const newKeyId = isUserToken
        ? `uk_${randomBytes(8).toString("hex")}`
        : isFederation
          ? `mk_fed_${randomBytes(8).toString("hex")}`
          : `mk_${randomBytes(8).toString("hex")}`;
      generatedPlainKey = plainKey;
      generatedNewKeyId = newKeyId;

      // INSERT new key (before deprecating old — overlap safety)
      // Carry user_id, tenant_id, key_kind and max_sensitivity forward.
      await tx`
        INSERT INTO mnemo_api_keys
          (id, workspace_id, user_id, tenant_id, key_kind, key_hash, lookup_hash, name, label, scopes, plan, ip_allowlist, max_sensitivity, rotated_from_id, created_at)
        VALUES (
          ${newKeyId},
          ${workspaceId},
          ${old.user_id ?? null},
          ${old.tenant_id ?? null},
          ${old.key_kind ?? (isUserToken ? "user" : "workspace")},
          ${keyHash},
          ${lookupHash},
          ${old.label},
          ${old.label},
          ${tx.array(old.scopes ?? [])},
          ${old.plan ?? "free"},
          ${tx.array(old.ip_allowlist ?? [])},
          ${old.max_sensitivity ?? null},
          ${keyId},
          ${nowIso}
        )
      `;

      // Deprecate (sunset) the old key
      await tx`
        UPDATE mnemo_api_keys
        SET deprecated_at = ${nowIso}
        WHERE id = ${keyId}
          AND workspace_id = ${workspaceId}
      `;

      return { ok: true, newKeyId: generatedNewKeyId, plainKey: generatedPlainKey } as RotateResult;
    });

    if (!result.ok) {
      return c.json({ error: result.error, message: result.message } as never, result.code);
    }
    // The old key is now deprecated: drop its cached token so its next request
    // reads the deprecation (and its sunset) from the database.
    forgetKeyAuth(keyId);

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "key_rotate",
      resourceKind: "api_key",
      resourceId: generatedNewKeyId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        rotatedFromId: keyId,
        oldKeySunsetAt: sunsetIso,
      },
    });

    return c.json(
      {
        newKey: generatedPlainKey,
        newKeyId: generatedNewKeyId,
        oldKeySunsetAt: sunsetIso,
      },
      201
    );
  });
}
