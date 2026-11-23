# Mnemosyne — Security Architecture

How the server authenticates, authorizes, isolates, audits and encrypts, taken from the
code. Each statement names the file it comes from. There is no `@mnemo-ai/auth` package:
authentication lives in `packages/server` (`auth.ts`, `auth-evaluate.ts`, `auth/`), the
shared types in `packages/types/src/security.ts`, and the pure checks in `packages/core`.
Vulnerability reporting is in the repository's [SECURITY.md](../../SECURITY.md).

---

## 1. Threats and where they are handled

| Threat                                 | Handled by                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| Unauthenticated or out-of-scope access | API keys and scope checks on HTTP and gRPC (sections 2 and 3)                 |
| Cross-tenant leakage                   | Row-level security with transaction-local settings (section 4)                |
| Agent overreach inside a workspace     | Per-agent access policies and break-glass approval (section 5)                |
| Tampering with the audit trail         | Append-only grants, an immutable trigger and a hash chain (section 6)         |
| Theft of stored personal data          | Column encryption under per-actor keys, crypto-erasure (sections 7 and 8)     |
| Abuse and overload                     | Rate limits and concurrency slots (section 9)                                 |
| Memory poisoning and prompt injection  | Write-time scans, recall-time scoring, untrusted wrapping in MCP (section 10) |
| A hostile or impersonated peer         | The federation peer gate (section 11)                                         |

---

## 2. Authentication

### 2.1 API keys

The always-on scheme (`packages/server/src/auth.ts`). A request carries
`Authorization: Bearer <key>`; a token that does not match

```
^(mns_(live|test)|mk_(live|test|sess|fed|admin)|uk_(live|test))_[a-z0-9]{20,64}$
```

(case-insensitive) answers 401 `Malformed API key`.

- `POST /admin/keys` mints keys (`packages/server/src/routes/keys.ts`): `mk_live_` or
  `mk_test_` workspace keys, `uk_live_` or `uk_test_` user tokens, and `mk_fed_` federation
  keys (`"federation": true`, scopes exactly `["memory:federation"]`). The secret is the
  prefix, an underscore and 32 hex characters (16 random bytes). The bootstrap
  (`routes/bootstrap.ts`) mints `mns_live_` keys.
- Keys live in `mnemo_api_keys`: a bcrypt hash (cost 12) and a lookup hash,
  HMAC-SHA256 of the key with `MNEMO_KEY_PEPPER`. The full key is shown once, at creation.
- `POST /admin/keys/:keyId/rotate` issues a replacement; the old key stays valid for 7 days
  and responses to it carry `Deprecation` and `Sunset` headers (`auth-evaluate.ts`).
- After the lookup, `evaluateResolvedKey()` (`auth-evaluate.ts`) applies the key's IP
  allowlist, the deprecation sunset, workspace switching (`X-Workspace-Id`, user tokens
  only) and role→scope narrowing (section 4.3). HTTP and gRPC share it.

### 2.2 Scoped keys (`MNEMO_SCOPED_AUTH=1`)

A second scheme, off by default (`packages/server/src/index.ts`). With
`MNEMO_SCOPED_AUTH=1`, a token that starts with `mk_` and does not match the pattern of
section 2.1 (`isScopedSchemeToken()` in `auth.ts`) is verified by `ScopedApiKeyAdapter`
(`packages/server/src/auth/ScopedApiKeyAdapter.ts`) against `mnemo_scoped_api_keys`. The
`mk_live_`, `mk_test_` and `mk_fed_` keys `POST /admin/keys` mints match that pattern and
stay on the scheme above, in either mode. The two formats cannot overlap: a scoped key's
body always holds a second underscore, which the pattern forbids. Each key is verified
against the table it lives in, with no fallback to the other. The adapter implements the
`AuthAdapter` port of `@mnemo-ai/types`. Dashboard sign-in with an API key dispatches the
same way.

- `POST /admin/scoped-keys` issues them (`routes/admin-scoped-keys.ts`, scope `admin:keys`):
  `mk_live_` (90 days at most), `mk_sess_` (24 hours at most) or `mk_admin_` (24 hours at
  most), the type's maximum unless `expiresIn` asks for less. The limits are those of
  `POST /admin/keys`: no scope and no sensitivity ceiling the caller does not hold, and a
  dashboard password session never passes on `admin:workspace`. The key is bound to the
  caller's user (`user_id`, migration 0069), shown once and audited (`key_create`). Issuing
  works with the flag off, so keys can exist before verification is turned on.
  `POST /admin/scoped-keys/:id/rotate` issues a replacement that keeps the old grant (TOTP
  secret, user, ceiling, test flag and lifetime) and leaves the old key its 7 days;
  `DELETE /admin/scoped-keys/:id` revokes at once, since the adapter reads the row on every
  request. `:id` is `{prefix}{keyId}`, and a key of another workspace answers 404. The CLI
  has `mnemo keys scoped create|rotate|revoke`; `@mnemo-ai/client-ts` has `issueScopedKey`,
  `rotateScopedKey` and `revokeScopedKey`.
- Format `{prefix}{keyId}_{secret}`: a 12-character base62 `keyId` and a 43-character
  base62 secret (`auth/rotation.ts`).
