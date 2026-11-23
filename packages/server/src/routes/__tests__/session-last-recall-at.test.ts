/**
 * autonomous-memory Requirement 1/4 — GET /session/:id and GET /session/list
 * expose lastRecallAt (read from session.metadata.lastRecallAt, written by
 * POST /recall's recordSessionRecall best-effort stamp) so a compliance
 * check can confirm recall happened during a given session without needing
 * to know about the metadata bag's internal shape.
 */
import { describe, it, expect, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountRoutes } from "../index.js";
import { toErrorBody } from "../../errors.js";

function buildApp(deps: ServerDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
  });
  const v1 = new OpenAPIHono<{ Variables: AuthVariables }>();
  v1.use("*", async (c, next) => {
    c.set("workspaceId", "ws");
    c.set("actorId", "tester");
    await next();
  });
  mountRoutes(v1, deps);
  app.route("/", v1);
  return app;
}

describe("GET /session/:id — lastRecallAt", () => {
  it("returns lastRecallAt when metadata.lastRecallAt is set", async () => {
    const getSession = vi.fn(async () => ({
      id: "sess-1",
      workspaceId: "ws",
      agentId: "agent-1",
      status: "active",
      openedAt: new Date("2026-07-31T00:00:00Z"),
      label: null,
      metadata: { lastRecallAt: "2026-07-31T01:23:45.000Z" },
      turnCount: 0,
      tokenCount: 0,
      scratch: {},
    }));
    const deps = { storage: { getSession } } as unknown as ServerDeps;
    const app = buildApp(deps);

    const res = await app.request("/session/sess-1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lastRecallAt).toBe("2026-07-31T01:23:45.000Z");
  });

  it("returns lastRecallAt: null when no recall has been correlated yet", async () => {
    const getSession = vi.fn(async () => ({
      id: "sess-1",
      workspaceId: "ws",
      agentId: "agent-1",
      status: "active",
      openedAt: new Date("2026-07-31T00:00:00Z"),
      label: null,
      metadata: {},
      turnCount: 0,
      tokenCount: 0,
      scratch: {},
    }));
    const deps = { storage: { getSession } } as unknown as ServerDeps;
    const app = buildApp(deps);

    const res = await app.request("/session/sess-1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lastRecallAt).toBeNull();
  });
});

describe("GET /session/list — lastRecallAt", () => {
  it("includes lastRecallAt per session", async () => {
    const listSessions = vi.fn(async () => [
      {
        id: "sess-1",
        workspaceId: "ws",
        agentId: "agent-1",
        status: "collapsed",
        openedAt: new Date("2026-07-31T00:00:00Z"),
        label: null,
        metadata: { lastRecallAt: "2026-07-31T02:00:00.000Z" },
        turnCount: 0,
        tokenCount: 0,
        scratch: {},
      },
    ]);
    const deps = { storage: { listSessions } } as unknown as ServerDeps;
    const app = buildApp(deps);

    const res = await app.request("/session/list");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions[0].lastRecallAt).toBe("2026-07-31T02:00:00.000Z");
  });
});
