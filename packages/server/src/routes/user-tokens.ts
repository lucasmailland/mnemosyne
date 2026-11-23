/**
 * User-token provisioning API (S6, multi-tenancy closure plan).
 *
 * POST   /tenants/:tenantId/users/:userId/tokens          — mint a uk_live_*
 *          token bound to a SPECIFIC OTHER user (not the caller).
 * GET    /tenants/:tenantId/users/:userId/tokens          — list that user's
 *          tokens (secrets masked).
 * DELETE /tenants/:tenantId/users/:userId/tokens/:keyId   — revoke one.
 *
 * All three require the caller to be an owner/admin of `tenantId`
 * (`requireTenantAdmin`, reused as-is from tenants.ts).
 *
 * Deliberately NOT an extension of `POST /admin/keys`:
 *   - That route requires only `admin:keys`, which under the workspace-role
 *     scope narrowing (S1/S4) a plain workspace admin can hold — letting it
 *     mint a token for an arbitrary tenant member would be a privilege
 *     escalation the narrowing feature itself would introduce. Minting a
 *     credential for a THIRD PARTY is a tenant-plane action; it belongs
 *     behind `admin:tenant`, which `/tenants/*` already resolves to
 *     (`app-scope.ts`).
 *   - It also runs under the wrong RLS transaction: `withKeysTx` pins the
 *     GUCs to the CALLER's own workspace, but the target user's home
 *     workspace may be a different one entirely.
 *
 * Validation order (each step anti-probes — 404s that don't distinguish
 * "doesn't exist" from "not authorized to know" per CLAUDE.md S6):
 *   0. every requested scope exists (400 otherwise, like a schema error)
 *   1. caller is tenant owner/admin (requireTenantAdmin)
 *   2. target user is a member of this tenant (404 if not)
 *   3. the given home workspace belongs to this tenant (404 if not)
 *   4. target user is a member of that home workspace (400 — this one DOES
 *      distinguish, since the fix is actionable: invite them to the
 *      workspace first via POST /workspaces/:id/members)
 *   5. requested scopes (if any) are a subset of the CALLER's own scopes —
 *      a tenant admin can never mint a token more powerful than themselves.
 *   6. the token's sensitivity ceiling is not above the caller's; a capped
 *      caller that names none mints its own cap (SEC-1, the rule WP-11 put
 *      on POST /admin/keys).
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toIso } from "../schemas.js";
import { forgetKeyAuth } from "../auth-cache-registry.js";
import { withTenantRls, requireTenantAdmin } from "./tenants.js";
import {
  ceilingBeyondCaller,
  insertUserToken,
  KNOWN_SCOPES,
  scopesBeyondCaller,
} from "./_user-token.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string(), message: z.string() }).openapi("UserTokenError");

const CreateUserTokenBodySchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(80)
      .openapi({ description: "Human-readable label for this token." }),
    homeWorkspaceId: z.string().openapi({
      description:
        "The workspace this token resolves to by default (must be in the same tenant, and the target user must already be a member of it).",
    }),
    scopes: z.array(z.string()).optional().openapi({
      description:
        "Explicit scopes to grant. Must be a subset of the CALLER's own scopes. Omit to default to the target user's workspace-role-narrowed scope set for homeWorkspaceId.",
    }),
    expiresIn: z
      .string()
      .regex(/^\d+[dhm]$/)
      .optional()
      .openapi({ description: "TTL: 30d, 8h, 60m", example: "90d" }),
    ipAllowlist: z.array(z.string()).optional(),
    maxSensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
    test: z.boolean().optional().default(false).openapi({ description: "Use uk_test_ prefix." }),
  })
  .openapi("CreateUserTokenBody");

const CreateUserTokenResponseSchema = z
  .object({
    id: z.string(),
    key: z
      .string()
      .openapi({ description: "Full plaintext token — shown ONCE, never retrievable again." }),
    label: z.string(),
    scopes: z.array(z.string()),
    userId: z.string(),
    tenantId: z.string(),
    workspaceId: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("CreateUserTokenResponse");

const UserTokenListItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    scopes: z.array(z.string()),
    workspaceId: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("UserTokenListItem");

// ─── Routes ───────────────────────────────────────────────────────────────────

const createUserTokenRoute = createRoute({
  method: "post",
  path: "/tenants/{tenantId}/users/{userId}/tokens",
  tags: ["tenants", "tokens"],
  summary: "Mint a uk_live_* user token for another member of this tenant.",
  request: {
    params: z.object({ tenantId: z.string(), userId: z.string() }),
    body: {
      content: { "application/json": { schema: CreateUserTokenBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Token created.",
      content: { "application/json": { schema: CreateUserTokenResponseSchema } },
    },
    400: {
      description:
        "Target user is not a member of the given home workspace, or a requested scope does not exist.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description:
        "Caller is not a tenant owner/admin, or the token would carry a scope or sensitivity ceiling beyond the caller's own.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description:
        "Tenant not found, target user not a tenant member, or workspace not in this tenant.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listUserTokensRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/users/{userId}/tokens",
  tags: ["tenants", "tokens"],
  summary: "List a tenant member's user tokens (secrets masked).",
  request: { params: z.object({ tenantId: z.string(), userId: z.string() }) },
  responses: {
    200: {
      description: "Token list.",
      content: {
        "application/json": { schema: z.object({ tokens: z.array(UserTokenListItemSchema) }) },
      },
    },
    403: {
      description: "Caller is not a tenant owner/admin.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Tenant not found or target user not a tenant member.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const revokeUserTokenRoute = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/users/{userId}/tokens/{keyId}",
  tags: ["tenants", "tokens"],
  summary: "Revoke a user token.",
  request: { params: z.object({ tenantId: z.string(), userId: z.string(), keyId: z.string() }) },
  responses: {
    200: {
      description: "Token revoked.",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), revokedAt: z.iso.datetime() }),
        },
      },
    },
    403: {
      description: "Caller is not a tenant owner/admin.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Token not found, already revoked, or belongs to a different user/tenant.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountUserTokens(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const pgSql = deps.metricsPgClient;
  if (!pgSql) return; // no DB client — skip

  app.openapi(createUserTokenRoute, async (c) => {
    const { tenantId, userId: targetUserId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { scopes: callerScopes, maxSensitivity: callerCeiling } = getAuthCtx(c);

    // SEC-1: `*`, `root`, `memory:*` are not scopes, and storing one is not
    // inert (/admin/harness/quiesce honours `*`), even when the caller's own
    // legacy key holds it.
    const unknownScopes = (body.scopes ?? []).filter((s) => !KNOWN_SCOPES.has(s));
    if (unknownScopes.length > 0) {
      return c.json(
        {
          error: "bad_request",
          message: `Unknown scope(s): ${unknownScopes.join(", ")}`,
        } as never,
        400
      );
    }

    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAdmin(repo, tx, c, tenantId);

      const targetTenantRole = await repo.getTenantMemberRole(tenantId, targetUserId);
      if (targetTenantRole === null) {
        return c.json(
          { error: "not_found", message: "Target user is not a member of this tenant" } as never,
          404
        );
      }

      const workspace = await repo.getWorkspace(body.homeWorkspaceId);
      if (!workspace || workspace.tenantId !== tenantId) {
        return c.json(
          {
            error: "not_found",
            message: "homeWorkspaceId does not belong to this tenant",
          } as never,
          404
        );
      }

      const targetWorkspaceRole = await repo.getWorkspaceMemberRole(
        body.homeWorkspaceId,
        targetUserId
      );
      if (targetWorkspaceRole === null) {
        return c.json(
          {
            error: "bad_request",
            message:
              "Target user is not a member of homeWorkspaceId — add them via POST /workspaces/:id/members first",
          } as never,
          400
        );
      }

      // The caller's scopes are role-narrowed by auth.ts, an array on most
      // paths and a Set on some, so they are read as an iterable.
      const heldScopes = new Set<string>(callerScopes);
      const requestedScopes = body.scopes ?? [...heldScopes].filter((s) => KNOWN_SCOPES.has(s));
      const disallowed = scopesBeyondCaller(requestedScopes, heldScopes);
      if (disallowed.length > 0) {
        return c.json(
          {
            error: "forbidden",
            message: `Cannot grant scopes the caller doesn't have: ${disallowed.join(", ")}`,
          } as never,
          403
        );
      }
      // A capped caller that names no ceiling gets its own cap, not an uncapped token.
      const maxSensitivity = body.maxSensitivity ?? callerCeiling ?? null;
      if (ceilingBeyondCaller(maxSensitivity, callerCeiling)) {
        return c.json(
          {
            error: "forbidden",
            message: `Cannot grant a sensitivity ceiling above the caller's own (${callerCeiling})`,
          } as never,
          403
        );
      }

      const minted = await insertUserToken(tx, {
        userId: targetUserId,
        tenantId,
        workspaceId: body.homeWorkspaceId,
        label: body.label,
        scopes: requestedScopes,
        maxSensitivity,
        expiresAt: body.expiresIn ? parseTtl(body.expiresIn) : null,
        ipAllowlist: body.ipAllowlist,
        test: body.test,
      });

      return c.json(
        {
          id: minted.id,
          key: minted.key,
          label: body.label,
          scopes: requestedScopes,
          userId: targetUserId,
          tenantId,
          workspaceId: body.homeWorkspaceId,
          expiresAt: minted.expiresAt,
          createdAt: minted.createdAt,
        },
        201
      );
    });
  });

  app.openapi(listUserTokensRoute, async (c) => {
    const { tenantId, userId: targetUserId } = c.req.valid("param");

    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAdmin(repo, tx, c, tenantId);

      const targetTenantRole = await repo.getTenantMemberRole(tenantId, targetUserId);
      if (targetTenantRole === null) {
        return c.json(
          { error: "not_found", message: "Target user is not a member of this tenant" } as never,
          404
        );
      }

      type TokenRow = {
        id: string;
        label: string;
        scopes: string[];
        workspace_id: string;
        expires_at: string | null;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      };
      await tx`SET LOCAL ROLE app_user`;
      await tx`SET LOCAL search_path TO mnemosyne, public`;
      const rows = await tx<TokenRow[]>`
        SELECT id, label, scopes, workspace_id, expires_at::text, created_at::text, last_used_at::text, revoked_at::text
        FROM mnemo_api_keys
        WHERE user_id = ${targetUserId} AND tenant_id = ${tenantId} AND key_kind = 'user'
        ORDER BY created_at DESC
      `;

      return c.json(
        {
          tokens: rows.map((r) => ({
            id: r.id,
            label: r.label ?? "",
            scopes: r.scopes ?? [],
            workspaceId: r.workspace_id,
            expiresAt: toIso(r.expires_at),
            createdAt: toIso(r.created_at) ?? r.created_at,
            lastUsedAt: toIso(r.last_used_at),
            revokedAt: toIso(r.revoked_at),
          })),
        },
        200
      );
    });
  });

  app.openapi(revokeUserTokenRoute, async (c) => {
    const { tenantId, userId: targetUserId, keyId } = c.req.valid("param");

    const res = await withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAdmin(repo, tx, c, tenantId);

      const revokedAt = new Date();
      const revokedAtIso = revokedAt.toISOString();

      await tx`SET LOCAL ROLE app_user`;
      await tx`SET LOCAL search_path TO mnemosyne, public`;
      type UpdateResult = { id: string };
      const rows = await tx<UpdateResult[]>`
        UPDATE mnemo_api_keys
        SET revoked_at = ${revokedAtIso}
        WHERE id = ${keyId}
          AND user_id = ${targetUserId}
          AND tenant_id = ${tenantId}
          AND key_kind = 'user'
          AND revoked_at IS NULL
        RETURNING id
      `;

      if (!rows[0]) {
        return c.json(
          {
            error: "not_found",
            message: "Token not found, already revoked, or belongs to a different user/tenant",
          } as never,
          404
        );
      }

      return c.json({ ok: true, revokedAt: revokedAtIso }, 200);
    });
    // After the commit: the auth middleware caches a verified token for 60 s,
    // so without this the revoked token would keep working until it expired.
    if (res.status === 200) forgetKeyAuth(keyId);
    return res;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTtl(expiresIn: string): Date {
  const n = parseInt(expiresIn.slice(0, -1), 10);
  const unit = expiresIn.slice(-1);
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() + n * (msMap[unit] ?? 86_400_000));
}
