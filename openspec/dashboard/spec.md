# Mnemosyne Dashboard — OpenSpec

> Status: DRAFT — branch `feat/ui-dashboard-research`
> Last updated: 2026-07-06
> Prerequisite reading: `docs/research/ENGRAM_GAP_ANALYSIS.md`

---

## 0. Motivation

Mnemosyne has no web UI today. Every interaction goes through MCP tools or the `mnemo` CLI (alpha). This spec defines the first version of a web dashboard with three goals:

1. **Observability** — see what's stored in memory, how recall is performing, and what the health of the system looks like.
2. **Configuration** — change LLM provider, workspace mode, manage API keys — without editing env vars or running SQL.
3. **Functional power** — run recall queries interactively, explore the relation graph, inspect episode collapses.

The design is deliberately **not a clone of Engram**. Mnemosyne's richer type system (10 primitives vs. 1), bitemporal model, 7-stage recall pipeline, and sensitivity tiers deserve a UI that exposes and celebrates those features.

---

## 1. Tech Stack Decision

### 1.1 Where the dashboard lives

**Decision: `packages/dashboard` — standalone Next.js 15 app, proxied by the server in production.**

Rationale:

- The server is Hono on Node — no server-side templating engine. Adding HTMX templates would require a new dependency and violate the package boundary model.
- Next.js 15 (app dir) gives us RSC (React Server Components) for data-heavy pages with no client JS overhead, plus incremental client enhancement where needed.
- In development: `packages/dashboard` runs on port 3000, hitting the server at port 3939 directly (CORS allowed on localhost).
- In production: the server mounts a static export or reverse-proxy the Next.js app at `/dashboard`. Docker Compose adds an nginx layer for this.
- The dashboard depends on `@mnemosyne/client-ts` (typed SDK) and `@mnemosyne/types` (domain types). No direct DB access.

### 1.2 Component stack

| Layer        | Choice                       | Reason                                      |
| ------------ | ---------------------------- | ------------------------------------------- |
| Framework    | Next.js 15 (app dir)         | RSC + Server Actions; TypeScript native     |
| Styling      | Tailwind CSS v4              | Utility-first, v4 has CSS variables native  |
| Components   | shadcn/ui (Radix + Tailwind) | Accessible, unstyled primitives, copy-paste |
| Icons        | Lucide React                 | Tree-shakeable, consistent                  |
| Charts       | Recharts                     | React-native, no canvas dependency          |
| Session auth | `jose` (HS256 JWT)           | Battle-tested, edge-runtime compatible      |
| HTTP client  | `@mnemosyne/client-ts`       | Typed, already exists                       |
| Forms        | React Hook Form + Zod        | Validation shared with server schemas       |

### 1.3 Design tokens

Dark mode first. Cognitive/memory domain aesthetic — deep, precise, technical.

```css
/* Palette — cognitive dark */
--color-base: #0f0f1a; /* near-black indigo */
--color-surface: #16172a; /* panel background */
--color-surface-2: #1e2040; /* card / raised surface */
--color-border: #2a2d4a; /* subtle separator */
--color-text: #e2e4f0; /* primary text */
--color-text-muted: #7b7fa8; /* secondary text, timestamps */
--color-accent: #6366f1; /* indigo — primary action */
--color-accent-hover: #7c7ff5;
--color-gold: #f0b429; /* amber — active/pinned memories */
--color-green: #34d399; /* emerald — success, live facts */
--color-red: #f87171; /* rose — conflicts, errors */
--color-yellow: #fbbf24; /* warn, deprecated */
--color-purple: #a78bfa; /* episodes, reasoning */
--color-teal: #2dd4bf; /* entities, relations */
```

Typography: Geist Sans (UI), Geist Mono (IDs, code, timestamps, sensitivity labels).

---

## 2. Authentication Design

### 2.1 Current server capabilities (verified)

The server already has:

- `mnemo_api_keys` table with full schema (id, workspace_id, key_hash, lookup_hash, scopes[], plan, key_type, key_kind, expires_at, revoked_at, ip_allowlist[])
- `POST /admin/keys` — create key (requires `admin:keys` scope)
- `GET /admin/keys` — list all keys for workspace
- `DELETE /admin/keys/:keyId` — revoke key
- `GET /me` — key introspection (scopes, plan, expiry, workspace)
- `GET /bootstrap/status` — is the workspace bootstrapped?
- `POST /bootstrap` — create first key + workspace (unauthenticated, 403 after first use)

### 2.2 Dashboard login with email and password

`POST /dashboard/auth/login` accepts exactly one of `{email, password}` or
`{apiKey}`. Email is trimmed and lowercased; existing ambiguous case variants
fail closed. Password login is the primary UI; API key access remains secondary.
No signup, outgoing email, password recovery, OAuth or MFA is included.

