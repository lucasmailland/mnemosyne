/**
 * B7 — `memory_task(action:'archive')` respects the terminal task status.
 *
 * `DELETE /tasks/:id` (→ `storage.archiveTask()`) used to unconditionally force
 * `status: 'cancelled'`, silently corrupting an already-`completed` task's
 * terminal status when it was archived. This regression suite pins the fixed
 * contract (design.md's B7 "proposal correction"): `archiveTask` is
 * terminal-aware — it preserves `completed`/`cancelled`, and still cancels any
 * non-terminal task. It also re-confirms the unrelated `PATCH completed →
 * cancelled` 409 behavior is unaffected by this fix.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, beforeEach } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { toErrorBody } from "../../errors.js";
import { mountTasks } from "../../routes/tasks.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeTasksApp(storage: InMemoryStorageAdapter) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage,
    core: {} as unknown,
  } as unknown as ServerDeps;

  mountTasks(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

describe("DELETE /tasks/:id — archive respects terminal status (B7)", () => {
  let storage: InMemoryStorageAdapter;

  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("archiving a completed task preserves status:'completed' and sets validTo", async () => {
    const created = await storage.createTask({
      workspaceId: WORKSPACE_ID,
      title: "Ship Wave A",
      assignedTo: "agent-1",
    });
    // Drive the task to `completed` directly at the storage layer — the
    // state-machine guard for PATCH is a separate concern (route-level),
    // this test isolates archiveTask's own terminal-aware SQL/logic.
    await storage.updateTask(created.id, { workspaceId: WORKSPACE_ID, status: "completed" });

    const { request } = makeTasksApp(storage);
    const res = await request(`/tasks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const archived = await storage.getTask(created.id, WORKSPACE_ID);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe("completed");
    expect(archived!.validTo).toBeInstanceOf(Date);
  });

  it("archiving a non-terminal task still sets status:'cancelled'", async () => {
    const created = await storage.createTask({
      workspaceId: WORKSPACE_ID,
      title: "Ship Wave B",
      assignedTo: "agent-1",
    });
    expect(created.status).toBe("pending");

    const { request } = makeTasksApp(storage);
    const res = await request(`/tasks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const archived = await storage.getTask(created.id, WORKSPACE_ID);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe("cancelled");
    expect(archived!.validTo).toBeInstanceOf(Date);
  });

  it("archiving an already-cancelled task keeps status:'cancelled' (idempotent)", async () => {
    const created = await storage.createTask({
      workspaceId: WORKSPACE_ID,
      title: "Ship Wave C",
      assignedTo: "agent-1",
    });
    await storage.updateTask(created.id, { workspaceId: WORKSPACE_ID, status: "cancelled" });

    const { request } = makeTasksApp(storage);
    const res = await request(`/tasks/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const archived = await storage.getTask(created.id, WORKSPACE_ID);
    expect(archived!.status).toBe("cancelled");
  });
});

describe("PATCH /tasks/:id — completed → cancelled still returns 409 (unaffected by B7)", () => {
  it("rejects the illegal transition, regardless of archiveTask's fix", async () => {
    const storage = new InMemoryStorageAdapter();
    const created = await storage.createTask({
      workspaceId: WORKSPACE_ID,
      title: "Ship Wave D",
      assignedTo: "agent-1",
    });
    await storage.updateTask(created.id, { workspaceId: WORKSPACE_ID, status: "completed" });

    const { request } = makeTasksApp(storage);
    const res = await request(`/tasks/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });

    expect(res.status).toBe(409);

    // The task itself must remain untouched — the illegal PATCH never applied.
    const unchanged = await storage.getTask(created.id, WORKSPACE_ID);
    expect(unchanged!.status).toBe("completed");
  });
});
