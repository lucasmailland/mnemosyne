/**
 * Scoped-scheme key issuance (SECURITY.md §2.2).
 *
 * POST   /admin/scoped-keys             issue an mk_live_, mk_sess_ or mk_admin_ key
 * POST   /admin/scoped-keys/:id/rotate  issue a replacement; the old key keeps 7 days
 * DELETE /admin/scoped-keys/:id         revoke at once
 *
 * These are the `{prefix}{keyId}_{secret}` keys MNEMO_SCOPED_AUTH=1 verifies in
 * mnemo_scoped_api_keys (ScopedApiKeyAdapter), not the ones POST /admin/keys
 * mints into mnemo_api_keys. `:id` is the public id, `{prefix}{keyId}`.
 * Scope `admin:keys` (app-scope.ts). The limits are /admin/keys's: a caller
 * hands out no scope and no sensitivity ceiling it does not hold itself.
 *
 * An mk_admin_ key is bound to the user who issues it (the break-glass gate
 * keys on the human), carries a fresh TOTP secret returned once, and every
 * request with it needs a current code in `x-mnemo-mfa`.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { generateTotpSecret } from "@mnemo-ai/core";
import type { ApiKeyRecord, ApiKeyType, KeyScope } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { hashSecret } from "../auth/hash.js";
import { base62, KEY_TYPE_TTL_MS, rotateKey } from "../auth/rotation.js";
import { emitAudit } from "../audit-emit.js";
import type { ServerDeps } from "../deps.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { mintableCallerScopes } from "./keys.js";
import { ceilingBeyondCaller, KNOWN_SCOPES, scopesBeyondCaller } from "./_user-token.js";

const HOUR_MS = 3_600_000;
const UNIT_MS: Record<string, number> = { m: 60_000, h: HOUR_MS, d: 24 * HOUR_MS };

const ISSUABLE = { live: "mk_live_", sess: "mk_sess_", admin: "mk_admin_" } as const;
type IssuablePrefix = (typeof ISSUABLE)[keyof typeof ISSUABLE];

/** Longest (and default) lifetime per issued type. A session key is a day at most. */
const MAX_TTL_MS: Record<IssuablePrefix, number> = {
  mk_live_: KEY_TYPE_TTL_MS["mk_live_"]!,
  mk_sess_: 24 * HOUR_MS,
  mk_admin_: KEY_TYPE_TTL_MS["mk_admin_"]!,
};

const ALL_PREFIXES: ApiKeyType[] = ["mk_live_", "mk_test_", "mk_sess_", "mk_fed_", "mk_admin_"];

