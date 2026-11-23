# Security Policy

**English** · [Español](SECURITY.es.md)

Mnemosyne stores memories on behalf of many tenants in a single Postgres
database. Isolation is the product. We take security reports seriously and
appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Use **GitHub Private Vulnerability Reporting** on this repository
  (Security → _Report a vulnerability_), with steps to reproduce, affected
  package(s)/version, and impact. The form is available while the repository
  is public and the feature is enabled in its settings.
- A dedicated security address will be listed here when the project has one;
  until then, the GitHub form above is the only channel. Do not open a public issue.

We aim to acknowledge within **72 hours** and to ship a fix or mitigation for
confirmed high-severity issues within **30 days**. We will credit reporters who
ask to be credited once a fix is released.

## Supported versions

Mnemosyne is in the `3.6.x` line (the packages on npm are `@mnemo-ai/cli`,
`@mnemo-ai/mcp`, `@mnemo-ai/client-ts` and `@mnemo-ai/types`). Only the latest
published version of each receives security fixes.

| Version   | Supported          |
| --------- | ------------------ |
| `3.6.x`   | :white_check_mark: |
| `< 3.6.0` | :x:                |

## Layered defenses shipping today

Mnemosyne is defense-in-depth by design. Tenant isolation never rests on a
single check.

- **Per-workspace RLS with `FORCE`.** Workspace-scoped `mnemo_*` tables enable
  Row-Level Security with `FORCE`, so policies apply even to the table owner.
  The policies of the `mnemosyne` schema read the `mnemosyne.workspace_id` GUC
  (the older `public`-schema policies read `app.workspace_id`; `withMnemoTx`
  sets both) — no workspace context, no rows.

  Known exceptions, as of the 2026-11-22 audit (APP-059):
  - `mnemo_api_keys` has no RLS **by design**: the key lookup is what
    establishes the workspace, so it cannot run inside one
    (`packages/core/src/api-key-lookup.ts`).
  - No RLS: `mnemo_scoped_api_keys`, `mnemo_scoped_key_escrow`,
    `mnemo_scoped_key_usage`, `mnemo_outbox`, `mnemo_deletion_log`,
    `mnemo_hot_tier_snapshot`, `mnemo_consolidation_lock` and
    `mnemo_composition_rule_template`, nor the monthly partitions of
    `mnemo_audit_log` (the parent table has its policy).
  - `mnemo_recall_log` enables RLS without `FORCE`.

  These tables are reached through server code that scopes its own queries;
  closing the gap is tracked work.

- **Fail-closed tenant GUC.** Workspace-scoped access runs inside `withMnemoTx`
  (`packages/core/src/tx.ts`), which sets the workspace GUCs with
  `set_config(..., true)`, i.e. transaction-local. A missing or stale context
  yields **zero rows**, never another tenant's data. Because the setting is
  local, it reverts on `COMMIT`/`ROLLBACK` and cannot leak into the next
  reservation of a pooled connection.

- **Role downgrade against `BYPASSRLS`.** When the connection role is a member
  of `app_user`, `withMnemoTx` issues `SET LOCAL ROLE app_user` (a `NOINHERIT`,
  non-`BYPASSRLS` role) before any query, so the transaction is subject to
  RLS+FORCE for its duration even on a superuser connection. Production
  deployments should additionally connect directly as `app_user`.

- **Optional per-actor isolation.** A workspace can further restrict visibility
  to a single end-user via the `app.actor_id` / `app.enforce_actor_isolation`
  GUCs and the matching `SELECT` policy on `mnemo_fact`.

- **Hashed API keys.** API keys are stored as a bcrypt hash, plus an
  HMAC-SHA256 lookup hash keyed with `MNEMO_KEY_PEPPER` for the O(1) lookup;
  the plaintext key is shown once at creation and never persisted.

- **PII detection and redaction.** A conservative regex layer
  (`@mnemo-ai/core/pii`) detects emails, phone numbers, credit cards, SSNs,
  API keys/bearer tokens, IP addresses, and tokenized URLs, scores them by
  severity, and can redact every match to `[REDACTED-<category>]` before a
  fact is persisted.

- **Integration-tested isolation.** Cross-tenant isolation is asserted by the
  integration tests against a live pgvector container: workspace B sees **0**
  of workspace A's facts, and cross-tenant writes are rejected. GitHub Actions
  is off for this repository, so nothing runs them on every push: they run in
  the full local sweep (`FULL=1 bash scripts/full-sweep.sh`, required before a
  release, needs Docker). The pre-push hook runs the fast lane, which skips
  them.

- **Setup token for the first API key.** `POST /bootstrap` registers the first
  key only with the setup token the server prints in its log at startup
  (single use, 15 minutes), or the fixed `MNEMO_SETUP_TOKEN` (16+ characters).
  The token is not served over the network. Once a key exists, bootstrap is
  closed.

- **Webhook egress rule.** A webhook URL must be https and must not be, or
  resolve to, a loopback, private, link-local, carrier-NAT, multicast or
  unspecified address. It is checked when the endpoint is registered or
  changed and before every delivery; redirects are not followed and the test
  route does not return the receiver's body. Registering, changing, testing or
  removing an endpoint needs `memory:admin`. `MNEMO_WEBHOOK_ALLOW_HTTP` and
  `MNEMO_WEBHOOK_ALLOW_PRIVATE` relax the rule for internal receivers.

- **Sensitivity ceiling on events and webhooks.** A WebSocket subscription
  keeps its key's sensitivity ceiling: events above it are dropped and recall
  hits above it removed. Webhook payloads above `internal` go out as id and
  metadata only (`redacted: true`), and the signing secret is not copied into
  the outbox.

- **Single-use approvals.** An approved request lets through one request only:
  the same trigger, user, method and path, once, within one hour of being
  approved. A request waits up to 24 hours for the decision. The two windows
  are `APPROVAL_PENDING_TTL_MS` and `APPROVAL_USE_TTL_MS` in `@mnemo-ai/types`.
  The request is matched with its query string (an approval for a soft forget
  does not cover `?mode=hard`), and an export approval (`approvalRequestId`)
  covers one export, by the user who asked, with the same method and path.
  The policy's own deny is evaluated first and an approval never
  overrides it.

## Hardening checklist for operators

- Connect the application as `app_user` (non-`BYPASSRLS`), not as a superuser.
- Keep `DATABASE_URL` and provider API keys in a secret manager, never in VCS.
- Terminate TLS in front of `@mnemo-ai/server` and require API keys on every
  route.
- Treat memory content as user data: enable PII redaction for untrusted input.

Thank you for helping keep Mnemosyne and its users safe.
