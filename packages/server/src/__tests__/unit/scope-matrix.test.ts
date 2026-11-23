import { describe, it, expect } from "vitest";
import { getScopeForRequest } from "../../app.js";

describe("scope-matrix — spec §6 15-scope mapping", () => {
  const cases: Array<[string, string, string | string[] | null]> = [
    ["GET", "/facts", "memory:read"],
    ["POST", "/facts", "memory:write"],
    ["DELETE", "/facts/1", "memory:delete"],
    ["DELETE", "/facts/1/hard", "memory:hard_delete"],
    ["POST", "/sessions", "memory:session"],
    ["POST", "/tasks", "memory:task"],
    ["POST", "/events", "memory:event"],
    ["POST", "/harness/v1/probe", "memory:session"],
    ["POST", "/harness/v1/events", "memory:session"],
    ["GET", "/reasoning", "memory:reasoning"],
    ["GET", "/export", "memory:export"],
    // P55: peer trust administration is its own non-tenant-mintable admin
    // tier — separate from routine federation data-plane sync. All 5 peer
    // sub-paths resolve to federation:admin, including the GETs (they
    // disclose pinned-cert metadata, a pin-substitution reconnaissance
    // surface). The DELETE row also proves the federation branch wins over
    // the generic `DELETE → memory:delete` fallback further down this file.
    ["GET", "/memory/federation/peers", "federation:admin"],
    ["GET", "/memory/federation/peers/pending", "federation:admin"],
    ["POST", "/memory/federation/peers/p1/approve", "federation:admin"],
    ["POST", "/memory/federation/peers/p1/approve-key", "federation:admin"],
    ["DELETE", "/memory/federation/peers/p1", "federation:admin"],
    // Data-plane federation routes are unaffected — negative controls.
    ["GET", "/memory/federation/items", "memory:federation"],
    ["POST", "/memory/federation/sync", "memory:federation"],
    ["GET", "/memory/federation/sync/j1", "memory:federation"],
    ["POST", "/memory/federation/resolve", "memory:federation"],
    ["POST", "/consolidation/run", "memory:governance"],
    ["GET", "/memory/ws", "memory:subscribe"],
    // Self-edit routes must enforce memory:self_edit scope (bug: was matching /self-edit with hyphen)
    ["POST", "/self/edit", "memory:self_edit"],
    ["POST", "/self/reflect", "memory:self_edit"],
    // P6/P29 workspace-level config management is admin-tier regardless of method
    // (rule manually re-added post-merge — pin it so it can't silently regress).
    ["GET", "/config/retention", "memory:admin"],
    ["PUT", "/config/retention", "memory:admin"],
    // SEC-1: platform-level (GLOBAL_SENTINEL_ID) config writes require the
    // non-tenant-grantable admin:workspace scope — memory:admin must NOT reach
    // these, since it's mintable by any tenant admin and these writes affect
    // every workspace/tenant on the instance. Reads stay memory:admin so
    // per-tenant operators can still inspect the effective global config.
    ["PUT", "/admin/config/llm", "admin:workspace"],
    ["POST", "/admin/config/llm", "admin:workspace"],
    ["DELETE", "/admin/config/llm", "admin:workspace"],
    ["GET", "/admin/config/llm", "memory:admin"],
    ["PUT", "/admin/config/retention", "admin:workspace"],
    ["POST", "/admin/config/retention", "admin:workspace"],
    ["DELETE", "/admin/config/retention", "admin:workspace"],
    ["GET", "/admin/config/retention", "memory:admin"],
    // Stats are readable by members; the handler trims admin-only fields.
    ["GET", "/admin/stats", ["memory:read", "memory:admin"]],
    ["POST", "/admin/stats", "memory:admin"],
    // Multi-tenant model. /tenants* and /users* are the tenant plane, always
    // admin:tenant regardless of method. Bare /workspaces* GET reads accept
    // either memory:read or the broader memory:admin (a workspace-role `read`
    // member, narrowed to memory:read only, must still be able to see their
    // own workspace list and its members); mutating /workspaces* routes stay
    // memory:admin only.
    ["POST", "/tenants", "admin:tenant"],
    ["GET", "/tenants/t1", "admin:tenant"],
    ["POST", "/tenants/t1/members", "admin:tenant"],
    ["GET", "/tenants/t1/workspaces", "admin:tenant"],
    ["POST", "/tenants/t1/workspaces", "admin:tenant"],
    ["POST", "/users", "admin:tenant"],
    // /users/me hits the earlier `endsWith("/me")` rule first (same as bare /me) — memory:read, not admin:tenant.
    ["GET", "/users/me", "memory:read"],
    ["GET", "/workspaces/mine", ["memory:read", "memory:admin"]],
    ["GET", "/workspaces/abc123", ["memory:read", "memory:admin"]],
    ["GET", "/workspaces/abc123/members", ["memory:read", "memory:admin"]],
    ["POST", "/workspaces/abc123/members", "memory:admin"],
    ["DELETE", "/workspaces/abc123/members/u1", "memory:admin"],
    ["PATCH", "/workspaces/abc123/members/u1", "memory:admin"],
    // Instance plane (dashboard bridge): admin:workspace for every method, ahead
    // of the /users, /workspaces and /admin substring rules.
    ["GET", "/dashboard/api/instance/users", "admin:workspace"],
    ["POST", "/dashboard/api/instance/users/u1/disable", "admin:workspace"],
    ["POST", "/dashboard/api/instance/users/u1/superadmin", "admin:workspace"],
    ["DELETE", "/dashboard/api/instance/users/u1/superadmin", "admin:workspace"],
    ["GET", "/dashboard/api/instance/workspaces/w1/members", "admin:workspace"],
    // Phase 2 routes on the bridge resolve through the same table.
    ["GET", "/dashboard/api/conflicts", "memory:read"],
    ["POST", "/dashboard/api/conflicts/c1/resolve", "memory:write"],
    ["POST", "/dashboard/api/recall/explain", "memory:read"],
    ["GET", "/dashboard/api/facts/f1", "memory:read"],
    ["GET", "/dashboard/api/admin/stats", ["memory:read", "memory:admin"]],
    ["GET", "/dashboard/api/timeline", "memory:read"],
    // Health history is an operator view: admin on v1 and on the bridge.
    ["GET", "/health/snapshots", "memory:admin"],
    ["GET", "/health/history", "memory:admin"],
    ["GET", "/dashboard/api/health/snapshots", "memory:admin"],
    ["GET", "/dashboard/api/health/history", "memory:admin"],
    ["GET", "/health/cognitive", "memory:read"],
    // The doctor's checks describe the installation: admin on v1 and on the bridge.
    ["GET", "/doctor", "memory:admin"],
    ["GET", "/dashboard/api/doctor", "memory:admin"],
  ];
  it.each(cases)("%s %s → %s", (method, path, expected) => {
    expect(getScopeForRequest(method, path)).toEqual(expected);
  });
});
