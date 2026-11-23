# Accounts, superadmins and team access: operator guide

**English** · [Español](ACCOUNTS.es.md)

Audience: whoever runs a Mnemosyne installation. Model background: [MULTI_TENANCY.md](../architecture/MULTI_TENANCY.md) (the instance plane is section 2).

This guide covers stage A: superadmins, user lifecycle (disable, re-enable, offboard), workspace members, single-use links (invitations, account setup, password reset) and the dashboard Installation section. Self-registration and email delivery are stage B and are **not built**: registration is always closed, and every link is copied by an admin and shared by hand.

## 1. Concepts

- **Superadmin**: an installation-wide role stored in `mnemo_instance_admin`, apart from tenant and workspace membership. It is read from the database on every request, never from the session cookie, so a revocation applies on the next request.
- **Instance plane**: routes under `/instance/*`, mounted on the dashboard cookie bridge only. They accept a password session of a current superadmin. No API key reaches them. Anyone else gets the plain 404 of an unknown route.
- **What a superadmin can do**: list, create, disable, re-enable and offboard users; grant and revoke superadmin; list every workspace and manage its members; change installation settings; read the security audit.
- **Superadmin authority stays in the session.** While signed in, a superadmin's session also holds `admin:workspace` (installation-wide LLM and retention config). An API key created or rotated from a dashboard session never receives that scope (403), because a key would keep it after the superadmin is revoked.
- **Read access to any workspace**: during the current testing period a superadmin can open any workspace (personal ones included) from Installation > All workspaces and read its memories without being a member. The session is read-only unless they are a member (then they keep their real role). The opening is audited (`workspace_opened`); individual reads are not. This will later be audited per read and made configurable.
- **Workspace roles**: owner, admin, write, read. Owners and admins manage members and invitations of their workspace. An admin cannot invite, change or remove an owner. A workspace always keeps at least one enabled owner.
- **Personal workspaces take no invitations.** Share an organization workspace instead.

## 2. Deploy and migrate

1. Take a backup first:

   ```bash
   docker compose exec postgres pg_dump -U <owner> -Fc <database> > mnemosyne-$(date +%F).dump
   ```

2. Run the migrations **before** starting the new server. This stage adds `0050` to `0055`: `0050` user lifecycle and superadmin, `0051` the bootstrap-admin function, `0052` the instance plane, `0053` workspaces and offboarding, `0054` single-use links, `0055` the security audit. In the compose setup that is `docker compose up migrate`. The migration connection (`MIGRATE_DATABASE_URL`) must be a superuser or a role with `BYPASSRLS`: the instance functions run as that role and rely on it bypassing RLS. Owning the tables is not enough, because a table owner without `BYPASSRLS` does not bypass `FORCE ROW LEVEL SECURITY`.
3. Start the new server and dashboard.
4. Put a proxy in front? Then set `MNEMO_PUBLIC_BASE_URL` (see section 5).

After migration the app role can no longer write `disabled_at` on `mnemo_user` or write `mnemo_instance_admin` at all. Those changes go only through the instance functions.

## 3. First superadmin

There are two ways. Use one.

### 3.1 First-run bootstrap

On a fresh installation `/dashboard/setup` (`POST /bootstrap`) accepts `adminEmail` and `adminPassword` together (or neither). The request must carry the setup token the server prints in its log at startup (`setupToken` in the body or the `X-Setup-Token` header; `MNEMO_SETUP_TOKEN` sets a fixed one for unattended installs): without it the answer is 401 `setup_token_required`. It creates that user, makes them superadmin and records `user_created` and `superadmin_granted` in the audit log (actor `system:bootstrap`). It works only before the first API key exists; afterwards it answers 403 `already_bootstrapped`. The database function behind it refuses too unless the installation has no superadmin and at most the one key the bootstrap has just created, and the user exists and is enabled. An installation already in use that has no superadmin yet (for example right after upgrading to this stage) gets its first one from the break-glass script, never from the app.