- Secrets are hashed with argon2id; older bcrypt hashes still verify (`auth/hash.ts`).
- Default lifetimes (`KEY_TYPE_TTL_MS`): `mk_live_` 90 days, `mk_test_` 30 days, `mk_fed_`
  365 days, `mk_admin_` 24 hours. A key past its expiry or `revoked` is refused; a
  `deprecated` key keeps working for 7 days.
- `mk_admin_` (break-glass) keys need a TOTP code in `x-mnemo-mfa` and never live more than
  24 hours. Privileged operations with them also need a two-person grant (section 5).
  Only a caller with a user can issue one: the key gets a fresh 160-bit TOTP secret,
  returned once (base32 and an `otpauth://` URI), and carries that user, on whom the
  two-person gate keys. Only that user may rotate it.
- A key bound to a user is narrowed by that user's role in the workspace (section 4.3),
  like the user-bound keys of section 2.1, and stops while the user is disabled.
- The tables have no RLS, like `mnemo_api_keys`: the lookup is what establishes the
  workspace. The application role reads them through the grants of migration 0069
  (`SELECT, INSERT, UPDATE` on the keys, `SELECT, INSERT` on the usage trail, `INSERT` on
  the escrow); nothing deletes a key row.
- `MNEMO_SCOPED_AUTH_ANOMALY=1` turns on usage-history anomaly detection, which revokes a
  key on a new IP or an impossible geo-velocity.
- gRPC refuses scoped-scheme keys (`Unauthenticated`); the `mk_*` keys `/admin/keys` mints
  work there like any other key.

### 2.3 Other credentials

- WebSocket (`GET /memory/ws`): the key goes in `?token=`; a missing or invalid one closes
  the socket with code 1008 (`packages/server/src/ws.ts`).
- Federation peers: an `mk_fed_` key plus the peer gate, see section 11.

---

## 3. Scopes

`KeyScope` (`packages/types/src/security.ts`) has 29 values:

| Family         | Scopes                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory:*`     | `read`, `write`, `delete`, `admin`, `hard_delete`, `session`, `task`, `event`, `self_edit`, `procedural`, `reasoning`, `export`, `governance`, `subscribe`, `federation` |
| `session:*`    | `read`, `write`, `manage`                                                                                                                                                |
| `entity:*`     | `read`, `write`, `admin`                                                                                                                                                 |
| `federation:*` | `read`, `write`, `manage`, `admin`                                                                                                                                       |
| `admin:*`      | `keys`, `workspace`, `billing`, `tenant`                                                                                                                                 |

`SPEC_SCOPES` is the 15-scope subset a workspace-scoped dashboard or MCP flow can mint for
itself; `federation:admin` and `admin:workspace` stay outside it.

**Enforcement is the same on HTTP and gRPC.** Both transports decide with `decideScopeAccess` (`packages/server/src/middleware/scopeGuard.ts`):

- a key with no scopes is denied on every route and every RPC, unless `MNEMO_ALLOW_LEGACY_FULL_SCOPE=true`, which both read through `legacyFullScopeAllowed()`;
- otherwise the key must hold the scope the route or RPC requires.

HTTP takes the required scope from `app-scope.ts`, gRPC from `RPC_SCOPE` in `grpc.ts`. The 7 streaming RPCs require the scope of their HTTP equivalent:

| RPC                                         | Scope               |
| ------------------------------------------- | ------------------- |
| `WatchMemory`, `WatchTasks`, `StreamHealth` | `memory:subscribe`  |
| `IngestBatch`, `ImportMemory`, `Session`    | `memory:write`      |
| `FederationSync`                            | `memory:federation` |

`FederationSync` then answers `Unimplemented` to every caller (section 11).

Four unary mappings are still broader than HTTP's: `CreateTask` and `UpdateTask` take `memory:write` where HTTP takes `memory:task`, `RecordEvent` takes `memory:write` (HTTP `memory:event`), and `RecordReasoning`/`ResolveReasoning` take `memory:write`/`memory:read` (HTTP `memory:reasoning`). Aligning them would break keys scoped to the gRPC contract as documented, so it is a separate change.

---

## 4. Multi-Tenant Isolation

Request path: the auth middleware resolves the key and its workspace, the scope guard checks
the route's scope, the handler passes the `workspaceId` explicitly, and every storage call
runs inside `withMnemoTx` (`packages/core/src/tx.ts`), which sets the workspace for that
transaction only:

```sql
SELECT set_config('app.workspace_id', $1, true);       -- older policies (current_workspace_id())
SELECT set_config('mnemosyne.workspace_id', $1, true); -- mnemosyne schema policies
```

`withMnemoTx` can also set `app.actor_id` / `app.enforce_actor_isolation` and
`mnemosyne.actor_user_id` / `app.enforce_user_isolation` for per-actor and per-user rows.
Because the settings are transaction-local, they never leak to the next transaction on a
pooled connection.

### 4.1 RLS Policy (PostgreSQL)

Tenant tables have `ENABLE` and `FORCE ROW LEVEL SECURITY`, so the policies apply to the
table owner too, with policies of this shape (from the baseline migration):

```sql
CREATE POLICY mnemo_access_policy_ws ON mnemosyne.mnemo_access_policy
  USING ((workspace_id)::uuid = (current_setting('mnemosyne.workspace_id', true))::uuid);
