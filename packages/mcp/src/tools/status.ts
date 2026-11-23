import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_status` — snapshot de salud y disponibilidad del workspace de
 * memoria.
 *
 * FINDING (tool-promise audit, 2026-07-28): the JSDoc that used to live
 * here claimed `GET /health` "expone el estado individual de
 * sub-componentes (db, embedder, queue)". That is NOT what the server
 * returns. `client.health()` hits the authenticated `GET /health` route
 * (`mountVitals` in packages/server/src/routes/health.ts), which calls
 * `deps.core.vitals({workspaceId})` (packages/core/src/factory.ts) and
 * returns a workspace **vitals** snapshot — fact counts and embedding
 * backlog — never a `status`/`components` field for db, embedder, or
 * queue. The client-ts `HealthSnapshot` type (`status: "ok"|"degraded"|
 * "down"`, `components?: Record<string, ...>`) does not describe this
 * route's real wire shape either.
 *
 * FIXED (2026-07-31): the real per-dependency probe (postgres/vector/cache)
 * lives on `GET /health/ready` (unauthenticated, instance-wide — not
 * scoped to the caller's workspace), already exposed as
 * `client.healthReady()` but never called from here. Now wired in as a
 * best-effort 4th upstream call (swallowed to `null` on failure, same as
 * `getStats`/`getMe`, so an unreachable readiness probe doesn't fail the
 * whole tool) and surfaced under `dependencyHealth` in both the text and
 * `structuredContent`. Proven against a real Postgres instance in
 * `packages/server/src/__tests__/integration/status-vitals-nonsuperuser.integration.test.ts`.
 *
 * The scopeRef breakdown IS accurate — verified against real Postgres in
 * the same integration suite.
 *
 * SECOND FINDING (fixed 2026-07-29): the P10 personal-workspace section is
 * gated correctly in THIS file's own code (only shown when
 * `me.personalWorkspaceId` is set); the upstream value used to be broken in
 * any real deployment, because `GET /me`'s `personalWorkspaceId` resolution
 * (`getUserPersonalWorkspaceId` in packages/server/src/recall/multi-level.ts)
 * always threw Postgres error "infinite recursion detected in policy for
 * relation mnemo_workspace_member" — `mnemo_workspace`'s RLS read policy has
 * an EXISTS subquery against `mnemo_workspace_member`, whose OWN read policy
 * was self-referential (queried `mnemo_workspace_member` again in its own
 * USING clause) — and that error was silently swallowed to `null` by a
 * blanket try/catch, indistinguishable from "this user has no personal
 * workspace." Fixed in migration `0012_workspace_member_rls_recursion.sql`
 * (packages/adapter-postgres/migrations/baseline/) by replacing the
 * self-referential subquery with a `SECURITY DEFINER` helper function that
 * evaluates membership without re-triggering the same RLS policy. Proven
 * fixed against real Postgres, NOSUPERUSER role, in the same integration
 * suite this finding was originally proven in.
 *
 * No requiere parámetros — es un GET sin query string.
 */
export function registerStatus(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  server.registerTool(
    "memory_status",
    {
      title: "Memory workspace status",
      inputSchema: {},
    },
    async () => {
      try {
        const [health, stats, me, readiness] = await Promise.all([
          client.health(),
          client.getStats().catch(() => null),
          client.getMe().catch(() => null),
          (typeof client.healthReady === "function"
            ? client.healthReady()
            : Promise.resolve(null)
          ).catch(() => null),
        ]);

        const scopeBreakdown = stats?.facts?.byScopeRef ?? [];
        const scopeText =
          scopeBreakdown.length > 0
            ? `\n\n${t(locale, "out.memory_status.byScopeRef")}\n${scopeBreakdown.map((s) => `  ${s.scopeRef}: ${s.count}`).join("\n")}`
            : "";

        // Personal workspace section (P10) — only when userId is known
        const meData = me as Record<string, unknown> | null;
        const personalWorkspaceId = meData?.personalWorkspaceId as string | null | undefined;
        const personalFactsLive = meData?.personalFactsLive as number | null | undefined;
        const personalText = personalWorkspaceId
          ? `\n\n${t(locale, "out.memory_status.personal", { workspaceId: personalWorkspaceId, n: personalFactsLive ?? 0 })}`
          : "";

        const personal = personalWorkspaceId
          ? { workspaceId: personalWorkspaceId, factsLive: personalFactsLive ?? 0 }
          : undefined;

        // Real per-dependency status (postgres/vector/cache), instance-wide.
        const readinessText = readiness
          ? `\n\n${t(locale, "out.memory_status.dependencyHealth", { status: readiness.status })}${readiness.degraded ? t(locale, "out.memory_status.degraded") : ""}${
              readiness.checks
                ? `\n${Object.entries(readiness.checks)
                    .map(([k, v]) => `  ${k}: ${v}`)
                    .join("\n")}`
                : ""
            }${readiness.reason ? `\n  reason: ${readiness.reason}` : ""}`
          : "";

        return {
          content: [
            {
              type: "text",
              text: jsonText(health) + scopeText + personalText + readinessText,
            },
          ],
          structuredContent: {
            ...(health as unknown as { [key: string]: unknown }),
            factsByScopeRef: scopeBreakdown,
            ...(personal ? { personal } : {}),
            ...(readiness ? { dependencyHealth: readiness } : {}),
          },
        };
      } catch (err) {
        return formatMcpError("memory_status", err, locale);
      }
    }
  );
}
