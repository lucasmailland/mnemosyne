// Security, auth, RBAC, and sensitivity types — SECURITY.md §2, §3, §5
// TASK-2003 deliverable.

import type { Sensitivity } from "./common.js";
import type { HealthStatus } from "./common.js";
import type { ActorType } from "./provenance.js";
import type { AuditAction } from "./audit.js";
import type { LLMTask } from "./ports.js";

// ─── Sensitivity ordering (fixes MED-23: comparison was string equality) ──────
//
// Sensitivity tiers map to integers. ALWAYS compare using SENSITIVITY_ORDER or
// sensitivityAtLeast() — NEVER with string equality or alphabetic comparison.
//
// MED-23 root cause: "confidential" > "internal" is alphabetically correct but
// semantically wrong (internal=1 < confidential=2). String comparison produced
// inverted access decisions.
//
// Enforcement rule:
//   - On ceiling violation: return 404 NOT 403 (anti-probing — do not confirm existence)
//   - Auth context carries maxSensitivity; fact carries sensitivity
//   - Access allowed when: SENSITIVITY_ORDER[fact.sensitivity] <= SENSITIVITY_ORDER[auth.maxSensitivity]

export const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0, // visible to anyone with workspace read access
  internal: 1, // workspace-internal, not for external sharing
  confidential: 2, // restricted distribution within workspace
  restricted: 3, // highest tier: need-to-know only
};

/**
 * Returns true if sensitivity `a` is at or above tier `b`.
 * Use this when checking if a fact's sensitivity is within the caller's ceiling.
 *
 * @example
 * // Allow access only if caller's ceiling >= fact's sensitivity
 * if (!sensitivityAtLeast(auth.maxSensitivity, fact.sensitivity)) {
 *   return notFound(); // 404, never 403 (anti-probing rule)
 * }
 */
export function sensitivityAtLeast(a: Sensitivity, b: Sensitivity): boolean {
  return SENSITIVITY_ORDER[a] >= SENSITIVITY_ORDER[b];
}

/** The tiers a caller with `ceiling` may read, lowest first. */
export function tiersAtOrBelow(ceiling: Sensitivity): Sensitivity[] {
  return (Object.keys(SENSITIVITY_ORDER) as Sensitivity[]).filter(
    (tier) => SENSITIVITY_ORDER[tier] <= SENSITIVITY_ORDER[ceiling]
  );
}

// ─── Sensitive text to providers (SECURITY.md §7) ─────────────────────────────

/**
 * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS: which external providers may receive the
 * plaintext of confidential and restricted text.
 *   none   neither the embedder nor the completion provider
 *   embed  the embedder only (the default)
 *   all    both
 * A provider the operator runs locally is not egress and gets it under any value
 * (`EmbedAdapter.local`, `LLMAdapter.localTasks`).
 */
export type SensitiveTextPolicy = "none" | "embed" | "all";

/** Confidential, restricted, or a tier that is missing or unknown: fail closed. */
export function isSensitiveTier(tier: Sensitivity | null | undefined): boolean {
  // Own properties only: `in` would accept "toString" or "__proto__".
  const rank =
    typeof tier === "string" && Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, tier)
      ? SENSITIVITY_ORDER[tier]
      : undefined;
  return typeof rank !== "number" || rank >= SENSITIVITY_ORDER.confidential;
}

/** Whether confidential+ text may go to this embedder. */
export function sensitiveTextMayReachEmbedder(
  policy: SensitiveTextPolicy | undefined,
  embed: { readonly local?: boolean } | undefined
): boolean {
  return (policy ?? "embed") !== "none" || embed?.local === true;
}

/**
 * Whether confidential+ text may go to this completion adapter for `task`. A
 * completion with no task is routed to whatever answers by default, so it never
 * counts as local: only `all` lets it through.
 */
