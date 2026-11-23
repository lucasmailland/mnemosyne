/**
 * AB6.2 — mk_test_ sandbox key isolation (spec §35 lines 4293–4299).
 *
 * A mk_test_ key must only work against workspaces where is_test=true.
 * A prod key (mk_live_) must be refused on test workspaces.
 */
import { describe, it, expect } from "vitest";
import { isTestKey, validateTestKeyBinding } from "../auth/test-key-isolation.js";

describe("isTestKey — prefix detection", () => {
  it("mk_test_ prefix returns true", () => {
    expect(isTestKey("mk_test_abc_xyz")).toBe(true);
  });

  it("mk_live_ prefix returns false", () => {
    expect(isTestKey("mk_live_abc_xyz")).toBe(false);
  });

  it("mk_admin_ prefix returns false", () => {
    expect(isTestKey("mk_admin_abc_xyz")).toBe(false);
  });

  it("empty string returns false", () => {
    expect(isTestKey("")).toBe(false);
  });
});

describe("validateTestKeyBinding — workspace cross-check", () => {
  it("test key + test workspace → ok (returns true)", () => {
    expect(validateTestKeyBinding("mk_test_", true)).toBe(true);
  });

  it("test key + prod workspace → rejected (returns false)", () => {
    expect(validateTestKeyBinding("mk_test_", false)).toBe(false);
  });

  it("prod key + test workspace → rejected (returns false)", () => {
    expect(validateTestKeyBinding("mk_live_", true)).toBe(false);
  });

  it("prod key + prod workspace → ok (returns true)", () => {
    expect(validateTestKeyBinding("mk_live_", false)).toBe(true);
  });

  it("mk_admin_ key + test workspace → rejected (returns false)", () => {
    expect(validateTestKeyBinding("mk_admin_", true)).toBe(false);
  });

  it("mk_admin_ key + prod workspace → ok (returns true)", () => {
    expect(validateTestKeyBinding("mk_admin_", false)).toBe(true);
  });
});