Credentials live in `mnemosyne.mnemo_user_credential` (migration 0049), separate
from `mnemo_user`: user_id PK/FK, password_hash, password_updated_at,
failed_attempts, locked_until, created_at. bcrypt cost 12 uses existing dependencies.
New passwords require at least 12 characters, at most 72 UTF-8 bytes (bcrypt's
limit), and must differ from the normalized email. Never accept passwords via
command-line arguments or log them. Argon2 can be considered in a future migration.

All credential access runs in explicit transactions with SET LOCAL ROLE app_user
and local actor GUCs. Before identity is known, a narrow SECURITY DEFINER function
looks up one normalized email and locks its credential row. PUBLIC cannot execute
it. Its fixed search_path and explicit columns are the auth-bootstrap boundary;
there is no anonymous table policy. Own-user RLS covers subsequent reads/writes.
Membership queries set the user GUC and explicitly filter user_id, across tenants.

Unknown email, bad password, locked user and no workspace membership return the
same 401 `{error: "invalid_credentials", message: "Invalid email or password."}`.
Each performs exactly one bcrypt comparison at cost 12, using a dummy hash for
missing credentials; response equality and equivalent cryptographic work are the
contract, not exact wall-clock equality (SQL/scheduler variance remains).
bcrypt never runs inside a transaction: a short transaction reads the credential,
the comparison (and, for a change, the new hash) runs with no lock or pooled
connection held, and a second short transaction re-reads the row under its lock
and records the result. Holding the lock across bcrypt would queue concurrent
attempts on an existing account only (staggered responses reveal it exists) and
let a login burst pin the connection pool. Both transactions run whether or not
the account exists. A password replaced between the two denies without counting.
Credential row locks serialize recording concurrent failures and password changes.
Five failures lock the account for 15 minutes; failures after expiry start a new
count. Success resets the counter. Rate limits precede bcrypt: independent token
buckets per IP (30 attempts / 15 minutes) and normalized email (10 / 15 minutes).
Password changes share the IP bucket and use a per-user bucket instead of the email
one (the session carries the user, not the email); the account lockout is shared
with login. Redis uses the existing rate-limit backend when healthy;
a bounded, continuously maintained in-memory fallback applies otherwise. Proxies
must overwrite the client-IP headers before forwarding requests (the Next.js
rewrite keeps an incoming X-Forwarded-For, so the edge proxy in front of the
dashboard is the one that must set it). Unexpected failures log only a SQLSTATE or
error class (`errorCode`), never the message. Exhaustion is
429 with Retry-After, regardless of account existence. Audit structured events
record success/failure/reason and a SHA-256 email identifier, never passwords,
hashes, cookies, JWTs, API keys or raw email. Storage failure is a generic 503.

### 2.3 Workspace selection and account management

One membership creates the existing 8-hour HS256 JWT / HttpOnly Secure SameSite=Lax
cookie at Path=/dashboard. Password sessions always carry userId, a bare user
actorId and authMethod=password; provenance resolves them as user:<id>.
Role/scopes come from workspace membership, never tenant membership, and are
re-read from the database on every request (see "Live session checks" below), not
trusted from the JWT:
owner/admin → admin, write → contributor, read → viewer. Scopes come from the
canonical `WORKSPACE_ROLE_SCOPES` in `@mnemo-ai/types`, including the entity and
session scopes needed by the dashboard and excluding tenant-plane authority.
The plan defaults conservatively to free. Existing API key sessions remain valid.

Multiple memberships return 200 `{requiresWorkspace: true, email, workspaces: [{id,name,role}]}`
and a distinct HttpOnly selection cookie (5-minute JWT, purpose-bound, userId and
password version). It grants no dashboard API access. The browser submits
`POST /dashboard/auth/workspace {workspaceId}`; the server verifies the selection
cookie, password version, and current membership before issuing a full session.
A removed or foreign membership fails with 401. The selection cookie is cleared
on completion/logout. It may be retried until expiry; password updates invalidate
outstanding selections. Workspace names/ids are exposed only after valid password.

`POST /dashboard/auth/password {currentPassword, newPassword}` requires a password
session and the current password, shares login limits/lockout, enforces the policy,
and updates the hash and timestamp atomically. It does not mint API keys. Existing
sessions end by `sessions_valid_after` (see "Live session checks"): a password change ends every older session and re-mints the caller's own.
`GET /dashboard/auth/session` includes userId, authMethod and workspaceName for
account UI and sidebar orientation. Metadata is read in a tenant-scoped transaction;
if unavailable, the sidebar uses “Workspace” without exposing the workspace id.
Login and My account use labels, aria-live errors and focus management; password
values and selection cookies are never persisted in browser storage.

#### Live session checks (accounts stage A)

