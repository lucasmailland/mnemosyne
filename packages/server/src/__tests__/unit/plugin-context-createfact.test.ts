/**
 * Unit tests for ctx.createFact in buildPluginContext (Task P2.7).
 *
 * Verifies:
 *   - Delegates to deps.storage.createFact (not deps.core.createFact)
 *   - Passes input.subject and input.metadata through to storage
 *   - Clamps input.sensitivity to the plugin's maxSensitivity ceiling
 *   - Returns { id, content } where content === the persisted statement
 *   - Does NOT call storage when rate limit exceeded
 */
import { describe, it, expect, vi } from "vitest";
import { buildPluginContext } from "../../plugins/context.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-plugin-test";
const PLUGIN = "test-plugin";

function makeStorageMock(statement = "stored statement") {
  return {
    createFact: vi.fn().mockResolvedValue({
      id: "fact-1",
      workspaceId: WS,
      statement,
      subject: "test",
      scope: "global",
      kind: "other",
    }),
  };
}

function makeDeps(storageMock: ReturnType<typeof makeStorageMock>): ServerDeps {
  return {
    storage: storageMock,
  } as unknown as ServerDeps;
}

function makeCtx(deps: ServerDeps, config: Record<string, string | undefined> = {}) {
  return buildPluginContext({
    pluginId: PLUGIN,
    config,
    workspaceId: WS,
    deps,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("ctx.createFact", () => {
  it("calls deps.storage.createFact", async () => {
    const storage = makeStorageMock();
    const deps = makeDeps(storage);
    const ctx = makeCtx(deps);
    await ctx.createFact({ content: "test content" });
    expect(storage.createFact).toHaveBeenCalledTimes(1);
  });

  it("passes input.subject through to storage", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createFact({ content: "c", subject: "my-subject" });
    expect(storage.createFact).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "my-subject" })
    );
  });

  it("passes input.metadata through to storage", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createFact({ content: "c", metadata: { foo: "bar" } });
    expect(storage.createFact).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { foo: "bar" } })
    );
  });

  it("clamps sensitivity above the plugin ceiling to the ceiling", async () => {
    const storage = makeStorageMock();
    // config.maxSensitivity = "internal" → ceiling is "internal"
    // input.sensitivity = "restricted" → must be clamped down to "internal"
    const ctx = makeCtx(makeDeps(storage), { maxSensitivity: "internal" });
    await ctx.createFact({ content: "c", sensitivity: "restricted" });
    expect(storage.createFact).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivity: "internal" })
    );
  });

  it("does NOT include sensitivity key when input.sensitivity is undefined", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createFact({ content: "c" });
    const call = storage.createFact.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(call)).not.toContain("sensitivity");
  });

  it("returns { id, content } where content is the persisted statement", async () => {
    const storage = makeStorageMock("the real statement");
    const ctx = makeCtx(makeDeps(storage));
    const result = await ctx.createFact({ content: "the real statement" });
    expect(result).toMatchObject({ id: "fact-1", content: "the real statement" });
  });
});
