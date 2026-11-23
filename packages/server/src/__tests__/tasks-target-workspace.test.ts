/**
 * POST /tasks — targetWorkspaceId cross-workspace write support (P57 slice
 * 2a). See decisions-target-workspace.test.ts for the shared rationale —
 * every 201 body is parsed and asserted, not just schema presence.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { MnemoTask } from "@mnemo-ai/types";
import { toErrorBody } from "../errors.js";
import { mountTasks } from "../routes/tasks.js";

const KEY_WS_ID = "00000000-0000-0000-0000-ee0000000001";
const TARGET_WS_ID = "00000000-0000-0000-0000-ee0000000002";
const USER_ID = "user-tasks-target-ws-test-001";

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
  createTask: ReturnType<typeof vi.fn>;
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
      createTask: opts.createTask,
      listWebhookEndpoints: vi.fn().mockResolvedValue([]),
    } as unknown,
    metricsPgClient: makeFakeSql(opts.sqlRole),
  } as unknown as ServerDeps;

  mountTasks(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

function makeTask(workspaceId: string): MnemoTask {
  return {
    id: "task-1",
    workspaceId,
    title: "Ship Slice 2a",
    status: "pending",
    priority: "medium",
    assignedTo: "agent-1",
    blockedBy: [],
    subtaskIds: [],
    relatedFacts: [],
    relatedEntities: [],
    // P120: the response schema now projects the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    metadata: {},
  };
}

describe("POST /tasks — targetWorkspaceId", () => {
  it("write-role member targeting a different workspace → 201, response workspaceId is the target, storage receives the target workspace", async () => {
    const createTask = vi.fn().mockResolvedValue(makeTask(TARGET_WS_ID));
    const request = makeApp({ createTask, sqlRole: "write" });

    const res = await request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Ship Slice 2a",
        assignedTo: "agent-1",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(TARGET_WS_ID);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: TARGET_WS_ID }));
  });

  it("omitting targetWorkspaceId → 201 in the key's own workspace, byte-identical to pre-change", async () => {
    const createTask = vi.fn().mockResolvedValue(makeTask(KEY_WS_ID));
    const request = makeApp({ createTask, sqlRole: null });

    const res = await request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ship Slice 2a", assignedTo: "agent-1" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(KEY_WS_ID);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: KEY_WS_ID }));
  });

  it("non-member → 403 forbidden, flat shape, zero writes", async () => {
    const createTask = vi.fn();
    const request = makeApp({ createTask, sqlRole: null });

    const res = await request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Should not land",
        assignedTo: "agent-1",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("read-role member → 403, identical body to non-member, zero writes", async () => {
    const createTask = vi.fn();
    const request = makeApp({ createTask, sqlRole: "read" });

    const res = await request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Should not land",
        assignedTo: "agent-1",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "User is not a write member of the target workspace",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("non-user-bound key → 403 'requires a user-bound key', zero writes", async () => {
    const createTask = vi.fn();
    const request = makeApp({ createTask, sqlRole: "write", userId: null });

    const res = await request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Should not land",
        assignedTo: "agent-1",
        targetWorkspaceId: TARGET_WS_ID,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "forbidden",
      message: "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
    });
    expect(createTask).not.toHaveBeenCalled();
  });
});
