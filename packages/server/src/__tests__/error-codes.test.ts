/**
 * §3 — canonical operational error-code registry (MNEMO_001..010).
 */
import { describe, it, expect } from "vitest";
import { MNEMO_CODES, mnemoMessage, mnemoDegraded } from "../errorCodes.js";

describe("§3 MNEMO operational error codes", () => {
  it("defines exactly the 10 spec codes MNEMO_001..010", () => {
    const keys = Object.keys(MNEMO_CODES);
    expect(keys).toHaveLength(10);
    for (let i = 1; i <= 10; i++) {
      expect(keys).toContain(`MNEMO_${String(i).padStart(3, "0")}`);
    }
  });

  it("maps codes to the spec's canonical messages", () => {
    expect(MNEMO_CODES.MNEMO_001).toMatch(/Redis connection failed/i);
    expect(MNEMO_CODES.MNEMO_008).toMatch(/Merkle chain verification failed/i);
    expect(mnemoMessage("MNEMO_002")).toMatch(/PG pool exhausted/i);
  });

  it("mnemoDegraded builds a 503 carrying the code in details", () => {
    const err = mnemoDegraded("MNEMO_001");
    expect(err.status).toBe(503);
    expect(err.details?.code).toBe("MNEMO_001");
    expect(err.details?.reason).toMatch(/Redis/i);
  });

  it("mnemoDegraded accepts a custom message + extra details", () => {
    const err = mnemoDegraded("MNEMO_003", "embeddings down", { provider: "openai" });
    expect(err.message).toBe("embeddings down");
    expect(err.details?.code).toBe("MNEMO_003");
    expect(err.details?.provider).toBe("openai");
  });
});