The 8-hour JWT is a carrier, not the authority. On every dashboard API request the
bridge (`resolveLiveSession`) reads from the database, through a per-process cache of
15 seconds that every write busts: whether the user is disabled, `sessions_valid_after`
against the token's `iat` (an older token is rejected), the user's current role in the
session workspace (a removed member loses access on the next request; a demoted one
gets the narrower scopes) and whether the user is a superadmin right now. Disable,
offboard, password change or reset and superadmin revocation move `sessions_valid_after`
forward. The epoch compares database and application clocks, so hosts must run NTP.
Signing out (`POST /dashboard/auth/logout`) ends that session on the server, not only
in the browser: every token carries a random signed `jti`, the SHA-256 of that jti goes
into `mnemo_dashboard_session_revocation` (migration 0059) for the session TTL plus an hour, and
the live check refuses it on the next request, uncached (API-key sessions included, one
small query each when a database is wired; without a database there is nothing to revoke
and sign-out only clears the cookie). A token re-issued over a live session of the same
user (a workspace switch, a superadmin "open", a workspace create, an invitation accepted
while signed in) keeps that session's jti, so one sign-out ends every token the browser
held; a sign-in, a new account or a password reset starts a new session. Deploy the
migration and then every replica: during a mixed rollout an old replica neither mints a
jti nor checks revocation. The key is the verified jti,
never the token string (one signature has several base64url spellings). A token without
a jti is refused, so sessions from before this change sign in again once. The user's other
sessions stay. A sign-out whose revocation cannot be stored still clears the cookie and
answers 503.
Disabling a user also refuses their user-bound API keys and `uk_live_*` tokens on HTTP,
gRPC, the WebSocket upgrade and `/health/deep`; already-open WebSockets and long gRPC
streams are not cut (known limitation). Login with several workspaces preselects the
one used last (`mnemo_last_workspace` cookie). `MNEMO_DASHBOARD_LOGIN_IP_BURST`
(default 30 per 15 minutes) sizes the per-IP bucket shared by sign-in and the public
link endpoints.

#### Superadmin, instance plane and links (accounts stage A)

A superadmin (`mnemo_instance_admin`, migrations 0050-0055) is an installation-wide
role. `/instance/*` routes sit on the cookie bridge only, accept only a password
session of a current superadmin and answer 404 to anyone else. Granting and revoking
superadmin re-ask the caller's password; the last superadmin cannot be revoked,
disabled or offboarded. A superadmin can open any workspace read-only (testing period;
the opening is audited as `workspace_opened`). Single-use links (invitation and account
setup 7 days, password reset 30 minutes; SHA-256 stored, shown once) are public under
`/dashboard/auth/link/:token`. Registration is always closed and no email is sent
(stage B). Operator procedures: `docs/guides/ACCOUNTS.md`; design:
`docs/archive/superpowers/specs/2026-11-03-accounts-and-team-design.md`.

The administrative server script `scripts/dashboard-password.mjs --email <mail>`
reads the password from stdin. Optional `--create` provisions a
test user with a personal tenant and owned workspace through the existing helper.
With `--create --workspace <id>`, the account keeps a personal tenant but receives
only a read membership in the specified workspace; no Personal workspace is created.
The target membership is added within a scoped tenant transaction; existing users
gain no new membership. Run migrations first.
`--superadmin` also grants superadmin after setting the password. It needs
`MNEMO_ADMIN_DATABASE_URL` (the migration owner or superuser URL, which bypasses RLS on
`mnemo_instance_admin`), passed only at run time and never stored in the server's
environment. Its grants are not written to the dashboard audit log (hash-chained); the
operator's shell history is the record.

### 2.4 Bootstrap flow (first time)

```
GET /dashboard/login
  → Dashboard calls GET /bootstrap/status
  → If bootstrapped: false → redirect to /dashboard/setup
  → If bootstrapped: true → show normal login form

GET /dashboard/setup
  → Form: workspaceId (UUID, pre-generated client-side) + apiKey (user-chosen, must match pattern mk_live_*)
  → POST /bootstrap → 201 → store key (shown once, copy prompt) → redirect to /dashboard/login
  → If /bootstrap returns 403 → workspace already configured → redirect to /dashboard/login
```

The first-run `POST /bootstrap` also accepts `adminEmail` and `adminPassword` (both or
neither) and creates that user as the first superadmin, audited as `user_created` and
`superadmin_granted` (actor `system:bootstrap`).

### 2.5 Role mapping for UI

The dashboard derives display role from the session scopes:

| Scopes present                | Display role    | Can see                                       |
| ----------------------------- | --------------- | --------------------------------------------- |
| `admin:keys` + `memory:admin` | **Admin**       | All pages including Admin section             |
| `memory:write`                | **Contributor** | Browser, Recall, Sessions, Config (read-only) |
| `memory:read` only            | **Viewer**      | Browser (read-only), Recall                   |

---

## 3. Information Architecture

