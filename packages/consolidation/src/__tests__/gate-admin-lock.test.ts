import { describe, it, expect, vi } from "vitest";
import { runConsolidationTick } from "../scheduler.js";
import type { SchedulerContext, SchedulerStorage } from "../scheduler.js";
import { makeInMemoryStorage, seedCluster, validatorBoost, TEST_SYSTEM_ACTOR } from "./helpers.js";

describe("consolidation scheduler — admin lock (spec §12 condition 6)", () => {
  it("skips a workspace that is consolidation-locked (fail-closed retained)", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws1", 3);
    const applySpy = vi.fn(storage.applyConsolidationMerge);
    const storageWithLock: SchedulerStorage = {
      ...storage,
      applyConsolidationMerge: applySpy,
      isConsolidationLocked: vi.fn().mockResolvedValue(true),
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: storageWithLock,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1"]),
      replayValidator: validatorBoost(facts[0]!.id),
    };

    const result = await runConsolidationTick(ctx);

    expect(applySpy).not.toHaveBeenCalled();
    expect(result.mergedPairs).toBe(0);
  });

  it("merges an eligible cluster when the workspace is NOT locked", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws1", 3);
    const storageWithLock: SchedulerStorage = {
      ...storage,
      isConsolidationLocked: vi.fn().mockResolvedValue(false),
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: storageWithLock,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws1"]),
      replayValidator: validatorBoost(facts[0]!.id),
    };

    const result = await runConsolidationTick(ctx);

    expect(result.mergedPairs).toBe(1);
    expect((await storage.adapter.getFact(facts[1]!.id, "ws1"))?.status).toBe("merged");
  });
});
