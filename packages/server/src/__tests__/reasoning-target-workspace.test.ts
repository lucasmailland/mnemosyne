/**
 * POST /reasoning — targetWorkspaceId cross-workspace write support (P57
 * slice 2a). See decisions-target-workspace.test.ts for the shared rationale
 * — every 201 body is parsed and asserted, not just schema presence.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountReasoning } from "../routes/reasoning.js";

const KEY_WS_ID = "00000000-0000-0000-0000-11a000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-11a000000002";
const USER_ID = "user-reasoning-target-ws-test-001";

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
  createReasoning: ReturnType<typeof vi.fn>;
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
    storage: { createReasoning: opts.createReasoning } as unknown,
    metricsPgClient: makeFakeSql(opts.sqlRole),
  } as unknown as ServerDeps;

  mountReasoning(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

function makeReasoning(workspaceId: string) {
  return {
    id: "reasoning-1",
    workspaceId,
    question: "Should we use event sourcing?",
    chain: [{ step: 0, reasoning: "Because audit trail matters", conclusion: "Yes" }],
    conclusion: "Yes",
    successCount: 0,
    failureCount: 0,
    worth: 0.5,
    status: "active" as const,
    sensitivity: "internal" as const,
    usageCount: 0,
    validFrom: new Date("2026-08-11T00:00:00.000Z"),
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    metadata: {},
  };
}

describe("POST /reasoning — targetWorkspaceId", () => {
  it("write-role member targeting a different workspace → 201, response workspaceId is the target, storage receives the target workspace", async () => {
    const createReasoning = vi.fn().mockResolvedValue(makeReasoning(TARGET_WS_ID));
    const request = makeApp({ createReasoning, sqlRole: "write" });

    const res = await request("/reasoning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Should we use event sourcing?",
        chain: [{ step: 0, reasoning: "Because audit trail matters", conclusion: "Yes" }],
        conclusion: "Yes",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect(createReasoning).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: TARGET_WS_ID })
    );
  });

  it("omitting targetWorkspaceId → 201 in the key's own workspace, byte-identical to pre-change", async () => {
    const createReasoning = vi.fn().mockResolvedValue(makeReasoning(KEY_WS_ID));
    const request = makeApp({ createReasoning, sqlRole: null });

    const res = await request("/reasoning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Should we use event sourcing?",
        chain: [{ step: 0, reasoning: "Because audit trail matters", conclusion: "Yes" }],
        conclusion: "Yes",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect(createReasoning).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: KEY_WS_ID })
    );
  });

  it("non-member → 403 forbidden, flat shape, zero writes", async () => {
    const createReasoning = vi.fn();
    const request = makeApp({ createReasoning, sqlRole: null });

    const res = await request("/reasoning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Should not land",
        chain: [{ step: 0, reasoning: "x", conclusion: "y" }],
        conclusion: "y",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createReasoning).not.toHaveBeenCalled();
  });

  it("read-role member → 403, identical body to non-member, zero writes", async () => {
    const createReasoning = vi.fn();
    const request = makeApp({ createReasoning, sqlRole: "read" });

    const res = await request("/reasoning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Should not land",
        chain: [{ step: 0, reasoning: "x", conclusion: "y" }],
        conclusion: "y",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createReasoning).not.toHaveBeenCalled();
  });

  it("non-user-bound key → 403 'requires a user-bound key', zero writes", async () => {
    const createReasoning = vi.fn();
    const request = makeApp({ createReasoning, sqlRole: "write", userId: null });

    const res = await request("/reasoning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Should not land",
        chain: [{ step: 0, reasoning: "x", conclusion: "y" }],
        conclusion: "y",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
    });
    expect(createReasoning).not.toHaveBeenCalled();
  });
});
