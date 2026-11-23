import { describe, it, expect, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessPolicyRecord } from "@mnemo-ai/types";
import { mountTasks } from "../../routes/tasks.js";
import { toErrorBody } from "../../errors.js";
import type { ServerDeps } from "../../deps.js";

function policy(over: Partial<AccessPolicyRecord["taskScopes"]> = {}): AccessPolicyRecord {
  return {
    agentId: "agent-a",
    workspaceId: "ws-1",
    readScopes: ["memory:read"],
    writeScopes: ["memory:write", "memory:task"],
    selfEdit: { enabled: false },
    taskScopes: { canCreate: true, canDelegate: true, canDelegateTo: ["*"], ...over },
    limits: {
      maxRecallsPerMinute: 600,
      maxWritesPerMinute: 120,
      maxSessionsConcurrent: 10,
      maxSelfEditsPerSession: 3,
    },
    requireApprovalFor: [],
    federationAccess: "none",
  };
}

function appWith(p: AccessPolicyRecord | null) {
  const createTask = vi.fn(async (input: unknown) => ({
    id: "t-1",
    workspaceId: "ws-1",
    title: "x",
    status: "pending",
    priority: "medium",
    assignedTo: "agent-a",
    blockedBy: [],
    subtaskIds: [],
    relatedFacts: [],
    relatedEntities: [],
    // P120: the response schema now projects the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    metadata: {},
    ...(input as object),
  }));
  const deps = {
    storage: {
      createTask,
      getTask: vi.fn(),
      queryTasks: vi.fn(),
      updateTask: vi.fn(),
      archiveTask: vi.fn(),
      delegateTask: vi.fn(),
    },
    accessPolicies: { getPolicy: vi.fn(async () => p) },
    bus: undefined,
  } as unknown as ServerDeps;
  const app = new OpenAPIHono<{
    Variables: {
      workspaceId: string;
      apiKeyPrefix: string;
      actorId?: string;
      scopes: readonly string[];
      plan: string;
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws-1");
    c.set("apiKeyPrefix", "agent-a");
    c.set("actorId", "agent-a");
    c.set("scopes", ["memory:write", "memory:task"]);
    c.set("plan", "free");
    await next();
  });
  mountTasks(app, deps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, createTask };
}

describe("POST /tasks — taskScopes.canCreate enforcement", () => {
  it("403s when policy.taskScopes.canCreate is false", async () => {
    const { app, createTask } = appWith(policy({ canCreate: false }));
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "do a thing", assignedTo: "agent-a" }),
    });
    expect(res.status).toBe(403);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("201s when canCreate is true", async () => {
    const { app, createTask } = appWith(policy({ canCreate: true }));
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "do a thing", assignedTo: "agent-a" }),
    });
    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledOnce();
  });

  it("201s when no policy exists (default-allow)", async () => {
    const { app, createTask } = appWith(null);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "do a thing", assignedTo: "agent-a" }),
    });
    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledOnce();
  });
});

function appWithDelegate(p: AccessPolicyRecord | null) {
  const delegateTask = vi.fn(async () => ({
    id: "t-1",
    workspaceId: "ws-1",
    title: "x",
    status: "delegated",
    priority: "medium",
    assignedTo: "agent-b",
    delegatedBy: "agent-a",
    blockedBy: [],
    subtaskIds: [],
    relatedFacts: [],
    relatedEntities: [],
    // P120: the response schema now projects the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    metadata: {},
  }));
  const getTask = vi.fn(async () => ({
    id: "t-1",
    workspaceId: "ws-1",
    title: "x",
    status: "in_progress",
    priority: "medium",
    assignedTo: "agent-a",
    blockedBy: [],
    subtaskIds: [],
    relatedFacts: [],
    relatedEntities: [],
    // P120: the response schema now projects the bitemporal interval.
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    metadata: {},
  }));
  const deps = {
    storage: {
      getTask,
      delegateTask,
      createTask: vi.fn(),
      queryTasks: vi.fn(),
      updateTask: vi.fn(),
      archiveTask: vi.fn(),
    },
    accessPolicies: { getPolicy: vi.fn(async () => p) },
    bus: undefined,
  } as unknown as ServerDeps;
  const app = new OpenAPIHono<{
    Variables: {
      workspaceId: string;
      apiKeyPrefix: string;
      actorId?: string;
      scopes: readonly string[];
      plan: string;
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws-1");
    c.set("apiKeyPrefix", "agent-a");
    c.set("actorId", "agent-a");
    c.set("scopes", ["memory:write", "memory:task"]);
    c.set("plan", "free");
    await next();
  });
  mountTasks(app, deps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, delegateTask };
}

describe("POST /tasks/:id/delegate — taskScopes.canDelegate enforcement", () => {
  it("403s when policy.taskScopes.canDelegate is false", async () => {
    const { app, delegateTask } = appWithDelegate(
      policy({ canDelegate: false, canDelegateTo: ["*"] })
    );
    const res = await app.request("/tasks/t-1/delegate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b" }),
    });
    expect(res.status).toBe(403);
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it("403s when target is outside taskScopes.canDelegateTo", async () => {
    const { app, delegateTask } = appWithDelegate(
      policy({ canDelegate: true, canDelegateTo: ["agent-c"] })
    );
    const res = await app.request("/tasks/t-1/delegate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b" }),
    });
    expect(res.status).toBe(403);
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it("200s when canDelegate true and target allowed", async () => {
    const { app, delegateTask } = appWithDelegate(
      policy({ canDelegate: true, canDelegateTo: ["agent-b"] })
    );
    const res = await app.request("/tasks/t-1/delegate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b" }),
    });
    expect(res.status).toBe(200);
    expect(delegateTask).toHaveBeenCalledOnce();
  });
});
