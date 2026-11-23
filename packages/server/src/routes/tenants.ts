/**
 * Multi-tenant API routes
 *
 * POST   /tenants                              — create tenant
 * GET    /tenants/:tenantId                    — get tenant info
 * GET    /tenants/:tenantId/members            — list members
 * POST   /tenants/:tenantId/members            — invite user by email
 * DELETE /tenants/:tenantId/members/:userId    — remove member
 *
 * POST   /users                                — create user + personal tenant
 * GET    /users/me                             — get current user (from the key's bound userId)
 *
 * POST   /tenants/:tenantId/workspaces         — create workspace in tenant
 * GET    /tenants/:tenantId/workspaces         — list workspaces in tenant
 * POST   /workspaces/:workspaceId/members      — invite to workspace
 * GET    /workspaces/:workspaceId/members      — list workspace members
 * DELETE /workspaces/:workspaceId/members/:userId — remove from workspace
 * PATCH  /workspaces/:workspaceId/members/:userId — update role
 *
 * Scopes:
 *   tenant/user routes  → admin:tenant
 *   workspace routes    → memory:admin
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type postgres from "postgres";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { ForbiddenError } from "../errors.js";
import type { ServerDeps } from "../deps.js";
import { TenantRepository } from "@mnemo-ai/adapter-postgres";
import { toIso } from "../schemas.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";
import { forgetUserAuth } from "../auth-cache-registry.js";
import { insertUserToken, KNOWN_SCOPES } from "./_user-token.js";

export type TenantSql = postgres.Sql | postgres.TransactionSql;

/**
 * Set mnemosyne.actor_user_id and mnemosyne.actor_tenant_id GUCs on the
 * current connection so the RLS policies on mnemo_tenant, mnemo_user,
 * mnemo_workspace, and mnemo_workspace_member activate for this request.
 *
 * Uses set_config with is_local=true — the GUC is scoped to the current
 * transaction and resets when the connection is returned to the pool.
 */
async function setTenantGUCs(
  sql: TenantSql,
  userId: string | null | undefined,
  tenantId: string | null | undefined
): Promise<void> {
  if (userId) await sql`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`;
  if (tenantId) await sql`SELECT set_config('mnemosyne.actor_tenant_id', ${tenantId}, true)`;
}

type TenantContext = import("hono").Context<{ Variables: AuthVariables }>;

/**
 * The transaction every tenant route runs in. A key with neither a tenant nor
 * a user gets its home tenant (resolveCallerTenant) as actor tenant, so RLS
 * confines it to that tenant as the guards do (AUTH-TENANT-RLS-FALLBACK): it
 * no longer runs with no GUC, through the empty-GUC branches that show every
 * tenant. A user-bound key without a tenant still sets none.
 */
