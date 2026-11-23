# Mnemosyne — Claude Code Tool Mapping

Mnemosyne is accessed via MCP tools in Claude Code. All `memory_*` calls are MCP tool invocations — no additional translation is needed.

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

## Claude Code-Specific Notes

**Instructions file**: Claude Code reads `CLAUDE.md`, not `AGENTS.md`. If your project has `AGENTS.md`, import it from `CLAUDE.md`:

```markdown
@AGENTS.md

## Claude Code

(Claude-Code-specific instructions here.)
```

**Subagent dispatch**: Use the `Agent` tool (older releases: `Task`) to dispatch subagents.

**Task tracking**: Use `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` for interactive tasks; `TodoWrite` in `claude -p` / Agent SDK mode.

**Skill invocation**: Use the `Skill` tool to load and execute a skill file.

**Instructions directory**: Project-scoped rules can be placed in `.claude/rules/` with `paths` frontmatter for file-scoped loading.

## Configuration

Mnemosyne reads credentials from:

1. `MNEMO_URL` and `MNEMO_KEY` environment variables
2. `~/.mnemo/config.json` — `{ "url": "...", "apiKey": "..." }`
