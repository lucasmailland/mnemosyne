/**
 * F2 — HTTP collapse handler must thread the per-agent CollapsePolicy resolved
 * from the session's agent profile into deps.cognitive.collapseSession instead
 * of letting hardcoded defaults govern collapse.
 *
 * The route is /session/{id}/collapse mounted by mountSession.
 *
 * flatten-legacy-dual-core PR16: updated from `deps.core.collapseSession` to
 * `deps.cognitive.collapseSession` — the route now calls the v3 `MnemoCore`
 * facade instead of the legacy `CoreLike` client. No assertion changed.
 */
import { describe, it, expect, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountRoutes } from "../index.js";
import { toErrorBody } from "../../errors.js";

describe("HTTP collapse handler threads agent CollapsePolicy (F2)", () => {
  it("resolves the session's agent profile and forwards its CollapsePolicy", async () => {
    const seenPolicies: Array<unknown> = [];
    const collapseSession = vi.fn(async (args: { policy?: unknown }) => {
      seenPolicies.push(args.policy);
      return { turnsProcessed: 4, anticipationAccuracy: null };
    });
    const getSession = vi.fn(async () => ({ id: "s1", workspaceId: "ws", agentId: "agent-x" }));
    const getAgentProfile = vi.fn(async () => ({
      workspaceId: "ws",
      agentId: "agent-x",
      summary: "",
      metadata: { collapsePolicy: { maxTurns: 5, requirePin: true } },
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }));

    const deps = {
      cognitive: { collapseSession },
      storage: { getSession, getAgentProfile },
      telemetry: {
        startSpan: () => ({
          setAttribute() {},
          setStatus() {},
          end() {},
        }),
      },
    } as unknown as ServerDeps;

    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err, undefined);
      return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
    });
    const v1 = new OpenAPIHono<{ Variables: AuthVariables }>();
    // Bypass auth — inject workspaceId + actorId the way the auth middleware does.
    v1.use("*", async (c, next) => {
      c.set("workspaceId", "ws");
      c.set("actorId", "tester");
      await next();
    });
    mountRoutes(v1, deps);
    app.route("/", v1);

    const res = await app.request("/session/s1/collapse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    expect(getAgentProfile).toHaveBeenCalledWith("ws", "agent-x");
    expect(seenPolicies[0]).toMatchObject({ maxTurns: 5, requirePin: true, maxTokens: 8192 });
  });
});
