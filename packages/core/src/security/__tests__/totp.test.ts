import { describe, it, expect } from "vitest";
import { generateTotp, generateTotpSecret, verifyTotp } from "../totp.js";

// RFC 6238 base32 secret.
const SECRET = "JBSWY3DPEHPK3PXP";

describe("totp", () => {
  it("verifies a code it just generated", () => {
    const at = new Date("2026-06-16T12:00:30Z");
    const code = generateTotp(SECRET, at);
    expect(verifyTotp(SECRET, code, at)).toBe(true);
  });

  it("rejects a wrong code", () => {
    const at = new Date("2026-06-16T12:00:30Z");
    expect(verifyTotp(SECRET, "000000", at)).toBe(false);
  });

  it("accepts the previous 30s window (clock skew tolerance ±1)", () => {
    const gen = new Date("2026-06-16T12:00:00Z");
    const code = generateTotp(SECRET, gen);
    const later = new Date("2026-06-16T12:00:31Z"); // next step
    expect(verifyTotp(SECRET, code, later)).toBe(true);
  });

  it("a generated secret is 32 base32 characters (160 bits) and round-trips", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
    const at = new Date("2026-06-16T12:00:30Z");
    expect(verifyTotp(secret, generateTotp(secret, at), at)).toBe(true);
  });
});
