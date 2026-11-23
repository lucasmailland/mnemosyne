/**
 * Tests for:
 *  1. PATCH /tasks/:id with illegal status transition → 409
 *  2. PATCH /tasks/:id with legal transition → 200
 *  3. POST /tasks/:id/delegate → 200, status=delegated
 *  4. PATCH /tasks/:id to completed triggers auto-extract
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoTask } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountTasks } from "../../routes/tasks.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeTasksApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
  } as unknown as ServerDeps;

  mountTasks(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

const pendingTask: MnemoTask = {
  id: "task-1",
  workspaceId: WORKSPACE_ID,
  title: "Fix billing webhook",
  status: "pending",
  priority: "high",
  assignedTo: "agent-1",
  blockedBy: [],
  subtaskIds: [],
  relatedFacts: [],
  relatedEntities: [],
  // P120: the response schema now projects the bitemporal interval.
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: null,
  createdAt: new Date("2026-06-14T00:00:00.000Z"),
  updatedAt: new Date("2026-06-14T00:00:00.000Z"),
  metadata: {},
};

const inProgressTask: MnemoTask = {
  ...pendingTask,
  status: "in_progress",
};

describe("PATCH /tasks/:id — state machine guard", () => {
  it("returns 409 when jumping from pending directly to completed (illegal)", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(pendingTask),
      updateTask: vi.fn(),
    });

    const res = await request("/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("returns 200 when transitioning from pending to in_progress (legal)", async () => {
    const updatedTask = { ...pendingTask, status: "in_progress" as const };
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(pendingTask),
      updateTask: vi.fn().mockResolvedValue(updatedTask),
    });

    const res = await request("/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("in_progress");
  });
});

describe("POST /tasks/:id/delegate", () => {
  it("returns 200 with status=delegated and assignedTo and delegatedAt set", async () => {
    const delegatedTask: MnemoTask = {
      ...inProgressTask,
      status: "delegated",
      assignedTo: "agent-b",
      delegatedBy: "mns_live_",
      delegatedAt: new Date("2026-06-14T01:00:00.000Z"),
    };
    const delegateTask = vi.fn().mockResolvedValue(delegatedTask);
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(inProgressTask),
      delegateTask,
    });

    const res = await request("/tasks/task-1/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; assignedTo: string; delegatedAt: string };
    expect(body.status).toBe("delegated");
    expect(body.assignedTo).toBe("agent-b");
    expect(body.delegatedAt).toBeTruthy();
    expect(delegateTask).toHaveBeenCalledOnce();
  });

  it("returns 404 when task does not exist", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/tasks/missing/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 409 when task is already completed (terminal state)", async () => {
    const completedTask: MnemoTask = { ...pendingTask, status: "completed" };
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(completedTask),
      delegateTask: vi.fn(),
    });

    const res = await request("/tasks/task-1/delegate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: "agent-b" }),
    });

    expect(res.status).toBe(409);
  });
});

describe("PATCH /tasks/:id — auto-extract on completion", () => {
  it("triggers auto-extract when patching to completed with outcome and lessonsLearned", async () => {
    const completedTask: MnemoTask = {
      ...inProgressTask,
      status: "completed",
      outcome: "Increased timeout to 30s",
      lessonsLearned: "Check timeout config first",
    };
    const createStrategy = vi.fn().mockResolvedValue({ id: "strat-1" });
    const createFact = vi.fn().mockResolvedValue({ id: "fact-1" });
    const createEpisode = vi.fn().mockResolvedValue({ id: "ep-1" });
    const createRelation = vi.fn().mockResolvedValue({ id: "rel-1" });

    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(inProgressTask),
      updateTask: vi.fn().mockResolvedValue(completedTask),
      createStrategy,
      createFact,
      createEpisode,
      createRelation,
    });

    const res = await request("/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        outcome: "Increased timeout to 30s",
        lessonsLearned: "Check timeout config first",
      }),
    });

    expect(res.status).toBe(200);
    // Auto-extract should have run
    expect(createStrategy).toHaveBeenCalledOnce();
    expect(createFact).toHaveBeenCalledOnce();
    expect(createEpisode).toHaveBeenCalledOnce();
  });
});
