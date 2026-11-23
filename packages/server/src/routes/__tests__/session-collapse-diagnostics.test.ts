/**
 * LIFECYCLE-14 — `GET /session/:id` answered with `status` only, so an agent
 * could not tell "collapse pending retry" from "never tried" from "gave up",
 * and a completed collapse did not say what it produced.
 */
import { describe, it, expect } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountRoutes } from "../index.js";
import { toErrorBody } from "../../errors.js";

function appWith(session: Record<string, unknown>) {
  const deps = {
    storage: { getSession: async () => session },
    telemetry: { startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }) },
  } as unknown as ServerDeps;
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 404 | 500);
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

async function collapseOf(session: Record<string, unknown>) {
  const res = await appWith(session).request("/session/s1");
  expect(res.status).toBe(200);
  return ((await res.json()) as { collapse: Record<string, unknown> }).collapse;
}

const base = {
  id: "s1",
  workspaceId: "ws",
  agentId: "agent",
  openedAt: new Date("2026-10-17T10:00:00Z"),
  turnCount: 6,
  tokenCount: 100,
};

describe("GET /session/:id collapse diagnostics", () => {
  it("shows the pending retry of a failed collapse", async () => {
    const collapse = await collapseOf({
      ...base,
      status: "active",
      collapseAttempts: 3,
      collapseNextAttemptAt: new Date("2026-10-17T11:20:00Z"),
      metadata: { collapseLastError: "llm_unavailable" },
    });

    expect(collapse).toMatchObject({
      attempts: 3,
      lastError: "llm_unavailable",
      nextAttemptAt: "2026-10-17T11:20:00.000Z",
      collapsedAt: null,
      episodeId: null,
    });
  });

  it("shows what a completed collapse produced", async () => {
    const collapse = await collapseOf({
      ...base,
      status: "collapsed",
      collapseAttempts: 0,
      collapsedAt: new Date("2026-10-17T12:00:00Z"),
      factCount: 4,
      collapseSummary: { episodeId: "ep-1", outcome: "resolved", turnsProcessed: 6 },
      metadata: {},
    });

    expect(collapse).toMatchObject({
      attempts: 0,
      lastError: null,
      collapsedAt: "2026-10-17T12:00:00.000Z",
      factCount: 4,
      episodeId: "ep-1",
      outcome: "resolved",
    });
  });

  it("says why the sweep gave up on a session", async () => {
    const collapse = await collapseOf({
      ...base,
      status: "archived",
      collapseAttempts: 8,
      metadata: { collapseLastError: "llm_unavailable", archiveReason: "collapse_failed" },
    });

    expect(collapse).toMatchObject({ attempts: 8, archiveReason: "collapse_failed" });
  });

  it("bounds a long stored error", async () => {
    const collapse = await collapseOf({
      ...base,
      status: "active",
      collapseAttempts: 1,
      metadata: { collapseLastError: "x".repeat(5000) },
    });

    expect((collapse.lastError as string).length).toBeLessThanOrEqual(501);
  });
});