### 3.1 Navigation structure

```
/dashboard
├── /                     → Home (metric strip + activity)
├── /browser              → Memory Browser (all primitives)
│   ├── /browser/facts
│   ├── /browser/decisions
│   ├── /browser/episodes
│   ├── /browser/entities
│   └── /browser/[type]   → strategies, workflows, skills, tasks, events, reasoning
├── /recall               → Recall Playground
├── /sessions             → Episode Browser
│   └── /sessions/[id]    → Episode Detail
├── /relations            → Relation Graph (vis)
├── /config               → Workspace Config (LLM, mode, workspace info)
└── /admin                → Admin section (Admin role only)
    ├── /admin/keys        → API Key Management
    ├── /admin/health      → System Health
    ├── /admin/members     → Workspace Members
    └── /admin/audit       → Audit Log
```

### 3.2 Global shell

Every authenticated page is wrapped in the shell:

```
┌─────────────────────────────────────────────────────────┐
│  ◉ MNEMOSYNE   [workspace: ws_abc... ▾]    [role: Admin] │
├──────────┬──────────────────────────────────────────────┤
│  Home    │                                              │
│  Browser │                                              │
│  Recall  │         <page content>                       │
│  Sessions│                                              │
│  Graph   │                                              │
│  Config  │                                              │
│  ─────   │                                              │
│  Admin ▾ │                                              │
│   Keys   │                                              │
│   Health │                                              │
│   Members│                                              │
│   Audit  │                                              │
│          │                                              │
│  ─────   │                                              │
│  [Logout]│                                              │
└──────────┴──────────────────────────────────────────────┘
```

- Workspace switcher (top): if the API key has access to multiple workspaces, shows a dropdown. If single workspace, shows as static label.
- Role badge: "Admin" / "Contributor" / "Viewer" derived from scopes.
- Nav items hidden if role lacks access (Admin section not shown to Viewers/Contributors).

---

## 4. Page Specifications

### 4.1 Home

**Route:** `GET /dashboard`
**Data sources:** `GET /admin/stats`

**Layout:**

```
[Last updated: 2 min ago]

┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│  Facts  │ │Decisions│ │Episodes │ │Entities │
│  1,234  │ │   89    │ │   47    │ │  312    │
│live/closed│ │ active │ │complete │ │ all     │
└─────────┘ └─────────┘ └─────────┘ └─────────┘

┌─────────────────────┐ ┌───────────────────────┐
│ Recall Health       │ │ Embedding Coverage    │
│ Hit rate 30d: 78%   │ │ Indexed: 1,187 / 1,234│
│ Last recall: 3m ago │ │ Pending:  47 (3.8%)   │
└─────────────────────┘ └───────────────────────┘

Recent Activity (last 24h)
───────────────────────────────────────
● fact       "Pablo prefiere TypeScript strict mode"   2m ago
● decision   "Use event sourcing for audit log"        1h ago
● episode    Session #47 collapsed — 12 facts extracted  3h ago
```

**Interactions:**

- Each metric card links to the relevant browser filter.
- "Recent Activity" is a live-updating list (polling or SSE from a `GET /facts?order=created_at:desc&limit=20` call, unified across types).
- "Pending embeddings" shows a warning badge if > 5% are unindexed (recall quality degraded).

---

### 4.2 Memory Browser

**Route:** `GET /dashboard/browser`
**Data sources:** `GET /facts`, `GET /decisions`, `GET /entities`, `GET /episodes`, plus per-type routes for strategies/workflows/skills/tasks/events/reasoning.

**Layout:**

```
[Type: All ▾] [Sensitivity: All ▾] [Search: ________________] [Page: 1 of 47 < >]

┌──────────────────────────────────────────────────────────────────────┐
│ [fact] [preference]  "Pablo prefiere TypeScript strict mode"         │
│ internal · worth 0.85 · created 2026-07-01 · last recalled 3m ago   │
│ ─────────────────────────────────────────────────────────────────────│
│ [decision] [architecture]  "Use HNSW for vector search"             │
│ confidential · worth 0.92 · created 2026-06-15 · pinned 📌          │
└──────────────────────────────────────────────────────────────────────┘
```

**Filters (query params):**

- `type`: fact | decision | episode | entity | strategy | workflow | skill | task | event | reasoning | (all)
- `sensitivity`: public | internal | confidential | restricted | (all)
- `q`: full-text search string
- `pinned`: boolean
- `page`, `pageSize` (default 25)
- `order`: created_at:desc (default) | worth:desc | last_recalled:desc

**Memory card anatomy:**

```
┌─────────────────────────────────────────────────┐
│ [TYPE PILL] [KIND PILL]   [SENSITIVITY BADGE]   │
│                                                 │
│ Statement text (truncated at 120 chars)         │
│                                                 │
│ worth ████████░░ 0.82  · created Jul 1 · 📌    │
│ id: f_abc123...    [View →]  [Copy ID]          │
└─────────────────────────────────────────────────┘
```

