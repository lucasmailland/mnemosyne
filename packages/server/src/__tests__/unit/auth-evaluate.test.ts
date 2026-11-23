/**
 * AUTH-GRPC-PARITY — the post-resolve evaluator both transports share.
 *
 * It holds the decisions the HTTP auth middleware made inline after
 * resolveApiKey: IP allowlist, deprecation sunset, workspace switch and
 * membership, and role narrowing. HTTP behaviour is pinned by its own suites
 * (user-token-auth, auth-deprecation, auth-ip-allowlist, …), which this change
 * leaves untouched; these cases pin the evaluator itself.
 */
import { describe, it, expect, vi } from "vitest";
import {
  evaluateResolvedKey,
  DEPRECATION_GRACE_MS,
  type PostResolveRequest,
  type PostResolveHooks,
  type ResolvedKeyFacts,
} from "../../auth-evaluate.js";

const HOME = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function key(over: Partial<ResolvedKeyFacts> = {}): ResolvedKeyFacts {
  return { workspaceId: HOME, scopes: ["memory:read", "memory:write"], ...over };
}

function request(over: Partial<PostResolveRequest> = {}): PostResolveRequest {
  return {
    clientIp: "",
    requestedWorkspaceId: null,
    tokenIsUserKind: false,
    allowWorkspaceSwitch: true,
    now: NOW,
    ...over,
  };
}

function hooks(over: Partial<PostResolveHooks> = {}): PostResolveHooks {
  return { disableRoleScopes: false, ...over };
}

describe("evaluateResolvedKey — a plain key", () => {
  it("allows a key with no allowlist, deprecation, user or switch, unchanged", async () => {
    const d = await evaluateResolvedKey(key(), request(), hooks());
    expect(d).toEqual({
      ok: true,
      workspaceId: HOME,
      scopes: ["memory:read", "memory:write"],
      workspaceRole: null,
      roleNarrowed: false,
    });
  });
});

describe("evaluateResolvedKey — IP allowlist", () => {
  it("allows a caller inside an allowlisted CIDR", async () => {
    const d = await evaluateResolvedKey(
      key({ ipAllowlist: ["10.0.0.0/8"] }),
      request({ clientIp: "10.1.2.3" }),
      hooks()
    );
    expect(d.ok).toBe(true);
  });

  it("denies a caller outside every allowlisted CIDR", async () => {
    const d = await evaluateResolvedKey(
      key({ ipAllowlist: ["10.0.0.0/8"] }),
      request({ clientIp: "192.168.1.1" }),
      hooks()
    );
    expect(d).toEqual({ ok: false, reason: "ip_denied", message: "IP not in allowlist" });
  });

  it("denies a caller with no IP when the key has an allowlist", async () => {
    const d = await evaluateResolvedKey(key({ ipAllowlist: ["10.0.0.0/8"] }), request(), hooks());
    expect(d).toMatchObject({ ok: false, reason: "ip_denied" });
  });

  it("checks the allowlist before the sunset", async () => {
    const d = await evaluateResolvedKey(
      key({ ipAllowlist: ["10.0.0.0/8"], deprecatedAt: new Date(NOW - 30 * DAY) }),
      request({ clientIp: "192.168.1.1" }),
      hooks()
    );
    expect(d).toMatchObject({ ok: false, reason: "ip_denied" });
    expect(d).not.toHaveProperty("deprecation");
  });
});

describe("evaluateResolvedKey — deprecation", () => {
  it("allows a deprecated key inside the 7-day grace and reports its sunset", async () => {
    const deprecatedAt = new Date(NOW - 2 * DAY);
    const d = await evaluateResolvedKey(key({ deprecatedAt }), request(), hooks());
    expect(d).toMatchObject({
      ok: true,
      deprecation: { deprecatedAt, sunset: new Date(deprecatedAt.getTime() + 7 * DAY) },
    });
    expect(DEPRECATION_GRACE_MS).toBe(7 * DAY);
  });

  it("accepts deprecatedAt as a string, as a cached row may carry it", async () => {
    const d = await evaluateResolvedKey(
      key({ deprecatedAt: new Date(NOW - DAY).toISOString() }),
      request(),
      hooks()
    );
    expect(d).toMatchObject({ ok: true, deprecation: { deprecatedAt: new Date(NOW - DAY) } });
  });

  it("denies a key past its sunset, without a deprecation to report", async () => {
    const d = await evaluateResolvedKey(
      key({ deprecatedAt: new Date(NOW - 8 * DAY) }),
      request(),
      hooks()
    );
    expect(d).toEqual({
      ok: false,
      reason: "deprecated_sunset",
      message: "API key deprecated and past its sunset; rotate to a new key",
    });
  });

  it("still allows a key exactly at its sunset", async () => {
    const d = await evaluateResolvedKey(
      key({ deprecatedAt: new Date(NOW - 7 * DAY) }),
      request(),
      hooks()
    );
    expect(d.ok).toBe(true);
  });

  it("reports the deprecation on a later deny, so the transport can still send it", async () => {
    const deprecatedAt = new Date(NOW - DAY);
    const d = await evaluateResolvedKey(
      key({ deprecatedAt }),
      request({ requestedWorkspaceId: OTHER }),
      hooks()
    );
    expect(d).toMatchObject({ ok: false, reason: "not_user_token", deprecation: { deprecatedAt } });
  });
});

