# Multi-Tenancy: Users, Tenants, Workspaces, and Tokens

> **Status (2026-08-01):** The model described here is fully enforced server-side (S1-S8), covered end-to-end by `client-ts` (C1-C5), the MCP tool surface (M1-M4), and the CLI (L1-L3). This document is the canonical reference — read it before touching any tenant/workspace/auth code.

## 1. The model

Four primitives, two authority planes.

| Primitive                | Table                    | What it is                                                                                                                                                          |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**                 | `mnemo_user`             | A person. Has exactly one `personal_tenant_id`, auto-provisioned on `POST /users`.                                                                                  |
| **Tenant**               | `mnemo_tenant`           | `kind: personal \| organization`. An organization tenant is a company with multiple users; every user also has their own `personal` tenant, created alongside them. |
| **Workspace**            | `mnemo_workspace`        | A memory container. Belongs to exactly one tenant. All memory primitives (facts, decisions, episodes, etc) are workspace-scoped via RLS.                            |
| **Tenant membership**    | `mnemo_tenant_member`    | `(tenant_id, user_id, role)`. `role`: `owner \| admin \| member`.                                                                                                   |
| **Workspace membership** | `mnemo_workspace_member` | `(workspace_id, user_id, role)`. `role`: `owner \| admin \| write \| read`.                                                                                         |

A user can:

- create their own workspace(s) inside a tenant they administer,
- invite another user to a tenant or a specific workspace, with a role,
- mint a `uk_live_*` user token for another tenant member, scoped to one of their workspaces,
- hold `read`-only access to a workspace (e.g. a RAG-style consumer) — they can recall/search but cannot write, and the server enforces this, not just documentation.

### Keys vs. tokens

| Kind          | Prefix                            | Bound to                       | Can switch workspace?                                                        |
| ------------- | --------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| Workspace key | `mk_live_*` (legacy `mns_live_*`) | Exactly one workspace, no user | No                                                                           |
| User token    | `uk_live_*`                       | A `userId`                     | Yes — via `X-Workspace-Id` header, to any workspace that user is a member of |

**Which tenant a key acts in.** A key whose row carries a `tenant_id` acts in that tenant. A key without one (the bootstrap and setup keys, the keys minted from them, every `mk_*` key) acts in the tenant of its home workspace: the workspace on its own row, or for `mk_*` the workspace it authenticates to. `X-Workspace-Id` never changes it. This derived tenant only feeds the tenant-plane guards (§2): `GET /me`'s `tenantId` and multi-level recall keep reading the row's binding, which stays `null` for these keys.

## 2. The two authority planes

These are genuinely independent — do not conflate them.

**Tenant plane** — `mnemo_tenant_member.role`, gates `admin:tenant`-scoped operations (create workspaces, invite tenant members, mint user tokens for others). Checked by `requireTenantAdmin()` in `packages/server/src/routes/tenants.ts`.

Every guard compares against the caller's tenant (§1), and an unknown tenant is denied, never let through (AUTH-TENANT-NULL). A user-bound key also needs the `owner` or `admin` tenant role. A key with no user has no role to check and keeps tenant-admin authority in its own tenant only, which is what keeps a self-hosted instance's bootstrap key working. Workspace routes answer a workspace of another tenant with the same 404 as a missing one.

**Workspace plane** — `mnemo_workspace_member.role`, gates memory operations (facts, recall, remember, hard-delete, workspace membership management) via **role→scope narrowing** at auth time (below). Checked by `resolveWorkspaceRole()` in `packages/server/src/auth.ts`.

A workspace admin is NOT automatically a tenant admin, and vice versa — `mnemo tenant invite`/`mnemo token issue` require tenant-plane authority; `mnemo workspace invite`/`set-role` require workspace-plane authority on that specific workspace.

**Instance plane** (accounts stage A) — a third, installation-wide authority: `mnemo_instance_admin` (superadmin). It is stored apart from tenant and workspace membership, read from the database on every request (never from the session cookie) and reachable only through `/instance/*` routes on the dashboard cookie bridge with a password session; no API key or `uk_live_*` token reaches it, and non-superadmins get the plain 404 of an unknown route. Writes to `mnemo_instance_admin` and to `mnemo_user.disabled_at` go only through `SECURITY DEFINER` functions (migrations 0050-0055); the app roles hold no table-level write on them, and `mnemo_user` has per-column `UPDATE` grants (a new column written by app code needs its own grant). A superadmin can open any workspace read-only without being a member (testing period). Disabling a user stops their user-bound keys and tokens on every transport; offboarding also drops their superadmin grant. Operator procedures: [ACCOUNTS.md](../guides/ACCOUNTS.md).