**Type pill colors** (from the design tokens):

| Primitive               | Color           | Pill label           |
| ----------------------- | --------------- | -------------------- |
| fact / preference       | gold            | `fact:preference`    |
| fact / trait            | gold            | `fact:trait`         |
| fact / concern          | red             | `fact:concern`       |
| decision / architecture | accent (indigo) | `decision:arch`      |
| decision / bugfix       | red             | `decision:bugfix`    |
| decision / learning     | green           | `decision:learning`  |
| decision / discovery    | teal            | `decision:discovery` |
| episode                 | purple          | `episode`            |
| entity                  | teal            | `entity:person` etc. |
| strategy                | gold            | `strategy`           |
| workflow                | accent          | `workflow`           |
| skill                   | green           | `skill`              |
| task                    | yellow          | `task`               |
| event                   | muted           | `event`              |
| reasoning               | purple          | `reasoning`          |

**Detail drawer (slides in from right, no page nav):**

- Full statement text
- All metadata: id, created, validFrom/validTo, worth, sensitivity, source, scopeRef
- If `validTo` is set → shows "CLOSED" banner with the date (bitemporal)
- Related primitives (from `GET /relations?sourceId=X`)
- "Edit statement" (opens inline editor, POST to `/facts/:id` etc.)
- "Pin / Unpin" toggle
- "Close validity" (soft forget, sets validTo)

---

### 4.3 Recall Playground

