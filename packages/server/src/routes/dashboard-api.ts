/**
 * Dashboard data bridge — /dashboard/api/*.
 *
 * The browser dashboard authenticates with the mnemo_dash_token session
 * cookie and never holds the raw API key, so it cannot call the bearer-gated
 * v1 surface directly. This bridge re-mounts the route modules the dashboard
 * consumes on a sub-router whose auth is the session cookie:
 *
 *   cookie JWT ──verify──▶ live checks ──▶ AuthVariables (workspaceId/scopes/
 *   plan) ──▶ scope guard (same rule table as v1) ──▶ the same route handlers.
 *
 * Writes (anything but GET/HEAD) whose Sec-Fetch-Site header is present and is
 * neither same-origin nor none are refused with 403 invalid_origin (CSRF).
 *
 * Live checks (resolveLiveSession): for password sessions the user status
 * (disabled, sessions_valid_after, superadmin) and the role in the session
 * workspace are read on every request, and the scopes come from that role,
 * never from the JWT. A demotion or removal applies on the next request.
 *
 * The handlers read workspaceId/scopes via getAuthCtx, so RLS scoping and
 * sensitivity ceilings behave identically to bearer calls. Rate-limit /
 * idempotency / RBAC agent policies are intentionally not applied — this is
 * human, same-origin, session-gated traffic (V1; revisit if exposed wider).
 */
