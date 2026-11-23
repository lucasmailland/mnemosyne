import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_context` — identidad completa de la sesión actual.
 *
 * El agente debe llamar esta tool al inicio de sesión para entender:
 *   - En qué workspace está trabajando, y qué ROL tiene ahí (owner/admin/
 *     write/read) — el rol determina el techo real de lo que puede hacer,
 *     independientemente de los scopes crudos de la key/token.
 *   - Qué usuario y tenant está detrás de la key
 *   - Qué otros workspaces son sus propias membresías (`memory_workspace
 *     action='list'` es la fuente autoritativa para esto; acá se incluye
 *     un resumen liviano)
 *   - Stats rápidos del workspace activo
 *
 * WORKSPACE IDENTITY ES FIJA PARA TODA LA SESIÓN (M2/M4, closing the
 * multi-tenancy gaps): el workspace activo lo fija la API key/token al
 * arrancar el proceso — no hay, y no debe haber, ningún tool que lo
 * cambie a mitad de sesión (cambiar de workspace en medio de una tarea
 * fragmentaría silenciosamente la memoria del agente: escribe en B,
 * después recuerda desde A, y nunca se entera). Si necesitas trabajar en
 * otro workspace, inicia una sesión nueva con la key/token correspondiente
 * (o, si tu key es un `uk_live_*` user token, con `X-Workspace-Id` fijado
 * ANTES de tu primer tool call, vía `MNEMO_WORKSPACE_ID`).
 *
 * FIXED (2026-07-31, RLS recursion): the earlier version of this tool's
 * own header comment documented a `memory_remember(..., workspaceId=...)`
 * parameter that never existed on that tool — removed. Primary source for
 * "what workspaces am I in" switched from `listWorkspacesForCurrentTenant()`
 * (which lists the TENANT's workspaces, not the caller's own memberships)
 * to `listMyWorkspaces()`; the tenant listing is now only a labelled
 * fallback for a caller with zero personal workspace memberships.
 */
export function registerContext(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_context",
    {
      title: "Memory session context",
      inputSchema: {
        includeStats: z
          .boolean()
          .optional()
          .default(true)
          .describe(d("fields.memory_context.includeStats")),
        includeOtherWorkspaces: z
          .boolean()
          .optional()
          .default(true)
          .describe(d("fields.memory_context.includeOtherWorkspaces")),
      },
    },
    async ({ includeStats, includeOtherWorkspaces }) => {
      try {
        const [me, stats] = await Promise.all([
          client.getMe(),
          includeStats !== false ? client.getStats() : Promise.resolve(null),
        ]);

        let workspaces: unknown[] | null = null;
        let workspacesSource: "membership" | "tenant_fallback" | null = null;
        if (includeOtherWorkspaces !== false) {
          const myWorkspaces = await client.listMyWorkspaces();
          if (myWorkspaces && myWorkspaces.length > 0) {
            workspaces = myWorkspaces;
            workspacesSource = "membership";
          } else {
            const tenantWorkspaces = await client.listWorkspacesForCurrentTenant();
            if (tenantWorkspaces && tenantWorkspaces.length > 0) {
              workspaces = tenantWorkspaces;
              workspacesSource = "tenant_fallback";
            }
          }
        }

        const context: Record<string, unknown> = {
          workspace: me
            ? {
                id: me.workspaceId,
                name: me.workspaceName ?? null,
                keyPrefix: me.keyPrefix,
                plan: me.plan,
                role: me.workspaceRole ?? null,
              }
            : null,
        };

        if (me?.keyId)
          context.key = {
            id: me.keyId,
            actorType: me.actorType,
            scopes: me.scopes,
            expiresAt: me.expiresAt,
          };
        if (me?.userId) {
          context.user = {
            id: me.userId,
            ...(me.personalWorkspaceId ? { personalWorkspaceId: me.personalWorkspaceId } : {}),
          };
          if (me.personalWorkspaceId) context.personalWorkspaceId = me.personalWorkspaceId;
        }
        if (me?.tenantId) context.tenant = { id: me.tenantId };

        if (stats) {
          context.stats = {
            factsLive: stats.facts?.live ?? 0,
            factsPinned: stats.facts?.pinned ?? 0,
            lastRecallAt: stats.recall?.lastRecallAt ?? null,
            hitRate30d: stats.recall?.hitRate30d ?? null,
          };
        }

        if (workspaces && workspaces.length > 0) {
          context.otherWorkspaces = workspaces;
          context.otherWorkspacesSource = workspacesSource;
        }

        context._note = t(locale, "out.memory_context.note");

        if (me?.workspaceRole === "read") {
          context._roleNote = t(locale, "out.memory_context.roleNote");
        }

        return {
          content: [{ type: "text", text: jsonText(context) }],
          structuredContent: context as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_context", err, locale);
      }
    }
  );
}
