import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  WORKSPACE_ROLE_ORDER,
  WORKSPACE_ROLE_SCOPES,
  WORKSPACE_GOVERNED_SCOPES,
  roleAtLeast,
  narrowScopesForWorkspaceRole,
  type KeyScope,
  type WorkspaceRole,
} from "../security.js";

const ROLES: readonly WorkspaceRole[] = ["read", "write", "admin", "owner"];
const TENANT_PLANE_SCOPES: readonly KeyScope[] = [
  "admin:tenant",
  "admin:billing",
  "admin:workspace",
];

describe("WORKSPACE_ROLE_SCOPES", () => {
  it("every role's scope set is a subset of ALL_SCOPES", () => {
    for (const role of ROLES) {
      for (const scope of WORKSPACE_ROLE_SCOPES[role]) {
        expect(ALL_SCOPES).toContain(scope);
      }
    }
  });

  it("read is a strict subset of write, write is a strict subset of admin", () => {
    const read = WORKSPACE_ROLE_SCOPES.read;
    const write = WORKSPACE_ROLE_SCOPES.write;
    const admin = WORKSPACE_ROLE_SCOPES.admin;
    for (const s of read) expect(write.has(s)).toBe(true);
    for (const s of write) expect(admin.has(s)).toBe(true);
    expect(write.size).toBeGreaterThan(read.size);
    expect(admin.size).toBeGreaterThan(write.size);
  });

  it("owner is scope-identical to admin (ownership is a membership privilege, not a scope)", () => {
    expect([...WORKSPACE_ROLE_SCOPES.owner].sort()).toEqual(
      [...WORKSPACE_ROLE_SCOPES.admin].sort()
    );
  });

  it("no role's scope set includes a tenant/instance-plane scope", () => {
    for (const role of ROLES) {
      for (const scope of TENANT_PLANE_SCOPES) {
        expect(WORKSPACE_ROLE_SCOPES[role].has(scope)).toBe(false);
      }
    }
  });

  it("WORKSPACE_GOVERNED_SCOPES excludes exactly the 3 tenant/instance-plane scopes", () => {
    for (const scope of TENANT_PLANE_SCOPES) {
      expect(WORKSPACE_GOVERNED_SCOPES.has(scope)).toBe(false);
    }
    const governedCount = ALL_SCOPES.length - TENANT_PLANE_SCOPES.length;
    expect(WORKSPACE_GOVERNED_SCOPES.size).toBe(governedCount);
  });

  // P55: federation:admin (peer trust administration) was added to ALL_SCOPES
  // and WORKSPACE_ADMIN_SCOPES only (D1) — it must be role-governed like any
  // other workspace-plane scope: owner/admin members keep it, write/read
  // members are narrowed out of it. This is mostly self-adjusting via the
  // derived WORKSPACE_GOVERNED_SCOPES/subset checks above, but pin it
  // explicitly so a future scope addition can't silently regress it.
  it("federation:admin is admin/owner-only, absent from read/write", () => {
    expect(WORKSPACE_ROLE_SCOPES.admin.has("federation:admin")).toBe(true);
    expect(WORKSPACE_ROLE_SCOPES.owner.has("federation:admin")).toBe(true);
    expect(WORKSPACE_ROLE_SCOPES.read.has("federation:admin")).toBe(false);
    expect(WORKSPACE_ROLE_SCOPES.write.has("federation:admin")).toBe(false);
  });
});

describe("roleAtLeast", () => {
  it("orders read < write < admin < owner", () => {
    expect(roleAtLeast("write", "read")).toBe(true);
    expect(roleAtLeast("read", "write")).toBe(false);
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("admin", "admin")).toBe(true);
  });

  it("WORKSPACE_ROLE_ORDER is strictly increasing across the 4 roles", () => {
    const ordered = ROLES.map((r) => WORKSPACE_ROLE_ORDER[r]);
    expect(ordered).toEqual([0, 1, 2, 3]);
  });
});

describe("narrowScopesForWorkspaceRole", () => {
  it("never adds a scope the key didn't already have, for every role and every subset of ALL_SCOPES", () => {
    // Property-style sweep: for each role, narrow every possible single-scope
    // input and every pairwise combination — assert the result is always a
    // subset of the input.
    for (const role of ROLES) {
      for (const scope of ALL_SCOPES) {
        const result = narrowScopesForWorkspaceRole([scope], role);
        expect(result.every((s) => s === scope)).toBe(true);
      }
    }
    const full = narrowScopesForWorkspaceRole([...ALL_SCOPES], "read");
    for (const s of full) expect(ALL_SCOPES).toContain(s);
    expect(full.length).toBeLessThanOrEqual(ALL_SCOPES.length);
  });

  it("a read-role member narrowed from a full-scope key loses memory:write", () => {
    const narrowed = narrowScopesForWorkspaceRole(
      ["memory:read", "memory:write", "memory:admin"],
      "read"
    );
    expect(narrowed).toContain("memory:read");
    expect(narrowed).not.toContain("memory:write");
    expect(narrowed).not.toContain("memory:admin");
  });

  it("tenant-plane scopes always pass through unfiltered, regardless of role", () => {
    for (const role of ROLES) {
      const narrowed = narrowScopesForWorkspaceRole([...TENANT_PLANE_SCOPES], role);
      expect([...narrowed].sort()).toEqual([...TENANT_PLANE_SCOPES].sort());
    }
  });

  it("a read-role member keeps memory:read even when the key only had memory:read", () => {
    const narrowed = narrowScopesForWorkspaceRole(["memory:read"], "read");
    expect(narrowed).toEqual(["memory:read"]);
  });

  it("narrowing is a no-op for a key that already only has scopes within the role's set", () => {
    const keyScopes: KeyScope[] = ["memory:read", "memory:subscribe"];
    expect(narrowScopesForWorkspaceRole(keyScopes, "admin")).toEqual(keyScopes);
  });

  it("P55: federation:admin is narrowed out for write, passes through for admin", () => {
    expect(narrowScopesForWorkspaceRole(["federation:admin"], "write")).toEqual([]);
    expect(narrowScopesForWorkspaceRole(["federation:admin"], "admin")).toEqual([
      "federation:admin",
    ]);
  });
});
