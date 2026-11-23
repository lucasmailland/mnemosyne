# @mnemo-ai/mcp

**English** · [Español](README.es.md)

> The MCP server for [Mnemosyne](https://github.com/lucasmailland/mnemosyne), cognitive memory for AI agents. It runs over stdio, talks to a Mnemosyne server through `@mnemo-ai/client-ts` and gives Claude Desktop, Cursor and any MCP client all 37 live tools listed below by default, or the 9 core tools with `MNEMO_MCP_TOOLS=core`.
>
> [Repository](https://github.com/lucasmailland/mnemosyne) · [MCP guide](https://github.com/lucasmailland/mnemosyne/blob/main/docs/guides/MCP_GUIDE.md) · [Status](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

Standalone **Model Context Protocol** server for [Mnemosyne](https://github.com/lucasmailland/mnemosyne) — the multi-tenant cognitive memory system.

Plug it into any MCP client (Claude Desktop, Claude Code, Cursor, …) and your assistant gets durable, workspace-scoped memory: recall what users prefer, remember decisions across sessions, pin critical knowledge, and audit what was learned over time.

> This package is a **thin adapter**. It speaks MCP over stdio and forwards every call to [`@mnemo-ai/client-ts`](https://github.com/lucasmailland/mnemosyne/tree/main/packages/client-ts), which in turn talks to a Mnemosyne HTTP server you control.

> **Needs a running Mnemosyne server and an API key.** The [quickstart](https://github.com/lucasmailland/mnemosyne#quickstart) starts one with Docker in a few minutes.

## Install

You don't need to install anything globally. Just point your MCP client at it via `npx`.

## Configure

### Claude Desktop

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "https://memory.acme.com",
        "MNEMO_KEY": "mns_live_..."
      }
    }
  }
}
```

The tools and their messages are in English. For Spanish, see [Language](#language).

Restart Claude Desktop. You should see "mnemosyne" appear in the MCP tools menu.

### Cursor

In `~/.cursor/mcp.json` (or the per-project equivalent):

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "https://memory.acme.com",
        "MNEMO_KEY": "mns_live_..."
      }
    }
  }
}
```

### Continue / any other MCP client

Same pattern: `command: npx`, `args: ["-y", "@mnemo-ai/mcp"]`, set `MNEMO_URL` and `MNEMO_KEY` in `env`.

## Environment variables

| Var                  | Required | Description                                                                                                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MNEMO_URL`          | yes      | Base URL of your Mnemosyne server, e.g. `https://memory.acme.com`.                                                                                           |
| `MNEMO_KEY`          | yes      | Workspace API key (`mns_live_...` or `mk_live_...`). Scope determines which tools are available — read-only keys cannot call `remember`, `pin`, or `forget`. |
| `MNEMO_WORKSPACE_ID` | no       | Workspace for a user token. Overrides the nearest project `.mnemo.json` binding.                                                                             |
| `MNEMO_MCP_TOOLS`    | no       | `full` (default, all 37) or `core` (9 tools). See [Tool profile](#tool-profile).                                                                             |
| `MNEMO_LOCALE`       | no       | `en-US` (default) or `es-419`. See [Language](#language).                                                                                                    |

When `MNEMO_WORKSPACE_ID` is absent, the MCP reads `workspaceId` from the nearest `.mnemo.json` between the process directory and its Git root. The selected workspace stays fixed for the MCP process.

If either is missing, the server exits with code 1 and prints a help message to stderr (which most MCP clients surface in their UI).

## Tool profile

**The default is `full`.** `MNEMO_MCP_TOOLS` picks how many tools the server lists:

- `full` (default): all 37, including the episode, session, graph and admin tools a pure-MCP client needs to open episodes itself (`memory_episode_start`, `memory_session`, `memory_episode_end`).
- `core`: `memory_recall`, `memory_fact`, `memory_remember`, `memory_decide`, `memory_update`, `memory_forget`, `memory_search`, `memory_status`, `memory_context`. A client that does not defer tools loads every tool schema into every request; set `core` there to keep that cost small.

Any other value serves the 9 core tools (it never widens the surface) and prints one warning to stderr. `memory_doctor` (full profile) reports the active profile and its tool count. What the server advertises is also compacted: no `$schema`, no repeated date-time and UUID regexes (`format` says it), no ±2⁵³ integer bounds. Arguments are still validated exactly as before. `src/__tests__/tool-surface-budget.test.ts` fails when `tools/list` grows past 16,000 bytes (core) or 45,000 bytes (full).

## Language

The server defaults to American English (`en-US`). Spanish is opt-in: set `MNEMO_LOCALE` to `es-419` (any `es*` tag maps to it) in the client's `env` block, next to `MNEMO_URL` and `MNEMO_KEY`:

```json
"env": {
  "MNEMO_URL": "https://memory.acme.com",
  "MNEMO_KEY": "mns_live_...",
  "MNEMO_LOCALE": "es-419"
}
```

The MCP reads only `MNEMO_LOCALE`; it ignores `LANG` and the other POSIX variables, because the client's `env` block is the per-server channel. An unset or unrecognized value means English.

With `MNEMO_LOCALE=es-419`, the tool and field descriptions and the text the tools write back (errors, notes, summaries) are in Spanish, and the MCP sends `Accept-Language` to the Mnemosyne server, so the server's message inside an MCP error comes back in Spanish (when the server has a translation for it; otherwise English). Without `MNEMO_LOCALE` the MCP sends no `Accept-Language` and everything is English. What stays in English: the MCP protocol text and the server instructions, tool names and argument names, and the data inside tool results (JSON keys, codes, ids).

`MNEMO_LOCALE` is also read by the `mnemo` CLI. Like `MNEMO_URL` and `MNEMO_KEY`, if you export it in a shell, an MCP server started from that shell inherits it and switches to Spanish too.

## Tools exposed

Status legend: a Live tool is registered and functional. All 37 tools are live.

| Tool                       | Status  | Scope               | Purpose                                                                                                                                                                                                                                                                          |
| -------------------------- | ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_recall`            | ✅ Live | read                | Top-K relevant facts for a query (semantic + worth-weighted).                                                                                                                                                                                                                    |
| `memory_remember`          | ✅ Live | write               | Persist a new durable fact (idempotent via content hash).                                                                                                                                                                                                                        |
| `memory_pin`               | ✅ Live | write               | Protect a fact from consolidation merges (no recall boost).                                                                                                                                                                                                                      |
| `memory_forget`            | ✅ Live | write               | Soft-archive a fact (closes validTo, auditable, restorable).                                                                                                                                                                                                                     |
| `memory_timeline`          | ✅ Live | read                | Fact changes over a time window ("what did my AI learn this week?").                                                                                                                                                                                                             |
| `memory_search`            | ✅ Live | read                | Full-text + semantic search with filters (kind, sensitivity, date).                                                                                                                                                                                                              |
| `memory_relate`            | ✅ Live | write               | Create a relation between two primitives (9 locked verbs).                                                                                                                                                                                                                       |
| `memory_decide`            | ✅ Live | write               | Log an architectural or policy decision with full rationale.                                                                                                                                                                                                                     |
| `memory_entity`            | ✅ Live | write               | Upsert a named entity (person, org, project, concept).                                                                                                                                                                                                                           |
| `memory_status`            | ✅ Live | read                | Health check: server version, adapter states.                                                                                                                                                                                                                                    |
| `memory_remind_when`       | ✅ Live | write               | Schedule a prospective memory trigger on a condition or time.                                                                                                                                                                                                                    |
| `memory_consolidate`       | ✅ Live | write               | Trigger a consolidation pass (merge/retire duplicate facts).                                                                                                                                                                                                                     |
| `memory_session`           | ✅ Live | write               | Unified session control (§24): `pin` a fact, append a `scratch` turn, `collapse`, or `discard`. All 4 actions fully wired.                                                                                                                                                       |
| `memory_episode_start`     | ✅ Live | write               | Open a named episode context (session).                                                                                                                                                                                                                                          |
| `memory_episode_end`       | ✅ Live | write               | Close and collapse an episode, extracting facts from transcript.                                                                                                                                                                                                                 |
| `memory_task`              | ✅ Live | write               | Manage actionable tasks: create, read, list, update or archive them, with an owner, status and dependencies.                                                                                                                                                                     |
| `memory_event`             | ✅ Live | write               | Record immutable events in the workspace log: create, get, list, archive.                                                                                                                                                                                                        |
| `memory_reasoning`         | ✅ Live | write               | Persist structured chains of thought (question → steps → conclusion) for reuse.                                                                                                                                                                                                  |
| `memory_strategy`          | ✅ Live | write               | Manage reusable trigger→action strategies. Uses `op` as the discriminator (not `action`).                                                                                                                                                                                        |
| `memory_self_edit`         | ✅ Live | write               | Edit your own memory with `append`, `replace`, `strengthen`, `weaken`, `reflect` or `link`. The reason is required policy context; it is not yet durably audited.                                                                                                                |
| `memory_hyperedge`         | ✅ Live | write               | Create/relate an N-ary hyperedge across ≥3 facts (hypergraph associations beyond binary relations).                                                                                                                                                                              |
| `memory_introspect`        | ✅ Live | read                | Self-model / meta-cognition: knowledge coverage, gaps, and confidence trends per entity.                                                                                                                                                                                         |
| `memory_anticipate`        | ✅ Live | read                | Predictive next-recall suggestions from temporal + co-occurrence patterns (anticipation engine).                                                                                                                                                                                 |
| `memory_compose`           | ✅ Live | read                | Compose new inferences over recalled facts via the declarative inference engine.                                                                                                                                                                                                 |
| `memory_workflow`          | ✅ Live | write               | Manage reusable workflow definitions: create, get, list, patch, archive.                                                                                                                                                                                                         |
| `memory_skill`             | ✅ Live | write               | Manage reusable skill definitions: create, get, list, patch, archive.                                                                                                                                                                                                            |
| `memory_doctor`            | ✅ Live | read                | Runs 8 operational diagnostics (Postgres connectivity, app_user grants, schema shadows, migration version, embedding backlog, workspace_id validity, MCP env config, tool registration count). No input. Use before filing a bug report.                                         |
| `memory_update`            | ✅ Live | write               | Correct the statement of an existing fact by bitemporal replacement: closes the original fact and creates a new one with the same lineage. The fact `id` changes.                                                                                                                |
| `memory_judge`             | ✅ Live | write               | Resolve conflicts between contradictory facts. `action='list'` shows conflicting pairs; `action='resolve'` applies `supersede_a` \| `supersede_b` \| `keep_both` \| `merge`.                                                                                                     |
| `memory_stats`             | ✅ Live | read                | Aggregate workspace statistics: live/closed/pinned/archived facts, active decisions, conflicts, embedding coverage, 30-day recall hit rate. No input.                                                                                                                            |
| `memory_compare`           | ✅ Live | read                | Compare two facts by ID: full content, field diffs, suggested relation verb (supersedes \| conflicts_with \| compatible \| scoped \| related), and whether they are about the same subject.                                                                                      |
| `memory_purge`             | ✅ Live | write (hard_delete) | Permanent, irreversible deletion. Requires scope `memory:hard_delete`. `action='fact'` deletes one fact by ID; `action='closed'` bulk-deletes every `forgotten` fact in the workspace. For test workspaces only; not GDPR erasure (use `memory_forget` for ordinary forgetting). |
| `memory_context`           | ✅ Live | read                | Full session context: active workspace, user, tenant, stats, and other available workspaces. Call at the start of a session; it is the MCP equivalent of `GET /health` + `GET /me` combined.                                                                                     |
| `memory_suggest_topic_key` | ✅ Live | read                | Suggests a deterministic key from subject/body; reuse an existing key when the value changes.                                                                                                                                                                                    |
| `memory_fact`              | ✅ Live | read                | Get a full fact, decision or other recalled record by ID (`kind` is inferred for a fact or decision).                                                                                                                                                                            |
| `memory_relocate`          | ✅ Live | write               | Move a fact to another workspace: it is closed here and a successor is created there, with a new ID.                                                                                                                                                                             |
| `memory_workspace`         | ✅ Live | write               | List workspaces and memberships, or create, invite, set a role and remove (owner or admin).                                                                                                                                                                                      |

The exact JSON schemas and descriptions are carried verbatim from the in-process Orchester MCP server, so existing agent prompts continue to work.

## Local development

```bash
pnpm install
pnpm --filter @mnemo-ai/mcp build
MNEMO_URL=http://localhost:3939 MNEMO_KEY=mns_live_yourkey node packages/mcp/dist/index.js
```

To debug a tool call manually, paste a JSON-RPC frame into stdin — the server speaks the standard MCP wire protocol.

## Tool Schema Reference (37 registered)

One subsection per documented tool. The input schemas below are generated from what the server serves: the JSON schema from [`contracts/*.json`](https://github.com/lucasmailland/mnemosyne/tree/main/packages/mcp/contracts) and the field descriptions from the MCP dictionaries ([`src/i18n/en.ts`](https://github.com/lucasmailland/mnemosyne/blob/main/packages/mcp/src/i18n/en.ts); Spanish in [`src/i18n/es.ts`](https://github.com/lucasmailland/mnemosyne/blob/main/packages/mcp/src/i18n/es.ts)). After changing a tool, run `pnpm --filter @mnemo-ai/mcp readme:schemas`; a test fails when this section drifts.

> **Coverage note:** this section documents 20 of the 37 tools. `memory_fact`, `memory_relocate`, `memory_hyperedge`, `memory_introspect`, `memory_anticipate`, `memory_compose`, `memory_workflow`, `memory_skill`, `memory_doctor`, `memory_update`, `memory_judge`, `memory_stats`, `memory_compare`, `memory_purge`, `memory_context`, `memory_workspace` and `memory_suggest_topic_key` are not expanded below; their schemas are in `contracts/<name>.json`.

---

### memory_recall

Pass optional `kinds` to narrow the primitive kinds returned. Omit it for server defaults. Each hit keeps optional `kind`, `topicKey`, `subject`, `scopeRef`, `status`, `similarity`, and dispute metadata when supplied by the server. `nothingRelevant` is passed through when available. Text wraps each hit as untrusted data; `structuredContent` keeps the full response.

**Input schema:**

<!-- input-schema:memory_recall -->

```json
{
  "properties": {
    "actorId": {
      "type": "string"
    },
    "asOf": {
      "format": "date-time",
      "type": "string"
    },
    "includeGraph": {
      "type": "boolean"
    },
    "kinds": {
      "items": {
        "enum": [
          "fact",
          "decision",
          "strategy",
          "workflow",
          "skill",
          "episode",
          "task",
          "event",
          "reasoning",
          "entity"
        ],
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "limit": {
      "maximum": 25,
      "minimum": 1,
      "type": "integer"
    },
    "minSimilarity": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "mode": {
      "enum": ["lexical", "semantic", "hybrid", "auto"],
      "type": "string"
    },
    "projection": {
      "enum": ["full", "compact"],
      "type": "string"
    },
    "query": {
      "minLength": 1,
      "type": "string"
    },
    "requestId": {
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    },
    "scope": {
      "enum": ["global", "conversation", "personal"],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "vectorWeight": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": ["query"],
  "type": "object"
}
```

| Field           | Description                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `actorId`       | Exact stored actorId (e.g. "key:<id>"; not a userId).                                                          |
| `asOf`          | Past ISO 8601 instant: memory as it was then (later-superseded facts return as 'superseded').                  |
| `includeGraph`  | Also list each hit's relations and group co-member ids (not added as hits). Default false.                     |
| `kinds`         | Default: fact, decision, strategy, workflow, skill, episode, entities. task, event, reasoning only if listed.  |
| `limit`         | Default 5, max 25.                                                                                             |
| `minSimilarity` | Min raw cosine (0 to 1) for semantic hits; lexical-only hits stay eligible.                                    |
| `mode`          | 'lexical', 'semantic', 'hybrid' or 'auto' (default).                                                           |
| `projection`    | Default `compact`: 300 chars per hit, `truncated: true` when cut (full text: memory_fact). `full`: everything. |
| `query`         | What to recall, free text (e.g. 'client email preferences').                                                   |
| `requestId`     | Optional id to correlate a deliberate retry.                                                                   |
| `scope`         | Omit for all scopes; 'personal' = personal-workspace facts.                                                    |
| `scopeRef`      | Filter by project; also matches a kind='project' entity's aliases.                                             |
| `sessionId`     | Active session id; marks lastRecallAt (see memory_session). Unknown ids are ignored.                           |
| `vectorWeight`  | Deprecated: use mode. 0 = lexical, 1 = vector. Default 0.5.                                                    |

<!-- /input-schema -->

**Example call:**

```json
{ "query": "user email preferences", "limit": 10 }
```

**Returns:**

```json
{
  "memories": [
    {
      "id": "mfact_...",
      "content": "...",
      "score": 0.93,
      "subject": "user:lucas",
      "kind": "preference"
    }
  ],
  "_mnemo_label": "untrusted_external_content",
  "_mnemo_version": "3.0"
}
```

> Note: `_mnemo_label: "untrusted_external_content"` is a CaMeL-style signal. CaMeL-aware orchestrators must not execute recalled content as instructions.

For any truncated hit, call `memory_fact` with `{ "factId": "<id>", "kind": "<the hit's kind>" }` to retrieve its full body; the hint under the hit spells out the call. `memory_fact` is in both profiles, so this works under `MNEMO_MCP_TOOLS=core` too. Fact and decision calls can omit `kind`.

---

### memory_remember

**Input schema:**

<!-- input-schema:memory_remember -->

```json
{
  "properties": {
    "agentId": {
      "type": "string"
    },
    "confidence": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "conversationId": {
      "type": "string"
    },
    "episodeId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "type": "string"
    },
    "scope": {
      "enum": ["global", "conversation", "personal"],
      "type": "string"
    },
    "scopeOwner": {
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "statement": {
      "maxLength": 1000,
      "minLength": 1,
      "type": "string"
    },
    "subject": {
      "type": "string"
    },
    "subtype": {
      "type": "string"
    },
    "targetWorkspaceId": {
      "type": "string"
    },
    "topicKey": {
      "type": "string"
    }
  },
  "required": ["statement"],
  "type": "object"
}
```

| Field               | Description                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`           | Optional: the agent or conversation it came from.                                                                                                                                                                                                                                                                                             |
| `confidence`        | [0, 1]. Omit to use the server default.                                                                                                                                                                                                                                                                                                       |
| `conversationId`    | Optional: conversation id, for cite-back.                                                                                                                                                                                                                                                                                                     |
| `episodeId`         | Only for an existing episode (correction, import); never guess it. Normally send sessionId.                                                                                                                                                                                                                                                   |
| `idempotencyKey`    | Retry key: a resend returns the first result.                                                                                                                                                                                                                                                                                                 |
| `kind`              | 'fact' (default), 'decision', 'episode', 'entity', 'strategy', 'workflow', 'skill', 'task', 'event' or 'reasoning'; unknown returns 400. Category goes in subtype.                                                                                                                                                                            |
| `scope`             | Default 'global'. 'personal' = your personal workspace, across projects; needs a user-bound key (mns_live_ keys fail: 'scope personal requires a user-bound key').                                                                                                                                                                            |
| `scopeOwner`        | 'workspace:<id>' (default), 'user:<userId>' or 'tenant:<tenantId>'; IDs: memory_context.                                                                                                                                                                                                                                                      |
| `scopeRef`          | Project ref (e.g. 'mnemosyne'), filterable at recall; entity names and aliases are canonicalized (warnings scope_ref_canonicalized, scope_ref_unrecognized).                                                                                                                                                                                  |
| `sessionId`         | The session id returned by memory_episode_start (or 'Episode: open'). Always pass it: memory_episode_end links its facts to the episode; without it, no origin context ever.                                                                                                                                                                  |
| `statement`         | One self-contained claim (e.g. 'Client Acme prefers communication in Spanish.').                                                                                                                                                                                                                                                              |
| `subject`           | What the fact is about (e.g. 'acme', 'user:dana@example.com'). Default 'workspace'.                                                                                                                                                                                                                                                           |
| `subtype`           | fact: 'preference' \| 'trait' \| 'event' \| 'relationship' \| 'skill' \| 'concern' \| 'architecture' \| 'bugfix' \| 'config' \| 'discovery' \| 'policy' \| 'process' \| 'other' (default). A choice with rationale is a decision: use memory_decide. Other kinds: see memory_decide, memory_entity. Unknown values fall back, with a warning. |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context).                                                                                                                                                                                                                                                                |
| `topicKey`          | An active fact or decision with this key is updated, not duplicated (e.g. 'auth-strategy'). See memory_suggest_topic_key.                                                                                                                                                                                                                     |

<!-- /input-schema -->

**Example call:**

```json
{
  "statement": "User prefers TypeScript over JavaScript",
  "subject": "user:lucas@example.com",
  "kind": "preference",
  "confidence": 0.9
}
```

**Returns:** The created fact object from the server (shape mirrors POST /remember response — `V3Fact`, `statement` not `content`):

```json
{
  "id": "mfact_...",
  "statement": "User prefers TypeScript over JavaScript",
  "createdAt": "2026-06-13T10:00:00Z"
}
```

---

### memory_pin

**Input schema:**

<!-- input-schema:memory_pin -->

```json
{
  "properties": {
    "factId": {
      "minLength": 1,
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "unpin": {
      "type": "boolean"
    }
  },
  "required": ["factId"],
  "type": "object"
}
```

| Field            | Description                                   |
| ---------------- | --------------------------------------------- |
| `factId`         | ID of the fact to pin.                        |
| `idempotencyKey` | Retry key: a resend returns the first result. |
| `unpin`          | true unpins instead. Default false.           |

<!-- /input-schema -->

**Example call:**

```json
{ "factId": "mfact_01j..." }
```

**Example unpin call:**

```json
{ "factId": "mfact_01j...", "unpin": true }
```

**Returns:** The updated fact object from the server (shape mirrors POST /facts/:id/pin response).

---

### memory_forget

**Input schema:**

<!-- input-schema:memory_forget -->

```json
{
  "properties": {
    "factId": {
      "minLength": 1,
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "default": "fact",
      "enum": [
        "fact",
        "decision",
        "episode",
        "entity",
        "strategy",
        "workflow",
        "skill",
        "task",
        "event",
        "reasoning",
        "hyperedge"
      ],
      "type": "string"
    },
    "primitiveId": {
      "minLength": 1,
      "type": "string"
    },
    "reason": {
      "type": "string"
    }
  },
  "type": "object"
}
```

| Field            | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `factId`         | Fact to archive (alias of primitiveId for kind='fact'). |
| `idempotencyKey` | Retry key: a resend returns the first result.           |
| `kind`           | Type of primitive to archive. Default: 'fact'.          |
| `primitiveId`    | Required when kind is not 'fact'.                       |
| `reason`         | Optional reason (recorded in the audit log).            |

<!-- /input-schema -->

**Example call:**

```json
{ "factId": "mfact_01j...", "reason": "Information was incorrect" }
```

**Returns:**

```json
{ "id": "mfact_01j...", "forgotten": true, "reason": "Information was incorrect" }
```

> Note: This is a **soft delete**. The fact moves to `mnemo_fact_archive` and is recoverable for audit. The `reason` string is echoed back in the MCP response but is not persisted by the server on this route.

---

### memory_timeline

**Input schema:**

<!-- input-schema:memory_timeline -->

```json
{
  "properties": {
    "limit": {
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    },
    "sinceIso": {
      "type": "string"
    }
  },
  "type": "object"
}
```

| Field      | Description                      |
| ---------- | -------------------------------- |
| `limit`    | Default 20, max 100.             |
| `sinceIso` | Only events after this ISO date. |

<!-- /input-schema -->

**Example call:**

```json
{ "limit": 50, "sinceIso": "2026-06-06T00:00:00Z" }
```

**Returns:** Array of recent memory events from the server (shape mirrors GET /timeline response — events sorted newest-first with fields including `updatedAt`, `pinned`, `status`).

> Pagination: pass `sinceIso = <lastSeenEventTime>` to page forward — the server returns events newest-first, so this gives clean cursor-based pagination without offsets.

---

### memory_search

`memory_search` also accepts optional `kinds` and renders every hit in text. Its `score` is a ranking score, not raw cosine similarity.

**Input schema:**

<!-- input-schema:memory_search -->

```json
{
  "properties": {
    "actorId": {
      "type": "string"
    },
    "kinds": {
      "items": {
        "enum": [
          "fact",
          "decision",
          "strategy",
          "workflow",
          "skill",
          "episode",
          "task",
          "event",
          "reasoning",
          "entity"
        ],
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "limit": {
      "maximum": 20,
      "minimum": 1,
      "type": "integer"
    },
    "query": {
      "minLength": 1,
      "type": "string"
    },
    "scope": {
      "enum": ["global", "conversation", "personal"],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    }
  },
  "required": ["query"],
  "type": "object"
}
```

| Field      | Description                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `actorId`  | Exact stored actorId (e.g. "key:<id>"; not a userId).                                                         |
| `kinds`    | Default: fact, decision, strategy, workflow, skill, episode, entities. task, event, reasoning only if listed. |
| `limit`    | Default 5, max 20.                                                                                            |
| `query`    | Free text: what you want to search for by meaning.                                                            |
| `scope`    | Omit for all scopes; 'personal' = personal-workspace facts.                                                   |
| `scopeRef` | Filter by project (e.g. 'mnemosyne').                                                                         |

<!-- /input-schema -->

**Example call:**

```json
{ "query": "database architecture decisions", "limit": 5 }
```

**Returns:**

```json
{
  "memories": [
    { "id": "mfact_...", "content": "We chose PostgreSQL for ACID compliance", "score": 0.97 }
  ],
  "_mnemo_label": "untrusted_external_content",
  "_mnemo_version": "3.0"
}
```

> `memory_search` uses the server's automatic mode so it can fall back to keyword search when embeddings are unavailable. Check `debug.searchMode` for the path used.

---

### memory_relate

**Input schema:**

<!-- input-schema:memory_relate -->

```json
{
  "properties": {
    "action": {
      "default": "create",
      "enum": ["create", "list", "history", "retract"],
      "type": "string"
    },
    "confidence": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "from": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "judgmentStatus": {
      "enum": ["pending", "judged", "dismissed"],
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "maxDepth": {
      "maximum": 5,
      "minimum": 1,
      "type": "integer"
    },
    "reason": {
      "type": "string"
    },
    "relationId": {
      "type": "string"
    },
    "sourceKind": {
      "enum": ["fact", "decision", "entity", "episode"],
      "type": "string"
    },
    "targetKind": {
      "enum": ["fact", "decision", "entity", "episode"],
      "type": "string"
    },
    "to": {
      "type": "string"
    },
    "verb": {
      "enum": [
        "related",
        "compatible",
        "scoped",
        "conflicts_with",
        "supersedes",
        "not_conflict",
        "derived_from",
        "part_of",
        "member_of"
      ],
      "type": "string"
    }
  },
  "type": "object"
}
```

| Field            | Description                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `action`         | 'create', 'list', 'history' (supersedes/derived_from lineage) or 'retract' (bitemporal close by relation id). |
| `confidence`     | [0, 1]. Default set by the server.                                                                            |
| `from`           | action='create'/'history'. Source id (episodes: mepi_...).                                                    |
| `idempotencyKey` | Retry key: a resend returns the first result.                                                                 |
| `judgmentStatus` | action='list'. Filter by judgment status.                                                                     |
| `limit`          | action='list'. Limit of relations to return.                                                                  |
| `maxDepth`       | action='history'. Lineage depth. Default and maximum 5.                                                       |
| `reason`         | Optional: why this relation exists.                                                                           |
| `relationId`     | action='retract'. ID of the relation itself, not of its endpoints.                                            |
| `sourceKind`     | action='create'/'history'. Type of the source primitive.                                                      |
| `targetKind`     | action='create'. Type of the target primitive.                                                                |
| `to`             | action='create'. ID of the target primitive.                                                                  |
| `verb`           | action='create'. One of the 9 fixed verbs.                                                                    |

<!-- /input-schema -->

**Example call:**

```json
{
  "sourceKind": "decision",
  "from": "mdec_01j...",
  "targetKind": "fact",
  "to": "mfact_01j...",
  "verb": "derived_from",
  "reason": "The architecture decision was informed by this benchmark fact",
  "confidence": 0.85
}
```

**Returns:** The created relation object from the server.

> The 9 locked verbs are defined in spec v3 §4.2. The server rejects any verb outside this set with a 400 error; the MCP layer validates first so the LLM gets a descriptive error before the network round-trip.

---

### memory_decide

**Input schema:**

<!-- input-schema:memory_decide -->

```json
{
  "properties": {
    "body": {
      "minLength": 1,
      "type": "string"
    },
    "conversationId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "enum": [
        "decision",
        "architecture",
        "policy",
        "process",
        "bugfix",
        "learning",
        "discovery",
        "config"
      ],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "title": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    },
    "topicKey": {
      "type": "string"
    }
  },
  "required": ["body", "kind", "title"],
  "type": "object"
}
```

| Field               | Description                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `body`              | The rationale: reasoning, alternatives considered, deciding factors.                                                      |
| `conversationId`    | Provenance: pass the episode sessionId here; decide has no sessionId parameter of its own.                                |
| `idempotencyKey`    | Retry key: a resend returns the first result.                                                                             |
| `kind`              | Decision category. One of: decision \| architecture \| policy \| process \| bugfix \| learning \| discovery \| config.    |
| `scopeRef`          | Project the decision belongs to (e.g. 'project-x').                                                                       |
| `sensitivity`       | Default 'internal'.                                                                                                       |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context).                                            |
| `title`             | The decision in one sentence (e.g. 'Use PostgreSQL as the primary database.').                                            |
| `topicKey`          | Dedup key ('Auth-Strategy' = 'auth-strategy'): the same key updates the decision; without topicKey each call creates one. |

<!-- /input-schema -->

**Example call:**

```json
{
  "kind": "architecture",
  "title": "Use PostgreSQL as the primary database",
  "body": "We chose PostgreSQL over MySQL for its JSONB support, full ACID compliance, and better support for complex queries. MySQL was considered but ruled out due to weaker partial-index support.",
  "conversationId": "conv_01j..."
}
```

**Returns:** The created or upserted decision object from the server (stored in `mnemo_decision`, not `mnemo_fact`).

> Idempotent by normalized `topic_key`. Re-submitting the same title (normalized) performs an upsert and returns the existing row. Pass an explicit `topicKey` to control the dedup key.

---

### memory_entity

**Input schema:**

<!-- input-schema:memory_entity -->

```json
{
  "properties": {
    "action": {
      "default": "create",
      "enum": ["create", "get", "list", "update", "linked_facts", "link_user", "unlink_user"],
      "type": "string"
    },
    "aliases": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "enum": ["person", "organization", "project", "concept", "place", "other"],
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "name": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "q": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "userId": {
      "type": "string"
    }
  },
  "type": "object"
}
```

| Field               | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `action`            | The operation to perform.                                                                            |
| `aliases`           | Alternative names or nicknames.                                                                      |
| `description`       | Brief: role, context, details.                                                                       |
| `id`                | Required for get, update, linked_facts, link_user, unlink_user.                                      |
| `idempotencyKey`    | Retry key: a resend returns the first result.                                                        |
| `kind`              | Category of the entity. Required for create.                                                         |
| `limit`             | Result limit for list and linked_facts.                                                              |
| `metadata`          | Arbitrary metadata.                                                                                  |
| `name`              | Canonical name. Required for create.                                                                 |
| `q`                 | Search substring for list.                                                                           |
| `sensitivity`       | Set on create only (update refuses it). Default 'internal'.                                          |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context). action='create' only. |
| `userId`            | Account id (mnemo_user.id) for link_user; must be a workspace member.                                |

<!-- /input-schema -->

**Example call:**

```json
{
  "name": "Acme Corp",
  "kind": "organization",
  "description": "Enterprise customer using the ATS product",
  "aliases": ["Acme", "acme-corp"],
  "metadata": { "plan": "enterprise", "region": "us-east" }
}
```

**Returns:** The created or retrieved entity object from the server (upsert by normalized name within the workspace).

**Identity: `link_user` / `unlink_user` actions.** Beyond `create`/`get`/`list`/`update`/`linked_facts`, `memory_entity` supports two actions to bind a `kind: "person"` entity to a real platform account (`linkedUserId`, a `mnemo_user.id` — distinct from _provenance_, which tracks who wrote the row, not who it's about):

```json
{ "action": "link_user", "id": "d0522e17-bd87-4ced-bc38-2b9a499beea7", "userId": "usr_..." }
{ "action": "unlink_user", "id": "d0522e17-bd87-4ced-bc38-2b9a499beea7" }
```

Self-link (your own `userId`) is always allowed. Linking a _different_ user — or reassigning an entity already linked to someone else — requires the caller to hold `memory:admin` scope **and** an owner/admin role in the workspace; the check runs against the entity's _current_ link, not just the requested target, so a plain self-link can't silently hijack another person's existing link. `unlink_user` is bitemporal (closes the old row, creates an unlinked successor) rather than blanking `linkedUserId` in place. `linkedUserId` can never be set via `create`/`update` — only through these two actions.

---

### memory_status

**Input schema:**

<!-- input-schema:memory_status -->

```json
{
  "properties": {},
  "type": "object"
}
```

| Field | Description |
| ----- | ----------- |

<!-- /input-schema -->

**Example call:**

```json
{}
```

**Returns:** Health snapshot from GET /health, including sub-component status for graceful degradation:

```json
{
  "status": "ok",
  "db": "ok",
  "embedder": "ok",
  "queue": "ok",
  "version": "3.6.1",
  "recallLatencyP50Ms": 42
}
```

> Sub-component statuses allow orchestrators to degrade gracefully — e.g. if `embedder` is down but `db` is `"ok"`, fact retrieval by ID may still work while semantic recall is unavailable.

---

### memory_remind_when

**Description:** Schedule a prospective memory trigger. The server evaluates the condition
against new incoming facts and fires the reminder when matched.

**Input schema:**

<!-- input-schema:memory_remind_when -->

```json
{
  "properties": {
    "action": {
      "default": "create",
      "enum": ["create", "list", "dismiss"],
      "type": "string"
    },
    "condition": {
      "minLength": 1,
      "type": "string"
    },
    "content": {
      "minLength": 1,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "status": {
      "enum": ["pending", "triggered", "dismissed", "all"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "triggerAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "type": "object"
}
```

| Field               | Description                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`            | Operation to perform: 'create', 'list' or 'dismiss'.                                                                                               |
| `condition`         | action='create'. Semantic condition checked on each memory_recall; needed without triggerAt.                                                       |
| `content`           | action='create'. Text shown when it fires.                                                                                                         |
| `id`                | action='dismiss'. Reminder id.                                                                                                                     |
| `idempotencyKey`    | Retry key: a resend returns the first result.                                                                                                      |
| `limit`             | action='list'.                                                                                                                                     |
| `status`            | action='list'. Default 'pending'; 'triggered' = fired, unreviewed (content kept).                                                                  |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context). action='create' only.                                               |
| `triggerAt`         | action='create'. ISO 8601 earliest fire time (checked every 30s); needed without condition. With both, a later memory_recall must match condition. |

<!-- /input-schema -->

**Output schema:**

```json
{
  "content": [{ "type": "text", "text": "Reminder scheduled: {label} (id: {id})" }]
}
```

**Example call:**

```json
{
  "name": "memory_remind_when",
  "arguments": {
    "condition": "user mentions they want to switch to TypeScript",
    "label": "TS migration intent",
    "triggerAt": "2026-07-01T09:00:00Z"
  }
}
```

---

### memory_consolidate

**Description:** Trigger a fast consolidation pass for the active workspace. The engine
selects bounded low-worth candidate facts, merges eligible near-duplicate clusters, and
reports candidate, merge, and skip counts. Only `mode: "fast"` with `dryRun: false` is
currently supported. Manual deep mode returns HTTP 422 `deep_mode_not_supported`, and
`dryRun: true` returns HTTP 422 `dry_run_not_supported` without running consolidation.

**Input schema:**

<!-- input-schema:memory_consolidate -->

```json
{
  "properties": {
    "dryRun": {
      "default": false,
      "type": "boolean"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "mode": {
      "default": "fast",
      "enum": ["fast", "deep"],
      "type": "string"
    }
  },
  "type": "object"
}
```

| Field            | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `dryRun`         | Must be false: `dryRun: true` returns HTTP 422.              |
| `idempotencyKey` | Retry key: a resend returns the first result.                |
| `mode`           | `fast` (default) or `deep` (a manual deep returns HTTP 422). |

<!-- /input-schema -->

**Output schema:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Consolidation complete. candidates=N merged=M skipped=K"
    }
  ]
}
```

**Example call:**

```json
{
  "name": "memory_consolidate",
  "arguments": { "mode": "fast", "dryRun": false }
}
```

---

### memory_session

**Description:** Unified session-control tool (spec §24). Dispatches on `action`:
`pin`/unpin a fact, append a `scratch` turn to a session, `collapse` a session
(triggering the extraction pipeline), or `discard` a session. The MCP layer is a thin
adapter — the server owns the logic. Action → transport mapping:

- `pin` → `client.pinFact` / `client.unpinFact` (`POST /facts/:id/pin`) — **live**
- `collapse` → `client.collapseSession` (`POST /session/:id/collapse`) — **live**
- `scratch` → `client.updateSessionScratch` (`POST /session/:id/scratch`) — **live**
- `discard` → `client.discardSession` (`POST /session/:id/discard`) — **live**

**Input schema:**

<!-- input-schema:memory_session -->

```json
{
  "properties": {
    "action": {
      "enum": [
        "start",
        "turn",
        "pin_turn",
        "pin",
        "scratch",
        "collapse",
        "discard",
        "feedback",
        "get",
        "list"
      ],
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "collapseHint": {
      "type": "string"
    },
    "content": {
      "maxLength": 20000,
      "type": "string"
    },
    "factId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "metadata": {
      "type": "object"
    },
    "rating": {
      "enum": ["up", "down"],
      "type": "string"
    },
    "role": {
      "enum": ["user", "assistant", "system"],
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "turnId": {
      "type": "string"
    },
    "turnIndex": {
      "type": "integer"
    },
    "unpin": {
      "type": "boolean"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Field            | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `action`         | The session operation to perform.                                          |
| `agentId`        | For start: the new session's agent.                                        |
| `collapseHint`   | For collapse: 'explicit' = full extraction, 'auto' = recurrence heuristic. |
| `content`        | For scratch and turn: the note or turn text.                               |
| `factId`         | Fact to pin or unpin. Required for pin.                                    |
| `idempotencyKey` | Retry key: a resend returns the first result.                              |
| `metadata`       | Metadata for start or scratch.                                             |
| `rating`         | For feedback: 'up' (success) or 'down' (failure).                          |
| `role`           | For scratch and turn. Default assistant (scratch), user (turn).            |
| `sessionId`      | Required for turn, pin_turn, collapse, scratch, discard, feedback, get.    |
| `turnId`         | For pin_turn: the turn id (uuid).                                          |
| `turnIndex`      | For pin_turn: the turn's index.                                            |
| `unpin`          | For pin/pin_turn: true unpins. Default false.                              |

<!-- /input-schema -->

**Output schema:**

```json
{
  "content": [{ "type": "text", "text": "<result summary>" }],
  "structuredContent": { "<action-specific result>" }
}
```

All actions return a successful response with action-specific structured content (e.g., `{ "scratched": true, "sessionId": "..." }` for scratch, `{ "discarded": true, "sessionId": "..." }` for discard).

**Example call:**

```json
{
  "name": "memory_session",
  "arguments": { "action": "pin", "factId": "fct_01hwz..." }
}
```

---

### memory_episode_start

> **Note (spec §24 MCP Tools):** The unified `memory_session` tool (above) exposes the
> spec's `action: pin | scratch | collapse | discard` contract, and all four actions are
> fully wired. `memory_pin`, `memory_episode_start`, and `memory_episode_end` remain as
> focused aliases for the pin / open-session / collapse paths and continue to work.

**Description:** Open a named episode (session). Returns a `sessionId` that should be
passed to subsequent `memory_remember` calls to group facts under the episode context.
Close with `memory_episode_end` to trigger transcript extraction.

**Input schema:**

<!-- input-schema:memory_episode_start -->

```json
{
  "properties": {
    "agentId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "label": {
      "type": "string"
    },
    "metadata": {
      "type": "object"
    }
  },
  "type": "object"
}
```

| Field            | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `agentId`        | Agent starting the episode. Default: the workspace's agent. |
| `idempotencyKey` | Retry key: a resend returns the first result.               |
| `label`          | Readable label (e.g. 'Client meeting 2026-06-12').          |
| `metadata`       | Metadata for the episode (e.g. { projectId, ticketUrl }).   |

<!-- /input-schema -->

**Output schema:**

```json
{
  "content": [{ "type": "text", "text": "Episode started. sessionId: {id}" }]
}
```

**Example call:**

```json
{
  "name": "memory_episode_start",
  "arguments": { "agentId": "claude-sonnet", "actorId": "user-42" }
}
```

---

### memory_episode_end

**Description:** Close an episode and trigger the 8-step collapse pipeline: the session
transcript is sent to the LLM for fact extraction, which creates new facts tagged with
the episode context. The session status changes to `collapsed`.

**Input schema:**

<!-- input-schema:memory_episode_end -->

```json
{
  "properties": {
    "collapseHint": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "sessionId": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": ["sessionId"],
  "type": "object"
}
```

| Field            | Description                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collapseHint`   | Optional extraction hint (e.g. 'prioritize user decisions').                                                                                                                 |
| `idempotencyKey` | Retry key: a resend returns the first result.                                                                                                                                |
| `sessionId`      | ID of the episode/session to close. Returned by `memory_episode_start`. Pure MCP only: under 'Episode: open' or 'mnemo-managed-v1:' the host closes it; compaction does not. |

<!-- /input-schema -->

**Output schema:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Episode collapsed. sessionId: {id} status: collapsed"
    }
  ]
}
```

**Example call:**

```json
{
  "name": "memory_episode_end",
  "arguments": {
    "sessionId": "ses_01hwz...",
    "collapseHint": "Focus on architecture decisions"
  }
}
```

---

### memory_task

**Description:** Manage the workspace's actionable tasks. Tasks are one-off pieces of work with an owner, a status and dependencies. Domain verbs §24: `delegate` reassigns the task to another agent (requires `assignedTo`; applies `status → delegated`); `complete` marks it done (accepts `outcome` and `lessonsLearned`).

**Input schema:**

<!-- input-schema:memory_task -->

```json
{
  "properties": {
    "action": {
      "enum": ["create", "get", "list", "patch", "archive", "delegate", "complete"],
      "type": "string"
    },
    "assignedTo": {
      "type": "string"
    },
    "dueAt": {
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "lessonsLearned": {
      "maxLength": 20000,
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "outcome": {
      "maxLength": 20000,
      "type": "string"
    },
    "parentTaskId": {
      "type": "string"
    },
    "parentTaskIdFilter": {
      "type": "string"
    },
    "priority": {
      "enum": ["critical", "high", "medium", "low"],
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "status": {
      "enum": ["pending", "in_progress", "blocked", "delegated", "completed", "cancelled"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "title": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Field                | Description                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `action`             | create → title, assignedTo; get, patch, archive, complete → id; delegate → id, assignedTo.           |
| `assignedTo`         | Required for create and delegate.                                                                    |
| `description`        | Task details. For create and patch.                                                                  |
| `dueAt`              | When the task is due, ISO 8601. For create.                                                          |
| `id`                 | Required for get/patch/archive/delegate/complete.                                                    |
| `idempotencyKey`     | Retry key: a resend returns the first result.                                                        |
| `lessonsLearned`     | What to remember from it. For patch and complete.                                                    |
| `limit`              | For list.                                                                                            |
| `metadata`           | Free-form JSON. For create and patch.                                                                |
| `outcome`            | What came of the task. For patch and complete.                                                       |
| `parentTaskId`       | Parent task id, making this a subtask. For create.                                                   |
| `parentTaskIdFilter` | For list: only the subtasks of this task.                                                            |
| `priority`           | critical, high, medium or low. For create and patch.                                                 |
| `sensitivity`        | Set on create only (patch refuses it). Default 'internal'.                                           |
| `sessionId`          | The session the task belongs to. For create.                                                         |
| `status`             | For patch: new status. For list: a filter.                                                           |
| `targetWorkspaceId`  | Write to this workspace UUID instead (needs write/admin; IDs: memory_context). action='create' only. |
| `title`              | Required for create.                                                                                 |

<!-- /input-schema -->

**Example call:**

```json
{
  "name": "memory_task",
  "arguments": {
    "action": "create",
    "title": "Migrate auth to Better Auth",
    "assignedTo": "agent-claude",
    "priority": "high"
  }
}
```

---

### memory_event

**Description:** Record immutable events in the workspace log. Events are append-only; use `memory_fact` for mutable state.

**Input schema:**

<!-- input-schema:memory_event -->

```json
{
  "properties": {
    "action": {
      "enum": ["create", "get", "list", "archive", "annotate", "sensitivity"],
      "type": "string"
    },
    "after": {
      "format": "date-time",
      "type": "string"
    },
    "at": {
      "format": "date-time",
      "type": "string"
    },
    "author": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "before": {
      "format": "date-time",
      "type": "string"
    },
    "content": {
      "maxLength": 20000,
      "minLength": 1,
      "type": "string"
    },
    "durationS": {
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "name": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    },
    "occurredAt": {
      "format": "date-time",
      "type": "string"
    },
    "relatedEntities": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "source": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "sourceFilter": {
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "type": {
      "enum": ["system", "external", "user", "agent", "scheduled"],
      "type": "string"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Field               | Description                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`            | create (type, name, description, occurredAt, source) \| get \| list \| archive = NO-OP {archived:false, immutable:true} \| annotate \| sensitivity (raise only; lowering is 422). |
| `after`             | For list: only events after this instant.                                                                                                                                         |
| `at`                | Optional timestamp for annotate.                                                                                                                                                  |
| `author`            | Required for annotate.                                                                                                                                                            |
| `before`            | For list: only events before this instant.                                                                                                                                        |
| `content`           | Annotation content. Required for annotate.                                                                                                                                        |
| `description`       | Required for create.                                                                                                                                                              |
| `durationS`         | Duration in seconds. For create.                                                                                                                                                  |
| `id`                | Required for get/archive/annotate/sensitivity.                                                                                                                                    |
| `idempotencyKey`    | Retry key: a resend returns the first result.                                                                                                                                     |
| `limit`             | For list.                                                                                                                                                                         |
| `metadata`          | Free-form JSON. For create.                                                                                                                                                       |
| `name`              | Required for create.                                                                                                                                                              |
| `occurredAt`        | When it happened. Required for create.                                                                                                                                            |
| `relatedEntities`   | Entity ids involved. For create.                                                                                                                                                  |
| `sensitivity`       | create: initial tier (default 'internal'); sensitivity: the new tier, never lower.                                                                                                |
| `source`            | Where the event came from. Required for create.                                                                                                                                   |
| `sourceFilter`      | For list: only events from this source.                                                                                                                                           |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context). action='create' only.                                                                              |
| `type`              | Required for create.                                                                                                                                                              |

<!-- /input-schema -->

**Example call:**

```json
{
  "name": "memory_event",
  "arguments": {
    "action": "create",
    "type": "agent",
    "name": "wave-b-deployed",
    "description": "Wave B MCP tools deployed successfully",
    "occurredAt": "2026-06-15T01:00:00.000Z",
    "source": "mcp-agent"
  }
}
```

---

### memory_reasoning

**Description:** Store structured chains of thought (question → steps → conclusion) to reuse in similar situations.

**Input schema:**

<!-- input-schema:memory_reasoning -->

```json
{
  "properties": {
    "action": {
      "enum": ["create", "get", "list", "patch", "archive", "resolve", "record", "feedback"],
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "chain": {
      "items": {
        "properties": {
          "conclusion": {
            "maxLength": 20000,
            "type": "string"
          },
          "reasoning": {
            "maxLength": 20000,
            "minLength": 1,
            "type": "string"
          },
          "step": {
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": ["reasoning", "step"],
        "type": "object"
      },
      "maxItems": 200,
      "type": "array"
    },
    "conclusion": {
      "maxLength": 20000,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "outcome": {
      "enum": ["success", "fail"],
      "type": "string"
    },
    "query": {
      "maxLength": 20000,
      "type": "string"
    },
    "question": {
      "maxLength": 20000,
      "type": "string"
    },
    "reasoningId": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "status": {
      "enum": ["active", "archived", "pruned", "quarantined", "golden"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "topicKey": {
      "maxLength": 200,
      "type": "string"
    },
    "topicKeyFilter": {
      "type": "string"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Field               | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `action`            | resolve = look up the reasoning cache; record = store a chain with its outcome; feedback = rate one. |
| `agentId`           | Reasoning agent. For create and record.                                                              |
| `chain`             | Ordered {step, reasoning, conclusion?}. Required for create/record; replaces it on patch.            |
| `conclusion`        | Where it ended. Required for create and record; also patch.                                          |
| `id`                | Required for get, patch and archive.                                                                 |
| `limit`             | For list.                                                                                            |
| `metadata`          | Free-form JSON. For create and patch.                                                                |
| `outcome`           | success or fail. For record and feedback (required).                                                 |
| `query`             | The question to look up. Required for resolve.                                                       |
| `question`          | Required for create and record.                                                                      |
| `reasoningId`       | Record to rate. Required for feedback.                                                               |
| `sensitivity`       | Set on create and record (patch refuses it).                                                         |
| `status`            | For patch: new status. For list: a filter.                                                           |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context). action='create' only. |
| `topicKey`          | Groups records on one question. For create, record, resolve.                                         |
| `topicKeyFilter`    | For list: only records with this topicKey.                                                           |

<!-- /input-schema -->

**Example call:**

```json
{
  "name": "memory_reasoning",
  "arguments": {
    "action": "create",
    "question": "Should we use PostgreSQL or MongoDB for this use case?",
    "chain": [
      { "step": 1, "reasoning": "Need ACID transactions and relational joins" },
      { "step": 2, "reasoning": "Schema is stable and well-defined" }
    ],
    "conclusion": "PostgreSQL is the right choice"
  }
}
```

---

### memory_strategy

**Description:** Manage reusable strategies: trigger→action heuristics the agent applies when a triggering condition occurs. Use `op` as the discriminator (not `action`, which is a content field). Domain verbs §24: `store` saves a new strategy (alias of `create`); `recall` retrieves relevant/active strategies (alias of `list`); `rate` records a strategy's outcome (success/failure) to adjust its worth.

**Input schema:**

<!-- input-schema:memory_strategy -->

```json
{
  "properties": {
    "action": {
      "maxLength": 20000,
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "context": {
      "maxLength": 20000,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "op": {
      "enum": ["create", "get", "list", "patch", "archive", "store", "recall", "rate"],
      "type": "string"
    },
    "outcome": {
      "enum": ["success", "failure"],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "status": {
      "enum": ["active", "superseded", "archived"],
      "type": "string"
    },
    "statusFilter": {
      "enum": ["active", "superseded", "archived"],
      "type": "string"
    },
    "supersedesId": {
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "trigger": {
      "maxLength": 20000,
      "type": "string"
    },
    "validAt": {
      "format": "date-time",
      "type": "string"
    },
    "validFrom": {
      "format": "date-time",
      "type": "string"
    },
    "validTo": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": ["op"],
  "type": "object"
}
```

| Field               | Description                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `action`            | Required for create: the response to run.                                                                |
| `agentId`           | Owning agent. For create and store.                                                                      |
| `context`           | When it applies, free text. For create, store and patch.                                                 |
| `id`                | Required for get/patch/archive.                                                                          |
| `idempotencyKey`    | Retry key: a resend returns the first result.                                                            |
| `limit`             | For list.                                                                                                |
| `metadata`          | Free-form JSON. For create, store and patch.                                                             |
| `op`                | The operation to perform.                                                                                |
| `outcome`           | For rate: success or failure.                                                                            |
| `scopeRef`          | Project, set on create/store (patch refuses it); filters list/recall.                                    |
| `sensitivity`       | Set on create/store only (patch refuses it). Default 'internal'.                                         |
| `status`            | For patch: the new status.                                                                               |
| `statusFilter`      | For list: only strategies in this status.                                                                |
| `supersedesId`      | Strategy this one replaces (it is closed). For create/store.                                             |
| `targetWorkspaceId` | Write to this workspace UUID instead (needs write/admin; IDs: memory_context). op='create'/'store' only. |
| `trigger`           | Required for create.                                                                                     |
| `validAt`           | For list: only strategies valid at this instant.                                                         |
| `validFrom`         | When it starts to apply. For create and store.                                                           |
| `validTo`           | When it stops applying. For patch.                                                                       |

<!-- /input-schema -->

**Example call:**

```json
{
  "name": "memory_strategy",
  "arguments": {
    "op": "create",
    "trigger": "API returns 5xx three times in a row",
    "action": "Switch to exponential backoff with jitter; alert after 5 minutes",
    "context": "execution"
  }
}
```

---

### memory_self_edit

**Description:** Edit your own memory with `append`, `replace`, `strengthen`, `weaken`, `reflect` or `link`. When `replace` targets a fact, the server closes the historical version, creates a successor with a new ID and returns `replacementId`. The reason is required policy context, but it is not yet persisted as a durable audit. `forget` is not a supported action here (the server rejects it with 422); to invalidate a fact or strategy use `memory_forget`.

**Input schema:**

<!-- input-schema:memory_self_edit -->

```json
{
  "properties": {
    "action": {
      "enum": ["append", "replace", "strengthen", "weaken", "reflect", "link"],
      "type": "string"
    },
    "content": {
      "maxLength": 20000,
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "reason": {
      "maxLength": 2000,
      "minLength": 1,
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "target": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": ["action", "reason", "target"],
  "type": "object"
}
```

| Field            | Description                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `action`         | append/replace text, strengthen/weaken worth, reflect, or link (hyperedge with the comma-separated ids in content). |
| `content`        | New text (for append/replace).                                                                                      |
| `idempotencyKey` | Retry key: a resend returns the first result.                                                                       |
| `reason`         | Required reason, used to evaluate the edit policy.                                                                  |
| `sessionId`      | From memory_session/episode_start: uses its budget; else 5 edits/day.                                               |
| `target`         | fact_id, "profile", or "strategy:{id}".                                                                             |

<!-- /input-schema -->

**Example call:**

```json
{
  "name": "memory_self_edit",
  "arguments": {
    "action": "replace",
    "target": "mfact_01j...",
    "content": "The user prefers dark mode in all applications",
    "reason": "Previous statement only mentioned VS Code; confirmed applies globally"
  }
}
```

**Returns:** A structured self-edit result. Applied fact replacements include `targetKind: "fact"` and the required new `replacementId`. Approval-required results do not include a replacement ID. Returns `isError: true` with a descriptive message on failure.

---

## License

Apache-2.0 © Lucas Mailland
