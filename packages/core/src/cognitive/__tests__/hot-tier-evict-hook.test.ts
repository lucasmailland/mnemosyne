// packages/core/src/v3/__tests__/hot-tier-evict-hook.test.ts
import { describe, it, expect, vi } from "vitest";

const { bumpHotTierScore, hotTierKey } = await import("../recall-hot.js");

function makeCache(initialIds: string[]) {
  const z = new Map<string, number>();
  initialIds.forEach((id, i) => z.set(id, i + 1));
  return {
    store: z,
    async zincrby(_key: string, by: number, member: string) {
      z.set(member, (z.get(member) ?? 0) + by);
    },
    async zrangeByScore() {
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    },
  } as any;
}

describe("bumpHotTierScore — onHotTierEvict hook (F19)", () => {
  it("invokes onHotTierEvict with evicted count + post-eviction size when over cap", async () => {
    const ids = ["a", "b", "c", "d", "e"]; // 5 entries, cap = 3 → evict 2 (+1 new bump = 6 then trim)
    const cache = makeCache(ids);
    const onHotTierEvict = vi.fn();
    const ctx = {
      cache,
      config: { maxHotTierSize: 3 },
      telemetry: { counter: vi.fn() },
      onHotTierEvict,
    } as any;

    await bumpHotTierScore(ctx, "ws", "a");

    expect(onHotTierEvict).toHaveBeenCalledTimes(1);
    const call = onHotTierEvict.mock.calls[0][0];
    expect(call.workspaceId).toBe("ws");
    expect(call.evicted).toBeGreaterThanOrEqual(1);
    expect(typeof call.size).toBe("number");
  });

  it("does not invoke onHotTierEvict when under cap", async () => {
    const cache = makeCache(["a"]);
    const onHotTierEvict = vi.fn();
    const ctx = {
      cache,
      config: { maxHotTierSize: 100 },
      telemetry: { counter: vi.fn() },
      onHotTierEvict,
    } as any;

    await bumpHotTierScore(ctx, "ws", "a");
    expect(onHotTierEvict).not.toHaveBeenCalled();
  });
});

// Suppress unused-warning for hotTierKey import (kept to keep paths stable)
void hotTierKey;
