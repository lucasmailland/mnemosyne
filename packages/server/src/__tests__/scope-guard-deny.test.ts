// packages/server/src/__tests__/scope-guard-deny.test.ts
import { describe, it, expect } from "vitest";
import { decideScopeAccess } from "../middleware/scopeGuard.js";

describe("decideScopeAccess (F11)", () => {
  it("DENIES empty-scope keys by default (no legacy bypass)", () => {
    const d = decideScopeAccess([], "memory:read", { allowLegacyFullScope: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/empty scope/i);
  });

  it("allows empty-scope keys ONLY under explicit MNEMO_ALLOW_LEGACY_FULL_SCOPE", () => {
    const d = decideScopeAccess([], "memory:read", { allowLegacyFullScope: true });
    expect(d.allowed).toBe(true);
  });

  it("allows a scoped key whose scopes include the required scope", () => {
    const d = decideScopeAccess(["memory:read"], "memory:read", { allowLegacyFullScope: false });
    expect(d.allowed).toBe(true);
  });

  it("denies a scoped key missing the required scope", () => {
    const d = decideScopeAccess(["memory:write"], "memory:read", { allowLegacyFullScope: false });
    expect(d.allowed).toBe(false);
    expect(d.required).toBe("memory:read");
  });

  it("allows when no scope is required for the route (required === null)", () => {
    const d = decideScopeAccess(["memory:write"], null, { allowLegacyFullScope: false });
    expect(d.allowed).toBe(true);
  });

  it("under legacy override, a NON-empty scoped key is still enforced (override only relaxes empty scopes)", () => {
    const d = decideScopeAccess(["memory:write"], "memory:read", { allowLegacyFullScope: true });
    expect(d.allowed).toBe(false);
  });
});