## 3. Role → scope narrowing

Implemented entirely in `packages/server/src/auth.ts`'s bearer middleware, enforced by the single central scope guard in `app.ts` (`v1.use("*", ...)` → `app-scope.ts`'s `getScopeForRequest()`). Every route inherits this automatically — no per-route code.

```
effectiveScopes = keyScopes.filter(s =>
  !WORKSPACE_GOVERNED_SCOPES.has(s) || WORKSPACE_ROLE_SCOPES[role].has(s)
)
```

`WORKSPACE_GOVERNED_SCOPES` = every scope except the 3 tenant/instance-plane ones (`admin:tenant`, `admin:billing`, `admin:workspace`), which a workspace role never touches. This can only ever **narrow** a token's own scopes — never grant more than the key was created with.

| Role    | Scopes (cumulative)                                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `memory:read`, `memory:subscribe`, `session:read`, `entity:read`, `federation:read`                                                                                                                                  |
| `write` | everything in `read`, plus `memory:write`, `memory:delete`, `memory:session`, `memory:task`, `memory:event`, `memory:reasoning`, `memory:procedural`, `memory:self_edit`, `session:write`, `entity:write`            |
| `admin` | everything in `write`, plus `memory:admin`, `memory:hard_delete`, `memory:export`, `memory:governance`, `memory:federation`, `admin:keys`, `session:manage`, `entity:admin`, `federation:write`, `federation:manage` |
| `owner` | same effective scopes as `admin` (ownership is a membership-management distinction, not a wider scope set — inventing an owner-only scope with no route behind it would be speculative surface)                      |

Source of truth: `packages/types/src/security.ts` (`WORKSPACE_ROLE_SCOPES`, `narrowScopesForWorkspaceRole`, `roleAtLeast`).

**Sharp edge, accepted as-is:** `app-scope.ts` maps _all_ `/sessions`, `/tasks`, `/events` paths to their scope regardless of HTTP method — so a `read` member can't list sessions either (no route-level GET/POST split for those prefixes). This is a pre-existing, unrelated scope-mapping decision; role narrowing does not attempt to fix it, to avoid touching unrelated scope rules in this change.

### Where narrowing applies

1. **The key's own home workspace** — narrowed on every request, not just on an explicit switch. A user-bound key with no membership row for its own home workspace (legacy/bootstrap key minted before this feature) **fails open**: scopes stay unnarrowed, a warning is logged, and `mnemo_auth_scope_narrowed_total` is not incremented for that request — this avoids bricking existing keys on deploy.
2. **An explicit `X-Workspace-Id` switch** (`uk_live_*` tokens only — `mk_live_*` keys 403 with "Multi-workspace requests require a user token"). Missing membership on an explicit switch **fails closed**: 403, unchanged from pre-existing behavior.

**Over gRPC** the same narrowing applies to the key's own home workspace (case 1, with the same fail-open), through the evaluator both transports share (`packages/server/src/auth-evaluate.ts`). gRPC has no switch: `x-workspace-id` metadata naming another workspace is refused with `InvalidArgument`.

Kill switch: `MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES=true` disables all narrowing, on both transports (mirrors the existing `MNEMO_ALLOW_LEGACY_FULL_SCOPE` precedent). Role lookups go through a short-TTL LRU per transport (`MNEMO_ROLE_CACHE_TTL_MS`, default 30s) — deliberately shorter than the key-verification cache (60s) so a role demotion propagates faster than a full key revocation would.

## 4. Request lifecycle

```
Request → auth.ts (verify key/token, resolve role for effective workspace)
        → narrowScopesForWorkspaceRole() → c.set("scopes", effectiveScopes)
        → app.ts's central scope guard (getScopeForRequest + decideScopeAccess)
        → route handler → withMnemoTx / withTenantRls (sets RLS GUCs, incl. `mnemosyne.actor_user_id`)
        → Postgres (RLS enforces workspace_id / tenant_id isolation)
```

`withTenantRls` sets `mnemosyne.actor_tenant_id` from the key row's `tenant_id`, and for a key with neither a tenant nor a user from the tenant derived in §1, found through the `SECURITY DEFINER` function `mnemo_workspace_tenant_id` (migration `0047`). RLS then confines such a key to its home tenant, as the guards do; the bootstrap key keeps its memberless workspace because `mnemo_workspace_write` also applies to `SELECT`. A user-bound key with no tenant gets no actor tenant. See §5 for which empty-GUC fallbacks remain (AUTH-TENANT-RLS-FALLBACK).

