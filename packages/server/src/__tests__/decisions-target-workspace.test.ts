/**
 * POST /decisions — targetWorkspaceId cross-workspace write support (P57 slice
 * 2a). Mirrors remember-target-workspace.test.ts's coverage: asserts the
 * actual 201 response BODY carries the resolved workspaceId (not just schema
 * presence — hono zod-openapi does not validate responses), that omitting the
 * param is byte-identical to pre-change behaviour, and that non-member/
 * read-role/non-user-bound-key callers are rejected with the same flat
 * `{error:"forbidden",message}` shape `memory_remember` uses today.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountDecisions } from "../routes/decisions.js";

const KEY_WS_ID = "00000000-0000-0000-0000-cc0000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-cc0000000002";
const USER_ID = "user-decisions-target-ws-test-001";

/** Fake postgres.Sql for resolveTargetWorkspace's membership check. */
function makeFakeSql(role: string | null) {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("mnemo_workspace_member")) {
      return Promise.resolve(role ? [{ role }] : []);
    }
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as ServerDeps["metricsPgClient"];
}

function makeApp(opts: {
  createDecision: ReturnType<typeof vi.fn>;
  sqlRole: string | null;
  userId?: string | null;
}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", KEY_WS_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
    c.set("scopes", ["memory:write"] as ReadonlyArray<string>);
    c.set("userId", "userId" in opts ? opts.userId : USER_ID);
    await next();
  });

  const fakeDeps = {
    storage: {
      createDecision: opts.createDecision,
      listWebhookEndpoints: vi.fn().mockResolvedValue([]),
    } as unknown,
    metricsPgClient: makeFakeSql(opts.sqlRole),
  } as unknown as ServerDeps;

  mountDecisions(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

const baseDecision = {
  id: "decision-1",
  agentId: null,
  conversationId: null,
  kind: "decision" as const,
  title: "Use event sourcing",
  body: "Because audit trail matters",
  topicKey: null,
  revisionCount: 1,
  normalizedHash: "hash1",
  decidedByUserId: null,
  status: "active" as const,
  supersededById: null,
  sensitivity: "internal" as const,
  metadata: {},
  validFrom: new Date("2026-08-01T00:00:00.000Z"),
  validTo: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("POST /decisions — targetWorkspaceId", () => {
  it("write-role member targeting a different workspace → 201, response workspaceId is the target, storage receives the target workspace", async () => {
    const createDecision = vi
      .fn()
      .mockResolvedValue({ ...baseDecision, workspaceId: TARGET_WS_ID });
    const request = makeApp({ createDecision, sqlRole: "write" });

    const res = await request("/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "decision",
        title: "Use event sourcing",
        body: "Because audit trail matters",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: TARGET_WS_ID })
    );
  });

  it("omitting targetWorkspaceId → 201 in the key's own workspace, byte-identical to pre-change", async () => {
    const createDecision = vi.fn().mockResolvedValue({ ...baseDecision, workspaceId: KEY_WS_ID });
    const request = makeApp({ createDecision, sqlRole: null });

    const res = await request("/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "decision",
        title: "Use event sourcing",
        body: "Because audit trail matters",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect(createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: KEY_WS_ID })
    );
  });

  it("non-member → 403 forbidden, flat shape, zero writes", async () => {
    const createDecision = vi.fn();
    const request = makeApp({ createDecision, sqlRole: null });

    const res = await request("/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "decision",
        title: "Should not land",
        body: "x",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("read-role member → 403, identical body to non-member, zero writes", async () => {
    const createDecision = vi.fn();
    const request = makeApp({ createDecision, sqlRole: "read" });

    const res = await request("/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "decision",
        title: "Should not land",
        body: "x",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("non-user-bound key → 403 'requires a user-bound key', zero writes", async () => {
    const createDecision = vi.fn();
    const request = makeApp({ createDecision, sqlRole: "write", userId: null });

    const res = await request("/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "decision",
        title: "Should not land",
        body: "x",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
    });
    expect(createDecision).not.toHaveBeenCalled();
  });
});

describe("POST /decisions — PRIM-18 exact-repeat dedup", () => {
  function appWith(storage: Record<string, unknown>) {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", KEY_WS_ID);
      c.set("apiKeyPrefix", "mns_live_");
      c.set("actorId", "test-key-id");
      c.set("actorType", "user");
      c.set("scopes", ["memory:write"] as ReadonlyArray<string>);
      c.set("userId", null as never);
      await next();
    });
    mountDecisions(app, {
      storage: { listWebhookEndpoints: vi.fn().mockResolvedValue([]), ...storage },
      metricsPgClient: makeFakeSql(null),
    } as unknown as ServerDeps);
    return app.request.bind(app);
  }
  const post = (request: ReturnType<typeof appWith>, body: Record<string, unknown>) =>
    request("/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("without a topicKey the create goes through createDecisionUnlessDuplicate and returns the existing row", async () => {
    const existing = { ...baseDecision, id: "decision-existing", workspaceId: KEY_WS_ID };
    const createDecisionUnlessDuplicate = vi
      .fn()
      .mockResolvedValue({ decision: existing, reused: true });
    const createDecision = vi.fn();
    const request = appWith({ createDecisionUnlessDuplicate, createDecision });

    const res = await post(request, { kind: "decision", title: "T", body: "B" });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe("decision-existing");
    expect(createDecisionUnlessDuplicate).toHaveBeenCalledOnce();
    expect(createDecision).not.toHaveBeenCalled();
  });

  it("an explicit topicKey keeps its own semantics: merge, else plain create, never the content dedup", async () => {
    const mergeDecisionByTopicKey = vi.fn().mockResolvedValue(null);
    const createDecisionUnlessDuplicate = vi.fn();
    const createDecision = vi.fn().mockResolvedValue({ ...baseDecision, topicKey: "k" });
    const request = appWith({
      mergeDecisionByTopicKey,
      createDecisionUnlessDuplicate,
      createDecision,
    });

    const res = await post(request, { kind: "decision", title: "T", body: "B", topicKey: "k" });

    expect(res.status).toBe(201);
    expect(createDecision).toHaveBeenCalledOnce();
    expect(createDecisionUnlessDuplicate).not.toHaveBeenCalled();
  });
});