```

RLS holds only for a role without `SUPERUSER` or `BYPASSRLS`. At boot, `assertSafeDbRole`
(`packages/core/src/api-key-lookup.ts`) refuses to start with such a role unless
`MNEMO_ALLOW_UNSAFE_DB_ROLE=true`, which the server refuses when `NODE_ENV=production`
(`packages/server/src/boot/unsafe-switches.ts`).

### 4.2 Cache Isolation

Redis keys carry the workspace: the hot tier uses `mnemo:<workspaceId>:hot:...`
(`packages/core/src/cognitive/hot-cache.ts`), and forgetting a fact busts
`mnemo:<workspaceId>:hot:*`. `RedisAclProvisioner` in `@mnemo-ai/adapter-redis` can create a
Redis user per workspace prefix, but the server does not call it.

### 4.3 Tenant vs. Workspace Authority Planes

Two genuinely independent authority planes sit above the RLS isolation described in §4.1 — do not conflate them. Full model, role tables, and onboarding recipe: [MULTI_TENANCY.md](./MULTI_TENANCY.md).

- **Tenant plane** — `mnemo_tenant_member.role` (`owner | admin | member`), gates `admin:tenant`-scoped operations (create workspaces, invite tenant members, mint `uk_live_*` user tokens for OTHER tenant members). Checked by `requireTenantAdmin()`.
- **Workspace plane** — `mnemo_workspace_member.role` (`owner | admin | write | read`), gates memory operations (facts, recall, remember, hard-delete) via **role→scope narrowing** at auth time: `packages/server/src/auth.ts` resolves the caller's role for the effective workspace and filters the key's own scopes down to `WORKSPACE_ROLE_SCOPES[role]` — this can only ever narrow a token's scopes, never widen them, so it introduces no new escalation path. Enforced through the same single central scope guard (`app.ts` → `app-scope.ts`) every route already goes through, meaning this security property holds for every route with zero per-route code.

**There is no cross-tenant principal (AUTH-TENANT-NULL).** Every tenant-plane guard compares the target tenant with the caller's tenant, resolved server-side, and a caller whose tenant cannot be resolved is denied. The caller's tenant is the key row's `tenant_id`. A key without one (the bootstrap and setup keys, the keys minted from them, every `mk_*` key) acts in the tenant of its own home workspace: the workspace on its own `mnemo_api_keys` row, or for `mk_*` the workspace it authenticates to, never the one `X-Workspace-Id` selected. A workspace of another tenant answers with the same 404 and body as a missing one (S6). Until #227 (2026-10-16) the guards read "no tenant" as "unbound, allow", so such a key could manage any tenant's members and mint user tokens for any tenant's users. Proven on real Postgres under `mnemo_app` by `tenant-null-bypass.integration.test.ts`.

For a key with neither a tenant nor a user, `withTenantRls` also sets the derived tenant as `mnemosyne.actor_tenant_id`, found through the `SECURITY DEFINER` function `mnemo_workspace_tenant_id` rather than through RLS (migration `0047`), so RLS confines these keys to their home tenant as a second barrier behind the guards, and `mnemo_workspace_member` admits a caller with no user only in that tenant's workspaces. A user-bound key with no tenant still runs with no tenant GUC, and the empty-GUC fallbacks of `mnemo_tenant`, `mnemo_tenant_member`, `mnemo_user` and `mnemo_workspace` remain for the bootstrap, the setup wizard and the personal-workspace lookup; what removing them takes is in [MULTI_TENANCY.md](./MULTI_TENANCY.md) §5 (`AUTH-TENANT-RLS-FALLBACK`).

Security invariant: a workspace admin does NOT thereby gain tenant-admin authority (they cannot invite tenant members or mint tokens for other users), and a tenant admin does not automatically gain elevated workspace-plane scopes beyond what their own key/token was issued with. `POST /tenants/:tenantId/users/:userId/tokens` (minting a token for a different user) is deliberately its own route rather than a `POST /admin/keys` extension, specifically because `admin:keys` IS reachable at workspace-admin role post-narrowing — folding token minting into that route would let a workspace admin impersonate any tenant member.

### 4.4 Transport Parity (HTTP and gRPC)

The gRPC/ConnectRPC transport shares the public HTTP port (and, with `MNEMO_GRPC_PORT`, also listens alone on an h2c port with the same handler and interceptors) but not the Hono middleware chain, so it applies the same controls itself (AUTH-GRPC-PARITY):

- **Message size before auth:** Connect reads a unary body before any interceptor runs, so each message is capped at 1 MiB (`readMaxBytes`), the limit HTTP puts on `/v1` bodies. Past it the call fails with `ResourceExhausted` without a key lookup.
- **Post-resolve decisions:** after the key lookup, both transports run `evaluateResolvedKey()` (`packages/server/src/auth-evaluate.ts`): IP allowlist, deprecation sunset (with `Deprecation`/`Sunset` headers during the 7-day grace), and role→scope narrowing in the key's own workspace. The narrowed scopes are the ones every later check sees, including the SelfEdit `memory:admin` override.
- **Scopes:** see §3.
- **Workspace switching** is HTTP-only. gRPC refuses `x-workspace-id` metadata that names a workspace other than the key's own (`InvalidArgument`) rather than ignoring it.
- **Not at parity yet:** scoped-scheme keys (section 2.2) are refused over gRPC (`Unauthenticated`); the request-rate limiter and idempotency are HTTP-only; checks run when a call opens, so a long-lived stream is not re-checked after a demotion or sunset.

---

## 5. Agent Access Policies

A workspace can give each agent its own policy, `AgentMemoryAccess`
(`packages/types/src/security.ts`): read and write scopes (from `SPEC_SCOPES`), a self-edit
policy, task creation and delegation rights, per-agent limits (recalls and writes per
minute, concurrent sessions, self-edits per session), the operations that need approval
(`ApprovalTrigger`: `delete_fact`, `overwrite_decision`, `write_entity`, `cross_agent_read`,
`bulk_export`, `federation_share`, `procedural_evolution`, `task_delegation`) and
`federationAccess` (`none`, `read`, `read_write`).

Policies are managed under `/admin/agent-policies` and `/admin/agent-policy`
(`routes/admin-agent-policies.ts`) and enforced by `middleware/rbac-policy.ts` through
`evaluateAccess` (`@mnemo-ai/core`). The same middleware applies break-glass dual control: a
privileged `mk_admin_` operation (any scope but `memory:read`) needs an approved, unexpired,
unused grant in `mnemo_break_glass_request` filed by that admin and approved by a different
one; without a break-glass store it is refused.

Each replica caches an agent's policy for 60 s. A write or delete drops the entry on the
replica that took it and, through Redis pub/sub (`mnemo:rbac:policy-invalidate`), on the
others at once. Redis is not required for that: a trigger on `mnemo_access_policy` records
every write in `mnemo_access_policy_change` in the same transaction (migration 0067), and
every replica polls it each second through a `SECURITY DEFINER` function that returns only
workspace and agent ids (`pollPolicyChanges`). The poll runs with Redis too, since pub/sub
drops messages for a replica that is reconnecting. If the poll fails, the 60 s TTL is the
bound.

---

## 6. Audit Trail

### 6.1 Schema

`mnemo_audit_log` (baseline migration), partitioned by month on `created_at`:

| Column                      | Notes                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `id`                        | `bigint`                                                                |
| `workspace_id`              | `uuid`                                                                  |
| `actor_type`                | `agent`, `user`, `system` or `federation`                               |
| `actor_id`                  | Namespaced actor reference                                              |
| `action`                    | Checked against the list below                                          |
| `resource`, `resource_id`   |                                                                         |
| `metadata`                  | `jsonb`                                                                 |
| `ip_address`, `user_agent`  |                                                                         |
| `trace_id`                  |                                                                         |
| `created_at`                |                                                                         |
| `merkle_hash`               | `bytea`; NULL only on a terminal entry (`audit_merkle_integrity` check) |
| `is_terminal`               |                                                                         |
| `actor_dek_id`, `entry_uid` |                                                                         |

Allowed actions: `recall`, `create`, `update`, `delete`, `hard_delete`, `export`,
`self_edit`, `session_open`, `session_close`, `key_create`, `key_rotate`, `key_revoke`,
`admin_access`, `federation_sync`, `erasure_initiated`, `erasure_complete`,
`federation_cert_pin_mismatch`, `federation_cert_rotated`, `plugin_installed`,
`plugin_removed`, `workspace_created`, `workspace_deleted`, `rls_policy_changed`,
`mfa_verified`, `ip_denied`.

Append-only in two layers: the `enforce_audit_immutable` trigger raises on any `UPDATE` or
`DELETE`, and migration 0046 revokes `UPDATE`, `DELETE` and `TRUNCATE` from `mnemo_app_role`
on the table and every partition (`mnemo_deletion_log` gets the same). The weekly cron
`mnemo.audit.partition` (Sundays 01:00 UTC) creates the next partition and, only with
`MNEMO_AUDIT_DROP_ENABLED=true`, drops partitions older than 84 months
(`packages/server/src/cron/auditPartition.ts`).

### 6.2 Merkle Chain

Each workspace's entries form a hash chain (`packages/adapter-postgres/src/merkle.ts`):

```
merkle_hash = SHA-256(prevHashHex + "\n" + canonicalJson({ entryId, action, resourceKind, resourceId, occurredAt }))
```

The first entry of a workspace uses an empty previous hash. `metadata` and `user_agent` are
left out of the hash so crypto-erasing them does not break verification; terminal entries
(`merkle_hash` NULL) are skipped. Two cron jobs use the chain
(`packages/server/src/cron/jobs.ts`):

- `mnemo.audit.merkle.publish`, hourly: computes a Merkle root over each workspace's last
  1 000 entries and writes it as the log line `audit.merkle.root`. It is published nowhere
  else.
- `mnemo.audit.merkle`, weekly (Tuesdays 02:30 UTC): verifies each workspace's chain; a
  broken chain logs an error with `MNEMO_008` and fires the alert hook.

---

## 7. Encryption

**Transport.** The server listens with `node:http` and does not terminate TLS; put a
TLS-terminating proxy in front of it. Federation is the one path that checks the TLS
version, see section 11.

**Column encryption.** `MNEMO_MASTER_KEY` (64 hex characters, 32 bytes) feeds the key ring
in `packages/server/src/encryption/KeyRingAdapter.ts`:

```
MNEMO_MASTER_KEY
  │  HKDF-SHA256(salt = "mnemo-kek-v<N>", info = workspaceId)     N = MNEMO_KEK_VERSION
  ▼
