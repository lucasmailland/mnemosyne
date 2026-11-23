/**
 * English source of the server's error messages: key -> template, `{name}`
 * placeholders. The server never renders from this table: throw sites keep
 * their own English text, and the post-filter (locale.ts) matches that text
 * back to a key. Keys carry no dots (they are looked up as flat keys).
 * Later tasks add route entries; keep them grouped under a comment.
 */
export const en = {
  // errors.ts class defaults
  err_bad_request: "Bad request",
  err_unauthorized: "Unauthorized",
  err_forbidden: "Forbidden",
  err_not_found: "Not found",
  err_conflict: "Conflict",
  err_rate_limited: "Too many requests",
  err_unprocessable: "Unprocessable entity",
  err_unavailable: "Service unavailable",
  err_internal: "Internal server error",
  err_not_implemented: "Not implemented",

  // errors.ts mapDomainError
  err_poisoning: "Content rejected by the poisoning gate",
  err_semantic_unavailable: "Semantic search is temporarily unavailable",
  err_encryption_not_configured:
    "This server has no MNEMO_MASTER_KEY, so it cannot store confidential or restricted memories. Use public or internal, or ask the operator to set the key.",
  err_breaker_open:
    "A dependency is temporarily unavailable. Retry later; the request was not attempted.",
  err_breaker_timeout:
    "A dependency did not answer in time. Retry later; if this was a write, it may or may not have been applied, so retry it idempotently.",
  err_db_unavailable:
    "The database is temporarily unavailable. A write may or may not have been applied; retry it idempotently.",

  // app.ts: zod hook top message and body limit
  req_invalid: "Invalid request",
  req_too_large: "Request body exceeds 1 MB limit",

  // errorCodes.ts MNEMO_00x
  mnemo_001: "Redis connection failed — degrading to in-memory",
  mnemo_002: "PG pool exhausted — shedding low-priority jobs",
  mnemo_003: "Embedding provider timeout — falling back to FTS-only",
  mnemo_004: "Session collapse LLM failed — session preserved for retry",
  mnemo_005: "Federation peer unreachable — sync deferred",
  mnemo_006: "Worth propagation cycle detected — breaking at depth 5",
  mnemo_007: "Consolidation rollback triggered — recall quality degraded",
  mnemo_008: "Merkle chain verification failed — audit integrity alert",
  mnemo_009: "Hot tier Redis full — evicting by LRU activation",
  mnemo_010: "Plugin execution timeout — plugin disabled",

  // auth.ts, middleware/auth.ts
  auth_unavailable: "Authentication service unavailable",
  auth_no_credentials: "No credentials provided",
  auth_missing_bearer: "Missing bearer token",
  auth_malformed_key: "Malformed API key",
  auth_invalid_key: "Invalid API key",

  // middleware/scopeGuard.ts
  scope_insufficient: "API key scope insufficient",
  scope_requires: "API key scope insufficient: requires '{scope}'",
  scope_requires_one_of: "API key scope insufficient: requires one of [{scopes}]",
  scope_empty:
    "API key has empty scope set — full-access bypass is disabled. Mint a scoped key, or set MNEMO_ALLOW_LEGACY_FULL_SCOPE=true to allow legacy empty-scope keys.",

  // middleware/rbac-policy.ts
  rbac_break_glass: "break-glass requires a user-bound mk_admin_ key",
  rbac_no_policy: "No RBAC policy found for this agent (default-deny mode active).",
  rbac_approval_denied: "approval denied",
  rbac_needs_user_key: "this action requires approval, which requires a user-bound key",
  rbac_agent_rate: "Per-agent {metric} rate limit exceeded ({limit}/min)",
  rbac_session_edits: "Per-session self-edit limit exceeded ({limit}/session)",
  rbac_sessions: "Concurrent session limit exceeded ({limit})",

  // ratelimit.ts
  rl_concurrent: "Concurrent request limit exceeded",
  rl_rate: "Request rate limit exceeded",
  rl_shed: "Service shedding load; retry shortly",

  // flat { error, message } bodies: dashboard-auth, bootstrap
  flat_invalid_credentials: "Invalid email or password.",
  flat_too_many_attempts: "Too many attempts. Try again later.",
  flat_invalid_json: "Request body must be valid JSON",
  flat_api_key_required: "apiKey is required",
  flat_db_unreachable: "Could not reach the database",

  // forwarded from storage and core (foreign: texts owned by other packages)
  store_entity_exists: 'An entity named "{name}" of kind {kind} already exists',
  store_entity_not_found: "Entity {id} not found",
  store_entity_closed: "Entity {id} is already closed",
  store_decision_not_found: "Decision {id} not found",
  store_decision_self: "A decision cannot supersede itself",
  store_decision_superseded: "Decision {id} was already superseded by another decision",
  store_hyperedge_not_found: "Hyperedge not found: {id}",
  store_hyperedge_members_missing: "One or more hyperedge members were not found",
  store_hyperedge_distinct: "Hyperedge members must be distinct",
  store_relation_self: "A relation cannot link a node to itself",
  // zod_required / zod_invalid / zod_invalid_option (zod 4 wording): the server builds the zod top-level message as `${path}: ${issue.message}`,
  // so no source literal carries this text (the outer literals are empty/placeholders only). The
  // table entries exist to translate zod's own English; the drift guard treats them as FOREIGN.
  zod_required: "{path}: Invalid input: expected {expected}, received undefined",
  zod_invalid: "{path}: Invalid input",
  zod_invalid_option: "{path}: Invalid option: expected one of {options}",
  // zod 4 size and format checks, one entry per origin the server's schemas use, so the
  // Spanish names the unit instead of passing zod's English type name through.
  zod_too_small_string: "{path}: Too small: expected string to have {bound} characters",
  zod_too_big_string: "{path}: Too big: expected string to have {bound} characters",
  zod_too_small_array: "{path}: Too small: expected array to have {bound} items",
  zod_too_big_array: "{path}: Too big: expected array to have {bound} items",
  zod_too_small_number: "{path}: Too small: expected number to be {bound}",
  zod_too_big_number: "{path}: Too big: expected number to be {bound}",
  zod_invalid_guid: "{path}: Invalid GUID",
  zod_invalid_uuid: "{path}: Invalid UUID",
  zod_invalid_datetime: "{path}: Invalid ISO datetime",
  zod_invalid_date: "{path}: Invalid ISO date",
  zod_invalid_email: "{path}: Invalid email address",
  zod_invalid_url: "{path}: Invalid URL",
  zod_invalid_pattern: "{path}: Invalid string: must match pattern {pattern}",

  // Task 4: administration and account routes (source literals, verbatim)
  // routes/tenants.ts
  tenants_not_authorized: "Not authorized for this tenant",
  tenants_owner_admin_required: "Tenant owner or admin role required",
  tenants_workspace_owner_admin_required: "Workspace owner or admin role required",
  tenants_owner_token_needs_user: "issueOwnerToken needs a key bound to a user",
  tenants_not_found: "Tenant not found",
  tenants_user_email_not_found: "User with that email not found",
  tenants_user_exists_other_tenant:
    "A user with that email already exists and is not a member of this tenant; a key with a user can only invite new emails or members of its own tenant",
  tenants_email_registered: "Email already registered",
  tenants_no_user_for_key: "No user associated with this key",
  tenants_user_not_found: "User not found",
  tenants_owner_not_in_tenant: "owner does not belong to this tenant",
  tenants_workspace_not_found: "Workspace not found",
  tenants_user_not_in_tenant: "user does not belong to this tenant",

  // routes/instance.ts
  instance_unavailable: "Instance administration is unavailable",
  instance_invalid_password: "Invalid password.",
  instance_master_key_missing: "MNEMO_MASTER_KEY is not configured.",

  // routes/bootstrap.ts (the flat messages shared with dashboard-auth are flat_* above)
  bootstrap_invalid_api_key:
    "apiKey must match mns_(live|test)_<20+alphanum> or mk_(live|test|...)_<20+alphanum>",
  bootstrap_invalid_workspace_id: "workspaceId must be a valid UUID",
  bootstrap_admin_together: "adminEmail and adminPassword must be provided together",
  bootstrap_admin_email_invalid: "adminEmail must be a valid email address",
  bootstrap_already: "Mnemosyne already has API keys. Use the admin API to create additional keys.",
  bootstrap_register_failed: "Failed to register API key",
  bootstrap_setup_done: "Setup has already been completed.",
  bootstrap_token_invalid: "Setup token is invalid or has expired.",
  bootstrap_workspace_failed: "Failed to create workspace",

  // routes/dashboard-links.ts
  links_invalid: "This link is invalid or has expired.",
  links_choose_password: "Choose a password.",
  links_sign_in_required: "Sign in to this account to accept the invitation.",

  // routes/my-workspaces.ts, workspace-members.ts, workspace-target.ts
  workspaces_unavailable: "Workspaces are unavailable",
  workspaces_password_session: "Sign in with your email and password.",
  members_unavailable: "Member management is unavailable",
  members_owner_admin_only: "Only workspace owners and admins can do this.",
  members_invitations_off: "Invitations are turned off for this installation.",
  target_needs_user_key:
    "targetWorkspaceId requires a user-bound key (mk_user_* or mk_live_* with user_id)",
  target_not_write_member: "User is not a write member of the target workspace",

  // routes/keys.ts and user-tokens.ts (the three scope messages are shared by both files)
  scopes_unknown: "Unknown scope(s): {scopes}",
  scopes_cannot_grant: "Cannot grant scopes the caller doesn't have: {scopes}",
  scopes_cannot_grant_ceiling:
    "Cannot grant a sensitivity ceiling above the caller's own ({ceiling})",
  keys_federation_shape:
    'A federation key holds exactly ["memory:federation"] and is a workspace, non-test key',
  keys_revoke_not_found: "Key not found or already revoked",
  keys_not_found: "Key not found",
  keys_revoked: "Key is already revoked and cannot be rotated",
  keys_deprecated: "Key has already been rotated and cannot be rotated again",
  keys_expired: "Key is expired and cannot be rotated",
  keys_rotate_scopes_beyond: "Cannot rotate a key holding scopes the caller doesn't have: {scopes}",
  keys_rotate_ceiling_beyond:
    "Cannot rotate a key whose sensitivity ceiling is above the caller's own",
  scoped_keys_admin_needs_user:
    "An mk_admin_ key is bound to the user who issues it: issue it with a user-bound key or a dashboard session",
  scoped_keys_ttl_too_long: "A {prefix} key lives {hours} hours at most",
  scoped_keys_admin_rotate_owner: "Only the user an mk_admin_ key is bound to can rotate it",
  tokens_target_not_member: "Target user is not a member of this tenant",
  tokens_home_workspace_other: "homeWorkspaceId does not belong to this tenant",
  tokens_target_not_in_home:
    "Target user is not a member of homeWorkspaceId — add them via POST /workspaces/:id/members first",
  tokens_not_found: "Token not found, already revoked, or belongs to a different user/tenant",

  // routes/federation.ts
  federation_workspace_not_in_scope: "workspace not in JWT scope",
  federation_cert_required: "newCertDer is required (base64-encoded DER)",
  federation_peer_not_provisioned:
    "Peer '{peerId}' is not provisioned; add it before approving a key rotation",
  federation_peer_not_found: "Peer '{peerId}' not found",
  federation_peer_invalid: "Invalid peer: {detail}",
  federation_peer_exists: "Peer '{peerId}' already exists",
  federation_sync_peer_key: "A peer's federation key cannot start a sync",
  federation_storage_unavailable: "Storage adapter not available",
  federation_peer_id_required: "peerId is required",
  federation_sync_job_not_found: "Sync job '{jobId}' not found",
  federation_items_required: "itemA and itemB are required objects",

  // routes/admin-agent-policies.ts
  agent_policy_unavailable: "Agent policies are unavailable: the policy store is not configured",
  agent_policy_not_found: "No RBAC policy for agent '{agentId}'",
  agent_policy_self: "A key cannot change its own RBAC policy",

  // routes/approvals.ts
  approvals_not_found: "approval not found",
  approvals_status_invalid: "status must be approved|denied",
  approvals_needs_user_key: "approval resolution requires a user-bound key",
  approvals_already: "approval already {status}",
  approvals_self:
    "self-approval is not permitted: the requester of an approval cannot resolve their own request",

  // routes/consolidation.ts
  consolidation_dry_run: "Consolidation dry-run is not supported yet; no changes were made.",
  consolidation_deep: "Manual deep consolidation is not supported yet; no changes were made.",
  consolidation_storage_unwired:
    "Storage adapter is not wired into ServerDeps. Install @mnemo-ai/adapter-postgres and restart the server.",
  consolidation_not_installed:
    "@mnemo-ai/consolidation is not installed. Add it as a dependency and restart the server to enable this endpoint.",

  // Task 5: memory-primitive routes and the rest of src (source literals, verbatim)
  // auth-evaluate.ts, app-scope, dashboard-password.ts
  auth_ip_denied: "IP not in allowlist",
  auth_key_sunset: "API key deprecated and past its sunset; rotate to a new key",
  scope_session_insufficient: "Session scope insufficient",
  password_min_length: "Password must contain at least 12 characters.",
  password_max_bytes: "Password must be at most 72 UTF-8 bytes.",
  password_same_email: "Password must differ from your email.",

  // embed-adapter.ts, idempotency.ts, single-use-link.ts
  embed_not_configured:
    "No embed adapter configured: set MNEMO_LLM_PROVIDER and MNEMO_LLM_API_KEY to enable semantic recall",
  idem_in_progress: "A request with this Idempotency-Key is already in progress",
  idem_reused: "Idempotency-Key reused with a different request",
  links_rate_limited: "Too many links. Try again later.",

  // middleware/rbac-policy.ts, rbac.ts
  rbac_break_glass_unavailable:
    "break-glass approval unavailable: mk_admin_ privileged operations require a two-person grant",
  rbac_break_glass_second_admin:
    "break-glass: a second admin must approve before this privileged operation is permitted",
  rbac_sensitivity_above_ceiling:
    "sensitivity '{requested}' is above this credential's read ceiling ('{ceiling}'); the memory could never be read back, so it was not stored.",
  rbac_sensitivity_above_ceiling_update:
    "sensitivity '{requested}' is above this credential's read ceiling ('{ceiling}'); the event could never be read again, so it was not changed.",
  fact_not_found: "Fact {id} not found",

  // routes/_fact-hard-delete.ts, facts.ts, governance.ts
  hard_delete_scope_required: "memory:hard_delete scope required for hard delete",
  hard_delete_no_storage: "storage adapter not available",
  hard_delete_unsupported: "hard delete is not supported by this storage adapter",
  fact_being_consolidated: "Fact {id} is being consolidated; retry the delete later",
  fact_none_active: "No active fact {id} in this workspace.",
  fact_quoted_not_found: "Fact '{factId}' not found",

  // routes/admin-harness.ts, harness.ts, workspace-mode.ts
  admin_scope_required: "Administrative workspace scope is required",
  managed_storage_unavailable: "Managed lifecycle storage is unavailable",
  harness_too_large: "Harness request body exceeds 1 MiB limit",
  harness_invalid_json: "Harness request body must be valid JSON",
  harness_protocol_version: "Only harness protocol version {version} is supported",
  harness_invalid_probe: "Invalid harness probe envelope",
  harness_invalid_batch: "Invalid harness batch envelope",
  harness_binding_mismatch: "Harness binding does not match the authenticated workspace",
  workspace_mode_unsupported: "Storage adapter does not support workspace mode",

  // routes/break-glass.ts
  bg_request_needs_admin_key: "break-glass requests require an mk_admin_ key",
  bg_reason_required: "reason is required",
  bg_scopes_required: "requestedScopes must be a non-empty array",
  bg_request_not_found: "break-glass request not found",
  bg_approve_needs_admin_key: "break-glass approvals require an mk_admin_ key",

  // routes/composition.ts
  composition_invalid_condition: "Invalid conditionDsl: {detail}",
  composition_invalid_action: "Invalid actionDsl: {detail}",
  composition_not_found: "Composition rule {id} not found",

  // routes/conflicts.ts, relations.ts
  relation_not_found: "Relation {id} not found",
  relation_not_conflict: "Relation {id} is not a conflicts_with relation (got: {verb})",
  relations_verb_locked: 'Verb "{verb}" is not in the locked vocabulary. Allowed verbs: {allowed}.',

  // routes/entities.ts
  entities_no_fields: "No fields to update",
  entities_canonical_self: "canonicalId cannot equal the entity id",
  entities_canonical_missing: "canonicalId target does not exist",
  entities_closed: "Entity {id} is closed",
  entities_link_person_only: "Only kind='person' entities can be linked to a user account",
  entities_link_other_user:
    "Linking a different user requires memory:admin scope and an owner/admin role in this workspace",
  entities_relink_other_user:
    "Reassigning an entity already linked to a different user requires memory:admin scope and an owner/admin role in this workspace",
  entities_user_not_member: "User {userId} is not a member of this workspace",
  entities_not_linked: "Entity {id} is not currently linked to a user",
  entities_unlink_other_user:
    "Unlinking a different user requires memory:admin scope and an owner/admin role in this workspace",

  // routes/episodes.ts, events.ts, reasoning.ts, hyperedges.ts, reminders.ts, review.ts
  episode_not_found: "Episode {id} not found",
  event_not_found: "Event {id} not found",
  event_immutable:
    "Events are immutable and cannot be deleted; forget the facts derived from them instead.",
  reasoning_not_found: "Reasoning {id} not found",
  hyperedge_not_found: "Hyperedge {id} not found",
  reminder_not_found: "Reminder {id} not found",
  review_not_found: "Review row {id} not found",
  review_resolved: "Review row {id} is already resolved",

  // routes/export.ts
  export_needs_user_key: "This action requires approval, which requires a user-bound key",
  export_approval_not_found: "Approval request not found",
  export_approval_other_workspace: "Approval request belongs to a different workspace",
  export_approval_not_approved: "Approval request has not been approved",
  export_approval_expired: "Approval request has expired",
  // re-audit 2026-11-22 (server-sec S1): an export approval is the requester's, for a bulk export
  export_approval_wrong_trigger: "This approval was not granted for a bulk export",
  export_approval_wrong_requester: "This approval was requested by another user; only they can use it",
  insufficient_scope: "Insufficient scope",

  // routes/forget.ts
  forget_hard_facts_only:
    "mode=hard is supported only for facts (DELETE /forget/fact/{idForget}?mode=hard or DELETE /facts/{idFacts}/hard); a {kind} can only be forgotten (soft, without mode). Person-wide GDPR erasure is POST /admin/erasure.",
  forget_not_found: "{kind} {id} not found",

  // routes/admin-erasure.ts
  erasure_subject_required: "Name exactly one of userId or actorId",
  erasure_not_confirmed: "confirm must repeat the userId or actorId being erased",
  erasure_unsupported: "crypto-erasure is not supported by this storage adapter",
  erasure_nothing_to_erase: "No live encryption key to erase for {kind} {id}",

  // routes/import-route.ts
  // APP-007 (audit 2026-11-22)
  approval_not_covering: "this approval does not cover this request: it was already used, has expired, or was granted for another request or user",
  approval_expired_resolve: "approval expired",
  approval_no_longer_pending: "approval is no longer pending",
  // APP-004 / APP-005 (audit 2026-11-22)
  bootstrap_setup_token_required:
    "Registering the first API key needs the setup token printed in the server log at startup. Send it as setupToken in the body or in the X-Setup-Token header.",
  webhook_url_invalid:
    "The webhook URL is not a valid URL.",
  webhook_url_must_be_https:
    "The webhook URL must use https (an operator can allow http with MNEMO_WEBHOOK_ALLOW_HTTP=true).",
  webhook_url_credentials:
    "The webhook URL must not carry a user name or password.",
  webhook_url_private:
    "The webhook URL points at a loopback, private or link-local address (an operator can allow internal receivers with MNEMO_WEBHOOK_ALLOW_PRIVATE=true).",
  import_too_large: "Payload too large",
  import_bad_jsonl: "Could not decompress or parse body as JSONL",
  import_from_array: "--from imports expect a JSON array",
  import_empty: "No non-empty lines found in import body",
  import_bad_header: "First line must be valid JSON",
  import_version: "Unsupported export version",

  // routes/recall.ts, remember.ts
  recall_personal_needs_user_key:
    "scope 'personal' requires a user-bound key (userId must be set on the API key)",
  recall_asof_in_future: "asOf cannot be in the future",
  recall_no_personal_workspace:
    "No personal workspace found for this user. Register a user profile first.",
  remember_invalid_kind: "Invalid kind '{kind}'. Must be one of: {kinds}.",
  remember_subtype_empty: "subtype must not be empty: omit it to use the kind's default.",
  remember_statement_blank: "statement must contain non-whitespace text.",
  remember_valid_from_future: "validFrom cannot be in the future.",
  remember_nul: "{field} must not contain NUL (\\u0000) characters.",
  remember_owner_user: "scopeOwner 'user:<id>' must match the authenticated userId",
  remember_owner_tenant: "scopeOwner 'tenant:<id>' must match the authenticated tenantId",
  remember_owner_workspace: "scopeOwner 'workspace:<id>' must match the target workspaceId",
  remember_owner_prefix: "scopeOwner must start with 'workspace:', 'user:', or 'tenant:'",

  // routes/self.ts
  self_storage_unavailable: "Storage not available",
  self_invalid_body: "Invalid request body — action, target and reason are required.",
  self_content_required: "content is required (non-empty) for action '{action}'.",
  self_target_not_found: "Self-edit target not found",
  self_forget_unsupported:
    "memory_self_edit(action:'forget') is not supported under this workspace's approval policy — no approval flow exists to resolve it. Use memory_forget (kind: 'fact' | 'strategy') instead, which performs the identical bitemporal archive without waiting on an approval that will never arrive.",

  // routes/session.ts
  session_not_found_dot: "Session {id} not found.",
  session_not_found: "Session {id} not found",
  session_managed_turns: "Managed sessions must use harness ingestion for turns.",
  session_closed: "Session {id} is closed for writes.",
  session_managed_collapse: "Managed sessions must use the managed collapse lifecycle.",
  session_turn_not_found: "Turn {turnId} not found in session {id}.",
  session_turn_index_not_found: "Turn index {index} not found in session {id}.",
  session_continuity_incomplete:
    "Continuity requires conversation, client, generation and predecessor for successors",
  session_predecessor_not_found: "Predecessor session not found",
  session_continuity_rejected: "Session continuity rejected",
  session_generation_mismatch: "Session generation mismatch",
  session_message_identity_reused: "Message identity reused",
  // provenance.ts
  traffic_origin_unauthorized: "Traffic origin is not authorized for this credential",

  // routes/skills.ts, strategies.ts, tasks.ts, timeline.ts, webhooks.ts, workflows.ts
  skill_not_found: "Skill {id} not found",
  skills_one_field: "at least one field must be supplied",
  strategy_not_found: "Strategy {id} not found",
  task_not_found: "Task {id} not found",
  tasks_policy_no_create: "Agent policy forbids task creation (taskScopes.canCreate=false)",
  tasks_policy_no_delegate: "Agent policy forbids delegation (taskScopes.canDelegate=false)",
  tasks_delegate_target: "Delegation target not permitted by policy (taskScopes.canDelegateTo)",
  tasks_state_not_delegable: "Task in state '{status}' cannot be delegated",
  timeline_bad_cursor: "cursor is not a valid timeline cursor",
  webhook_not_found: "Webhook {id} not found",
  workflow_not_found: "Workflow {id} not found",

  // r2/server-core (audit 2026-11-22): errors.ts 22P02, routes/recall.ts kinds
  invalid_input_syntax:
    "A value in the request has the wrong format for its field (for example an id that is not a UUID).",
  recall_unknown_kind: "Unknown kind '{kind}' in kinds. Valid kinds: {valid}.",

  // middleware/rbac.ts, middleware/region.ts (HttpError subclasses outside errors.ts)
  rbac_missing_scope: "Missing required scope: {scope}",
  wrong_region:
    "Workspace is locked to region '{workspaceRegion}'. This instance serves '{envRegion}'.",
} as const;

/** Entries whose English text lives outside packages/server/src (P2-7: exempt from the drift guard). */
export const FOREIGN: ReadonlySet<keyof typeof en> = new Set<keyof typeof en>([
  "store_entity_exists",
  "store_entity_not_found",
  "store_entity_closed",
  "store_decision_not_found",
  "store_decision_self",
  "store_decision_superseded",
  "store_hyperedge_not_found",
  "store_hyperedge_members_missing",
  "store_hyperedge_distinct",
  "store_relation_self",
  "zod_required",
  "zod_invalid",
  "zod_invalid_option",
  "zod_too_small_string",
  "zod_too_big_string",
  "zod_too_small_array",
  "zod_too_big_array",
  "zod_too_small_number",
  "zod_too_big_number",
  "zod_invalid_guid",
  "zod_invalid_uuid",
  "zod_invalid_datetime",
  "zod_invalid_date",
  "zod_invalid_email",
  "zod_invalid_url",
  "zod_invalid_pattern",
]);
