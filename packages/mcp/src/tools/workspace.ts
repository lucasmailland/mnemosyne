import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_workspace` — consultar y gestionar workspaces.
 *
 * 8 actions (M1, multi-tenancy closure plan): `list`, `describe`, `members`,
 * `current`, `create`, `invite`, `set_role`, `remove`.
 *
 * The 4 mutating actions (`create`, `invite`, `set_role`, `remove`) are safe
 * to register UNCONDITIONALLY — the server's workspace-role scope narrowing
 * (S1-S4, `@mnemo-ai/types`'s `WORKSPACE_ROLE_SCOPES`) means a `read`/`write`
 * role genuinely cannot reach them; the server 403s, this tool just surfaces
 * that. There is deliberately NO action here that switches the active
 * workspace mid-session — see this tool's own workspace-identity note below
 * and `memory_context`'s header comment for why.
 *
 * FIXED (2026-07-31): action='list' cae a 'workspaces del tenant' solo cuando
 * el usuario no pertenece a ninguno propio. Ese fallback (`client.
 * listWorkspacesForCurrentTenant()`) lee `tenantId` de `GET /me`, que hasta
 * ahora nunca lo devolvía (`server/src/routes/keys.ts`'s `MeResponseSchema`
 * carecía del campo, aunque ya estaba resuelto en el contexto de auth).
 * Fixed: `/me` ahora incluye `tenantId` (null si la key no tiene tenant
 * asociado), así que el fallback funciona de verdad.
 */
export function registerWorkspace(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_workspace",
    {
      title: "Workspace management",
      inputSchema: {
        action: z
          .enum([
            "list",
            "describe",
            "members",
            "current",
            "create",
            "invite",
            "set_role",
            "remove",
          ])
          .default("list")
          .describe(d("fields.memory_workspace.action")),
        workspaceId: z.string().optional().describe(d("fields.memory_workspace.workspaceId")),
        userId: z.string().optional().describe(d("fields.memory_workspace.userId")),
        role: z
          .enum(["owner", "admin", "write", "read"])
          .optional()
          .describe(d("fields.memory_workspace.role")),
        name: z.string().optional().describe(d("fields.memory_workspace.name")),
        slug: z.string().optional().describe(d("fields.memory_workspace.slug")),
        visibility: z
          .enum(["private", "public"])
          .optional()
          .describe(d("fields.memory_workspace.visibility")),
        ownerUserId: z.string().optional().describe(d("fields.memory_workspace.ownerUserId")),
        tenantId: z.string().optional().describe(d("fields.memory_workspace.tenantId")),
      },
    },
    async ({
      action,
      workspaceId,
      userId,
      role,
      name,
      slug,
      visibility,
      ownerUserId,
      tenantId,
    }) => {
      try {
        if (action === "describe") {
          if (!workspaceId) return missingArg(locale, "workspaceId", "describe");
          const workspace = await client.getWorkspaceById(workspaceId);
          return ok({ workspace });
        }

        if (action === "members") {
          if (!workspaceId) return missingArg(locale, "workspaceId", "members");
          const members = await client.listWorkspaceMembers(workspaceId);
          return ok({ workspaceId, members });
        }

        if (action === "current") {
          const me = await client.getMe();
          return {
            content: [{ type: "text", text: jsonText(me) }],
            structuredContent: me as unknown as { [key: string]: unknown },
          };
        }

        if (action === "create") {
          if (!name) return missingArg(locale, "name", "create");
          let resolvedTenantId = tenantId;
          if (!resolvedTenantId) {
            const me = await client.getMe();
            if (!me.tenantId) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: t(locale, "out.memory_workspace.noTenant"),
                  },
                ],
              };
            }
            resolvedTenantId = me.tenantId;
          }
          const workspace = await client.createWorkspace(resolvedTenantId, {
            name,
            ...(slug ? { slug } : {}),
            ...(visibility ? { visibility } : {}),
            ...(ownerUserId ? { ownerUserId } : {}),
          });
          return ok({ workspace });
        }

        if (action === "invite") {
          if (!workspaceId) return missingArg(locale, "workspaceId", "invite");
          if (!userId) return missingArg(locale, "userId", "invite");
          const result = await client.inviteWorkspaceMember(workspaceId, {
            userId,
            ...(role ? { role } : {}),
          });
          return ok(result);
        }

        if (action === "set_role") {
          if (!workspaceId) return missingArg(locale, "workspaceId", "set_role");
          if (!userId) return missingArg(locale, "userId", "set_role");
          if (!role) return missingArg(locale, "role", "set_role");
          const result = await client.updateWorkspaceMemberRole(workspaceId, userId, role);
          return ok(result);
        }

        if (action === "remove") {
          if (!workspaceId) return missingArg(locale, "workspaceId", "remove");
          if (!userId) return missingArg(locale, "userId", "remove");
          const result = await client.removeWorkspaceMember(workspaceId, userId);
          return ok(result);
        }

        // Action "list" (default)
        const myWorkspaces = await client.listMyWorkspaces();
        const tenantWorkspaces =
          myWorkspaces.length === 0 ? await client.listWorkspacesForCurrentTenant() : [];
        const workspaces = myWorkspaces.length > 0 ? myWorkspaces : tenantWorkspaces;

        return ok({ workspaces });
      } catch (err) {
        return formatMcpError("memory_workspace", err, locale);
      }
    }
  );
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: jsonText(data) }],
    structuredContent: data,
  };
}

function missingArg(locale: Locale, argName: string, action: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: t(locale, "out.memory_workspace.paramRequired", { param: argName, action }),
      },
    ],
  };
}
