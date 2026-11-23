/**
 * Unit tests for ctx.getFact in buildPluginContext.
 *
 * flatten-legacy-dual-core Phase 6d (PR17): D3 Tier A parity coverage for
 * `deps.core.getFact` — ported to `deps.storage.getFact(id, workspaceId)` in
 * the same PR (the v3 1:1 positional-arg equivalent, matching the
 * `getWorkspaceVitals`/`getFact` calling convention already established by
 * PR6/PR8/PR9a). `deps.storage` is optional on `ServerDeps` (unlike the
 * legacy required `core` field) — guarded with a null return, matching the
 * `keys.ts` optional-storage precedent (PR12).
 */
import { describe, it, expect, vi } from "vitest";
import { buildPluginContext } from "../../plugins/context.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-plugin-test";
const PLUGIN = "test-plugin";

function makeCtx(deps: ServerDeps, config: Record<string, string | undefined> = {}) {
  return buildPluginContext({
    pluginId: PLUGIN,
    config,
    workspaceId: WS,
    deps,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("ctx.getFact", () => {
  it("delegates to deps.storage.getFact(id, workspaceId) and maps statement → content", async () => {
    const getFact = vi.fn().mockResolvedValue({
      id: "f1",
      workspaceId: WS,
      statement: "the persisted statement",
    });
    const deps = { storage: { getFact } } as unknown as ServerDeps;
    const ctx = makeCtx(deps);

    const result = await ctx.getFact("f1");

    expect(getFact).toHaveBeenCalledWith("f1", WS);
    expect(result).toEqual({ id: "f1", content: "the persisted statement" });
  });

  it("returns null when the fact does not exist", async () => {
    const getFact = vi.fn().mockResolvedValue(null);
    const deps = { storage: { getFact } } as unknown as ServerDeps;
    const ctx = makeCtx(deps);
    await expect(ctx.getFact("missing")).resolves.toBeNull();
  });

  it("returns null (does not throw) when deps.storage is absent", async () => {
    const deps = {} as unknown as ServerDeps;
    const ctx = makeCtx(deps);
    await expect(ctx.getFact("f1")).resolves.toBeNull();
  });
});