export function sensitiveTextMayReachLlm(
  policy: SensitiveTextPolicy | undefined,
  llm: { readonly localTasks?: readonly LLMTask[] } | undefined,
  task: LLMTask | undefined
): boolean {
  if (policy === "all") return true;
  return task !== undefined && Array.isArray(llm?.localTasks) && llm.localTasks.includes(task);
}

// ─── API Key types ─────────────────────────────────────────────────────────────

export type ApiKeyType = "mk_live_" | "mk_test_" | "mk_sess_" | "mk_fed_" | "mk_admin_";

// ─── Scopes ────────────────────────────────────────────────────────────────────

export type KeyScope =
  | "memory:read"
  | "memory:write"
  | "memory:delete"
  | "memory:admin"
  | "memory:hard_delete"
  | "memory:session"
  | "memory:task"
  | "memory:event"
  | "memory:self_edit"
  | "memory:procedural"
  | "memory:reasoning"
  | "memory:export"
  | "memory:governance"
  | "memory:subscribe"
  | "session:read"
  | "session:write"
  | "session:manage"
  | "entity:read"
  | "entity:write"
  | "entity:admin"
  | "federation:read"
  | "federation:write"
  | "federation:manage"
  // Peer trust administration (approve/reject/revoke a federation peer) is a
  // separate, non-tenant-mintable authority tier from routine federation
  // data-plane sync — see WORKSPACE_ADMIN_SCOPES below and the SPEC_SCOPES
  // comment. Never add this to SPEC_SCOPES (same precedent as admin:workspace).
  | "federation:admin"
  | "memory:federation" // canonical name — XDC-06 fix
  | "admin:keys"
  | "admin:workspace"
  | "admin:billing"
  | "admin:tenant";

export const ALL_SCOPES: ReadonlyArray<KeyScope> = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:admin",
  "memory:hard_delete",
  "memory:session",
  "memory:task",
  "memory:event",
  "memory:self_edit",
  "memory:procedural",
  "memory:reasoning",
  "memory:export",
  "memory:governance",
  "memory:subscribe",
  "session:read",
  "session:write",
  "session:manage",
  "entity:read",
  "entity:write",
  "entity:admin",
  "federation:read",
  "federation:write",
  "federation:manage",
  "federation:admin",
  "memory:federation",
  "admin:keys",
  "admin:workspace",
  "admin:billing",
  "admin:tenant",
] as const;

// ─── Spec §6 — 15 canonical memory scopes ─────────────────────────────────────

// NOTE: "federation:admin" is deliberately NOT listed here, mirroring the
// existing "admin:workspace" precedent — SPEC_SCOPES is the set a
// workspace-scoped dashboard/MCP flow can self-mint, and peer trust
// administration must stay operator-provisioned only (out-of-band via
// POST /admin/keys or the create-api-key.cjs bootstrap script).
export const SPEC_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:hard_delete",
  "memory:session",
  "memory:task",
  "memory:event",
  "memory:self_edit",
  "memory:procedural",
  "memory:reasoning",
  "memory:export",
  "memory:admin",
  "memory:federation",
  "memory:governance",
  "memory:subscribe",
] as const;

export type SpecScope = (typeof SPEC_SCOPES)[number];

// ─── Workspace membership roles → scope narrowing ─────────────────────────────
//
// mnemo_workspace_member.role is one of 4 values (owner/admin/write/read). It
// governs what a user-token (uk_live_*) request may do IN A SPECIFIC WORKSPACE
// — narrower than, and never wider than, the token's own static scopes. See
// docs/architecture/MULTI_TENANCY.md for the full model and rationale.
//
// Tenant-plane scopes (admin:tenant, admin:billing) and the instance-global
// admin:workspace scope are NEVER narrowed by a workspace role — they belong
// to a different, orthogonal authority plane (see WORKSPACE_GOVERNED_SCOPES).

export type WorkspaceRole = "read" | "write" | "admin" | "owner";

export const WORKSPACE_ROLE_ORDER: Record<WorkspaceRole, number> = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};

