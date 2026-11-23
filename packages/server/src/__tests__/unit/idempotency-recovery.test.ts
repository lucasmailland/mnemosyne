import { describe, it, expect } from "vitest";
import { InMemoryIdempotencyStore } from "../../idempotencyMemory.js";

describe("InMemoryIdempotencyStore recovery points (spec §Idempotency RDD9)", () => {
  it("starts at 'started' after begin and advances via recordPhase", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.begin("ws1", "k1", "h1");
    expect(await s.getRecoveryPoint("ws1", "k1")).toBe("started");

    await s.recordPhase("ws1", "k1", "session_locked");
    expect(await s.getRecoveryPoint("ws1", "k1")).toBe("session_locked");

    await s.recordPhase("ws1", "k1", "llm_called");
    await s.recordPhase("ws1", "k1", "facts_persisted");
    expect(await s.getRecoveryPoint("ws1", "k1")).toBe("facts_persisted");
  });

  it("complete() sets recovery_point to 'completed'", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.begin("ws1", "k2", "h2");
    await s.complete("ws1", "k2", 200, "{}");
    expect(await s.getRecoveryPoint("ws1", "k2")).toBe("completed");
  });

  it("recordPhase is a no-op for an unknown key; getRecoveryPoint returns null", async () => {
    const s = new InMemoryIdempotencyStore();
    await s.recordPhase("ws1", "ghost", "llm_called"); // must not throw
    expect(await s.getRecoveryPoint("ws1", "ghost")).toBeNull();
  });
});
