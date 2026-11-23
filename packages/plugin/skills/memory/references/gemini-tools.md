# Mnemosyne — Gemini CLI Tool Mapping

Mnemosyne is accessed via MCP tools in Gemini CLI. All `memory_*` calls are MCP tool invocations routed through Gemini CLI's MCP bridge.

## Memory Tool Reference

| Memory tool            | What it does                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory_recall`        | 7-stage hybrid recall: vector search + ACT-R activation scoring + sensitivity filter                                                             |
| `memory_remember`      | Store a persistent fact (pass `subtype` such as `skill` and open `sessionId`)                                                                    |
| `memory_forget`        | Close a memory's validity range (bitemporal — does NOT delete the row)                                                                           |
| `memory_search`        | Full-text + semantic search across all primitives                                                                                                |
| `memory_status`        | Workspace health check + feature flags                                                                                                           |
| `memory_relate`        | Create a relation between two memory primitives                                                                                                  |
| `memory_decide`        | Record an architectural or policy decision (`body`, `conversationId`, `scopeRef`)                                                                |
| `memory_entity`        | Upsert an entity (person, org, project, concept, place)                                                                                          |
| `memory_pin`           | Pin a fact to prevent decay                                                                                                                      |
| `memory_timeline`      | Time-scoped episodic recall                                                                                                                      |
| `memory_episode_start` | Begin an episode (session tracking)                                                                                                              |
| `memory_episode_end`   | End an episode and trigger full extraction pipeline                                                                                              |
| `memory_consolidate`   | Trigger fast manual consolidation; deep mode and `dryRun: true` currently return HTTP 422                                                        |
| `memory_session`       | Unified session control: `pin`/`scratch`/`collapse`/`discard` within an open episode                                                             |
| `memory_introspect`    | Structured self-assessment of workspace knowledge coverage                                                                                       |
| `memory_anticipate`    | Predict facts needed next given the current task context (4-way blend)                                                                           |
| `memory_workflow`      | Manage repeatable process workflows (`create`, `get`, `list`; recallable via `memory_recall`)                                                    |
| `memory_self_edit`     | Propose edits to your own stored facts (append/replace/strengthen/weaken/forget/reflect/link)                                                    |
| `memory_doctor`        | Run 8 operational diagnostics (Postgres connectivity, grants, schema, migrations, embeddings, workspace_id, env config, tool registration count) |
| `memory_update`        | Correct a fact you saved incorrectly (bitemporal replace)                                                                                        |
| `memory_judge`         | Resolve a conflict between two contradicting facts                                                                                               |
| `memory_stats`         | Detailed workspace statistics (fact counts, recall volume, storage)                                                                              |
| `memory_compare`       | Diff two facts, suggests a relation verb                                                                                                         |
| `memory_purge`         | Hard delete — irreversible, requires `memory:hard_delete` scope                                                                                  |
| `memory_context`       | Optional identity/orientation call (active workspace, user, tenant, other workspaces) — not a session-start gate                                 |
| `memory_workspace`     | List workspaces/members available to the current tenant/user                                                                                     |

## Selected Memory Workflows

- **Project entities (catalog & alias lookup):** Query existing entities before writing duplicates.
  - Lookup: `memory_entity(action: "list", q: "mnemosyne")` or `memory_entity(action: "get", id: "<id>")`
  - Create: `memory_entity(action: "create", name: "Mnemosyne", kind: "project", aliases: ["mnemo"], description: "Core engine")`
- **Decisions (rationale & provenance):** Use `memory_decide` for architectural choices and tradeoffs.
  - Example: `memory_decide(kind: "architecture", title: "Use Postgres", body: "Selected for RLS; rejected Redis", conversationId: "<sessionId>", scopeRef: "mnemosyne")`
- **Workflows (repeatable procedures):** Explicitly manage reusable multi-step workflows. Do not promote casual chat into workflows automatically.
  - Create: `memory_workflow(action: "create", name: "deploy", steps: [{order: 1, action: "build"}], scopeRef: "mnemosyne")`
  - Read: `memory_workflow(action: "get", id: "<id>")`, `memory_workflow(action: "list", scopeRef: "mnemosyne")`, or retrieve via `memory_recall(query: "deploy procedure", scopeRef: "mnemosyne")`

## Lifecycle & Session Context

For session lifecycle modes and post-compaction recovery, refer to the canonical protocol in `../SKILL.md`:

- Three modes: managed harness (`mnemo-managed-v1:`), plugin hooks (`Episode: open`), or Pure MCP.
- Post-compaction / resume recovery continues the session without ending it.

## Gemini CLI Native Tool Equivalents

When Mnemosyne tools are unavailable, use Gemini CLI's native tools for basic file operations:

| Action               | Gemini CLI native tool                         |
| -------------------- | ---------------------------------------------- |
| Read a file          | `read_file`                                    |
| Read multiple files  | `read_many_files`                              |
| Write a file         | `write_file`                                   |
| Edit a file          | `replace`                                      |
| Run a shell command  | `run_shell_command`                            |
| Search file contents | `grep_search`                                  |
| Find files by name   | `glob`                                         |
| List directory       | `list_directory`                               |
| Fetch a URL          | `web_fetch`                                    |
| Dispatch a subagent  | `invoke_agent` with `agent_name: "generalist"` |
| Create/update todos  | `write_todos`                                  |

## Instructions File

Gemini CLI loads `GEMINI.md` hierarchically:

- Global: `~/.gemini/GEMINI.md`
- Project-level: `GEMINI.md` in workspace directories and their ancestors
- Subdirectory: auto-loaded when tools access files in that subdirectory

The Mnemosyne `GEMINI.md` at the plugin root provides the full memory protocol.

## Personal Skills Directory

Gemini CLI reads user-level skills from `~/.gemini/skills/` or `~/.agents/skills/` (cross-runtime alias shared with Codex and Copilot CLI). When both exist, `~/.agents/skills/` takes precedence.

## Subagent Dispatch

Dispatch subagents using `invoke_agent` with `agent_name: "generalist"` and the full filled prompt. For parallel work, issue multiple `invoke_agent` calls in the same response.

## Configuration

Mnemosyne reads credentials from:

1. `MNEMO_URL` and `MNEMO_KEY` environment variables
2. `~/.mnemo/config.json` — `{ "url": "...", "apiKey": "..." }`

Register the extension by placing `gemini-extension.json` in your project root, or copy `GEMINI.md` there and Gemini CLI will load the protocol automatically.
