import { describe, it, expect } from "vitest";
import { RECOVERY_POINTS, type RecoveryPoint, type IdempotencyStore } from "../ports.js";

describe("idempotency port — recovery points (spec §Idempotency RDD9 lines 3954-3964)", () => {
  it("declares the exact spec phase vocabulary in order", () => {
    expect(RECOVERY_POINTS).toEqual([
      "started",
      "session_locked",
      "llm_called",
      "facts_persisted",
      "completed",
    ]);
  });

  it("port type structurally requires recordPhase + getRecoveryPoint", () => {
    const store: IdempotencyStore = {
      async begin() { return { state: "new" }; },
      async complete() {},
      async recordPhase() {},
      async getRecoveryPoint() { return null; },
    };
    expect(typeof store.recordPhase).toBe("function");
    expect(typeof store.getRecoveryPoint).toBe("function");
    const p: RecoveryPoint = "facts_persisted";
    expect(p).toBe("facts_persisted");
  });
});