### 3.2 Break-glass script

For an existing installation, or to recover when no superadmin can sign in:

```bash
docker compose exec -e MNEMO_ADMIN_DATABASE_URL='postgres://<owner>:<secret>@postgres:5432/<db>' \
  server node scripts/dashboard-password.mjs --email <email> --superadmin < password-file
```

Rules:

- `MNEMO_ADMIN_DATABASE_URL` is the URL of a superuser or a role with `BYPASSRLS` (the migration role, section 2). It must bypass RLS on `mnemo_instance_admin`, which the app role cannot write. Pass it **only at run time** with `-e` as above. Never put it in the server's environment, `.env` or compose file.
- The password comes from stdin (a file or a pipe, never an argument; the script refuses a terminal). It must follow the policy: at least 12 characters, at most 72 bytes, different from the email. Delete the file afterwards.
- `DATABASE_URL` must already be set in the container (it is, for the server).
- The user must exist or you add `--create` (which also provisions their personal tenant and workspace). With `--create --workspace <id>` the new user gets read access to exactly that workspace instead (plus a personal tenant, no personal workspace); `--workspace` is accepted only with `--create`. With `--superadmin`, a disabled user is refused; enable them first.
- Setting a password with the script ends every open dashboard session of that user, as a reset link does (in a running server within the 15-second status cache, section 6). Use it as a break-glass password reset.
- The script sets the password and then grants superadmin. If the grant fails you get the message "Password set, but the superadmin grant failed"; check the URL and the migrations. If the user was disabled between the two steps you get "Password set, but the user is disabled so superadmin was not granted"; enable them and run it again.
- **The script's grants are not in the dashboard audit log.** That log is hash-chained and a raw insert could break its verification, so the script does not write to it. The record of a break-glass grant is the operator's shell history (and the deploy log). Keep it.

### Example: mnemo.example.com

```bash
# On the host, after migrations; the file holds a password chosen for this purpose.
docker compose exec -e MNEMO_ADMIN_DATABASE_URL="$ADMIN_URL" \
  server node scripts/dashboard-password.mjs --email admin@example.com --superadmin < /root/admin-password.txt
shred -u /root/admin-password.txt
```

## 4. Day-to-day operations (Installation section)

Superadmins see an **Installation** group in the sidebar: Users, All workspaces, Settings, Security audit. Everyone else sees none of it.

### 4.1 Users

- **Create user**: enter an email (and an optional name). The response is a one-time **account setup link** (valid 7 days). Send it to the person; they choose a password and land in their personal workspace. An email already in use answers 409 `email_taken`.
- **Disable / re-enable**: a disabled user cannot sign in, their sessions end, and their user-bound keys and tokens (`uk_live_*` and keys bound to the user) stop authenticating on every transport. Data, memberships and tokens stay, so re-enabling restores access. **Disabling the only enabled owner of a shared workspace leaves it without an owner who can act**: no one there can manage members or invitations until a superadmin promotes another member to owner (Installation > All workspaces) or re-enables the user. Check a user's owned workspaces before disabling them; offboarding (next item) asks for a new owner instead.
- **Offboard**: disables the user, removes every workspace and tenant membership except their personal tenant, revokes their `uk_live_*` tokens and user-bound API keys, drops any superadmin grant and ends their sessions, in one transaction. The personal workspace and its data are kept. If the user is the last owner of a shared workspace, the call answers 409 `owner_required` and the dialog lists those workspaces; choose a new owner for each and repeat. Re-enabling an offboarded user does not restore memberships or superadmin. Offboarding can leave a tenant without a tenant owner: the new workspace owners you pick join the workspace as owner but the tenant only as member. Account setup and reset links the offboarded user issued as superadmin stop working.
- **Grant / revoke superadmin**: asks for your own password in the same request (a wrong one counts toward your sign-in lockout). The last active superadmin cannot be revoked, disabled or offboarded (409 `last_superadmin`).
- **Reset link**: generates a single-use password reset link (valid 30 minutes) for a user. Resetting unlocks a locked account and ends all its sessions. Only superadmins can do this: an account spans every workspace its owner belongs to, so a workspace admin cannot.
- Account setup and reset links work only while their issuer is still an active superadmin: once the issuer is revoked, disabled or offboarded, their pending links are refused (404). Issue a new one from another superadmin.