workspace KEK
  │  AES-256-GCM wrap, AAD = "<workspaceId>|<actorId>"
  ▼
per-actor DEK (32 random bytes), stored wrapped in mnemo_actor_dek
```

A fact whose sensitivity is `confidential` or `restricted` has its PII columns encrypted
with AES-256-GCM under the writing actor's DEK, and the write fails rather than storing
plaintext (`packages/adapter-postgres/src/repositories/FactRepository.ts`). The master key
is required when `NODE_ENV=production` or `MNEMO_REQUIRE_ENCRYPTION=true`: without a valid
one the server refuses to start (`encryption/assertEncryption.ts`). In development, without
it, encryption is off. The same key ring seals federation peer secrets, webhook signing
secrets and stored LLM provider keys.

**Reading encrypted facts.** Every fact the Postgres adapter returns (`getFact`, the
listings, the recall hydration and candidate arms, export, and through them MCP and the
dashboard) goes through `openFacts`
(`packages/adapter-postgres/src/encryption/fact-decryptor.ts`, called from
`DrizzleStorageAdapter`): the ciphertext is opened with the DEK of the row's `actor_id`,
looked up once per call for all the actors in it and never cached across calls, so an
erasure takes effect on the next read. The sensitivity ceiling (section 4) still decides
who gets the row; decryption only decides what text it carries. A row that cannot be
opened never comes back as ciphertext and never fails the read: its `statement` and
`subject` read `[erased]` with `redacted: "erased"` when the actor's DEK was destroyed,
or `[unreadable]` with `redacted: "unreadable"` when no key ring is configured (no
`MNEMO_MASTER_KEY`), the DEK row is missing, or the key does not open the ciphertext (a
warning is logged). Recall leaves such rows out; `GET /facts/{id}` and the listings show
them flagged, and an import skips a line that carries `redacted`. Exports apply the
caller's ceiling to facts, since they now carry plaintext, and so does the write-time
conflict screen of `POST /remember` (`findContradictingFacts`): an existing fact above
the writer's ceiling (as recall computes it, `effectiveCeiling`) or outside the write's
own scope, `scope_ref` and owner is never a candidate, so its text never reaches the
conflict answer or a paraphrase reuse.

**Confidential text to providers: `MNEMO_SENSITIVE_TEXT_TO_PROVIDERS`.** One setting
decides which external providers may receive the plaintext of confidential and restricted
text (`packages/server/src/boot/sensitive-egress.ts`; the checks are `sensitiveTextMayReach*`
in `packages/types/src/security.ts`). A missing or unknown tier counts as sensitive, and
any value other than the three below refuses to start.

| Value             | Embedder | Completion provider |
| ----------------- | -------- | ------------------- |
| `none`            | no       | no                  |
| `embed` (default) | yes      | no                  |
| `all`             | yes      | yes                 |

Where it applies:

- **Embedding a write** (`remember()`, every kind: decisions, entities and the rest carry a
  tier too): under `none` a confidential+ write is stored without a vector and queues no
  text job. It is found only by exact repeat, never by meaning.
- **Embedding later**: nothing re-embeds such a row afterwards. The outbox worker re-reads
  the row's tier (`getEmbeddingSourceSensitivity`) before it embeds a text-form job, so a
  job a repository or a backfill script queued is skipped (processed, never embedded), and
  a tier it cannot read counts as sensitive. The re-embed sweep (`mnemo.embed.migration`
  and `POST /admin/embedding-migrations`) lists only `public`/`internal` rows
  (`listStaleEmbeddings` with `plaintextOnly`); the admin run embeds with the completion
  provider's credentials, whose locality is not tracked, so it applies this under `none`
  even with a local embedder.
- **Recall**: the near-duplicate pass and the rerank's recurrence gate embed the served
  hits' text. Under `none` the near-duplicate pass leaves confidential+ hits out (they are
  kept, never merged), and a page that holds one is not embedded for the gate.
- **Write-time conflict screen** (`POST /remember` with
  `MNEMO_WRITE_CONFLICT_CLASSIFICATION=true`) and the **scoped conflict check**
  (`packages/consolidation`), both on the `judge` task: unless completions are allowed, a
  confidential+ write is not screened, candidates stop at `internal`, and confidential+
  pairs are skipped, so contradictions involving such facts are not detected. Allowed,
  candidates go up to the writer's ceiling. The consolidation storage gets the key ring's
  unwrapper only when the server's own judge may receive that text (`all`, or a local
  `judge`); otherwise sealed facts read `[unreadable]` there, and a fact that cannot be
  opened (`redacted`) is never judged.
- **Recall `rerank`** (`judge`): a page that holds a confidential+ hit keeps its score
  order unless completions are allowed.

Not affected by the value: **consolidation** (clustering, the deep-mode classifier and
replay) keeps excluding confidential+ facts, and facts with a missing or unknown tier or
that could not be opened (it writes merged facts, and a derived fact cannot be sealed);
**HyDE** and anticipation send only the caller's query; **session collapse** sends session
turns, which carry no fact tier (a managed session is `public` or `internal`).

**Local providers are not egress.** With a provider the operator runs on its own machine or
network, confidential+ text goes to it under any value: the embedder carries
`EmbedAdapter.local`, and the completion adapter lists the tasks it answers locally in
`LLMAdapter.localTasks`, so a judge routed elsewhere (`MNEMO_LLM_JUDGE_*`) is judged on its
own. Each task's locality comes from the endpoint the task router really calls for it
(`routeFor` in `boot/llm-router.ts`), and a completion that names no task is never local.
Only the server's own adapter can carry `localTasks`: an adapter built from a provider a
workspace configured never does. Local is read only from the operator's environment (`MNEMO_LLM_*`, `MNEMO_EMBED_*`),
and only from what cannot be redirected after boot: Ollama with no base URL (it defaults to
`http://localhost:11434`), or a base URL whose host is `localhost` (RFC 6761: always
loopback) or an IP literal in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `::1` or `fc00::/7`. Any other host name, a Docker service name such as
`http://ollama:11434` included, resolves through DNS at request time, so it counts as
external; link-local and CGNAT addresses do too. Bedrock ignores the base URL and is always
external. A provider a workspace configures through the API (`/config/llm`) is always
external: whoever sets it controls its address. The in-process stub embedder
(`MNEMO_EMBED_STUB=true`) is local.