/** Returns true if workspace role `a` is at or above tier `b`. */
export function roleAtLeast(a: WorkspaceRole, b: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_ORDER[a] >= WORKSPACE_ROLE_ORDER[b];
}

/** Scopes governed by workspace membership role — every scope except the 3 tenant/instance-plane ones. */
export const WORKSPACE_GOVERNED_SCOPES: ReadonlySet<KeyScope> = new Set(
  ALL_SCOPES.filter((s) => s !== "admin:tenant" && s !== "admin:billing" && s !== "admin:workspace")
);

const WORKSPACE_READ_SCOPES: ReadonlyArray<KeyScope> = [
  "memory:read",
  "memory:subscribe",
  "session:read",
  "entity:read",
  "federation:read",
];

const WORKSPACE_WRITE_SCOPES: ReadonlyArray<KeyScope> = [
  ...WORKSPACE_READ_SCOPES,
  "memory:write",
  "memory:delete",
  "memory:session",
  "memory:task",
  "memory:event",
  "memory:reasoning",
  "memory:procedural",
  "memory:self_edit",
  "session:write",
  "entity:write",
];

const WORKSPACE_ADMIN_SCOPES: ReadonlyArray<KeyScope> = [
  ...WORKSPACE_WRITE_SCOPES,
  "memory:admin",
  "memory:hard_delete",
  "memory:export",
  "memory:governance",
  "memory:federation",
  "admin:keys",
  "session:manage",
  "entity:admin",
  "federation:write",
  "federation:manage",
  "federation:admin",
];

/**
 * Scopes a member with this workspace role may exercise IN THAT WORKSPACE.
 * `owner` and `admin` are deliberately scope-identical: the owner/admin
 * distinction is a membership-management privilege (transfer ownership,
 * remove the last owner, delete the workspace), not a difference in what
 * memory operations are allowed — see `requireWorkspaceAdmin` in
 * `packages/server/src/routes/tenants.ts`. Inventing an owner-only scope
 * with no route behind it would be speculative surface this codebase avoids.
 */
export const WORKSPACE_ROLE_SCOPES: Record<WorkspaceRole, ReadonlySet<KeyScope>> = {
  read: new Set(WORKSPACE_READ_SCOPES),
  write: new Set(WORKSPACE_WRITE_SCOPES),
  admin: new Set(WORKSPACE_ADMIN_SCOPES),
  owner: new Set(WORKSPACE_ADMIN_SCOPES),
};

/**
 * Narrow a key's own static scopes down to what its workspace membership
 * role allows IN THIS WORKSPACE. Tenant/instance-plane scopes (outside
 * `WORKSPACE_GOVERNED_SCOPES`) always pass through untouched — a different
 * authority plane. This can only ever REMOVE scopes from the input, never
 * add one: a workspace role can never grant more than the key already had.
 */
export function narrowScopesForWorkspaceRole(
  keyScopes: ReadonlyArray<KeyScope>,
  role: WorkspaceRole
): ReadonlyArray<KeyScope> {
  const allowed = WORKSPACE_ROLE_SCOPES[role];
  return keyScopes.filter((s) => !WORKSPACE_GOVERNED_SCOPES.has(s) || allowed.has(s));
}

// ─── Auth context ──────────────────────────────────────────────────────────────

export interface KeyDeprecation {
  deprecated: true;
  /** ISO-8601 sunset instant = deprecatedAt + 7 days. */
  sunset: string;
}

/** One row of markUsed history, newest first (for anomaly detection). */
export interface KeyUsageEvent {
  ipAddress: string;
  at: Date;
}

export interface RotateKeyResult {
  /** The full new key shown ONCE (SECURITY.md §2.2). */
  newKey: string;
  newKeyId: string;
  /** The old key's ISO sunset (deprecatedAt + 7 days). */
  sunset: string;
}

export interface KeyEscrowEntry {
  keyId: string;
  prefix: ApiKeyType;
  workspaceId: string;
  scopes: KeyScope[];
  action: "rotate" | "revoke" | "break_glass";
  reason: string;
  escrowedAt: Date;
}

