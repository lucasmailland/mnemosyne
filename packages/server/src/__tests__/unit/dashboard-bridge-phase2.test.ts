/**
 * Phase 2 routes on the dashboard bridge: conflicts, recall explain, fact
 * provenance, trimmed stats and decision timeline events, all through a
 * password-session cookie (scopes come from the live role).
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

const fact = (storage: InMemoryStorageAdapter, statement: string) =>
  storage.createFact({
    workspaceId: WS,
    statement,
    subject: "workspace",
    kind: "other",
    scope: "global",
  } as never);

async function conflict(storage: InMemoryStorageAdapter) {
  const a = await fact(storage, "a");
  const b = await fact(storage, "b");
  const rel = await storage.createRelation({
    workspaceId: WS,
    sourceId: a.id,
    sourceType: "fact",
    targetId: b.id,
    targetType: "fact",
    verb: "conflicts_with",
  } as never);
  return { a, b, rel };
}

describe("dashboard bridge, phase 2 routes", () => {
  it("lists conflicts for a read member", async () => {
    const { storage, call } = await setup("read");
    await conflict(storage);
    const res = await call("GET", "/conflicts");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pairs: unknown[] }).pairs).toHaveLength(1);
  });

  it("resolve: 403 INSUFFICIENT_SCOPE for read, 200 for write", async () => {
    const read = await setup("read");
    const { rel } = await conflict(read.storage);
    const denied = await read.call("POST", `/conflicts/${rel.id}/resolve`, { action: "keep_both" });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).toContain("INSUFFICIENT_SCOPE");

    const write = await setup("write");
    const w = await conflict(write.storage);
    const ok = await write.call("POST", `/conflicts/${w.rel.id}/resolve`, { action: "keep_both" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ resolved: true, action: "keep_both" });
  });

  it("recall explain: 200 for a read member", async () => {
    const { call } = await setup("read");
    const res = await call("POST", "/recall/explain", { query: "anything" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hits: unknown[] }).hits).toHaveLength(1);
  });

  it("fact detail: closed + provenance fields", async () => {
    const { storage, call } = await setup("read");
    const { a: old, b: next, rel } = await conflict(storage);
    await storage.resolveConflict({
      workspaceId: WS,
      relationId: rel.id,
      sourceId: old.id,
      sourceKind: "fact",
      targetId: next.id,
      targetKind: "fact",
      action: "supersede_a",
      actorId: USER,
      actorType: "user",
    } as never);
    const res = await call("GET", `/facts/${old.id}?includeClosed=true&provenance=true`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ supersededById: next.id });
  });

  it("stats: trimmed for read, full for admin", async () => {
    const read = await (await (await setup("read")).call("GET", "/admin/stats")).json();
    expect(read).toHaveProperty("writesPerDay14d");
    expect(read.facts).not.toHaveProperty("withZeroHits");
    expect(read).not.toHaveProperty("embeddings");
    const adminRes = await (await setup("admin")).call("GET", "/admin/stats");
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toHaveProperty("embeddings");
  });

  it("timeline includes a decision event", async () => {
    const { storage, call } = await setup("read");
    const d = await storage.createDecision({
      workspaceId: WS,
      kind: "architecture",
      title: "t",
      body: "b",
    } as never);
    const res = await call("GET", "/timeline?limit=50");
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as {
      events: Array<{ kind: string; decisionId?: string }>;
    };
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "decision_created", decisionId: d.id })
    );
  });

  it("cross-site write is refused on the new POST routes", async () => {
    const { call } = await setup("write");
    for (const path of ["/conflicts/x/resolve", "/recall/explain"]) {
      const res = await call(
        "POST",
        path,
        { action: "keep_both", query: "q" },
        {
          "sec-fetch-site": "cross-site",
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "invalid_origin" });
    }
  });
});