**Writes after the first one** keep the row's key: a PATCH of the text (`updateFact`), a
topic-key update and a replacement re-encrypt under the DEK of the row's `actor_id`, and
fail rather than store plaintext when that DEK is gone. A conflict `merge` takes the more
sensitive tier of its two facts and is sealed under the resolving actor's DEK. A derived
fact (composition rules) has no actor, so a confidential+ one is refused. Moving a
confidential+ fact to another workspace is refused (its DEK is bound to the source one).

**How encrypted facts are found.** Only by meaning and by exact repeat:

- **Vectors** (unless `MNEMO_SENSITIVE_TEXT_TO_PROVIDERS=none` with an external
  embedder): `remember()` embeds the plaintext in memory before the write and stores
  that vector; a topic-key update passes its new vector to the successor. A confidential+
  row is never re-embedded from its column, so one written while the embedder was down
  (CHAOS-5) or replaced without a vector stays out of semantic recall.
- **Exact repeat**: the content hash (`mnemo_fact_hash`, `factStatementHash`) is SHA-256
  of the normalised plaintext, computed before the write, so re-sending the same
  statement still deduplicates. It is unsalted: someone with the database can confirm a
  guessed statement, not read one.
- **Full text: never.** `text_lemmatized`/`text_lemmatized_es` are generated from the
  stored column, which holds ciphertext. This is deliberate: a tsvector of the plaintext
  is the statement's words in the clear, in a column crypto-erasure cannot reach, so it
  would undo the encryption at rest. There is no trigram index on facts.

