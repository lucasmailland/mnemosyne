/**
 * Unit tests for /tasks routes (Wave A3).
 *
 * Mirrors the pattern from facts-sensitivity.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the tasks sub-router with fake storage overrides
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoTask } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountTasks } from "../../routes/tasks.js";

// ── Test workspace ID (valid UUID) ────────────────────────────────────────────

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// ── Helper: build minimal app with fake storage ───────────────────────────────

function makeTasksApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth — stamps all required AuthVariables without touching bcrypt/DB
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseTask: MnemoTask = {
  id: "task-1",
  workspaceId: WORKSPACE_ID,
  title: "Ship Wave A",
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /tasks — list tasks", () => {
  it("returns 200 with items array (offset/limit/hasMore shape, no nextCursor)", async () => {
    const { request } = makeTasksApp({
      queryTasks: vi.fn().mockResolvedValue({
        items: [baseTask],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
      }),
    });

    const res = await request("/tasks");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { id: string; createdAt: string }[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("task-1");
    // Wire shape must use ISO strings, not Date objects
    expect(body.items[0].createdAt).toBe("2026-06-14T00:00:00.000Z");
    expect(body.total).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.hasMore).toBe(false);
    // PaginatedResult has NO nextCursor
    expect("nextCursor" in body).toBe(false);
  });
});

describe("POST /tasks — create task", () => {
  it("returns 201 with the created task", async () => {
    const createTask = vi.fn().mockResolvedValue(baseTask);
    const { request } = makeTasksApp({ createTask });

    const res = await request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Ship Wave A",
        assignedTo: "agent-1",
        priority: "high",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe("task-1");
    expect(body.title).toBe("Ship Wave A");
    expect(createTask).toHaveBeenCalledOnce();
  });
});

describe("GET /tasks/:id — get missing task → 404", () => {
  it("returns 404 with not_found code when task does not exist", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/tasks/nonexistent-id");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns 200 with ISO date strings when task exists", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(baseTask),
    });

    const res = await request("/tasks/task-1");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: string; updatedAt: string };
    expect(body.id).toBe("task-1");
    expect(body.updatedAt).toBe("2026-06-14T00:00:00.000Z");
  });
});

describe("PATCH /tasks/:id — update task", () => {
  it("returns 404 when task does not exist", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(null),
      updateTask: vi.fn(),
    });

    const res = await request("/tasks/nonexistent-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 200 with updated task on success", async () => {
    const updatedTask = { ...baseTask, title: "Updated title", status: "in_progress" as const };
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(baseTask),
      updateTask: vi.fn().mockResolvedValue(updatedTask),
    });

    const res = await request("/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated title", status: "in_progress" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; status: string };
    expect(body.title).toBe("Updated title");
    expect(body.status).toBe("in_progress");
  });
});

describe("DELETE /tasks/:id — archive task", () => {
  it("returns 404 when task does not exist", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(null),
      archiveTask: vi.fn(),
    });

    const res = await request("/tasks/nonexistent-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 204 on successful archive", async () => {
    const { request } = makeTasksApp({
      getTask: vi.fn().mockResolvedValue(baseTask),
      archiveTask: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request("/tasks/task-1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
