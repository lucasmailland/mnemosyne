/**
 * The actions GET /instance/audit accepts (packages/server/src/routes/instance.ts,
 * SECURITY_AUDIT_ACTIONS). The server rejects any other value with 400.
 */
export const SECURITY_AUDIT_ACTIONS = [
  "login_success",
  "login_failure",
  "user_created",
  "user_disabled",
  "user_enabled",
  "user_offboarded",
  "superadmin_granted",
  "superadmin_revoked",
  "member_added",
  "member_removed",
  "member_role_changed",
  "invitation_created",
  "invitation_revoked",
  "invitation_accepted",
  "link_created",
  "password_changed",
  "password_reset",
  "settings_changed",
  "workspace_opened",
  "key_create",
  "key_rotate",
  "key_revoke",
] as const;
