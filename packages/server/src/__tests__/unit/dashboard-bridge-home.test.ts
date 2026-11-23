/**
 * Home's reads on the dashboard bridge: plan usage, the cognitive snapshot and the two
 * aggregates, through a password-session cookie for a read member (scopes come from the
 * live role), answering like their bearer twins.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { mountDashboardApi } from "../../routes/dashboard-api.js";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import { mintDashboardToken } from "../../dashboard-session.js";
import { UserStatusService } from "../../user-status.js";
import { toErrorBody } from "../../errors.js";
import type { ServerDeps } from "../../deps.js";

const SECRET = "dashboard-bridge-phase2-secret-32-bytes!";
const USER = "user-1";
const WS = "00000000-0000-0000-0000-0000000000b5";

beforeEach(() => vi.stubEnv("MNEMO_DASHBOARD_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

async function cookie() {
  const { token } = await mintDashboardToken(SECRET, {
    workspaceId: WS,
    keyPrefix: "password",
    scopes: [],
    plan: "free",
    actorId: USER,
    userId: USER,
    authMethod: "password",
  });
  return `mnemo_dash_token=${token}`;
}

async function setup(role: "read" | "write" | "admin") {
  const storage = new InMemoryStorageAdapter();
  const query = vi.fn(async (strings: TemplateStringsArray) =>
    strings.join("?").includes("mnemo_workspace_member") ? [{ role }] : []
  );
  const deps = {
    storage,
    cognitive: {
      recall: vi.fn(async () => ({
        hits: [
          {
            id: "h1",
            content: "hit",
            primitive: "fact",
            score: 0.9,
            injectionScore: 0.5,
            provenance: "user",
            contested: false,
          },
        ],
        fromHotTier: false,
      })),
    },
    userStatus: new UserStatusService(
      {
        load: async () => ({
          disabledAt: null,
          sessionsValidAfter: new Date(0),
          isSuperadmin: false,
        }),
      },
      { ttlMs: 0 }
    ),
    metricsPgClient: { begin: vi.fn(async (fn: (sql: typeof query) => unknown) => fn(query)) },
  } as unknown as ServerDeps;
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400);
  });
  mountDashboardAuth(app, deps);
  mountDashboardApi(app, deps);
  const c = await cookie();
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    app.request(`/dashboard/api${path}`, {
      method,
      headers: { cookie: c, "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { storage, call };
}

describe("dashboard bridge, Home reads", () => {
  it.each([
    "/usage",
    "/health/cognitive",
    "/recall/metrics",
    "/facts/stats",
    "/graph/stats",
    "/session/stats",
    "/audit/stats",
    "/me/activity",
  ])("GET %s answers 200 to a read member", async (path) => {
    const { call } = await setup("read");
    const res = await call("GET", path);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it.each(["/health/snapshots", "/health/history"])(
    "GET %s is refused to a read member and answers an admin",
    async (path) => {
      const read = await setup("read");
      const denied = await read.call("GET", path);
      expect(denied.status).toBe(403);
      const admin = await setup("admin");
      const res = await admin.call("GET", path);
      expect(res.status, await res.clone().text()).toBe(200);
    }
  );

  it("/usage reports every metered resource against the session plan", async () => {
    const { call } = await setup("read");
    const body = (await (await call("GET", "/usage")).json()) as {
      plan: string;
      metrics: Record<string, { used: number; limit: number }>;
    };
    expect(body.plan).toBe("free");
    expect(body.metrics.recall).toMatchObject({ used: 0, limit: 1000 });
  });

  it("/recall/metrics takes 7 to 90 days, 30 by default", async () => {
    const { call } = await setup("read");
    const body = (await (await call("GET", "/recall/metrics")).json()) as { days: unknown[] };
    expect(body.days).toHaveLength(30);
    expect((await call("GET", "/recall/metrics?days=7")).status).toBe(200);
    expect((await call("GET", "/recall/metrics?days=6")).status).toBe(400);
    expect((await call("GET", "/recall/metrics?days=91")).status).toBe(400);
  });

  it("/facts/stats is not shadowed by GET /facts/{id} and counts the workspace's live facts", async () => {
    const { storage, call } = await setup("read");
    await storage.createFact({
      workspaceId: WS,
      statement: "the stats route answers",
      subject: "workspace",
      kind: "other",
      scope: "global",
    } as never);
    const body = (await (await call("GET", "/facts/stats")).json()) as {
      live: number;
      byKind: unknown[];
    };
    expect(body.live).toBe(1);
    expect(body.byKind).toEqual([{ kind: "other", count: 1 }]);
  });
});
