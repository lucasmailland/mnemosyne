# Dashboard email login: implementation and verification

Implementation date: 2026-10-21. No commits, pushes, deployments or task-orchestrator
state changes. No environment/credential files were read. Dependencies were copied
from the existing local checkout into this worktree; no dependencies or lockfile
changes were introduced. Validation runtime: Node 24.19.0, local pnpm 11.2.2.

## Files and design

- `spec.md` and `login-failure-modes.md`: login contract, failure catalog and non-goals.
- `packages/adapter-postgres/migrations/baseline/0049_dashboard_user_credentials.sql`:
  separate credential table, own-user ENABLE/FORCE RLS, grants, and a narrow
  SECURITY DEFINER email bootstrap lookup with fixed search path, no PUBLIC execute,
  duplicate-case rejection and credential row locking.
- `packages/server/src/dashboard-password.ts`: transactional credential store,
  bcrypt cost 12, dummy comparison for unknown users, persistent five-failure
  lockout for 15 minutes, password policy, Redis token buckets with bounded memory
  fallback, and canonical `WORKSPACE_ROLE_SCOPES` (no tenant-plane authority).
- `packages/server/src/routes/dashboard-auth.ts`: email/API key login, isolated
  five-minute workspace-selection cookie, current membership/password-version
  revalidation, current-password change, generic failures, no-store responses,
  JSON/body limits and structured audit events. Anonymous auth events go to the
  server logger as `dashboard.password_auth`; no workspace is invented to insert
  anonymous failures into a workspace audit table. Events omit passwords, hashes,
  JWTs, API keys, raw email and underlying database errors.
- `dashboard-session.ts`, `auth.ts`, `deps.ts`, `provenance.ts` and
  `routes/dashboard-api.ts`: reuse the eight-hour cookie/JWT and identify password
  sessions as `user:<id>`, preserving legacy API key identity behavior.
- `packages/server/scripts/dashboard-password.mjs`, `package.json` and
  `tsup.config.ts`: packaged administrative script and built shared password module.
  The script reads stdin, rejects password arguments, and can provision a test user
  through the existing RLS-aware provisioning function. It sanitizes DB failures.
- `packages/dashboard/app/login/page.tsx`: email/password first, secondary API key
  access, workspace selector, labels, live errors and focus management.
- `packages/dashboard/app/(dashboard)/account/`: account page and password form;
  `components/sidebar.tsx` and `lib/server-api.ts`: navigation and session metadata.
- Tests: server `unit/dashboard-password.test.ts`, `unit/dashboard-auth.test.ts`,
  `unit/dashboard-user-provenance.test.ts`; adapter-postgres
  `dashboard-credential-migration.test.ts`; dashboard login and account tests;
  server `integration/dashboard-password.integration.test.ts`.

New passwords require at least 12 Unicode characters and at most 72 UTF-8 bytes;
normalized email cannot be the password. Timing tests verify equal cryptographic
work (one cost-12 comparison) and identical failure responses, not exact elapsed
milliseconds. SQL and scheduler timing remain variable. Account lockout is in
Postgres and serializes failures with row locks. IP/mail buckets allow bursts of
30/10 and refill over 15 minutes. Password changes share the IP bucket and use a
user-specific account bucket. Memory fallback is per process; Redis shares limits
across replicas. Proxies must overwrite forwarded client-IP headers.

No email sending, signup, recovery, OAuth, MFA or global session revocation was
added. Existing sessions expire after eight hours; password changes invalidate
pending workspace selections. Selection JWTs can be retried until their five-minute
expiry. Argon2 remains a future option; bcrypt uses the existing dependency.

## Verification

