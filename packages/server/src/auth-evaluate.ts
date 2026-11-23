/**
 * Post-resolve key evaluation shared by the HTTP and gRPC transports
 * (AUTH-GRPC-PARITY).
 *
 * After resolveApiKey has matched a key, these decisions say whether the call
 * may go on, in which workspace and with which scopes. HTTP made them inline
 * in createAuthMiddleware while the gRPC interceptor skipped most of them,
 * which is how one key came to have more power over gRPC than over HTTP. One
 * implementation removes the drift.
 *
 * The function imports neither Hono nor Connect. Each transport reads its own
 * request (client IP, requested workspace), maps a deny reason onto its own
 * error, and emits its own metrics and logs, so HTTP keeps its error types,
 * messages and metric labels exactly.
 */
import type { KeyScope, WorkspaceRole } from "@mnemo-ai/types";
import { narrowScopesForWorkspaceRole } from "@mnemo-ai/types";
import { ipInCidr } from "@mnemo-ai/core";
import type { UserStatusService } from "./user-status.js";

/** §6 key rotation: a deprecated key stays valid for a 7-day sunset window. */
export const DEPRECATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Set to true to disable workspace-role scope narrowing entirely (rollback
 * kill switch, mirrors MNEMO_ALLOW_LEGACY_FULL_SCOPE's precedent in app.ts).
 * Read once at module load — this is a deploy-time posture, not a per-request
 * decision. Both transports read it from here so they cannot disagree.
 */
export const workspaceRoleScopesDisabled =
  process.env.MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES === "true";

/**
 * Accounts stage A lifecycle gate, shared by every path that authenticates a
 * key or a session minted from one (HTTP bearer, gRPC, WebSocket, /health/deep,
 * dashboard API-key sign-in and sessions): a key bound to a disabled (or
 * unknown) user does not authenticate while the user is disabled.
 *
 * True when the key has no user or no status service is wired (no Postgres).
 * Throws when the status cannot be read; callers answer "unavailable", never
 * "allowed". Each transport maps false and the throw onto its own errors.
 */
export async function keyUserAllowed(
  userStatus: Pick<UserStatusService, "get"> | undefined,
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId || !userStatus) return true;
  const status = await userStatus.get(userId);
  return status !== null && !status.disabledAt;
}

/** What evaluation needs from a resolved key row. */
export interface ResolvedKeyFacts {
  workspaceId: string;
  scopes: ReadonlyArray<string>;
  ipAllowlist?: ReadonlyArray<string>;
  /** A cached row can carry it as a string. */
  deprecatedAt?: Date | string | null;
  userId?: string | null;
}

/** What evaluation needs from the request, read by the transport. */
export interface PostResolveRequest {
  /** "" when the transport found no client IP. */
  clientIp: string;
  /** The workspace the caller asked for; absent or "" means the key's own. */
  requestedWorkspaceId?: string | null;
  /** The key is a user token (`uk_*`, or a row of kind "user"). */
  tokenIsUserKind: boolean;
  /** HTTP supports switching workspaces with a user token; gRPC does not. */
  allowWorkspaceSwitch: boolean;
  /** Epoch ms. */
  now: number;
}

/** Lookups and flags each transport supplies, so each keeps its own caches. */
export interface PostResolveHooks {
  /** The user's role in a workspace, or null when not a member. */
  resolveRole?: (userId: string, workspaceId: string) => Promise<string | null>;
  /** Membership only, for lookups without resolveRole: switches with no narrowing. */
  verifyMember?: (userId: string, workspaceId: string) => Promise<boolean>;
  disableRoleScopes: boolean;
}

export type PostResolveDenyReason =
  | "ip_denied"
  | "deprecated_sunset"
  | "workspace_switch_unsupported"
  | "not_user_token"
  | "missing_user_binding"
  | "not_member"
  | "verifier_missing";

/** A deprecated key inside its grace window: transports advertise the sunset. */
export interface KeyDeprecation {
  deprecatedAt: Date;
  sunset: Date;
}

export type PostResolveDecision =
  | {
      ok: true;
      workspaceId: string;
      scopes: ReadonlyArray<string>;
      workspaceRole: string | null;
      /** A role was found and narrowing is on: the narrowing metric counts it. */
      roleNarrowed: boolean;
      deprecation?: KeyDeprecation;
      /**
       * role_lookup_degraded: switched on membership alone, scopes not narrowed.
       * home_role_missing: no membership row in the key's own workspace; the
       * key's scopes are kept so a legacy key is not bricked.
       */
      note?: "role_lookup_degraded" | "home_role_missing";
    }
  | {
      ok: false;
      reason: PostResolveDenyReason;
      message: string;
      /** Set when the deny came after the deprecation check passed. */
      deprecation?: KeyDeprecation;
    };

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return value === "read" || value === "write" || value === "admin" || value === "owner";
}