import type { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { ForbiddenError, HttpError } from "../errors.js";
import { decideScopeAccess, legacyFullScopeAllowed } from "../middleware/scopeGuard.js";
import { logger } from "../logging.js";
import { getScopeForRequest } from "../app-scope.js";
import {
  DASHBOARD_COOKIE,
  readDashboardSecret,
  verifyDashboardToken,
} from "../dashboard-session.js";
import { resolveLiveSession } from "../dashboard-live-session.js";
import { createWorkspaceRegionLookup, regionLockMiddleware } from "../middleware/region.js";

import { mountAdminLlmConfig } from "./admin-llm-config.js";
import { mountAdminRetention } from "./admin-retention.js";
import { mountAdminStats } from "./admin-stats.js";
import { mountAdminEmbeddingMigrations } from "./admin-embedding-migrations.js";
import { mountTimeline } from "./timeline.js";
import { mountFacts } from "./facts.js";
import { mountDecisions } from "./decisions.js";
import { mountEntities } from "./entities.js";
import { mountEpisodes } from "./episodes.js";
import { mountRecall } from "./recall.js";
import { mountConflicts } from "./conflicts.js";
import { mountRecallTiering } from "./recallTiering.js";
import { mountGraph } from "./graph.js";
import { mountRelations } from "./relations.js";
import { mountAudit } from "./audit.js";
import { mountDoctor } from "./doctor.js";
import { mountKeys } from "./keys.js";
import { mountWorkspaceConfig } from "./workspace-config.js";
import { mountWorkspaceMode } from "./workspace-mode.js";
import { mountCognitiveHealth, mountHealthHistory, mountVitals } from "./health.js";
import { mountAggregates } from "./aggregates.js";
import { buildUsageRouter } from "./usage.js";
import { instanceGuard, mountInstance } from "./instance.js";
import { mountMyWorkspaces } from "./my-workspaces.js";
import { mountWorkspaceMembers } from "./workspace-members.js";

const BODY_LIMIT_BYTES = 1 * 1024 * 1024;

export function mountDashboardApi(app: Hono, deps: ServerDeps): void {
  const secret = readDashboardSecret();
  if (!secret) return; // dashboard disabled — mountDashboardAuth already logged it.

  const api = new OpenAPIHono<{ Variables: AuthVariables }>();

  api.use("*", bodyLimit({ maxSize: BODY_LIMIT_BYTES }));

  // 0. CSRF: the session cookie rides along on any request the browser sends,
  //    so a write the browser marks as coming from another site, or from a
  //    sibling subdomain (same-site), is refused before the session is read.
  //    Same answer as /dashboard/auth/*. Requests without the header (non-browser
  //    clients, older browsers) and reads are not affected.
  api.use("*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      const site = c.req.header("sec-fetch-site");
      if (site !== undefined && site !== "same-origin" && site !== "none")
        return c.json({ error: "invalid_origin" }, 403);
    }
    return next();
  });

  // 1. Session cookie → AuthVariables. The bridge serves fetch() calls only,
  //    so an invalid/absent session is always a JSON 401 (the HX-Redirect
  //    header lets HTMX-style callers bounce to login without extra code).
  api.use("*", async (c, next) => {
    const token = getCookie(c, DASHBOARD_COOKIE);
    const payload = token ? await verifyDashboardToken(secret, token) : null;
    if (!payload) {
      c.header("HX-Redirect", "/dashboard/login");
      return c.json({ error: "no_session" }, 401);
    }
    let live;
    try {
      live = await resolveLiveSession(deps, payload);
    } catch (err) {
      // Fail closed: an unverifiable session is never treated as allowed.
      const code = (err as { code?: unknown } | null)?.code;
      logger.warn(
        {
          errorCode: typeof code === "string" ? code : err instanceof Error ? err.name : "unknown",
        },
        "dashboard.bridge: live session checks unavailable"
      );
      return c.json(
        { error: "auth_unavailable", message: "Authentication service unavailable" },
        503
      );
    }
    if (!live) {
      c.header("HX-Redirect", "/dashboard/login");
      return c.json({ error: "no_session" }, 401);
    }
    c.set("workspaceId", live.workspaceId);
    c.set("apiKeyPrefix", payload.keyPrefix);
    c.set("scopes", live.scopes as ReadonlyArray<string>);
    if (live.role) c.set("workspaceRole", live.role);
    c.set("plan", (payload.plan || "free") as "free" | "pro" | "enterprise");
    c.set("actorType", "user");
    // Bare principal id. resolveProvenance() owns the namespace, with
    // password sessions identifying a user instead of an API key.
    c.set("actorId", payload.actorId);
    if (payload.authMethod === "password") c.set("actorRefKind", "user");
    if (payload.userId) c.set("userId", payload.userId);
    // Live, never from the token: resolveLiveSession read it on this request.
    c.set("instanceSuperadmin", payload.authMethod === "password" && live.isSuperadmin);
    return next();
  });

  // 1a. §35 data residency, as on v1: a session workspace pinned to another
  //     region gets 403 wrong_region.
  api.use(
    "*",
    regionLockMiddleware(
      deps.metricsPgClient
        ? { lookupRegion: createWorkspaceRegionLookup(deps.metricsPgClient) }
        : {}
    )
  );

  // 1b. The instance plane answers anyone but a live superadmin with the 404 of
  //     an unknown route, before the scope guard could answer 403 (anti-probing).
  api.use("/instance/*", instanceGuard());

  // 2. Same deny-by-default scope guard as the v1 surface. The rule table
  //    matches on substrings (path.includes), so the /dashboard/api prefix
  //    does not change which rule fires.
  const allowLegacyFullScope = legacyFullScopeAllowed();
  api.use("*", async (c, next) => {
    const scopes = c.get("scopes") as ReadonlyArray<string> | undefined;
    const required = getScopeForRequest(c.req.method, c.req.path);
    const decision = decideScopeAccess(scopes, required, { allowLegacyFullScope });
    if (!decision.allowed) {
      if (decision.code === "INSUFFICIENT_SCOPE") {
        throw new HttpError(
          403,
          "INSUFFICIENT_SCOPE",
          decision.reason ?? "Session scope insufficient"
        );
      }
      throw new ForbiddenError(decision.reason ?? "Session scope insufficient");
    }
    return next();
  });

  // 3. The data surface the dashboard pages consume (spec §4).
  mountAdminLlmConfig(api, deps);
  mountAdminRetention(api, deps);
  mountAdminStats(api, deps); //      Home metric strip (/admin/stats)
  mountAdminEmbeddingMigrations(api, deps);
  mountTimeline(api, deps); //        Home activity feed (/timeline)
  mountVitals(api, deps); //          Health page vitals (GET /health)
  mountCognitiveHealth(api, deps); // Home (/health/cognitive)
  mountHealthHistory(api, deps); //   Health page readiness history (/health/history)
  mountAggregates(api, deps); //      rooms' figures (/recall/metrics, /facts/stats, ...); before mountFacts
  mountFacts(api, deps); //           Memory Browser (facts CRUD + pin + restore)
  mountDecisions(api, deps); //       Memory Browser (decisions tab)
  mountEntities(api, deps); //        Memory Browser (entities tab)
  mountEpisodes(api, deps); //        Sessions browser
  mountRecall(api, deps); //          Recall Playground
  mountConflicts(api, deps); //       Conflicts queue (list + resolve)
  mountRecallTiering(api, deps); //   Recall explain (also /recall/hot, /recall/unified)
  mountGraph(api, deps); //           Relation Graph
  mountRelations(api, deps); //       Detail drawer related-memories
  mountAudit(api, deps); //           Audit Log
  mountDoctor(api, deps); //          Health page (/doctor)
  mountKeys(api, deps); //            Admin key management (/admin/keys, /me)
  mountWorkspaceConfig(api, deps); // Config page (/config/llm)
  mountWorkspaceMode(api, deps); //   Config page (/workspace-mode)
  mountInstance(api, deps); //        Instance plane, superadmins only (/instance/*)
  mountMyWorkspaces(api, deps); //    Own workspaces: list, create, switch (/my-workspaces)
  mountWorkspaceMembers(api, deps); // Members and invitations (/workspace/members, /workspace/invitations)
  api.route(
    "/usage", //                        Home plan usage (GET /usage), the same router as /usage on v1
    buildUsageRouter({
      storage: deps.storage as {
        getMonthToDateUsageFromDb?(workspaceId: string): Promise<Record<string, number>>;
      },
    })
  );

  app.route("/dashboard/api", api);
  logger.info("mountDashboardApi: session-cookie data bridge mounted at /dashboard/api/*");
}