### 4.2 Workspaces and members

- Installation > All workspaces lists every workspace with tenant, owner and member count. **Open** switches your session to it (read-only unless you are a member). Superadmins can also change roles and remove members of any workspace there. **My workspaces** (top of the sidebar) is different: only the workspaces you belong to, and the form to create one.
- **Add member** (in a workspace's Members panel there) adds an existing account by email with any role, at once and without an invitation; audited as `member_added`. It is how a workspace with **no owner** (one created with an operator key, for instance) gets one: nobody can manage such a workspace, invite to it or create its keys until it has an owner, and the list flags it. Refused for a personal workspace (409 `personal_workspace`), an email with no account (`unknown_email`), a disabled account (`user_disabled`) and someone already in the workspace (`already_member`). Migration `0057` adds the function behind it.
- Workspace owners and admins use **Members** in their own workspace: list members, change a role, remove a member (refused for the last owner, 409 `last_owner`), invite, and manage pending invitations.
- **Removing a member revokes their API keys for that workspace**, whether from the dashboard, Installation or the v1 API (`DELETE /workspaces/:id/members/:userId`, used by the CLI and the MCP `memory_workspace` tool): every `uk_live_*` token and user-bound key homed in that workspace is revoked in the same transaction, and stops authenticating at once in the server that handled the removal (other server processes within a minute, their key cache). Their keys homed in other workspaces, including their personal one, are not touched. Re-adding the member does not restore revoked keys; they create new ones.

### 4.3 Invitations and links

- An owner or admin enters an email and a role. The server returns the link **once**; copy it and share it. It cannot be shown again, only regenerated (the old link then dies) or revoked.
- Lifetimes: invitation and account setup 7 days; password reset 30 minutes. Links are single use and only their SHA-256 hash is stored.
- Opening the link: a new person chooses a password and is signed in to the workspace; an existing account signs in first, then accepts. Accepting adds the workspace membership (and tenant membership `member`) in one transaction.
- A re-invite to a pending address replaces the pending invitation. Inviting someone who is already a member answers 409.
- Invitations can be turned off in Installation > Settings (`MNEMO_INVITATIONS_ENABLED` sets the initial value). Then no invitation is created or regenerated (403 `invitations_disabled`). **Turning invitations off does not invalidate links already handed out**: pending invitations can still be accepted until they expire. Revoke them in each workspace's Members (pending invitations) if they must stop working.
- Link issuing is rate limited per acting user (30 per 15 minutes). The public link endpoints share the per-IP sign-in budget (below).
- Anyone holding an invitation link learns whether that address has an account (accepted risk). Treat links as secrets: do not paste them into shared channels.

### 4.4 Settings

Installation > Settings (`GET/PUT /instance/settings`):

| Setting                                  | Notes                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitations enabled                      | Default on. Env `MNEMO_INVITATIONS_ENABLED`; a saved value wins.                                                                                                                                                                  |
| Public base URL                          | Used to build links. Env `MNEMO_PUBLIC_BASE_URL`; a saved value wins. `https` anywhere, `http` only for localhost; no credentials, query or fragment. Saved encrypted with the master key (501 `encryption_required` without it). |
| Registration                             | Always `closed`, read-only.                                                                                                                                                                                                       |
| Workspaces per user                      | Default 5. Env `MNEMO_WORKSPACE_LIMIT_PER_USER`; a saved value wins. Team workspaces a user who is not a superadmin may create and own (personal ones do not count); 0 leaves creation to superadmins.                            |
| Workspace owners can set their own model | Default off. Env `MNEMO_WORKSPACE_LLM_OVERRIDE`; a saved value wins. See section 4.5.                                                                                                                                             |

Each value reports its source: saved, env or default.

### 4.4.1 Creating workspaces

Any signed-in user creates a team workspace they own from **My workspaces** in the sidebar (`POST /dashboard/api/my-workspaces`, password sessions only). Each one gets its own organization tenant, with the creator as tenant and workspace owner, so it takes members, invitations and API keys like any team workspace. A user who is not a superadmin may own at most "Workspaces per user" team workspaces (409 `workspace_limit`); the database counts under a per-user lock, so concurrent requests cannot pass it. Creation is audited as `workspace_created` in the new workspace. The same page switches the session to any workspace the user belongs to, without signing out.

To connect an agent or a tool (an orchestrator, a flow engine), open the workspace, create an API key in Keys with `memory:read` and `memory:write`, and give it to that tool: everything it remembers and recalls stays in that workspace.

### 4.5 Who sets a workspace's model

A workspace can override the installation's LLM provider, model and API key (Config page, `PUT/DELETE /config/llm`). Every completion and embedding call for that workspace's memories then goes to that provider, from the server's network.

- **By default only installation admins change it**: a superadmin's password session or an operator key with `admin:workspace`. Workspace owners and admins see the model read-only, and the server answers their writes with 403 `LLM_CONFIG_INSTALLATION_ONLY`.
- **With "Workspace owners can set their own model" on**, owners and admins (`memory:admin`) may set it too. Their `baseUrl` must be `https://` and may not be, or resolve to, a loopback, private, carrier-grade NAT, link-local (cloud metadata) or multicast address (422 `BASE_URL_NOT_HTTPS`, `BASE_URL_PRIVATE_ADDRESS`, `BASE_URL_UNRESOLVABLE`, `BASE_URL_INVALID`); `ollama` needs such a `baseUrl` (422 `BASE_URL_REQUIRED`). The check runs when the URL is saved; a host whose DNS answer changes later is not re-checked.
- Installation admins' base URLs are not checked: an internal Ollama or proxy is their call.
- Every save and removal is audited as `settings_changed` with resource `llm_config`: provider, models and the base URL's host, never the key.

### 4.5.1 A workspace's API keys

Keys (workspace owners and admins, `admin:keys`) lists every live key of the open workspace, whoever created it: dashboard, CLI, `POST /admin/keys`, or an operator. Each row shows its label, scopes, creation date, last use and expiry. No key of a workspace is hidden from this page. Before 2026-11-04 the page read the wrong field of the response and listed none.

- **Rotate** creates a key with the same label and scopes and shows it once, with a Copy button. The old key keeps working for 7 days so clients can switch over. Its row says _Rotated · works until …_, and it cannot be rotated again.
- **Revoke** ends a key immediately. The server process that handled the revocation forgets the key at once. Another server process can still accept it for up to 60 seconds, the lifetime of its auth cache.
- Revoke the old key once every client uses the new one, rather than waiting out the 7 days.

### 4.6 Security audit

Installation > Security audit (`GET /instance/audit`) lists, newest first, 50 per page, with filters by actor, action and date: logins (success and failure), user created/disabled/enabled/offboarded, superadmin granted/revoked, member added/removed/role changed, invitations created/revoked/accepted, links created, password changed/reset, settings changed, workspace opened, and API key create/rotate/revoke. Links, tokens and passwords are never recorded. Rate-limited sign-ins are not audited. The existing Audit page (fact forgets and archives) is unchanged. Break-glass script grants are **not** here (section 3.2).

The same actions are counted per UTC day and per action by `GET /instance/audit/stats?days=30` (7 to 90 days; `failedSignIns7d` counts the failed sign-ins of the last 7 days), and Installation > Workspaces carries each workspace's live memories (under the caller's sensitivity ceiling) and last write; both read through migration 0060's superadmin-only functions.