/** `{prefix}{keyId}` → its parts; null when it is not a scoped key id. */
function parseScopedId(id: string): { prefix: ApiKeyType; keyId: string } | null {
  const prefix = ALL_PREFIXES.find((p) => id.startsWith(p));
  const keyId = prefix ? id.slice(prefix.length) : "";
  return prefix && /^[0-9A-Za-z]{1,64}$/.test(keyId) ? { prefix, keyId } : null;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const IdParam = z.object({
  id: z
    .string()
    .openapi({ description: "Public key id, `{prefix}{keyId}`", example: "mk_live_a1B2c3D4e5F6" }),
});

const IssueBody = z
  .object({
    type: z.enum(["live", "sess", "admin"]).default("live").openapi({
      description:
        "live: mk_live_ (90 days at most). sess: mk_sess_ (24 hours at most). admin: mk_admin_ break-glass key (24 hours at most, TOTP, bound to the issuing user).",
    }),
    scopes: z
      .array(z.string())
      .min(1)
      .openapi({ example: ["memory:read"] }),
    expiresIn: z
      .string()
      .regex(/^[1-9]\d*[dhm]$/)
      .optional()
      .openapi({
        description: "TTL: 30d, 8h, 60m. Defaults to the type's maximum.",
        example: "8h",
      }),
    ipAllowlist: z
      .array(z.string())
      .optional()
      .openapi({ example: ["10.0.0.0/8"] }),
    maxSensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
  })
  .openapi("IssueScopedKeyBody");

const IssueResponse = z
  .object({
    id: z.string().openapi({ description: "Public id, `{prefix}{keyId}`" }),
    key: z.string().openapi({ description: "Full key, shown once and never retrievable again" }),
    prefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    maxSensitivity: z.string().nullable(),
    mfaSecret: z.string().optional().openapi({
      description: "mk_admin_ only: the base32 TOTP secret, shown once. Codes go in `x-mnemo-mfa`.",
    }),
    otpauthUri: z.string().optional().openapi({
      description: "mk_admin_ only: the same secret as an otpauth:// URI for an authenticator app.",
    }),
  })
  .openapi("IssueScopedKeyResponse");

const RotateResponse = z
  .object({
    newKey: z.string().openapi({ description: "Full new key, shown once" }),
    newId: z.string(),
    oldKeySunsetAt: z.iso.datetime().openapi({
      description: "The old key keeps working until then (7 days). Revoke it to end it sooner.",
    }),
  })
  .openapi("RotateScopedKeyResponse");

const issueRoute = createRoute({
  method: "post",
  path: "/admin/scoped-keys",
  tags: ["keys"],
  summary: "Issue a scoped-scheme key (mk_live_, mk_sess_ or mk_admin_).",
  request: { body: { content: { "application/json": { schema: IssueBody } }, required: true } },
  responses: {
    201: {
      description: "Key issued. `key` (and `mfaSecret` for mk_admin_) are shown once.",
      content: { "application/json": { schema: IssueResponse } },
    },
    400: { description: "Invalid body, an unknown scope, or a lifetime past the type's maximum." },
    403: {
      description:
        "admin:keys missing; a scope or ceiling the caller does not hold; or an mk_admin_ key asked by a caller with no user.",
    },
  },
});

const rotateRoute = createRoute({
  method: "post",
  path: "/admin/scoped-keys/:id/rotate",
  tags: ["keys"],
  summary: "Rotate a scoped-scheme key. The old key stays valid for 7 days.",
  request: {
    params: IdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ reason: z.string().max(200).optional() })
            .openapi("RotateScopedKeyBody"),
        },
      },
      required: false,
    },
  },
  responses: {
    201: {
      description: "Replacement issued.",
      content: { "application/json": { schema: RotateResponse } },
    },
    403: {
      description:
        "The key holds a scope or ceiling the caller does not, or it is another user's mk_admin_ key.",
    },
    404: { description: "No such key in this workspace." },
    409: { description: "The key is revoked or was already rotated." },
    422: { description: "The key is expired." },
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/admin/scoped-keys/:id",
  tags: ["keys"],
  summary: "Revoke a scoped-scheme key at once (a rotated key in its grace period too).",
  request: { params: IdParam },
  responses: {
    200: {
      description: "Revoked.",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean(), revokedAt: z.iso.datetime() }) },
      },
    },
    404: { description: "No such key in this workspace, or it is already revoked." },
  },
});

// ─── Mount ───────────────────────────────────────────────────────────────────

