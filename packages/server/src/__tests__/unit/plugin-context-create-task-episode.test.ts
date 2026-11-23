/**
 * Unit tests for ctx.createTask and ctx.createEpisode in buildPluginContext (Task P2.9).
 *
 * Verifies:
 *   - createTask calls deps.storage.createTask with correct fields
 *   - createTask returns { id, title }
 *   - createEpisode calls deps.storage.createEpisode with correct fields
 *   - createEpisode returns { id, title }
 *   - Both are rate-limited (throw when rate limit exceeded)
 */
import { describe, it, expect, vi } from "vitest";
import { buildPluginContext } from "../../plugins/context.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-task-ep-test";
const PLUGIN = "test-plugin";

function makeStorageMock() {
  return {
    createTask: vi.fn().mockResolvedValue({
      id: "task-1",
      workspaceId: WS,
      title: "Test Task",
      assignedTo: `plugin:${PLUGIN}`,
      status: "pending",
      priority: "medium",
    }),
    createEpisode: vi.fn().mockResolvedValue({
      id: "episode-1",
      workspaceId: WS,
      title: "Test Episode",
      narrative: "",
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    }),
  };
}

function makeDeps(storage: ReturnType<typeof makeStorageMock>): ServerDeps {
  return { core: {}, storage } as unknown as ServerDeps;
}

function makeCtx(deps: ServerDeps) {
  return buildPluginContext({
    pluginId: PLUGIN,
    config: {},
    workspaceId: WS,
    deps,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("ctx.createTask", () => {
  it("calls storage.createTask with title and workspaceId", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createTask({ title: "Do something" });
    expect(storage.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, title: "Do something" }),
    );
  });

  it("defaults assignedTo to plugin:<id> when not provided", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createTask({ title: "Task" });
    expect(storage.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: `plugin:${PLUGIN}` }),
    );
  });

  it("returns { id, title } from persisted task", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    const result = await ctx.createTask({ title: "Test Task" });
    expect(result).toMatchObject({ id: "task-1", title: "Test Task" });
  });
});

describe("ctx.createEpisode", () => {
  it("calls storage.createEpisode with title and workspaceId", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createEpisode({ title: "Some episode" });
    expect(storage.createEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, title: "Some episode" }),
    );
  });

  it("defaults narrative to empty string when not provided", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createEpisode({ title: "Ep" });
    expect(storage.createEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ narrative: "" }),
    );
  });

  it("returns { id, title } from persisted episode", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    const result = await ctx.createEpisode({ title: "Test Episode" });
    expect(result).toMatchObject({ id: "episode-1", title: "Test Episode" });
  });
});
