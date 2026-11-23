# Mnemosyne MCP — User Guide

**English** · [Español](MCP_GUIDE.es.md)

Target audience: developer who has a Mnemosyne server running and wants to connect an AI coding agent to it.

---

## Table of Contents

1. [How it works](#1-how-it-works)
2. [Setup options](#2-setup-options)
3. [Claude Desktop](#3-claude-desktop)
4. [Passive capture — automatic memory](#4-passive-capture--automatic-memory)
5. [All 37 tools — when to use each](#5-all-37-tools--when-to-use-each)
6. [No-repo usage](#6-no-repo-usage)
7. [FAQ](#7-faq)

---

## 1. How it works

```
Claude Code / Cursor / Claude Desktop
        │
        │  (stdio JSON-RPC)
        ▼
  @mnemo-ai/mcp  ← thin adapter process (npx -y @mnemo-ai/mcp)
        │
        │  (HTTP + Bearer token)
        ▼
  Mnemosyne server  (your local Docker or remote VPS)
        │
        ├── PostgreSQL + pgvector  (storage + HNSW semantic index)
        └── Redis                  (hot-tier session cache)
```

The MCP process is a **thin proxy**. It contains no business logic — every tool call becomes an HTTP request to the Mnemosyne server. Business logic (recall pipeline, RLS, audit log, consolidation) lives exclusively in the server.

**Two env vars are all that's needed:**

| Variable    | Example                      | What it is                        |
| ----------- | ---------------------------- | --------------------------------- |
| `MNEMO_URL` | `https://memory.example.com` | Base URL of your Mnemosyne server |
| `MNEMO_KEY` | `mns_live_abc123`            | API key for your workspace        |

**Why stdio (not an HTTP server)?**

MCP clients (Claude Code, Cursor, Claude Desktop) spawn the MCP server as a child process and pipe JSON-RPC frames over stdin/stdout. This means:

- No port binding required — no firewall rules, no port conflicts
- The MCP process starts on demand and exits when the client disconnects
- `npx -y @mnemo-ai/mcp` works out of the box without any global install

---

## 2. Setup options

Choose one option based on your situation.

### Option A — Full local setup (monorepo)

For contributors or users who want to run the server themselves.

```bash
# Clone and start everything with Docker
git clone https://github.com/lucasmailland/mnemosyne
cd mnemosyne
pnpm install
pnpm docker:up          # starts Postgres + pgvector
pnpm build
pnpm --filter @mnemo-ai/server dev   # server on :3939

# Or use mnemo install to auto-configure all detected agents (Claude Code, Cursor, OpenCode, Codex, Gemini CLI)
mnemo install
```

Or add manually to Claude Code:

```bash
claude mcp add mnemosyne --scope user \
  --env MNEMO_URL=http://localhost:3939 \
  --env MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

### Option B — Cloud/remote server (no repo needed)

You have Mnemosyne running on a VPS or cloud host. You only need npm — no repo clone required.

```bash
# Claude Code (one-time command)
claude mcp add mnemosyne --scope user \
  --env MNEMO_URL=https://your-server.com \
  --env MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

Or use the CLI to configure interactively:

```bash
npm install -g @mnemo-ai/cli
mnemo init   # prompts for MNEMO_URL and MNEMO_KEY, writes ~/.mnemo/config.json
```

### Option C — Plugin (recommended for Claude Code)

The plugin gives you automatic memory capture via hooks in addition to the MCP tools.

```bash
# Step 1 — Register the marketplace (once per machine)
claude plugin marketplace add lucasmailland/mnemosyne

# Step 2 — Install the plugin
claude plugin install mnemosyne@mnemosyne
```

Then set env vars in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export MNEMO_URL=https://your-server.com
export MNEMO_KEY=mns_live_...
```

Claude Code will auto-wire the session hooks. On the next session start the memory protocol is injected automatically and hooks start capturing.

---

## 3. Claude Desktop

Claude Desktop supports MCP tools but not Claude Code hooks. Tools work; automatic passive capture does not.

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "mns_live_..."
      },
      "type": "stdio"
    }
  }
}
```

Restart Claude Desktop. The server's tools will appear in the tool selector: all 37, or only the 9 most used (recall, fact, remember, decide, update, forget, search, status, context) with `"MNEMO_MCP_TOOLS": "core"` in `env`.

**Note on hooks:** Session hooks (`session-start.sh`, `subagent-stop.sh`, etc.) are a Claude Code feature and do not run in Claude Desktop. The AI can still call tools manually, but it will not auto-recall context at session start unless you explicitly ask it to call `memory_recall`.

---

## 4. Passive capture — automatic memory

There are two operating modes:

### Manual mode (baseline)

Without the plugin, the AI decides when to call memory tools based on its instructions. With the memory protocol loaded (`SKILL.md`), the AI:

- Calls `memory_recall` before responding to the first message in every session
- Calls `memory_remember` proactively after decisions, bug fixes, and preferences
- Calls `memory_episode_end` before saying "done" to persist the full session

This is what you get with Option B (MCP only) or Claude Desktop.

### Automatic mode (plugin hooks)

The plugin wires five shell hooks that run without any AI involvement:

| Hook                    | When it fires                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-start.sh`      | On `SessionStart` (startup/clear)                                                  | Calls `POST /session/start`, stores the Mnemosyne session id in a correlation mapping keyed by Claude's own session id (`~/.mnemo/sessions/<claude_session_id>.json`, 7-day GC — read by `user-prompt-submit.sh` and `session-stop.sh` below), injects `SKILL.md` + workspace stats as `additionalContext`                                                                                                                                                                                                                                                                                                   |
| `post-compaction.sh`    | On `SessionStart` (compact)                                                        | Triggers post-compaction recovery protocol (replays buffer through `memory_episode_end`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `user-prompt-submit.sh` | On every `UserPromptSubmit`                                                        | **First message** (autonomous-memory Requirement 2): calls `POST /recall` itself using the prompt as the query (plus the correlated session id, if any) and injects hits via `additionalContext` — real recalled context reaches the model with zero tool calls. A slimmed-down `ToolSearch` nudge is still sent alongside it for follow-up recall on a topic shift, and becomes the sole fallback if the server is unreachable or returns no hits. **Subsequent messages**: unchanged — checks `lastWriteAt` from `/admin/stats`, nudges to save if it's been > 15 minutes since the last `memory_remember` |
| `subagent-stop.sh`      | On `SubagentStop` (async)                                                          | Sends the subagent's `stdout` to `POST /capture` for automatic fact extraction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `session-stop.sh`       | On `Stop` (async at the harness level, synchronous internally — see script header) | Guarantees the session's episode gets collapsed even if the model never called `memory_episode_end` (skips re-collapsing if already `collapsed`). Then runs the autonomous-memory Requirement 4 **compliance backstop**: checks whether recall ever correlated to this session (`lastRecallAt`) and whether collapse succeeded, surfacing a `systemMessage` gap report ONLY when something genuinely didn't happen (e.g. the server was unreachable all session) — never a re-nag of something that already worked                                                                                           |

The result: memory is captured and recalled even when the AI forgets to call tools explicitly — recall is auto-injected on the first message, episodes auto-collapse at session end, and a compliance check flags the rare case where neither happened. Every subagent output is also automatically scanned for extractable facts.

---

## 5. All 37 tools — when to use each

All 37 are served by default; `MNEMO_MCP_TOOLS=core` trims the list to the 9 most used, for a smaller per-request surface.

The AI selects tools based on the task. This section explains the intent so you can refer to it in prompts or configure a custom protocol.

### Memory operations

| Tool                       | When to use                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_remember`          | Save a durable fact. Call proactively after decisions, bug fixes, preferences, or non-obvious discoveries. This is the workhorse tool.                                       |
| `memory_forget`            | Soft-delete a fact that is no longer true. Sets `validTo = NOW()` — the row is preserved for audit. Does NOT delete.                                                         |
| `memory_update`            | Correct a fact you saved incorrectly. Use when the statement itself was wrong, not just outdated.                                                                            |
| `memory_fact`              | Read one fact in full by id. Use it when a compact recall hit says `truncated: true` and you need the whole text.                                                            |
| `memory_relocate`          | Move a fact to the workspace it belongs in. Closes the original and creates the successor there, linked by `supersedes`; confidential and restricted facts cannot move.      |
| `memory_suggest_topic_key` | Derive a stable `topicKey` from a subject and body before saving, so a later save on the same topic updates it instead of adding a duplicate.                                |
| `memory_pin`               | Keep a fact out of consolidation merges (it does not raise its recall rank). Use for critical invariants that must stay as written (e.g. "RLS must always use withMnemoTx"). |
| `memory_timeline`          | See recent activity in the workspace. Useful for session summaries or "what happened this week".                                                                             |
| `memory_status`            | Quick workspace health snapshot — live fact count, last write, feature flags. Call at session start or when something feels off.                                             |

### Recall and search

| Tool            | When to use                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_recall` | 7-stage hybrid pipeline (vector + ACT-R activation + worth scoring). Use for semantic queries: "what did we decide about X", "how do we handle Y". This is the primary recall tool. |
| `memory_search` | Pure full-text search. Use for exact keyword matches (error codes, function names, known phrases). Works without an LLM API key. Faster but not semantic.                           |

**Choosing between them:** `memory_recall` is almost always better for understanding. `memory_search` is faster for "find the exact error message we documented".

### Knowledge graph

| Tool               | When to use                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_relate`    | Link two facts with a typed relation verb (one of the 9 locked verbs: `related`, `compatible`, `scoped`, `conflicts_with`, `supersedes`, `not_conflict`, `derived_from`, `part_of`, `member_of`). Call when you notice a meaningful connection. |
| `memory_hyperedge` | Link 3 or more facts in a single co-activation cluster. Use for decisions that span multiple components or facts that always apply together.                                                                                                    |
| `memory_compare`   | Diff two facts — see what changed between two versions of a decision or piece of knowledge.                                                                                                                                                     |
| `memory_judge`     | Resolve a conflict between two facts that contradict each other. Picks the authoritative version and records the reasoning.                                                                                                                     |

### Structured primitives

These tools create richer typed records than plain `memory_remember`.

| Tool               | When to use                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_decide`    | Record an architectural or policy decision with full rationale, context, and alternatives considered. Richer than `memory_remember` for anything that needed deliberation. |
| `memory_entity`    | Upsert a person, organization, project, concept, or place. Use when a recurring actor needs its own node in the graph (e.g. "Ada", "Mnemosyne", "PostgreSQL").             |
| `memory_strategy`  | Record a "when X, do Y" heuristic that the AI should reapply in future sessions (e.g. "when RLS fails, check withMnemoTx first").                                          |
| `memory_reasoning` | Store a chain-of-thought record with worth decay. Use when you want to preserve a line of reasoning, not just its conclusion.                                              |
| `memory_task`      | Track an action item with lifecycle (`pending` → `completed`). Use for work items you want the AI to remember across sessions.                                             |
| `memory_event`     | Record an immutable fact that happened. No `updatedAt` — events are append-only by design. Use for "we deployed v3.2 on 2026-06-10".                                       |
| `memory_workflow`  | Save a reusable multi-step process template (e.g. "how to cut a release"). The AI can recall and execute it later.                                                         |
| `memory_skill`     | Record an AI capability or prompt template (e.g. "I know how to write migration files in this project"). Recalled and applied automatically.                               |

### Session management

| Tool                   | When to use                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_episode_start` | Begin a work session. Facts are buffered temporarily. Call at the start of significant work expected to last more than 5 minutes.                                                                                                               |
| `memory_episode_end`   | Close the session and collapse the buffer into durable memory. Call before saying "done". The LLM summarises the full buffer for richer extraction than individual `memory_remember` calls.                                                     |
| `memory_session`       | Unified session-control tool with actions: `pin` (elevate a scratch fact), `scratch` (add a temporary note), `collapse` (manual collapse), `discard` (abandon session without saving). For fine-grained session control within an open episode. |

### Metacognition

| Tool                 | When to use                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_introspect`  | Ask "what do I know well? what are my gaps?" Returns a structured self-assessment of workspace knowledge coverage. Call when starting a new project phase.                                        |
| `memory_anticipate`  | Predict what facts will be needed next based on the current task context. Useful for pre-loading relevant context at the start of a complex task.                                                 |
| `memory_consolidate` | Merge duplicate or redundant facts. Triggers `POST /consolidation/trigger` which runs the background consolidation pipeline. Use after bulk imports or long sessions with many overlapping facts. |
| `memory_compose`     | Inference engine — compose new facts from existing ones using declarative rules. Use when you want the system to derive implicit knowledge from what it already knows.                            |

### Reminders

| Tool                 | When to use                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_remind_when` | Set a future trigger: time-based ("remind me about X in 3 days") or semantic ("remind me about X when we next work on auth"). The background polling evaluates triggers every 30 seconds. |

### Self-edit

| Tool               | When to use                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_self_edit` | Allow the memory system to propose edits to its own stored facts based on new evidence. Use with care — this is a governance-level operation. |

### Operations

| Tool            | When to use                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_doctor` | Run 8 operational diagnostics: Postgres connectivity, app_user grants, schema shadows, migration version, embedding backlog, workspace_id validity, MCP env config, and MCP tool registration count. Call immediately on any 500 error before retrying.                          |
| `memory_stats`  | Detailed workspace statistics: fact counts by primitive type, recall log volume, storage usage.                                                                                                                                                                                  |
| `memory_purge`  | Permanently delete one fact by ID (`action='fact'`) or every forgotten fact in the workspace (`action='closed'`). **Deletion is permanent and cannot be undone.** Not GDPR erasure; for ordinary forgetting use `memory_forget`. Test workspaces only; never call in production. |

### Identity & workspace

See [architecture/MULTI_TENANCY.md](../architecture/MULTI_TENANCY.md) for the full model. **Neither tool switches the active workspace** — it's fixed for the whole session, set once at process start by the API key/token (or `MNEMO_WORKSPACE_ID`). Your role (owner/admin/write/read), not just your key's raw scopes, is the real ceiling on what you can do — a write tool returning 403 is very likely your role, not an outage; call `memory_context` to confirm before retrying, and tell the user to ask a workspace admin for access rather than looping.

| Tool               | When to use                                                                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_context`   | Optional identity/orientation call — returns active workspace, userId, tenantId, scopes, and live stats in one shot. Workspace scoping is already established by the API key on every call (including `memory_recall`); this is for orientation, not a session-start gate.                               |
| `memory_workspace` | 8 actions: `list` (your own memberships + role), `describe`, `members` (+ roles), `current`, plus 4 mutating actions requiring workspace owner/admin: `create`, `invite`, `set_role`, `remove` — a `read`/`write`-role caller gets a real 403 from the server for those, not just a client-side refusal. |

---

## 6. No-repo usage

You do not need to clone the Mnemosyne repository to use it as a client. The repo is only needed if you want to run the server locally.

### Just the CLI

```bash
npm install -g @mnemo-ai/cli
mnemo init   # prompts for MNEMO_URL + MNEMO_KEY, writes ~/.mnemo/config.json
mnemo status
mnemo recall "what did we decide about RLS?"
```

### Just the MCP (Claude Code)

```bash
claude mcp add mnemosyne --scope user \
  -e MNEMO_URL=https://your-server.com \
  -e MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

Verify it registered:

```bash
claude mcp list
```

### One-liner install script (coming soon)

Once the packages are published to npm, a shell installer will be available:

```bash
# Not yet available — packages must be published first
curl -fsSL https://raw.githubusercontent.com/lucasmailland/mnemosyne/main/scripts/install.sh | bash
```

This script does not exist yet. Use `npm install -g @mnemo-ai/cli` and `claude mcp add` above in the meantime.

---

## 7. FAQ

**Do I need to clone the repo?**

No. For connecting a client to Mnemosyne, you only need `npx @mnemo-ai/mcp` (the MCP process) and optionally `@mnemo-ai/cli`. The repo is needed only if you want to run the server yourself.

**What is the difference between `memory_recall` and `memory_search`?**

`memory_recall` runs the full 7-stage pipeline: HNSW vector search → 1-hop relation expansion → ACT-R activation scoring → worth weighting → sensitivity ceiling → structured hits. It is semantic — it finds conceptually related facts even when the keywords don't match.

`memory_search` is pure full-text search (PostgreSQL FTS). It is faster and works without an LLM API key, but it only matches documents that contain the exact keywords.

Use `memory_recall` for understanding and reasoning. Use `memory_search` when you know the exact phrase you saved.

**Can I use it without an LLM API key?**

Yes. `memory_recall` and `memory_search` both fall back to full-text search when no embedding model is configured. All other tools work fully. The only thing you lose is semantic vector indexing — facts are saved but not embedded until you add an LLM key with embedding support.

**Does it work with Cursor, Codex, or Gemini?**

- **MCP tools**: Yes, if the runtime supports MCP. Cursor Agent mode, Codex, and Gemini CLI all support MCP.
- **Plugin hooks**: Cursor has a manifest in `packages/plugin/.cursor-plugin/`. Codex has one in `packages/plugin/.codex-plugin/`. Gemini CLI uses `packages/plugin/GEMINI.md` and `packages/plugin/gemini-extension.json`.
- **Automatic session hooks**: These use Claude Code's `SessionStart` / `SubagentStop` / `Stop` hook system. Other runtimes do not have equivalent hook APIs, so you get tool access but not the automatic capture.

**Does the MCP listen passively like Engram?**

Not by default. The MCP tools are called explicitly by the AI. However, with the Claude Code plugin installed, three things happen automatically without any AI tool call: `user-prompt-submit.sh` recalls context for the first message of a session and injects it directly, `subagent-stop.sh` sends every subagent's output to `POST /capture` for background extraction, and `session-stop.sh` guarantees the session's episode collapses (extracting facts) even if the model never called `memory_episode_end`. See §4's hook table for the full behavior. Without the plugin, the AI must call tools actively.

**What happens if the Mnemosyne server is offline?**

The MCP process will start successfully but tool calls will return HTTP errors. The AI should call `memory_doctor` to diagnose connectivity. All errors are surfaced to stderr (never stdout, which is the JSON-RPC channel). Claude Code surfaces stderr in its UI so you will see a clear error message.

**My API key format — what is valid?**

Keys use the format `mns_live_...` (production) or `mns_test_...` (test/staging). The prefix is stripped and validated server-side. Keys are workspace-scoped — they enforce RLS automatically.

**How does the AI decide when to use each tool?**

The AI follows the behavioral protocol defined in `packages/plugin/skills/memory/SKILL.md`. Core tools (`memory_recall`, `memory_remember`, `memory_status`, `memory_search`, `memory_episode_start`, `memory_episode_end`) are always in context. Extended tools are loaded via `ToolSearch` when the task requires them. With the plugin installed, the protocol is injected at session start automatically. Without the plugin, paste the contents of `SKILL.md` into your system prompt or project instructions.
