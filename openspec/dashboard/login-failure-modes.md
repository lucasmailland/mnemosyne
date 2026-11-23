# Dashboard password login: failure-mode catalog

Contract basis: task requirements and spec.md §§2.2–2.3. Existing API-key-only
behavior: packages/server/src/routes/dashboard-auth.ts:103–197 and
packages/dashboard/app/login/page.tsx:47–77. All entries are confirmed; thresholds
and password byte limit are implementation choices documented in the spec.

| ID      | Category          | Trigger / risk                                       | Expected contract                                                      | Status    |
| ------- | ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | --------- |
| AUTH-01 | business-contract | Valid password, one member                           | Existing cookie, user identity and membership scopes                   | confirmed |
| AUTH-02 | equivalence       | Wrong/unknown/locked/no membership                   | Same generic 401, one cost-12 compare; no cookie                       | confirmed |
| AUTH-03 | boundary          | Fifth failure and lock expiry                        | Atomic 15-minute lock; valid password denied until expiry              | confirmed |
| AUTH-04 | concurrency       | Concurrent failures or change                        | Row lock prevents lost counters and stale password writes              | confirmed |
| AUTH-05 | authorization     | Multiple workspaces, foreign/removed membership      | Selection cookie grants no data access; recheck membership and version | confirmed |
| AUTH-06 | authorization     | Forged/expired selection or session cookie           | Fail closed without issuing a session                                  | confirmed |
| AUTH-07 | boundary          | IP/email bucket exhausted, Redis unavailable         | Independent 429 + Retry-After; bounded memory fallback                 | confirmed |
| AUTH-08 | business-contract | Current password wrong, weak/same-email/>72-byte new | Deny; never update hash; valid change bcrypt cost 12                   | confirmed |
| AUTH-09 | null-empty        | Null/array/missing/ambiguous login fields            | 400, no server exception or credential query                           | confirmed |
| AUTH-10 | authorization     | Other-user credential query under NOSUPERUSER        | FORCE RLS hides/denies it; lookup function denied to PUBLIC            | confirmed |
| AUTH-11 | business-contract | Login/selection/error UI                             | Labels, generic accessible error and focus, secondary API key path     | confirmed |
| AUTH-12 | authorization     | Password-session provenance                          | user:<id>, never key:<id>; legacy key behavior preserved               | confirmed |

Tests map these IDs in their names. No pending product decisions or known-bug markers.

## Real-server regression contracts (2026-10-22)

Basis: delegated login fix, items 1–4; observed failures in the supplied local
report. All are confirmed by that explicit request; no pending decisions.

| ID      | Category          | Trigger / risk                                                                                              | Expected contract                                                                                                                 | Status    |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------- |
| AUTH-13 | boundary          | Drizzle replaces timestamp serializers/parsers (`dashboard-password.ts:167–190`)                            | ISO write, normalized date read; fifth failure and locked attempts return generic 401, expiry permits success and resets counters | confirmed |
| AUTH-14 | authorization     | Home fetches admin stats for a reader (`app/(dashboard)/page.tsx:97`)                                       | Skip forbidden request, explain admin-only stats, retain activity                                                                 | confirmed |
| AUTH-15 | business-contract | Mixed labels, anonymous workspace choice, fixed sidebar (`login/page.tsx:231`, `components/sidebar.tsx:81`) | English labels, account + role per workspace, workspace name, collapsible mobile menu                                             | confirmed |
| AUTH-16 | boundary          | Native minlength prevents submit and leaves stale error (`account/password-form.tsx:94`)                    | Clear old feedback on edit/invalid; show current policy error                                                                     | confirmed |
| AUTH-17 | business-contract | Provisioning --create --workspace calls personal-space helper (`scripts/dashboard-password.mjs:76`)         | Only specified workspace membership; default --create still creates Personal                                                      | confirmed |

## Independent review fixes (2026-11-02)

Basis: independent security review of the WIP commit c61a4f7a. All confirmed.

| ID      | Category    | Trigger / risk                                                                                      | Expected contract                                                                                                     | Status    |
| ------- | ----------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| AUTH-18 | equivalence | Parallel logins for one email queue on the row lock held across bcrypt (only if the account exists) | bcrypt and hashing run with no transaction open; lock held only to record; same two transactions for missing accounts | confirmed |
| AUTH-19 | concurrency | Password replaced between the credential read and the recorded result                               | Deny without counting a failure or resetting the counter                                                              | confirmed |
| AUTH-20 | boundary    | Storage failure returns 503 with no cause for operators                                             | Log SQLSTATE / error class as `errorCode`; never the error message                                                    | confirmed |

## Accounts stage A: lifecycle, revocation and links (2026-11-03)

Basis: docs/archive/superpowers/specs/2026-11-03-accounts-and-team-design.md sections 3-5. All confirmed.

| ID      | Category          | Trigger / risk                                                                                      | Expected contract                                                                                                                          | Status    |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| AUTH-21 | authorization     | User disabled while signed in or holding keys                                                       | Next request refused; login refused with the generic 401; user-bound keys/tokens refused on HTTP, gRPC, WebSocket upgrade and /health/deep | confirmed |
| AUTH-22 | authorization     | Token older than `sessions_valid_after` (password change or reset, offboard, superadmin revocation) | Session rejected on the next request; the caller's own session is re-minted after a password change                                        | confirmed |
| AUTH-23 | authorization     | Member removed or demoted, superadmin revoked                                                       | Role and superadmin read live per request (15 s cache, busted on write); never from the JWT                                                | confirmed |
| AUTH-24 | authorization     | Unknown, used, expired, revoked or regenerated link; issuer removed or disabled                     | Same 404 `link_invalid`; nothing consumed; only the SHA-256 reaches the database                                                           | confirmed |
| AUTH-25 | authorization     | Link for an existing account without a live session of that account                                 | 401 `session_required`; no membership added; no cookie                                                                                     | confirmed |
| AUTH-26 | boundary          | Public link endpoints and sign-in from one IP                                                       | One per-IP bucket (`MNEMO_DASHBOARD_LOGIN_IP_BURST`, default 30 / 15 min); 429 + Retry-After                                               | confirmed |
| AUTH-27 | authorization     | Non-superadmin or API key calls `/instance/*`                                                       | Plain 404 of an unknown route; the database functions re-check the actor                                                                   | confirmed |
| AUTH-28 | business-contract | Last superadmin or last enabled owner revoked, disabled, offboarded                                 | Refused (409 `last_superadmin`, `last_owner`, `owner_required`) under a database lock                                                      | confirmed |
