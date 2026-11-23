import { describe, it, expect } from "vitest";
import { hashSecret, verifySecret } from "../../auth/hash.js";
import bcrypt from "bcrypt";

describe("auth/hash — argon2id with bcrypt fallback", () => {
  it("hashSecret produces an argon2id hash", async () => {
    const h = await hashSecret("super-secret-part");
    expect(h.startsWith("$argon2id$")).toBe(true);
  });

  it("verifySecret round-trips its own argon2id hash", async () => {
    const h = await hashSecret("super-secret-part");
    expect(await verifySecret("super-secret-part", h)).toBe(true);
    expect(await verifySecret("wrong", h)).toBe(false);
  });

  it("verifySecret still accepts a legacy bcrypt hash (no forced re-hash)", async () => {
    const legacy = await bcrypt.hash("legacy-secret", 10);
    expect(await verifySecret("legacy-secret", legacy)).toBe(true);
    expect(await verifySecret("nope", legacy)).toBe(false);
  });
});