export async function withTenantRls<T>(
  sql: postgres.Sql,
  c: TenantContext,
  fn: (repo: TenantRepository, tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  const { userId, tenantId } = getAuthCtx(c);
  return sql.begin(async (tx) => {
    const actorTenantId = tenantId ?? (userId ? null : await resolveCallerTenant(c, tx));
    await setTenantGUCs(tx, userId, actorTenantId);
    // §35: a workspace created in this transaction gets this instance's region
    // (the mnemo_workspace.region default, migration 0062).
    const region = process.env.MNEMO_REGION;
    if (region) await tx`SELECT set_config('mnemosyne.region', ${region}, true)`;
    return fn(new TenantRepository(tx as TenantSql), tx);
  }) as Promise<T>;
}

// ─── Authorization helpers ────────────────────────────────────────────────────
//
// All routes in this file operate on resources that belong to a specific tenant,
// and every guard compares that tenant with the caller's (AUTH-TENANT-NULL).
// There is no cross-tenant principal: a caller whose tenant cannot be resolved
// is denied, never let through.
//
// The caller's tenant is the key row's tenant_id when it has one. A key without
// one (the bootstrap and setup keys, the keys minted from them, every mk_* key)
// acts in the tenant of its own home workspace, and only there.
//
// The derived tenant feeds these guards and, for a key with no user either,
// the actor tenant of withTenantRls. `tenantId` on the context keeps meaning
// "the key row's binding" (recall and remember read it). With actor_tenant_id
// set, the bootstrap key still sees its own private, memberless workspace:
// mnemo_workspace_write applies to SELECT too and admits its tenant's rows.
//
// The lookup goes through mnemo_workspace_tenant_id (migration 0047), a
// SECURITY DEFINER function, not through the RLS fallback it used to read by.

/** The tenant the caller may act in, or null when it cannot be resolved. */
async function resolveCallerTenant(c: TenantContext, tx: TenantSql): Promise<string | null> {
  const { tenantId, apiKeyPrefix, actorId, workspaceId } = getAuthCtx(c);
  if (tenantId) return tenantId;
  let rows: Array<{ tenant_id: string | null }> = [];
  if (apiKeyPrefix?.startsWith("mk_")) {
    // A scoped key never switches workspaces: the one on the request is its own.
    rows = await tx<Array<{ tenant_id: string | null }>>`
      SELECT mnemosyne.mnemo_workspace_tenant_id(${workspaceId}) AS tenant_id`;
  } else if (actorId) {
    // Any other key: the workspace on its own row, never the one X-Workspace-Id
    // selected, so a header cannot move tenant-plane authority.
    rows = await tx<Array<{ tenant_id: string | null }>>`
      SELECT mnemosyne.mnemo_workspace_tenant_id(k.workspace_id) AS tenant_id
      FROM mnemosyne.mnemo_api_keys k
      WHERE k.id = ${actorId}`;
  }
  return rows[0]?.tenant_id ?? null;
}

async function requireTenantAccess(
  c: TenantContext,
  tx: TenantSql,
  tenantId: string
): Promise<void> {
  if ((await resolveCallerTenant(c, tx)) !== tenantId) {
    throw new ForbiddenError("Not authorized for this tenant");
  }
}

export async function requireTenantAdmin(
  repo: TenantRepository,
  tx: TenantSql,
  c: TenantContext,
  tenantId: string
): Promise<void> {
  await requireTenantAccess(c, tx, tenantId);
  // A user-bound key also needs the owner/admin role in the tenant. A key with
  // no user has no role to check, and keeps acting in its own tenant: that is
  // what keeps a self-hosted instance's bootstrap key working.
  const userId = c.get("userId") ?? null;
  if (userId) {
    const role = await repo.getTenantMemberRole(tenantId, userId);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenError("Tenant owner or admin role required");
    }
  }
}

/**
 * For routes that create a tenant or an account, which name no tenant: the
 * caller must be a tenant admin (requireTenantAdmin) of its own tenant.
 */
async function requireOwnTenantAdmin(
  repo: TenantRepository,
  tx: TenantSql,
  c: TenantContext
): Promise<void> {
  const tenantId = await resolveCallerTenant(c, tx);
  if (!tenantId) throw new ForbiddenError("Not authorized for this tenant");
  await requireTenantAdmin(repo, tx, c, tenantId);
}

/**
 * The provisioning functions (migration 0047) check the caller again in SQL
 * and raise insufficient_privilege. That is the same answer the guards give.
 */
function rethrowProvisioningError(err: unknown): never {
  if ((err as { code?: string } | null)?.code === "42501") {
    throw new ForbiddenError("Tenant owner or admin role required");
  }
  throw err;
}

function isTakenEmail(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint_name?: string } | null;
  return pgErr?.code === "23505" && pgErr.constraint_name === "mnemo_user_email_key";
}

/**
 * Whether the workspace belongs to the caller's tenant. A route answers "no"
 * exactly as it answers a missing workspace: RLS still shows a user-bound caller
 * with no tenant the workspaces of every tenant, and a 403 would confirm they
 * exist (S6).
 */
async function inCallerTenant(
  c: TenantContext,
  tx: TenantSql,
  workspace: { tenantId: string }
): Promise<boolean> {
  return (await resolveCallerTenant(c, tx)) === workspace.tenantId;
}

/** For a workspace already known to be in the caller's tenant (`inCallerTenant`). */
async function requireWorkspaceAdmin(
  repo: TenantRepository,
  c: TenantContext,
  workspace: { id: string; tenantId: string }
): Promise<void> {
  const userId = c.get("userId") ?? null;
  if (userId) {
    const role = await repo.getWorkspaceMemberRole(workspace.id, userId);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenError("Workspace owner or admin role required");
    }
  }
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const TenantSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    plan: z.string(),
    createdAt: z.iso.datetime().nullable(),
  })
  .openapi("Tenant");

const CreateTenantBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: z.enum(["personal", "organization"]).default("organization"),
    plan: z.string().optional(),
    issueOwnerToken: z.boolean().optional().default(false).openapi({
      description:
        "When true, the same call also creates the tenant's first workspace, owned by the caller's user, and returns `ownerToken`: a uk_live_* token for that user, bound to the new tenant and workspace, with the caller's own scopes and sensitivity ceiling at most. The caller's current key keeps acting in its old tenant, so without this nothing can act in the new one. Needs a key bound to a user. The plaintext is shown once.",
    }),
    workspaceName: z.string().min(1).max(120).optional().openapi({
      description: "Name of the first workspace with issueOwnerToken. Defaults to the tenant name.",
    }),
  })
  .openapi("CreateTenantBody");

const TenantMemberSchema = z
  .object({
    userId: z.string(),
    role: z.string(),
    joinedAt: z.iso.datetime().nullable(),
  })
  .openapi("TenantMember");

const InviteTenantMemberBodySchema = z
  .object({
    email: z.email(),
    role: z.enum(["owner", "admin", "member"]).default("member"),
    createIfMissing: z.boolean().optional().default(false).openapi({
      description:
        "When true and no user exists with this email, auto-provisions one (same personal-tenant/personal-workspace flow as POST /users) before adding the tenant membership. Default false preserves the original 404-on-unknown-email behavior.",
    }),
  })
  .openapi("InviteTenantMemberBody");

const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    personalTenantId: z.string(),
    createdAt: z.iso.datetime().nullable(),
  })
  .openapi("User");

const CreateUserBodySchema = z
  .object({
    email: z.email(),
    displayName: z.string().optional(),
  })
  .openapi("CreateUserBody");

const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullable(),
    tenantId: z.string(),
    visibility: z.string(),
    createdAt: z.iso.datetime().nullable(),
  })
  .openapi("Workspace");

const WorkspaceListItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullable(),
    visibility: z.string(),
    memberCount: z.number().int(),
  })
  .openapi("WorkspaceListItem");

const CreateWorkspaceBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().optional(),
    ownerUserId: z.string().optional().openapi({
      description:
        "Who owns the new workspace; must be a member of the tenant. Defaults to the caller's own user. A key with no user and no ownerUserId creates a workspace with no member, which only keys with no user can manage.",
    }),
    visibility: z.enum(["private", "public"]).optional().default("private"),
  })
  .openapi("CreateWorkspaceBody");

const WorkspaceMemberSchema = z
  .object({
    userId: z.string(),
    role: z.string(),
    joinedAt: z.iso.datetime().nullable(),
  })
  .openapi("WorkspaceMember");

const InviteWorkspaceMemberBodySchema = z
  .object({
    userId: z.string(),
    role: z.enum(["owner", "admin", "write", "read"]).default("read"),
  })
  .openapi("InviteWorkspaceMemberBody");

const UpdateWorkspaceMemberRoleBodySchema = z
  .object({
    role: z.enum(["owner", "admin", "write", "read"]),
  })
  .openapi("UpdateWorkspaceMemberRoleBody");

const ErrorSchema = z.object({ error: z.string(), message: z.string() }).openapi("TenantError");

// ─── Route definitions ────────────────────────────────────────────────────────

const OwnerTokenSchema = z
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
    maxSensitivity: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("OwnerToken");

const CreateTenantResponseSchema = TenantSchema.extend({
  workspace: WorkspaceSchema.optional().openapi({
    description: "The first workspace, with issueOwnerToken.",
  }),
  ownerToken: OwnerTokenSchema.optional(),
}).openapi("CreateTenantResponse");