**Route:** `GET /dashboard/recall`
**Data sources:** `POST /recall` (new `?debug=true` mode to be added — see task #9)

This is the most powerful differentiator vs. Engram. Exposes the 7-stage pipeline visually.

**Layout:**

```
Query: [_________________________________________________] [↵ Recall]
Options: [Limit: 10 ▾] [Sensitivity ceiling: all ▾] [Mode: cold ▾]

── Pipeline Trace ──────────────────────────────────────────────────
Stage 1  Parse + embed        →  query vector computed    12ms
Stage 2  HNSW vector search   →  50 candidates           8ms
Stage 3  Relation expansion   →  +12 related hits        5ms
Stage 4  ACT-R activation     →  scored (log decay)      2ms
Stage 5  Worth weighting      →  score = ACT-R × worth   1ms
Stage 6  Sensitivity ceiling  →  2 filtered (restricted) 0ms
Stage 7  Assemble hits        →  final 10 results        1ms

Total: 29ms

── Results ─────────────────────────────────────────────────────────
#1  score 0.94  ACT-R 1.82  worth 0.92
    [decision:architecture] "Use HNSW for vector search"
    Recalled 3 times · last: 3m ago · confidential

#2  score 0.87  ACT-R 1.71  worth 0.85
    [fact:preference] "Pablo prefiere TypeScript strict mode"
    Recalled 7 times · last: 1h ago · internal
```

**Debug mode behavior:**

- Stage trace is only shown when `debug=true` is passed to the server (needs implementation — task #9)
- Without debug: shows results only (same as current recall)
- Stage 6 shows how many items were filtered by sensitivity — important for diagnosing recall gaps

**SSE streaming option:**

- Toggle "Stream results" — sends each stage result as an SSE event
- Stage boxes light up one by one as the server processes them
- High-value UX differentiator — makes the pipeline feel alive

---

### 4.4 Session Browser (Episodes)

**Route:** `GET /dashboard/sessions`
**Data sources:** `GET /episodes` (paginated list), `GET /episodes/:id` (detail)

**List view:**

```
[Search: ______________]  [Status: All ▾]  [Page: 1 of 12 < >]

┌─────────────────────────────────────────────────────────────┐
│ #47  Started Jul 6 14:30 · Duration 23m · 12 facts extracted│
│ Collapsed ✓ · scopeRef: mnemosyne                           │
├─────────────────────────────────────────────────────────────┤
│ #46  Started Jul 6 11:00 · Duration 8m  · 3 facts extracted │
│ Collapsed ✓ · scopeRef: acme                              │
├─────────────────────────────────────────────────────────────┤
│ #45  Started Jul 5 22:00 · In progress ●                    │
│ Not yet collapsed · turns: 14                               │
└─────────────────────────────────────────────────────────────┘
```

**Detail view (`/dashboard/sessions/:id`):**

- Session metadata: id, start/end, scopeRef, turns count, collapse status
- Extracted facts list (facts whose `episodeId = this session`)
- Collapse summary (if collapsed): what the LLM extracted
- "Trigger collapse" button (if session is open — calls `POST /session/:id/collapse`)
- "Discard session" button (calls `POST /session/:id/discard`)

---

### 4.5 Relation Graph

**Route:** `GET /dashboard/relations`
**Data sources:** `GET /graph`

**Layout:**

- Force-directed graph (using `react-force-graph` or `d3-force`)
- Nodes: colored by primitive type (same palette as type pills)
- Edges: labeled with relation verb (related, supersedes, conflicts_with, etc.)
- Click node → opens detail drawer (same as browser)
- Click edge → shows relation detail (confidence, created, reason)
- Filters: by type, by relation verb, by connected node
- Max nodes rendered: 200 (pagination for larger graphs)

**Why this page matters:** no other memory system shows you the graph of _how_ memories relate. This is pure Mnemosyne.

---

### 4.6 Workspace Config

**Route:** `GET /dashboard/config`
**Data sources:** `GET /config/llm`

**Sections:**

#### LLM Provider

```
Provider:    [OpenAI ▾]
Model:       [gpt-4o              ]
Embed model: [text-embedding-3-large]
API Key:     [••••••••••••••••ab12]  [Change] [Remove]
Temperature: [0.7    ]
Max tokens:  [4096   ]
Source: workspace  (overriding global config)

[Save changes]
```

**Key field behavior:**

- On load: shows masked key (`first8****`) if set, empty field if not
- "Change" button: shows a new text input for the new key — on submit, POSTs to `PUT /config/llm` with the new key
- "Remove" button: calls `DELETE /config/llm` (resets to global/env fallback)
- The key input field is `type="password"` — never shown in plain text after save
- If source is "env" or "global": shows read-only view with "Override for this workspace" button

#### Embedding warning

If embeddings exist and the provider is being changed, show an inline warning:

> "⚠ Changing the embedding model will invalidate existing vector indexes. Recall quality will degrade until re-indexing completes."

#### Workspace Mode

```
Mode: [Learning ▾]   (learning | production)
Session count: 47 collapses
Promote at: [100    ] collapses  [Save]

[Promote to Production manually]
```

Source: `GET /workspace-mode` (needs verification that this endpoint exists).

#### Workspace info (read-only)

```
Workspace ID:  ws_abc123...  [Copy]
Plan:          pro
Created:       2026-01-15
```

---

### 4.7 Admin — API Key Management

**Route:** `GET /dashboard/admin/keys`
**Data sources:** `GET /admin/keys`, `POST /admin/keys`, `DELETE /admin/keys/:keyId`

**List:**

```
[+ Create key]

┌─────────────────────────────────────────────────────────────────┐
│ Label: "Production MCP key"                                     │
│ mk_live_ab12cd34...  · scopes: memory:read memory:write         │
│ plan: pro · created Jul 1 · last used 3m ago · expires never    │
│ [Revoke]                                                         │
├─────────────────────────────────────────────────────────────────┤
│ Label: "Bootstrap key"   ⚠ No lookup_hash (O(n) auth path)     │
│ bootstrap_abc123...  · scopes: all                              │
│ created Jun 15 · never used                                     │
│ [Revoke]                                                         │
└─────────────────────────────────────────────────────────────────┘
```

**Create key dialog:**

```
Label:      [_________________________]
Scopes:     ☑ memory:read  ☑ memory:write  ☐ memory:delete
            ☐ memory:admin  ☐ admin:keys  ☐ admin:tenant
Plan:       [free ▾]
Expires:    [never ▾]  (never | 30d | 90d | 1y | custom)
IP Allowlist: [optional, one per line]

[Create]
```

**After creation — show-once dialog:**

```
┌─────────────────────────────────────────────────────┐
│  ✓ Key created                                      │
│                                                     │
│  mk_live_ab12cd34ef56gh78ij90kl12mn34op56qr78st90   │
│                                          [Copy]     │
│                                                     │
│  This key will not be shown again.                  │
│  Store it in a safe place before closing.           │
└─────────────────────────────────────────────────────┘
```

**⚠ Bootstrap key warning:** Keys with no `lookup_hash` (the bootstrap key is created without one) force O(n) bcrypt scan on every auth request. The UI should show a warning badge and a "Migrate to fast path" button (calls a new endpoint to backfill the lookup hash).

---

### 4.8 Admin — System Health

**Route:** `GET /dashboard/admin/health`
**Data sources:** `GET /doctor`, `GET /admin/stats`

**Layout:**

```
System Health            [Refresh]  [Run full check]

┌─────────────────────────────────────────────────────┐
│ ● Postgres           HEALTHY    ping: 2ms           │
│ ● Redis (cache)      HEALTHY    keys: 1,204         │
│ ● Vector index       HEALTHY    indexed: 1,187/1,234│
│ ● Recall pipeline    HEALTHY    last run: 3m ago    │
│ ● Consolidation      HEALTHY    last: 1h ago        │
│ ● Reminder evaluator HEALTHY    next poll: 28s      │
└─────────────────────────────────────────────────────┘

Memory Stats
┌────────┬──────────┬────────┬──────────┬───────────┐
│ Facts  │ Decisions│Episodes│ Entities │ Relations │
│  1,234 │    89    │   47   │   312    │   156     │
│live:1,180│active:82│complete:45│       │conflicts:3│
│closed:54 │         │in-prog:2│         │           │
└────────┴──────────┴────────┴──────────┴───────────┘
```

**Doctor checks surface:** each check from `GET /doctor` shown as a row with status badge (✓ ok / ⚠ warn / ✗ error) and message.

---

### 4.9 Admin — Workspace Members

**Route:** `GET /dashboard/admin/members`
**Data sources:** `GET /workspaces/:workspaceId/members`, `POST /workspaces/:workspaceId/members`, `DELETE /workspaces/:workspaceId/members/:userId`, `PATCH /workspaces/:workspaceId/members/:userId`

**Layout:**

```
[+ Invite member]

┌─────────────────────────────────────────────────────────────┐
│ pablo@example.com  · role: owner  · joined Jun 15           │
│ [Change role ▾]  [Remove]                                   │
├─────────────────────────────────────────────────────────────┤
│ agent@ci.example  · role: write   · joined Jul 1            │
│ [Change role ▾]  [Remove]                                   │
└─────────────────────────────────────────────────────────────┘
```

Role options: owner | admin | write | read (from `mnemo_workspace_member.role` CHECK constraint).

As built (accounts stage A): the list shows email, display name, role and joined date;
owners and admins invite (the link is shown once to copy), change roles, remove members
and manage pending invitations (regenerate, revoke) through `/workspace/members` and
`/workspace/invitations` on the cookie bridge. Admins cannot touch owners; the last
owner cannot be removed or demoted. Personal workspaces take no invitations. Superadmins
get a separate **Installation** group (Users, Workspaces, Settings, Security audit).

---

### 4.10 Admin — Audit Log

**Route:** `GET /dashboard/admin/audit`
**Data sources:** `GET /audit` (needs filter params — verify in audit.ts)

**Layout:**

```
[Filter: Actor _____] [Action ▾] [From: ______] [To: ______] [Apply]
[Share filtered URL]

┌─────────────────────────────────────────────────────────────┐
│ Jul 6 14:37  mk_live_ab12  DELETE  fact:f_abc123  ✓ ok     │
│ Jul 6 14:30  mk_live_ab12  POST    session:start  ✓ ok     │
│ Jul 6 11:00  mk_live_ab12  PUT     config:llm     ✓ ok     │
└─────────────────────────────────────────────────────────────┘
[< prev]  Page 1 of 8  [next >]
```

Deep-link support: filters embedded in URL params so a filtered view can be shared as a link.

---

## 5. Configurable from the UI (complete list)

These are ALL settings that the UI exposes for change:

### Per-workspace config (Config page)

- LLM provider (openai | google | cohere | mistral | voyage | ollama | bedrock)
- LLM model name
- Embedding model name
- LLM API key (write-only after save, shown masked)
- Temperature (0–2)
- Max tokens (1–32768)
- Embed dimensions (64–3072)
- Embed batch size (1–2048)
- Base URL (for Ollama / custom providers)
- Workspace mode (learning | production)
- Promote-at threshold (session count for auto-promotion to production)

### API keys (Admin > Keys)

- Create keys with label, scopes, plan, expiry, IP allowlist
- Revoke existing keys
- View key metadata (prefix, scopes, created, last used)

### Workspace members (Admin > Members)

- Invite member (by userId — user must exist)
- Change member role (owner | admin | write | read)
- Remove member

### What is NOT configurable from the UI (and why)

- `MNEMO_MASTER_KEY` — encryption root key, must never reach client
- `MNEMO_DASHBOARD_SECRET` — session signing secret, server-only
- Federation peers — complex enough to warrant CLI or API
- Postgres / Redis connection — infrastructure concern, not workspace config
- Rate limits, body limits — deployment concern

---

## 6. Functional Features (beyond CRUD)

Features that go beyond observability/configuration:

### 6.1 Recall Playground (§4.3)

Run queries against the live recall pipeline, see stage-by-stage trace, understand why a memory surfaced or was filtered. **Not in Engram.**

### 6.2 Trigger session collapse (§4.4)

From the Sessions page: manually trigger `POST /session/:id/collapse` for any open episode. Useful when an agent session was never properly closed.

### 6.3 Manual fact operations from browser

From any memory card in the browser:

- **Pin / Unpin** — calls `POST /facts/:id/pin`
- **Close validity (forget)** — soft-deletes by setting validTo, calls `DELETE /facts/:id`
- **Hard delete** (Admin only) — calls `DELETE /facts/:id/hard`
- **Edit statement** — inline edit, calls `PATCH /facts/:id`

### 6.4 Trigger consolidation

From Health page: "Run consolidation now" button — calls `POST /consolidation/trigger`. Shows dry-run option.

### 6.5 Export workspace

From Config page: "Export all memory" — calls `GET /export` → downloads JSONL. Shows warning about sensitivity.

### 6.6 Embedding re-index nudge

When pending embeddings > 5%, Home shows an action card: "47 memories not yet indexed. Recall quality may be degraded. [Learn more]". No manual trigger needed (background worker handles it), but the visibility is important.

### 6.7 Conflict surfacing

Admin > Audit or Browser: when a memory has `conflicts_with` relations, show a ⚡ badge. Click → opens both memories side by side with the relation reason and confidence. Option to "Judge" (call `POST /conflicts/:id/resolve`).

---

## 7. Open Questions (pending resolution)

### Q1 — Does `GET /workspace-mode` exist? ⚠ UNVERIFIED

The Config page needs `GET /workspace-mode` to read the current mode and session count. Must verify in `packages/server/src/routes/`. If it doesn't exist, a new endpoint is needed.

### Q2 — `GET /audit` has no filters ⚠ GAP FOUND

`audit.ts` confirmed: `GET /audit` only accepts `limit` (max 100). It also only surfaces `action: "forgotten"` entries — no create/update/key-management events. The audit log page as specced (actor, action, date range filters) requires either:

- Extending `GET /audit` with actor/from/to/action params and additional event sources
- Or scoping V1 audit to "forgotten memories only" and labeling it accordingly

**Decision needed:** what do we want to audit in V1? Recommend: forgotten facts + key creation/revocation (the two security-relevant events).

### Q3 — `GET /facts` sensitivity filter missing ⚠ GAP FOUND

Confirmed: `GET /facts` does NOT have a sensitivity filter today. The endpoint has: `kind`, `scope`, `scopeRef`, `status`, `pinned`, `q`, `sortBy`, `order`, `cursor`, `asOf`, `limit`.

**Action needed:** add `sensitivity` query param to `GET /facts` route before the Memory Browser can filter by sensitivity tier.

Other per-type endpoints (`/decisions`, `/entities`) also lack sensitivity filters — consistent gap.

### Q4 — `POST /recall` debug mode: NOT implemented

The Recall Playground needs per-stage trace output. Current `POST /recall` returns only `{ hits[], debug: { embedded, latencyMs, searchMode, tier } }` — no stage-by-stage breakdown. This requires new work on `recall-cold.ts` and a new response field. (Task #9.)

### Q5 — `GET /graph` response shape: UNVERIFIED

The Relation Graph needs nodes + edges with types. Must read `graph.ts` to understand what the endpoint returns today.

### Q6 — Workspace switcher: DEFERRED TO V2

If a user has API keys for multiple workspaces, switching requires re-authenticating with a different key. No clean way to resolve "all workspaces for this user" without a tenant-admin key. Workspace switcher deferred to V2 — V1 shows a single workspace per session.

### Q7 — SSE streaming recall: DEFERRED TO V2

`POST /recall` is synchronous today. Streaming would require server-sent events infrastructure and pipeline instrumentation simultaneously. Deferred — V1 Recall Playground is synchronous with a loading state.

---

## 8. Non-Goals for V1

- Mobile-responsive layout (desktop-first, mobile later)
- Multi-tenant admin (managing tenants and users across workspaces — that's a super-admin concern)
- Federation management UI (peer config, sync status across instances)
- Real-time collaborative editing
- Custom dashboard widgets / drag-and-drop layout
- Dark/light mode toggle (dark mode only for V1)

---

## 9. Implementation Sequence

| Phase                         | Deliverable                                                                        | Blocked by                                   |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| **0 — Auth foundation**       | `POST/GET /dashboard/auth/*` endpoints in server; login page; bootstrap setup page | Q1-check, env var for MNEMO_DASHBOARD_SECRET |
| **1 — Shell + Home**          | Nav shell, Home metric strip, Recent activity feed                                 | Phase 0                                      |
| **2 — Memory Browser**        | All-primitives browser, filters, pagination, detail drawer                         | Q3-resolved                                  |
| **3 — Config page**           | LLM config form, workspace mode, key field UX                                      | Q1-resolved                                  |
| **4 — Admin: Keys + Members** | Key create/revoke, member invite/role/remove                                       | Phase 0                                      |
| **5 — Recall Playground**     | Query + results; stage trace if Q4 resolved                                        | Q4-resolved                                  |
| **6 — Sessions browser**      | Episode list, detail, manual collapse trigger                                      | Phase 1                                      |
| **7 — Admin: Health + Audit** | Doctor output, stats table, audit log with filters                                 | Q2-resolved                                  |
| **8 — Relation Graph**        | Force-directed graph, node/edge click                                              | Q5-resolved                                  |