## 5. Public base URL behind a proxy

Links are built from `MNEMO_PUBLIC_BASE_URL` or the saved Installation setting (the saved one wins). If neither is set, the link carries the origin of the request. Behind a reverse proxy that origin is usually the internal address, so the links you copy will be wrong. **Set it before creating the first invitation**, for example `https://mnemo.example.com`. The proxy in front of the dashboard must also overwrite the client-IP headers (`X-Forwarded-For`) so per-IP limits see the real address.

## 6. Sessions and timing

- Sessions are checked live. Disabling, offboarding, session revocation (password change or reset, superadmin revocation) and role or membership changes apply on the next request. The only delay is a per-process status cache of 15 seconds on user status. API keys: the server that made a change drops the user's cached keys and roles at once; other server processes keep a key cache of 60 seconds and a role cache of 30 seconds (`MNEMO_ROLE_CACHE_TTL_MS`).
- The dashboard API (`/dashboard/api/*`) refuses a state-changing request that the browser marks as coming from another site or a sibling subdomain (`Sec-Fetch-Site` other than `same-origin` or `none`) with 403 `invalid_origin`. The sign-in endpoints (`/dashboard/auth/*`) refuse only `cross-site` POSTs that way; they also require `application/json`, which a browser cannot send cross-origin without a CORS preflight the server does not grant. Serve the dashboard on its own origin.
- A session carries an epoch (`iat`) compared with `sessions_valid_after`. The comparison uses the database clock and the application clock, so **the hosts must run NTP**. A skewed app clock can reject fresh sessions or keep old ones.
- Disabling a user also stops their user-bound keys and tokens on HTTP, gRPC, the WebSocket upgrade and `/health/deep`. **Known limitation:** WebSocket connections already open, and long gRPC streams, are not cut; they end when the client reconnects.
- `MNEMO_DASHBOARD_LOGIN_IP_BURST` (default 30 per 15 minutes) sizes the per-IP token bucket shared by sign-in and the public link endpoints. Raise it for many users behind one NAT address. Email and per-user buckets are separate.