describe("evaluateResolvedKey — workspace switch", () => {
  it("treats a request for the key's own workspace as no switch", async () => {
    const d = await evaluateResolvedKey(
      key(),
      request({ requestedWorkspaceId: HOME, allowWorkspaceSwitch: false }),
      hooks()
    );
    expect(d).toMatchObject({ ok: true, workspaceId: HOME });
  });

  it("treats an empty requested workspace as none", async () => {
    const d = await evaluateResolvedKey(
      key(),
      request({ requestedWorkspaceId: "", allowWorkspaceSwitch: false }),
      hooks()
    );
    expect(d).toMatchObject({ ok: true, workspaceId: HOME });
  });

  it("denies any switch on a transport that does not support it, before any lookup", async () => {
    const resolveRole = vi.fn();
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true, allowWorkspaceSwitch: false }),
      hooks({ resolveRole })
    );
    expect(d).toMatchObject({ ok: false, reason: "workspace_switch_unsupported" });
    expect(resolveRole).not.toHaveBeenCalled();
  });

  it("denies a switch with a key that is not a user token", async () => {
    const d = await evaluateResolvedKey(key(), request({ requestedWorkspaceId: OTHER }), hooks());
    expect(d).toEqual({
      ok: false,
      reason: "not_user_token",
      message: "Multi-workspace requests require a user token (uk_live_*)",
    });
  });

  it("denies a switch with a user token bound to no user", async () => {
    const d = await evaluateResolvedKey(
      key(),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true }),
      hooks()
    );
    expect(d).toEqual({
      ok: false,
      reason: "missing_user_binding",
      message: "Multi-workspace requests require a user-bound key",
    });
  });

  it("switches to a workspace the user is a member of, narrowed by that role", async () => {
    const resolveRole = vi.fn().mockResolvedValue("read");
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true }),
      hooks({ resolveRole })
    );
    expect(resolveRole).toHaveBeenCalledWith("u1", OTHER);
    expect(d).toEqual({
      ok: true,
      workspaceId: OTHER,
      scopes: ["memory:read"],
      workspaceRole: "read",
      roleNarrowed: true,
    });
  });

  it("denies a switch to a workspace the user is not a member of", async () => {
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true }),
      hooks({ resolveRole: vi.fn().mockResolvedValue(null) })
    );
    expect(d).toEqual({
      ok: false,
      reason: "not_member",
      message: `User is not a member of workspace '${OTHER}'`,
    });
  });

  it("falls back to the membership check, without narrowing, when no role lookup exists", async () => {
    const verifyMember = vi.fn().mockResolvedValue(true);
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true }),
      hooks({ verifyMember })
    );
    expect(verifyMember).toHaveBeenCalledWith("u1", OTHER);
    expect(d).toEqual({
      ok: true,
      workspaceId: OTHER,
      scopes: ["memory:read", "memory:write"],
      workspaceRole: null,
      roleNarrowed: false,
      note: "role_lookup_degraded",
    });
  });

  it("denies a non-member through the membership fallback", async () => {
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true }),
      hooks({ verifyMember: vi.fn().mockResolvedValue(false) })
    );
    expect(d).toMatchObject({ ok: false, reason: "not_member" });
  });

  it("denies a switch when nothing can verify membership", async () => {
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request({ requestedWorkspaceId: OTHER, tokenIsUserKind: true }),
      hooks()
    );
    expect(d).toEqual({
      ok: false,
      reason: "verifier_missing",
      message: "Workspace membership verification unavailable",
    });
  });
});

describe("evaluateResolvedKey — home-workspace role", () => {
  it("narrows a user-bound key by its role in its own workspace", async () => {
    const resolveRole = vi.fn().mockResolvedValue("read");
    const d = await evaluateResolvedKey(key({ userId: "u1" }), request(), hooks({ resolveRole }));
    expect(resolveRole).toHaveBeenCalledWith("u1", HOME);
    expect(d).toMatchObject({
      ok: true,
      scopes: ["memory:read"],
      workspaceRole: "read",
      roleNarrowed: true,
    });
  });

  it("fails open when the user has no membership row in its own workspace", async () => {
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request(),
      hooks({ resolveRole: vi.fn().mockResolvedValue(null) })
    );
    expect(d).toEqual({
      ok: true,
      workspaceId: HOME,
      scopes: ["memory:read", "memory:write"],
      workspaceRole: null,
      roleNarrowed: false,
      note: "home_role_missing",
    });
  });

  it("looks up no role for a key bound to no user", async () => {
    const resolveRole = vi.fn();
    await evaluateResolvedKey(key(), request(), hooks({ resolveRole }));
    expect(resolveRole).not.toHaveBeenCalled();
  });

  it("does not use the membership fallback for the home workspace", async () => {
    const verifyMember = vi.fn();
    const d = await evaluateResolvedKey(key({ userId: "u1" }), request(), hooks({ verifyMember }));
    expect(verifyMember).not.toHaveBeenCalled();
    expect(d).toMatchObject({ ok: true, workspaceRole: null });
  });

  it("keeps the key's scopes but the role when the kill switch is on", async () => {
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request(),
      hooks({ resolveRole: vi.fn().mockResolvedValue("read"), disableRoleScopes: true })
    );
    expect(d).toMatchObject({
      ok: true,
      scopes: ["memory:read", "memory:write"],
      workspaceRole: "read",
      roleNarrowed: false,
    });
  });

  it("leaves the scopes alone for a role it does not know, but still counts it", async () => {
    const d = await evaluateResolvedKey(
      key({ userId: "u1" }),
      request(),
      hooks({ resolveRole: vi.fn().mockResolvedValue("viewer") })
    );
    expect(d).toMatchObject({
      ok: true,
      scopes: ["memory:read", "memory:write"],
      workspaceRole: "viewer",
      roleNarrowed: true,
    });
  });
});
