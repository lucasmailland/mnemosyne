# Extended reference — Mnemosyne MCP tools

**English** · [Español](MCP_TOOLS.es.md)

> Day-to-day reference for the 37 Mnemosyne MCP tools (`packages/mcp/src/tools/`). Each tool was investigated against the real source code (Zod schemas, HTTP handlers in `packages/server/src/routes/`, business logic in `packages/core/`), not against the tool's one-line description or `docs/architecture/API.md`, which in several cases (`memory_introspect`, `memory_anticipate`, `memory_status`) documents outdated or outright invented contracts.
>
> For a higher-level introduction (setup, MCP↔server architecture, passive capture), see [`MCP_GUIDE.md`](./MCP_GUIDE.md), which this document complements and does not replace. The focus here is each tool in depth: what it does internally, all of its parameters, real use cases, and above all **edge cases and verified discrepancies between what the tool promises and what the code actually does**.
>
> Last code verification: 2026-08-09.
>
> The example payloads in this guide are sample data, written in Spanish.

## Index

**Core memory**: [`memory_context`](#memory_context) · [`memory_recall`](#memory_recall) · [`memory_remember`](#memory_remember) · [`memory_forget`](#memory_forget) · [`memory_search`](#memory_search) · [`memory_status`](#memory_status) · [`memory_relate`](#memory_relate)

**Decisions and entities**: [`memory_decide`](#memory_decide) · [`memory_entity`](#memory_entity) · [`memory_pin`](#memory_pin) · [`memory_timeline`](#memory_timeline) · [`memory_episode_start`](#memory_episode_start) · [`memory_episode_end`](#memory_episode_end) · [`memory_consolidate`](#memory_consolidate)

**Advanced editing and admin**: [`memory_remind_when`](#memory_remind_when) · [`memory_self_edit`](#memory_self_edit) · [`memory_update`](#memory_update) · [`memory_judge`](#memory_judge) · [`memory_doctor`](#memory_doctor) · [`memory_stats`](#memory_stats) · [`memory_purge`](#memory_purge)

**Sessions, tasks, and events**: [`memory_compare`](#memory_compare) · [`memory_session`](#memory_session) · [`memory_task`](#memory_task) · [`memory_event`](#memory_event) · [`memory_reasoning`](#memory_reasoning) · [`memory_strategy`](#memory_strategy) · [`memory_hyperedge`](#memory_hyperedge)

**Metacognition and workspace**: [`memory_introspect`](#memory_introspect) · [`memory_anticipate`](#memory_anticipate) · [`memory_compose`](#memory_compose) · [`memory_workflow`](#memory_workflow) · [`memory_skill`](#memory_skill) · [`memory_workspace`](#memory_workspace) · [`memory_suggest_topic_key`](#memory_suggest_topic_key)

See also the summary of [verified critical findings](#verified-critical-findings-summary) at the end of the document. It is the consolidated list of real discrepancies between documentation or tool names and code behavior, useful as a quick checklist before relying on any of these tools in a critical flow.

---

# Reference documentation — Mnemosyne MCP tools

## `memory_context`

**What it does**: This is the session orientation tool. In a single call it returns the full identity behind the active API key or token: the workspace the agent is operating in (including its real **role** there: `owner`/`admin`/`write`/`read`), the user and tenant associated with the key, lightweight workspace stats, and a list of the caller's own workspace memberships.

It exists as a separate tool from `memory_recall` because it serves a different purpose: it does not search memory, it tells the agent "where am I and what can I do" before operating. The code states explicitly (handler comment) that the active workspace is **fixed for the whole session**. The API key or token determines it when the process starts, and no tool changes it mid-session. This is a deliberate design decision (M2/M4): switching workspaces in the middle of a task would silently fragment memory (you write to B, then recall from A, and never find out). If you need another workspace, you must start a new session with the corresponding key or token, or, if the key is a `uk_live_*` (user token), set `X-Workspace-Id` through `MNEMO_WORKSPACE_ID` **before** the first tool call.

Internally it makes 3 calls in parallel: `GET /me` (key identity), `GET /admin/stats` (stats, optional), and `listMyWorkspaces()`. For the "other workspaces" list it uses **`GET /workspaces/mine`** as the primary source (the caller's own memberships). If that list comes back empty, it falls back to `GET /tenants/:tenantId/workspaces` (all workspaces of the tenant) as a labeled fallback (`workspacesSource: "tenant_fallback"`). This fixes a historical bug (fixed 2026-07-31): previously the _tenant's_ workspace list was the primary source, which showed other people's workspaces as if they belonged to the caller.

**Parameters**:

| Parameter                | Type    | Required | Default | Description                                                                                                                        |
| ------------------------ | ------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `includeStats`           | boolean | No       | `true`  | Includes workspace stats (facts, sessions, last recall)                                                                            |
| `includeOtherWorkspaces` | boolean | No       | `true`  | Lists the caller's own workspace memberships (falls back to the tenant's workspaces if the caller has no memberships of their own) |

**When to use it — use cases**:

- At the start of an agent session, to confirm which workspace will be written to and recalled from before the first write.
- Before attempting a write (`memory_remember`, `memory_decide`, etc.) when you do not know whether the key or role has write permission, which avoids spending a call that returns 403.
- To get the `personalWorkspaceId` or `tenantId` needed as parameters of other tools (`targetWorkspaceId`, `scopeOwner: 'tenant:<id>'`).
- To diagnose why a key cannot see certain workspaces (check `otherWorkspacesSource`: if it is `tenant_fallback`, the key has no memberships of its own).

**Edge cases and gotchas**:

- If the caller's role in the active workspace is `'read'`, the response includes an explicit `_roleNote` field warning that writes will return 403 and that retrying will not help. You must ask a workspace admin to raise the role.
- All sub-calls (`getMe`, `getStats`, `listMyWorkspaces`, `listWorkspacesForCurrentTenant`) are wrapped in `.catch(() => null)`. A partial failure (for example, stats unavailable) never makes the whole tool fail; it simply omits that section of the response.
- The `key.scopes` field reflects the credential's _raw_ scopes, not the real permission ceiling. In practice the workspace role (`workspaceRole`) is what governs.
- The file's JSDoc records that an earlier version of this comment documented a `memory_remember(..., workspaceId=...)` parameter that **never existed**. It was removed. This is a reminder that documentation embedded in code can go stale and must be checked against the real schema.

**Examples**:

```json
{}
```

(all parameters are optional with default `true`)

```json
{ "includeStats": false, "includeOtherWorkspaces": true }
```

Typical response (abridged):

```json
{
  "workspace": { "id": "ws_...", "name": "acme-prod", "plan": "pro", "role": "write" },
  "key": { "id": "mns_live_...", "actorType": "agent", "scopes": ["memory:write", "memory:read"] },
  "user": { "id": "user_...", "personalWorkspaceId": "ws_personal_..." },
  "tenant": { "id": "tenant_..." },
  "stats": { "factsLive": 128, "factsPinned": 4, "lastRecallAt": "2026-08-05T10:00:00Z" },
  "otherWorkspaces": [{ "id": "ws_...", "role": "admin" }],
  "otherWorkspacesSource": "membership",
  "_note": "The active workspace is FIXED for the whole session..."
}
```

---

## `memory_recall`

**What it does**: Runs the 7-stage "cold" recall pipeline against the workspace memory: parsing the query into an embedding plus filters → HNSW vector search (top 50) → 1-hop relation expansion → Petrov activation scoring (`A(t) = ln(∑ t_j^-d)`, d=0.5) → worth weighting → sensitivity ceiling filter plus CaMeL contest → `RecallHit[]` assembly. It is the most complete durable-knowledge retrieval tool in the set: it combines lexical (FTS) and vector search in `hybrid`/`auto` mode, supports bitemporal recall (`asOf`), and applies the full pipeline (not the "hot" shortcut from Redis).

On the server, the `POST /recall` route resolves a `RecallQuery` that also implements the "CALMem token-budget ladder" (§17): `tokenBudget` decides how many stages to run (hot-only, hot+pointer, or the full pipeline), and a RecMem gate decides whether it is worth spending an LLM rerank call (default: `rerank: true`, but the gate itself skips the LLM if the recurrence signal among candidates is below `recurrenceThreshold`, default 0.6, which is the "87% savings" path). It also performs **multi-level recall**: if the key has a `userId` and/or `tenantId`, it automatically merges hits from the active workspace, the user's personal workspace (weight 0.8), and the tenant's facts. **Fixed (B1, 2026-08-10)**: passing `scope: 'personal'` now does restrict the result. `multiLevelRecall` runs in `{ only: 'personal' }` mode, skipping workspace and tenant and returning only hits from the user's personal workspace, with weight 1.0 instead of 0.8. Without that `scope`, the automatic merge behavior described above stays the same.

The output payload is wrapped with `_mnemo_label: "untrusted_external_content"` (CaMeL style). The intent is for the calling model to treat the recalled content as untrusted external data, not as instructions to execute.

**Parameters**:

| Parameter      | Type                                         | Required | Default                                        | Description                                                                                                                                             |
| -------------- | -------------------------------------------- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`        | string (min 1)                               | Yes      | —                                              | Free text describing what you want to recall                                                                                                            |
| `limit`        | int [1,25]                                   | No       | 5 (maps to `topK`)                             | Maximum number of hits. The server accepts up to 100, but the tool clamps to 25 to bound the payload                                                    |
| `asOf`         | string ISO 8601 datetime                     | No       | now                                            | Bitemporal recall: what the memory knew at that instant                                                                                                 |
| `scope`        | enum `global`\|`conversation`\|`personal`    | No       | (all)                                          | Filters by scope. `'personal'` restricts to the caller's personal workspace only (weight 1.0). Fixed in B1; see the gotcha below                        |
| `scopeRef`     | string                                       | No       | —                                              | Filters by project/entity (for example `'mnemosyne'`). If it names a `project` entity (name or alias), it also brings in that project's other spellings |
| `actorId`      | string                                       | No       | —                                              | Filters by the exact `ActorRef` that wrote the fact (for example `"key:<id>"`). It is NOT reliably a userId                                             |
| `mode`         | enum `lexical`\|`semantic`\|`hybrid`\|`auto` | No       | `auto`                                         | Explicit ranking mode                                                                                                                                   |
| `vectorWeight` | number [0,1]                                 | No       | 0.5 on the server, but only if sent explicitly | Lexical/vector weight. Deprecated in favor of `mode`                                                                                                    |
| `sessionId`    | string                                       | No       | —                                              | Active session id; marks `lastRecallAt` on a best-effort basis; an invalid id is silently ignored                                                       |

**When to use it — use cases**:

- A coding agent resumes a task and needs to recover earlier architectural decisions about the module it is about to touch.
- Before suggesting a solution, recall explicit user preferences (for example "the client prefers library X") so that an already-corrected mistake is not repeated.
- Bitemporal recall to audit "what did the system know about this client last month, before this change?" using `asOf`.
- Filter by `scopeRef` to isolate the recalled context to a specific project when the workspace mixes memory from several repos.

**Edge cases and gotchas**:

- **`scope: 'personal'` DOES filter to only facts from the personal workspace (fixed, B1, 2026-08-10)**. `recall.ts` now detects `scope === "personal"` and calls `multiLevelRecall(..., { only: "personal" })`, which skips the workspace and tenant promises entirely and runs recall only against the caller's personal workspace, with weight 1.0 (not 0.8). If the key has no associated `userId`, or the user has no personal workspace configured, the server responds **400** with the same message that `memory_remember` uses for the same case. It never returns a silent empty result or a 500. The sensitivity ceiling filter still applies after the merge, unchanged. Omitting `scope` leaves the automatic merge behavior (weight 0.8) exactly as before.
- When `MNEMO_LLM_API_KEY` is not configured, it automatically degrades to full-text search (FTS). `debug.searchMode` reflects `"fts"` in that case; it does not fail.
- An explicit `mode: 'semantic'` DOES throw `semantic_search_unavailable` if no embedder is configured (unlike the default `'auto'`, which degrades silently). This is a deliberate design (B5.9, "no silent fallback").
- Historical bug fixed (MCP-1, 2026-07-29): previously, `mode`/`vectorWeight` were parsed in the schema but dropped before reaching `RecallQuery`, so every call resolved to `mode: "auto"` regardless of what was requested. This is fixed; both fields now actually reach `recallCold()`.
- An invalid or unknown `sessionId` never makes the recall fail. It is silently ignored (best-effort, via `setImmediate`).
- The `sensitivity ceiling` filter is applied twice on the server (before and after the plugin hooks). Ceiling violations do not appear as an error; the hit is simply excluded from the array (404-style anti-probing, not 403).

**Examples**:

```json
{ "query": "preferencias de deploy del cliente Acme", "limit": 10 }
```

```json
{
  "query": "qué decidimos sobre la estrategia de auth",
  "scopeRef": "mnemosyne",
  "mode": "hybrid",
  "asOf": "2026-06-01T00:00:00Z"
}
```

Response (abridged):

```json
{
  "memories": [{ "id": "mfact_...", "content": "...", "score": 0.83, "hitFreshness": "recent" }],
  "debug": { "embedded": false, "searchMode": "hybrid", "latencyMs": 42 },
  "_mnemo_label": "untrusted_external_content"
}
```

---

## `memory_remember`

**What it does**: Persists a new durable cognitive primitive in the workspace (by default `kind: 'fact'`, but it supports all 10 primitives except `hyperedge`, which requires `memberIds` and is only created through `POST /hyperedges`). Internally it calls `POST /remember`, which resolves the `kind`, validates the corresponding `subtype`, and delegates to `deps.cognitive.remember()`.

It has three overlapping idempotency/deduplication mechanisms, each with different semantics:

1. **Idempotency-Key** (global middleware §34.9, Stripe-style): if the same key is resent on a retry, the server returns the original response without re-executing. Implemented with `begin`/`complete` under SERIALIZABLE; a concurrent collision returns 409, and a reused key with a different request hash returns 422.
2. **Content-hash dedupe**: resending the same `statement` does not duplicate the fact.
3. **`topicKey`**: if an active fact/decision with the same `topicKey` already exists in the workspace, the call **updates it instead of creating a duplicate** (revision incremented). This only applies to `kind: 'fact'` and `'decision'`.

The write is always persisted, and the response carries `status: 'active'` with an `id` that corresponds to a real row. Until P74 this was not the case: when the content closely resembled something already stored, the **surprise-gate** diverted it to a `staging` that existed nowhere (no table, no consumer) and returned a fabricated id. That path was removed; the prediction error is recorded in the audit log instead of deciding whether the data is written. In addition, if the new fact contradicts existing facts, the response includes `conflict.judgmentRequired: true` with a list of `candidates`. You must resolve each one with `memory_judge(action='resolve', relationId=...)` (one call per candidate) before continuing; candidates with `action: 'supersede'` and no `relationId` are informational only (the server has already archived the dominated fact).

**Parameters**:

| Parameter           | Type                                      | Required | Default         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statement`         | string [1,1000]                           | Yes      | —               | The fact in one short sentence. The server accepts up to 50,000 chars; the tool clamps to 1000                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subject`           | string                                    | No       | `'workspace'`   | Who or what the fact is about                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `kind`              | string (not an enum)                      | No       | `'fact'`        | `fact\|decision\|episode\|entity\|strategy\|workflow\|skill\|task\|event\|reasoning`. Unrecognized value → 400                                                                                                                                                                                                                                                                                                                                                                                                  |
| `subtype`           | string (not an enum)                      | No       | depends on kind | Only applies if `kind` is `fact`/`decision`/`entity`. fact: `preference\|trait\|event\|relationship\|skill\|concern\|architecture\|bugfix\|config\|discovery\|policy\|process\|other`. decision: `decision\|architecture\|policy\|process\|bugfix\|learning\|discovery\|config`. entity: `person\|organization\|project\|concept\|place\|other`. Case-insensitive. A value outside the list → stored as `other` (decision: `decision`) and the response carries `warnings` (`subtype_substituted`). Empty → 400 |
| `confidence`        | number [0,1]                              | No       | 0.7             | Use <0.5 for derived/inferred facts                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `agentId`           | string                                    | No       | —               | Who originated the fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `conversationId`    | string                                    | No       | —               | For traceability (cite-back)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `idempotencyKey`    | string                                    | No       | —               | UUID v4 recommended; prevents duplicates on retries                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `scope`             | enum `global`\|`conversation`\|`personal` | No       | `'global'`      | `'personal'` requires a key with an associated `userId`; it fails at runtime if it has none                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `scopeRef`          | string                                    | No       | —               | Project/entity ref. If it names a `kind: project` entity by name or alias (case-insensitive), the canonical name is stored and the response carries `warnings` (`scope_ref_canonicalized`); if it looks like a project without matching one, it is stored as given with `scope_ref_unrecognized` and a `suggestion` (P135)                                                                                                                                                                                      |
| `scopeOwner`        | string                                    | No       | —               | `'workspace:<id>'`\|`'user:<id>'`\|`'tenant:<id>'`. Validated server-side: it cannot be forged (403 if it does not match the authenticated identity)                                                                                                                                                                                                                                                                                                                                                            |
| `targetWorkspaceId` | string                                    | No       | —               | Writes to another workspace; requires write/admin membership there                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `topicKey`          | string                                    | No       | —               | Per-topic idempotent upsert key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**When to use it — use cases**:

- When you discover an explicit user preference during the conversation ("always use TypeScript strict mode").
- Recording a learned configuration decision (although for "pure" decisions `memory_decide` exists and is more specific).
- Storing a low-confidence fact when something is inferred indirectly (`confidence: 0.3`).
- Using `topicKey` to keep a single "live" fact per topic (for example `'infra/pg-version'`) that is updated instead of accumulating duplicates with every new session.

**Edge cases and gotchas**:

- `scope: 'personal'` without a user-bound key fails at runtime with the literal message `"scope 'personal' requires a user-bound key"`. It is not a silent error; check with `memory_context` beforehand.
- A malformed `scopeOwner` (it does not start with `workspace:`/`user:`/`tenant:`) returns 400; if it starts correctly but does not match the authenticated identity (for example `user:<otro-id>`), it returns 403. This prevents an LLM from claiming another identity.
- The tool deliberately does NOT expose the content hash used for dedupe. This keeps callers from depending on an internal detail that may change.
- `kind` is a loose `string` in the Zod schema (not an enum) on purpose: the product taxonomy evolves faster than the MCP protocol, and freezing it would break clients with every new kind. But the server DOES validate against `PRIMITIVE_KINDS` and returns 400 if there is no match.
- The `501` documented in the server's OpenAPI schema ("no embed provider configured and no precomputed `vector`") is not reachable from this MCP tool, because it does not expose the `vector` parameter.

**Examples**:

```json
{
  "statement": "El cliente Acme prefiere comunicación en español.",
  "subject": "acme",
  "subtype": "preference",
  "confidence": 0.9
}
```

```json
{
  "statement": "Se decidió usar event sourcing para el audit log.",
  "kind": "decision",
  "subtype": "architecture",
  "topicKey": "infra/audit-log-strategy",
  "scopeRef": "mnemosyne"
}
```

Response with a conflict (abridged):

```json
{
  "id": "mfact_...",
  "status": "active",
  "conflict": {
    "judgmentRequired": true,
    "candidates": [{ "id": "mfact_old", "action": "review", "relationId": "mrel_..." }]
  }
}
```

---

## `memory_forget`

**What it does**: Archives (soft-deletes) any cognitive primitive. It **never destroys data**. It is the direct implementation of the project's bitemporal principle: it closes `validTo = NOW()` and preserves the row for audit; the primitive disappears from recall but remains recoverable and auditable.

Internally the code branches into two completely different HTTP routes depending on `kind`:

- **`kind: 'fact'` (or absent, the default)**: uses `client.forgetFact()` → `DELETE /facts/:id`, which supports `idempotencyKey` (through the `Idempotency-Key` header, handled by global middleware).
- **Any other kind** (`decision`, `episode`, `entity`, `strategy`, `workflow`, `skill`, `task`, `event`, `reasoning`, `hyperedge`): uses `client.forgetPrimitive()` → `DELETE /forget/{kind}/{id}` (generic P18 route). **Fixed (B2, 2026-08-10)**: `forgetPrimitive()` now accepts `idempotencyKey` as its 5th parameter and forwards it as the `Idempotency-Key` header, just like `forgetFact`. The global idempotency middleware already covered `DELETE` on all routes; the only real bug was that the SDK never forwarded the key for this generic branch.

`factId` is a backward-compat alias of `primitiveId` only when `kind === 'fact'`; for any other kind, `primitiveId` is required and `factId` is ignored.

**Parameters**:

| Parameter        | Type             | Required    | Default  | Notes                                                                                                          |
| ---------------- | ---------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `factId`         | string (min 1)   | Conditional | —        | Only valid when `kind='fact'` (or absent). Backward-compat alias of `primitiveId`                              |
| `primitiveId`    | string (min 1)   | Conditional | —        | Required if `kind` is not `'fact'`                                                                             |
| `kind`           | enum (11 values) | No          | `'fact'` | `fact\|decision\|episode\|entity\|strategy\|workflow\|skill\|task\|event\|reasoning\|hyperedge`                |
| `reason`         | string           | No          | —        | Recorded in the audit log; the server truncates it to 200 chars (Zod accepts any length, the server truncates) |
| `idempotencyKey` | string           | No          | —        | Real effect for **all** kinds (fixed in B2). A retry with the same key does not re-apply the archive           |

**When to use it — use cases**:

- The agent detects that a previously stored fact is no longer correct or has become obsolete (`memory_update` is typically preferred if it is a correction with a replacement, but `memory_forget` fits when the fact simply no longer applies).
- A piece of data was marked with the wrong sensitivity or exposed by mistake, and it must be removed from the recall pool immediately without losing the audit trail.
- Archiving a completed or cancelled `task`, an irrelevant `episode`, or a duplicate `entity`.
- Automatic cleanup after detecting duplicates via `memory_compare`.

**Edge cases and gotchas**:

- If neither `primitiveId` nor `factId` (where applicable) is passed, the tool returns an error BEFORE calling the server (`isError: true`, no network round trip) with an explicit message: `"primitiveId (or factId for facts) is required."`.
- **Fixed (B2, 2026-08-10)**: passing `idempotencyKey` together with a `kind` other than `'fact'` now does protect against double-archiving on a retry, just like `kind: 'fact'`. `forgetPrimitive()` forwards the key as the `Idempotency-Key` header, covered by the same global idempotency middleware that already applied to every `DELETE`.
- The default `reason` when none is provided explicitly is literally the string `"mcp_forget"` in the tool response (this does not mean the server used it that way; it is just what the tool returns as an echo if `reason` came in undefined).
- There is NO confirmation that the id exists before attempting to archive beyond the server's native 404: a nonexistent id returns an error from the HTTP call, not `forgotten: false`.

**Examples**:

```json
{ "factId": "mfact_abc123", "reason": "Dato desactualizado — cliente cambió de plan" }
```

```json
{
  "primitiveId": "mtask_xyz789",
  "kind": "task",
  "reason": "Tarea cancelada por el usuario"
}
```

Response:

```json
{
  "id": "mfact_abc123",
  "kind": "fact",
  "forgotten": true,
  "reason": "Dato desactualizado — cliente cambió de plan"
}
```

---

## `memory_search`

**What it does**: Semantic search over the workspace memory pool. Unlike `memory_recall`, which exposes fine-grained control over mode and lexical/vector weight, this tool is meant to prioritize conceptual similarity. However, it deliberately does **not** force a strict `mode: 'semantic'` or `vectorWeight: 1.0`, and this is extensively documented in the source code as the result of a real project finding (MCP-1, 2026-07-29): previously, `POST /recall` silently dropped `vectorWeight`/`mode` from the request before they reached `RecallQuery`, so every call resolved to `mode: "auto"` regardless of what was requested. Once that routing bug was fixed, forcing a strict `mode: 'semantic'` in this tool would have made **every call without a configured embedder throw a hard error** (`semantic_search_unavailable`, design B5.9 with no silent fallback), breaking this same tool's documented promise of degrading to FTS. That is why it omits `mode`/`vectorWeight` entirely and relies on the `'auto'` default, which, as shown in a dedicated integration test, produces ranking and scores **identical** to a strict `'semantic'` when an embedder IS available (both run the same HNSW vector cascade), but degrades to FTS instead of throwing an error when there is none.

Under the hood, `memory_search` calls exactly the same endpoint as `memory_recall` (`client.recall()` → `POST /recall`), only with a smaller subset of exposed parameters (no `asOf`, no `mode`, no `sessionId`) and a slightly different output format (`memories` with `content` instead of `statement`, no explicit `subject`/`kind` field).

**Parameters**:

| Parameter  | Type                                      | Required | Default | Notes                                                                                               |
| ---------- | ----------------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------- |
| `query`    | string (min 1)                            | Yes      | —       | Free text to search semantically                                                                    |
| `limit`    | int [1,20]                                | No       | 5       | Maximum number of hits (more restrictive than `memory_recall`, which allows up to 25)               |
| `scope`    | enum `global`\|`conversation`\|`personal` | No       | (all)   | Same behavior as `memory_recall`: `'personal'` filters to the personal workspace only (fixed in B1) |
| `scopeRef` | string                                    | No       | —       | Filters by project/entity                                                                           |
| `actorId`  | string                                    | No       | —       | Filters by the exact `ActorRef` that wrote the fact                                                 |

**When to use it — use cases**:

- Searching memory by concept when you do not know the exact terminology used when it was stored (for example, searching "error handling" and finding a fact that says "retry strategy with backoff").
- When `memory_recall` has already been used for general context and you need a second pass more focused on pure similarity, without the noise of the 1-hop relation expansion.
- Preferring it over `memory_recall` when you do not need the extra fields (reminders, composition debug) and want a more compact response.

**Edge cases and gotchas**:

- The `score` field in the response **is not pure cosine**. It is a mix of cosine similarity with ACT-R activation and worth, the same as in `memory_recall`. The name "semantic search" in the description may suggest an isolated vector similarity score, but it is not one.
- `debug.searchMode` is the only reliable place to know whether the call actually ran in vector mode or fell back to FTS. The response text (`content[0].text`) also indicates it in natural language ("Found N semantic memories" vs "Found N memories via FTS keyword fallback").
- Compared with `memory_recall`, this tool does NOT support `asOf` (no bitemporal recall) or explicit `mode`/`vectorWeight`. If you need that control, use `memory_recall` directly.
- Same `scope: 'personal'` behavior as `memory_recall` (fixed in B1): it filters to only facts from the caller's personal workspace, with a 400 if the key has no `userId` or no personal workspace is configured. Without that `scope`, the user's personal facts are already merged automatically through multi-level recall if the key has a `userId`.

**Examples**:

```json
{ "query": "cómo manejamos reintentos de red", "limit": 8 }
```

```json
{ "query": "convenciones de nombres de branches", "scopeRef": "mnemosyne", "actorId": "key:abc123" }
```

Response:

```json
{
  "memories": [
    {
      "id": "mfact_...",
      "content": "Usamos conventional commits, sin AI attribution.",
      "score": 0.71,
      "hitFreshness": "current"
    }
  ],
  "debug": { "searchMode": "hybrid" },
  "_mnemo_label": "untrusted_external_content"
}
```

---

## `memory_status`

**What it does**: A health and availability snapshot of the memory workspace. It makes 4 calls in parallel (authenticated `GET /health`, `GET /admin/stats`, `GET /me`, `GET /health/ready`), all best-effort (`.catch(() => null)`), and assembles a combined summary.

It is important to distinguish what this tool actually reports, because the file's own JSDoc records an audit finding (2026-07-28) about an earlier version of the documentation that was **incorrect**: the old version claimed that `GET /health` "exposes the individual state of sub-components (db, embedder, queue)". That was NEVER the case. `client.health()` hits `GET /health` (authenticated, scoped to the caller's workspace), which returns a **snapshot of workspace vitals** (fact count, embedding backlog), never a `status`/`components` per db/embedder/queue. The real per-dependency state (postgres/vector/cache) lives in a completely different endpoint: `GET /health/ready` (**unauthenticated, instance-level, not scoped to the caller's workspace**), which was wired into this tool on 2026-07-31 under the `dependencyHealth` field.

It also exposes (P10) the user's personal workspace when the key has an associated `userId`: id plus the count of active facts there. This was broken in every real deployment until 2026-07-29 because of an infinite recursion bug in the RLS policy of `mnemo_workspace_member` (the read policy ran an EXISTS subquery against itself). The Postgres error was silently absorbed by a generic try/catch, indistinguishable from "this user has no personal workspace". It was fixed with a `SECURITY DEFINER` function that avoids re-triggering the same RLS policy (migration `0012_workspace_member_rls_recursion.sql`).

**Parameters**: none. It is a GET with no query string, `inputSchema: {}`.

**When to use it — use cases**:

- A quick diagnostic before a long work session, to confirm the instance is `ready` and not `degraded`.
- Viewing the memory distribution per project (`factsByScopeRef`) to understand how much context has accumulated before deciding whether a broad `memory_recall` is worth it.
- Confirming the pending embedding backlog when you suspect a recent `memory_search` fell back to FTS because of missing indexing, not because of a missing embedder.
- A shallow operational check before escalating to `memory_doctor` (which does a deep diagnosis of grants and schema).

**Edge cases and gotchas**:

- `dependencyHealth` is **instance-wide**, not specific to this workspace. A `degraded` there affects every workspace on the instance, not just the caller's. The response text states this explicitly ("instance-wide, not workspace-scoped").
- If `client.healthReady` is not available in the installed client-ts (check `typeof client.healthReady === "function"`), this section is simply omitted and the tool does not break.
- The `factsByScopeRef` breakdown IS verified as accurate against real Postgres (dedicated integration test). Unlike other fields of this tool that had historical bugs, this one was never flagged as suspect.
- For deeper diagnosis (grants, schema, engine-level embedding state), the tool's own description explicitly redirects to `memory_doctor`. `memory_status` is deliberately shallow.

**Examples**:

```json
{}
```

Response (abridged):

```json
{
  "workspaceId": "ws_...",
  "factsLive": 340,
  "embeddings": { "indexed": 335, "pending": 5 },
  "factsByScopeRef": [
    { "scopeRef": "mnemosyne", "count": 210 },
    { "scopeRef": "acme", "count": 130 }
  ],
  "personal": { "workspaceId": "ws_personal_...", "factsLive": 12 },
  "dependencyHealth": {
    "status": "ready",
    "degraded": false,
    "checks": { "postgres": "ok", "vector": "ok", "cache": "ok" }
  }
}
```

---

## `memory_relate`

**What it does**: Creates or lists typed relations between memory primitives (fact/decision/entity/episode), or reconstructs the lineage of one of them, on the workspace knowledge graph. The verb vocabulary is **locked at 9 values** (a locked set with a CHECK constraint in SQL), and the server validates explicitly against `LOCKED_VERBS`, returning a descriptive 400 (`invalid_verb`) if you try to use anything outside that set, distinguishing it from a generic Zod validation 422.

It has three `action` values:

- **`create`**: `POST /relations`. Requires `sourceKind`, `from`, `targetKind`, `to`, `verb`, all mandatory when `action='create'`; if any is missing, the tool returns an error BEFORE calling the server.
- **`list`**: `GET /relations`. Lists existing relations (with `limit`, up to 200 from the tool, up to 500 from the server directly).
- **`history`**: reuses `POST /relations/traverse`, **deliberately** fixing `verbs: ['supersedes', 'derived_from']` and intentionally ignoring the other 7 verbs. It is not a generic traverse: it serves specifically to reconstruct "what replaced this primitive?" or "what was it derived from?" by walking the chain from the given id. The code itself documents that a separate generic `memory_graph`/traverse tool was evaluated and rejected for lack of a clear use case with a natural-language trigger.

There is a non-obvious side effect documented in the code (ENTITY-1): a `part_of` or `member_of` relation with `sourceKind='fact'` and `targetKind='entity'` **also** links the fact to that entity (`mnemo_fact.entity_id`), so `memory_entity(action:'linked_facts')` returns it. This only applies in that exact direction and those 2 exact verbs; any other verb or the reverse direction (`entity→fact`) links nothing. And the **first** relation wins: if the fact is already linked to an entity, a later relation to a different entity does not overwrite it (although the relation itself is still created in the graph).

**Parameters**:

| Parameter        | Type                                         | Required    | Default                | Applies to                                                                                                           |
| ---------------- | -------------------------------------------- | ----------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `action`         | enum `create`\|`list`\|`history`             | No          | `'create'`             | —                                                                                                                    |
| `sourceKind`     | enum `fact`\|`decision`\|`entity`\|`episode` | Conditional | —                      | `create`/`history`                                                                                                   |
| `from`           | string                                       | Conditional | —                      | `create`/`history` — source id (for `history`, the id to walk from)                                                  |
| `targetKind`     | enum `fact`\|`decision`\|`entity`\|`episode` | Conditional | —                      | `create`                                                                                                             |
| `to`             | string                                       | Conditional | —                      | `create` — target id                                                                                                 |
| `verb`           | enum (9 locked values)                       | Conditional | —                      | `create` — `related\|compatible\|scoped\|conflicts_with\|supersedes\|not_conflict\|derived_from\|part_of\|member_of` |
| `reason`         | string                                       | No          | —                      | Optional context for why the relation exists                                                                         |
| `confidence`     | number [0,1]                                 | No          | assigned by the server | Confidence in the relation                                                                                           |
| `limit`          | int [1,200]                                  | No          | —                      | `list`                                                                                                               |
| `maxDepth`       | int [1,5]                                    | No          | 5 (maximum supported)  | `history` — depth of the lineage chain                                                                               |
| `idempotencyKey` | string                                       | No          | —                      | Avoids duplicating relations on retries                                                                              |

**When to use it — use cases**:

- Linking a newly created fact to the entity it represents (`part_of`/`member_of`, fact→entity) so that it later appears in `memory_entity(action:'linked_facts')`.
- Marking that a new decision `supersedes` an earlier one, instead of leaving both as equally current.
- Using `action='history'` when an agent needs to explain why the current decision or fact is the valid one and what it replaced, for example when answering "why did we choose this architecture and not the previous one?".
- Marking two facts as `not_conflict` when the system detected them as potentially contradictory but they actually are not (explicit disambiguation).

**Edge cases and gotchas**:

- `action='history'` does NOT work for the inverse case, "what replaced THIS old decision?", without knowing the id of the newer one. The underlying traverse is directional only (source→target).
- Do not confuse `memory_relate(action='history')` with `GET /graph/traverse` (another server endpoint, not exposed by this tool): that one is bidirectional, returns a list ranked by decay with no edge detail, and supports bitemporal `asOf`. The code documents them as intentionally NOT redundant; both are kept.
- A verb outside the set of 9 → explicit 400 (`invalid_verb`) both in `create` and when doing `PATCH` (judgment); it never crashes silently.
- The entity auto-link side effect (ENTITY-1) is easy to miss: creating a `related` relation between a fact and an entity does NOT link it. Only `part_of`/`member_of` in the `fact→entity` direction do.
- `action='create'` without all required fields returns an error from the tool itself (no round trip to the server): `"action='create' requires sourceKind, from, targetKind, to, and verb."`.

**Examples**:

```json
{
  "action": "create",
  "sourceKind": "fact",
  "from": "mfact_pricing_pref",
  "targetKind": "entity",
  "to": "d0522e17-bd87-4ced-bc38-2b9a499beea7",
  "verb": "part_of",
  "reason": "Preferencia de pricing pertenece a la entidad Acme"
}
```

```json
{
  "action": "history",
  "sourceKind": "decision",
  "from": "mdec_auth_strategy_v3",
  "maxDepth": 3
}
```

```json
{ "action": "list", "limit": 50 }
```

## `memory_decide`

**What it does**: Persists a durable decision (architectural, policy, process, etc.) in `mnemo_decision`, a table distinct from `mnemo_fact`. A decision represents an explicit commitment ("we are going to do X because Y"), not a transient observation. The MCP handler calls `client.createDecision()`, which resolves to `POST /decisions` on the server.

Deduplication works by upsert on `(workspace_id, topic_key)`. Since the DECIDE-1 fix (2026-07-31), the `topicKey` comparison is case- and whitespace-insensitive (`lower(btrim(topic_key))`), both in the lookup query and in the partial unique index `uniq_mnemo_decision_topic` (migration 0017). So "Auth-Strategy" and "auth-strategy " (with a trailing space) match the same row, with no race condition between concurrent writes with different casing. The stored value keeps the original casing of whoever created the decision first; only the matching is normalized. If `topicKey` is omitted, the system **does not derive it** from `title`: every call without `topicKey` creates a new row, with no deduplication (this was never implemented, despite what the original documentation implied).

Besides the topic-key upsert, the server applies dedup by `normalizedHash` (visible in the response schema), although the main structured duplicate-control field that the LLM sees is `topicKey`.

A decision also supports a lifecycle: `PATCH /decisions/:id` marks it `status: "superseded"` and sets `supersededById`, but that operation is not exposed in the `memory_decide` tool (create only). You would have to go directly to the API or use `memory_relate` to create the corresponding `supersedes` relation, which the server does not create automatically.

**Parameters**:

- `kind` (enum, required): one of `decision | architecture | policy | process | bugfix | learning | discovery | config` (8 values, locked).
- `title` (string, required, 1–500 characters): one-sentence summary.
- `body` (string, required, minimum 1 character, server cap 50 000): the full rationale. Alternatives considered and which one was chosen go here in free prose; there are no separate structured fields for "alternatives"/"chosen".
- `topicKey` (string, optional): normalized deduplication key.
- `conversationId` (string, optional).
- `sensitivity` (enum, optional): `public | internal | confidential | restricted`, default `internal`.
- `scopeRef` (string, optional): project/entity scope.
- `idempotencyKey` (string, optional): avoids duplicating the decision if the call is retried.

**When to use it — use cases**:

1. Recording why Postgres was chosen over another DB, with the alternatives evaluated in `body`.
2. Documenting a bugfix with its root cause (`kind: "bugfix"`).
3. Setting a team policy ("every PR requires 2 approvals") with `kind: "policy"`.
4. Updating the rationale of an existing decision by reusing the same `topicKey`.

**Edge cases and gotchas**:

- **Discrepancy confirmed in code** (`packages/server/src/routes/decisions.ts`, explicit comment): `deps.core.createDecision` (in `@mnemo-ai/core/factory.ts`) **does not forward `actorId`/`userId`/`actorType` to storage today**. This is a pre-existing gap. Decisions created through this tool currently **do not store real author attribution**, even though the route already passes the correct value from `resolveProvenance(c)` (ready for when the core is fixed).
- A sensitivity ceiling violation on read (`GET /decisions/:id`) returns 404, not 403 (anti-probing, S6).
- `POST /decisions` responds 201 both when it creates and when the topic-key already existed (upsert), never 409.

**Examples**:

```json
{
  "kind": "architecture",
  "title": "Usar PostgreSQL + pgvector como store principal",
  "body": "Se evaluó Pinecone y Postgres+pgvector. Se eligió Postgres por RLS nativo, transacciones ACID compartidas con el resto de los datos, y menor costo operativo a la escala actual.",
  "topicKey": "vector-store-choice",
  "sensitivity": "internal"
}
```

```json
{
  "kind": "bugfix",
  "title": "Fix: RLS bypass en consolidation scheduler",
  "body": "El scheduler corría con rol superuser, bypasseando FORCE RLS. Se movió a withMnemoTx.",
  "topicKey": "rls-bypass-consolidation"
}
```

---

## `memory_entity`

**What it does**: Manages the full lifecycle of entities (people, organizations, projects, concepts, places) in `mnemo_entity` through `/entities`. It is a single multi-action tool: `create`, `get`, `list`, `update`, `linked_facts`, `link_user`, `unlink_user`. Entities do not decay (`validTo` is only set by explicit deletion) and the system deduplicates mentions through `aliases`.

`linkedUserId`, the field that links an entity of `kind: "person"` to a real platform account (`mnemo_user.id`), **can never be set through `create`/`update`**: the server's `CreateEntitySchema`/`PatchEntitySchema` schemas simply do not include that field. Only `link_user`/`unlink_user` can touch it. Self-linking (your own `userId`) is always allowed; linking another user requires the `memory:admin` scope **and** the `owner`/`admin` role in the workspace, verified through `deps.apiKeys.getWorkspaceMemberRole`. If the entity was already linked to a different user, reassigning it requires the same admin permission plus role **also** over the user who held the current link (having permission over the new target is not enough), so that a caller cannot "steal" someone else's link just by naming themselves as the new target.

Both `link_user` and `unlink_user` are **bitemporal** operations: they never overwrite the field in place. They close the current row (`validTo = now()`), create a successor row with the new state, and connect them with a `supersedes` relation, the same as the `forget()` convention.

**Parameters**:

- `action` (enum, default `create`): `create | get | list | update | linked_facts | link_user | unlink_user`.
- `id` (string, optional): required for `get`/`update`/`linked_facts`/`link_user`/`unlink_user`.
- `userId` (string, optional): required for `link_user`; must be a member of the workspace.
- `name` (string, 1–200, optional): required for `create`.
- `kind` (enum, optional): `person | organization | project | concept | place | other` (6 values); required for `create`.
- `description` (string, optional).
- `aliases` (array of strings, optional).
- `q` (string, optional): substring search for `list`.
- `limit` (number, 1–200, optional).
- `metadata` (record, optional).
- `sensitivity` (enum, optional, default `internal`).
- `idempotencyKey` (string, optional).

**When to use it — use cases**:

1. Creating a `person` entity the first time someone is mentioned in a conversation.
2. `link_user` to link the "Ada" entity with Ada's real `mnemo_user.id` account, enabling "what does the system know about this real user" queries.
3. `linked_facts` to see all the facts associated with a project (entity `kind: "project"`).
4. `list` with `q` to search by name or alias before creating (to avoid duplicates because of the 409).

**Edge cases and gotchas**:

- `create` with a duplicate `(name, kind)` returns **409 Conflict**. The tool description explicitly instructs to use `get`/`list` in that case instead of retrying `create`.
- The tool **does not expose `canonicalId`** (the "merge knob" that exists in `PATCH /entities/:id` of the HTTP API for merging duplicate entities). Merging two entities is not possible from this MCP tool, only through direct HTTP.
- A sensitivity ceiling violation on any read → 404 (anti-probing).
- `link_user` on an entity that is not `kind: "person"` → 400.
- `unlink_user` on an entity with no current link → 404.

**Examples**:

```json
{
  "action": "create",
  "name": "Acme",
  "kind": "organization",
  "description": "Consulting client: HR platform",
  "aliases": ["Acme HR"]
}
```

```json
{
  "action": "link_user",
  "id": "d0522e17-bd87-4ced-bc38-2b9a499beea7",
  "userId": "usr_9f8e7d6c5b4a"
}
```

---

## `memory_pin`

**What it does**: Marks (or unmarks) a fact as `pinned` in `mnemo_fact.pinned`, protecting it from automatic merge/pruning by the consolidation pipeline. It was implemented as a separate tool (not as a flag of `remember`) deliberately: pinning is a later curation action, typically after the fact has proven its value, and bundling it with creation would tempt an LLM to pin everything it writes, defeating the purpose.

**Verification of the promise against the real code** (audit 2026-07-28, confirmed against real Postgres and the consolidation gate without mocking):

- **"Protects from automatic prune/forget" → TRUE.** `pinFact()` writes the same column/table that `ConsolidationGate.ts` reads in its `pinned` condition. A pinned fact reliably fails that condition and is never merged.
- **"Gives it priority in recall" → FALSE on the real path.** `memory_recall`/`memory_search` resolve to `POST /recall` → `recallCold()`. That pipeline's `viewFact()` projection **never copies** `fact.pinned` into the `PrimitiveView` that the Stage 5 blended-score formula reads. A pinned fact and an identical unpinned one come out with **the same score**, with no ranking boost. A legacy module exists (`packages/core/src/recall/search.ts`) that does compute a `pin_bonus` column, but it backs `deps.core.recall`/`searchMnemo`, which is **not** the code path that `memory_recall`/`memory_search` exercise, so that bonus is unreachable from this tool.

**Parameters**:

- `factId` (string, required, minimum 1 character): id of the fact to pin.
- `unpin` (boolean, optional, default `false`): `true` to unpin instead of pin.
- `idempotencyKey` (string, optional).

**When to use it — use cases**:

1. Protecting a critical fact (for example "the user prefers TypeScript strict mode") from being merged by consolidation with similar low-worth facts.
2. Unpinning (`unpin: true`) a fact that is no longer critical, letting it become a consolidation candidate again.
3. Manually curating knowledge after reviewing the results of `memory_timeline` or `memory_recall`.

**Edge cases and gotchas**:

- **Do not use this tool expecting to raise the fact in recall results.** It does not work today, despite what the name would suggest. It is purely a protection against automatic merge/forget.
- The server returns an error if the fact is already archived (`status: "forgotten"`); the message is surfaced verbatim because it is actionable.
- Under the hood, pin/unpin are the same HTTP route (`POST /facts/:id/pin` with `{ pinned: true|false }`); the SDK exposes `pinFact`/`unpinFact` as separate wrappers, and the tool picks one or the other depending on the `unpin` flag.

**Examples**:

```json
{ "factId": "fct_8a2b1c3d4e5f6789" }
```

```json
{ "factId": "fct_8a2b1c3d4e5f6789", "unpin": true }
```

---

## `memory_timeline`

**What it does**: Returns the most recently created/updated/archived facts of the workspace, ordered by each one's most recent event, not just by creation date. The primary use case is a diff along the lines of "what did my AI learn this week?". It delegates to `client.timeline()` → `GET /timeline`, which in turn calls `core.timeline()`.

Ordering by "most recent event" is guaranteed at the DB level: `mnemo_fact` has a `BEFORE UPDATE` trigger that stamps `updated_at = now()` on **any** mutation (pin/unpin, the archive-on-forget path, edits), and the query orders by `ORDER BY updated_at DESC`. This is verified against a real NOSUPERUSER Postgres role (dedicated integration test).

The server only supports the `since`/`limit` query params on `GET /timeline` and has no filter by `kind`/`status`, so the MCP tool deliberately does not expose those parameters (to avoid advertising a no-op). The tool's `sinceIso` field maps directly to the server's `since`.

**Parameters**:

- `limit` (number, 1–100, optional, default 20): out-of-range values are **rejected** as an MCP tool error, not silently clipped to 100.
- `sinceIso` (string, optional): ISO date; only later events. If omitted, the server defaults to the last 24 hours.

**When to use it — use cases**:

1. A weekly or daily summary of what new knowledge entered the workspace.
2. Incremental pagination: use `sinceIso = lastSeenEventTime` of the last event received (the server returns events newest-first, so this gives clean pagination without offsets).
3. A quick audit of which facts were pinned or unpinned recently.
4. Detecting recently closed facts (`forget()`) for review.

**Edge cases and gotchas**:

- **Fixed (B3, 2026-08-10)**: `kind: "created"` is now emitted for a newly created fact. The fix lives outside `factory.ts` (an owned file, with no growth allowed for `CoreLike`): `FactFilter` gained an additive `createdSince?: Date` field, and `GET /timeline` merges the legacy `core.timeline()` stream (it still emits only `closed | pinned | updated`, unchanged) with a second read through `storage.queryFacts({ createdSince })`, mapped to `kind: "created"` events. Dedupe: when a fact's legacy event has the same `at` as its `createdAt` (a fact that was never touched), the phantom `"updated"` is discarded and only `"created"` is kept. If `deps.storage` is not wired, it degrades to the legacy stream without failing (no `created` events, pre-fix behavior).
- "max 100" is enforced by the tool's own Zod schema (rejection, not clamp).
- The response includes `nextCursor` (string or null) in addition to `events`, although the documented tool (v3.2) recommends paginating manually with `sinceIso`.

**Examples**:

```json
{ "limit": 50 }
```

```json
{ "sinceIso": "2026-08-01T00:00:00.000Z", "limit": 100 }
```

---

## `memory_episode_start`

**What it does**: Starts an ephemeral session (episode) by calling `client.createSession()` → `POST /session/start`. The memories generated inside the session (turns) live in a volatile state (session buffer, potentially backed by Redis through `sessionBuffer` if wired) until `memory_episode_end` collapses the content into durable memory. It returns a `sessionId` that the caller must keep.

Internally, the server also attempts an anticipation pre-injection (§30): if `deps.storage` and `deps.workingMemory` are wired, it preloads into the working memory L0 slot the memories that the anticipation engine predicts to be relevant for this session. This is best-effort; any failure is logged and does not block session creation. Those anticipated ids come back in the `anticipated` field of the HTTP response (although the MCP tool does not expose them in its output text).

**Parameters**:

- `agentId` (string, optional): agent that starts the episode. If omitted, it uses the workspace's default agent.
- `label` (string, optional): human-readable label (for example `"Reunión con cliente 2026-06-12"`) for later search/debug.
- `metadata` (record, optional): arbitrary metadata (for example `{ projectId, ticketUrl }`).
- `idempotencyKey` (string, optional): if the start is retried, the server returns the original session.

**When to use it — use cases**:

1. At the start of a significant multi-turn conversation that is expected to generate durable knowledge.
2. Before a long work session (for example extensive debugging) where it is worth extracting decisions and facts at the end.
3. With a descriptive `label` so the session can be found later through `memory_session`.

**Edge cases and gotchas**:

- The tool response **does not use `structuredContent`**. Unlike `memory_decide`/`memory_entity`/`memory_pin`/`memory_timeline`/`memory_consolidate`, this tool only returns a plain text block: `` `Episode started. sessionId: ${id}${labelSuffix}` ``. A programmatic caller must parse the `sessionId` from the text, not read it from a structured field.
- There is no guarantee that the session collapses automatically. `memory_episode_end` is the "mandatory close" of the cycle; a session that is never closed stays open indefinitely (subject to the `CollapsePolicy` timeouts if an automatic collapse on inactivity is wired).
- Starting a session does not create any fact/decision by itself; it only opens the container.

**Examples**:

```json
{ "label": "Debug RLS bypass en scheduler", "agentId": "claude-code" }
```

```json
{ "metadata": { "projectId": "mnemosyne", "ticketUrl": "https://github.com/org/repo/issues/42" } }
```

---

## `memory_episode_end`

**What it does**: Closes an episode and runs the full collapse pipeline: `client.collapseSession()` → `POST /session/:id/collapse` → `collapseSession()` in `packages/core/src/session/collapse.ts` (a function exported as `runCollapseSession` in the factory; note that it does **not** live under `packages/core/src/cognitive/session/`, but under `packages/core/src/session/`). The real pipeline has 8 steps:

1. **Load** the session and turns (from the Redis-backed `sessionBuffer` if wired, otherwise directly from storage).
2. **Minimum viability**: if `turns.length < minTurnsForCollapse` (default 3), it is skipped (`skipReason: "too_few_turns"`). There is also a `requirePin` gate (forced to `true` in `hybrid` mode) that skips if no turn is pinned.
3. **RecMem gate**: thematic coherence via mean-of-max pairwise cosine similarity between turn embeddings. Below `recurrenceThreshold` (default 0.6) it is skipped without spending LLM calls (`skipLlmIfBelowThreshold`, default `true`).
4. **A single LLM call** (temperature 0.1, for reproducibility) that returns `{ goal, outcome, facts[], decisions[], strategies[], discoveries[], nextSteps[], relevantEntities[], keyDecisions[] }`.
5. **Surprise gate (prediction error)** for each extracted fact: `PE = 1 − maximum_similarity_to_existing_knowledge`. Below `config.surpriseThreshold` (default 0.3) it is discarded for not being novel enough.
6. **Persistence**: creates each fact/decision/strategy individually (there is no single transaction; "atomic" here means "without batching", not cross-item ACID). If a write fails, the session is **not** closed, allowing a full retry.
7. **Hebbian co-occurrence**: creates `related` relations between every pair of facts extracted in the same session (it feeds recall's Stage 3 relation expansion). Then it creates a `MnemoEpisode` (delta-encoded against the most similar episode if it exceeds 0.85, DELTAMEM §16), extracts hyperedges via LLM if there are ≥3 facts, propagates worth by outcome (except in cold-start/`learningMode`), and runs TD(λ) credit propagation.
8. **Closing** the session, mode graduation counters (learning→production), a self-reflection cycle every `REFLECTION_CADENCE` collapses, computing anticipation accuracy, and cleaning up the Redis footprint.

Degradation: if the LLM is unavailable, `status: "failed"`, and the session is preserved for retry.

**Parameters**:

- `sessionId` (string, required, minimum 1 character): id returned by `memory_episode_start`.
- `collapseHint` (string, optional): natural-language hint embedded in the LLM prompt ("influences but does not guarantee" the extraction).
- `idempotencyKey` (string, optional): prevents collapsing the same session twice.

**When to use it — use cases**:

1. Normal closing of a session started with `memory_episode_start` once the conversation is over.
2. Forcing a full extraction even in short sessions using `collapseHint` (which forces `strategy: "explicit"`, and therefore `reason: "explicit"` in the pipeline, instead of `"inactivity"`).
3. Guiding the extraction ("prioritize the user's decisions, ignore system messages") through `collapseHint`.

**Edge cases and gotchas**:

- **The HTTP 202 "Accepted" is misleading**: despite the status code suggesting asynchronous processing, the SDK's own comment (`client.ts`) clarifies it: _"The server returns 202 Accepted after the collapse pipeline completes"_. The handler does `await collapseWithPhases(...)` **before** responding. That is, the MCP call blocks until the 8-step pipeline finishes.
- The MCP tool **discards** the rich `CollapseResult` (factsCreated, decisionsCreated, strategiesCreated, outcome, anticipationAccuracy, etc.) and only returns the text `"Episode ended and collapsed. sessionId: X"`, with no counts. To see how many facts were created, query `memory_timeline` afterwards.
- It supports idempotent retries with recovery points (`session_locked` → `llm_called` → `facts_persisted` → `completed`): a retry after `facts_persisted` **does not re-run** the pipeline (`resumed: true`), avoiding double extraction.
- Session not found or already collapsed → 404 (`isError: true`). LLM failure mid-collapse → degraded error `MNEMO_004`, and the session stays active for retry.

**Examples**:

```json
{ "sessionId": "sess_3f8a9b2c1d0e" }
```

```json
{
  "sessionId": "sess_3f8a9b2c1d0e",
  "collapseHint": "Priorizar la decisión de arquitectura tomada sobre el vector store; ignorar saludos."
}
```

---

## `memory_consolidate`

**What it does**: Triggers an immediate manual consolidation pass for the caller's workspace, delegating to `POST /consolidation/trigger` → `runConsolidationTick()` from `@mnemo-ai/consolidation`. This is **the same function the background scheduler runs on every tick**, but scoped to the caller's workspace. A separate background scheduler exists (`packages/consolidation/src/scheduler.ts`) that runs on a simple `setInterval` (it is not a full queue system; that is v3.1) roughly every 60 seconds, wired at server boot.

**Fast mode (cosine-only, the only mode supported manually)**: queries low-worth candidates (excluding `confidential`/`restricted` up front), groups clusters by embedding similarity, and runs the 6+ condition `ConsolidationGate` on each cluster. **Any condition that fails aborts the merge of that entire cluster** (a deliberately conservative design: "do not merge pairs — too aggressive"). Conditions: cluster ≥ 3 members, no `canonical` member, `worth < 0.5` in ALL members, none recalled in the last 14 days, no Wilson lower confidence bound > 0.7, none pinned, none `contested`, uniform sensitivity across members, and a minimum pairwise cosine similarity ≥ 0.85.

**Deep mode (only through the background scheduler, NOT reachable manually)**: besides cosine clustering, it classifies each candidate pair with an LLM (`classifyFactPair`) and memoizes the result per pair by reading already existing relations (`loadLinkedFactIds`) so as not to pay the LLM cost again on every tick. It may write `conflicts_with` or `not_conflict` relations depending on the verdict. The background scheduler has **`mode: "deep"` enabled by default in production** (kill switch: `MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED=false`), but this is completely independent of this tool.

**Parameters**:

- `mode` (enum, optional, default `fast`): `fast | deep`. Requesting `deep` manually returns HTTP 422.
- `dryRun` (boolean, optional, default `false`): requesting `true` returns HTTP 422; there is no dry-run mode implemented yet.
- `idempotencyKey` (string, optional): avoids triggering two passes if the trigger is retried.

**When to use it — use cases**:

1. Forcing an immediate pass after a large batch of `memory_remember`, without waiting for the scheduler's next tick.
2. An orchestrator that wants to process the bounded set of low-worth candidates before reasoning about the graph state.
3. Manual/debug operation to verify that the consolidation gate does (or does not) merge an expected cluster.

**Edge cases and gotchas**:

- `mode: "deep"` or `dryRun: true` are rejected **before** touching storage. The validation (`assertSupportedConsolidationRequest`) runs on the parsed body and does not require storage to be available in order to fail with 422.
- If `@mnemo-ai/consolidation` is not installed → 503 `consolidation_unavailable` (the tool adds the suggestion to install it and restart). If no storage adapter is wired → 503 `storage_unavailable`.
- The manual trigger context **does not inject the boot scheduler's replay validator** unless it is explicitly configured (`deps.replayValidator`/`deps.getReplayValidator`), so the validation behavior of a manual trigger may differ from that of an automatic background tick.
- The response always carries `mode: "fast"` and `dryRun: false` literally in the schema, reflecting that these are the only values that ever get executed.
- If there are no candidates or no cluster passes the gate, the tool prints a friendly note instead of just zeros.

**Examples**:

```json
{}
```

```json
{ "mode": "fast", "dryRun": false, "idempotencyKey": "consolidate-2026-08-06-manual" }
```

---

## `memory_remind_when`

**What it does**: Creates, lists, or dismisses prospective-memory reminders. A reminder is activated by two mechanisms: a time trigger (`triggerAt`, evaluated by a background poller every 30 seconds) and/or a semantic trigger (`condition`, evaluated on every real `memory_recall` call, against the user's real query). The pure evaluator lives in `packages/core/src/reminders/evaluator.ts` (`evaluatePendingReminders`) and tries, in order, three semantic match strategies: (1) cosine similarity if a stored `conditionEmbedding` exists and a query embedding is available (threshold 0.7), (2) a YES/NO LLM judgment if an LLM adapter is configured, (3) a fallback by FTS keyword match. A reminder that fires moves to `status='triggered'` through `dismissReminder()`; the row is never deleted.

**Parameters** (Zod schema in `packages/mcp/src/tools/remind_when.ts`):

- `action`: `"create" | "list" | "dismiss"`, default `"create"`.
- `id`: string, optional; required only for `action='dismiss'`.
- `status`: `"pending" | "triggered" | "dismissed" | "all"`, optional; filter for `action='list'`, default `"pending"`.
- `content`: string, min 1; required for `action='create'`, it is the text surfaced when the reminder fires.
- `condition`: string, min 1, optional; semantic condition, required if `triggerAt` is not passed.
- `triggerAt`: ISO 8601 datetime string, optional; required if `condition` is not passed.
- `limit`: number, integer, 1–200, optional; for `action='list'`.
- `idempotencyKey`: string, optional; avoids duplicates on retries of `action='create'`.

**When to use it — use cases**:

1. Remembering to check something on a future date ("remind me to check the deploy on Monday at 10:00").
2. A purely semantic reminder with no fixed date: "when the user mentions Kubernetes, remind them of the cluster's resource limitation".
3. A combined reminder (true AND): "starting Monday, if the query mentions project X, remind about the pending blocker". It only fires on a real `memory_recall` after `triggerAt` whose query satisfies `condition`.
4. Auditing reminders that have already fired with `action='list', status='triggered'` to review what was shown to the agent.

**Edge cases and gotchas**:

- **Verification of the reported AND/OR bug**: the current code (`evaluator.ts` line 322: `fires = timeMatch && semanticMatch`) correctly implements **AND** logic for compound reminders. This corresponds to phase REMIND-1 (2026-07-27, see `docs/STATUS.md`); **the bug was fixed** and is not broken today.
- **A real gotcha that persists** (not a bug, it is a design documented in the code itself): the 30s background poller (`packages/server/src/index.ts`, around line 1178) **can only fire reminders with no `condition` at all**. Its discovery SQL query explicitly filters on `condition IS NULL OR btrim(condition) = ''`. Any compound reminder (`triggerAt` + `condition`) or purely semantic reminder **never fires through the poller**; it can only fire inside a real `memory_recall` call that brings a query to evaluate `condition` against. If the agent never calls `memory_recall` again after creating a compound reminder, that reminder stays pending indefinitely even if `triggerAt` has already passed.
- The `condition` embedding is computed only once, when the reminder is created (`routes/reminders.ts`). If there is no LLM adapter configured at that moment, the reminder is left without a `conditionEmbedding` and will always use the (less precise) FTS fallback instead of cosine.
- `action='list'` without `status` only shows `pending`. The content of a reminder that has already fired still exists in the database but is invisible unless you explicitly request `status='triggered'` or `'all'`.
- The firing path (`memory_recall`) is RLS-scoped, so a reminder never crosses workspaces.

**Examples**:

```json
{
  "action": "create",
  "content": "Revisar si el deploy a producción de chatbot-service terminó bien",
  "triggerAt": "2026-08-10T14:00:00Z"
}
```

```json
{
  "action": "create",
  "content": "Recordar la limitación de memoria del cluster K8s de staging",
  "condition": "el usuario pregunta sobre performance o escalado en Kubernetes"
}
```

```json
{ "action": "list", "status": "triggered", "limit": 20 }
```

---

## `memory_self_edit`

**What it does**: Lets the agent itself edit its memory with 6 actions (spec §13): `append`/`replace` (modify content), `strengthen`/`weaken` (adjust `worth` through a Bayesian credit mechanism, `updateWorth(..., { success, failure, creditWeight })`, not a fixed delta), `reflect` (runs the full self-reflection cycle), and `link` (creates an n-ary hyperedge: `target` is the anchor member, `content` is the other ids separated by commas, minimum 3 members in total). `target` is polymorphic: `fact_id`, `"profile"`, or `"strategy:{id}"`. All the policy logic lives server-side in `packages/core/src/cognitive/self-edit.ts` (`evaluateSelfEdit`) against `DEFAULT_SELF_EDIT_POLICY`.

**Fixed (B4, 2026-08-10)**: `action: "forget"` was **removed** from the enum and is no longer a supported action of this tool. Before, it got permanently stuck on `202 { approvalRequired: true }` with no real approval flow to complete (there was no `ApprovalStore`, no resume executor, and no wrapper in `client-ts`). The server now responds **422** `self_edit_forget_unsupported` if it is attempted anyway (for example from an old caller), with a message that points to `memory_forget` (`kind: 'fact' | 'strategy'`), which already covers exactly what `applySelfEdit("forget")` did internally (`archiveFact`/`archiveStrategy`). `client-ts` keeps `"forget"` in the type union marked `@deprecated` so that the 422 stays typed and observable without breaking compilation of old callers.

**Parameters** (Zod schema in `packages/mcp/src/tools/self_edit.ts`):

- `action`: `"append" | "replace" | "strengthen" | "weaken" | "reflect" | "link"`; required. It does not support `forget`; use `memory_forget`.
- `target`: string, min 1; `fact_id`, `"profile"`, or `"strategy:{id}"`.
- `content`: string, max 20,000 chars, optional; effectively required for `append`/`replace`/`link`.
- `reason`: string, min 1, max 2,000; always mandatory, context for the policy.
- `idempotencyKey`: string, optional.

**When to use it — use cases**:

1. Adding information to an existing fact without losing the previous content (`append`).
2. Lowering the weight of a preference that turned out to be incorrect without deleting it entirely (`weaken`).
3. Linking 3+ related facts into a single semantic hyperedge (`link`).
4. Manually triggering an agent's reflection cycle (`reflect`) to consolidate the session's learnings.

**Edge cases and gotchas**:

- **`action='forget'` no longer exists in this tool (fixed, B4)**: the Zod schema no longer accepts it, and a caller that tries it receives a local validation error before reaching the server. If the server still receives an `action:"forget"` (an old caller that has not been updated), it responds **422** `self_edit_forget_unsupported` instead of the old `202 { approvalRequired: true }`, which had no way of ever being resolved (there was no `ApprovalStore` or resume executor). **To delete or invalidate a fact or strategy, use the dedicated `memory_forget` tool (bitemporal, closes `validTo`)**. It does exactly what the old `action='forget'` did internally.
- Daily/per-session limits hardcoded in `DEFAULT_SELF_EDIT_POLICY`: `maxEditsPerSession: 5`, `maxDeletesPerDay: 3`, `maxStrengthensPerDay: 3`, `maxWeakensPerDay: 5`, `editCooldown: 300` seconds (5 min between consecutive edits by the same agent). When they are exceeded, the response is 429 with a message explaining which limit was exhausted.
- `strengthen` also has a cap of **at most 1 per fact per day** (`strengthensTodayForTarget`), independent of the global daily cap.
- `reason` is mandatory per the schema but, according to the file's own JSDoc, it is **not yet audited durably**. It is policy context, not a persisted audit log.
- `target="profile"` does not allow `strengthen`/`weaken`; it throws an explicit error ("requires a fact or strategy target, not profile").
- The budget counters are persisted in Redis (`CacheAdapter.incrWithTtl`) when a cache is configured; without a cache they fall back to an in-process `Map`, valid only for local dev. In a multi-instance setup without Redis the limit is easily evaded.

**Examples**:

```json
{
  "action": "weaken",
  "target": "fact_01HZXK...",
  "reason": "La preferencia resultó desactualizada tras confirmación del usuario"
}
```

```json
{
  "action": "link",
  "target": "fact_A",
  "content": "fact_B, fact_C",
  "reason": "Los tres facts describen la misma decisión de arquitectura desde ángulos distintos"
}
```

---

## `memory_update`

**What it does**: An ergonomic, thin wrapper over `client.selfEdit({ action: "replace", target: factId, content: statement, reason })`. Unlike `memory_self_edit`, this tool does not expose all 6 actions; it only covers the "fix this fact" use case. Server-side it applies the **full bitemporal replace**: it closes `validTo` on the original fact and creates a new row with the corrected statement, so the fact's `id` changes. All the authorization, RLS, and `worth` inheritance logic lives in `SelfEditPolicy`; this tool reimplements nothing.

**Parameters** (Zod schema in `packages/mcp/src/tools/update.ts`):

- `factId`: string, min 1; required, id of the fact to fix.
- `statement`: string, min 1, max 1000; required, new content that replaces the current statement.
- `reason`: string, optional; defaults to `"Updated via memory_update"` if omitted.

**When to use it — use cases**:

1. The user corrects a wrongly stored piece of data ("no, my timezone is GMT-3, not GMT-5").
2. Updating a fact that became outdated because of a change of context (change of role, change of stack).
3. Fixing a typo or ambiguity in a statement stored by `memory_remember`.

**Edge cases and gotchas**:

- Unlike `memory_self_edit` with `action='forget'`, this one DOES apply without approval gating: `parsedTarget.kind === "fact"` for a `replace` leaves `approvalScope = null` in `self.ts` (the `edit_entity` gate only applies when the target is **not** a fact, for example `"profile"` or `"strategy:{id}"`). A `memory_update` on a real fact runs directly.
- Ownership: the route checks `fact.userId`/`fact.actorId` against the caller's provenance in two separate fields, never against `apiKeyPrefix`. If the fact belongs to another actor/user and the caller does not have the `memory:admin` scope, the response is 404 (not 403, the same anti-probing pattern as the sensitivity ceiling).
- `statement` has a limit of 1000 characters, shorter than the 20,000 limit of `memory_self_edit`'s `content`, because this tool is meant for targeted corrections, not extensive rewrites.
- It consumes the same `maxEditsPerSession: 5` / `editCooldown: 300s` budget as any `memory_self_edit`, because internally it IS a `replace` self-edit.
- The original fact is preserved (it closes `validTo`, it is not deleted), so it is auditable through the same bitemporal mechanism as `forget()`.

**Examples**:

```json
{
  "factId": "fact_01HZXK...",
  "statement": "Ada prefiere TypeScript en modo strict en todos los proyectos nuevos"
}
```

```json
{
  "factId": "fact_01HZY2...",
  "statement": "El deploy de chatbot-service se hace vía GitLab CI, no acceso directo al server",
  "reason": "Corrección tras confirmar el flujo real con el usuario"
}
```

---

## `memory_judge`

**What it does**: Exposes unresolved conflicts between facts (`conflicts_with` relations created by the consolidation pass) and lets you resolve them interactively. `action='list'` fetches conflict pairs through `GET /conflicts`; `action='resolve'` applies a resolution through `POST /conflicts/:id/resolve`. There are four strategies: `supersede_a` (forgets factA, the original relation becomes `not_conflict`, and a new separate relation `factB --supersedes--> factA` is created), `supersede_b` (the mirror), `keep_both` (the relation becomes `not_conflict`, no fact is touched), and `merge` (forgets both originals, creates a new fact with `mergedStatement`, and creates two new `supersedes` relations toward the merged one). All 4 strategies correctly retire the original `conflicts_with` relation, so a resolved conflict never shows up again in a later `list`.

**Parameters** (Zod schema in `packages/mcp/src/tools/judge.ts`):

- `action`: `"list" | "resolve"`; required.
- `limit`: number, integer, 1–20, optional; only `action='list'`, default 5.
- `relationId`: string, optional; required for `action='resolve'` (it comes from the `relationId` field that `list` returns).
- `resolution`: `"supersede_a" | "supersede_b" | "keep_both" | "merge"`, optional; required for `action='resolve'`.
- `mergedStatement`: string, optional; required only when `resolution='merge'`.

**When to use it — use cases**:

1. Periodically reviewing conflicts detected by consolidation before they pile up.
2. The user explicitly states which of two contradictory facts is the correct one (`supersede_a`/`supersede_b`).
3. Two facts seem to contradict each other but actually apply to different contexts (`keep_both`).
4. Merging two partial versions of the same fact into a unified, more complete statement (`merge`).

**Edge cases and gotchas**:

- **Relationship with `decideAutoResolution` (`packages/core/src/conflict/decide.ts`)**: the code was verified. The auto-resolution gate requires `confidence > 0.7` (strictly greater, not `>=`). Of the 4 priority rules, only rule 1 (**trust-anchor**, confidence 0.9) exceeds that threshold and auto-resolves without intervention. Rule 2 (**recency**) has a confidence of exactly 0.7, so it does **not** cross the `> 0.7` threshold and **always** falls to manual review despite being a "priority" rule. Rules 3 (**worth-gap**, 0.6) and 4 (**ambiguous**, 0) also always fall to review. In practice, this means that almost all the conflicts that reach `memory_judge` are due to recency, worth-gap, or ambiguity; the clear trust-anchor ones were already resolved on their own before getting here.
- **`merge` is NOT atomic** (an audit finding documented in the code itself, still open; it is not a fixed bug): unlike `memory_update`/`memory_self_edit`'s `replace`, which use `StorageAdapter.replaceFact` in a single transaction, `merge` in `packages/server/src/routes/conflicts.ts` chains **six separate `withMnemoTx` transactions** (two `closeFact` in parallel, one `createFact`, one `patchRelation`, two `createRelation` in parallel) with no cross-transaction atomicity. A crash midway can leave both originals forgotten without a merged fact, or a merged fact with incomplete lineage.
- `merge` also loses the `subject`/`kind` of the source facts: `createFact` hardcodes them to `subject:"workspace", kind:"other"`, unlike `replaceFact`, which does preserve them.
- The historical finding that `GET /conflicts` and `POST /conflicts/:id/resolve` **always returned 404** because `mountConflicts(v1, deps)` was never called in `app.ts` is **fixed** (verified 2026-07-27); the routes are mounted and work.
- A missing `mergedStatement` with `resolution='merge'` returns an explicit tool error before even calling the server.

**Examples**:

```json
{ "action": "list", "limit": 10 }
```

```json
{
  "action": "resolve",
  "relationId": "rel_01HZAB...",
  "resolution": "merge",
  "mergedStatement": "El usuario prefiere reuniones async por Slack, salvo decisiones críticas que requieren llamada"
}
```

---

## `memory_doctor`

**What it does**: Runs 8 operational diagnostics and returns a structured `DoctorReport`. Checks 1–6 are server-side, through `client.doctor()` → `GET /doctor`: (1) `connectivity`: Postgres is reachable through `deps.core.ping()`; (2) `app_user_grants`: the `app_user` role has `USAGE` on the `mnemosyne` schema; (3) `schema_shadows`: detects duplicate table names between the `public` and `mnemosyne` schemas; (4) `migration_version`: the last applied migration; (5) `embedding_backlog`: live facts with no embedding or with an outdated embedding; (6) `workspace_id_valid`: the authenticated `workspace_id` is a well-formed UUID. Checks 7–8 run inside the MCP process itself: (7) `env_config`: `MNEMO_URL`/`MNEMO_KEY` are present; (8) `mcp_tools`: the MCP server has exactly `MCP_TOOL_COUNT` tools registered, measured with a live `ToolRegistrationProbe` (not a tautology). It has no input parameters and does no auto-remediation; it only reports.

**Parameters**: none (`inputSchema: {}`).

**When to use it — use cases**:

1. Diagnosing an unexpected 500 before assuming it is a code bug.
2. Verifying that a fresh deploy (for example to `agents.example.com` in other projects, or any new Mnemosyne environment) is healthy before calling it done.
3. Confirming that the MCP client's environment variables (`MNEMO_URL`, `MNEMO_KEY`) are loaded correctly.
4. Detecting a backlog of pending embeddings before it affects the quality of semantic recall.

**Edge cases and gotchas**:

- **`schema_shadows` reports `"warn"` on EVERY healthy deploy**; this is not a real alarm. `docker/Dockerfile.migrate` runs two migration streams in parallel (the legacy/`public` stream of `@mnemo-ai/core` and the v3/`mnemosyne` stream of `@mnemo-ai/adapter-postgres`), and both create tables with the same name (`mnemo_fact`, `mnemo_entity`, `mnemo_relation`, ...) in different schemas by design ("dual-core hybrid"). The check cannot tell that expected overlap apart from a real accidental collision, so treat `"warn"` here as normal unless `shadowCount` changes between runs.
- **`workspace_id_valid`'s `"error"` branch is unreachable in real production**; verified: both the API key lookup (`packages/core/src/api-key-lookup.ts`) and the `isWorkspaceId()` gate in `auth.ts` reject a malformed `workspace_id` with 400 **before** any route handler (this one included) gets to run. The check stays as defense in depth, but you will never see it fire against the real API.
- Check 8 (`mcp_tools`) was fixed from a real tautology (DOCTOR-1): it used to compare a value against itself and could never fail; it now measures live how many registrars ran and fails with `"error"` if any of them threw an exception during boot (not just `"warn"` for a count mismatch).
- If the server is unreachable, checks 1–6 collapse into a single synthetic check `{ name: "server", status: "error" }`; you will not see which of the 6 failed, only that the connection could not be made.
- The overall status (`worst`) follows the hierarchy `error > warn > unknown > ok` across all the combined checks (server + env + mcp_tools).

**Examples**:

```json
{}
```

Expected response on a typical healthy deploy (summary): `status: "warn"` (because of `schema_shadows`), with the rest of the checks at `"ok"`.

---

## `memory_stats`

**What it does**: Aggregate statistics snapshot of the authenticated workspace, delegating to `GET /admin/stats`. It returns: `facts.{live, closed, pinned, archived, withZeroHits, byScopeRef}`, `decisions.active`, `relations.conflicts`, `embeddings.{indexed, pending}`, `recall.{hitRate30d, lastRecallAt}`, `lastWriteAt`, plus `workspaceId` and `generatedAt`.

**Parameters**: none (`inputSchema: {}`).

**When to use it — use cases**:

1. A quick memory health snapshot before a large recall or consolidation pass.
2. Detecting facts with `withZeroHits` for review or pruning.
3. Monitoring the backlog of pending embeddings.
4. Seeing when the workspace's last write or recall happened, useful when debugging "is this workspace really idle?".

**Edge cases and gotchas**:

- **Not all fields are live**: `facts.live/closed/pinned`, `facts.byScopeRef`, `embeddings.indexed/pending`, `recall.lastRecallAt`, and `lastWriteAt` are computed live on every call (through `deps.core.vitals()`), and so is `relations.conflicts` (the unresolved pairs within the caller's sensitivity ceiling). But `facts.archived`, `facts.withZeroHits`, `decisions.active`, and `recall.hitRate30d` read a periodic snapshot (`mnemo_health`, daily cron `mnemo.health.snapshot` at 03:00 UTC, `packages/server/src/cron/jobs.ts`) and can be up to 24 hours out of date in a newly active workspace.
- **There is no MCP-callable way to force a refresh of those 4 fields**; verified: `GET /admin/stats` calls `getHealthSnapshot({ fresh: false })` with no exception. The only endpoint that forces a real refresh (`GET /governance/drift?fresh=true`, `packages/server/src/routes/governance.ts`) has no wrapper in `client-ts`, requires the `memory:governance` scope (which typical MCP API keys do not have), and has per-workspace write side effects with no throttle; a wrapper was deliberately not added so as not to expose that from a read-only tool.
- If `getHealthSnapshot()` fails or there is no snapshot yet (cold start), the route catches the error and serves `archived`, `withZeroHits`, `decisions.active` and `hitRate30d` as `null`, with `snapshot.available: false`, instead of throwing a 500: `null` means "no usable snapshot", not zero. `relations.conflicts` does not depend on the snapshot: it is always the live count (a number), and reads `null` only if that count itself fails.
- All the numbers are scoped by RLS to the authenticated workspace; there is no way to see cross-workspace stats with this tool (the operator-level `memory_status`/admin/stats is a different tool for that).

**Examples**:

```json
{}
```

Example response shape:

```json
{
  "workspaceId": "ws_01HZ...",
  "facts": {
    "live": 342,
    "closed": 58,
    "pinned": 12,
    "archived": 5,
    "withZeroHits": 27,
    "byScopeRef": { "chatbot-service": 120 }
  },
  "decisions": { "active": 14 },
  "relations": { "conflicts": 2 },
  "embeddings": { "indexed": 340, "pending": 2 },
  "recall": { "hitRate30d": 0.71, "lastRecallAt": "2026-08-09T10:02:11Z" },
  "lastWriteAt": "2026-08-09T09:58:03Z"
}
```

---

## `memory_purge`

**What it does**: Physical hard-delete of facts: a real `DELETE FROM mnemo_fact`, with no deletion-log, no crypto-erasure of the actor's DEK, and no audit trail. Two actions: `fact` (deletes one fact by id through `DELETE /facts/:id/hard`) and `closed` (bulk-deletes all facts with `status='forgotten'` in the workspace through `DELETE /facts/purge`). Both require the `memory:hard_delete` scope on the API key (403 if missing). It is not GDPR-compliant: for a real Article 17 erasure you must use `memory_forget` in hard mode (`packages/core/src/cognitive/forget.ts`), which does generate a deletion-log and destroys the actor's DEK.

**Parameters** (Zod schema in `packages/mcp/src/tools/purge.ts`):

- `action`: `"fact" | "closed"`; required.
- `factId`: string, optional; required when `action='fact'`.

**When to use it — use cases**:

1. Cleaning up test/CI workspaces where retaining an audit trail does not matter.
2. Purging one specific fact created by mistake in a test environment.
3. Reclaiming space in bulk by deleting everything already marked `forgotten` in a disposable workspace.
4. **Never** for a real GDPR deletion of a user's data; for that, use `memory_forget` with the corresponding hard mode.

**Edge cases and gotchas — fresh verification of the "completely non-functional" report**:

- **The historical report that `memory_purge` is "completely non-functional" is OUTDATED; the bug was fixed and verified in the current code (2026-08-09):**
  - `deps.core.hardDeleteFact`/`purgeClosedFacts` **are** implemented in `packages/core/src/factory.ts` (lines 762 and 779): both run a real `DELETE FROM mnemo_fact ... RETURNING id` inside `withMnemoTx` (RLS respected).
  - `DELETE /facts/purge` is **no longer** shadowed by `DELETE /facts/:id`: in `packages/server/src/routes/facts.ts`, the `/facts/purge` route is registered at line 231, **before** `/facts/:id` (line 264) and `/facts/:id/hard` (line 347). The code itself leaves an explicit comment documenting the historical bug and why registration order matters (Hono resolves routes in registration order; `/facts/:id` is a wildcard that captured `"purge"` as if it were a literal `id` before the dedicated handler ran).
  - A specific integration test proves this against a real Postgres: `packages/server/src/__tests__/integration/purge-facts-hard-delete.integration.test.ts`.
- A real gotcha that persists (not a bug, an intentional safeguard): both purge queries explicitly exclude facts with `metadata ? '__mnemoConsolidationPending'`. A fact that is in the middle of a consolidation pass cannot be purged until that flag is cleared, to avoid deleting something the consolidation pipeline is still using.
- `action='fact'` with an empty or whitespace-only `factId` returns a tool validation error before calling the server.
- It is **irreversible**: unlike `memory_forget` (soft), there is no `restore`. `DELETE /facts/:id/hard` and `DELETE /facts/purge` have no undo equivalent.
- The `memory:hard_delete` scope is not usually on standard agent API keys; if the tool returns 403, it is not a bug, it is the scope policy working as expected.

**Examples**:

```json
{ "action": "fact", "factId": "fact_01HZXK..." }
```

```json
{ "action": "closed" }
```

---

## `memory_compare`

**What it does**: Compares two `facts` by ID (`factIdA`, `factIdB`). **Updated (docs/archive/openspec/decompose-recall-and-compare, Slice 2, 2026-08-10)**: the tool is now a thin HTTP caller. It calls `client.compareFacts({ factIdA, factIdB })`, which hits `POST /facts/compare` server-side, and returns the response as is (no local computation). All the diff/heuristic logic (formerly in `packages/mcp/src/tools/compare.ts`) now lives in `packages/server/src/facts/compare.ts` (a pure module, no I/O), reachable by any HTTP client, not just this MCP process. The tool's contract for whoever invokes it (parameters, response shape, behavior) is identical to before; only where the computation runs changed. It produces three outputs: (1) a list of human-readable differences per field (`content`, `pinned`, `validFrom`, `validTo`; no tags, see correction B6 below), (2) a `sameSubject` boolean, and (3) a suggested relation verb (`supersedes | conflicts_with | compatible | scoped`).

**Corrected (B6, 2026-08-10)**: the dead code that used to exist but was structurally unreachable was removed. The tag diff (`computeDifferences`) and the tag-overlap shortcut in `detectSameSubject` were **removed**: `mnemo_fact` has no `tags` column, so that code could never fire in production. The `related` verb was also **removed** from `SuggestableVerb` (it now has only 4 values): its only precondition (`factA.workspaceId !== factB.workspaceId`) is unreachable from a real MCP process, which is tied to a single `MnemosyneClient`/workspace for the life of the process; a cross-workspace attempt 404s before reaching `suggestVerb`. `sameSubject` now compares only `content` tokens (there is no tag overlap to check first). The verb suggestion follows a decision tree: if `sameSubject` is true, it compares `createdAt`; if they differ by more than 60 seconds, it suggests `supersedes`; if they are very close in time, it suggests `conflicts_with` (it assumes a contradiction, not an update). If `sameSubject` is false, it checks whether exactly one of the two facts has a closed `validTo` (`scoped`); if not, it falls back to the default `compatible` (before: it compared `workspaceId` and could return `related`).

**Parameters**:

- `factIdA` (string, required, min 1 char): ID of the first fact (e.g. `mfact_...`).
- `factIdB` (string, required, min 1 char): ID of the second fact.

There are no other parameters; the tool accepts no filters, limits, or format options.

**When to use it — use cases**:

1. Detecting whether a user preference changed ("does the new fact replace the old one or contradict it?").
2. Before calling `memory_relate`, using `memory_compare` to get the suggested verb instead of guessing it by hand.
3. Auditing duplicates: two nearly identical facts with slightly different content; checking whether they are the same thing rephrased.
4. Debugging recall: when `memory_recall` returns two hits that look redundant, comparing them to decide whether a `forget()` or a `supersedes` relation is the better choice.

**Edge cases and gotchas**:

- **`related` no longer exists as a possible verb (fixed, B6)**: a pair of genuinely unrelated facts now always falls into `compatible`, by design, not as a side effect of an unreachable precondition. Covered in `packages/mcp/src/__tests__/contracts/compare.test.ts`.
- **Tags never appear in the diff (fixed, B6, dead code removed)**: `mnemo_fact` has no `tags` column in the baseline schema, and `rowToFact` (in `packages/core/src/factory-mappers.ts`) hardcodes `tags: []`, so the tag diff and the tag-overlap shortcut in `detectSameSubject` were deleted instead of being left as disclosed dead code. Every real comparison runs only the content token overlap check.
- There is no sensitivity distinction beyond what `POST /facts/compare` already applies server-side (the same 3-step guard as `GET /facts/:id`, RLS-scoped). If one of the two IDs belongs to a fact outside the caller's sensitivity ceiling, or does not exist, or is closed, the endpoint responds 404 (anti-probing, never 403) and the whole comparison is canceled with `isError: true`.
- Different from `memory_relate`: `memory_compare` **creates no relation**; it only suggests. You have to call `memory_relate` separately with the chosen verb.

**Examples**:

```json
{ "factIdA": "mfact_01J...abc", "factIdB": "mfact_01J...xyz" }
```

```json
{ "factIdA": "mfact_pref_theme_dark", "factIdB": "mfact_pref_theme_light" }
```

---

## `memory_session`

**What it does**: Unified session control tool (spec §24) that consolidates 10 operations under a single `action` discriminator. It replaces (additively; the legacy tools keep working) the surface that was previously fragmented across `memory_pin`, `memory_episode_start`, and `memory_episode_end`, and adds two actions (`get`/`list`) that closed a real gap: the `GET /session/:id` and `GET /session/list` routes existed server-side but were not reachable from any client because `client-ts` had no wrapper methods (an "orphan route" bug found in the fidelity audit, 2026-07-31).

Each `action` maps to a different `client-ts` method and a different HTTP route: `start`→`POST /session/start`, `turn`→`POST /session/:id/turn`, `pin_turn`→`POST /session/:id/pin`, `pin`→`POST /facts/:id/pin`, `scratch`→`POST /session/:id/scratch`, `collapse`→`POST /session/:id/collapse`, `discard`→`POST /session/:id/discard`, `feedback`→`POST /session/:id/feedback`, `get`→`GET /session/:id`, `list`→`GET /session/list`.

`start` also triggers anticipation pre-injection (§30): if `deps.storage` and `deps.workingMemory` are wired, it computes anticipated memories and returns them in the `anticipated` field of the response (it fails silently and never blocks session creation). `collapse` resolves a per-agent `CollapsePolicy` (`maxTurns`/`maxTokens`/`inactivityTimeout` thresholds) and runs the full 8-step extraction pipeline asynchronously (202 Accepted); it supports idempotent retries through `idempotencyKey`, returning `resumed: true` if an already completed phase is skipped. `feedback` maps `rating: "up"/"down"` to an `explicitSignal` that updates the worth of all the facts recalled during that session. `discard` archives without collapsing; importantly, it does NOT run knowledge extraction (an earlier bug called `collapseSession` here by mistake).

**Parameters**:

- `action` (enum, required): `start | turn | pin_turn | pin | scratch | collapse | discard | feedback | get | list`.
- `sessionId` (string, optional): required for `turn`, `pin_turn`, `collapse`, `scratch`, `discard`, `feedback`, `get`.
- `rating` (enum `up|down`, optional): required for `feedback`.
- `agentId` (string, optional): for `start`.
- `factId` (string, optional): required for `pin`.
- `turnIndex` (number int, optional): for `pin_turn`.
- `turnId` (string, optional): for `turn`/`pin_turn`.
- `unpin` (boolean, optional, default false): pass `true` to unpin instead of pin (`pin`/`pin_turn`).
- `content` (string, max 20 000, optional): for `scratch` and `turn`.
- `role` (enum `user|assistant|system`, optional): default `assistant` in `scratch`, `user` in `turn`.
- `collapseHint` (string, optional): forces `explicit` extraction instead of `auto` heuristics.
- `metadata` (record, optional): used by `start`, `turn`, `scratch`.
- `idempotencyKey` (string, optional, §34.9): prevents the operation from being applied again on retries.

**When to use it — use cases**:

1. Opening a session at the start of a multi-turn conversation (`start`), adding turns (`turn`), and closing it with `collapse` so the pipeline extracts facts/decisions/episodes.
2. Saving an ephemeral working note while the agent solves a problem (`scratch`) without committing it to durable memory yet.
3. Pinning a critical turn inside a long session so it survives the collapse policy (`pin_turn`), as opposed to pinning an already persisted fact (`pin`).
4. Recording explicit user feedback at the end of a task (`feedback`) to adjust the worth of the facts used.

**Edge cases and gotchas**:

- `pin` (an action of this tool) protects a fact from automatic forgetting/merging; it does **not** give it priority in recall. Assuming that "pinned" implies "top of results" is a common mistake.
- `scratch`: `content` is stored under the `note` key inside the scratch object; any additional `metadata` is spread next to `note`, so it can overwrite the `role` key if both are passed with conflicting names.
- `discard` vs `collapse`: `discard` throws away the ephemeral buffer without extraction; it is irreversible, and everything not collapsed is lost. This is the key difference between "close and learn" and "close and forget".
- If a `sessionBuffer` (Redis) is wired, `turn` writes with write-through (Redis + Postgres); if not, it uses `core.appendTurn` straight to Postgres. The latency behavior differs depending on the server configuration, invisible from the tool.
- `SessionOut.lastRecallAt` is read from `metadata.lastRecallAt`; it is not a first-class field in the table, and it only appears if some `POST /recall` passed that `sessionId`.

**Examples**:

```json
{ "action": "start", "agentId": "support-bot", "metadata": { "channel": "slack" } }
```

```json
{ "action": "collapse", "sessionId": "sess_01J...", "collapseHint": "explicit" }
```

---

## `memory_task`

**What it does**: Full CRUD plus domain verbs for actionable tasks with a lifecycle. The status is validated by an explicit state machine (`packages/core/src/cognitive/tasks.ts`, `TASK_TRANSITIONS`), enforced **only** on the `patch` path (server-side, `PATCH /tasks/:id`), which rejects illegal transitions with 409 through `IllegalTaskTransitionError`. The valid transitions are:

```
pending     → in_progress, cancelled
in_progress → blocked, completed, delegated, cancelled
blocked     → in_progress, cancelled
delegated   → completed, cancelled
completed   → (terminal, sin salida)
cancelled   → (terminal, sin salida)
```

`delegate` calls the dedicated `POST /tasks/:id/delegate` route, which applies the same transition validation (`assertValidTransition(status, "delegated")`), stamps `delegatedBy`/`delegatedAt`, and honors a policy allow-list (`canDelegateTo`); it can reject with 403 if the agent's policy forbids it. `complete` is syntactic sugar over `PATCH` with `status: "completed"`; the server's PATCH handler triggers `autoExtractOnCompletion` on the first fresh transition to `completed` (it does not run again if the task was already completed): if `lessonsLearned` is populated, it creates a `MnemoStrategy` + a `derived_from` relation; if `outcome` is populated, it creates a `MnemoFact` (kind `"other"`, attribution `"inferred"`) + a `derived_from` relation; it always creates a `MnemoEpisode` narrating the closure, and emits an immutable `MnemoEvent` (`name: "task.completed"`, `source: "task_auto_extract"`) linking the strategy/fact/episode by id in its `metadata`.

**Parameters**:

- `action` (enum, required): `create | get | list | patch | archive | delegate | complete`.
- `id` (string, optional): required for `get/patch/archive/delegate/complete`.
- `title` (string, 1–500, optional): required for `create`.
- `description` (string, max 20 000, optional).
- `status` (enum, optional): `pending | in_progress | blocked | delegated | completed | cancelled`.
- `priority` (enum, optional): `critical | high | medium | low`.
- `assignedTo` (string, optional): required for `create` and `delegate`.
- `sessionId`, `parentTaskId` (string, optional).
- `dueAt` (ISO datetime, optional).
- `sensitivity` (enum `public|internal|confidential|restricted`, optional, default `internal`).
- `outcome`, `lessonsLearned` (string, max 20 000, optional).
- `metadata` (record, optional).
- `parentTaskIdFilter` (string, optional): `list` filter.
- `limit` (int 1–500, optional).
- `idempotencyKey` (string, optional): applies only to `create`.

**When to use it — use cases**:

1. Creating a work item with an owner (`assignedTo`) and a due date, with hierarchical dependencies (`parentTaskId`).
2. Breaking a large task into subtasks and tracking their progress through `status`.
3. Delegating a task to another agent with `delegate`, honoring the policies on who can delegate to whom.
4. Closing a task with `complete`, including `outcome` and `lessonsLearned` so the system extracts knowledge automatically with no manual effort.

**Edge cases and gotchas**:

- **`archive` now respects the terminal state (fixed, B7, 2026-08-10).** `DELETE /tasks/:id` still calls `storage.archiveTask()` without going through `assertValidTransition` (a guard there would have broken archiving `completed` tasks, since `TASK_TRANSITIONS.completed === []`), but `archiveTask` itself stopped unconditionally forcing `status: "cancelled"`: it now uses `SET valid_to = now(), status = CASE WHEN status IN ('completed','cancelled') THEN status ELSE 'cancelled' END` (the same fix in `TaskRepository` and `InMemoryStorageAdapter`, exported as `TERMINAL_TASK_STATUSES` from `@mnemo-ai/types`). Effect: an archived `completed` task keeps `status: 'completed'` (with `validTo` closed); a non-terminal task is still canceled as before. `action: "patch", status: "cancelled"` on a `completed` task still rejects with 409, unchanged; the real asymmetry between the two closing paths is now closed.
- `sensitivity` defaults to `"internal"`, not `"public"`: a caller that omits the field does not get the most visible task, it gets the middle tier.
- Different from `memory_event`: tasks have mutable state and a lifecycle; events are immutable. For "something that already happened", use `memory_event`; for "something that has to be done", use `memory_task`.
- The auto-extract on `complete` is best-effort: if it fails, the status was already committed (`completed`) and the error is swallowed silently (an empty catch in the server), so there is no guarantee that a derived fact/strategy exists even if `outcome`/`lessonsLearned` were populated.
- The `taskScopes.canCreate`/`canDelegate`/`canDelegateTo` policy is looked up by the credential's raw `actorId`, not by the namespaced `ActorRef`; this is consistent with `rbac-policy.ts`/`ratelimit.ts`, but keep it in mind when debugging why a policy does not apply.

**Examples**:

```json
{
  "action": "create",
  "title": "Migrar tabla mnemo_task a partición mensual",
  "assignedTo": "agent:db-migrator",
  "priority": "high",
  "dueAt": "2026-08-15T00:00:00Z"
}
```

```json
{
  "action": "complete",
  "id": "mtask_01J...",
  "outcome": "Migración aplicada sin downtime.",
  "lessonsLearned": "Usar CREATE INDEX CONCURRENTLY antes del ALTER, no después."
}
```

---

## `memory_event`

**What it does**: Records an immutable event in the workspace log (`mnemo_event`, append-only by design, with no `updatedAt`). It supports 6 actions: `create`, `get`, `list`, `archive` (a declared NO-OP), `annotate` (append-only), `sensitivity` (raise-only). On `POST /events`, the server also triggers a hidden but documented automation (T14): it creates a `MnemoFact` from `event.description` in a fire-and-forget way (`tags: ["auto:event"]`, `attribution: { source: "event", eventId, eventName }`), merging event→memory with no manual effort from the caller.

`archive` is the most notable case: `mnemo_event` **has no status column** in the schema, so `DELETE /events/:id` responds `204` but does not touch the row at all. The tool is designed not to lie about this; it explicitly returns `{ id, archived: false, immutable: true }` instead of `{ archived: true }`, so the caller can tell a real archive from a no-op. `sensitivity` is raise-only: the server compares with `sensitivityAtLeast(new, existing)` and responds `422` if you try to lower the tier. Reducing the sensitivity of an already written event is never allowed, consistent with the append-only principle.

**Parameters**:

- `action` (enum, required): `create | get | list | archive | annotate | sensitivity`.
- `id` (string, optional).
- `type` (enum, optional): `system | external | user | agent | scheduled`; required for `create`.
- `name` (string, 1–500, optional): required for `create`.
- `description` (string, max 20 000, optional): required for `create`.
- `occurredAt` (ISO datetime, optional): required for `create`.
- `durationS` (non-negative int, optional).
- `source` (string, 1–200, optional): required for `create`.
- `relatedEntities` (array of strings, optional).
- `metadata` (record, optional).
- `sourceFilter`, `after`, `before` (optional): `list` filters.
- `limit` (int 1–500, optional).
- `sensitivity` (enum, optional): initial tier on `create` (default `internal`); required new tier on the `sensitivity` action (it must be ≥ the current one).
- `idempotencyKey` (string, optional): applies only to `create`.
- `author` (string, 1–200, optional): required for `annotate`.
- `content` (string, 1–20 000, optional): required for `annotate`.
- `at` (ISO datetime, optional): optional timestamp for `annotate`.

**When to use it — use cases**:

1. Recording a webhook received from an external system (`type: "external"`, `source: "github"`).
2. Logging a completed deploy or migration (`type: "system"`, `source: "ci"`), taking advantage of the automatic fact creation so the event becomes semantically searchable.
3. Adding after-the-fact context to an existing event that cannot be edited (`annotate`), for example troubleshooting notes added later.
4. Raising the sensitivity of an event when it turns out to contain more sensitive data than first thought (`sensitivity`, raise-only).

**Edge cases and gotchas**:

- `action: "archive"` is a no-op: if the caller expects the event to stop appearing in `list`, it will fail, because it always keeps appearing. The tool documents this in its own `description` and in the output (`immutable: true`), but it is easy to overlook.
- If you need mutable state (something that can really be closed/archived), the tool itself recommends using `memory_remember` (`kind: 'fact'`) or `memory_task` instead, not `memory_event`.
- `sensitivity` with the `sensitivity` action returns `422`, not `403`, if you try to lower the tier; it does not follow the "404 anti-probing" pattern of read-ceiling violations, it is a different business validation.
- The automatic fact creation (T14) is fire-and-forget (`.catch(() => {})`): if it fails, the event is created anyway and there is no sign in the response that the fact was not generated.
- Difference from `memory_task`: events have no owner or lifecycle; they are one-off facts that already happened, not pending work. Do not use `memory_event` to track something that needs to be "resolved".

**Examples**:

```json
{
  "action": "create",
  "type": "external",
  "name": "Webhook de pago recibido",
  "description": "Stripe confirmó el pago del invoice #4521.",
  "occurredAt": "2026-08-06T14:30:00Z",
  "source": "stripe",
  "sensitivity": "confidential"
}
```

```json
{
  "action": "annotate",
  "id": "mevt_01J...",
  "author": "user:pablo",
  "content": "Confirmado manualmente contra el dashboard de Stripe."
}
```

---

## `memory_reasoning`

**What it does**: Persists and retrieves reasoning chains (question → steps → conclusion) as a chain-of-thought cache (spec §8). It offers standard CRUD (`create/get/list/patch/archive`) plus three domain verbs that implement the full cache cycle: `resolve` (is there a reusable CoT for this question?), `record` (record a new CoT with deduplication), `feedback` (report whether a cached CoT worked, adjusting its lifecycle).

**`resolve`** has two paths: if `topicKey` is passed, it does an exact O(1) lookup and applies `passesTopicKeyResolveGate`, the same gate as the vector path, to prevent a topic-key match from serving a low-evidence CoT. If there is no `topicKey` or it does not match, it falls back to the vector path: it embeds the query, finds the 5 nearest candidates by cosine, and applies `resolveDecision`, whose gate requires **all three conditions at once**: `status` in (`active`,`golden`), cosine ≥ 0.88, `worth` > 0.5, AND the Wilson lower bound (`wilsonLowerBound(successCount+1, failureCount+1)`) > 0.3. Only if all three hold is it a "hit"; otherwise it is "execute" (recompute), returning up to 3 similar attempts.

**`record`** looks for duplicates by cosine; if the top candidate has cosine ≥ 0.95 (`DEDUP_COSINE`), it upserts worth on the existing one instead of inserting a new one. **`feedback`** updates `successCount`/`failureCount` (delta 0/1 depending on `outcome`) and then evaluates `lifecycleTransition`: if `worth` falls below 0.3 (`QUARANTINE_WORTH`), it moves to `quarantined` (unless it already is); if `worth` > 0.8 (`GOLDEN_WORTH`) and `usageCount` ≥ 50 (`GOLDEN_MIN_USES`), it promotes to `golden`; if it was `quarantined` and the worth recovered to ≥ 0.3, it goes back to `active`.

**About "worth decay"**: `worth` is a `GENERATED ALWAYS AS worth_alpha / (worth_alpha + worth_beta)` column in Postgres, the same Beta-Bernoulli model as `memory_strategy`, with a Beta(2,2) prior. **It does not decay with the mere passage of time or from lack of use**; it only changes when `record` or `feedback` explicitly move `successCount`/`failureCount`. The comment on the `MnemoReasoning` type in `primitives.ts` says "worth... decays with disuse", which is inaccurate: without explicit feedback, worth stays frozen at its current value indefinitely.

**Parameters**:

- `action` (enum, required): `create | get | list | patch | archive | resolve | record | feedback`.
- `id`, `agentId` (string, optional).
- `question`, `conclusion` (string, max 20 000, optional): required for `create`/`record`.
- `chain` (array of `{step: int, reasoning: string, conclusion?: string}`, max 200 steps, optional): required and non-empty for `create`/`record`.
- `topicKey` (string, max 200, optional).
- `status` (enum, optional): `active | archived | pruned | quarantined | golden`.
- `metadata` (record, optional).
- `topicKeyFilter` (string, optional), `limit` (int 1–500, optional): `list` filters.
- `query` (string, max 20 000, optional): required for `resolve`.
- `outcome` (enum `success|fail`, optional): required for `record` and `feedback`.
- `reasoningId` (string, optional): required for `feedback`.
- `sensitivity` (enum, optional, default `internal`).

**When to use it — use cases**:

1. Caching a non-obvious piece of reasoning that took several LLM steps, so it is not recomputed the next time a similar question appears (`record`).
2. Before reasoning from scratch about a problem, checking whether a reusable CoT already exists (`resolve`); it saves tokens if there is a hit.
3. Reporting that a cached CoT led to a wrong result (`feedback` with `outcome: "fail"`), so its worth drops and it is eventually quarantined.
4. Building a library of "how I reasoned about X" that can be browsed by `topicKey` for a recurring domain (e.g. RLS debugging).

**Edge cases and gotchas**:

- A newly created CoT starts at Beta(2,2) (worth 0.5, Wilson lower bound ≈0.15), so it **can never be a hit** in `resolve` until it accumulates at least some explicit positive feedback (the gate requires Wilson > 0.3). There is no automatic bootstrapping like in the facts gate (`passesWorthGate`, which exempts never-observed facts); here the gate always applies, with no exception for new CoTs.
- `resolve` with no LLM wired (`deps.llm` absent) always returns `{ action: "execute", similar_attempts: [] }` if there is no `topicKey`; it degrades silently with no error.
- `resolve` with `topicKey`: if the candidate exists but does not pass the gate, it falls back to the vector path instead of failing; this is fallback behavior, not an error.
- Different from `memory_strategy`: reasoning caches reusable _thought processes_ for a specific question; strategy caches _conditional heuristics_ (trigger→action) that apply recurrently. Do not use reasoning for "when X happens, do Y"; that is `memory_strategy`.

**Examples**:

```json
{
  "action": "record",
  "question": "¿Por qué falla el RLS al insertar en mnemo_task desde un job cron?",
  "chain": [
    { "step": 1, "reasoning": "El job usa el rol superuser de conexión, no app_user." },
    { "step": 2, "reasoning": "withMnemoTx no se está llamando en el path del cron." }
  ],
  "conclusion": "Envolver la escritura del cron en withMnemoTx.",
  "topicKey": "rls-cron-jobs",
  "outcome": "success"
}
```

```json
{
  "action": "resolve",
  "query": "por qué el cron no respeta RLS al escribir tareas",
  "topicKey": "rls-cron-jobs"
}
```

---

## `memory_strategy`

**What it does**: CRUD + domain verbs for trigger→action heuristics (`mnemo_strategy`): "when X happens, do Y". It uses `op` as the discriminator (not `action`, because the strategy's `action` field is already taken by the response to execute). `store`/`create` are true aliases at the code level (same handler); `recall`/`list` are also aliases, with the difference that `recall` filters `status: "active"` by default (a real filter, not cosmetic) unless an explicit `statusFilter` is passed, whereas `list` with no filter returns everything. `rate` records an outcome (`success`/`failure`) against `POST /strategies/:id/rate`, which recomputes `successCount`/`failureCount` and, on the server, computes `newWorth = alpha/(alpha+beta)` with `alpha = 2 + successCount`, `beta = 2 + failureCount` and passes it to `updateStrategy`.

**Verified internal detail**: `worth` in `mnemo_strategy` is a `GENERATED ALWAYS AS worth_alpha / NULLIF(worth_alpha + worth_beta, 0)` column. The repository (`KnowledgeRepository.updateStrategy`) **silently ignores** any explicit `worth` that arrives in the input; it only derives `worthAlpha`/`worthBeta` from `successCount`/`failureCount` (the same Beta(2,2) prior as reasoning) when those two fields change. The `newWorth` computed in the `/strategies/:id/rate` HTTP route is, in practice, dead/redundant code: the real value that ends up in the row is recomputed by Postgres with the same formula, so the observable result matches, but the responsibility for the calculation lives in two places at once.

**Parameters**:

- `op` (enum, required): `create | get | list | patch | archive | store | recall | rate`.
- `outcome` (enum `success|failure`, optional): required for `rate`.
- `id` (string, optional): required for `get/patch/archive`.
- `trigger`, `action` (string, max 20 000, optional): both required for `create`/`store`.
- `context` (string, max 20 000, optional).
- `agentId`, `supersedesId` (string, optional).
- `status` (enum, optional): `active | superseded | archived`.
- `validFrom`, `validTo` (ISO datetime, optional).
- `metadata` (record, optional).
- `statusFilter` (enum `active|superseded|archived`, optional): explicit `list`/`recall` filter.
- `validAt` (ISO datetime, optional): temporal filter.
- `limit` (int 1–500, optional).
- `sensitivity` (enum, optional, default `internal`).
- `scopeRef` (string, optional): scopes the strategy to a specific project/context (e.g. `"project-x"`).
- `idempotencyKey` (string, optional): only for `create`/`store`.

**When to use it — use cases**:

1. Saving a learned heuristic ("if the user asks about pricing, show them the enterprise plan first") with `store`.
2. Retrieving the active strategies relevant to the current context before deciding how to act (`recall`).
3. Reporting whether applying a strategy worked or not (`rate`), so its worth converges toward its real success rate.
4. Superseding an obsolete strategy with a new one (`supersedesId` on `create`, then `patch` the old one to `status: "superseded"`).

**Edge cases and gotchas**:

- `recall` with an explicit `statusFilter` respects that filter entirely; the `"active"` default only applies if the filter is omitted. If a caller passes `statusFilter: "archived"` under `op: "recall"`, it gets archived strategies, not an error.
- Difference from `memory_reasoning`/`memory_task`: strategy is for general recurring heuristics ("when X, Y"), not for one-off task plans (`memory_task`) nor for caching a specific reasoning process (`memory_reasoning`).
- `scopeRef` is not the same as `workspaceId`: it lets you narrow a strategy to a project/entity within the same workspace; a strategy without `scopeRef` is visible across the whole workspace (depending on how it is filtered in `list`).
- A prior audit (2026-07-28, see `docs/STATUS.md`) verified this tool as clean, with no discrepancies between what is documented and the code, unlike other tools in the set.

**Examples**:

```json
{
  "op": "store",
  "trigger": "El usuario reporta un error 500 en producción",
  "action": "Pedir el traceId y consultar mnemo_audit_log antes de escalar.",
  "scopeRef": "chatbot-service"
}
```

```json
{ "op": "rate", "id": "mstrat_01J...", "outcome": "success" }
```

---

## `memory_hyperedge`

**What it does**: CRUD for hyperedges: n-ary relations that connect **3 or more** primitives that co-activate under a shared context. Unlike `memory_relate` (always binary, 9 fixed verbs: `related`, `compatible`, `scoped`, `conflicts_with`, `supersedes`, `not_conflict`, `derived_from`, `part_of`, `member_of`), a hyperedge has no verb; it is an undirected group of `memberIds` with an optional `label`/`description`/`contextQuery`. `create`, `get`, `list`, `patch`, `archive` are the only 5 actions; there are no additional domain verbs like in task/reasoning/strategy.

**Finding about `worth`, now fixed (B8, 2026-08-10)**: `docs/STATUS.md` and the `MnemoHyperedge` docstring in `primitives.ts` always claimed that "worth decays via TD(λ) 0.1-step updates". The mechanism (`StorageAdapter.updateWorth("hyperedge", ...)`, ±0.1 clamped to [0,1]) always existed, but until this fix it **had no real caller**: neither `memory_self_edit` strengthen/weaken (they only target fact/strategy) nor `PATCH /hyperedges/:id` (only `label`/`description`/`contextQuery`) reached it, so `worth` stayed frozen at 0.5 from creation. **Fix**: `POST /recall` now triggers `recordHyperedgeCoActivation(storage, workspaceId, hitIds)` through `setImmediate` (best-effort, fire-and-forget, the same pattern as the existing Hebbian helper `recordCoRecallStdpForHits`) when the call returns ≥2 hits: for each hyperedge relevant to those hits (`getRecallStructures`), if ≥2 of its members are in the served set, it is a real reinforcement (`updateWorth(..., {success:1, failure:0})`); if exactly 1 is, it is a weakening (`{success:0, failure:1}`). Errors are swallowed silently; it never breaks recall. `bumpHyperedgeActivation` (invoked by `OutboxWorker` on `hyperedge_bump` events) still does not touch `worth`, only `activationCount`; it remains the only separate "activity" signal.

`recall-cold.ts` does _use_ `hyperedge.worth` for scoring: in the co-member expansion (spec §15), it injects co-members of hyperedges with `worth > 0.5` as additional `RecallHit`s with `score = parentScore × hyperedge.worth`. Before the fix, `worth` never moved from the 0.5 default and that co-member expansion never fired in practice except by manual DB setting (the creation schema does not expose that field either); now, real co-activation in recall moves `worth` over time, activating the expansion organically for genuinely relevant hyperedges.

**Parameters**:

- `action` (enum, required): `create | get | list | patch | archive`.
- `id` (string, optional): required for `get/patch/archive`.
- `memberIds` (array of strings, min 3, max 50, optional): required for `create`, at least 3 primitive IDs.
- `label` (string, 1–200, optional).
- `description` (string, max 20 000, optional).
- `contextQuery` (string, max 20 000, optional).
- `memberIdFilter`, `labelFilter` (string, optional): `list` filters.
- `limit` (int 1–500, optional).
- `idempotencyKey` (string, optional): only for `create`.

**When to use it — use cases**:

1. Grouping 3+ facts/decisions that systematically appear together in the context of the same recurring problem.
2. Modeling a thematic cluster (e.g. "everything related to the August RLS migration") without forcing artificial binary relations between every pair.
3. Querying which hyperedges include a given primitive (`memberIdFilter`) to understand its full semantic neighborhood.
4. Labeling and documenting a group with `label`/`description` to make it discoverable in `list`.

**Edge cases and gotchas**:

- Do not use it for pairwise relations: `memberIds` requires a minimum of 3; for binary ones use `memory_relate`.
- A hyperedge's worth does now move organically (B8): every `POST /recall` with ≥2 hits that touch a relevant hyperedge adjusts its `worth` best-effort through co-activation. There is still no explicit endpoint to force the adjustment manually; the only caller is the automatic recall.
- `activationCount` is incremented for real (Hebbian) every time its members are recalled together in a recall; it is the only genuinely live "activity" signal on this primitive.
- The `mnemo_hyperedge` table has no `metadata` column (unlike the other 9 primitives) nor `contextEmbeddingModel`; any attempt to save arbitrary metadata on a hyperedge has nowhere to persist.
- `archive` is a real archive (soft-delete with `validTo`), unlike the no-op of `memory_event`; do not confuse the two behaviors across primitives.

**Examples**:

```json
{
  "action": "create",
  "memberIds": ["mfact_01J...a", "mdec_01J...b", "mepi_01J...c"],
  "label": "incidente-rls-agosto",
  "description": "Facts, decisión y episodio del incidente de RLS bypass en cron jobs."
}
```

```json
{ "action": "list", "memberIdFilter": "mfact_01J...a", "limit": 20 }
```

---

## `memory_introspect`

**What it does**

`memory_introspect` exposes the workspace's **SelfModel**: an aggregate summary of how well the agent "knows" each topic/entity, which topics are strong, which are knowledge gaps, and how that cognitive health evolved over time. It does not return the content of individual facts, only aggregates per entity/topic (a comment in the code: "intentionally workspace-aggregate-only... no per-fact content is exposed", `packages/core/src/cognitive/metacognition.ts`).

The MCP handler (`packages/mcp/src/tools/introspect.ts`) calls `client.getSelfModel()` → `GET /metacognition` (`packages/server/src/routes/metacognition.ts`) → `buildSelfModel()` in `packages/core/src/cognitive/metacognition.ts`. This function reads three sources through the `StorageAdapter` port, in parallel:

- **`getConfidenceMap`**: reads the materialized view `mv_confidence_map` (one row per entity, `LEFT JOIN` with active `mnemo_fact`). It computes `coverage_level` (`expert`: ≥10 facts and avgWorth>0.7; `familiar`: ≥5 and avgWorth>0.5; `aware`: ≥2; `minimal`: ≥1; `blind`: 0 facts) and `freshness` (`current`: newest fact <7 days old; `recent`: <30 days; `aging`: <90 days; `stale`: the rest), based on `f.created_at`.
- **`getKnowledgeGaps`**: reads `mv_knowledge_gaps`, grouped by `topic_key`. `gap_score = recall_hits_30d × (1 − avg_worth) / GREATEST(evidence_volume, 1)`; it prioritizes topics that are recalled often but have low confidence and little accumulated evidence.
- **`getMetacognitionTrends`**: invokes the SQL function `mnemo_metacognition_trends(workspace_id)`, which returns 4 `{current, previous, delta}` pairs comparing the last 7 days against the previous 7: `recallHitRate`, `avgRecallLatency` (proxy: average of `activation_score`), `sessionCollapseQuality` (average of `outcome_rating`: success=1, neutral=0.5, failure=0), `strategySuccessRate` (average of `worth` in `mnemo_strategy`).

On top of `confidence` (filtered by `entity` if passed), `buildSelfModel` derives `strongTopics`/`strengths` (avgWorth ≥ 0.7, evidenceVolume ≥ 5, factCount ≥ 3, top 25 ordered by `avgWorth × evidenceVolume`) and computes `summary` (totalTopics, strongTopicsCount, gapsCount, blindCount, avgWorthAcrossWorkspace) **always over the full set of entities**, regardless of the requested `aspect`. Each gap gets a `suggestedAction` through `recommendAction`: `recallHits30d ≥5 && avgWorth<0.2` → `search_codebase`; `recallHits30d <5` → `wait_for_data`; in any other case → `ask_user`.

Important: the two materialized views (`mv_confidence_map`, `mv_knowledge_gaps`) are refreshed once a day through cron (`mnemo.metacognition.refresh`, 07:00 UTC, `packages/server/src/cron/jobs.ts`); **they are not real-time data** and can have up to ~24h of latency.

**Parameters** (Zod schema in `introspect.ts`):

| Parameter | Type   | Required | Default | Description                                                                                                                                                                                                                                                                                                                  |
| --------- | ------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aspect`  | enum   | No       | `"all"` | Accepts **two vocabularies** that the handler maps to the backend's real aspects: `coverage`, `trends`, `gaps`, `strengths`, `all` (native) and `health`, `worth`, `drift`, `types`, `recent_changes` (legacy aliases). Mapping: `health→all`, `worth→strengths`, `drift→trends`, `types→coverage`, `recent_changes→trends`. |
| `entity`  | string | No       | —       | Case-insensitive substring filter against `canonicalName` (confidenceMap) and `topicKey` (gaps). It is applied over the rows already fetched from the DB, not in the SQL `WHERE`.                                                                                                                                            |
| `limit`   | number | No       | `10`    | 1–200. Trims (post-fetch, in the HTTP route) the 4 lists `confidenceMap`, `strongTopics`, `strengths`, `gaps`; it does not apply to `summary` or `trends`.                                                                                                                                                                   |

**When to use it — use cases**

1. Before stating something with confidence about a topic ("how well do I know X?"), call with `aspect: "coverage", entity: "X"` to check whether the level is `expert`/`familiar` or barely `aware`/`minimal`/`blind`.
2. Detecting topics the agent consults often but never quite learns well (`aspect: "gaps"`), to decide whether it is better to ask the user, search the source code, or simply wait for more evidence.
3. Monitoring the health of the memory pipeline over a week (`aspect: "trends"` or its alias `"drift"`): seeing whether the recall hit rate or strategy success is going up or down.
4. When starting a long session, requesting `aspect: "strengths"` to know which areas it can cite with confidence without needing additional explicit recall.

**Edge cases and gotchas**

- **Freshness**: the data comes from MVs with a daily refresh (07:00 UTC); a freshly saved fact does not appear in the SelfModel until the next refresh.
- **`summary` does not respect `aspect`**: it always reflects the whole workspace (even if you request only `gaps`, `summary.totalTopics`/`avgWorthAcrossWorkspace` count all entities).
- If there is no session/recall data yet, `trends` returns zeros in the 4 pairs, not `null` or an error.
- There is no `withMnemoTx` in between: the route reads `deps.storage` directly; workspace isolation comes from the explicit `WHERE workspace_id = ...` in every query on the MV (MVs do not inherit RLS).
- `docs/architecture/API.md` is outdated: it documents a different, nonexistent schema (`required: ["aspect"]` limited to 5 values, a flat response `{status, factCount, avgWorth, staleCount, driftScore, recallMode}`) that does not match the real code. Do not use it as a reference.
- Different from `memory_recall`: `memory_introspect` does not return individual recallable memories, only aggregate statistics; it is self-assessment, not search.

**Examples**

```json
{ "aspect": "gaps", "entity": "autenticación", "limit": 5 }
```

```json
{ "aspect": "trends" }
```

---

## `memory_anticipate`

**What it does**

`memory_anticipate` predicts which memories will be useful in the next few minutes, combining **4 statistical signals with fixed weights that add up to 1.0**, computed purely over storage reads (no LLM or vector index) in `packages/core/src/cognitive/anticipation.ts::buildAnticipationFeed`:

1. **Sequential (weight 0.35)**: requires `recentlyRecalledId`. It reads `mv_sequential_patterns` (pairs of facts recalled one after the other within a 5-minute window, over the last 30 days of `mnemo_recall_log`), filtering `confidence ≥ 0.3`. Score contributed = `confidence × 0.35`.
2. **Periodic (weight 0.25)**: **requires no parameter, it always runs**. It reads `mv_periodic_patterns`: for each `(day_of_week, 3-hour hour_bucket)` in **UTC**, it computes what fraction of a fact's recalls fall in that slot (`slot_share`), requiring ≥3 distinct weeks of evidence and `slot_share ≥ 0.20`. The slot queried is `now + lookAhead` minutes, not the current one. Score = `slotShare × 0.25`.
3. **Conditional (weight 0.25)**: requires `context`, does not depend on `recentlyRecalledId`. It reads `mv_conditional_patterns`: exact matches (`lower(btrim(...))`, not fuzzy search) between the received `context` and the historical `query_key` in `mnemo_recall_log`, with at least 4 co-occurrences and `confidence ≥ 0.5`. Score = `confidence × 0.25`.
4. **Co-occurrence / Hebbian (weight 0.15)**: requires `recentlyRecalledId`. It reads `mnemo_relation` looking for related pairs by `co_recall_count`/`hebbian_weight` (requires `co_recall_count ≥ 2`, current relation `valid_to IS NULL`). The count is saturated by dividing by 10 (10+ co-recalls = maximum signal). Score = `min(1, coRecallCount/10) × 0.15`.

If the same id is reached by more than one signal, their weighted scores are **summed** and its `source` becomes `"blended"`, concatenating the `rationale` of each signal. The final result is sorted by descending score and trimmed to `limit`.

The materialized views `mv_sequential_patterns`, `mv_periodic_patterns`, and `mv_conditional_patterns` are refreshed daily through cron (`mnemo.anticipate.mine`, 06:30 UTC); the co-occurrence signal, by contrast, reads `mnemo_relation` directly (live data, not an MV).

**5th signal — LLM enrichment (fixed in the tool description, D7, 2026-08-10)**: when `context` is passed and an LLM adapter is configured (workspace or boot), the HTTP route (`packages/server/src/routes/anticipation.ts::enrichWithLlmContext`) asks the LLM for 2-3 related search queries, runs `core.recall()` with each one, and merges the new hits (fixed score `0.1 × hit.score`, `source: "conditional"`), deduplicating by id. It is additive and fails silently (log + unchanged feed) if the LLM is unavailable or answers badly. This signal is now explicitly listed in the `description` of `memory_anticipate` (`packages/mcp/src/tools/anticipate.ts`), next to the 4 statistical ones; before the fix it was only documented here.

**Parameters** (Zod schema in `anticipate.ts`):

| Parameter            | Type                 | Required | Default     | Description                                                                                                         |
| -------------------- | -------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `recentlyRecalledId` | string               | No       | —           | Id of the last recalled memory. Triggers the sequential and co-occurrence signals.                                  |
| `context`            | string (max 500)     | No       | —           | Free text of the current query. Triggers the conditional signal and (if there is an LLM) the additional enrichment. |
| `lookAhead`          | number int (0–10080) | No       | 30 (server) | Minutes ahead to anticipate; shifts the dow/hour slot queried by the periodic signal. Max. 10080 = one week.        |
| `limit`              | number int (1–100)   | No       | 20 (server) | Maximum number of items returned after the blend/merge.                                                             |

**When to use it — use cases**

1. Right after a successful `memory_recall`, calling with `recentlyRecalledId` to prewarm which other memories will probably be needed next (sequential + Hebbian).
2. When starting a new task, passing `context` with the task description to activate the conditional signal and detect facts that historically appear when that topic is mentioned.
3. Routines that always run at the same hour/day (standup, weekly deploy): with no parameter at all, the periodic signal alone already returns what is usually recalled in that UTC time slot.
4. Planning ahead (`lookAhead: 120`) which memories will be needed in 2 hours, to preload them before a scheduled meeting.

**Edge cases and gotchas**

- Without `recentlyRecalledId`, the periodic signal is not the only one left: if `context` is sent, the conditional one also runs.
- The matching of `context` against `query_key` is **exact** after `lower(btrim())`, not full-text or semantic; a context that does not match a historical query character for character does not trigger the conditional signal (except through the additional LLM enrichment, if an adapter is available).
- Calling with no parameters is valid: only the periodic signal runs, and it can return 0 items if there are not ≥3 weeks of history for any slot.
- Data from the 3 MVs with up to ~24h of latency (daily refresh 06:30 UTC); the co-occurrence signal is the only one with a live read.
- Different from `memory_recall`: this is not a semantic similarity search of a query; it is a prediction based on historical patterns of what is recalled together/after/at what time, without touching the vector index.
- `docs/architecture/API.md` describes a completely different tool (`taskDescription`, `prefetchCount`, `types`, response `{prefetched, cacheWarmed, topicsDetected, estimatedRecallSpeedupMs}`) that does not exist in the current code; it is outdated, do not use it as a reference.

**Examples**

```json
{ "recentlyRecalledId": "fact_8f2a1c", "lookAhead": 15 }
```

```json
{ "context": "revisando el módulo de autenticación", "limit": 10 }
```

---

## `memory_compose`

**What it does**

`memory_compose` is the MCP interface to the Compositionality / Inference Engine, a pure forward-chaining engine that runs over the results of `memory_recall`, with no infrastructure dependency (it lives in `packages/core/src/cognitive/compositionality.ts` and complies with the hexagonal purity rule). The engine applies **composition rules** (`conditionDsl`/`actionDsl` pairs stored in `mnemo_composition_rule_template` / `mnemo_composition_rule`) against the hits that recall returns, and when the conditions match, it derives new assertions (facts) or warnings.

The real evaluation cycle (`evaluateRule`):

1. It parses `conditionDsl` and `actionDsl` with Zod (`ConditionDslSchema`/`ActionDslSchema` in `packages/types/src/compositionality.ts`); a rule with an invalid DSL is discarded silently with a log warning and does not break execution.
2. `matchClauses` backtracks over the clauses of `condition.all` (up to 8 clauses) against the hits, generating variable _bindings_ (`$a`, `$b`, ...). There are 5 supported clauses: `fact_kind` (matches by `factKind`/`primitive`), `topic_key_in` (matches by tags), `text_contains` (case-insensitive substring), `relation{from,to,verb}` (walks `hit.relations`, uses the system's 9 locked verbs), and `fact_value{subject,predicate,valueType,compare}` (extracts a number or duration from the fact's text and compares it with `lt/gt/lte/gte`).
3. For each combination of bindings, it expands `action.statementTemplate` (replacing `$a`, `$ws`, etc.) to produce the `derivedStatement`.
4. It computes `confidence = baseConfidence × premiseAvgWorth` (average of the premises' `worth`/`score`), bounded to `[0,1]`.
5. **Confidence filter**: if `confidence <= minConfidence` (default `0.5` in the recall pipeline, `0` in dry-run), the inference is discarded before any side effect.
6. **Sensitivity ceiling**: the sensitivity of the derived inference can never exceed the minimum of its premises (clamped downward).
7. If `action.op === "derive_fact"`, a new `MnemoFact` is materialized (`kind: "other"`, `attribution: "inferred"`) through an atomic transaction (insert + embeddings outbox + inference log + `executionCount` bump). If it is `"derive_warning"`, it is only logged and never persisted as a fact.

`composeInferences` (the orchestrator that is called automatically after each `memory_recall`, in both `recall-cold.ts` and `recall-hot.ts`) iterates over all the workspace's active rules, sorted by `priority` DESC, and runs up to 4 fixpoint "hops" (`MAX_HOP_DEPTH=4`): in each hop, the facts derived in the previous hop are re-injected as synthetic premises so they can trigger downstream rules. It is bounded to 50 firings per call (`MAX_FIRINGS_PER_CALL`) and stops early if a hop derives nothing new. At the end it runs `resolveConflicts`: it groups statements by signature and, if a group has both polarities, it keeps only the winner by `(priority, confidence)` DESC.

The repo ships with 3 builtin rules seeded per workspace through `mnemo_seed_builtin_rules()` (`source: 'imported'`): `builtin_transitive_part_of`, `builtin_conflict_propagation`, and `builtin_scope_inheritance`.

**Parameters** (Zod schema, `packages/mcp/src/tools/compose.ts`):

| Parameter          | Type                                                                 | Required             | Applies to                   | Description                                                          |
| ------------------ | -------------------------------------------------------------------- | -------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `action`           | `enum("list","create","get","patch","dry_run")`                      | Yes                  | all                          | Operation to run.                                                    |
| `isActive`         | boolean                                                              | No                   | `list`                       | Filters rules by active status.                                      |
| `offset`           | number int ≥0                                                        | No                   | `list`                       | Pagination.                                                          |
| `limit`            | number int 1–200                                                     | No                   | `list`, `dry_run`            | Page size / max. hits to evaluate.                                   |
| `ruleId`           | string                                                               | Conditional          | `get`, `patch`, `dry_run`    | ID of the target rule.                                               |
| `name`             | string                                                               | Required on `create` | `create`, `patch`            | Rule name.                                                           |
| `description`      | string                                                               | No                   | `create`, `patch`            | Free-form description.                                               |
| `conditionDsl`     | object (validated against `ConditionDslSchema`)                      | Required on `create` | `create`, `patch`, `dry_run` | `{ all: [...] }` with condition clauses.                             |
| `actionDsl`        | object (validated against `ActionDslSchema`)                         | Required on `create` | `create`, `patch`, `dry_run` | `{ op: "derive_fact"\|"derive_warning", statementTemplate, ... }`.   |
| `priority`         | number int 0–10000                                                   | No                   | `create`, `patch`            | Evaluation order (higher = first); tiebreaker in `resolveConflicts`. |
| `isActiveOnCreate` | boolean                                                              | No (default `true`)  | `create`                     | Whether the rule is active immediately.                              |
| `hits`             | array of `{id, primitive, content, score, factKind?, worth?, tags?}` | No (default `[]`)    | `dry_run`                    | Simulated hits the rule is evaluated against.                        |

For `dry_run`, you need `ruleId` **or** inline `conditionDsl`+`actionDsl`.

**When to use it — use cases**

1. An agent detects a recurring pattern in memory (e.g. "when a fact has topicKey X and another supersedes it, warn") and wants to encode it as a permanent rule with `action='create'` instead of repeating the reasoning manually each time.
2. Before activating a new rule in production, testing it with `action='dry_run'` against a set of sample hits to see exactly which inferences it would generate, without writing anything to the database.
3. Auditing which rules are active in the workspace (`action='list'`, filtering by `isActive`) before a cleanup or before diagnosing why an unexpected inference appeared in a `recall`.
4. Temporarily disabling a rule that is generating too much noise (false positives) with `action='patch'` and `isActive: false`, without deleting it.

**Edge cases and gotchas**

- `relation` rules in `conditionDsl` can only use the system's 9 locked verbs; the server validates this with `ConditionDslSchema` and rejects any verb outside that set with 400.
- The engine does not go through `withMnemoTx` in `evaluateRule`/`composeInferences` itself (it is a pure core with no direct I/O); materializing a fact is an atomic transaction in the adapter, though.
- The composition HTTP routes (`composition.ts`) do not apply `filterBySensitivity`/`assertCanReadFact` the way the workflow ones do; there is no explicit sensitivity ceiling at the rule listing/reading level.
- `dry_run` never persists anything (it uses a fake `ctx.storage` with no-ops); it is safe to invoke repeatedly. It also uses `minConfidence: 0`, so in dry-run you see inferences that would never appear in a real recall (where the gate is `>0.5`).
- If two hits generate the same `derivedStatement` for the same rule, it is deduplicated (`${ruleId}::${statement}`), even across different hops.
- The limit of 4 hops and 50 firings per call means that very productive rules or very long chains are cut off silently with no error.

**Examples**

```json
{
  "action": "create",
  "name": "conflict-warns-on-supersede-chain",
  "description": "Advierte si A conflicts_with B y B fue reemplazado por C",
  "conditionDsl": {
    "all": [
      { "op": "relation", "from": "$a", "to": "$b", "verb": "conflicts_with" },
      { "op": "relation", "from": "$b", "to": "$c", "verb": "supersedes" }
    ]
  },
  "actionDsl": {
    "op": "derive_warning",
    "statementTemplate": "A puede seguir en conflicto con C (via B)",
    "baseConfidence": 0.6,
    "sensitivity": "internal"
  },
  "priority": 90
}
```

```json
{
  "action": "dry_run",
  "conditionDsl": { "all": [{ "op": "fact_kind", "kind": "preference", "bind": "$p" }] },
  "actionDsl": {
    "op": "derive_fact",
    "statementTemplate": "Preferencia detectada: $p",
    "baseConfidence": 0.7
  },
  "hits": [
    {
      "id": "f1",
      "primitive": "fact",
      "content": "prefiere TypeScript strict",
      "score": 0.9,
      "factKind": "preference",
      "worth": 0.8
    }
  ]
}
```

---

## `memory_workflow`

**What it does**

`memory_workflow` manages `MnemoWorkflow`, one of the 10 cognitive primitives, defined in `packages/types/src/primitives.ts` as a reusable multi-step process template, with ordered steps, conditions, and timings. Unlike `memory_compose`, it is not an execution or inference engine: it is CRUD over the `mnemo_workflow` table. The tool (`packages/mcp/src/tools/workflow.ts`) exposes only 3 actions; there is no `update`, `archive`, `run`, or `execute`, even though the `StoragePort` port does define `updateWorkflow`/`archiveWorkflow` internally (not wired to this tool).

The real flow:

- `create` → `POST /workflows` (`packages/server/src/routes/workflows.ts`) → `storage.createWorkflow(input)`. The body is built with `resolveProvenance(c)` (namespaced actorId/userId/actorType) plus `name` and `steps`. Each `WorkflowStep` has `order`, `action` (free text, up to 20,000 characters), an optional `condition` (up to 20,000), `expectedDurationMs` (integer ≥0, default `0`), and optional `tools`. Important: the `steps` array is stored as it arrives, without re-sorting by `order`.
- `get` → `GET /workflows/:id`, applies `assertCanReadFact` with the caller's sensitivity ceiling (S6: 404 if the caller has no access, not 403).
- `list` → `GET /workflows`, optionally filters by `status`/`scopeRef` and applies `filterBySensitivity` over the paginated result.

A new workflow is born with `avgDurationMs: 0`, `successRate: 0`, `worth: 0.5`, `executionCount: 0`, `version: 1`, and `sensitivity: "internal"` if none is specified.

**Parameters** (Zod schema, `packages/mcp/src/tools/workflow.ts`):

| Parameter          | Type                                                    | Required                         | Applies to                | Description                                            |
| ------------------ | ------------------------------------------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------ |
| `action`           | `enum("create","get","list")`                           | Yes                              | all                       | Operation to perform.                                  |
| `id`               | string                                                  | Required on `get`                | `get`                     | Workflow ID.                                           |
| `name`             | string 1–500                                            | Required on `create`             | `create`                  | Workflow name.                                         |
| `description`      | string ≤20000                                           | No                               | `create`                  | Free-form description.                                 |
| `steps`            | array of `WorkflowStep`                                 | Required on `create` (non-empty) | `create`                  | Ordered list of steps.                                 |
| `sensitivity`      | `enum("public","internal","confidential","restricted")` | No (default `"internal"`)        | `create`                  | The workflow's sensitivity ceiling.                    |
| `metadata`         | `record(string, unknown)`                               | No                               | `create`                  | Free-form metadata.                                    |
| `scopeRef`         | string                                                  | No                               | `create`, `list` (filter) | Project/entity reference.                              |
| `status`           | `enum("active","deprecated","draft")`                   | No                               | `list` (filter)           | It cannot be set on `create`, only filtered on `list`. |
| `limit` / `offset` | number int                                              | No                               | `list`                    | Pagination.                                            |

`WorkflowStep`: `order` (int ≥0, required), `action` (string 1–20000, required), `condition` (string ≤20000, optional), `expectedDurationMs` (int ≥0, default 0), `tools` (array of strings, optional).

**When to use it — use cases**

1. Documenting a procedure the agent repeats often (e.g. "how to deploy to `agents.example.com`": ordered steps with the tools/commands for each) so it does not have to be reconstructed from memory every session.
2. Before running a complex process, retrieving it with `action='get'` to reread the exact steps and their conditions before acting.
3. Listing the workflows available for a specific project with `scopeRef` to know which processes are already documented before creating a duplicate.
4. Versioning an operational checklist: when the process changes, creating a new workflow and manually relating it to the previous one with `memory_relate(verb: "supersedes")`.

**Edge cases and gotchas**

- There is no `update` or `patch` action: to correct an existing workflow you have to create a new one.
- There is no action to "execute" the workflow. According to `docs/architecture/API.md`, the current reality is that skills and workflows are returned as structured recall results; the agent reads the steps and acts directly, and the engine runs nothing.
- `create` requires `name` and a non-empty `steps`; if either is missing, the tool responds `isError: true` without calling the server.
- `status` cannot be set on `create`; it only works as a filter on `list`.
- The `steps` array is not reordered: if the steps are sent out of order relative to their `order` field, they are stored and returned in insertion order, not in the logical `order`.
- `list` does filter by sensitivity and `get` does apply the S6 ceiling, unlike `memory_compose`, which has no such filtering in its routes.
- It is different from `memory_task` (one-off work with a pending→completed lifecycle) and from `memory_skill` (a prompt template).

**Examples**

```json
{
  "action": "create",
  "name": "Deploy chatbot-service a producción",
  "description": "Checklist de deploy vía GitLab CI para agents.example.com",
  "scopeRef": "support-bot",
  "sensitivity": "internal",
  "steps": [
    {
      "order": 0,
      "action": "Correr pnpm test e2e localmente",
      "expectedDurationMs": 120000,
      "tools": ["bash"]
    },
    {
      "order": 1,
      "action": "Abrir MR y esperar pipeline de GitLab CI",
      "condition": "solo si tests pasan",
      "expectedDurationMs": 600000
    },
    {
      "order": 2,
      "action": "Verificar healthcheck en agents.example.com post-deploy",
      "expectedDurationMs": 30000,
      "tools": ["curl"]
    }
  ]
}
```

```json
{ "action": "list", "scopeRef": "support-bot", "status": "active", "limit": 20 }
```

---

## `memory_skill`

**What it does**

Manages the `MnemoSkill` primitive, procedural memory that stores reusable prompt templates ("I know how to do X"), through the `/skills` and `/forget/skill/:id` HTTP routes. The tool is a thin wrapper over `MnemosyneClient` (`packages/mcp/src/tools/skill.ts`); it contains no business logic of its own, it only routes each `action` to a client method. The real storage happens in `KnowledgeRepository` (adapter-postgres), on the `mnemo_skill` table, with bitemporal support (`validFrom`/`validTo`) and scoring fields (`qualityScore`, `worth`, `usageCount`).

The four actions and their real HTTP route:

- `create` → `POST /skills`
- `get` → `GET /skills/:id`
- `list` → `GET /skills`
- `forget` → `DELETE /forget/skill/:id` (`client.forgetPrimitive("skill", id)`): archives bitemporally (`validTo = now()`, the row is never deleted) and excludes the skill from `list` from that moment on, because `GET /skills` passes `validAt: new Date()` by default.

**Parameters** (Zod schema, `packages/mcp/src/tools/skill.ts`):

| Parameter        | Type                                | Required    | Notes                                                                                    |
| ---------------- | ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `action`         | `"create"\|"get"\|"list"\|"forget"` | Yes         | Operation to perform.                                                                    |
| `id`             | string                              | Conditional | Required for `get`/`forget`.                                                             |
| `name`           | string (1–500)                      | Conditional | Required for `create` (or use `content`).                                                |
| `promptTemplate` | string (1–50000)                    | Conditional | Required for `create` (or use `content`).                                                |
| `content`        | string (1–20000)                    | Optional    | Fallback alias: if `name`/`promptTemplate` are not provided, `content` is used for both. |
| `tags`           | string[]                            | Optional    | Sent as `metadata: { tags }` on create.                                                  |
| `limit`          | number (1–200)                      | Optional    | Page size for `list`.                                                                    |
| `cursor`         | string                              | Optional    | Declared as a pagination cursor; it is not used anywhere in the handler (see gotchas).   |

Note: although the `CreateSkillInput` port (`packages/types/src/ports.ts`) accepts `variables`, `requiredContext`, and `sensitivity`, the MCP tool does not expose those fields; only `name`/`promptTemplate`/`tags` reach `client.createSkill()`.

**When to use it — use cases**

1. Saving a prompt template that an agent learned to run well (e.g. "how to generate a changelog from conventional commits") to reuse it in future sessions.
2. Listing the skills available in the workspace before deciding whether to create a new one or reuse an existing one.
3. Retrieving the exact `promptTemplate` of a skill by `id` before injecting it into a prompt.
4. Archiving (`forget`) an obsolete or replaced skill, preserving the historical record for audit.

**Edge cases and gotchas**

- `cursor` is declared in the Zod schema but the handler never reads it or passes it to the client; `client.listSkills()` only supports `offset`/`limit`, so passing `cursor` is a silent no-op.
- History of bugs already fixed (file header comment, 2026-07-31): (1) `forget` used to call `client.forgetFact(id)` → always 404 because a skill id never exists in `mnemo_fact`; (2) the generic forget route failed with 500 under the real `mnemo_app_role` because the audit append ran `SELECT ... FOR UPDATE` against `mnemo_audit_log`, an append-only table with `UPDATE` revoked (S3); (3) `GET /skills` did not exclude archived skills; (4) a latent bug discovered while fixing (3): the `validTo` condition inserted a raw `Date` into an `sql` template, bypassing Drizzle's mapping and causing another 500. All four are fixed.
- `forgetPrimitive` is different from `forgetFact`; it is the primitive-agnostic route.
- There is no `update`/`patch` action in the MCP tool, even though the port defines `UpdateSkillInput`.

**Examples**

```json
{
  "action": "create",
  "name": "Generar changelog convencional",
  "promptTemplate": "A partir de estos commits, genera un changelog agrupado por tipo (feat/fix/docs)...",
  "tags": ["git", "changelog"]
}
```

```json
{ "action": "forget", "id": "skill_01HXYZ..." }
```

---

## `memory_workspace`

**What it does**

Queries and manages workspaces and their membership within the multi-tenant model. It is the only tool that exposes which workspaces/tenants the current key belongs to, along with the role of each membership. Implemented in `packages/mcp/src/tools/workspace.ts`, it delegates to `MnemosyneClient` over the routes mounted in `packages/server/src/routes/tenants.ts`, which use a helper analogous to `withMnemoTenantTx`: it opens a transaction, sets the `mnemosyne.actor_user_id`/`mnemosyne.actor_tenant_id` GUCs with `set_config(..., true)`, and only then instantiates `TenantRepository`, activating RLS on `mnemo_tenant`, `mnemo_user`, `mnemo_workspace`, and `mnemo_workspace_member`. **No action changes the session's active workspace**; that is fixed by the API key/token when the process starts.

The role model (`WorkspaceRole` in `packages/types/src/security.ts`) narrows the key's static scopes: `read` → read of memory/session/entity/federation; `write` → everything in `read` + remember/decide/task/event/reasoning/procedural/self_edit; `admin` → everything in `write` + hard_delete/purge/export/governance/federation/keys/membership; `owner` has the **same effective set of scopes as `admin`**. A role can never add scopes that the key did not have; it can only subtract them.

**Parameters** (Zod schema, `packages/mcp/src/tools/workspace.ts`):

| Parameter     | Type                                                                                 | Required              | Notes                                                                                  |
| ------------- | ------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------- |
| `action`      | `"list"\|"describe"\|"members"\|"current"\|"create"\|"invite"\|"set_role"\|"remove"` | No (default `"list"`) | 8 actions.                                                                             |
| `workspaceId` | string                                                                               | Conditional           | Required for `describe`, `members`, `invite`, `set_role`, `remove`.                    |
| `userId`      | string                                                                               | Conditional           | Required for `invite`, `set_role`, `remove`.                                           |
| `role`        | `"owner"\|"admin"\|"write"\|"read"`                                                  | Conditional           | Required for `set_role`; server default `"read"` for `invite`.                         |
| `name`        | string                                                                               | Conditional           | Required for `create`.                                                                 |
| `slug`        | string                                                                               | Optional              | For `create`.                                                                          |
| `visibility`  | `"private"\|"public"`                                                                | Optional              | For `create`; default `"private"`.                                                     |
| `ownerUserId` | string                                                                               | Optional              | Initial owner of the workspace, for `create`.                                          |
| `tenantId`    | string                                                                               | Optional              | Tenant in which to create the workspace; if omitted, it is resolved through `GET /me`. |

Detail per action: `list` (default) first calls `listMyWorkspaces()`; if it comes back empty, it falls back to the tenant listing. `describe` requires membership and returns 404 (not 403) if the caller is not a member (anti-probing). `current` returns workspaceId/name/keyId/actorType/scopes/plan/userId/personalWorkspaceId/tenantId/role. `create` resolves `tenantId` through `GET /me` if it is not passed. `invite`/`set_role`/`remove` require the `owner`/`admin` role; the server returns 403 to a `read`/`write` caller.

**When to use it — use cases**

1. An agent wants to know which workspace it is operating in and with what role (`action:"current"`) before attempting a write.
2. Listing all the workspaces the user behind the key belongs to, to show them a selector.
3. An administrator invites a new collaborator to a workspace with the `write` role.
4. Auditing who has access to a workspace and with what role (`action:"members"`).

**Edge cases and gotchas**

- A real bug already fixed (audit 2026-07-29, fix 2026-07-31): `action:"list"` and `action:"members"` returned an uncontrolled 500 because of an infinite recursion in the RLS policy of `mnemo_workspace_member` (self-referential `EXISTS`); fixed by replacing the subqueries with `SECURITY DEFINER` functions. The tenant-wide fallback of `list` was also dead code because `GET /me` never returned `tenantId` even though it was already resolved server-side; fixed along with the above.
- The caller can never change the active workspace from this tool; it is a design limitation, not a bug.
- The mutating actions (`create`/`invite`/`set_role`/`remove`) are registered unconditionally because scope narrowing on the server already blocks a `read`/`write` caller; the tool neither hides these actions nor replicates that authorization client-side.

**Examples**

```json
{ "action": "current" }
```

```json
{ "action": "invite", "workspaceId": "ws_01HXYZ...", "userId": "user_01HABC...", "role": "write" }
```

---

## `memory_suggest_topic_key`

**What it does**

Derives a deterministic, idempotent `topicKey` from a `subject`/`body` pair, without writing anything or making LLM/embedding calls. It is tool #35, the newest in the registry (added 2026-08-04). It is a pure proxy: `packages/mcp/src/tools/suggest_topic_key.ts` calls `client.suggestTopicKey()`, which makes `POST /topic-key/suggest` (`packages/server/src/routes/topicKey.ts`), whose handler touches neither `withMnemoTx` nor any adapter; it only invokes `suggestTopicKey()` from `@mnemo-ai/core` (`packages/core/src/cognitive/topic-key.ts`), the single source of truth for the algorithm.

The real algorithm:

1. **Idempotency short-circuit**: if `body` is empty/absent and `subject` already meets the canonical grammar (`^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$`, ≤80 chars), it is returned as is with `source: "identity"`. This guarantees `suggest({subject: suggest(x).topicKey}).topicKey === x`.
2. Otherwise, both strings are normalized (NFKD, no diacritics, lowercase, everything that is not `[a-z0-9]` collapses to a space) and tokenized, filtering out a bilingual EN/ES stopword set, tokens shorter than 3 characters (except 2-character tokens with a digit), and duplicates.
3. Level assembly: with `subject`+`body`, level 1 = up to 2 tokens from `subject`, level 2 = up to 3 tokens from `body` (`source: "subject+body"`). `body` only: level 1 = the first 2 tokens, level 2 = the next 3 (`source: "body"`). `subject` only: a single level of up to 2 tokens (`source: "subject"`).
4. If no token survives the filtering, it falls back to: `"general"` if both inputs are empty, or `"general/<sha256-hash-8-chars>"` if there is content but no useful token (`source: "fallback"`).
5. Length clamp: each level is trimmed to ≤40 chars and the full key to ≤80 chars (level 2 is dropped first, then the trailing tokens of level 1 are trimmed, always leaving ≥1 token).

**Parameters** (Zod schema, `packages/mcp/src/tools/suggest_topic_key.ts`):

| Parameter | Type   | Required | Notes                                          |
| --------- | ------ | -------- | ---------------------------------------------- |
| `subject` | string | Optional | Subject of the fact or title of the decision.  |
| `body`    | string | Optional | Statement of the fact or body of the decision. |

Both are optional; `{}` resolves to the `"general"` fallback.

**When to use it — use cases**

1. Before `memory_remember(kind:"fact", topicKey:...)` or `memory_decide(topicKey:...)`, to get a stable key instead of inventing one by hand and risking a collision with `uniq_mnemo_decision_topic`.
2. Verifying that an already used `topicKey` is still the same when re-derived with the same `subject`/`body` (idempotency).
3. Normalizing a "raw" `topicKey` by passing it as `subject` with no `body`; if it is already canonical, it comes back unchanged.
4. External systems that need to generate `topicKey`s consistent with the ones Mnemosyne uses (for example, a persistent memory plugin such as Engram) can call this tool instead of reimplementing the algorithm.

**Edge cases and gotchas**

- It uses neither `withMnemoTx` nor RLS: the HTTP handler explicitly has no adapter and no DB round trip.
- The stopword set is deliberately independent of the one used in recall; a comment in the code warns that sharing them would couple the tuning of both systems.
- The SHA-256 hash fallback is deterministic but not semantically meaningful: two very different inputs that collapse to "stopwords only" produce `general/` prefixes with different hashes, not readable collisions.
- `source` in the response has 5 possible values (`identity`, `subject+body`, `subject`, `body`, `fallback`); useful for deciding whether the suggested key should be reviewed manually.

**Examples**

```json
{ "subject": "infra/pg", "body": "Migramos a Postgres 16 con pgvector para el índice HNSW" }
```

```json
{ "subject": "auth/oauth-google" }
```

Since `"auth/oauth-google"` already meets the canonical grammar and there is no `body`, it returns `{ "topicKey": "auth/oauth-google", "source": "identity" }` with no transformation.

---

## Verified critical findings (summary)

A quick checklist of real discrepancies between what each tool promises (name, description, or `docs/architecture/API.md`) and what the code does, verified as of 2026-08-10 (re-verified against the real code after `docs/archive/openspec/complete-mcp-tools`). Fixed and still-current items are mixed together; each item says which it is.

### Fixed bugs (no longer apply, included in case an old memory of the finding remains)

- **`memory_remind_when`**: the AND/OR mismatch reported earlier is **fixed**: `evaluator.ts` implements `fires = timeMatch && semanticMatch` (fix REMIND-1, 2026-07-27).
- **`memory_purge`**: the report that it was "completely non-functional" is **outdated**: `hardDeleteFact`/`purgeClosedFacts` are implemented and `DELETE /facts/purge` is now registered before `DELETE /facts/:id`, with a real integration test proving it.
- **`memory_workspace`**: it suffered a real infinite-recursion bug in the RLS policy of `mnemo_workspace_member` that returned 500 on `list`/`members`; **fixed** on 2026-07-31 with `SECURITY DEFINER` functions.
- **`memory_skill`**: it had 4 chained bugs in `forget` (it called the facts route, then a 500 from the revoked `UPDATE` on the audit log, then it did not exclude archived skills, then a raw `Date` broke Drizzle's mapping); all 4 are **fixed**.
- **`memory_recall`/`memory_search`**: the historical bug where `mode`/`vectorWeight` were dropped before reaching `RecallQuery` (every call resolved `mode:"auto"` regardless of what was requested) is **fixed**.
- **`memory_context`**: the bug where the "other workspaces" listing used the tenant's workspaces as its primary source (showing other people's workspaces as the user's own) is **fixed**; it now uses `GET /workspaces/mine` first.
- **`memory_status`**: the RLS recursion bug that silently broke the `personal` block (the user's personal workspace) is **fixed** through the same migration `0012_workspace_member_rls_recursion.sql`.
- **`memory_recall` / `memory_search`** (B1, 2026-08-10): `scope: 'personal'` previously filtered nothing: the code explicitly excluded it from the filter. Now `recall.ts` routes to `multiLevelRecall(..., { only: 'personal' })`, truly restricting to the caller's personal workspace (weight 1.0), with an explicit 400 if the key is not user-bound or there is no personal workspace.
- **`memory_forget`** (B2, 2026-08-10): `idempotencyKey` previously only had a real effect when `kind='fact'`; for any other kind it was silently dropped. `forgetPrimitive()` now forwards the key as an `Idempotency-Key` header for all kinds, like `forgetFact`.
- **`memory_timeline`** (B3, 2026-08-10): it previously never reported `kind: "created"` for an event, even though the schema declared it as a valid value; a new fact showed up as `"updated"`. Now `GET /timeline` merges a second stream derived from `FactFilter.createdSince` that does emit `"created"`, without touching `factory.ts`/`CoreLike` (a constraint from `flatten-legacy-dual-core`).
- **`memory_self_edit` with `action:'forget'`** (B4, 2026-08-10): it previously got permanently stuck at `202 { approvalRequired: true }` with no real approval flow to complete. The `forget` action was **removed** from the tool's enum; if it is attempted anyway, the server responds `422 self_edit_forget_unsupported`; use `memory_forget` (`kind: 'fact' | 'strategy'`) instead.
- **`memory_compare`** (B6, 2026-08-10): it previously never suggested the `related` verb in real production nor showed tag diffs; both were disclosed dead code. Now both were **removed** from the code: `SuggestableVerb` has 4 values (no `related`), and `computeDifferences`/`detectSameSubject` no longer touch tags at all.
- **`memory_task`** (B7, 2026-08-10): `action:'archive'` previously forced `status:'cancelled'` without going through the state machine, and could archive a `completed` (terminal) task to `cancelled`, something `patch` rejected with 409. `archiveTask` is now terminal-aware (`TERMINAL_TASK_STATUSES`): an archived `completed` task keeps `status: 'completed'`; the rest are still canceled as before.
- **`memory_hyperedge`** (B8, 2026-08-10): the `worth` documented as "decays via TD(λ)" had no real caller and stayed frozen at 0.5. `POST /recall` now triggers a best-effort co-activation (`recordHyperedgeCoActivation`, through `setImmediate`) that moves `worth` with `updateWorth("hyperedge", ...)` when ≥2 members of a hyperedge appear in the served hits.

### Current gotchas (not bugs, real behavior to keep in mind)

- **`memory_pin` / `memory_session(action:'pin')`**: protecting a fact with a pin does **not** give it priority in `memory_recall`/`memory_search`; the `pinned` field never reaches scoring. It only protects from automatic merge/forget by consolidation.
- **`memory_decide`**: decisions created today do **not** store real author attribution (`actorId`/`userId`/`actorType`); a known gap in `@mnemo-ai/core/factory.ts`.
- **`memory_episode_end`**: the HTTP 202 is misleading; the 8-step collapse pipeline has already finished running synchronously before that response, it is not real asynchronous processing.
- **`memory_consolidate`**: it can only run `mode: "fast"` manually; `mode: "deep"` (LLM classification with memoization) runs exclusively through the background scheduler, and requesting it manually gives 422.
- **`memory_remind_when`**: the 30s background poller **only** fires reminders without a `condition`; any compound or semantic reminder depends exclusively on a future real call to `memory_recall`.
- **`memory_judge`**: the `confidence > 0.7` gate means that only the trust-anchor rule (0.9) auto-resolves conflicts; recency (exactly 0.7) always falls to manual review. The `merge` resolution is not atomic (6 separate transactions).
- **`memory_event`**: `action:'archive'` is a **declared no-op**; `mnemo_event` has no status column, and the row never changes despite the 204. Use `memory_remember`/`memory_task` if you need something mutable.
- **`memory_anticipate`** (D7, 2026-08-10): it is no longer a documentation gap; the 5th LLM enrichment signal (when there is a `context` and a configured adapter) is now explicitly listed in the tool's `description` next to the 4 statistical ones, not only in this document.
- **`memory_workflow`**: it executes nothing; it is partial CRUD (no `update`/`archive`/`run`); the agent reads the steps and acts manually.
- **`memory_skill`**: the `cursor` parameter exists in the schema but the handler ignores it; real pagination is by `offset` only.
- **`docs/architecture/API.md`**: outdated or outright invented for `memory_introspect`, `memory_anticipate`, and `memory_status` (response schemas that do not match the real code); do not use it as a reference for those three tools, rely on this document or the source code directly.

---

_Generated from a direct reading of the source code of this repository (Zod schemas in `packages/mcp/src/tools/`, handlers in `packages/server/src/routes/`, business logic in `packages/core/src/cognitive/`). If the code changes, this document can become outdated; when in doubt, the code is the source of truth, not this file._