The stored vector is not encrypted and survives erasure (section 8): it is derived from
the text and can leak some of it to someone with the database.

**Why per-actor DEK (not per-field or per-fact):**

- **GDPR right-to-erasure**, for a single credential, is fulfilled by calling
  `destroyActorDek(workspaceId, actorId)`, which nulls the wrapped DEK row in
  `mnemo_actor_dek` for that one `actor_id`. Every ciphertext encrypted under
  that DEK becomes permanently irrecoverable — without touching the rows
  themselves. Per-field keys would require tracking O(facts × fields) keys;
  per-actor makes erasure a single-row operation.
  **Per-person erasure** (the actual GDPR unit — a human, not a credential)
  is `destroyUserDeks(workspaceId, userId)`: `mnemo_actor_dek` carries an
  additive nullable `user_id` column stamped at DEK-provisioning time, and
  this bulk-destroys every DEK a person has accrued across every `actor_id`
  (API key) they've used in one call. This exists because a person holding
  two API keys previously had two separate DEKs, and `destroyActorDek` on
  one key left the other's DEK — and that credential's data — recoverable.
  The wrap/unwrap crypto (AAD, KEK derivation) is unchanged by this; only
  the erasure-candidate bookkeeping is per-person now. DEKs provisioned
  before this column existed have `user_id = NULL` (no backfill) and remain
  reachable only via the single-credential `destroyActorDek` path — see
  `forget()` in `packages/core/src/cognitive/forget.ts`, which tries
  `destroyUserDeks` first and falls back to `destroyActorDek` when it finds
  nothing, so this legacy case doesn't hard-fail GDPR erasure.
- **Key-management cost** is O(actors), not O(facts × fields). A workspace with 10 agents and
  10,000 facts holds 10 DEKs, not 200,000+.
- **Ciphertext isolation** is preserved by AES-256-GCM's unique 96-bit nonce per encrypt call.
  Two facts encrypted under the same actor DEK produce independent ciphertexts that reveal nothing
  about each other; a shared DEK does not reduce confidentiality.

