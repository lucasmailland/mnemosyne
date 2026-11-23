/**
 * Unit tests for the setup token lifecycle in bootstrap.ts.
 *
 * Tests: generateSetupToken, validateSetupToken
 * Uses vi.setSystemTime() to control date-now for expiry assertions. // determinism-ok: vi.setSystemTime controls all date access
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We import the functions directly from the module. Because the token store
// is module-level, we need to reset it between tests by using vi.resetModules()
// or by calling validate/generate in a way that clears state.

// Use dynamic import so we can get a fresh module state per test suite.
let generateSetupToken: () => string;
let validateSetupToken: (t: string) => boolean;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  // Re-import fresh module to get a clean Map each time
  vi.resetModules();
  const mod = await import("../../routes/bootstrap.js");
  generateSetupToken = mod.generateSetupToken;
  validateSetupToken = mod.validateSetupToken;
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("generateSetupToken", () => {
  it("returns a UUID-formatted string", () => {
    const token = generateSetupToken();
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("returns a different token each call", () => {
    const t1 = generateSetupToken();
    // Expire t1 so Map doesn't confuse things
    vi.setSystemTime(new Date("2026-01-01T12:16:00.000Z")); // 16 min later
    const t2 = generateSetupToken();
    expect(t1).not.toBe(t2);
  });
});

describe("validateSetupToken", () => {
  it("returns true for a valid token and deletes it (single-use)", () => {
    const token = generateSetupToken();
    expect(validateSetupToken(token)).toBe(true);
    // Second call: token was deleted
    expect(validateSetupToken(token)).toBe(false);
  });

  it("returns false for an unknown token", () => {
    expect(validateSetupToken("not-a-real-token")).toBe(false);
  });

  it("returns false for an expired token (15 min elapsed)", () => {
    const token = generateSetupToken();
    // Advance time past the 15-minute TTL
    vi.setSystemTime(new Date("2026-01-01T12:15:01.000Z")); // 15 min + 1 s later
    expect(validateSetupToken(token)).toBe(false);
  });

  it("returns true for a token that is exactly at TTL boundary (just before expiry)", () => {
    const token = generateSetupToken();
    // Advance to 14 min 59 s — still valid
    vi.setSystemTime(new Date("2026-01-01T12:14:59.000Z"));
    expect(validateSetupToken(token)).toBe(true);
  });

  it("double-call returns false on the second call", () => {
    const token = generateSetupToken();
    const first = validateSetupToken(token);
    const second = validateSetupToken(token);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