const createTenantRoute = createRoute({
  method: "post",
  path: "/tenants",
  tags: ["tenants"],
  summary: "Create a new tenant.",
  request: {
    body: { content: { "application/json": { schema: CreateTenantBodySchema } }, required: true },
  },
  responses: {
    201: {
      description:
        "Tenant created (with issueOwnerToken, also its first workspace and an owner token).",
      content: { "application/json": { schema: CreateTenantResponseSchema } },
    },
    400: {
      description: "Invalid request body, or issueOwnerToken from a key with no user.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description:
        "Insufficient scope (admin:tenant required), or not a tenant owner/admin of the caller's own tenant.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getTenantRoute = createRoute({
  method: "get",
  path: "/tenants/:tenantId",
  tags: ["tenants"],
  summary: "Get tenant info.",
  request: { params: z.object({ tenantId: z.string() }) },
  responses: {
    200: { description: "Tenant info.", content: { "application/json": { schema: TenantSchema } } },
    404: {
      description: "Tenant not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listTenantMembersRoute = createRoute({
  method: "get",
  path: "/tenants/:tenantId/members",
  tags: ["tenants"],
  summary: "List tenant members.",
  request: { params: z.object({ tenantId: z.string() }) },
  responses: {
    200: {
      description: "Member list.",
      content: {
        "application/json": { schema: z.object({ members: z.array(TenantMemberSchema) }) },
      },
    },
    404: {
      description: "Tenant not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const inviteTenantMemberRoute = createRoute({
  method: "post",
  path: "/tenants/:tenantId/members",
  tags: ["tenants"],
  summary: "Invite a user by email to a tenant.",
  request: {
    params: z.object({ tenantId: z.string() }),
    body: {
      content: { "application/json": { schema: InviteTenantMemberBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Member added.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: {
      description: "Invalid request body.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Not a tenant owner/admin of this tenant.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Tenant or user not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "With createIfMissing, the email already has an account outside this tenant (or a concurrent invitation registered it first).",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const removeTenantMemberRoute = createRoute({
  method: "delete",
  path: "/tenants/:tenantId/members/:userId",
  tags: ["tenants"],
  summary: "Remove a user from a tenant.",
  request: { params: z.object({ tenantId: z.string(), userId: z.string() }) },
  responses: {
    200: {
      description: "Member removed.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    404: {
      description: "Tenant not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const WorkspaceListItemWithRoleSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    role: z.string(),
    visibility: z.string(),
  })
  .openapi("WorkspaceListItemWithRole");

const createUserRoute = createRoute({
  method: "post",
  path: "/users",
  tags: ["users"],
  summary: "Create a user (and auto-create their personal tenant and workspace).",
  request: {
    body: { content: { "application/json": { schema: CreateUserBodySchema } }, required: true },
  },
  responses: {
    201: {
      description: "User created with personal tenant and workspace.",
      content: {
        "application/json": {
          schema: z.object({
            user: UserSchema,
            personalTenant: TenantSchema,
            personalWorkspace: WorkspaceSchema,
          }),
        },
      },
    },
    400: {
      description: "Invalid request or email already exists.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Not a tenant owner/admin of the caller's own tenant.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getMeRoute = createRoute({
  method: "get",
  path: "/users/me",
  tags: ["users"],
  summary: "Get the current user (derived from the API key's bound userId).",
  responses: {
    200: {
      description: "Current user info.",
      content: { "application/json": { schema: UserSchema } },
    },
    404: {
      description: "User not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/tenants/:tenantId/workspaces",
  tags: ["workspaces"],
  summary: "Create a workspace inside a tenant.",
  request: {
    params: z.object({ tenantId: z.string() }),
    body: {
      content: { "application/json": { schema: CreateWorkspaceBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Workspace created.",
      content: { "application/json": { schema: WorkspaceSchema } },
    },
    400: {
      description: "Invalid request body.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Not a tenant owner/admin of this tenant, or the owner is not a member of it.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Tenant not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listWorkspacesForTenantRoute = createRoute({
  method: "get",
  path: "/tenants/:tenantId/workspaces",
  tags: ["workspaces"],
  summary: "List workspaces in a tenant.",
  request: { params: z.object({ tenantId: z.string() }) },
  responses: {
    200: {
      description: "Workspace list.",
      content: {
        "application/json": { schema: z.object({ workspaces: z.array(WorkspaceListItemSchema) }) },
      },
    },
    404: {
      description: "Tenant not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getWorkspaceByIdRoute = createRoute({
  method: "get",
  path: "/workspaces/:workspaceId",
  tags: ["workspaces"],
  summary:
    "Get a workspace by ID (membership required — returns 404 if not a member, anti-probing).",
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: {
      description: "Workspace metadata.",
      content: { "application/json": { schema: WorkspaceSchema } },
    },
    404: {
      description: "Workspace not found or caller is not a member.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listMyWorkspacesRoute = createRoute({
  method: "get",
  path: "/workspaces/mine",
  tags: ["workspaces"],
  summary: "List workspaces the authenticated user belongs to.",
  responses: {
    200: {
      description: "Workspace list.",
      content: {
        "application/json": {
          schema: z.object({ workspaces: z.array(WorkspaceListItemWithRoleSchema) }),
        },
      },
    },
    404: {
      description: "No user associated with this key.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const inviteWorkspaceMemberRoute = createRoute({
  method: "post",
  path: "/workspaces/:workspaceId/members",
  tags: ["workspaces"],
  summary: "Invite a user to a workspace.",
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: { "application/json": { schema: InviteWorkspaceMemberBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Member added.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: {
      description: "Invalid request body.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Invited user does not belong to this tenant.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Workspace not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listWorkspaceMembersRoute = createRoute({
  method: "get",
  path: "/workspaces/:workspaceId/members",
  tags: ["workspaces"],
  summary: "List workspace members.",
  request: { params: z.object({ workspaceId: z.string() }) },
  responses: {
    200: {
      description: "Member list.",
      content: {
        "application/json": { schema: z.object({ members: z.array(WorkspaceMemberSchema) }) },
      },
    },
    404: {
      description: "Workspace not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const removeWorkspaceMemberRoute = createRoute({
  method: "delete",
  path: "/workspaces/:workspaceId/members/:userId",
  tags: ["workspaces"],
  summary: "Remove a user from a workspace.",
  request: { params: z.object({ workspaceId: z.string(), userId: z.string() }) },
  responses: {
    200: {
      description: "Member removed.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    404: {
      description: "Workspace not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateWorkspaceMemberRoleRoute = createRoute({
  method: "patch",
  path: "/workspaces/:workspaceId/members/:userId",
  tags: ["workspaces"],
  summary: "Update a workspace member's role.",
  request: {
    params: z.object({ workspaceId: z.string(), userId: z.string() }),
    body: {
      content: { "application/json": { schema: UpdateWorkspaceMemberRoleBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Role updated.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: {
      description: "Invalid request body.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Workspace not found.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountTenants(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const pgSql = deps.metricsPgClient;
  if (!pgSql) return; // no DB client — skip all tenant routes

  // POST /tenants
  app.openapi(createTenantRoute, async (c) => {
    const body = c.req.valid("json");
    const { userId, scopes: callerScopes, maxSensitivity: callerCeiling } = getAuthCtx(c);
    // The owner token is the caller's own user's: a key with no user has none.
    if (body.issueOwnerToken && !userId) {
      return c.json(
        { error: "bad_request", message: "issueOwnerToken needs a key bound to a user" } as never,
        400
      );
    }
    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireOwnTenantAdmin(repo, tx, c);
      // A caller with a user becomes the new tenant's owner (SEC-5, PRIM-17).
      const { tenant, workspace } = await repo
        .provisionTenant({
          name: body.name,
          kind: body.kind,
          plan: body.plan,
          workspaceName: body.issueOwnerToken ? (body.workspaceName ?? body.name) : undefined,
        })
        .catch(rethrowProvisioningError);

      // Tenant-plane authority comes from the key's own tenant, so the caller's
      // key cannot act in the tenant it just made. The owner token can: same
      // user, bound to the new tenant, within the caller's scopes and ceiling
      // (SEC-1). Same transaction: no tenant without its token, or the reverse.
      let ownerToken: z.infer<typeof OwnerTokenSchema> | undefined;
      if (body.issueOwnerToken && workspace && userId) {
        const scopes = [...new Set<string>(callerScopes)].filter((s) => KNOWN_SCOPES.has(s));
        const maxSensitivity = callerCeiling ?? null;
        const label = `owner token for ${tenant.name}`.slice(0, 80);
        const minted = await insertUserToken(tx, {
          userId,
          tenantId: tenant.id,
          workspaceId: workspace.id,
          label,
          scopes,
          maxSensitivity,
          expiresAt: null,
        });
        ownerToken = {
          id: minted.id,
          key: minted.key,
          label,
          scopes,
          userId,
          tenantId: tenant.id,
          workspaceId: workspace.id,
          maxSensitivity,
          createdAt: minted.createdAt,
        };
      }

      return c.json(
        {
          id: tenant.id,
          name: tenant.name,
          kind: tenant.kind,
          plan: tenant.plan,
          createdAt: toIso(tenant.createdAt),
          ...(workspace
            ? {
                workspace: {
                  id: workspace.id,
                  name: workspace.name,
                  slug: workspace.slug,
                  tenantId: workspace.tenantId,
                  visibility: workspace.visibility,
                  createdAt: toIso(workspace.createdAt),
                },
              }
            : {}),
          ...(ownerToken ? { ownerToken } : {}),
        },
        201
      );
    });
  });

  // GET /tenants/:tenantId
  app.openapi(getTenantRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAccess(c, tx, tenantId);
      const tenant = await repo.getTenant(tenantId);
      if (!tenant) {
        return c.json({ error: "not_found", message: "Tenant not found" } as never, 404);
      }
      return c.json(
        {
          id: tenant.id,
          name: tenant.name,
          kind: tenant.kind,
          plan: tenant.plan,
          createdAt: null,
        },
        200
      );
    });
  });

  // GET /tenants/:tenantId/members
  app.openapi(listTenantMembersRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAccess(c, tx, tenantId);
      const tenant = await repo.getTenant(tenantId);
      if (!tenant) {
        return c.json({ error: "not_found", message: "Tenant not found" } as never, 404);
      }
      const members = await repo.listTenantMembers(tenantId);
      return c.json(
        {
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role,
            joinedAt: toIso(m.joinedAt),
          })),
        },
        200
      );
    });
  });

  // POST /tenants/:tenantId/members
  app.openapi(inviteTenantMemberRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { userId } = getAuthCtx(c);
    try {
      return await withTenantRls(pgSql, c, async (repo, tx) => {
        await requireTenantAdmin(repo, tx, c, tenantId);

        const tenant = await repo.getTenant(tenantId);
        if (!tenant) {
          return c.json({ error: "not_found", message: "Tenant not found" } as never, 404);
        }

        // Not getUserByEmail: mnemo_user_own shows a caller with a user only
        // its own row. findUserIdByEmail shows it the members of its own
        // tenant, and nobody else: pulling in an account from outside would
        // let this admin mint a token that switches into that account's other
        // workspaces (migration 0047). A key with no user still sees everyone.
        let inviteeId = await repo.findUserIdByEmail(body.email).catch(rethrowProvisioningError);
        if (!inviteeId) {
          if (!body.createIfMissing) {
            return c.json(
              { error: "not_found", message: "User with that email not found" } as never,
              404
            );
          }
          // Auto-provision: identical personal-tenant/user/personal-workspace
          // flow as POST /users, so "invite someone who's never used Mnemosyne"
          // works in one call — every user still needs their own personal
          // tenant regardless of which organization tenant they're being
          // invited into here.
          const account = await repo
            .provisionUser({ email: body.email, workspaceName: `${body.email}'s workspace` })
            .catch(rethrowProvisioningError);
          inviteeId = account.user.id;
        }

        // invited_by is a real user reference (FK-adjacent) — must be the
        // caller's userId, never the raw API-key id (see user-tokens.ts for the
        // established correct pattern this now matches).
        await repo.addTenantMember(tenantId, inviteeId, body.role, userId ?? undefined);
        return c.json({ ok: true }, 200);
      });
    } catch (err) {
      // createIfMissing for an email that already has an account this caller
      // may not invite, or that a concurrent invitation registered first.
      if (isTakenEmail(err)) {
        return c.json(
          {
            error: "conflict",
            message:
              "A user with that email already exists and is not a member of this tenant; a key with a user can only invite new emails or members of its own tenant",
          } as never,
          409
        );
      }
      throw err;
    }
  });

  // DELETE /tenants/:tenantId/members/:userId
  app.openapi(removeTenantMemberRoute, async (c) => {
    const { tenantId, userId } = c.req.valid("param");
    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAdmin(repo, tx, c, tenantId);
      const tenant = await repo.getTenant(tenantId);
      if (!tenant) {
        return c.json({ error: "not_found", message: "Tenant not found" } as never, 404);
      }
      await repo.removeTenantMember(tenantId, userId);
      return c.json({ ok: true }, 200);
    });
  });

  // POST /users
  app.openapi(createUserRoute, async (c) => {
    const body = c.req.valid("json");
    const emailTaken = () =>
      c.json({ error: "bad_request", message: "Email already registered" } as never, 400);
    try {
      return await withTenantRls(pgSql, c, async (repo, tx) => {
        await requireOwnTenantAdmin(repo, tx, c);

        // Check for duplicate email, past mnemo_user_own (see the invitation).
        if (await repo.findUserIdByEmail(body.email).catch(rethrowProvisioningError)) {
          return emailTaken();
        }

        // Personal tenant, user, its owner membership, personal workspace and
        // its owner membership, in one call (migration 0047).
        const {
          user,
          tenant: personalTenant,
          workspace: personalWorkspace,
        } = await repo
          .provisionUser({
            email: body.email,
            displayName: body.displayName,
            workspaceName: `${body.email}'s workspace`,
          })
          .catch(rethrowProvisioningError);

        return c.json(
          {
            user: {
              id: user.id,
              email: user.email,
              displayName: user.displayName,
              personalTenantId: user.personalTenantId,
              createdAt: toIso(user.createdAt),
            },
            personalTenant: {
              id: personalTenant.id,
              name: personalTenant.name,
              kind: personalTenant.kind,
              plan: personalTenant.plan,
              createdAt: toIso(personalTenant.createdAt),
            },
            personalWorkspace: {
              id: personalWorkspace.id,
              name: personalWorkspace.name,
              slug: personalWorkspace.slug,
              tenantId: personalWorkspace.tenantId,
              visibility: personalWorkspace.visibility,
              createdAt: toIso(personalWorkspace.createdAt),
            },
          },
          201
        );
      });
    } catch (err) {
      // Registered between the check above and the insert.
      if (isTakenEmail(err)) return emailTaken();
      throw err;
    }
  });

  // GET /users/me
  app.openapi(getMeRoute, async (c) => {
    const { userId } = getAuthCtx(c);
    return withTenantRls(pgSql, c, async (_repo, tx) => {
      if (!userId) {
        return c.json(
          { error: "not_found", message: "No user associated with this key" } as never,
          404
        );
      }

      // userId is already resolved on the auth context (the key's bound
      // user) — no need to guess by querying with the raw key/actor id, the
      // conflation this lookup used to make.
      type UserRow = {
        id: string;
        email: string;
        display_name: string | null;
        personal_tenant_id: string;
        created_at: string;
      };
      const rows = await tx<UserRow[]>`
        SELECT id, email, display_name, personal_tenant_id, created_at::text
        FROM mnemosyne.mnemo_user
        WHERE id = ${userId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        return c.json({ error: "not_found", message: "User not found" } as never, 404);
      }
      return c.json(
        {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          personalTenantId: row.personal_tenant_id,
          createdAt: toIso(row.created_at),
        },
        200
      );
    });
  });

  // POST /tenants/:tenantId/workspaces
  app.openapi(createWorkspaceRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { userId } = getAuthCtx(c);

    // The audit write for `workspace_created` MUST happen AFTER this tx
    // commits, never inside it — appendAuditEntry opens its own transaction
    // and takes a per-workspace advisory lock, so the new workspace row must
    // already be visible when it runs (design D1/D8).
    const result = await withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAdmin(repo, tx, c, tenantId);

      const tenant = await repo.getTenant(tenantId);
      if (!tenant) {
        return { notFound: true as const };
      }

      // PRIM-17: a workspace with no member can be managed only by a key with
      // no user, so a caller with a user who names no owner owns it. The owner
      // must belong to the tenant, as an invited workspace member must.
      const ownerUserId = body.ownerUserId ?? userId ?? undefined;
      if (ownerUserId && !(await repo.getTenantMemberRole(tenantId, ownerUserId))) {
        return { notFound: false as const, foreignOwner: true as const };
      }

      const workspace = await repo.createWorkspace({
        name: body.name,
        slug: body.slug,
        tenantId,
        ownerUserId,
        visibility: body.visibility,
      });

      return { notFound: false as const, foreignOwner: false as const, workspace, ownerUserId };
    });

    if (result.notFound) {
      return c.json({ error: "not_found", message: "Tenant not found" } as never, 404);
    }
    if (result.foreignOwner) {
      return c.json(
        { error: "forbidden", message: "owner does not belong to this tenant" } as never,
        403
      );
    }

    const { workspace, ownerUserId } = result;

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: workspace.id,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "workspace_created",
      resourceKind: "workspace",
      resourceId: workspace.id,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        tenantId: workspace.tenantId,
        slug: workspace.slug,
        visibility: workspace.visibility,
        ownerUserId,
      },
    });

    return c.json(
      {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        tenantId: workspace.tenantId,
        visibility: workspace.visibility,
        createdAt: toIso(workspace.createdAt),
      },
      201
    );
  });

  // GET /tenants/:tenantId/workspaces
  app.openapi(listWorkspacesForTenantRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    return withTenantRls(pgSql, c, async (repo, tx) => {
      await requireTenantAccess(c, tx, tenantId);

      const tenant = await repo.getTenant(tenantId);
      if (!tenant) {
        return c.json({ error: "not_found", message: "Tenant not found" } as never, 404);
      }

      const workspaces = await repo.listWorkspacesForTenant(tenantId);
      return c.json({ workspaces }, 200);
    });
  });

  // GET /workspaces/mine — must be registered BEFORE /workspaces/:workspaceId to avoid param capture
  app.openapi(listMyWorkspacesRoute, async (c) => {
    const { userId } = getAuthCtx(c);
    if (!userId) {
      return c.json(
        { error: "not_found", message: "No user associated with this key" } as never,
        404
      );
    }
    return withTenantRls(pgSql, c, async (repo) => {
      const workspaces = await repo.listWorkspacesForUser(userId);
      return c.json({ workspaces }, 200);
    });
  });

  // GET /workspaces/:workspaceId — membership required; 404 for non-members (anti-probing)
  app.openapi(getWorkspaceByIdRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { userId, workspaceId: authWorkspaceId } = getAuthCtx(c);
    return withTenantRls(pgSql, c, async (repo) => {
      const workspace = await repo.getWorkspace(workspaceId);
      if (!workspace) {
        return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
      }

      // Anti-probing: return 404 (not 403) unless the caller can legitimately see this
      // workspace (security invariant S6). Two distinct caller shapes, both gated:
      //  - user-bound key: membership in this workspace's member table.
      //  - workspace-only key (no userId): the key's OWN scoped workspace, via
      //    the workspaceId the auth middleware set on the request context — a
      //    workspace-only key must never be able to read a DIFFERENT workspace's
      //    info just by guessing its id (SEC: found by B4.1's coverage fill-in,
      //    this branch previously ran no check at all when userId was absent).
      if (userId) {
        const memberRole = await repo.getWorkspaceMemberRole(workspaceId, userId);
        if (!memberRole) {
          return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
        }
      } else if (workspaceId !== authWorkspaceId) {
        return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
      }

      return c.json(
        {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          tenantId: workspace.tenantId,
          visibility: workspace.visibility,
          createdAt: null,
        },
        200
      );
    });
  });

  // POST /workspaces/:workspaceId/members
  app.openapi(inviteWorkspaceMemberRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { userId } = getAuthCtx(c);
    return withTenantRls(pgSql, c, async (repo, tx) => {
      const workspace = await repo.getWorkspace(workspaceId);
      if (!workspace || !(await inCallerTenant(c, tx, workspace))) {
        return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
      }

      await requireWorkspaceAdmin(repo, c, workspace);

      // Same-tenant enforcement: invited user must belong to the workspace's tenant
      const inviteeTenantRole = await repo.getTenantMemberRole(workspace.tenantId, body.userId);
      if (!inviteeTenantRole) {
        return c.json(
          { error: "forbidden", message: "user does not belong to this tenant" } as never,
          403
        );
      }

      // invited_by must be the caller's userId, never the raw API-key id —
      // see the matching fix + comment on addTenantMember above.
      await repo.addWorkspaceMember(workspaceId, body.userId, body.role, userId ?? undefined);
      return c.json({ ok: true }, 200);
    });
  });

  // GET /workspaces/:workspaceId/members
  app.openapi(listWorkspaceMembersRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return withTenantRls(pgSql, c, async (repo, tx) => {
      const workspace = await repo.getWorkspace(workspaceId);
      if (!workspace || !(await inCallerTenant(c, tx, workspace))) {
        return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
      }

      const members = await repo.listWorkspaceMembers(workspaceId);
      return c.json(
        {
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role,
            joinedAt: toIso(m.joinedAt),
          })),
        },
        200
      );
    });
  });

  // DELETE /workspaces/:workspaceId/members/:userId
  app.openapi(removeWorkspaceMemberRoute, async (c) => {
    const { workspaceId, userId } = c.req.valid("param");
    const res = await withTenantRls(pgSql, c, async (repo, tx) => {
      const workspace = await repo.getWorkspace(workspaceId);
      if (!workspace || !(await inCallerTenant(c, tx, workspace))) {
        return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
      }

      await requireWorkspaceAdmin(repo, c, workspace);

      await repo.removeWorkspaceMember(workspaceId, userId);
      return c.json({ ok: true }, 200);
    });
    // The removal revoked the member's keys homed here; drop them, and the
    // cached role, from this process's auth caches now (after the commit).
    deps.userStatus?.invalidate(userId);
    forgetUserAuth(userId);
    return res;
  });

  // PATCH /workspaces/:workspaceId/members/:userId
  app.openapi(updateWorkspaceMemberRoleRoute, async (c) => {
    const { workspaceId, userId } = c.req.valid("param");
    const body = c.req.valid("json");
    return withTenantRls(pgSql, c, async (repo, tx) => {
      const workspace = await repo.getWorkspace(workspaceId);
      if (!workspace || !(await inCallerTenant(c, tx, workspace))) {
        return c.json({ error: "not_found", message: "Workspace not found" } as never, 404);
      }

      await requireWorkspaceAdmin(repo, c, workspace);

      await repo.updateWorkspaceMemberRole(workspaceId, userId, body.role);
      return c.json({ ok: true }, 200);
    });
  });
}