Disk and backup encryption are the operator's: nothing in the repository configures them.

---

## 8. GDPR Erasure

Three operations exist:

- **Hard delete of one fact.** `DELETE /facts/{id}/hard` and
  `DELETE /forget/fact/{id}?mode=hard` need `memory:hard_delete` and run
  `hardDeleteFactAudited` (`packages/server/src/routes/_fact-hard-delete.ts`): the row is
  deleted, a `mnemo_deletion_log` row and the index cleanup are written in the same
  transaction, and a terminal `hard_delete` audit entry follows. No encryption key is
  destroyed. The log row keeps the fact's creation time (migration 0068), so federation
  serves the deletion as a tombstone to a peer that may hold the fact, and the peer
  archives its copy (FEDERATION.md, section 10).
- **Crypto-erasure of a person.** `POST /admin/erasure`
  (`packages/server/src/routes/admin-erasure.ts`, scope `memory:hard_delete`; CLI
  `mnemo erase`) names one subject in the caller's workspace: `userId` destroys every DEK of
  that platform user (`destroyUserDeks`), `actorId` (the `key:<id>` ref on the actor's facts)
  destroys that actor's DEK (`destroyActorDek`, the path for DEKs provisioned with no user
  binding). The body must repeat the id in `confirm`, or the answer is 400. It writes
  `erasure_initiated` before touching a key (if that write fails, nothing is destroyed),
  then a terminal `erasure_complete` with the number of keys destroyed. With no live key
  for the subject it answers 404 and writes no completion entry. Rows are not deleted: the
  confidential and restricted columns stay as ciphertext no key can open, and reads return
  them as `[erased]` with `redacted: "erased"` (section 7). Plaintext columns of `public`
  and `internal` facts and the stored embeddings are not touched.
  An agent whose policy lists `delete_fact` in `requireApprovalFor` needs an approval for
  it too, and a break-glass `mk_admin_` key needs the two-person grant.
- **Hard mode of `forget()`** (`packages/core/src/cognitive/forget.ts`): writes
  `erasure_initiated`, deletes the fact, logs it in `mnemo_deletion_log`
  (`deletionType: "gdpr_erasure"`), destroys the caller's DEKs (`destroyUserDeks` for a
  key bound to a user, falling back to `destroyActorDek`; a failure aborts before the
  completion entry), queues vector and hot-cache purges, and writes a terminal
  `hard_delete` entry. No HTTP route calls it.

The daily retention cron also destroys an actor's DEKs once all of that actor's encrypted
facts have expired (`packages/server/src/cron/retention-purge.ts`).

---

## 9. Rate Limiting

`packages/server/src/ratelimit.ts`, mounted on HTTP only:

1. **Per-key token bucket** per operation class, scaled by plan (free 1×, pro 10×,
   enterprise 100×):

   | Class        | Budget (free plan) | Burst                 |
   | ------------ | ------------------ | --------------------- |
   | `recall`     | 600 / minute       | 50                    |
   | `write`      | 120 / minute       | 20                    |
   | `turn`       | 600 / minute       | 100                   |
   | `export`     | 10 / day           | the daily cap         |
   | `admin`      | 30 / minute        | the per-minute budget |
   | `federation` | 60 / minute        | the per-minute budget |
   | `other`      | 600 / minute       | the per-minute budget |

   `turn` is `POST /session/:id/turn` only.

