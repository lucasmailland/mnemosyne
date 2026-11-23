import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { invalidateAgentPolicy } from "../middleware/rbac-policy.js";
import type { Context } from "hono";
import { SPEC_SCOPES, type AccessPolicyStore } from "@mnemo-ai/types";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { ForbiddenError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * §19 agent RBAC policies: read, list, create-or-replace and delete the policy
 * the RBAC middleware (middleware/rbac-policy.ts) enforces for one agent.
 *
 * The agent id travels in the query string or the body, never in the path:
 * the scope table (app-scope.ts) matches path substrings, so an agent id like
 * "recall" or "ws-bot" in the path would change the scope a request needs.
 * Both paths fall under the `/admin` rule (memory:admin).
 *
 * The workspace always comes from the credential; a body naming one is
 * rejected by the strict schema. The middleware caches each policy for 60 s
 * per process, so a change reaches an agent within that window.
 */

const scope = z.enum(SPEC_SCOPES);
const agentId = z.string().min(1).max(200);
const shortList = z.array(z.string().min(1).max(200)).max(100);

const PolicyBodySchema = z
  .object({
    agentId,
    readScopes: z.array(scope),
    writeScopes: z.array(scope),
    selfEdit: z
      .object({ enabled: z.boolean(), maxWorthDelta: z.number().finite().optional() })
      .strict(),
    taskScopes: z
      .object({ canCreate: z.boolean(), canDelegate: z.boolean(), canDelegateTo: shortList })
      .strict(),
    limits: z
      .object({
        maxRecallsPerMinute: z.number().int().min(0),
        maxWritesPerMinute: z.number().int().min(0),
        maxSessionsConcurrent: z.number().int().min(0),
        maxSelfEditsPerSession: z.number().int().min(0),
      })
      .strict(),
    requireApprovalFor: z.array(
      z.enum([
        "delete_fact",
        "overwrite_decision",
        "write_entity",
        "cross_agent_read",
        "bulk_export",
        "federation_share",
        "procedural_evolution",
        "task_delegation",
      ])
    ),
    federationAccess: z.enum(["none", "read", "read_write"]),
    namespaces: shortList.optional(),
  })
  .strict()
  .openapi("AgentPolicyInput");

const PolicySchema = PolicyBodySchema.extend({ workspaceId: z.string() }).openapi("AgentPolicy");
const AgentQuerySchema = z.object({ agentId });

const listRoute = createRoute({
  method: "get",
  path: "/admin/agent-policies",
  tags: ["admin"],
  summary: "List the RBAC policies of every agent in the workspace.",
  responses: {
    200: {
      description: "Policies, ordered by agent id.",
      content: { "application/json": { schema: z.object({ policies: z.array(PolicySchema) }) } },
    },
    503: { description: "No database: agent policies are unavailable." },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/admin/agent-policy",
  tags: ["admin"],
  summary: "Read the RBAC policy of one agent (its API key id).",
  request: { query: AgentQuerySchema },
  responses: {
    200: { description: "The policy.", content: { "application/json": { schema: PolicySchema } } },
    404: { description: "The agent has no policy in this workspace." },
    503: { description: "No database: agent policies are unavailable." },
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/admin/agent-policy",
  tags: ["admin"],
  summary: "Create or replace the RBAC policy of one agent in the workspace.",
  request: {
    body: { content: { "application/json": { schema: PolicyBodySchema } }, required: true },
  },
  responses: {
    200: {
      description: "The stored policy.",
      content: { "application/json": { schema: PolicySchema } },
    },
    400: { description: "Validation error." },
    403: { description: "A key cannot change its own policy." },
    503: { description: "No database: agent policies are unavailable." },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/admin/agent-policy",
  tags: ["admin"],
  summary: "Delete the RBAC policy of one agent (it falls back to the workspace default).",
  request: { query: AgentQuerySchema },
  responses: {
    204: { description: "Policy deleted." },
    403: { description: "A key cannot change its own policy." },
    404: { description: "The agent has no policy in this workspace." },
    503: { description: "No database: agent policies are unavailable." },
  },
});

function store(deps: ServerDeps): AccessPolicyStore {
  if (!deps.accessPolicies) {
    throw new ServiceUnavailableError(
      "Agent policies are unavailable: the policy store is not configured"
    );
  }
  return deps.accessPolicies;
}

export function mountAdminAgentPolicies(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // A restricted agent holding memory:admin must not lift its own limits.
  function assertNotSelf(actorId: string | undefined, target: string): void {
    if (actorId === target) {
      throw new ForbiddenError("A key cannot change its own RBAC policy");
    }
  }

  async function audit(
    c: Context<{ Variables: AuthVariables }>,
    method: "PUT" | "DELETE",
    target: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: c.get("workspaceId"),
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "admin_access",
      resourceKind: "agent_policy",
      resourceId: target,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        route: "/admin/agent-policy",
        method,
        ...detail,
      },
    });
  }

  app.openapi(listRoute, async (c) => {
    const policies = await store(deps).listPolicies(c.get("workspaceId"));
    return c.json({ policies }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const { agentId: target } = c.req.valid("query");
    const policy = await store(deps).getPolicy(c.get("workspaceId"), target);
    if (!policy) throw new NotFoundError(`No RBAC policy for agent '${target}'`);
    return c.json(policy, 200);
  });

  app.openapi(putRoute, async (c) => {
    const body = c.req.valid("json");
    const policies = store(deps);
    assertNotSelf(c.get("actorId"), body.agentId);
    const policy = { ...body, workspaceId: c.get("workspaceId") };
    await policies.putPolicy(policy);
    await invalidateAgentPolicy(policy.workspaceId, body.agentId);
    await audit(c, "PUT", body.agentId, { policy: body });
    return c.json(policy, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { agentId: target } = c.req.valid("query");
    const policies = store(deps);
    assertNotSelf(c.get("actorId"), target);
    const deleted = await policies.deletePolicy(c.get("workspaceId"), target);
    if (!deleted) throw new NotFoundError(`No RBAC policy for agent '${target}'`);
    await invalidateAgentPolicy(c.get("workspaceId"), target);
    await audit(c, "DELETE", target);
    return new Response(null, { status: 204 });
  });
}