export interface AuthContext {
  workspaceId: string;
  actorId: string;
  actorType: ActorType;
  /** The platform account (mnemo_user.id) behind this action, when one exists. */
  userId?: string | null;
  scopes: ReadonlyArray<KeyScope>;
  keyType?: ApiKeyType;
  federationPeer?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Set when the authenticating key is in its 7-day deprecation grace
   * (SECURITY.md §2.2). The middleware emits Deprecation/Sunset/
   * Mnemosyne-Key-Deprecated headers from this.
   */
  keyDeprecation?: KeyDeprecation;
  /**
   * Per-key recall sensitivity ceiling carried by the key grant (§5, MED-23).
   * When present it can only LOWER the effective recall ceiling below the
   * process-wide MNEMO_SENSITIVITY_CEILING — never raise it (the effective
   * ceiling is min(envCeiling, keyMax) via SENSITIVITY_ORDER). Undefined for
   * legacy/non-scoped keys → the process-wide ceiling applies unchanged.
   */
  maxSensitivity?: Sensitivity;
}

export type AuthResult =
  | { ok: true; context: AuthContext }
  | {
      ok: false;
      code: "UNAUTHORIZED" | "FORBIDDEN" | "TOKEN_EXPIRED" | "REVOKED" | "INVALID";
      reason: string;
      /**
       * Audit-only. Optional for every `AuthAdapter` — only `ScopedApiKeyAdapter`
       * currently sets these so `authenticateScoped()` can emit `ip_denied` /
       * (future) failure audit entries before the rejection throws.
       */
      workspaceId?: string;
      keyId?: string;
      auditAction?: AuditAction;
    };

// ─── Credentials ──────────────────────────────────────────────────────────────

export interface InheritedContext {
  workspaceId: string;
  actorId: string;
  actorType: "agent" | "user" | "system";
  scopes: KeyScope[];
  hostSignature?: string;
}

export interface RawCredentials {
  bearer?: string;
  apiKey?: string;
  clientCert?: Uint8Array; // mTLS peer certificate (DER)
  inherited?: InheritedContext;
  /** SEC-03: client IP for allowlist enforcement in ScopedApiKeyAdapter */
  clientIp?: string;
  /** Break-glass: TOTP code for mk_admin_ keys (SECURITY.md §2.2). */
  mfaToken?: string;
}

export interface AuthOperation {
  action: KeyScope;
  resource?: string;
  workspaceId?: string;
}

// ─── AuthAdapter port ─────────────────────────────────────────────────────────

export interface AuthAdapter {
  readonly id: string;

  authenticate(credentials: RawCredentials): Promise<AuthResult>;
  authorize(context: AuthContext, operation: AuthOperation): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
}

// ─── API Key store interface (used by ScopedApiKeyAdapter) ───────────────────

export interface ApiKeyRecord {
  keyId: string;
  prefix: ApiKeyType;
  hashedSecret: string;
  workspaceId: string;
  scopes: KeyScope[];
  status: "active" | "deprecated" | "revoked";
  expiresAt: Date | null;
  rotatedFromId?: string;
  ipAllowlist?: string[];
  createdAt: Date;
  lastUsedAt?: Date;
  /** Set when status flips to "deprecated" during rotation (§3.3). */
  deprecatedAt?: Date | null;
  /** TOTP shared secret (base32) for mk_admin_ break-glass keys. */
  mfaSecret?: string | null;
  /** AB6.2: workspace.is_test flag — populated by store to enable test/prod key isolation. */
  isTest?: boolean;
  /**
   * The platform user who issued the key (mnemo_user.id), when a user-bound
   * caller issued it. Break-glass dual control keys on it, so an mk_admin_ key
   * always carries one.
   */
  userId?: string | null;
  /**
   * Per-key recall sensitivity ceiling grant (§5). When set, it lowers the
   * effective recall ceiling for requests made with this key below the
   * process-wide MNEMO_SENSITIVITY_CEILING (never raises it). Absent on legacy
   * keys → the process-wide ceiling applies unchanged.
   */
  maxSensitivity?: Sensitivity;
}

