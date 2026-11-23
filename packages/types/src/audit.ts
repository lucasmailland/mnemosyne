// Audit log types — DATA_MODEL.md §4.8 (SECURITY.md §6)
// mnemo_audit_log is append-only: INSERT only for app role, enforced by trigger.

import type { ActorType } from "./provenance.js";

export type AuditAction =
  | "recall"
  | "create"
  | "update"
  | "delete"
  | "hard_delete"
  | "export"
  | "self_edit"
  | "session_open"
  | "session_close"
  | "key_create"
  | "key_rotate"
  | "key_revoke"
  | "admin_access"
  | "federation_sync"
  | "erasure_initiated"
  // Terminal entry of POST /admin/erasure (routes/admin-erasure.ts). Core
  // forget's hard mode still closes with "hard_delete" (it also deletes a fact).
  | "erasure_complete"
  // Wired in sdd/p56-federation-cert-pin-mismatch-audit: emitted by
  // gateFederationRequest() (routes/federation.ts) when a peer's
  // presented mTLS cert fails the constant-time pin comparison.
  | "federation_cert_pin_mismatch"
  | "federation_cert_rotated"
  // p50-audit-log-emitters: declared, deliberately NOT emitted by this
  // change — no runtime plugin lifecycle exists yet to emit these from.
  | "plugin_installed"
  | "plugin_removed"
  | "workspace_created"
  // p50-audit-log-emitters: declared, deliberately NOT emitted by this
  // change — no delete-workspace route exists to emit this from.
  | "workspace_deleted"
  // p50-audit-log-emitters: declared, deliberately NOT emitted by this
  // change — this is a migration-time-only concern, not a request-time event.
  | "rls_policy_changed"
  // p50-audit-log-emitters (D10): deferred, not silently dropped. Both live
  // in `ScopedApiKeyAdapter.authenticate()`, an auth hot path with no
  // `deps.storage` handle — wiring these needs its own design (see
  // sdd/p50-audit-log-emitters/tasks Phase 9, task 9.1 — tracked as blocked).
  // Wired in sdd/p52-mfa-ip-denied-audit via authenticateScoped()'s optional
  // storage handle.
  | "mfa_verified"
  | "ip_denied"
  // Migration 0050 (accounts stage A): account, invitation and instance actions.
  | "login_success"
  | "login_failure"
  | "user_created"
  | "user_disabled"
  | "user_enabled"
  | "user_offboarded"
  | "superadmin_granted"
  | "superadmin_revoked"
  | "member_added"
  | "member_removed"
  | "member_role_changed"
  | "invitation_created"
  | "invitation_revoked"
  | "invitation_accepted"
  | "link_created"
  | "password_changed"
  | "password_reset"
  | "settings_changed"
  | "workspace_opened";

/**
 * Who performed the audited operation (SECURITY.md §6 "Audit
 * Trail"). The distinction is load-bearing for the threat model: insider-access
 * detection and federation-sync provenance both rely on being able to tell a
 * human `user`, an autonomous `agent`, an internal `system` job, and an inbound
 * `federation` peer apart.
 */
export type AuditActorType = ActorType;

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  /**
   * Origin of the operation. Threaded from the auth context. When omitted, the
   * storage adapter resolves it via {@link resolveAuditActorType} (back-compat:
   * `user` when an actorId is present, else `system`).
   */
  actorType?: AuditActorType;
  actorId?: string;
  action: AuditAction;
  resourceKind: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?: Record<string, unknown>;
  isTerminal: boolean; // true for GDPR erasure terminal records
  merkleHash?: Uint8Array; // hash chain integrity; NULL until terminal record
  /**
   * The stable entry uuid the Merkle chain commits to (the row's `id` is a
   * BIGINT assigned after hashing). Returned by listAuditLog so the chain can
   * be verified; a writer never sets it (the adapter generates it).
   */
  entryUid?: string;
  createdAt: Date;
}

/**
 * Resolve the `actor_type` to persist for an audit entry.
 *
 * - Prefer the explicit `actorType` threaded from the auth context (the correct
 *   value for `agent` / `federation` / `system` / `user` origins).
 * - Back-compat fallback when callers don't yet pass one: `user` if an actorId
 *   is present (matches the historical hardcoded value), otherwise `system`.
 *
 * Pure (no I/O) so it can be unit-tested and shared by every StorageAdapter
 * implementation without coupling `@mnemo-ai/types` to any infrastructure.
 */
export function resolveAuditActorType(
  entry: Pick<AuditLogEntry, "actorType" | "actorId">
): AuditActorType {
  if (entry.actorType) return entry.actorType;
  return entry.actorId ? "user" : "system";
}
