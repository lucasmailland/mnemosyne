# Mnemosyne v3 — Public API Specification

**English** · [Español](API.es.md)

> **The complete, authoritative contract is the OpenAPI 3.1 document the server serves at
> `GET /openapi.json`** (human view: `GET /docs`). It is generated from the route definitions, so it
> always matches the running build; like every route it needs a bearer API key. This file is a
> hand-written guide that covers a subset of the routes and can lag behind; where the two disagree,
> `/openapi.json` wins.

> **Status:** Partially implemented — some routes return 501; see docs/STATUS.md — verified 2026-06-13

> **Revision**: 2026-06-12 (path prefixes corrected 2026-07-31)  
> **Scope**: guide to `@mnemo-ai/server` and `@mnemo-ai/mcp` (gRPC lives in `@mnemo-ai/server`)  
> **Base URL**: wherever you run `@mnemo-ai/server` (default port 3939, for example `http://localhost:3939`)
>
> **⚠️ No `/v1` path prefix on the wire.** `packages/server/src/app.ts` mounts the
> `v1` OpenAPIHono router at the app root (`app.route("/", v1)`), not under
> `/v1`. Every real route in this document is a bare path — `POST /recall`,
> `POST /remember`, `GET /admin/stats`, etc. — **not** `POST /v1/recall`. The only
> routes that genuinely keep a `/memory/` segment are federation
> (`/memory/federation/*`), the WS replay catch-up endpoint (`/memory/events`),
> and the WebSocket endpoint itself (`/memory/ws`) — see §5. Every curl example
> and path below has been corrected to match the real, deployed routes.
> `@mnemo-ai/client-ts` already calls these bare paths; `sdk-go` and
> `sdk-python` were fixed to match on 2026-07-31 (they previously hardcoded a
> `/v1/...` prefix and would 404 against a real server).

---

## Table of Contents