2. **Concurrency slot** per workspace and actor, taken before the rate token: at least 10
   requests in flight (the plan's limit when higher: pro 25, enterprise 100). A refusal
   answers 429 with `Retry-After: 1`.
3. **Fleet shedding**: the middleware answers `503` with `Retry-After: 5` and
   `Mnemosyne-Rate-Limited-Reason: fleet_shed` when fleet utilization reaches a class's
   threshold: 70% for export, admin and federation, 85% for every other route, never for
   recall and collapse. Utilization is the share of Postgres `max_connections` busy across
   the cluster (`pg_stat_activity`, sampled every 2 s), the same reading the job-shedding
   gate uses (`deps.fleetUtil`, `index.ts`); without a database it stays 0.
4. **Worker shedding**: background queues shed work under back-pressure
   (`mnemo_queue_shed_total`, `packages/server/src/metrics/backpressure.ts`).

As built, the request limiter runs only on HTTP and only with Redis. Without `MNEMO_REDIS_URL` no backend is created (`index.ts`) and the middleware is not mounted (`app.ts`), so there is no in-process fallback; with an unhealthy backend, or on a backend error, it fails open (`ratelimit.ts`). gRPC has only the per-agent limiter of section 5, which needs an access policy for the agent.

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
`Mnemosyne-Rate-Limit-Operation`, and on a refusal `Retry-After` and
`Mnemosyne-Rate-Limited-Reason`.

---

## 10. Memory Poisoning and Prompt Injection

- **Write-time gate** (`packages/core/src/ingest-safety.ts`), on every path that stores
  memory text, including `POST /import`: a poisoning-pattern scan on the original text is a
  hard reject; PII is redacted and stored.
- **Write-time anomaly score** (`packages/core/src/security/anomaly.ts`):
  `0.5 × distance + 0.3 × piiDensity + 0.2 × contradiction`, from the new fact's nearest
  neighbours. At or above 0.8 (`anomalyScoreThreshold`) the fact is stored and sent to the
  review queue.
- **Recall-time injection score** (`packages/core/src/security/injection.ts`): a noisy-OR
  over the matched poisoning patterns plus a weak signal for a leading imperative verb. A
  hit at or above 0.85 (`injectionScoreThreshold`) is demoted: its score is multiplied by
  `1 - injectionScore`. Every recall hit carries `trust: "untrusted"` and its
  `injectionScore` (`packages/server/src/routes/recall.ts`).
- **MCP output**: `@mnemo-ai/mcp` wraps every recalled memory in
  `<untrusted_context>...</untrusted_context>` (`packages/mcp/src/tools/render-memory.ts`).
- **Embedding noise** (optional): `MNEMO_EMBEDDING_NOISE=laplace:<epsilon>` or
  `gaussian:<epsilon>` adds differential-privacy noise to every embedding the server
  computes; the default, `off`, adds none (`packages/core/src/security/embedding-noise.ts`).

---

## 11. Federation

Details in [FEDERATION.md](./FEDERATION.md) §10 and §11. In short, a peer's request to
`/memory/federation/items` or `/resolve` must carry an `mk_fed_` key, arrive over TLS 1.3
(from the server's own socket or a declared TLS proxy), present the public key that the
operator pinned for that peer (`pinnedCertDer`, mandatory, compared in constant time), and
carry an EdDSA service JWT signed with that pinned key, addressed to this server, valid for
at most 5 minutes and never replayed (`jti` kept in Redis when `MNEMO_REDIS_URL` is set). A
pin mismatch writes the audit entry `federation_cert_pin_mismatch`. Optionally, item
payloads are sealed with AES-256-GCM under a shared symmetric key and the batch is signed
with Ed25519. Pulled items are always stored as `federation_received`, under the id of the
registered peer they were pulled from, whatever `peerDomain` the items claim. A tombstone
archives a copy only when it comes from the copy's own peer.
Recall returns pulled items to their workspace only (RLS), at the tier the peer sent (anything
unknown reads as `restricted`) under the caller's ceiling, with the recall-time injection score,
and marked `federation: { peer, trustScore: 20 }` ([FEDERATION.md](./FEDERATION.md) §12a).

Pulled items, tombstones and sync jobs are per workspace under forced RLS like the rest.
`DrizzleSyncStorage` runs each call in a transaction that sets `app.current_workspace_id`
(read by the policies of `mnemo_federated_item` and `mnemo_sync_tombstone`) and
`mnemosyne.workspace_id` (`mnemo_sync_supersession`); the job store sets
`mnemosyne.workspace_id`. The application role may only insert into `mnemo_deletion_log`,
which has no RLS; `/items` reads a workspace's hard deletions through the `SECURITY DEFINER`
function `mnemo_deleted_facts` (migration 0068), which returns only the rows of the workspace
`mnemosyne.workspace_id` names, and none when it is unset. Which tombstones a peer gets is
bounded by what the server served that peer (`mnemo_federation_serve_mark`, migration 0070,
per workspace under forced RLS), never by the `knownCursor` the peer sends alone. The peer table belongs to the installation and is keyed to the
`mnemosyne.federation_peers` GUC, which only the peer store sets. All three stores
downgrade to `app_user` when the connection may, so they obey the policies even over a
superuser connection.

A peer never writes into this server: its `mk_fed_` key reads `/items` and calls
`/resolve`, which stores nothing, and `POST /memory/federation/sync` refuses it. The gRPC
`FederationSync` RPC, which would apply items a caller sends, answers `Unimplemented` to
every key, so it opens no write path for a peer either.

---

## 12. Code Map

| Concern                                        | Where                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AuthAdapter`, `AuthContext`, `KeyScope` types | `packages/types/src/security.ts`                                                       |
| API-key middleware                             | `packages/server/src/auth.ts`, `auth-evaluate.ts`                                      |
| Scoped keys                                    | `packages/server/src/auth/` (`ScopedApiKeyAdapter`, `hash.ts`, `rotation.ts`)          |
| Scoped key issuance                            | `packages/server/src/routes/admin-scoped-keys.ts`                                      |
| Scope mapping and guard                        | `packages/server/src/app-scope.ts`, `middleware/scopeGuard.ts`, `grpc.ts`              |
| Agent policies, break-glass                    | `packages/server/src/middleware/rbac-policy.ts`                                        |
| Transaction settings for RLS                   | `packages/core/src/tx.ts`                                                              |
| Audit chain                                    | `packages/adapter-postgres/src/merkle.ts`                                              |
| Key ring and encryption gate                   | `packages/server/src/encryption/`                                                      |
| Erasure                                        | `packages/server/src/routes/admin-erasure.ts`, `packages/core/src/cognitive/forget.ts` |
| Rate limiting                                  | `packages/server/src/ratelimit.ts`, `ratelimitRedis.ts`                                |
| Poisoning and injection                        | `packages/core/src/ingest-safety.ts`, `packages/core/src/security/`                    |
| Federation peer gate                           | `packages/server/src/federation/authenticateFederationRequest.ts`                      |