Tests were written before the corresponding implementation. The initial pnpm
launcher tried to download its pinned version and later tried to auto-install
dependencies. Local execution uses the existing pnpm with these offline-safe flags
on each command (the lockfile is unchanged):

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false <command>
```

Results:

- Server auth/session/provenance tests: **52 passed** across three files.
- Dashboard package tests: **11 passed**, three files (login, workspace selector,
  password change, accessible errors, existing server API tests).
- Migration safety + baseline sequence: **31 passed**; the new migration also
  passes `lintMigration` and the CLI without any per-file exemptions.
- `pnpm lint:migrations`: **59 files, all checks passed**.
- Server and dashboard typecheck: **exit 0**.
- Server and its workspace dependency builds: **exit 0**, including declarations.
- Admin script syntax check and weak-password stdin rejection: **passed**.
- Complete server suite: **2431 passed, 8 failed, 23 skipped**; three files fail
  because the sandbox forbids listening on `127.0.0.1` (`listen EPERM`). Eight gRPC
  message-cap cases fail; `pool-stall-watchdog` and `redis-clients-failfast` fail in
  setup, leaving their 22 cases unexecuted. These files were not modified.
- Remaining server suite, excluding only those three files: **2431 passed,
  1 previously skipped**, across 299 passing files (300 including the skipped file).
  The command adds `--exclude '**/grpc-read-max-bytes.test.ts'`,
  `--exclude '**/redis-clients-failfast.test.ts'`, and
  `--exclude '**/pool-stall-watchdog.test.ts'`.
- `git diff --check`: **passed**; authored text files end in a newline.

Commands run include the requested server/dashboard tests, both package typechecks,
server dependency build, migration lint and targeted migration/sequence tests.
The complete server suite was also retried with `--maxWorkers=2`; socket permission
failures remain. No test expectations were weakened to mask those failures.

## Create a test user and set its password

Use an already configured database, with `DATABASE_URL` securely supplied in the
operator's environment. Apply migration 0049 before provisioning credentials. No
command loads a dotenv file or accepts a database URL/password as an argument.

```sh
pnpm --filter @mnemo-ai/server... build
pnpm --filter @mnemo-ai/adapter-postgres migrate
python3 -c 'import getpass; print(getpass.getpass("Password: "))' | node packages/server/scripts/dashboard-password.mjs --email prueba@example.test --create
```

`--create` creates a personal tenant and an owned workspace for a new user, so it
can log in immediately. For an existing user, omit `--create` to set/reset its
password. Optional `--create --workspace <id>` adds a read membership to that
existing workspace only when provisioning a new user; existing memberships are
never broadened. As of the 2026-10-22 fix, this option creates no Personal workspace:
the personal tenant remains for the account model, with only the target workspace
in the login membership list. Without `--workspace`, `--create` still creates Personal.
The terminal prompt hides the password; the password travels only through stdin.

## Postgres integration: coordinator command

Updated and attempted on 2026-10-22; blocked before any case ran because the
sandbox cannot access Docker (no working container runtime strategy). Requires
Node >=22, Docker, a cached pgvector image, and freshly built workspace dependencies:

```sh
pnpm --filter @mnemo-ai/server test:integration src/__tests__/integration/dashboard-password.integration.test.ts
```

The nine real-Postgres cases now share the same raw client mutated by
`drizzle(client)`, matching the server. They cover NOSUPERUSER login and workspace
name metadata, FORCE RLS and PUBLIC execute denial, the fifth failure through HTTP
(generic 401 during lock, correct and wrong passwords), expiry, counter reset after
success, concurrent failures, membership selection, password replacement,
duplicate-case rejection, and stdin provisioning with/without `--workspace`.
Independent review and execution with Docker remain with the reviewing agent.

## Real-server lockout and UX fix (2026-10-22)

No commits, process shutdowns, orchestrator state changes, network fetches, or
credential-file reads. Node 20.20.2 + the cached pnpm 9.15.0 were used for unit
tests/typechecks, Node 22.23.1 for the integration attempt. The global pnpm 11
launcher was interrupted while trying to select another package manager; use the
locally installed Node 20 pnpm binary instead of downloading anything.

Changes:

- `PostgresCredentialStore` writes `locked_until` as ISO text, normalizes timestamp
  reads for both email/user lookups, and leaves server-generated dates in SQL.
- AUTH-13 offline regressions use a real `postgres()` client and `drizzle(client)`
  codecs with simulated row I/O (no database connection). Before the fix, two
  tests failed with the exact Date serialization and string `.getTime()` errors
  from the supplied report; both pass after the fix. The third verifies generic
  HTTP 401 during lock and successful reset after expiry.
- AUTH-14 Home checks `memory:admin` before requesting `/admin/stats`; readers
  receive role context and retain recent activity. Admin load failures have a
  separate message.
- AUTH-15 English labels, tighter login spacing, a shared solid/disabled button
  style, account identity and roles in the selector (ids only to disambiguate
  duplicate names), expiry guidance, and workspace name metadata in the sidebar.
  Below `md`, navigation is an in-flow disclosure menu rather than a fixed column;
  Escape restores focus and following a link closes it. No overlay/focus trap.
- AUTH-16 My account clears stale feedback on editing and validates Unicode
  character/UTF-8 byte limits in the form before requesting a password change.
- AUTH-17 `--create --workspace` creates only the requested workspace membership.
  Integration tests check both this case and the default Personal behavior.

Browser verification could not start: ego-browser failed to launch under the
sandbox (`com.apple.hiservices-xpcservice` connection invalid). No screenshots
were captured and no browser task remains active. The existing server/dashboard
on 3941/3951 were left running.

Browser handoff (after ensuring the running server loads the revised code):

1. At 390 px, verify full-width Home/My account content, Menu open/closed, Escape,
   tab order, navigation and logout. Repeat at 1440 px in light and dark themes;
   check wordmark/button contrast, spacing and absence of horizontal overflow.
2. Reader Home should explain admin-only stats and keep activity; admin Home
   should show metrics. Sidebar should show the selected workspace name for
   password and API key sessions.
3. Selector should show the signed-in account, Owner/Admin/Contributor/Viewer,
   distinguish duplicate names, explain expiry and recover from a rejected choice.
4. Wrong current password, edit to a short password, submit: only the new policy
   error should appear. Valid change should clear fields and show success.
5. On a synthetic account, confirm fifth-failure lockout, correct-password denial
   during lock (401, never 503), and success after expiry. The Docker test covers
   the DB contract; this browser pass validates deployment and user-visible flow.

Final results for the 2026-10-22 revision:

| Check                                                                               | Result                                                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Server full unit suite (requested command, then JSON reporter to identify failures) | 301 files passed, 3 failed; 2436 tests passed, 8 failed, 22 skipped                 |
| Login store/route regressions                                                       | 27 passed across 2 files, including 3 offline Drizzle cases                         |
| Dashboard `pnpm --filter @mnemo-ai/dashboard test`                                  | 18 passed across 5 files                                                            |
| Server `pnpm --filter @mnemo-ai/server typecheck`                                   | passed                                                                              |
| Dashboard `pnpm --filter @mnemo-ai/dashboard typecheck`                             | passed                                                                              |
| Real Postgres login integration, Node 22                                            | blocked at container setup; all 9 cases unexecuted                                  |
| Browser                                                                             | blocked at application launch; checklist above remains for independent verification |
| `git diff --check`                                                                  | passed after removing codegen-only side effects                                     |

The full server failures are `grpc-read-max-bytes.test.ts` (8 socket-dependent
cases), `pool-stall-watchdog.test.ts` and `redis-clients-failfast.test.ts` (setup).
The default reporter recorded `listen EPERM` on 127.0.0.1; these are the same
sandbox limitations recorded in the earlier validation. No assertions were
weakened or tests excluded from the requested run. The JSON reporter retry
identifies the three failed files. The gRPC codegen test regenerates
`src/gen/mnemosyne_pb.ts`; its formatting-only output was restored to its initially
clean tracked content, preserving unrelated user edits elsewhere.

## Browser verification automated (2026-11-02)

The browser handoff above is now a repeatable Playwright suite,
`packages/dashboard/e2e/` (`pnpm test:e2e:dashboard`, CI job `e2e-dashboard`),
run against images built from the checkout with Postgres and Redis. It covers
items 2–5 and the mobile menu, focus return and overflow of item 1; theme
contrast and tab order across the whole page remain manual. Two consecutive
runs on fresh stacks: 10/10 passed each.

Found while automating it: the server image did not ship
`scripts/dashboard-password.mjs`, so the documented `docker compose exec server`
provisioning could not run in a container. `docker/Dockerfile.server` now copies
it next to `docker/scripts`; the e2e setup provisions every account through it.