/**
 * Decides, in this order: IP allowlist, deprecation sunset, workspace switch
 * and membership, home-workspace role, role narrowing. Narrowing can only
 * remove scopes from the key's own list, never add one.
 */
export async function evaluateResolvedKey(
  key: ResolvedKeyFacts,
  req: PostResolveRequest,
  hooks: PostResolveHooks
): Promise<PostResolveDecision> {
  // SEC-2: per-key IP allowlist. Empty/absent = unrestricted.
  const allow = key.ipAllowlist ?? [];
  if (allow.length > 0) {
    const ok = req.clientIp !== "" && allow.some((entry) => ipInCidr(req.clientIp, entry));
    if (!ok) return { ok: false, reason: "ip_denied", message: "IP not in allowlist" };
  }

  // §6 key lifecycle: revoked/expired keys are already excluded by the lookup;
  // a deprecated key stays valid for DEPRECATION_GRACE_MS, then is rejected.
  let deprecation: KeyDeprecation | undefined;
  if (key.deprecatedAt) {
    const dep = key.deprecatedAt instanceof Date ? key.deprecatedAt : new Date(key.deprecatedAt);
    const sunset = new Date(dep.getTime() + DEPRECATION_GRACE_MS);
    if (req.now > sunset.getTime()) {
      return {
        ok: false,
        reason: "deprecated_sunset",
        message: "API key deprecated and past its sunset; rotate to a new key",
      };
    }
    deprecation = { deprecatedAt: dep, sunset };
  }
  const deny = (reason: PostResolveDenyReason, message: string): PostResolveDecision => ({
    ok: false,
    reason,
    message,
    ...(deprecation ? { deprecation } : {}),
  });

  let workspaceId = key.workspaceId;
  let workspaceRole: string | null = null;
  let note: "role_lookup_degraded" | "home_role_missing" | undefined;

  // P33: a user token may target another workspace it is a member of.
  const requested = req.requestedWorkspaceId;
  if (requested && requested !== key.workspaceId) {
    if (!req.allowWorkspaceSwitch) {
      return deny(
        "workspace_switch_unsupported",
        "This transport does not switch workspaces; omit the workspace or use the key's own"
      );
    }
    if (!req.tokenIsUserKind) {
      return deny("not_user_token", "Multi-workspace requests require a user token (uk_live_*)");
    }
    if (!key.userId) {
      return deny("missing_user_binding", "Multi-workspace requests require a user-bound key");
    }
    if (hooks.resolveRole) {
      workspaceRole = await hooks.resolveRole(key.userId, requested);
      if (workspaceRole === null) {
        return deny("not_member", `User is not a member of workspace '${requested}'`);
      }
    } else if (hooks.verifyMember) {
      // Degraded path: membership-gate only, no role → no narrowing.
      if (!(await hooks.verifyMember(key.userId, requested))) {
        return deny("not_member", `User is not a member of workspace '${requested}'`);
      }
      note = "role_lookup_degraded";
    } else {
      return deny("verifier_missing", "Workspace membership verification unavailable");
    }
    workspaceId = requested;
  } else if (key.userId && hooks.resolveRole) {
    // The key's own workspace is narrowed by role too, when a membership row
    // exists. A missing row FAILS OPEN (keep the key's scopes) rather than
    // bricking a legacy/bootstrap key minted before narrowing existed.
    workspaceRole = await hooks.resolveRole(key.userId, key.workspaceId);
    if (workspaceRole === null) note = "home_role_missing";
  }

  // Role -> scope narrowing (S4).
  const scopes =
    workspaceRole && !hooks.disableRoleScopes && isWorkspaceRole(workspaceRole)
      ? narrowScopesForWorkspaceRole(key.scopes as ReadonlyArray<KeyScope>, workspaceRole)
      : key.scopes;

  return {
    ok: true,
    workspaceId,
    scopes,
    workspaceRole,
    roleNarrowed: Boolean(workspaceRole) && !hooks.disableRoleScopes,
    ...(deprecation ? { deprecation } : {}),
    ...(note ? { note } : {}),
  };
}
