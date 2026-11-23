// CHAOS-2: `last_used_at` is written at most once per key per interval, a
// burst of requests on one key coalesces into one write, and outstanding work
// is bounded so a slow database can't pile up touches.
import { describe, expect, it, vi } from "vitest";
import { createKeyTouchScheduler } from "../api-key-lookup";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyTouchScheduler", () => {
  it("coalesces a concurrent burst on one key into a single write", async () => {
    const pending = deferred();
    const write = vi.fn(() => pending.promise);
    const touch = createKeyTouchScheduler({ write, now: () => 1_000 });

    const calls = Array.from({ length: 20 }, () => touch("key-a"));
    pending.resolve();
    await Promise.all(calls);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("key-a");
  });

  it("writes again only after the interval has passed", async () => {
    let now = 0;
    const write = vi.fn(async () => undefined);
    const touch = createKeyTouchScheduler({ write, intervalMs: 60_000, now: () => now });

    await touch("key-a");
    now = 59_999;
    await touch("key-a");
    expect(write).toHaveBeenCalledTimes(1);

    now = 60_000;
    await touch("key-a");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("touches distinct keys independently", async () => {
    const write = vi.fn(async () => undefined);
    const touch = createKeyTouchScheduler({ write, now: () => 0 });
    await Promise.all([touch("key-a"), touch("key-b"), touch("key-a")]);
    expect(write.mock.calls.map((c) => c[0]).sort()).toEqual(["key-a", "key-b"]);
  });

  it("ignores an empty key id", async () => {
    const write = vi.fn(async () => undefined);
    const touch = createKeyTouchScheduler({ write });
    await touch("");
    expect(write).not.toHaveBeenCalled();
  });

  it("drops new touches while maxInFlight writes are outstanding", async () => {
    const pending = deferred();
    const write = vi.fn(() => pending.promise);
    const touch = createKeyTouchScheduler({ write, maxInFlight: 2, now: () => 0 });

    const a = touch("key-a");
    const b = touch("key-b");
    await touch("key-c"); // dropped: resolves at once, no write
    expect(write).toHaveBeenCalledTimes(2);
    pending.resolve();
    await Promise.all([a, b]);

    // Capacity is back once the outstanding writes settle.
    await touch("key-c");
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("releases the in-flight slot on failure and does not retry within the interval", async () => {
    let now = 0;
    const write = vi.fn(async () => {
      throw new Error("db down");
    });
    const touch = createKeyTouchScheduler({ write, maxInFlight: 1, now: () => now });

    await expect(touch("key-a")).rejects.toThrow("db down");
    // The slot is free again: another key can be written.
    await expect(touch("key-b")).rejects.toThrow("db down");
    // But a failing key is not hammered on every request.
    await touch("key-a").catch(() => undefined);
    expect(write).toHaveBeenCalledTimes(2);

    now = 60_000;
    await touch("key-a").catch(() => undefined);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("keeps its tracking map bounded", async () => {
    const write = vi.fn(async () => undefined);
    const touch = createKeyTouchScheduler({ write, maxTracked: 3, now: () => 0 });
    for (const k of ["k1", "k2", "k3", "k4"]) await touch(k);
    // k1 was evicted (oldest), so it is written again; k4 is still tracked.
    await touch("k1");
    await touch("k4");
    expect(write.mock.calls.map((c) => c[0])).toEqual(["k1", "k2", "k3", "k4", "k1"]);
  });
});