1. [Authentication & Workspace Scoping](#1-authentication--workspace-scoping)
2. [REST API](#2-rest-api)
3. [MCP Tools (26 tools)](#3-mcp-tools)
4. [gRPC Service (ConnectRPC)](#4-grpc-service-connectrpc)
5. [WebSocket Protocol](#5-websocket-protocol)
6. [Error Format](#6-error-format)
7. [Pagination](#7-pagination)
8. [API Versioning](#8-api-versioning)
9. [Idempotency](#9-idempotency)
10. [Response Headers](#10-response-headers)
11. [Webhook Delivery](#11-webhook-delivery)
12. [Rate Limits](#12-rate-limits)

---

## 1. Authentication & Workspace Scoping

All requests require a Bearer token in the `Authorization` header. The token uniquely identifies a workspace; no explicit workspace ID is needed.

```
Authorization: Bearer mns_live_abc123...  # Production key (legacy bearer format)
Authorization: Bearer mns_test_abc123...  # Sandbox key (legacy bearer format)
Authorization: Bearer mk_live_abc123...   # Production scoped key
Authorization: Bearer mk_test_abc123...   # Sandbox scoped key
```

**Key prefixes:**

| Prefix      | Kind          | Notes                                                              |
| ----------- | ------------- | ------------------------------------------------------------------ |
| `mns_live_` | Legacy bearer | Production; full rate limits; `mns_(live\|test)_<cuid>` format     |
| `mns_test_` | Legacy bearer | Sandbox; isolated workspace; shed last under load                  |
| `mk_live_`  | Scoped        | Production; carries explicit scopes + optional sensitivity ceiling |
| `mk_test_`  | Scoped        | Sandbox scoped key                                                 |
| `mk_sess_`  | Scoped        | Session-lifetime key                                               |
| `mk_fed_`   | Scoped        | Federation peer key (used with mTLS binding)                       |
| `mk_admin_` | Scoped        | Admin-scope key                                                    |

**Scopes** (assigned at key creation):

| Scope        | Grants                                       |
| ------------ | -------------------------------------------- |
| `read`       | GET endpoints, recall                        |
| `write`      | POST, PATCH, DELETE on knowledge             |
| `admin`      | Consolidate, export, import, provider config |
| `federation` | Cross-instance sync and resolve              |

### 1.1 Cross-Workspace Writes (`targetWorkspaceId`)

`POST /remember` and 9 other creation endpoints — `/decisions`, `/entities`,
`/tasks`, `/events`, `/reasoning`, `/strategies`, `/workflows`, `/skills`,
`/reminders` — accept an optional `targetWorkspaceId` (UUID) body field to
write into a workspace other than the caller's own key-bound workspace,
without needing a separate session or API key per workspace.

| Field               | Type                      | Notes                                                                                                                            |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `targetWorkspaceId` | `string` (UUID, optional) | Omit to write into the caller's own workspace (unchanged, default behavior). Supply to write into a different workspace instead. |

Requirements, resolved by one shared server-side helper
(`resolveTargetWorkspace`, `packages/server/src/workspace-target.ts`) shared
by all 10 routes:

- The caller's API key MUST be user-bound (`mk_user_*`/`mk_live_*` with a
  `user_id`, or any other user-bound key — **not** narrowed to a `uk_*`
  prefix). A workspace-only key supplying `targetWorkspaceId` is rejected.
- That user MUST have `role: "write"`, `"admin"`, or `"owner"` in
  `mnemo_workspace_member` for the target workspace. `role: "read"` and "no
  membership row at all" are rejected identically (indistinguishable to the
  caller, by design).
- Any rejection returns `403` with the flat body
  `{ "error": "forbidden", "message": "..." }` — the same shape
  `POST /remember` already used before this mechanism was extended to the
  other 9 endpoints.

Every one of these 10 endpoints' `201` response body includes a
`workspaceId` field stating which workspace actually received the write —
the caller's own workspace when `targetWorkspaceId` was omitted, the target
workspace when it was supplied and accepted. This value is also surfaced
through the corresponding MCP tool's result content, never swallowed.

`memory_pin`, `memory_relate`, and `memory_hyperedge` do **not** accept
`targetWorkspaceId` — they reference pre-existing primitive ids rather than
creating new rows, so "target a different workspace" does not map cleanly
onto them. This is deliberate, not an oversight (`docs/archive/openspec/
p57-cross-workspace-tool-parity/spec.md`, Non-Goals).

---

## 2. REST API

### OpenAPI Spec

The live OpenAPI 3.1 spec is auto-generated from route definitions and served at:

```
GET /openapi.json   — machine-readable spec
GET /docs           — Scalar interactive browser UI
```

No static file is checked in — the spec is always current with the deployed server. Both routes sit
behind the same bearer-key authentication as every other route (`Authorization: Bearer <key>`).

### Quick Start — curl Examples

Golden-path operations. Set `MNEMO_URL` and `MNEMO_KEY` first:

```bash
export MNEMO_URL=http://localhost:3939
export MNEMO_KEY=mns_live_...

# 1. Store a fact
curl -s -X POST "$MNEMO_URL/remember" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"PostgreSQL is the primary datastore","type":"fact","topicKey":"infra/db","confidence":0.99}' | jq .

# 2. Recall by semantic query
curl -s -X POST "$MNEMO_URL/recall" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"database stack","limit":5}' | jq '.hits[].content'

# 3. Log a decision
curl -s -X POST "$MNEMO_URL/decisions" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"architecture","title":"PostgreSQL over MongoDB","body":"Chosen for ACID guarantees and native pgvector support."}' | jq .

# 4. Soft-forget a fact (close validity window)
FACT_ID=fact_01j9abc123...
curl -s -X DELETE "$MNEMO_URL/facts/$FACT_ID" \
  -H "Authorization: Bearer $MNEMO_KEY" | jq .

# 5. Health check
curl -s "$MNEMO_URL/health/live" && curl -s "$MNEMO_URL/health/ready" | jq .
```

**Error response shape** (all errors):

```json
{
  "error": {
    "type": "not_found_error",
    "code": "not_found",
    "message": "fact_xyz does not exist in this workspace",
    "request_id": "req_..."
  }
}
```

Common error codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `unprocessable_entity` (422), `not_implemented` (501), `internal_error` (500).

#### Routes that can return 501

Verified against `packages/server/src/routes/*.ts` (2026-07-31) — every route whose
OpenAPI `responses` block declares `501`, with the real trigger condition:

| Route                            | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /remember`                 | No embed provider configured (`MNEMO_LLM_PROVIDER`/`MNEMO_LLM_API_KEY` unset) **and** no precomputed `vector` supplied in the request. `POST /facts` was removed (flatten-legacy-dual-core, D2) and is no longer a comparison point. `POST /recall` also does NOT 501 for the same missing-provider case — it gracefully degrades to full-text search instead (see the `debug.searchMode: "fts"` note under §2.2). A provider that is configured but **unreachable** does not fail the write either: the memory is stored, `embeddingDeferred: true` is returned, and the embedding is queued for the outbox worker (CHAOS-5). |
| `PUT /admin/config/llm`          | `MNEMO_MASTER_KEY` not configured — the workspace-config encryption-at-rest dependency is unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PUT /admin/config/retention`    | Same — `MNEMO_MASTER_KEY` not configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DELETE /admin/config/retention` | Same — `MNEMO_MASTER_KEY` not configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PUT /config/llm`                | Same — per-workspace override of the routes above; same encryption dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PUT /config/retention`          | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DELETE /config/retention`       | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Common Conventions

- All request/response bodies are `application/json`
- Timestamps are ISO 8601 with timezone (`2026-06-09T12:00:00Z`)
- IDs are prefixed by type: `sess_`, `fact_`, `ent_`, `task_`, `evt_`, `ep_`, `rel_`, `rsn_`, `wh_`
- Soft-deletes archive records; hard-delete is not exposed publicly
- `PATCH` accepts partial bodies (only provided fields are updated)

---

### 2.1 Session Lifecycle

Sessions are ephemeral working memory. They collapse into durable knowledge units.

> **Not implemented.** No route answers under `/memory/sessions`: the headings marked "(not implemented)" below are an earlier design that was never built. The real routes use the `/session` prefix (no `/memory/`, no `/v1/`), plus the aliases `POST /sessions`, `GET /sessions`, `POST /sessions/:id/turns` and `DELETE /sessions/:id`. Each heading names its real route under **Implemented**; their exact shapes are in `GET /openapi.json`.

#### `POST /memory/sessions` (not implemented)

Start a new session for an agent.

**Scope**: `write`

```json
// Request
{
  "agentId": "agent_coder_01",
  "label": "PR review for feat/auth",
  "metadata": { "task": "code-review" }
}

// Response 201
{
  "id": "sess_abc123",
  "agentId": "agent_coder_01",
  "label": "PR review for feat/auth",
  "status": "active",
  "createdAt": "2026-06-09T12:00:00Z",
  "scratchpad": {}
}
```

**Implemented** (`POST /session/start`, 2026-06-12): request body is optional; response is `{ id, agentId, status, createdAt }` (no `label` or `scratchpad` fields yet).

**Errors**: `unprocessable_entity`

---

#### `POST /memory/sessions/:id/turns` (not implemented)

Append a turn to an active session.

**Scope**: `write`

```json
// Request
{
  "role": "user",
  "content": "What do we know about the auth module?",
  "metadata": { "tokens": 14 }
}

// Response 201
{
  "turnIndex": 0,
  "sessionId": "sess_abc123",
  "role": "user",
  "content": "What do we know about the auth module?",
  "createdAt": "2026-06-09T12:00:01Z"
}
```

**Implemented** (`POST /session/:id/turn`, 2026-06-12): returns **204 No Content** (no body). Request shape is the same.

**Errors**: `not_found`, `unprocessable_entity`, `conflict` (session already collapsed)

---

#### `POST /memory/sessions/:id/pin` (not implemented)

Pin a turn so the collapse pipeline extracts it as a high-priority knowledge unit.

**Scope**: `write`

```json
// Request
{ "turnIndex": 3, "label": "Key decision on JWT expiry" }

// Response 200
{ "pinned": true, "turnIndex": 3, "label": "Key decision on JWT expiry" }
```

**Status**: Superseded — implemented earlier and differently than planned, as
`POST /session/:id/pin` (`{ turnIndex }`, no `label` field). See `session.ts:489`.

---

#### `POST /memory/sessions/:id/scratch` (not implemented)

Write to the session scratchpad (ephemeral key/value store).

**Scope**: `write`

```json
// Request
{ "key": "auth_module_path", "value": "packages/auth/src/index.ts" }

// Response 200
{ "scratchpad": { "auth_module_path": "packages/auth/src/index.ts" } }
```

**Status**: Superseded — implemented as `POST /session/:id/scratch` (`{ key, value }`
body). See `session.ts:535`. Response shape not independently verified against
this doc's `{ scratchpad }` claim as part of this pass.

---

#### `POST /memory/sessions/:id/collapse` (not implemented)

Collapse session into durable knowledge units. Requires LLM provider (Cognitive tier) or returns extraction prompt for the caller (inherited mode).

**Scope**: `write`  
**Idempotency**: supported via `Idempotency-Key` header

```json
// Request
{
  "hint": "Focus on architectural decisions and gotchas",
  "extractTypes": ["fact", "decision", "strategy"]
}

// Response 202 (async — LLM-backed)
{
  "jobId": "job_coll_xyz",
  "sessionId": "sess_abc123",
  "status": "processing",
  "estimatedMs": 3000
}

// OR Response 200 (inherited mode — caller must complete extraction)
{
  "status": "extraction_required",
  "extractionPrompt": "Given the following conversation...",
  "extractionSchema": { ... },
  "callbackEndpoint": "POST /memory/sessions/sess_abc123/collapse/complete"
}
```

**Implemented** (`POST /session/:id/collapse`): body `{ strategy?: "auto" | "explicit", collapseHint? }`; runs the extraction pipeline and returns 202 `{ accepted, sessionId, resumed, status, skipReason? }`, where `status` is `completed`, `skipped`, `failed` or `collapse_pending`. A `skipped` collapse extracted nothing.

**Errors**: `not_found`, `capability_unavailable` (no LLM provider and not inherited mode)

---

#### `DELETE /memory/sessions/:id` (not implemented)

Discard a session without collapsing it. All turns are lost.

**Scope**: `write`

```
// Response 204 No Content
```

**Errors**: `not_found`

**Implemented** (`POST /session/:id/discard`, not `DELETE`): see `session.ts:576`.

---

#### `GET /session/:id` and `GET /session/list`

Not part of the original planned spec above — added for the autonomous-memory
compliance backstop (2026-07). Read a session's current state, or list every
session in the workspace.

**Scope**: `read`

```json
// GET /session/sess_abc123 — Response 200
{
  "id": "sess_abc123",
  "agentId": "agent_coder_01",
  "status": "active",
  "createdAt": "2026-06-09T12:00:00Z",
  "label": "PR review for feat/auth",
  "lastRecallAt": "2026-07-31T14:22:00.000Z"
}

// GET /session/list — Response 200
{ "sessions": [ /* same shape as above, one per session */ ] }
```

`lastRecallAt` (autonomous-memory Requirement 1/4): ISO timestamp of the most
recent `POST /recall` call that supplied this session's id as `sessionId`, or
`null` if none has. Read from `metadata.lastRecallAt` — see `sessionId` under
§2.2 for how it gets set. `client-ts`'s `getSession()`/`listSessions()`
methods and the `memory_session` MCP tool's `get`/`list` actions both wrap
these routes (added 2026-07-31, closing an orphan-route gap — see
`docs/archive/BACKLOG.md` P36).

**Errors**: `not_found` (get only, unknown session id)

---

### 2.2 Recall

#### `POST /recall`

Blended lexical + vector search. The primary recall endpoint.

Optional `debug: true` returns `debug.trace` (per-stage candidate counts and timings; `ms` is time since the previous stage in execution order, only the answering level's trace under multi-level recall, a tier miss reports 0 candidates).

Trace counts and the sensitivity ceiling: the stages before `eligibility` (`embed`, the tiers, `cache`, `vector`, `lexical`, `nonfact_candidates`, `fusion`) count candidates the ceiling has not filtered yet. They report `candidatesIn: null, candidatesOut: null` unless the caller's effective ceiling admits every tier (a `memory:admin` key and `MNEMO_SENSITIVITY_CEILING=restricted`; the default env ceiling `internal` caps admin keys too). For those callers `eligibility` reports the candidates that passed it as both `candidatesIn` and `candidatesOut`; later stages are already past the ceiling and keep their counts. Stage names and `ms` are always present. In the hybrid cold path, `lexical` and `nonfact_candidates` report as `candidatesOut` the candidates they added. `debug.lexicalCandidateCount` counts candidates before the ceiling too, so it is present only for a caller whose effective ceiling admits every tier.

**Scope**: `read`

> **Corrected 2026-07-31** — the request/response shape below was rewritten to
> match `packages/server/src/routes/recall.ts`'s real `RecallRequestSchema`/
> `RecallResponseSchema` (verified directly against the Zod source, not
> assumed). The previous version of this section (`types`, `limit`,
> `includeGraph`, `agentId` request fields; `results[]` with `type`/`worth`/
> `relevanceScore`/`graph` response fields) did not match any field the real
> route reads or returns — it was pre-implementation/aspirational text that
> was never reconciled after the route shipped.

```json
// Request
{
  "query": "What do we know about Redis caching strategy?",
  "topK": 5,
  "asOf": "2026-05-01T00:00:00Z",
  "scope": "global",
  "scopeRef": "project:infra",
  "actorId": "key:ak_01H8Z9QK3X",
  "mode": "auto",
  "sessionId": "sess_abc123",
  "includeLowWorth": false
}

// Response 200
{
  "hits": [
    {
      "id": "fact_abc",
      "content": "Redis is used in transaction mode via PgBouncer",
      "score": 0.94,
      "lexicalScore": 0.4,
      "vectorScore": 0.91,
      "validFrom": "2026-04-01T00:00:00Z",
      "validTo": null,
      "attribution": { "source": "user_stated" },
      "tags": ["infra"],
      "actorId": "key:ak_01H8Z9QK3X",
      "userId": "usr_01H8Z8P7YQ"
    }
  ],
  "debug": {
    "embedded": true,
    "latencyMs": 42,
    "searchMode": "hybrid"
  },
  "reminders": []
}
```

Request fields not shown above: `vector` (caller-supplied precomputed embedding
— skips the server's own embed call), `vectorWeight` (deprecated in favor of
`mode`), `tokenBudget` (CALMem §17 ladder), `rerank`/`recurrenceThreshold`
(RecMem LLM-rerank gate, §1/§2). `topK` defaults to 10, max 100.

**`sessionId`** (autonomous-memory, added 2026-07): the Mnemosyne session id
returned by `POST /session/start`. When present, the server best-effort-stamps
`metadata.lastRecallAt` on that session so a later `GET /session/:id` call can
confirm recall happened during it — see §2.1. A stale or unknown `sessionId`
is silently ignored; it never fails the recall itself.

`debug.searchMode` reflects the ranking mode ACTUALLY used — `"fts"` when the
call degraded to full-text search because no embed provider is configured
(graceful degradation, not a 501 — see "Routes that can return 501" above).
`mode: "semantic"` is the one exception: it throws
`semantic_search_unavailable` rather than silently falling back, since the
caller explicitly asked for vector-only search.

A hit with `federation: { "peer": "...", "trustScore": 20 }` is an item a federation sync
pulled from another server, not memory of this workspace: `GET /facts/:id` does not find
it. These match lexically only (never in `mode: "semantic"`) and rank after the local hits
unless nothing local was relevant. See [FEDERATION.md](./FEDERATION.md) §12a.

`reminders` (REMIND-1): prospective-memory reminders whose trigger condition
was satisfied by this recall call. Omitted when none fired. Treat reminder
`content` as untrusted stored memory, same as `hits`.

**Errors**: `unprocessable_entity`, `semantic_search_unavailable` (`mode:"semantic"` with no embedder configured)

---

#### `POST /recall/hot`

Tier-1 only recall from Redis hot cache. Target latency: <5ms.

**Scope**: `read`

```json
// Request
{ "query": "Redis version", "limit": 3 }

// Response 200
{
  "results": [ ... ],
  "mode": "hot",
  "tookMs": 3,
  "cacheHit": true
}
```

---

#### `POST /recall/unified`

Blended recall across knowledge base (structured facts) and raw memory (episodic).

**Scope**: `read`

```json
// Request
{ "query": "auth module history", "limit": 10, "blend": { "kb": 0.6, "episodic": 0.4 } }
```

---

#### `POST /recall/explain`

Recall with a Bill of Materials — explains why each result was returned.

**Scope**: `read`

```json
// Request
{ "query": "deploy process", "limit": 3 }

// Response 200
{
  "results": [
    {
      "id": "fact_deploy_01",
      "content": "Deploy uses canary: 5% → 25% → 50% → 100%",
      "explanation": {
        "matchedTerms": ["deploy", "canary"],
        "vectorSimilarity": 0.91,
        "worthScore": 0.83,
        "recencyBoost": 0.05,
        "finalScore": 0.89
      }
    }
  ]
}
```

---

### 2.3 Knowledge Units CRUD

All knowledge types share the same revision and soft-delete model. `PATCH` creates a new revision; the original is preserved for bitemporal queries.

#### Facts

```
GET    /facts/:id
PATCH  /facts/:id
DELETE /facts/:id
```

> **BREAKING CHANGE (flatten-legacy-dual-core, D2):** `POST /facts` has been
> **removed**. `POST /remember` (`packages/server/src/routes/remember.ts`,
> used by the `memory_remember` MCP tool and the CLI's `mnemo remember`) is
> now the **sole** write path for facts — the two routes previously ran two
> independently-maintained implementations (`deps.core.createFact` vs
> `deps.cognitive.remember`) against the same physical schema; `/remember`'s
> plugin write hooks and `fact.created` event/webhook fan-out (the two
> behaviors `/facts` uniquely owned) were ported over first, then `/facts`
> was deleted. Migrate request bodies with a lossless field remap:
> `{content, attribution, tags}` → `{statement: content, attribution, tags}`;
> response readers should switch `content` → `statement`. The `/remember`
> response also carries `confidence`/`status`/`sensitivity`/
> `conflict.judgmentRequired`, none of which the old `Fact` shape had.
> `/remember` also creates non-fact primitives via its `kind` field
> (decision, entity, strategy, workflow, skill, task, event, reasoning), and
> it genuinely **can return 501** — see "Routes that can return 501" near
> the top of this file. MCP and CLI already targeted `/remember` only, so no
> change was needed there; `client-ts`/`sdk-go`/`sdk-python`/the dashboard
> are remapped in a follow-up change.

**`GET /facts/:id`** — **Scope**: `read`

Query params: `?asOf=2026-05-01` (time-travel), `?includeClosed=true` (closed facts return instead of 404), `?provenance=true` (adds `sessionId`, `supersededById`, `supersededAt`, `supersedesIds`; a successor or source episode above the sensitivity ceiling reads as `null`, exactly like none, and superseded facts above it are left out of `supersedesIds`). With or without `provenance`, `episodeId` reads `null` when that episode is above the caller's ceiling

Besides `content`/`attribution`/`tags`/validity, the response carries `kind`, `subject`,
`scopeRef`, `confidence`, `topicKey`, `episodeId`, `status` and `revisionCount` (CLIENTS-20,
additive).

**`GET /facts`** — **Scope**: `read` — keyset-paginated list (WP-5):

- **Default: current rows only** — `status: active` with an open validity interval. `includeClosed=true`
  (no `status`) lists history too; an explicit `status` or an `asOf` snapshot is applied as given.
- The caller's sensitivity ceiling is applied **in the query**, so pages are full and `total` counts only
  readable rows (PRIM-8).
- The cursor carries the sort timestamp with full microsecond precision. Cursors issued before this change
  carried milliseconds and can skip rows: restart pagination after upgrading.
- `q` matches with full-text search (both languages) or `ILIKE`; when that strict match finds nothing for the
  whole filter set, it falls back to rows matching at least two of the question's content terms (RECALL-7).

**`PATCH /facts/:id`** — **Scope**: `write`

Accepts partial updates. Supported fields (all optional):

| Field        | Type           | Notes                                     |
| ------------ | -------------- | ----------------------------------------- |
| `pinned`     | `boolean`      | Pin/unpin the fact for hot-tier promotion |
| `statement`  | `string`       | Revise the fact text                      |
| `confidence` | `number` (0–1) | Adjust confidence score                   |

```json
// Request — any combination of fields
{ "statement": "Updated statement text", "confidence": 0.98, "pinned": true }

// Response 200 — full MemoryFact including updated confidence
{ "id": "fact_xyz789", "statement": "Updated statement text", "confidence": 0.98, "pinned": true, "revision": 2, "previousRevision": 1, ... }
```

> **Implementation note (2026-06-12):** All three fields (`pinned`, `statement`, `confidence`) are now supported. Earlier builds only applied `pinned`; `statement` and `confidence` threw 501. This is fully resolved.

PATCH updates the fact **in place** (same id, `revisionCount + 1`) under a row lock, and copies the revision
it replaces into `mnemo_fact_revision` (migration 0044; cascades on hard delete). Optional
`expectedRevision`: the patch applies only if the fact is still at that revision, otherwise **409
`revision_conflict`** and nothing changes. A new `statement` is re-embedded through the outbox (CHAOS-8,
PRIM-4). PATCH, `POST /facts/:id/pin` and `POST /facts/:id/restore` answer **404** for a fact above the
caller's ceiling (PRIM-14).

**`DELETE /facts/:id`** — **Scope**: `write` — Archives (soft-delete), response `204`. Repeatable and
serialized: of concurrent deletes one gets `204`, the rest `404`; a fact forgotten, restored and forgotten
again keeps its latest snapshot in `mnemo_fact_archive` (PRIM-3). `POST /facts/:id/restore` reopens the
fact and re-embeds it; restoring a live fact is a no-op.

**`POST /facts/compare`** (docs/archive/openspec/decompose-recall-and-compare, Slice 2) — server-owned
relocation of what `memory_compare` used to compute locally in the MCP process. Fetches both
facts with the exact same read guard `GET /facts/:id` uses (active + open-interval + sensitivity
ceiling — 404, not 403, anti-probing per §5), then returns a structured comparison.

```json
// Request
{ "factIdA": "mfact_01J...abc", "factIdB": "mfact_01J...xyz" }

// Response 200
{
  "factA": { "id": "mfact_01J...abc", "content": "...", "...": "..." },
  "factB": { "id": "mfact_01J...xyz", "content": "...", "...": "..." },
  "differences": ["content: \"...\" → \"...\""],
  "suggestedVerb": "supersedes",
  "sameSubject": true
}
```

`suggestedVerb` is one of exactly 4 values: `supersedes | conflicts_with | compatible | scoped`
(never `related` — docs/archive/openspec/complete-mcp-tools B6). Either id missing, closed, or above the
caller's sensitivity ceiling → `404`. The comparison logic itself lives in
`packages/server/src/facts/compare.ts`, a pure module with no I/O.

---

#### Decisions, Strategies, Workflows, Skills

Same CRUD shape as Facts. POST only (no GET/:id individual endpoints for now, retrieved via recall).

```
POST /decisions    # Record a decision with rationale
POST /strategies   # Store behavioral pattern ("when X, do Y")
POST /workflows    # Store multi-step procedural recipe
POST /skills       # Store reusable capability
```

All 4 accept the optional `targetWorkspaceId` body field — see §1.1. `POST /strategies` also
takes an optional `validFrom` (when the strategy starts to apply); a future instant answers 400.

**`POST /decisions`**

```json
// Request
{
  "summary": "Use cursor-based pagination for all list endpoints",
  "rationale": "Offset pagination is O(n) at depth; cursor is O(1) and stable under writes",
  "alternatives": ["offset-based", "keyset"],
  "chosenAlternative": "cursor-based",
  "confidence": 0.99,
  "relatedEntities": ["ent_api"]
}
```

---

### 2.4 Entities & Graph

#### `POST /entities`

Create or find-or-create an entity.

**Scope**: `write`

Accepts the optional `targetWorkspaceId` body field — see §1.1.

```json
// Request
{
  "name": "PostgreSQL",
  "kind": "system",
  "aliases": ["PG", "Postgres"],
  "findOrCreate": true
}

// Response 200 (found) or 201 (created)
{
  "id": "ent_pg_001",
  "name": "PostgreSQL",
  "kind": "system",
  "aliases": ["PG", "Postgres"],
  "factCount": 12,
  "createdAt": "2026-01-01T00:00:00Z"
}
```

Every entity response (`GET /entities`, `GET /entities/:id`, its `/facts`, create, update,
link and unlink) carries `mentionCount`: the entity's active facts plus the episodes related to
it, counting only those the caller may read. It is the same number `GET /graph` shows for the
node. `linkedFactCount` in `GET /entities/:id` likewise counts only readable facts.
`PATCH /entities/:id` answers 404 for an entity above the caller's ceiling, and a `canonicalId`
above it answers 400 exactly like one that does not exist.

---

#### `POST /entities/:id/link-user` / `DELETE /entities/:id/link-user`

Bind (or unbind) a `kind: "person"` entity to a real platform account
(`linkedUserId`, a `mnemo_user.id`) — see "Provenance identity" in CLAUDE.md
for the `userId` (provenance, who wrote the row) vs. `linkedUserId` (subject,
who the row is about) distinction.

**Scope**: self-link (your own `userId`) requires no special scope beyond
read access to the entity. Linking a _different_ user — or reassigning an
entity already linked to someone else — requires `memory:admin` **and** an
owner/admin role in this workspace.

```json
// POST /entities/:id/link-user — Request
{ "userId": "usr_01H8Z8P7YQ" }

// Response 200
{ "id": "ent_pg_001", "kind": "person", "linkedUserId": "usr_01H8Z8P7YQ", "sensitivity": "internal", "..." : "..." }
```

`DELETE /entities/:id/link-user` takes no body. Unlink is bitemporal — it
closes the linked row (`validTo = now()`) and returns a new, unlinked
successor row linked to the predecessor via a `supersedes` relation, rather
than blanking `linkedUserId` in place.

404 when the entity doesn't exist, the caller's sensitivity ceiling can't
read it (anti-probing — same response as nonexistent), or (link only) the
target user isn't a member of this workspace. 400 (link only) when the
entity's `kind` isn't `person`.

---

#### `GET /entities/:id/graph`

Return the subgraph around an entity (BFS up to depth).

**Scope**: `read`  
Query params: `?depth=2&types=system,person`

**Implemented** as a path alias in `app.ts` (T6.6) — internally forwards to
`GET /graph?focus=:id`; see `packages/server/src/routes/graph.ts`.

Nodes above the caller's sensitivity ceiling are omitted, with the edges that touch them, and `factCount` counts only the facts the caller may read (the same holds for `GET /graph`). An entity's `mentionCount` is its `factCount` plus the episodes related to it that the caller may read.

```json
// Response 200
{
  "root": { "id": "ent_pg_001", "name": "PostgreSQL", "kind": "system" },
  "nodes": [ ... ],
  "edges": [
    { "from": "ent_pg_001", "to": "ent_pgbouncer", "verb": "proxied_by", "weight": 0.9 }
  ]
}
```

---

#### `POST /relations`

Create a relation between two memory primitives (fact/decision/entity/episode).

**Scope**: `write`

> **Corrected 2026-07-31** — the previous version of this section used a
> `from`/`to`/`verb`/`weight` shape and an invented verb (`"proxied_by"`)
> that don't exist on the real route. Rewritten to match
> `packages/server/src/routes/relations.ts`'s real request/response, which
> that file's own header comment documents field-by-field.

```json
// Request
{
  "sourceKind": "entity",
  "sourceId": "ent_pg_001",
  "targetKind": "entity",
  "targetId": "ent_pgbouncer",
  "relation": "related",
  "markedByKind": "agent",
  "reason": "Connection pooling in transaction mode",
  "confidence": 0.9
}

// Response 201
{
  "id": "rel_abc",
  "sourceKind": "entity",
  "sourceId": "ent_pg_001",
  "targetKind": "entity",
  "targetId": "ent_pgbouncer",
  "relation": "related",
  "judgmentStatus": "pending"
}
```

`relation` must be one of the 9 **locked verbs**: `related`, `compatible`,
`scoped`, `conflicts_with`, `supersedes`, `not_conflict`, `derived_from`,
`part_of`, `member_of` — any other value 400s with the allowed list.
Multi-actor disagreement is captured by creating multiple relation rows for
the same source/target/verb with different `markedByKind`/`markedByUserId`;
there is deliberately no `UNIQUE` constraint on that tuple.

---

#### `POST /relations/traverse`

Directional BFS from a root node — returns the full reachable node+edge
structure. Distinct from `GET /graph/traverse` (§2.2-adjacent, bidirectional,
returns a decay-scored neighbor list instead) — see GRAPH-DUP-1 in
`docs/archive/BACKLOG.md` for why both exist.

Both traverse the **current** graph: a relation closed by `DELETE /relations/:id`
or by a fact's hard delete is not followed. `GET /graph/traverse?asOf=` still
reconstructs the graph at a past instant, closed edges included.

Both, and `GET /graph/path`, stop at nodes above the caller's sensitivity ceiling:
such a node is never returned or walked through, and no edge that touches it is
listed, so a path that runs through it is not found. A root above the ceiling
answers as an unknown id does (no hits, no path, no edges).

The rest of the relation surface follows the same rule: `GET /relations` lists no relation
that touches such a node, and `PATCH`/`DELETE /relations/:id` answer 404 for one and leave it
unchanged. `GET /hyperedges` leaves out a hyperedge with a member above the ceiling (from
`items` and `total`), and `GET`, `PATCH` and `DELETE /hyperedges/:id` answer 404 for it.

**Scope**: `read`

> **Corrected 2026-07-31** — same issue as `POST /relations` above: the
> previous shape (`startEntity`, `traversal`, `paths`, `visitedNodes`) had
> no relationship to the real route.

```json
// Request
{
  "rootId": "ent_auth_module",
  "rootKind": "entity",
  "maxDepth": 3,
  "verbs": ["derived_from", "supersedes"]
}

// Response 200
{
  "nodes": [{ "id": "ent_auth_module", "kind": "entity" }, { "id": "mdec_xyz", "kind": "decision" }],
  "edges": [{ "id": "rel_1", "sourceKind": "decision", "sourceId": "mdec_xyz", "targetKind": "entity", "targetId": "ent_auth_module", "relation": "derived_from" }],
  "truncated": false
}
```

`maxDepth` defaults to 2, max 5. `verbs` restricts which of the 9 locked
verbs to follow; omit for all. `truncated: true` signals a very generous
per-layer cap (2000 nodes) was hit — a real safety ceiling, not a silent
edge drop (TRAVERSE-1).

**`memory_relate(action:'history')`** (MCP tool, added 2026-07-31) composes
this exact endpoint with `verbs` fixed to `['supersedes', 'derived_from']` —
no new server code, no new `client-ts` method. Purpose-built for "why is
this decision/fact the current one, what did it replace" instead of
generic graph exploration; see `packages/mcp/src/tools/relate.ts` and
`docs/archive/BACKLOG.md`'s case-1 analysis for why a narrow action was chosen
over a generic traverse-exposing tool.

---

### 2.5 Episodes & Timeline

#### `POST /episodes`

Create an episode (a named segment of activity).

**Scope**: `write`

```json
// Request
{
  "name": "Auth refactor — June 2026",
  "startedAt": "2026-06-01T09:00:00Z",
  "endedAt": null,
  "relatedEntities": ["ent_auth_module"],
  "tags": ["refactor", "auth"]
}

// Response 201
{ "id": "ep_001", "name": "Auth refactor — June 2026", ... }
```

---

#### `GET /episodes/:id/timeline`

Events and turns within a specific episode.

**Scope**: `read`  
Query params: `?cursor=xxx&limit=20`

---

#### `GET /timeline`

Global timeline across all episodes and events.

**Scope**: `read`  
Query params: `?from=2026-05-01&to=2026-06-09&entityId=ent_auth_module&types=event,session&limit=50&cursor=xxx`

Events also include `decision_created`, `decision_superseded` and `decision_withdrawn` (with `decisionId`, no `factId`).

```json
// Response 200
{
  "data": [
    {
      "type": "event",
      "id": "evt_001",
      "name": "deploy.success",
      "timestamp": "2026-06-08T14:32:00Z",
      "entities": ["ent_deploy_pipeline"]
    }
  ],
  "cursor": "cur_encoded_next",
  "hasMore": true
}
```

---

#### `GET /timeline/counts`

How many decision events `GET /timeline` would list since an instant, without paging through
them. Decision kinds only: a fact event's kind is derived per row, so those are not counted.
Decisions above the caller's sensitivity ceiling are left out.

**Scope**: `read`  
Query params: `?since=2026-06-09T00:00:00Z` (defaults to 24 hours ago)

```json
// Response 200
{
  "since": "2026-06-09T00:00:00.000Z",
  "counts": { "decision_created": 4, "decision_superseded": 1, "decision_withdrawn": 0 }
}
```

---

### 2.6 Tasks & Events

#### `POST /tasks`

Create a task.

**Scope**: `write`

Accepts the optional `targetWorkspaceId` body field — see §1.1.

```json
// Request
{
  "title": "Migrate fact table to bitemporal schema",
  "description": "Add valid_from/valid_to columns to mnemo_fact",
  "priority": "high",
  "assignedTo": "agent_db_01",
  "dueAt": "2026-06-15T00:00:00Z",
  "relatedFacts": ["fact_xyz789"]
}

// Response 201
{
  "id": "task_001",
  "title": "Migrate fact table to bitemporal schema",
  "status": "pending",
  "priority": "high",
  "assignedTo": "agent_db_01",
  "dueAt": "2026-06-15T00:00:00Z",
  "createdAt": "2026-06-09T12:00:00Z"
}
```

---

#### `PATCH /tasks/:id`

Update task status or outcome.

**Scope**: `write`

```json
// Request
{
  "status": "completed",
  "outcome": "Migration completed. Added 2 columns, backfilled 50K rows.",
  "lessonsLearned": "Run ANALYZE after bulk backfill to update planner stats"
}
```

---

#### `GET /tasks`

List tasks with filters.

**Scope**: `read`  
Query params: `?status=pending&assignedTo=agent_db_01&cursor=xxx&limit=20`

---

#### `POST /tasks/:id/delegate`

Delegate a task to another agent.

**Scope**: `write`

```json
// Request
{ "toAgent": "agent_specialist_02", "context": "Needs schema expertise" }
```

---

#### `POST /events`

Record an immutable event (temporal anchor).

**Scope**: `write`

Events cannot be deleted or forgotten: `DELETE /events/:id` and `DELETE /forget/event/:id` answer **409
`event_immutable`** and change nothing (they used to report success while changing nothing — PRIM-10).
To retract what an event says, forget the facts derived from it.

Accepts the optional `targetWorkspaceId` body field — see §1.1.

```json
// Request
{
  "name": "deploy.success",
  "description": "v3.1.0 deployed to production",
  "type": "system",
  "relatedEntities": ["ent_deploy_pipeline"],
  "metadata": { "version": "3.1.0", "sha": "d0428e7" }
}

// Response 201
{ "id": "evt_001", "name": "deploy.success", "recordedAt": "2026-06-09T14:00:00Z" }
```

---

#### `GET /events`

Query events by time range.

**Scope**: `read`  
Query params: `?since=2026-06-01T00:00:00Z&until=2026-06-09T00:00:00Z&name=deploy.*&cursor=xxx&limit=50`

---

#### `POST /reminders`

Create a prospective-memory reminder — surfaces during recall when its time
condition (`triggerAt`), semantic condition, or both are met (REMIND-1).
Backs the `memory_remind_when` MCP tool's `action: "create"`.

**Scope**: `write`

Accepts the optional `targetWorkspaceId` body field — see §1.1.

```json
// Request
{ "content": "Follow up on the pgvector migration", "triggerAt": "2026-06-20T00:00:00Z" }

// Response 201
{
  "id": "rem_001",
  "content": "Follow up on the pgvector migration",
  "condition": null,
  "triggerAt": "2026-06-20T00:00:00Z",
  "status": "pending",
  "createdAt": "2026-06-09T14:00:00Z",
  "workspaceId": "ws_default"
}
```

---

### 2.7 CoT Distillation

#### `POST /reasoning`

Create a reasoning chain record directly (distinct from `/reasoning/record`
below, which stores a chain resolved via `/reasoning/resolve`'s cache-check
flow). Backs the `memory_reasoning` MCP tool's `action: "create"`.

**Scope**: `write`

Accepts the optional `targetWorkspaceId` body field — see §1.1.

```json
// Request
{
  "question": "How to handle cursor pagination with concurrent writes?",
  "chain": [{ "step": "Considered offset vs. keyset pagination" }],
  "conclusion": "Use composite cursor (timestamp + id) to maintain stability under concurrent inserts"
}

// Response 201
{ "id": "rsn_002", "question": "...", "conclusion": "...", "workspaceId": "ws_default" }
```

---

#### `POST /reasoning/resolve`

Check if a similar reasoning chain exists before running LLM inference.

**Scope**: `read`

```json
// Request
{ "query": "How to handle cursor pagination with concurrent writes?", "similarityThreshold": 0.88 }

// Response 200
{
  "cacheHit": true,
  "reasoning": {
    "id": "rsn_001",
    "input": "How to handle cursor pagination...",
    "output": "Use composite cursor (timestamp + id) to maintain stability under concurrent inserts",
    "model": "claude-sonnet-4-5",
    "usedAt": "2026-06-07T10:00:00Z",
    "successRate": 0.95
  }
}
```

---

#### `POST /reasoning/record`

Store a successful reasoning chain.

**Scope**: `write`

```json
// Request
{
  "input": "How to handle cursor pagination with concurrent writes?",
  "reasoning": "<full chain of thought>",
  "output": "Use composite cursor (timestamp + id)...",
  "model": "claude-sonnet-4-5",
  "tokensUsed": 512
}
```

---

#### `POST /reasoning/feedback`

Report whether a cached reasoning result succeeded or failed.

**Scope**: `write`

```json
// Request
{ "reasoningId": "rsn_001", "outcome": "success" }
```

---

### 2.8 Self-Edit

#### `POST /self/edit`

Agent edits its own memory — append, replace, strengthen, or weaken a fact.

**Scope**: `write`

```json
// Request
{
  "action": "weaken",
  "target": "fact_abc",
  "reason": "Turned out Redis Sentinel failed to promote in under 5s during the June incident"
}

// Response 200
{ "id": "fact_abc", "confidence": 0.61, "previousConfidence": 0.85, "revision": 3 }
```

Actions: `append | replace | strengthen | weaken`

`append` and `replace` require non-blank `content` (**400 `self_edit_content_required`**, nothing is
changed or charged — PRIM-1).

Budgets (PRIM-6) belong to the **authenticated credential**, never to the body's `agentId`: 5 edits per
session, the daily delete/strengthen/weaken caps, and a 300 s cooldown **per target**. A `sessionId` opens its
own budget only when it names a session of the workspace (`POST /session/start`); otherwise the edit draws
from the credential's sessionless budget. HTTP and gRPC share the same counters.

---

#### `POST /self/reflect`

Trigger a self-reflection pass — surfaces inconsistencies, outdated facts, gaps.

**Scope**: `write`  
**Note**: Cognitive tier (requires LLM provider)

```json
// Request
{ "focus": "auth module", "depth": "shallow" }

// Response 202
{ "jobId": "job_reflect_001", "status": "processing" }
```

---

#### `GET /self/profile`

Get the agent's computed profile summary (strengths, gaps, recent activity).

**Scope**: `read`  
Query params: `?agentId=agent_coder_01`

```json
// Response 200
{
  "agentId": "agent_coder_01",
  "factCount": 142,
  "avgWorth": 0.74,
  "strongAreas": ["PostgreSQL", "authentication"],
  "weakAreas": ["frontend testing"],
  "recentActivity": { "recalls": 23, "writes": 7, "period": "last_7d" }
}
```

---

### 2.9 Procedural Memory

#### `POST /procedural/optimize`

Submit a completed trajectory for prompt evolution (improves the agent's system prompt over time).

**Scope**: `write`

```json
// Request
{
  "agentId": "agent_coder_01",
  "trajectory": { "steps": [...], "outcome": "success", "rating": 0.9 },
  "currentPromptVersion": "v12"
}
```

---

#### `GET /procedural/prompt/:agent`

Get the current evolved system prompt for an agent.

**Scope**: `read`

```json
// Response 200
{
  "agentId": "agent_coder_01",
  "promptVersion": "v13",
  "content": "You are a code reviewer...",
  "evolvedAt": "2026-06-08T00:00:00Z",
  "improvementDelta": "+8% task success rate vs v12"
}
```

---

### 2.10 Governance

#### `GET /governance/worth`

Memory worth scores — identifies high/low value knowledge.

**Scope**: `read`  
Query params: `?sort=asc&type=fact&limit=20&cursor=xxx`

```json
// Response 200
{
  "data": [
    {
      "id": "fact_stale_01",
      "content": "...",
      "worth": 0.03,
      "type": "fact",
      "lastRecalledAt": null
    }
  ],
  "cursor": "cur_next",
  "hasMore": false
}
```

---

#### `POST /governance/gate`

Manually gate or ungate a consolidation run.

**Scope**: `admin`

```json
// Request
{ "action": "gate", "reason": "Major refactor in progress — hold consolidation" }

// Response 200
{ "consolidationGated": true, "reason": "Major refactor in progress...", "gatedAt": "2026-06-09T12:00:00Z" }
```

---

#### `GET /governance/drift`

Memory drift report — facts that have diverged from observed behavior.

**Scope**: `read`

```json
// Response 200
{
  "driftScore": 0.12,
  "driftedFacts": [
    { "id": "fact_001", "statement": "...", "driftReason": "Contradicted by 3 recent events" }
  ],
  "generatedAt": "2026-06-09T06:00:00Z"
}
```

---

### 2.11 Health & Admin

#### `GET /health`

Workspace cognitive vitals for the authenticated caller (`mountVitals` in
`packages/server/src/routes/health.ts`, backed by
`deps.storage.getWorkspaceVitals()`). This
is auth'd and scoped to the caller's workspace — it is NOT a generic
infra/dependency health check (that's the unauthenticated, instance-wide
`GET /health/ready` below).

**Scope**: `read`

```json
// Response 200
{
  "workspaceId": "ws_default",
  "factsLive": 1420,
  "factsClosed": 87,
  "pinnedCount": 34,
  "lastRecallAt": "2026-06-09T05:58:00Z",
  "lastWriteAt": "2026-06-09T04:12:00Z",
  "embeddings": { "indexed": 1390, "pending": 12 }
}
```

The MCP `memory_status` tool (`packages/mcp/src/tools/status.ts`) takes no
parameters and calls this route plus three others in parallel, folding them
into one response: `GET /health/ready` (real per-dependency status, surfaced
as `dependencyHealth` — instance-wide, not workspace-scoped), `GET /admin/stats`
(`factsByScopeRef` breakdown), and `GET /me` (personal-workspace id + live
fact count, when the API key is bound to a user). Any of the three optional
calls that fails is swallowed to `null` rather than failing the whole tool.

---

#### `GET /health/ready`

Real per-dependency readiness probe (postgres/vector/cache). Unauthenticated
and instance-wide — not scoped to a workspace. Postgres down returns 503;
cache/vector down still returns 200 with `degraded: true`.

```json
// Response 200
{
  "status": "ready",
  "degraded": false,
  "checks": { "postgres": "ok", "vector": "ok", "cache": "ok" }
}

// Response 503 (postgres unreachable)
{ "status": "not_ready", "reason": "postgres_unavailable" }
```

---

#### `GET /health/history`

Historical health drift. Query params: `?from=2026-06-01&to=2026-06-09&resolution=1h`

**Scope**: `admin`

---

#### `POST /admin/consolidate`

**Implemented** as a path alias in `app.ts` (T6.6) — internally forwards to
`POST /consolidation/trigger`; see `packages/server/src/routes/consolidation.ts`.

Manually trigger memory consolidation (normally runs on schedule).

**Scope**: `admin`

```json
// Request (both fields optional; "deep" and dryRun: true answer 422)
{ "mode": "fast", "dryRun": false }

// Response 200 (one tick, run synchronously)
{ "accepted": true, "workspaceId": "00000000-0000-0000-0000-000000000001", "mode": "fast", "dryRun": false, "mergedPairs": 2, "skippedPairs": 5, "candidatesProcessed": 40, "errors": 0, "tookMs": 180 }

// Response 503 when @mnemo-ai/consolidation is not installed
{ "error": { "code": "consolidation_unavailable", "message": "@mnemo-ai/consolidation is not installed. Add it as a dependency and restart the server to enable this endpoint." } }
```

---

#### `GET /admin/stats`

Usage statistics for the workspace.

**Scope**: `read` (trimmed: the keys marked "admin only" below are omitted, not `null`) or `admin` (full).

```json
// Response 200
{
  "workspaceId": "00000000-0000-0000-0000-000000000001",
  "generatedAt": "2026-11-14T12:00:00.000Z",
  "facts": {
    "live": 1420,
    "closed": 96,
    "pinned": 12,
    "archived": 40, // null when no usable health snapshot
    "withZeroHits": 310, // admin only; null without a snapshot
    "byScopeRef": [{ "scopeRef": "project:abc", "count": 210 }] // admin only
  },
  "decisions": { "active": 87 }, // null without a snapshot
  "relations": { "conflicts": 3 }, // live: the pairs GET /conflicts can list
  "embeddings": { "indexed": 1400, "pending": 20 }, // admin only
  "snapshot": { "at": "2026-11-14T11:55:00.000Z", "ageSeconds": 300, "available": true }, // admin only
  "recall": {
    "hitRate30d": 0.62,
    "lastRecallAt": "2026-11-14T11:59:00.000Z",
    "latencyP50Ms7d": 38, // null with no samples
    "latencyP95Ms7d": 140,
    "precisionAtK": [
      { "k": 1, "precision": 0.8, "sampleSize": 50 },
      { "k": 3, "precision": 0.7, "sampleSize": 140 },
      { "k": 5, "precision": 0.62, "sampleSize": 220 } // precision is null while sampleSize is 0
    ], // admin only, as are the next five; always k = 1, 3 and 5
    "precisionTotalHits": 230,
    "precisionPendingHits": 4,
    "precisionInsufficientData": false,
    "precisionUnavailable": false,
    "precisionMethodologyNote": "…"
  },
  "writesPerDay14d": [{ "day": "2026-11-01", "count": 14 }], // 14 zero-filled UTC days, oldest first
  "lastWriteAt": "2026-11-14T11:58:00.000Z"
}
```

`recall.latencyP50Ms7d` / `latencyP95Ms7d` are percentiles over the recall log, which has one row per served memory: they weigh a recall by how many memories it served, and a recall that served nothing is not counted. `writesPerDay14d` counts `mnemo_fact.created_at`.

---

#### `GET /recall/metrics`

Recall activity per UTC day. Query param: `?days=30` (7 to 90, default 30; outside that range, 400).

**Scope**: `read`

```json
// Response 200
{
  "days": [
    { "day": "2026-10-19", "queries": 0, "zeroHitShare": null, "p50Ms": null, "p95Ms": null },
    { "day": "2026-11-17", "queries": 42, "zeroHitShare": 0.07, "p50Ms": 36, "p95Ms": 128 }
  ], // exactly `days` entries ending today, zero-filled, oldest first
  "totals": { "queries": 610, "zeroHitShare": 0.09, "p50Ms": 34, "p95Ms": 140 } // the whole window
}
```

- `queries` counts recall calls (`POST /recall`, `/recall/hot`, `/recall/unified`, `/recall/explain`): each one writes a `recall` audit entry, whatever it returned. The recall log can't count them, since it has one row per served fact and none for a call that served nothing.
- `zeroHitShare` is the share of those calls that returned nothing, over the calls whose audit detail is readable. A detail encrypted with the actor's key hides its result count, so those calls are left out of the share. `null` when no call in the window is readable.
- `p50Ms` / `p95Ms` are per call: the recall log's first-rank row of each call that served a fact (unlike `/admin/stats`, which weighs a call by how many memories it served). `null` with no samples.

---

#### `GET /facts/stats`

Counts of the live facts (open, `active`) the caller can read. Facts above the caller's sensitivity ceiling are not counted, the same as every list.

**Scope**: `read`

```json
// Response 200
{
  "live": 1420,
  "pinned": 12,
  "neverRecalled": 310, // hit_count = 0
  "lastWriteAt": "2026-11-17T18:02:11.000Z", // the latest created_at of these same facts; null when none
  "byKind": [
    { "kind": "preference", "count": 610 },
    { "kind": "architecture", "count": 220 }
  ],
  "bySensitivity": [
    { "sensitivity": "internal", "count": 1300 },
    { "sensitivity": "public", "count": 120 }
  ],
  "byMemoryType": [
    { "memoryType": "semantic", "count": 1400 },
    { "memoryType": "episodic", "count": 20 }
  ]
}
```

Each breakdown lists its groups largest first and leaves out empty ones; the counts of a breakdown add up to `live`.

---

#### `GET /graph/stats`

Counts of the graph the caller can read, tallied from the same snapshot `GET /graph?includeMentions=true` draws: canonical entities, active decisions and non-synthetic episodes at or under the caller's sensitivity ceiling, and the open typed relations between them (dismissed relations and semantic neighbours are left out).

**Scope**: `read`

```json
// Response 200
{
  "entities": 84,
  "decisions": 12,
  "episodes": 30,
  "relations": 140, // open typed relations between readable nodes
  "conflicts": 2, // open fact conflicts, the same count as GET /conflicts' total
  "isolated": 9, // entities with no relation and no mention
  "entitiesByKind": [{ "kind": "person", "count": 31 }],
  "relationsByType": [{ "relation": "related", "count": 96 }],
  "hubs": [{ "id": "ent_…", "label": "Atlas", "degree": 22 }] // top 5 by links (relations and mentions)
}
```

Groups are largest first, then by name; empty groups are left out.

---

#### `GET /session/stats`

Sessions and episodes over a window of UTC days. Query param: `?days=30` (7 to 90, default 30; outside that range, 400).

**Scope**: `read`

```json
// Response 200
{
  "days": [{ "day": "2026-11-17", "active": 2, "collapsed": 5, "archived": 0 }], // sessions started that day, by current status; `days` entries, oldest first
  "totals": {
    "sessions": 41, // sessions started in the window
    "collapsed": 33, // of those, collapsed into memory
    "avgTurns": 12.4, // null with no session
    "episodes": 30, // non-synthetic episodes that occurred in the window, under the ceiling
    "factsPerEpisode": 3.1 // mean of their linked facts the caller can read; null with no episode
  },
  "topics": [{ "topic": "checkout", "count": 7 }] // the five topics most of those episodes carry
}
```

Sessions carry no content and are all counted; episodes and linked facts above the caller's sensitivity ceiling are not.

---

#### `GET /health/snapshots`

The workspace's daily health snapshots (`mnemo_health`, written by the snapshot job), as shares and rates. Query param: `?days=30` (7 to 90, default 30; outside that range, 400).

**Scope**: `admin`

```json
// Response 200
{
  "days": [
    {
      "day": "2026-11-16",
      "recallHitRate30d": null,
      "zeroHitShare": null,
      "embeddedShare": null,
      "failedJobs7d": null
    },
    {
      "day": "2026-11-17",
      "recallHitRate30d": 0.42,
      "zeroHitShare": 0.31,
      "embeddedShare": 0.97,
      "failedJobs7d": 0
    }
  ] // exactly `days` entries ending today, oldest first; a day without a snapshot is all null
}
```

Each day is that day's latest snapshot. A snapshot covers every sensitivity tier, so only shares and rates are returned, never row counts: `zeroHitShare` is facts never recalled over active facts, `embeddedShare` embedded over embedded plus unembedded.

---

#### `GET /audit/stats`

The undo log (`GET /audit`) counted per UTC day: user forgets and system archives. Query param: `?days=30` (7 to 90, default 30; outside that range, 400).

**Scope**: `read`

```json
// Response 200
{
  "days": [{ "day": "2026-11-17", "user": 3, "system": 12 }], // exactly `days` entries ending today, zero-filled, oldest first
  "totals": { "user": 41, "system": 230 } // the whole window
}
```

Facts above the caller's sensitivity ceiling are not counted, the same as in the feed.

---

#### `GET /me/activity`

The caller's own audit-log entries in this workspace: the signed-in person on the dashboard, the key on the API. Query param: `?days=30` (7 to 90, default 30; outside that range, 400).

**Scope**: `read`

```json
// Response 200
{
  "days": [{ "day": "2026-11-17", "count": 14 }], // exactly `days` entries ending today, zero-filled, oldest first
  "byAction": [{ "action": "recall", "count": 120 }], // the window's entries, largest first
  "lastAt": "2026-11-17T18:02:11.000Z" // the latest entry ever; null when none
}
```

---

#### `POST /admin/erasure`

GDPR Article 17 crypto-erasure of one data subject in the caller's workspace
(`routes/admin-erasure.ts`, SECURITY.md section 8). `userId` destroys every encryption key of
that platform user; `actorId` (the `key:<id>` ref on the actor's facts) destroys that actor's
key. Confidential and restricted columns written under those keys can never be decrypted again;
no row is deleted. Irreversible. CLI: `mnemo erase`.

**Scope**: `memory:hard_delete`

```json
// Request: exactly one of userId / actorId; confirm repeats it
{ "actorId": "key:mk_0123456789abcdef", "confirm": "key:mk_0123456789abcdef" }

// Response 200
{ "subject": { "kind": "actor", "id": "key:mk_0123456789abcdef" }, "keysDestroyed": 1 }
```

`400` both or neither subject, or `confirm` does not repeat it; `404` no live key for that
subject (already erased); `501` the storage adapter cannot destroy keys. Audit:
`erasure_initiated` before any key is touched (if it cannot be written, nothing is destroyed),
then a terminal `erasure_complete`.

---

#### `POST /admin/export`

**Implemented** as a path alias in `app.ts` (T6.6) — internally forwards to
`POST /export`.

Initiate a full memory export (async, JSONL format).

**Scope**: `admin`

A `types` filter is not implemented yet: a body that sends `types` gets `400`, and the export always carries every type.

```json
// Request
{ "format": "jsonl", "includeEmbeddings": false }

// Response 202
{ "jobId": "job_exp_001", "status": "processing", "estimatedSeconds": 30 }
```

Export file format: `workspace_{id}_{timestamp}.jsonl.gz`  
Each line: `{ "type": "fact", "id": "...", "data": {...}, "metadata": { "createdAt": "...", "worth": 0.87 } }`

---

#### `POST /admin/import`

**Implemented** as a path alias in `app.ts` (T6.6) — internally forwards to
`POST /import`.

Bulk import from export file. Supports Mem0, Zep/Graphiti, and Claude memory formats via `--from` flag.

**Scope**: `admin`

```json
// Request
{
  "format": "jsonl",
  "sourceFormat": "mnemosyne-export-v1",
  "conflictResolution": "theirs_wins",
  "dryRun": false
}
// Body: multipart/form-data with file upload, OR { "url": "https://..." }

// Response 202
{ "jobId": "job_imp_001", "status": "processing" }
```

`conflictResolution`: `"theirs_wins" | "ours_wins" | "newest_wins" | "skip"`

Sensitivity ceiling: a line whose own `sensitivity` is above the caller's ceiling is skipped
(reason `above-ceiling`), and an existing row above it is never matched or overwritten (the line
is imported as a new row, as for an id that names nothing).

---

### 2.12 Federation

#### `POST /memory/federation/sync`

Push/pull knowledge with a remote Mnemosyne instance.

**Scope**: `federation`

```json
// Request
{ "peerId": "peer_instance_02", "direction": "bidirectional", "since": "2026-06-08T00:00:00Z" }

// Response 202
{ "jobId": "job_sync_001", "status": "processing" }
```

---

#### `GET /memory/federation/peers`

List connected peer instances.

**Scope**: `federation`

```json
// Response 200
{
  "data": [
    {
      "id": "peer_instance_02",
      "url": "https://remote.example.com",
      "lastSync": "2026-06-09T06:00:00Z",
      "status": "healthy"
    }
  ]
}
```

---

#### `POST /memory/federation/resolve`

Resolve a cross-instance conflict (conflicting facts from two peers).

**Scope**: `federation`

```json
// Request
{
  "conflictId": "conf_001",
  "resolution": "local_wins",
  "reason": "Local instance has more recent evidence"
}
```

---

### 2.13 Webhooks

```
POST   /webhooks          # Register endpoint
GET    /webhooks          # List endpoints
DELETE /webhooks/:id      # Remove endpoint
POST   /webhooks/:id/test # Send test event
GET    /webhooks/:id/deliveries  # Delivery log (last 30 days)
```

See [Section 11 — Webhook Delivery](#11-webhook-delivery) for full details.

---

### 2.14 Multi-Tenancy: Tenants, Workspaces, Users, Tokens

See [MULTI_TENANCY.md](./MULTI_TENANCY.md) for the full model (tenant vs. workspace, the two authority planes, role→scope narrowing, the onboarding recipe, and what was deliberately not built). This section is the route reference only.

All 16 routes below are mounted by `packages/server/src/routes/tenants.ts` (13 routes) and `packages/server/src/routes/user-tokens.ts` (3 routes). `TenantRole` = `owner | admin | member` (governs tenant-plane operations, scope `admin:tenant`). `WorkspaceRole` = `owner | admin | write | read` (governs workspace-plane operations — facts/recall/remember/etc — via the server's role→scope narrowing, not a distinct scope of its own).

#### `POST /tenants`

Create a tenant. **Scope**: `admin:tenant`; a user-bound caller must be `owner` or `admin` of its own tenant (403 otherwise), and becomes the new tenant's `owner`. Its key keeps acting in its old tenant (MULTI_TENANCY.md §5). With `"issueOwnerToken": true` (and an optional `workspaceName`), the response also carries `workspace`, the tenant's first workspace, and `ownerToken`, a `uk_live_*` token for the caller's user bound to the new tenant, within the caller's own scopes and ceiling; the plaintext `key` is shown once. 400 when the key has no user.

```json
// Request
{ "name": "Acme", "kind": "organization", "plan": "free" }
// Response 201
{ "id": "tenant_1", "name": "Acme", "kind": "organization", "plan": "free", "createdAt": "2026-01-01T00:00:00Z" }
```

#### `GET /tenants/:tenantId`

Get tenant info. **Scope**: `admin:tenant`. 404 if the caller's key/token is bound to a different tenant.

#### `GET /tenants/:tenantId/members`

List tenant members with their `TenantRole`. **Scope**: `admin:tenant`.

```json
// Response 200
{ "members": [{ "userId": "user_1", "role": "owner", "joinedAt": "2026-01-01T00:00:00Z" }] }
```

#### `POST /tenants/:tenantId/members`

Invite a user by email. **Scope**: `admin:tenant`, caller must be tenant owner/admin.

```json
// Request
{ "email": "new@example.com", "role": "member", "createIfMissing": true }
// Response 200
{ "ok": true }
```

`createIfMissing: true` auto-provisions a user (+ personal tenant + personal workspace, same flow as `POST /users`) when the email has no account yet, then adds the membership — closes the "invite someone who's never used Mnemosyne" gap in one call. Default `false` preserves the original 404-on-unknown-email behavior. A user-bound caller finds only members of its own tenant and accounts that tenant provisioned: any other registered email answers 404, or 409 with `createIfMissing` (MULTI_TENANCY.md §5 explains why).

#### `DELETE /tenants/:tenantId/members/:userId`

Remove a tenant member. **Scope**: `admin:tenant`, caller must be tenant owner/admin.

#### `POST /users`

Create a user (auto-creates personal tenant + personal workspace, both owned by the user). **Scope**: `admin:tenant`; a user-bound caller must be `owner` or `admin` of its own tenant (403 otherwise). The new user joins no tenant of the caller's: invite it with `POST /tenants/:tenantId/members`, which finds accounts the caller's tenant provisioned.

```json
// Response 201
{
  "user": {
    "id": "user_1",
    "email": "a@b.com",
    "displayName": null,
    "personalTenantId": "tenant_1",
    "createdAt": "..."
  },
  "personalTenant": {
    "id": "tenant_1",
    "name": "a@b.com",
    "kind": "personal",
    "plan": "free",
    "createdAt": "..."
  },
  "personalWorkspace": {
    "id": "ws_1",
    "name": "a@b.com's workspace",
    "slug": null,
    "tenantId": "tenant_1",
    "visibility": "private",
    "createdAt": "..."
  }
}
```

400 if the email is already registered.

#### `GET /users/me`

Get the current user's row (id/email/displayName/personalTenantId), derived from the API key's `userId` binding (not `actorId` — see "Provenance identity" in CLAUDE.md). **Scope**: `memory:read`. Distinct from `GET /me` (below), which returns auth-context fields (scopes, workspaceRole, etc), not the DB user row.

#### `POST /tenants/:tenantId/workspaces`

Create a workspace inside a tenant. **Scope**: `admin:tenant`; a user-bound caller must be tenant `owner` or `admin`. `ownerUserId` defaults to the caller's own user and must be a member of the tenant (403 otherwise, nothing created); the owner gets the workspace's first membership, role `owner`. A key with no user and no `ownerUserId` creates a workspace with no member.

```json
// Request
{ "name": "Prod memory", "slug": "prod", "visibility": "private", "ownerUserId": "user_1" }
// Response 201
{ "id": "ws_2", "name": "Prod memory", "slug": "prod", "tenantId": "tenant_1", "visibility": "private", "createdAt": "..." }
```

#### `GET /tenants/:tenantId/workspaces`

List workspaces in a tenant. **Scope**: `admin:tenant`.

```json
// Response 200
{
  "workspaces": [
    { "id": "ws_1", "name": "...", "slug": null, "visibility": "private", "memberCount": 3 }
  ]
}
```

#### `GET /workspaces/mine`

List workspaces the authenticated user belongs to, WITH the caller's role in each. **Scope**: any of `memory:read`, `memory:admin` (a `read`-role member must still be able to discover their own memberships — see MULTI_TENANCY.md's role→scope table). 404 when the key has no user binding.

```json
// Response 200
{
  "workspaces": [
    {
      "workspaceId": "ws_1",
      "workspaceName": "Prod memory",
      "role": "write",
      "visibility": "private"
    }
  ]
}
```

#### `GET /workspaces/:workspaceId`

Get a workspace by id. Membership required — returns 404 (not 403) for a non-member, per the anti-probing invariant (CLAUDE.md S6). **Scope**: `memory:read` or `memory:admin`.

#### `POST /workspaces/:workspaceId/members`

Invite a user to a workspace with a `WorkspaceRole` (default `read`). **Scope**: `memory:admin`, caller must be workspace owner/admin. The invited user must already belong to the workspace's tenant (403 otherwise).

```json
// Request
{ "userId": "user_2", "role": "write" }
```

#### `GET /workspaces/:workspaceId/members`

List workspace members with their `WorkspaceRole`. **Scope**: `memory:read` or `memory:admin`.

#### `DELETE /workspaces/:workspaceId/members/:userId`

Remove a workspace member. **Scope**: `memory:admin`, caller must be workspace owner/admin.

#### `PATCH /workspaces/:workspaceId/members/:userId`

Change a workspace member's role. **Scope**: `memory:admin`, caller must be workspace owner/admin.

```json
// Request
{ "role": "admin" }
```

#### `POST /tenants/:tenantId/users/:userId/tokens`

Mint a `uk_live_*` user token for **another** tenant member (not the caller). **Scope**: `admin:tenant`, caller must be tenant owner/admin — deliberately its own route, not a `POST /admin/keys` extension, because `admin:keys` is reachable at workspace-admin role post-narrowing and would let a workspace admin impersonate any tenant member. See MULTI_TENANCY.md.

```json
// Request
{ "label": "B's token", "homeWorkspaceId": "ws_1", "scopes": ["memory:read", "memory:write"], "expiresIn": "90d" }
// Response 201
{ "id": "uk_abc", "key": "uk_live_...", "label": "B's token", "scopes": ["memory:read", "memory:write"], "userId": "user_2", "tenantId": "tenant_1", "workspaceId": "ws_1", "expiresAt": "...", "createdAt": "..." }
```

`key` is returned **once** — never retrievable again. Validation order (each a distinct anti-probing 404 except the last, which is actionable so it stays 400): target is a tenant member → home workspace belongs to this tenant → target is a member of that workspace → requested scopes (if any) ⊆ the CALLER's own scopes.

#### `GET /tenants/:tenantId/users/:userId/tokens`

List a tenant member's user tokens (secrets masked — never returned after creation). **Scope**: `admin:tenant`, caller must be tenant owner/admin.

#### `DELETE /tenants/:tenantId/users/:userId/tokens/:keyId`

Revoke a user token. **Scope**: `admin:tenant`, caller must be tenant owner/admin. 404 if the token doesn't exist, is already revoked, or belongs to a different user/tenant.

---

## 3. MCP Tools

> **Implementation status (2026-06-22, v3.3):** All 26 tools are live in `@mnemo-ai/mcp`. 0 stubs.
> **Live (registered, 26):** memory_recall, memory_remember, memory_pin, memory_forget, memory_timeline, memory_search, memory_relate, memory_decide, memory_entity, memory_status, memory_remind_when, memory_consolidate, memory_episode_start, memory_episode_end, memory_event, memory_reasoning, memory_strategy, memory_self_edit, memory_hyperedge, memory_introspect, memory_anticipate, memory_compose, memory_workflow, memory_skill, memory_task, memory_session
> The tool schemas documented in this spec do not match the implemented tools 1:1 — the spec uses older names (Tool 1–13 numbering). See [packages/mcp/README.md](../../packages/mcp/README.md) for the authoritative live tool list and schemas.

The MCP server exposes tools via stdio. Tool calls are workspace-scoped by the API key used to connect the MCP server.

### 3.1 Dynamic Ephemeral Tools (Executable Memory) — FUTURE IDEA, NOT IMPLEMENTED

> **Note:** The `mnemo_exec_*` ephemeral-tool mechanism described below does **not exist** in the current implementation. No code in `@mnemo-ai/mcp` auto-registers tools at recall time. This section describes a future design idea and is retained for context only.

The idea: Mnemosyne could expand the agent's action space dynamically.
When `memory_recall` retrieves a `mnemo_skill` or `mnemo_workflow` primitive that the Core considers highly relevant (confidence > 0.9), the Mnemosyne MCP Server would automatically register an ephemeral tool on the fly.

- Example: If the agent recalls the skill "Deploy to pre-prod", an ephemeral tool `mnemo_exec_deploy_pre_prod` would become available in the MCP context.
- These tools would disappear when the session ends or the context shifts.

**Current reality:** skills and workflows are returned as structured recall results — the agent reads the steps and acts on them directly.

All tool schemas below are JSON Schema (Draft 7) compatible.

---

### Tool 1: `memory_recall`

Search memory for relevant knowledge. Returns facts, decisions, strategies ranked by relevance and worth.

```json
{
  "name": "memory_recall",
  "description": "Search your memory for relevant knowledge. Returns facts, decisions, strategies ranked by relevance and worth.",
  "inputSchema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": { "type": "string", "description": "Natural language question or topic" },
      "types": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["fact", "decision", "strategy", "episode", "workflow", "skill"]
        },
        "description": "Filter by memory type"
      },
      "limit": { "type": "number", "default": 5, "maximum": 20 },
      "includeGraph": {
        "type": "boolean",
        "default": false,
        "description": "Expand results via knowledge graph relations"
      },
      "asOf": {
        "type": "string",
        "format": "date-time",
        "description": "ISO date for time-travel query"
      }
    }
  }
}
```

**Example**:

```json
{ "query": "What do we know about Redis caching?", "types": ["fact", "strategy"], "limit": 3 }
```

**Response**: Array of memory items with `id`, `type`, `content`, `confidence`, `worth`, `relevanceScore`.

---

### Tool 2: `memory_remember`

Store new knowledge in long-term memory. Automatically detects conflicts and handles deduplication.

```json
{
  "name": "memory_remember",
  "inputSchema": {
    "type": "object",
    "required": ["content", "type"],
    "properties": {
      "content": { "type": "string", "description": "What to remember" },
      "type": { "type": "string", "enum": ["fact", "decision", "strategy", "workflow", "skill"] },
      "topicKey": {
        "type": "string",
        "description": "Stable key for evolving facts — same key = update, not duplicate"
      },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.8 },
      "relatedEntities": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Entity names to link"
      },
      "validUntil": {
        "type": "string",
        "format": "date-time",
        "description": "When this knowledge becomes outdated"
      }
    }
  }
}
```

**Example**:

```json
{
  "content": "PostgreSQL is the primary datastore. Redis is optional and gracefully degraded if unavailable.",
  "type": "fact",
  "topicKey": "infra/datastore-stack",
  "confidence": 0.99
}
```

---

### Tool 3: `memory_forget`

Mark knowledge as no longer valid. Closes the validity window but preserves history.

```json
{
  "name": "memory_forget",
  "inputSchema": {
    "type": "object",
    "required": ["factId", "reason"],
    "properties": {
      "factId": { "type": "string", "description": "ID of the fact to forget" },
      "reason": { "type": "string", "description": "Why this is no longer valid" }
    }
  }
}
```

**Example**:

```json
{ "factId": "fact_redis_v7", "reason": "Upgraded to Redis 8.0 in June 2026" }
```

---

### Tool 4: `memory_session`

Manage working session. Pin important turns, add scratch notes, collapse when done.

```json
{
  "name": "memory_session",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["pin", "scratch", "collapse", "discard"] },
      "pin": {
        "type": "object",
        "properties": {
          "turnIndex": { "type": "number" },
          "label": { "type": "string" }
        }
      },
      "scratch": {
        "type": "object",
        "properties": {
          "key": { "type": "string" },
          "value": {}
        }
      },
      "collapseHint": { "type": "string", "description": "Guidance for extraction during collapse" }
    }
  }
}
```

**Example (collapse)**:

```json
{ "action": "collapse", "collapseHint": "Extract decisions about pagination and auth" }
```

---

### Tool 5: `memory_task`

Create, update, delegate, or complete tasks. Completed tasks auto-generate strategies.

```json
{
  "name": "memory_task",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["create", "update", "delegate", "list", "complete"] },
      "create": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "priority": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
          "dueAt": { "type": "string", "format": "date-time" },
          "relatedFacts": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title"]
      },
      "update": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "status": {
            "type": "string",
            "enum": ["pending", "in_progress", "blocked", "completed", "cancelled"]
          },
          "outcome": { "type": "string" }
        },
        "required": ["taskId"]
      },
      "delegate": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "toAgent": { "type": "string" },
          "context": { "type": "string" }
        },
        "required": ["taskId", "toAgent"]
      },
      "complete": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "outcome": { "type": "string" },
          "lessonsLearned": { "type": "string" }
        },
        "required": ["taskId", "outcome"]
      },
      "list": {
        "type": "object",
        "properties": {
          "status": { "type": "string" },
          "assignedTo": { "type": "string" }
        }
      }
    }
  }
}
```

---

### Tool 6: `memory_event`

Record that something happened. Events are immutable and create temporal anchors.

```json
{
  "name": "memory_event",
  "inputSchema": {
    "type": "object",
    "required": ["name", "description", "type"],
    "properties": {
      "name": {
        "type": "string",
        "description": "Event name, e.g. 'deploy.success', 'user.complained'"
      },
      "description": { "type": "string" },
      "type": { "type": "string", "enum": ["system", "external", "user", "agent", "scheduled"] },
      "relatedEntities": { "type": "array", "items": { "type": "string" } },
      "metadata": { "type": "object" }
    }
  }
}
```

**Example**:

```json
{
  "name": "deploy.failure",
  "description": "v3.0.1 rollback triggered — p99 latency exceeded 2s",
  "type": "system",
  "relatedEntities": ["deploy_pipeline"],
  "metadata": { "version": "3.0.1", "p99Ms": 2340 }
}
```

---

### Tool 7: `memory_reasoning`

Check if you've solved a similar problem before (saves tokens via cached CoT).

```json
{
  "name": "memory_reasoning",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["resolve", "record", "feedback"] },
      "resolve": {
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"]
      },
      "record": {
        "type": "object",
        "properties": {
          "input": { "type": "string" },
          "reasoning": { "type": "string" },
          "output": { "type": "string" },
          "model": { "type": "string" }
        },
        "required": ["input", "reasoning", "output", "model"]
      },
      "feedback": {
        "type": "object",
        "properties": {
          "reasoningId": { "type": "string" },
          "outcome": { "type": "string", "enum": ["success", "failure"] }
        },
        "required": ["reasoningId", "outcome"]
      }
    }
  }
}
```

---

### Tool 8: `memory_self_edit`

Edit your own memory. Correct errors, strengthen useful knowledge, weaken unreliable facts.

```json
{
  "name": "memory_self_edit",
  "inputSchema": {
    "type": "object",
    "required": ["action", "target", "reason"],
    "properties": {
      "action": {
        "type": "string",
        "enum": ["append", "replace", "strengthen", "weaken", "reflect"]
      },
      "target": { "type": "string", "description": "fact_id or 'profile'" },
      "content": { "type": "string", "description": "New content for append or replace actions" },
      "reason": {
        "type": "string",
        "description": "Required — explains why this edit is warranted"
      }
    }
  }
}
```

**Example**:

```json
{
  "action": "strengthen",
  "target": "fact_pg_serializable",
  "reason": "Confirmed in production — zero idempotency collisions over 30 days"
}
```

---

### Tool 9: `memory_entity`

Manage entities (people, projects, systems) in your knowledge graph.

```json
{
  "name": "memory_entity",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["find", "create", "link", "graph"] },
      "find": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "create": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "kind": {
            "type": "string",
            "enum": ["person", "project", "system", "concept", "organization"]
          },
          "aliases": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["name", "kind"]
      },
      "link": {
        "type": "object",
        "properties": {
          "fromEntity": { "type": "string" },
          "toEntity": { "type": "string" },
          "verb": { "type": "string" },
          "context": { "type": "string" }
        },
        "required": ["fromEntity", "toEntity", "verb"]
      },
      "graph": {
        "type": "object",
        "properties": {
          "entityId": { "type": "string" },
          "depth": { "type": "number", "default": 2 }
        },
        "required": ["entityId"]
      }
    }
  }
}
```

---

### Tool 10: `memory_timeline`

Query the timeline of events and episodes. Useful for understanding what happened when.

```json
{
  "name": "memory_timeline",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "format": "date-time" },
      "to": { "type": "string", "format": "date-time" },
      "entityId": { "type": "string", "description": "Filter by entity" },
      "types": {
        "type": "array",
        "items": { "type": "string", "enum": ["event", "session", "episode", "task"] }
      },
      "limit": { "type": "number", "default": 20, "maximum": 100 }
    }
  }
}
```

---

### Tool 11: `memory_introspect`

Returns the workspace `SelfModel` (§31 meta-cognition, `buildSelfModel` in
`packages/core/src/cognitive/metacognition.ts`, served via
`GET /metacognition`): topics known well (high worth + evidence), knowledge
gaps (recalled often but low certainty), and an aggregate summary.

```json
{
  "name": "memory_introspect",
  "inputSchema": {
    "type": "object",
    "properties": {
      "aspect": {
        "type": "string",
        "enum": [
          "coverage",
          "trends",
          "gaps",
          "strengths",
          "all",
          "health",
          "worth",
          "drift",
          "types",
          "recent_changes"
        ],
        "default": "all"
      },
      "entity": {
        "type": "string",
        "description": "Case-insensitive substring filter on topic/entity name"
      },
      "limit": { "type": "number", "default": 10, "minimum": 1, "maximum": 200 }
    }
  }
}
```

No field is required — `aspect` defaults to `"all"`. The last five enum
values (`health`, `worth`, `drift`, `types`, `recent_changes`) are legacy §29
aliases the tool maps onto the real §31 aspects before calling the backend:
`health`→`all`, `worth`→`strengths`, `drift`→`trends`, `types`→`coverage`,
`recent_changes`→`trends`. `limit` caps each of the four returned lists
(`confidenceMap`, `strongTopics`, `strengths`, `gaps`) independently — it does
not limit the response as a whole.

**Example**:

```json
{ "aspect": "gaps", "limit": 5 }
```

**Response** (shape is always the same `SelfModel`; unrequested aspects come
back as empty arrays rather than being omitted):

```json
{
  "workspaceId": "ws_default",
  "generatedAt": "2026-06-09T06:00:00Z",
  "confidenceMap": [
    {
      "entity": "auth-module",
      "coverage": "familiar",
      "freshness": "recent",
      "factCount": 12,
      "avgWorth": 0.68
    }
  ],
  "strongTopics": [
    { "topicKey": "auth-module", "memoryCount": 12, "avgWorth": 0.81, "evidenceVolume": 9 }
  ],
  "strengths": [{ "topic": "auth-module", "avgWorth": 0.81, "factCount": 12 }],
  "gaps": [
    {
      "topicKey": "billing-webhooks",
      "gapScore": 0.62,
      "recallHits30d": 7,
      "avgWorth": 0.18,
      "memoryCount": 2,
      "suggestedAction": "search_codebase"
    }
  ],
  "summary": {
    "totalTopics": 34,
    "strongTopicsCount": 6,
    "gapsCount": 3,
    "blindCount": 1,
    "avgWorthAcrossWorkspace": 0.5421
  }
}
```

`trends` (only present when `aspect` is `"trends"` or `"all"`) is
`{ recallHitRate, avgRecallLatency, sessionCollapseQuality, strategySuccessRate }`,
each a `{ current, previous, delta }` triple.

---

### Tool 12: `memory_strategy`

Store or recall behavioral strategies — "when X, do Y" patterns learned from experience.

```json
{
  "name": "memory_strategy",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["recall", "store", "rate"] },
      "recall": {
        "type": "object",
        "properties": { "situation": { "type": "string" } },
        "required": ["situation"]
      },
      "store": {
        "type": "object",
        "properties": {
          "trigger": { "type": "string", "description": "When this situation occurs" },
          "action": { "type": "string", "description": "What to do" },
          "context": { "type": "string" },
          "relatedFacts": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["trigger", "action"]
      },
      "rate": {
        "type": "object",
        "properties": {
          "strategyId": { "type": "string" },
          "outcome": { "type": "string", "enum": ["success", "failure"] }
        },
        "required": ["strategyId", "outcome"]
      }
    }
  }
}
```

---

### Tool 13: `memory_anticipate`

Returns memories likely to be useful in the next few minutes (§8 Anticipation
Engine, `buildAnticipationFeed` in `packages/core/src/cognitive/anticipation.ts`,
served via `GET /anticipation`). It does not prefetch or warm any cache — it
just ranks and returns candidate memories.

```json
{
  "name": "memory_anticipate",
  "inputSchema": {
    "type": "object",
    "properties": {
      "recentlyRecalledId": {
        "type": "string",
        "description": "Last recalled memory id — drives sequential + co-occurrence predictions"
      },
      "context": {
        "type": "string",
        "maxLength": 500,
        "description": "Free-text query context — drives conditional predictions"
      },
      "lookAhead": {
        "type": "number",
        "minimum": 0,
        "maximum": 10080,
        "default": 30,
        "description": "Minutes to anticipate ahead (server-side default 30, max one week)"
      },
      "limit": { "type": "number", "minimum": 1, "maximum": 100 }
    }
  }
}
```

Every field is optional. Four signals with fixed weights summing to 1.0 are
blended: **sequential** (0.35, "recalling X is usually followed by Y within
minutes" — requires `recentlyRecalledId`), **periodic** (0.25, "this memory
shows up in this day-of-week/3h UTC slot" — always runs, no parameter
needed), **conditional** (0.25, "queries mentioning Z tend to recall this" —
requires `context`, independent of `recentlyRecalledId`), and
**co-occurrence/Hebbian** (0.15, "recalled together with X" — requires
`recentlyRecalledId`). An item hit by more than one signal sums its weighted
scores and comes back with `source: "blended"`. When `context` is supplied
and the server has an LLM adapter configured, `GET /anticipation`
additionally asks the LLM for 2-3 related search queries, runs them through
`core.recall()`, and merges any new hits into the feed (`source:
"conditional"`, low base score, deduplicated by id) — this enrichment is
purely additive and fails silently back to the statistical feed on any error.

**Example**:

```json
{ "recentlyRecalledId": "fact_042", "context": "auth module refactor", "lookAhead": 30 }
```

**Response**:

```json
{
  "workspaceId": "ws_default",
  "generatedAt": "2026-06-09T06:00:00Z",
  "cue": { "recentlyRecalledId": "fact_042" },
  "items": [
    {
      "id": "fact_017",
      "score": 0.31,
      "source": "blended",
      "rationale": "Follows fact_042 82% of the time (avg lag 45s). Also: Co-recalled with fact_042 6 times (Hebbian weight 0.71)."
    }
  ]
}
```

---

## 4. gRPC Service (ConnectRPC)

Status: **Implemented** (packages/server/src/grpc.ts — Wave R)  
Package: `@mnemo-ai/server` (ConnectRPC transport layer is internal to the server; proto definitions live in `packages/server/src/proto/`)  
Protocol: [ConnectRPC](https://connectrpc.com) (supports gRPC, gRPC-Web, Connect protocol)  
Transport: Connect and gRPC-Web over HTTP/1.1 on `PORT`; the gRPC protocol and the 2 bidirectional RPCs need the h2c listener on `MNEMO_GRPC_PORT` ([SDK_INTEGRATION.md](../integration/SDK_INTEGRATION.md) §5)

**Implemented RPCs:**

- **10 unary:** `Recall`, `Remember`, `Forget`, `ResolveReasoning`, `RecordReasoning`, `CreateTask`, `UpdateTask`, `RecordEvent`, `SelfEdit`, `GetHealth`
- **3 server-streaming:** `WatchMemory`, `WatchTasks`, `StreamHealth`
- **2 client-streaming:** `IngestBatch`, `ImportMemory`
- **2 bidirectional:** `Session` (session lifecycle bidi), `FederationSync` (drives SyncEngine)

```protobuf
syntax = "proto3";
package mnemosyne.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/struct.proto";

service MnemosyneService {
  // ─── Unary ───────────────────────────────────────────────────────────
  rpc Recall(RecallRequest) returns (RecallResponse);
  rpc Remember(RememberRequest) returns (RememberResponse);
  rpc Forget(ForgetRequest) returns (ForgetResponse);
  rpc ResolveReasoning(ResolveReasoningRequest) returns (ResolveReasoningResponse);
  rpc RecordReasoning(RecordReasoningRequest) returns (RecordReasoningResponse);
  rpc CreateTask(CreateTaskRequest) returns (Task);
  rpc UpdateTask(UpdateTaskRequest) returns (Task);
  rpc RecordEvent(RecordEventRequest) returns (Event);
  rpc SelfEdit(SelfEditRequest) returns (SelfEditResponse);
  rpc GetHealth(HealthRequest) returns (HealthSnapshot);

  // ─── Server Streaming ────────────────────────────────────────────────
  rpc WatchMemory(WatchMemoryRequest) returns (stream MemoryEvent);
  rpc WatchTasks(WatchTasksRequest) returns (stream TaskEvent);
  rpc StreamHealth(HealthRequest) returns (stream HealthSnapshot);

  // ─── Client Streaming ────────────────────────────────────────────────
  rpc IngestBatch(stream IngestItem) returns (IngestSummary);
  rpc ImportMemory(stream MemoryChunk) returns (ImportResult);

  // ─── Bidirectional Streaming ─────────────────────────────────────────
  rpc Session(stream SessionMessage) returns (stream SessionResponse);
  rpc FederationSync(stream SyncMessage) returns (stream SyncMessage);
}

// ─── Core Messages ───────────────────────────────────────────────────────

message RecallRequest {
  string query = 1;
  repeated string types = 2;
  int32 limit = 3;             // default 5
  bool include_graph = 4;
  string as_of = 5;            // ISO 8601 timestamp string
}

message RecallResponse {
  repeated MemoryItem results = 1;
  string mode = 2;             // "hybrid" | "fts_only" | "hot"
  int64 took_ms = 3;
}

message MemoryItem {
  string id = 1;
  string type = 2;
  string content = 3;
  double confidence = 4;
  double worth = 5;
  double relevance_score = 6;
  string valid_from = 7;
  string valid_to = 8;
}

message RememberRequest {
  string content = 1;
  string type = 2;             // "fact" | "decision" | "strategy" | "workflow" | "skill"
  string topic_key = 3;
  double confidence = 4;
  repeated string related_entities = 5;
  string valid_until = 6;
}

message RememberResponse {
  string id = 1;
  bool conflict_detected = 2;
  string conflicting_id = 3;   // Set if conflict_detected = true
  int32 revision = 4;
}

message ForgetRequest {
  string fact_id = 1;
  string reason = 2;
}

message ForgetResponse {
  bool archived = 1;
  string archived_at = 2;
}

// ─── Watch / Streaming ───────────────────────────────────────────────────

message WatchMemoryRequest {
  repeated string channels = 1;  // e.g. "facts.*", "tasks.*"
  string agent_id = 2;
  string entity_id = 3;
}

message MemoryEvent {
  string id = 1;
  string channel = 2;
  string type = 3;
  google.protobuf.Struct payload = 4;
  google.protobuf.Timestamp timestamp = 5;
  string trace_id = 6;
}

message TaskEvent {
  string task_id = 1;
  string previous_status = 2;
  string new_status = 3;
  google.protobuf.Timestamp occurred_at = 4;
}

message HealthSnapshot {
  string status = 1;             // "healthy" | "degraded" | "down"
  string recall_mode = 2;
  map<string, string> checks = 3;
  google.protobuf.Timestamp snapshot_at = 4;
}

// ─── Session Bidirectional ───────────────────────────────────────────────

message SessionMessage {
  oneof payload {
    StartSession start = 1;
    AddTurn turn = 2;
    PinTurn pin = 3;
    ScratchUpdate scratch = 4;
    CollapseSession collapse = 5;
    DiscardSession discard = 6;
  }
}

message SessionResponse {
  oneof payload {
    SessionStarted started = 1;
    TurnAdded turn_added = 2;
    CollapseStarted collapse_started = 3;
    CollapseCompleted collapse_completed = 4;
    SessionError error = 5;
  }
}

// ─── Federation Bidirectional ────────────────────────────────────────────

message SyncMessage {
  string peer_id = 1;
  string sync_cursor = 2;
  repeated SyncItem items = 3;
  bool end_of_batch = 4;
}

message SyncItem {
  string id = 1;
  string type = 2;
  bytes payload = 3;            // CBOR-encoded knowledge unit
  string content_hash = 4;
  string region = 5;
}
```

**Authentication**: gRPC metadata header `authorization: Bearer mk_live_xxx`

---

## 5. WebSocket Protocol

Status: **Implemented**  
Endpoint: `ws://host/memory/ws`

### 5.1 Connection

```
ws://host/memory/ws?token=mk_live_xxx
```

Alternatively, pass the token in the `Sec-WebSocket-Protocol` header (for environments where query strings are not available).

### 5.2 Subscribe Message

Sent by the client immediately after connection (or on reconnect).

```json
{
  "action": "subscribe",
  "channels": ["facts.*", "tasks.*", "session.sess_abc123", "health"],
  "filter": {
    "entityId": "ent_pg_001",
    "agentId": "agent_coder_01"
  }
}
```

**Available channels:**

| Channel             | Description                                  |
| ------------------- | -------------------------------------------- |
| `facts.*`           | All fact events (created, updated, archived) |
| `facts.created`     | New facts only                               |
| `tasks.*`           | Task state changes                           |
| `events.*`          | New events recorded                          |
| `session.{id}`      | Updates for a specific session               |
| `agent.{id}.recall` | What a specific agent is recalling           |
| `health`            | Health metric updates                        |
| `federation.sync`   | Cross-instance sync activity                 |

### 5.3 Server Push Events

```json
{
  "id": "evt_ws12_1717500000000_0042",
  "channel": "facts.created",
  "type": "fact.created",
  "payload": {
    "id": "fact_xyz",
    "content": "Redis 8.0 deployed to production",
    "confidence": 0.97
  },
  "timestamp": "2026-06-09T12:00:00Z",
  "traceId": "trace_abc123"
}
```

**Event types:**

| Event Type            | Trigger                            |
| --------------------- | ---------------------------------- |
| `fact.created`        | New fact stored                    |
| `fact.updated`        | Fact revised                       |
| `fact.archived`       | Fact soft-deleted                  |
| `task.created`        | Task created                       |
| `task.transitioned`   | Task status changed                |
| `task.completed`      | Task completed                     |
| `event.recorded`      | Immutable event recorded           |
| `recall.hit`          | Agent recalled from memory         |
| `session.collapsed`   | Session collapsed to knowledge     |
| `health.alert`        | Health check degraded or recovered |
| `federation.conflict` | Cross-instance conflict detected   |

### 5.4 Reconnection and Event Replay

On reconnect, send a `resubscribe` message with the last received event ID:

```json
{
  "action": "resubscribe",
  "channels": ["facts.*", "tasks.*"],
  "lastEventId": "evt_ws12_1717500000000_0042"
}
```

**Server response — replay (event still in buffer):**

```json
{
  "type": "replay",
  "events": [ ... ],
  "gapDetected": false
}
```

**Server response — gap (event evicted from buffer):**

```json
{
  "type": "gap",
  "oldestAvailable": "evt_ws12_1717500100000_0001",
  "message": "Events between your lastEventId and this point are lost. Use GET /memory/events?since=... to sync."
}
```

**Buffer policy:**

- Per-channel ring buffer: 1000 events, max age 1 hour
- Storage: Redis list key `mnemo:{workspace}:ws_buffer:{channel}`
- Event ID format: `evt_{workspace_short}_{timestamp_ms}_{sequence}` — monotonically increasing per workspace

### 5.5 Backpressure

- Drop policy: `drop_oldest` (ring buffer evicts oldest events when full)
- Slow consumer detection: connection lagging > 500ms P99 is flagged
- Slow consumers receive a `slowConsumer` warning event; if unresolved after 30s, the connection is closed with code 1008

---

## 6. Error Format

All errors use a nested `error` envelope (Stripe-style). The wire shape is:

```json
{
  "error": {
    "type": "conflict_error",
    "code": "conflict",
    "message": "A fact with similar content already exists",
    "param": "statement",
    "details": {
      "existing_fact_id": "fact_xyz789",
      "similarity": 0.92
    },
    "request_id": "req_abc123"
  }
}
```

Fields:

- `type` — Stripe-style category string derived from HTTP status: `invalid_request_error` (400/422), `authentication_error` (401), `permission_error` (403), `not_found_error` (404), `conflict_error` (409), `rate_limit_error` (429), `api_error` (500/other)
- `code` — machine-readable snake_case code (stable contract)
- `message` — human-readable description
- `param` — (optional) field name that caused a 400 validation error
- `details` — (optional) structured bag of extra context
- `request_id` — (optional) request ID for support correlation
- `retryable` — whether retrying the same request later can succeed (429 and 503)
- `retryAfterSeconds` — (optional) how long to wait, equal to the `Retry-After` header

### Error Codes

All codes are stable across API versions. Removal requires a version gate.

| Code                          | HTTP Status | Description                                                                                                                      |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `not_found`                   | 404         | Requested resource does not exist                                                                                                |
| `conflict`                    | 409         | Content conflict (e.g. near-duplicate fact). `details.existing_fact_id` and `details.similarity` provided                        |
| `rate_limited`                | 429         | Rate limit exceeded. `Retry-After` header set. `details.limit_type` indicates which layer                                        |
| `forbidden`                   | 403         | API key lacks the required scope. `details.required_scope` provided                                                              |
| `unprocessable_entity`        | 422         | Request body failed schema validation. `param` indicates the failing field                                                       |
| `poisoning_rejected`          | 422         | Content refused by the poisoning gate. `details.categories` lists what matched; the matched text is never returned               |
| `service_unavailable`         | 503         | Database down or too slow right now, or a storage circuit breaker open. `Retry-After` set; a write's outcome is unknown          |
| `semantic_search_unavailable` | 503         | `mode:"semantic"` recall with no embedder answering. `Retry-After` set                                                           |
| `capability_unavailable`      | 503         | Feature requires a provider (LLM/embedding/Redis) that is not configured or currently unavailable                                |
| `degraded`                    | 206         | Request succeeded but with reduced quality (e.g. FTS fallback used instead of vector search). Informational — not an error state |
| `internal_error`              | 500         | Unexpected server error. `error.request_id` provided for support                                                                 |

### Curl Example

```bash
curl -s -X POST https://mnemo.example.com/remember \
  -H "Authorization: Bearer mns_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "statement": "Redis is optional" }' \
  | jq '.error.code'
# "conflict"
```

---

## 7. Pagination

All list endpoints use cursor-based pagination. Offset pagination is not supported.

### Request

```
GET /timeline?cursor=eyJpZCI6ImV2dF8wMDEiLCJ0cyI6MTcxNzUwMDAwMH0&limit=20
```

- `cursor`: opaque string (base64-encoded composite key — do not parse)
- `limit`: 1–100, default 20

### Response

```json
{
  "data": [ ... ],
  "cursor": "eyJpZCI6ImV2dF8wMjAiLCJ0cyI6MTcxNzUwMDIwMH0",
  "hasMore": true
}
```

- Cursor is stable under concurrent writes (unlike offset, which drifts when new records insert before the current page)
- When `hasMore` is `false`, `cursor` is omitted
- Cursors expire after 24 hours; expired cursors return `unprocessable_entity`

---

## 8. API Versioning

Mnemosyne uses **date-based versioning** (Stripe pattern), not semver or URL path versioning. There is no `/v1/` path prefix on the wire at all (see the note at the top of this document) — versioning is carried entirely by the `Mnemosyne-Version` header below, not by the path.

### Version Header

```
Mnemosyne-Version: 2026-06-15
```

**Behavior:**

- First API call from a workspace auto-pins that workspace to the current version
- Subsequent calls use the pinned version unless the header overrides it
- Workspace can upgrade globally via Studio (one-way, irreversible)

### Compatibility Rules

| Change type                    | Version gate required |
| ------------------------------ | --------------------- |
| Add new field to response      | No (additive)         |
| Add new endpoint               | No (additive)         |
| Remove field from response     | Yes                   |
| Change field type or semantics | Yes                   |
| Remove endpoint                | Yes                   |
| Change error code meaning      | Yes                   |

### Version Gate Module (internal)

Each backwards-incompatible change ships as a self-contained module:

```typescript
{
  date: "2026-06-15",
  description: "recall response includes worth scores",
  transform: {
    backward: (response) => { delete response.results[*].worth; return response; },
    forward: (request) => request   // no request shape change
  }
}
```

On each request: walk backward through all gates from latest down to the workspace's pinned version, transforming the response at the edge. Core code always runs at latest.

---

## 9. Idempotency

Supported on all `POST` endpoints that create or mutate state.

### Header

```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

- Value: client-generated UUID (any format)
- TTL: 72 hours
- Scope: per workspace (same key from different workspaces is independent)
- Concurrent duplicates: second request receives `409 conflict` until first completes, then replays stored response

### Multi-Phase Recovery Points

For long-running operations (e.g., `POST /session/:id/collapse`):

| Recovery Point    | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `session_locked`  | Session marked as collapsing; safe to retry                      |
| `llm_called`      | LLM summarization complete; safe to retry without re-calling LLM |
| `facts_persisted` | Knowledge units written to PostgreSQL                            |
| `completed`       | Session removed from Redis; full response stored                 |

On retry: the operation resumes from the last persisted recovery point, skipping completed phases. All local writes happen before external calls (LLM), ensuring safe retry if the LLM call fails mid-flight.

---

## 10. Response Headers

Every response includes these headers:

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 587
X-RateLimit-Reset: 1717500060
X-Request-Id: req_abc123xyz
Mnemosyne-Version: 2026-06-15
```

On `429`:

```
Retry-After: 13
Mnemosyne-Rate-Limited-Reason: request_rate
```

`Mnemosyne-Rate-Limited-Reason` values: `request_rate` and `concurrency` (`429`), `fleet_shed` (`503`, `Retry-After: 5`)

---

## 11. Webhook Delivery

### Registration

```bash
curl -X POST https://mnemo.example.com/webhooks \
  -H "Authorization: Bearer mk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.example.com/hooks/mnemo",
    "events": ["fact.created", "task.completed", "session.collapsed"],
    "secret": "whsec_your_signing_secret"
  }'
```

```json
// Response 201
{
  "id": "wh_001",
  "url": "https://yourapp.example.com/hooks/mnemo",
  "events": ["fact.created", "task.completed", "session.collapsed"],
  "status": "active",
  "createdAt": "2026-06-09T12:00:00Z"
}
```

### Payload Signing

Every delivery includes `Mnemosyne-Signature`:

```
Mnemosyne-Signature: t=1717500060,v1=3a4b5c6d...
```

Verification:

1. Parse `t` (Unix timestamp) and `v1` (HMAC-SHA256 hex digest)
2. Reject if `|now - t| > 300` seconds (replay protection)
3. Compute `HMAC-SHA256(webhook_secret, t + "." + raw_body)`
4. Compare to `v1` using constant-time equality

### Delivery Guarantees

- **Ordering**: best-effort (use `event.timestamp` to order, not delivery sequence)
- **Delivery**: at-least-once (receiver must deduplicate on `event.id`)
- **Timeout**: endpoint must respond `2xx` within 10 seconds

### Retry Schedule

| Attempt | Delay      |
| ------- | ---------- |
| 1       | Immediate  |
| 2       | 5 minutes  |
| 3       | 30 minutes |
| 4       | 2 hours    |
| 5       | 24 hours   |

After 5 failures: moved to dead-letter queue.  
After 3 consecutive endpoint failures: endpoint disabled, workspace admin alerted.

### Subscribable Events

| Event                 | Trigger                              |
| --------------------- | ------------------------------------ |
| `fact.created`        | New fact written                     |
| `fact.updated`        | Fact revised                         |
| `fact.archived`       | Fact soft-deleted                    |
| `decision.created`    | Decision recorded                    |
| `decision.superseded` | Decision replaced by newer one       |
| `task.created`        | Task created                         |
| `task.completed`      | Task completed                       |
| `task.delegated`      | Task delegated to another agent      |
| `session.collapsed`   | Session collapsed to knowledge units |
| `event.recorded`      | Immutable event recorded             |
| `health.alert`        | Health check status changed          |
| `federation.conflict` | Cross-instance conflict detected     |

### Webhook Event Payload

```json
{
  "id": "evt_wh_abc123",
  "type": "fact.created",
  "created": 1717500060,
  "workspaceId": "ws_default",
  "data": {
    "object": "fact",
    "id": "fact_xyz789",
    "content": "Redis 8.0 deployed to production",
    "confidence": 0.97,
    "createdAt": "2026-06-09T12:00:00Z"
  }
}
```

---

## 12. Rate Limits

Four-layer architecture. Fail-open: if Redis rate-limit store is unavailable, all traffic is allowed.

| Layer                       | Scope        | Free              | Pro                 | Enterprise            |
| --------------------------- | ------------ | ----------------- | ------------------- | --------------------- |
| Request rate (token bucket) | Per API key  | 10 rps / burst 20 | 100 rps / burst 200 | 1000 rps / burst 2000 |
| Concurrency                 | Per API key  | 5 in-flight       | 25 in-flight        | 100 in-flight         |
| Fleet load shed             | Global       | —                 | —                   | —                     |
| Worker utilization          | Per instance | —                 | —                   | —                     |

The request-rate bucket is kept per operation class (recall, write, export, admin, federation,
other). `POST /session/:id/turn` has its own `turn` class (600/min, burst 100 on the free plan), so
flushing a long transcript does not spend the write budget. A request turned away for concurrency
spends no rate token. On `429`, `Retry-After` is the bucket's real refill time (1 s for
concurrency), also given as `error.details.retryAfterSeconds`.

**Fleet load shedding priority:**

| Priority              | Endpoints                 | Shed at fleet utilization |
| --------------------- | ------------------------- | ------------------------- |
| Critical (never shed) | recall, session.collapse  | —                         |
| Important             | write, reasoning.resolve  | 85%                       |
| Normal                | export, admin, federation | 70%                       |

**Worker utilization shedding order** (when instance CPU > 90%):

1. `mk_test_*` keys first
2. GET requests
3. POST requests
4. Critical paths last (return `503` with `Retry-After` as last resort)

---

---

## 13. Recall Projection

`POST /recall` returns JSON only. There is no `?format=` query parameter and no
`renderRecallResults()` export. How much of each hit comes back is chosen with the `projection`
body field (`packages/server/src/routes/recall.ts`):

| `projection`     | Each hit's `content`                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `full` (default) | The whole text.                                                                                                                               |
| `compact`        | The first 300 characters, plus `truncated: true` on hits that were cut. Hits of 300 characters or fewer, and federated hits, come back whole. |

The rest of the hit (`id`, `kind`, `score`, `similarity`, `validFrom`, `validTo`, `tags`,
`sensitivity`, `status`, …) is the same in both. Truncation happens at the HTTP boundary: ranking
always runs over the whole text. To read a truncated hit in full, fetch it by id with
`GET /facts/:id` (the `memory_fact` MCP tool does this).

```json
// POST /recall
{ "query": "auth module", "topK": 5, "projection": "compact" }
```

For prompt injection from TypeScript, `@mnemo-ai/core` exports `renderFactsCompact(facts, opts)`,
which renders `MnemoFact[]` (not recall hits) into a token-budgeted block (`maxTokensApprox`,
default 200; `format: "structured" | "prose"`).

---

_The authoritative contract is `GET /openapi.json`; this document is a guide to it. Breaking changes require a version gate module and at minimum 90 days notice to pinned workspaces._
