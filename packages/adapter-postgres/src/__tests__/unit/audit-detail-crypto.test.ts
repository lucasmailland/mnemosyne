import { describe, it, expect } from "vitest";
import { encryptJson, decryptJson } from "../../encryption/fact-cryptor.js";

describe("audit detail crypto (C3)", () => {
  const dek = Buffer.alloc(32, 3);
  it("round-trips a jsonb detail object", () => {
    const detail = { who: "actor-1", changed: ["statement"], note: "PII here" };
    const blob = encryptJson(dek, "dek-actor-1", detail);
    expect(typeof blob).toBe("string");
    expect(blob).not.toContain("PII here");
    expect(decryptJson(dek, blob)).toEqual(detail);
  });
  it("passes through legacy plaintext (no sentinel) unchanged", () => {
    const legacy = JSON.stringify({ legacy: true });
    expect(decryptJson(dek, legacy)).toEqual({ legacy: true });
  });
});