export interface ApiKeyStore {
  lookup(prefix: ApiKeyType, keyId: string): Promise<ApiKeyRecord | null>;
  markUsed(keyId: string, ipAddress: string): Promise<void>;
  revoke(keyId: string, reason: string): Promise<void>;
  /** Newest-first usage history for anomaly detection. */
  recentUsage(keyId: string, limit: number): Promise<KeyUsageEvent[]>;
  /** Flip a key to deprecated with a grace window (rotation step 3). */
  deprecate(keyId: string, deprecatedAt: Date): Promise<void>;
  /** Persist a new key record (rotation step 1); returns nothing. */
  insert(record: ApiKeyRecord): Promise<void>;
  /** Append-only escrow of key METADATA (never the secret) for forensics. */
  escrow(entry: KeyEscrowEntry): Promise<void>;
}

// ─── Deployment tier ──────────────────────────────────────────────────────────

export type DeploymentTier = "personal" | "team" | "cloud" | "embedded";

// ─── Agent memory access policy (spec §19) ────────────────────────────────────

export type ApprovalTrigger =
  | "delete_fact"
  | "overwrite_decision"
  | "write_entity"
  | "cross_agent_read"
  | "bulk_export"
  | "federation_share"
  | "procedural_evolution"
  | "task_delegation";

export interface SelfEditPolicy {
  enabled: boolean;
  maxWorthDelta?: number;
}

export interface AgentMemoryAccess {
  agentId: string;
  workspaceId: string;
  readScopes: SpecScope[];
  writeScopes: SpecScope[];
  selfEdit: SelfEditPolicy;
  taskScopes: {
    canCreate: boolean;
    canDelegate: boolean;
    canDelegateTo: string[];
  };
  limits: {
    maxRecallsPerMinute: number;
    maxWritesPerMinute: number;
    maxSessionsConcurrent: number;
    maxSelfEditsPerSession: number;
  };
  requireApprovalFor: ApprovalTrigger[];
  federationAccess: "none" | "read" | "read_write";
}

// ─── Injection guard ──────────────────────────────────────────────────────────

export interface InjectionGuardResult {
  score: number; // 0–1; high = likely injection attempt
  flagged: boolean;
  reason?: string;
}

// ─── Wave X — Active Security Detection ──────────────────────────────────────

/**
 * Noisy-OR injection score for recall-path text.
 * Aggregates all matched poisoning categories.
 */
export interface InjectionScore {
  /** Composite noisy-OR probability in [0, 1]; high = likely injection. */
  score: number;
  flagged: boolean;
  categories: string[];
}

// ─── Column-level encryption (SECURITY.md §7) ────────────────────────────────

/**
 * Wire format for an AES-256-GCM encrypted field stored in the database.
 * Identified by the sentinel prefix "enc:v1:" when serialized to a column.
 */
export interface EncryptedField {
  /** AES-256-GCM ciphertext, base64-encoded. */
  ciphertext: string;
  /** GCM IV, base64-encoded (12 bytes). */
  iv: string;
  /** GCM authentication tag, base64-encoded (16 bytes). */
  tag: string;
  /** DEK identifier — used for rotation auditing. */
  dekId: string;
  algorithm: "AES-256-GCM";
}

/**
 * Write-time semantic anomaly score derived from neighbour cosine similarities.
 */
export interface AnomalyScore {
  /** Composite anomaly probability in [0, 1]; high = anomalous. */
  score: number;
  flagged: boolean;
  signals: {
    /** Isolation score: 1 − mean(neighbour cosine sims). High = isolated from existing knowledge. */
    distance: number;
    /** Estimated PII density derived from piiRiskScore. */
    piiDensity: number;
    /** Fraction of neighbours in contradiction zone [0.80, 0.97). */
    contradiction: number;
  };
}
