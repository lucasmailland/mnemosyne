# Dashboard end-to-end specs

Playwright specs that drive the dashboard in Chromium against a real stack:
server, migrate and dashboard images built from this checkout, with Postgres
and Redis, in the same topology as production
(`docker/docker-compose.e2e.yml`). Nothing is mocked.

## Running

```bash
# From the repo root: fresh stack → specs → teardown. Same command as CI.
pnpm test:e2e:dashboard

# Keep the stack up afterwards (to inspect it), or pass Playwright options:
pnpm test:e2e:dashboard -- --keep
pnpm test:e2e:dashboard -- --grep AUTH-03
```

Needs Docker with compose v2 and Playwright's Chromium
(`pnpm --filter @mnemo-ai/dashboard exec playwright install chromium`). The
dashboard is published on `127.0.0.1:${MNEMO_E2E_PORT:-3300}`. Reports land in
`packages/dashboard/playwright-report/`; traces and screenshots of failures in
`packages/dashboard/test-results/`.

## Rules for adding specs

- **Repeatable or it doesn't count.** A check that only happened once, by hand
  or by an agent driving a browser, is not verification. Write it here.
- **Fresh stack per run.** `global-setup.ts` refuses a bootstrapped stack:
  lockouts and rate-limit buckets from a previous run would change results.
  `global-teardown.ts` deletes the signed-in session files (`.admin-session.json`
  and the others) that the gate specs keep for the run.
- **One account per concern** (`ACCOUNTS` in `support.ts`). A spec that locks an
  account or changes a password owns that account alone.
- **Mind the rate-limit budget.** Every login, password change and public link
  request counts against one shared IP bucket. The e2e stack sets
  `MNEMO_DASHBOARD_LOGIN_IP_BURST=300` (production default: 30 per 15 minutes),
  so the IP bucket is no constraint here. The per-email bucket (10 per 15
  minutes, not configurable) is: count the sign-ins an account makes in total
  across specs, and keep each account under 10. `admin` signs in about 8 times
  per run (members, invitation, superadmin, installation, offboarding): share
  one signed-in session across the tests of a spec (`describe.serial` with a
  `beforeAll` context) rather than signing in per test.
- **Provision like an operator.** Accounts are created with the production
  admin script inside the server container; only what the script deliberately
  cannot do (a second membership) goes through SQL.
- **Name tests by contract ID** from `openspec/dashboard/login-failure-modes.md`
  when one applies.

## Coverage

| Spec                      | Contract                                                                   |
| ------------------------- | -------------------------------------------------------------------------- |
| `email-login.spec.ts`     | AUTH-01 login, role and workspace in the sidebar; normalized email         |
|                           | AUTH-02 identical, focused error for wrong password and unknown email      |
|                           | AUTH-03 lockout after five failures, still a generic 401                   |
|                           | AUTH-05 workspace choice before any session cookie; last one preselected   |
|                           | AUTH-14 read-only member: viewer role, stats explained                     |
|                           | API key login still works; My account explains it; logout ends the session |
| `account.spec.ts`         | AUTH-08/16 password change: server and policy errors, success, re-login    |
| `members.spec.ts`         | Members page: emails and roles, role change, the only owner gets an        |
|                           | explanation (server still 409), viewer does not see it, mobile layout      |
| `own-workspaces.spec.ts`  | Any user creates a team workspace they own and lands in it; switching;     |
|                           | the per-user limit (Installation > Settings) stops the next one            |
| `workspace-model.spec.ts` | Personal workspace: Owner badge, Members explains instead of invites;      |
|                           | model read-only and 403 for owners by default; superadmin edits; the       |
|                           | Installation switch lets owners edit, never a non-public base URL          |
| `invitation.spec.ts`      | Invitation link: new account joins, single use, existing account signs in  |
|                           | then accepts (workspace selector), revoke, no referrer                     |
| `installation.spec.ts`    | Installation section: superadmin-only (404 otherwise), grant/revoke with   |
|                           | password re-entry, last superadmin, audit filters and pages, settings      |
|                           | sources, create-user and reset links, open a workspace read-only           |
|                           | All workspaces: a superadmin adds an owner to an ownerless workspace (and  |
|                           | gets reasons for a duplicate or unknown email), none on a personal one;    |
|                           | the new owner can invite; pages fill a wide window                         |
| `offboarding.spec.ts`     | Disable ends open sessions; offboarding asks for a new owner, then sign-in |
|                           | and the API token are refused                                              |
| `keys.spec.ts`            | API Keys lists every live key with its scopes; rotate shows the new key    |
|                           | once and keeps the old one until its sunset; revoke ends it at once        |
| `mobile.spec.ts`          | AUTH-15 disclosure menu, Escape returns focus, no horizontal overflow      |
| `palace.spec.ts`          | The five memory rooms with seeded data, en-US and es-419: atrium story,    |
|                           | ledger and conflict card; catalog clocks and provenance of a superseded    |
|                           | fact; recall pipeline and "why"; columbarium niche; constellation keyboard |
|                           | (metered calls counted on the wire); a conflict the spec writes is settled |
|                           | and announced, then the archive state is drawn and byte-measured           |
|                           | `seed.ts` writes that data into the E2E Team workspace in `global-setup`;  |
|                           | `layout` and `a11y` also measure each room in its data states, and Home,   |
|                           | Browser, Sessions and Graph empty (`plain`'s workspace, which holds none)  |
