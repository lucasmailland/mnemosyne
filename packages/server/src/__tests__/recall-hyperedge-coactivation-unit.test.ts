/**
 * decompose-recall-and-compare, Slice 1 (spec.md Requirement 3) — direct unit
 * coverage for `recordHyperedgeCoActivation` against a fake `StorageAdapter`,
 * with no `createApp`/HTTP scaffolding. This is new coverage alongside the
 * existing route-level `recall-hyperedge-coactivation.test.ts`, which stays
 * untouched (spec.md Requirement 4 / design.md D5) — it drives the same
 * behavior through `POST /recall`.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { recordHyperedgeCoActivation } from "../recall/hyperedge-coactivation.js";

const WS_ID = "00000000-0000-0000-0000-ee0000000001";

describe("recordHyperedgeCoActivation (direct unit)", () => {
  it("credits worth when >=2 hyperedge members are present in the served hit set", async () => {
    const storage = new InMemoryStorageAdapter();
    const hyperedge = await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-a", "fact-b", "fact-c"],
    });
    expect(hyperedge.worth).toBe(0.5);

    await recordHyperedgeCoActivation(storage, WS_ID, ["fact-a", "fact-b"]);

    const updated = await storage.getHyperedge(hyperedge.id, WS_ID);
    expect(updated?.worth).toBeCloseTo(0.6, 5);
  });

  it("debits worth when exactly 1 hyperedge member is present in the served hit set", async () => {
    const storage = new InMemoryStorageAdapter();
    const hyperedge = await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-x", "fact-y", "fact-z"],
    });

    await recordHyperedgeCoActivation(storage, WS_ID, ["fact-x", "unrelated-fact"]);

    const updated = await storage.getHyperedge(hyperedge.id, WS_ID);
    expect(updated?.worth).toBeCloseTo(0.4, 5);
  });

  it("never calls updateWorth for a hyperedge with 0 members in the served hit set", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-m", "fact-n", "fact-o"],
    });
    const updateWorthSpy = vi.spyOn(storage, "updateWorth");

    await recordHyperedgeCoActivation(storage, WS_ID, ["fact-unrelated-1", "fact-unrelated-2"]);

    expect(updateWorthSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the served hit set is empty", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.createHyperedge({
      workspaceId: WS_ID,
      memberIds: ["fact-p", "fact-q", "fact-r"],
    });
    const updateWorthSpy = vi.spyOn(storage, "updateWorth");

    await recordHyperedgeCoActivation(storage, WS_ID, []);

    expect(updateWorthSpy).not.toHaveBeenCalled();
  });
});
