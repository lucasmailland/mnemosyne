/**
 * Unit tests for ctx.createEvent in buildPluginContext (Task P2.8).
 *
 * Verifies:
 *   - Calls deps.storage.createEvent (persists before emitting)
 *   - Emits on bus AFTER storage persist — using the persisted event.id
 *   - Returns the persisted id (not a synthetic UUID)
 *   - Bus is optional — no throw when deps.bus is absent
 *   - Passes input.payload as metadata to storage
 */
import { describe, it, expect, vi } from "vitest";
import { buildPluginContext } from "../../plugins/context.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-event-test";
const PLUGIN = "test-plugin";
const PERSISTED_ID = "event-persisted-123";

function makeStorageMock() {
  return {
    createEvent: vi.fn().mockResolvedValue({
      id: PERSISTED_ID,
      workspaceId: WS,
      type: "agent",
      name: "test.event",
      description: "",
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      source: `plugin:${PLUGIN}`,
      relatedEntities: [],
      annotations: [],
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      metadata: {},
    }),
  };
}

function makeBusMock() {
  return { emit: vi.fn() };
}

function makeDeps(
  storage: ReturnType<typeof makeStorageMock>,
  bus?: ReturnType<typeof makeBusMock>,
): ServerDeps {
  return {
    core: {},
    storage,
    bus,
  } as unknown as ServerDeps;
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

describe("ctx.createEvent", () => {
  it("calls deps.storage.createEvent to persist the event", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createEvent({ type: "user.action" });
    expect(storage.createEvent).toHaveBeenCalledTimes(1);
    expect(storage.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, name: "user.action" }),
    );
  });

  it("returns the persisted event id (not a synthetic UUID)", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    const result = await ctx.createEvent({ type: "user.action" });
    expect(result.id).toBe(PERSISTED_ID);
  });

  it("emits on bus with the persisted id after storage persist", async () => {
    const storage = makeStorageMock();
    const bus = makeBusMock();
    const ctx = makeCtx(makeDeps(storage, bus));
    await ctx.createEvent({ type: "user.action" });
    // storage is called first
    expect(storage.createEvent).toHaveBeenCalled();
    // bus emits with the real persisted ID
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ id: PERSISTED_ID }) }),
    );
  });

  it("does NOT throw when deps.bus is absent", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage, undefined));
    await expect(ctx.createEvent({ type: "user.action" })).resolves.not.toThrow();
  });

  it("passes input.payload as metadata to storage", async () => {
    const storage = makeStorageMock();
    const ctx = makeCtx(makeDeps(storage));
    await ctx.createEvent({ type: "user.action", payload: { key: "value" } });
    expect(storage.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { key: "value" } }),
    );
  });
});