`GET /me` surfaces the result of this pipeline for introspection: `workspaceRole`, `effectiveScopes` (same value as `scopes`, named explicitly so a caller doesn't have to know `scopes` is already narrowed), `workspaceName`, `tenantId`.

**`mnemosyne.actor_user_id`** is the one GUC shared across both layers: `withMnemoTenantTx` sets it unconditionally for tenant/membership tables, and `withMnemoTx` (`packages/core/src/tx.ts`) can additively set it for primitive tables (`mnemo_fact`, etc.) when a caller opts in with `userId`/`enforceUserIsolation: true`. As of this writing no server route passes those options yet — the primitive-table RESTRICTIVE policy that reads this GUC (`mnemo_fact_user_isolation_select`, migration `0023`) exists and is safe to have shipped inert (see "Provenance identity" in CLAUDE.md), but nothing currently activates per-user isolation on primitive tables in production. Don't assume it's enforced there without checking `withMnemoTx`'s actual call sites first.

## 5. Onboarding recipe

The full "invite someone who's never used Mnemosyne, give them scoped access" flow, in 3 calls:

```bash
# 1. Invite by email — auto-provisions the account if it doesn't exist yet
mnemo tenant invite <tenantId> newcomer@example.com --role member --create-if-missing

# 2. Add them to a specific workspace with a role
mnemo workspace invite <workspaceId> <newUserId> --role read

# 3. Mint them a token scoped to their own role in that workspace
mnemo token issue <tenantId> <newUserId> --label "newcomer read access" --workspace <workspaceId>
```

Step 3's minted token defaults to the target user's workspace-role-narrowed scope set for that workspace when `--scopes` is omitted; explicit `--scopes` must be a subset of the **minting admin's own** scopes — a tenant admin can never mint a token more powerful than themselves.

**Who can run it.** Every step works with a key bound to the tenant, held by a tenant `owner` or `admin`, and with a key that has no user (which acts in its home workspace's tenant, §1). `POST /tenants` and `POST /users` name no tenant, so they check the caller against its own tenant: a user-bound caller must be `owner` or `admin` there. Until 2026-10-17 (SEC-5, PRIM-17) a tenant-bound key got a 500 from RLS on step 1 with `--create-if-missing`, on `POST /tenants`, on `POST /users` and on any workspace created with an owner; only keys with no tenant and no user passed, through the empty-GUC fallbacks.

**Creating accounts and tenants.** A new tenant's id is never the caller's tenant and a new user is never the caller, so RLS refuses those rows to a tenant-bound caller. They are written by `SECURITY DEFINER` functions (migration `0047`): `mnemo_provision_user` creates the user, its personal tenant and personal workspace and both owner memberships in one call, `mnemo_provision_tenant` creates a tenant and makes the calling user its owner (and, on request, its first workspace), and `mnemo_find_user_id_by_email` lets an invitation find a member of the caller's tenant or an account that tenant provisioned, which `mnemo_user_own` hides from it. Each account records the tenant that provisioned it (`mnemo_user.provisioned_by_tenant_id`), so `POST /users` followed by the invitation works. They generate every id, take no existing tenant, user or workspace as input, check the caller's tenant role again in SQL, and run in the route's transaction. A taken email is a 400 on `POST /users`.

**A user-bound key cannot pull someone else's account into its tenant.** Invitations by such a key find only members of its own tenant and accounts its tenant provisioned: any other registered email answers 404, or 409 with `--create-if-missing`. The reason is step 3. A token minted for a user switches with `X-Workspace-Id` into every workspace that user belongs to, in any tenant, and that check is membership only (`auth-evaluate.ts`). An admin who could add any registered user to its tenant could mint a token for them and read their personal workspace. Keys with no user still find every account, as they did through the RLS fallbacks; the same caveat applies to them and to every member a tenant already has, whose personal workspace its admins can reach the same way. Inviting existing accounts from a user-bound key needs the switch confined to the token's tenant first (or the invitee's consent).

**Operating a new tenant.** `POST /tenants` makes the caller its owner, but tenant-plane authority comes from the key's own tenant (§1): the caller's current key still acts in its old tenant. With `issueOwnerToken: true` the same call, in one transaction, also creates the tenant's first workspace (owned by the caller's user) and returns `ownerToken`, a `uk_live_*` token for that user bound to the new tenant and workspace, carrying the caller's own known scopes and sensitivity ceiling at most (SEC-1). That token acts in the new tenant and not in the old one. It needs a key bound to a user (400 otherwise); without the flag nothing but the tenant and its owner membership is created, and only an operator can mint the first key bound to it.

**Creating a workspace.** Its owner is `ownerUserId`, or the caller's own user when that is omitted, and must be a member of the tenant (403 otherwise, nothing created). The owner membership is the workspace's first, and passes RLS through the `INSERT`-only policy `mnemo_workspace_member_seed_owner`: role `owner`, for the user the workspace row declares as `owner_user_id`, in a workspace with no member yet, of the caller's tenant, written by an `owner` or `admin` of that tenant. It grants nothing on a workspace that already has members, and changes no `UPDATE` or `DELETE`. A key with no user and no `ownerUserId` still creates a workspace with no member; keys with no user in that tenant keep managing it, and its first member is added with `POST /workspaces/:id/members`.

**Workspaces left without members before the fix** (created by a user-bound key with no `ownerUserId`) have `owner_user_id` null, so the policy above does not apply to them and nobody is made their owner automatically. Repair one by adding its first member with a key that has no user in that tenant (`POST /workspaces/:id/members`), or as the database owner: `INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES ('<workspace>', '<tenant member>', 'owner')`.

**What RLS still lets through with no GUC (AUTH-TENANT-RLS-FALLBACK).** Since `0047`, `mnemo_workspace_member` admits a caller with no user only in the workspaces of its actor tenant, and nothing with no GUC at all. The empty-GUC branches of `mnemo_tenant`, `mnemo_tenant_member`, `mnemo_user` and `mnemo_workspace` stay, because code outside the tenant routes still writes or reads through them: `POST /bootstrap` and `POST /setup/complete` insert the first tenant and workspace setting `mnemosyne.tenant_id`/`mnemosyne.user_id`, which no policy reads, and `getUserPersonalWorkspaceId` (multi-level recall, `GET /me`) reads `mnemo_workspace` with only the user GUC. Removing them takes, in order: those two writers setting `mnemosyne.actor_tenant_id`; the personal-workspace lookup going through a `SECURITY DEFINER` function or setting the personal tenant as actor tenant; user-bound keys with no tenant getting their derived tenant too; then one migration that drops the branches, splits the `ALL` policies of `mnemo_workspace` and `mnemo_tenant` into per-command ones so a write policy no longer widens `SELECT`, and gives the read policy an explicit branch for a key with no user in its own tenant.

## 6. What we deliberately did NOT build

- **No `memory_tenant` MCP tool.** Tenant-plane operations (create an organization, invite at the tenant level, mint tokens) stay CLI/HTTP-only. No agent mid-task needs "create an organization"; more importantly, minting a token returns a **plaintext credential** — putting that in an MCP tool means a live secret lands in the model's context window and every transcript/telemetry sink downstream, which is disqualifying regardless of the "no agent needs this" argument.
- **No workspace switching from any agent-facing tool.** The active workspace is an agent's memory identity for the whole session, fixed at process start (env var / key / token). Switching mid-task would silently fragment memory (write to B, later recall from A, never notice). `memory_context` / `memory_workspace action:'current'` give read-only role awareness instead; a role-caused 403 gets an explicit "ask an admin" recovery message, not a retry loop.
- **`owner` ≡ `admin` scope-wise.** No separate owner-tier scope exists (see §3).
- **`admin:keys` is reachable at workspace-`admin` role.** Intentional — a workspace admin minting workspace-scoped keys (`POST /admin/keys`) is in-plane. Minting a token for a **different, specific user** is NOT in-plane, which is exactly why `POST /tenants/:tenantId/users/:userId/tokens` is its own route rather than an extension of `POST /admin/keys` (see API.md §2.14).

## 7. Related docs

- [API.md §2.14](./API.md#214-multi-tenancy-tenants-workspaces-users-tokens) — route reference (request/response shapes).
- [DATA_MODEL.md](./DATA_MODEL.md) — table DDL, RLS policies, the `0012`/`0022` recursion-fix migrations.
- [SECURITY.md](./SECURITY.md) — the two-plane model as a security invariant.
- `packages/mcp/src/tools/workspace.ts`, `packages/mcp/src/tools/context.ts` — the MCP surface.
- `packages/cli/src/commands.ts` (`workspace`, `tenant`, `user`, `token` commands) — the CLI surface.