export function mountAdminScopedKeys(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const store = deps.scopedKeyStore;
  if (!store) return;

  /** The key, only when it belongs to the caller's workspace. */
  async function findInWorkspace(id: string, workspaceId: string): Promise<ApiKeyRecord | null> {
    const parsed = parseScopedId(id);
    const record = parsed ? await store!.lookup(parsed.prefix, parsed.keyId) : null;
    return record && record.workspaceId === workspaceId ? record : null;
  }

  app.openapi(issueRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const userId = c.get("userId") ?? null;
    const body = c.req.valid("json");
    const { scopes: callerScopes, maxSensitivity: callerCeiling } = getAuthCtx(c);

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
    const maxSensitivity = body.maxSensitivity ?? callerCeiling ?? null;
    if (ceilingBeyondCaller(maxSensitivity, callerCeiling)) {
      throw new ForbiddenError(
        `Cannot grant a sensitivity ceiling above the caller's own (${callerCeiling})`,
        { requested: maxSensitivity, callerCeiling }
      );
    }

    const prefix = ISSUABLE[body.type];
    // Dual control keys on the human: a break-glass key nobody owns could never
    // pass the two-person gate, and must not be issued.
    if (prefix === "mk_admin_" && !userId) {
      throw new ForbiddenError(
        "An mk_admin_ key is bound to the user who issues it: issue it with a user-bound key or a dashboard session"
      );
    }
    const maxTtlMs = MAX_TTL_MS[prefix];
    const ttlMs = body.expiresIn
      ? Number(body.expiresIn.slice(0, -1)) * UNIT_MS[body.expiresIn.slice(-1)]!
      : maxTtlMs;
    if (ttlMs > maxTtlMs) {
      throw new BadRequestError(`A ${prefix} key lives ${maxTtlMs / HOUR_MS} hours at most`, {
        maxHours: maxTtlMs / HOUR_MS,
      });
    }

    const keyId = base62(12);
    const secret = base62(43);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const mfaSecret = prefix === "mk_admin_" ? generateTotpSecret() : null;
    await store.insert({
      keyId,
      prefix,
      hashedSecret: await hashSecret(secret),
      workspaceId,
      scopes: body.scopes as KeyScope[],
      status: "active",
      expiresAt,
      ...(body.ipAllowlist?.length ? { ipAllowlist: body.ipAllowlist } : {}),
      createdAt: now,
      deprecatedAt: null,
      mfaSecret,
      isTest: false,
      userId,
      ...(maxSensitivity ? { maxSensitivity } : {}),
    });

    const id = `${prefix}${keyId}`;
    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "key_create",
      resourceKind: "api_key",
      resourceId: id,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        scheme: "scoped",
        scopes: body.scopes,
        expiresAt: expiresAt.toISOString(),
        ...(mfaSecret ? { mfa: "totp" } : {}),
      },
    });

    return c.json(
      {
        id,
        key: `${id}_${secret}`,
        prefix,
        scopes: body.scopes,
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
        maxSensitivity,
        ...(mfaSecret
          ? {
              mfaSecret,
              otpauthUri: `otpauth://totp/Mnemosyne:${id}?secret=${mfaSecret}&issuer=Mnemosyne`,
            }
          : {}),
      },
      201
    );
  });

  app.openapi(rotateRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const userId = c.get("userId") ?? null;
    const { id } = c.req.valid("param");
    const { scopes: callerScopes, maxSensitivity: callerCeiling } = getAuthCtx(c);

    const old = await findInWorkspace(id, workspaceId);
    if (!old) throw new NotFoundError("Key not found");
    if (old.status === "revoked")
      throw new ConflictError("Key is already revoked and cannot be rotated");
    if (old.status === "deprecated") {
      throw new ConflictError("Key has already been rotated and cannot be rotated again");
    }
    if (old.expiresAt && old.expiresAt < new Date()) {
      throw new UnprocessableEntityError("Key is expired and cannot be rotated");
    }
    // Rotating is minting: the response holds a fresh secret with the old grant.
    const beyond = scopesBeyondCaller(old.scopes, mintableCallerScopes(c, callerScopes));
    if (beyond.length > 0) {
      throw new ForbiddenError(
        `Cannot rotate a key holding scopes the caller doesn't have: ${beyond.join(", ")}`
      );
    }
    if (ceilingBeyondCaller(old.maxSensitivity ?? null, callerCeiling)) {
      throw new ForbiddenError(
        "Cannot rotate a key whose sensitivity ceiling is above the caller's own"
      );
    }
    // The replacement keeps the TOTP secret and the user binding: only that
    // user may hold a new secret for their break-glass key.
    if (old.prefix === "mk_admin_" && (!userId || old.userId !== userId)) {
      throw new ForbiddenError("Only the user an mk_admin_ key is bound to can rotate it");
    }

    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const result = await rotateKey(store, old.prefix, old.keyId, {
      reason: body.reason ?? "manual rotation",
    });
    const newId = `${old.prefix}${result.newKeyId}`;

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "key_rotate",
      resourceKind: "api_key",
      resourceId: newId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        scheme: "scoped",
        rotatedFromId: id,
        oldKeySunsetAt: result.sunset,
      },
    });

    return c.json({ newKey: result.newKey, newId, oldKeySunsetAt: result.sunset }, 201);
  });

  app.openapi(revokeRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { id } = c.req.valid("param");

    const key = await findInWorkspace(id, workspaceId);
    if (!key || key.status === "revoked")
      throw new NotFoundError("Key not found or already revoked");
    const revokedAt = new Date();
    // The adapter reads the row on every request (no cache): the next one is refused.
    await store.revoke(key.keyId, "revoked via /admin/scoped-keys");
    await store.escrow({
      keyId: key.keyId,
      prefix: key.prefix,
      workspaceId,
      scopes: key.scopes,
      action: "revoke",
      reason: "revoked via /admin/scoped-keys",
      escrowedAt: revokedAt,
    });

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "key_revoke",
      resourceKind: "api_key",
      resourceId: id,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        scheme: "scoped",
        revokedAt: revokedAt.toISOString(),
      },
    });

    return c.json({ ok: true, revokedAt: revokedAt.toISOString() }, 200);
  });
}