## 7. Rollout runbook (stage A, example)

For `mnemo.example.com`:

1. Back up with `pg_dump`; run migrations `0050` to `0055`; deploy the new server and dashboard.
2. Grant `admin@example.com` superadmin (section 3.2 example, or the first-run bootstrap on an empty installation).
3. Set the public base URL to `https://mnemo.example.com` (Installation > Settings or `MNEMO_PUBLIC_BASE_URL`).
4. Sign in as the superadmin; confirm the Installation section appears.
5. Invite a test address into an organization workspace, open the link in a private window, choose a password, sign in, then offboard that user from Installation > Users.
6. Check Security audit shows the invitation, acceptance and offboarding.

Stage B (email provider, domain-restricted self-registration) is not built.

## 8. Troubleshooting

| Symptom                                         | Cause                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Installation section absent                     | The user is not a superadmin right now, or signed in with an API key. |
| Links show an internal host                     | Public base URL not set (section 5).                                  |
| Script: needs `MNEMO_ADMIN_DATABASE_URL`        | Pass the owner/superuser URL with `-e` at run time.                   |
| Script: password set but grant failed           | The URL lacks rights or the migrations did not run.                   |
| Script: password set, user disabled             | Enable the user (Installation > Users), then run the script again.    |
| 403 `invalid_origin` on a dashboard action      | The request came from another site or subdomain (section 6).          |
| Setup or reset link answers 404                 | Expired, used, revoked, or its issuer is no longer a superadmin.      |
| Fresh sessions rejected, odd logouts            | Clock skew between app and database host (NTP).                       |
| 429 on sign-in or link pages for a whole office | One IP exhausted the bucket; raise `MNEMO_DASHBOARD_LOGIN_IP_BURST`.  |
| 409 `owner_required` on offboard                | The user is the last owner of a shared workspace; pick new owners.    |
| 409 `last_superadmin`                           | Grant another superadmin first.                                       |
