# MCP Tool Atomization/Fusion Catalog

> **Basis: designed intent, not measured usage.** No per-tool-name call telemetry exists in
> this codebase (`packages/server/src/metrics.ts` has only `tokensSavedByMechanism` /
> `anticipationAccuracyByWorkspace`; `telemetry/otel.ts` is opt-in HTTP/pg/ioredis tracing with
> no tool-name counter; `mnemo_recall_log` logs per-**fact** access, not per-tool calls;
> `packages/mcp/src` has no handler wrapping). This catalog is built from designed intent —
> [`packages/plugin/skills/memory/SKILL.md`](../../packages/plugin/skills/memory/SKILL.md)'s
> protocol triggers, tool docstrings, and code-verified reference prose in
> [`docs/guides/MCP_TOOLS.md`](../guides/MCP_TOOLS.md) — not from production call logs.
> Adding per-tool-name usage telemetry is a prerequisite for acting on the candidates below (see
> [Closing note](#closing-note-telemetry-prerequisite)), not something this document provides.
>
> Verified against source: 2026-08-11. Tool count: **35** (`packages/mcp/src/tools/*.ts`, 36
> files minus the non-tool `errors.ts` helper).

## Purpose

`docs/archive/BACKLOG.md` P58 asks for a catalog of tool usage patterns to inform (not decide) which of
the 35 MCP tools should be atomized (split into several) or fused (merged into one), under
`flatten-legacy-dual-core` Priority decision #2 (2026-08-09), which authorizes tool-surface
reshaping in principle but requires each reshaping change to be a genuine improvement,
documented, and to migrate every consumer in the same change. This document is the evidence
artifact that decision requires — it does not itself decide anything.

## Classification table

Tiers and caller archetypes come from `SKILL.md`'s two-tier call-frequency model, split further
(per `explore.md`'s finding, reused here) into two Extended sub-archetypes by trigger shape.
Action counts are the number of values in each tool's `action` (or `op`) Zod enum, re-read
directly from `packages/mcp/src/tools/*.ts` at write time; a tool with no `action` parameter is
single-purpose (count = 1). Evidence cites the `action`/`op` enum line where one exists,
otherwise the `server.registerTool(...)` call line.

| Tool                                                                          | Tier     | Caller archetype      | Actions                                                                                                                                                                      | Atomization/fusion signal                                                                                                                                                                   | Evidence                                                                 |
| ----------------------------------------------------------------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`memory_recall`](../guides/MCP_TOOLS.md#memory_recall)                       | Core     | Protocol-autonomous   | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/recall.ts:25`                                                     |
| [`memory_remember`](../guides/MCP_TOOLS.md#memory_remember)                   | Core     | Protocol-autonomous   | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/remember.ts:23`                                                   |
| [`memory_status`](../guides/MCP_TOOLS.md#memory_status)                       | Core     | Protocol-autonomous   | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/status.ts:54`                                                     |
| [`memory_search`](../guides/MCP_TOOLS.md#memory_search)                       | Core     | Protocol-autonomous   | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/search.ts:50`                                                     |
| [`memory_episode_start`](../guides/MCP_TOOLS.md#memory_episode_start)         | Core     | Protocol-autonomous   | 1                                                                                                                                                                            | Fusion (duplicated by `memory_session action='start'`) — see [Candidates](#1-fusion-leading-signal-session-vs-pinepisode_startepisode_end)                                                  | `tools/episode_start.ts:13`                                              |
| [`memory_episode_end`](../guides/MCP_TOOLS.md#memory_episode_end)             | Core     | Protocol-autonomous   | 1                                                                                                                                                                            | Fusion (duplicated by `memory_session action='collapse'`\|`'discard'`) — see [Candidates](#1-fusion-leading-signal-session-vs-pinepisode_startepisode_end)                                  | `tools/episode_end.ts:15`                                                |
| [`memory_decide`](../guides/MCP_TOOLS.md#memory_decide)                       | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/decide.ts:33`                                                     |
| [`memory_entity`](../guides/MCP_TOOLS.md#memory_entity)                       | Extended | Agent-judgment        | 7 (`create`\|`get`\|`list`\|`update`\|`linked_facts`\|`link_user`\|`unlink_user`)                                                                                            | Multiplexed — action-count outlier, not a named candidate here                                                                                                                              | `tools/entity.ts:23-26`                                                  |
| [`memory_relate`](../guides/MCP_TOOLS.md#memory_relate)                       | Extended | Agent-judgment        | 3 (`create`\|`list`\|`history`)                                                                                                                                              | —                                                                                                                                                                                           | `tools/relate.ts:45-50`                                                  |
| [`memory_forget`](../guides/MCP_TOOLS.md#memory_forget)                       | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/forget.ts:23`                                                     |
| [`memory_pin`](../guides/MCP_TOOLS.md#memory_pin)                             | Extended | Agent-judgment        | 1                                                                                                                                                                            | Fusion (duplicated by `memory_session action='pin'`) — see [Candidates](#1-fusion-leading-signal-session-vs-pinepisode_startepisode_end)                                                    | `tools/pin.ts:41`                                                        |
| [`memory_timeline`](../guides/MCP_TOOLS.md#memory_timeline)                   | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/timeline.ts:47`                                                   |
| [`memory_remind_when`](../guides/MCP_TOOLS.md#memory_remind_when)             | Extended | Agent-judgment        | 3 (`create`\|`list`\|`dismiss`)                                                                                                                                              | —                                                                                                                                                                                           | `tools/remind_when.ts:32-35`                                             |
| [`memory_consolidate`](../guides/MCP_TOOLS.md#memory_consolidate)             | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/consolidate.ts:19`                                                |
| [`memory_task`](../guides/MCP_TOOLS.md#memory_task)                           | Extended | Agent-judgment        | 7 (`create`\|`get`\|`list`\|`patch`\|`archive`\|`delegate`\|`complete`)                                                                                                      | Secondary atomization candidate (action-count outlier) — see [Candidates](#2-atomization-shipped-precedent-memory_update--memory_self_edit)                                                 | `tools/task.ts:26-28`                                                    |
| [`memory_event`](../guides/MCP_TOOLS.md#memory_event)                         | Extended | Agent-judgment        | 6 (`create`\|`get`\|`list`\|`archive`\|`annotate`\|`sensitivity`)                                                                                                            | Multiplexed — action-count outlier, not a named candidate here                                                                                                                              | `tools/event.ts:16-23`                                                   |
| [`memory_reasoning`](../guides/MCP_TOOLS.md#memory_reasoning)                 | Extended | Agent-judgment        | 8 (`create`\|`get`\|`list`\|`patch`\|`archive`\|`resolve`\|`record`\|`feedback`)                                                                                             | Multiplexed — action-count outlier, not a named candidate here                                                                                                                              | `tools/reasoning.ts:21`                                                  |
| [`memory_strategy`](../guides/MCP_TOOLS.md#memory_strategy)                   | Extended | Agent-judgment        | 8 `op` values (`create`\|`get`\|`list`\|`patch`\|`archive`\|`store`\|`recall`\|`rate`; `store`/`recall` are documented aliases of `create`/`list`, so 6 distinct operations) | Multiplexed — action-count outlier, not a named candidate here                                                                                                                              | `tools/strategy.ts:20-22`                                                |
| [`memory_hyperedge`](../guides/MCP_TOOLS.md#memory_hyperedge)                 | Extended | Agent-judgment        | 5 (`create`\|`get`\|`list`\|`patch`\|`archive`)                                                                                                                              | —                                                                                                                                                                                           | `tools/hyperedge.ts:13`                                                  |
| [`memory_introspect`](../guides/MCP_TOOLS.md#memory_introspect)               | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/introspect.ts:6`                                                  |
| [`memory_anticipate`](../guides/MCP_TOOLS.md#memory_anticipate)               | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/anticipate.ts:6`                                                  |
| [`memory_compose`](../guides/MCP_TOOLS.md#memory_compose)                     | Extended | Agent-judgment        | 5 (`list`\|`create`\|`get`\|`patch`\|`dry_run`)                                                                                                                              | —                                                                                                                                                                                           | `tools/compose.ts:20-27`                                                 |
| [`memory_workflow`](../guides/MCP_TOOLS.md#memory_workflow)                   | Extended | Agent-judgment        | 3 (`create`\|`get`\|`list`)                                                                                                                                                  | —                                                                                                                                                                                           | `tools/workflow.ts:24`                                                   |
| [`memory_skill`](../guides/MCP_TOOLS.md#memory_skill)                         | Extended | Agent-judgment        | 4 (`create`\|`get`\|`list`\|`forget`)                                                                                                                                        | —                                                                                                                                                                                           | `tools/skill.ts:53`                                                      |
| [`memory_update`](../guides/MCP_TOOLS.md#memory_update)                       | Extended | Agent-judgment        | 1 (thin wrapper)                                                                                                                                                             | Atomization precedent (shipped) — see [Candidates](#2-atomization-shipped-precedent-memory_update--memory_self_edit)                                                                        | `tools/update.ts:5-16` (docstring), `:44` (delegates `action:"replace"`) |
| [`memory_compare`](../guides/MCP_TOOLS.md#memory_compare)                     | Extended | Agent-judgment        | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/compare.ts:32`                                                    |
| [`memory_doctor`](../guides/MCP_TOOLS.md#memory_doctor)                       | Extended | Rare-admin/diagnostic | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/doctor.ts:69`                                                     |
| [`memory_judge`](../guides/MCP_TOOLS.md#memory_judge)                         | Extended | Rare-admin/diagnostic | 2 (`list`\|`resolve`)                                                                                                                                                        | —                                                                                                                                                                                           | `tools/judge.ts:75-79`                                                   |
| [`memory_stats`](../guides/MCP_TOOLS.md#memory_stats)                         | Extended | Rare-admin/diagnostic | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/stats.ts:47`                                                      |
| [`memory_purge`](../guides/MCP_TOOLS.md#memory_purge)                         | Extended | Rare-admin/diagnostic | 2 (`fact`\|`closed`)                                                                                                                                                         | —                                                                                                                                                                                           | `tools/purge.ts:48-52`                                                   |
| [`memory_context`](../guides/MCP_TOOLS.md#memory_context)                     | Extended | Rare-admin/diagnostic | 1                                                                                                                                                                            | Weak signal — tier/purpose mismatch, listed not asserted — see [Candidates](#3-weak-signal-listed-not-asserted-memory_context-tierpurpose-mismatch)                                         | `tools/context.ts:5-35` (docstring), `:37` (`registerTool`)              |
| [`memory_workspace`](../guides/MCP_TOOLS.md#memory_workspace)                 | Extended | Rare-admin/diagnostic | 8 (`list`\|`describe`\|`members`\|`current`\|`create`\|`invite`\|`set_role`\|`remove`)                                                                                       | Secondary atomization candidate (action-count outlier) — see [Candidates](#2-atomization-shipped-precedent-memory_update--memory_self_edit)                                                 | `tools/workspace.ts:5-9` (docstring), `:38-45` (enum)                    |
| [`memory_session`](../guides/MCP_TOOLS.md#memory_session)                     | Extended | Rare-admin/diagnostic | 10 (`start`\|`turn`\|`pin_turn`\|`pin`\|`scratch`\|`collapse`\|`discard`\|`feedback`\|`get`\|`list`)                                                                         | Fusion (leading signal) — duplicates `memory_pin`/`memory_episode_start`/`memory_episode_end` — see [Candidates](#1-fusion-leading-signal-session-vs-pinepisode_startepisode_end)           | `tools/session.ts:5-19` (docstring), `:60-72` (enum)                     |
| [`memory_self_edit`](../guides/MCP_TOOLS.md#memory_self_edit)                 | Extended | Rare-admin/diagnostic | 6 (`append`\|`replace`\|`strengthen`\|`weaken`\|`reflect`\|`link`)                                                                                                           | Secondary atomization candidate (action-count outlier; already partially atomized via `memory_update`) — see [Candidates](#2-atomization-shipped-precedent-memory_update--memory_self_edit) | `tools/self_edit.ts:28`                                                  |
| [`memory_suggest_topic_key`](../guides/MCP_TOOLS.md#memory_suggest_topic_key) | Extended | Rare-admin/diagnostic | 1                                                                                                                                                                            | —                                                                                                                                                                                           | `tools/suggest_topic_key.ts:24`                                          |

Row count: 35 (Core 6 + Extended/agent-judgment 20 + Extended/rare-admin/diagnostic 9), matching
`packages/mcp/src/tools/*.ts` (36 files minus `errors.ts`) and `SKILL.md`'s Core/Extended split
(6 + 29).

Per-tool use-case prose and edge cases ("Cuándo usarla" / "Casos borde y gotchas") live in
[`docs/guides/MCP_TOOLS.md`](../guides/MCP_TOOLS.md) — linked per row above, not repeated
here. Protocol trigger rules (when an agent is expected to call a Core tool autonomously) live in
[`SKILL.md`](../../packages/plugin/skills/memory/SKILL.md).

## Candidates

Every candidate below is **not yet decided** — it needs its own SDD change, per
`flatten-legacy-dual-core` Priority decision #2's constraints (genuine improvement, documented,
all consumers migrated in the same change). This document names the signal and evidence only.

### 1. Fusion (leading signal): `session` vs. `pin`/`episode_start`/`episode_end`

`packages/mcp/src/tools/session.ts:5-19`'s own docstring states the original spec wanted a
single unified tool with `action: pin | scratch | collapse | discard`, but the prior API split
that surface across `memory_pin`, `memory_episode_start`, and `memory_episode_end`. `memory_session`
was added **additively** on top to restore the unified 10-action contract
(`start, turn, pin_turn, pin, scratch, collapse, discard, feedback, get, list`) — "the legacy
tools keep working unchanged" (`session.ts:13`).

Result: `pin`, `collapse`, and `discard` are each reachable through **two different tool names**
today:

| Operation                                          | Core-tier surface                                           | Extended-tier surface              |
| -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| Pin a fact                                         | `memory_pin`                                                | `memory_session action='pin'`      |
| Close a session, collapse buffer to durable memory | `memory_episode_end`                                        | `memory_session action='collapse'` |
| Discard a session without collapsing               | `memory_episode_end`-adjacent (no direct legacy equivalent) | `memory_session action='discard'`  |
| Open a session                                     | `memory_episode_start`                                      | `memory_session action='start'`    |

This is the strongest signal in the codebase: two tool names reach the same operations, one in
the mandatory Core tier (loaded on every session, no ToolSearch) and one in the rarely-loaded
Extended tier. **This document does not recommend which surface to keep** — that is a genuine
product decision requiring its own change (e.g., deprecate the split tools in favor of
`memory_session`, or keep both and document the intentional overlap, or something else).

### 2. Atomization (shipped precedent): `memory_update` ← `memory_self_edit`

`packages/mcp/src/tools/update.ts:5-16` documents that `memory_update` is intentionally a thin
wrapper: it delegates to `client.selfEdit({action: "replace", ...})` (`update.ts:44`), a
single-purpose tool split out of the 6-action `memory_self_edit` (`append`, `replace`,
`strengthen`, `weaken`, `reflect`, `link` — `self_edit.ts:28`) because "correct this fact" was
common enough to deserve its own low-friction surface. This is a real, already-shipped example of
the atomization pattern — not a hypothesis.

Secondary candidates, listed **by action count only** (no token-savings ranking, no usage
evidence):

| Tool               | Actions                                                                                | Evidence             |
| ------------------ | -------------------------------------------------------------------------------------- | -------------------- |
| `memory_workspace` | 8 (`list`, `describe`, `members`, `current`, `create`, `invite`, `set_role`, `remove`) | `workspace.ts:38-45` |
| `memory_task`      | 7 (`create`, `get`, `list`, `patch`, `archive`, `delegate`, `complete`)                | `task.ts:26-28`      |
| `memory_self_edit` | 6 (`append`, `replace`, `strengthen`, `weaken`, `reflect`, `link`)                     | `self_edit.ts:28`    |

Whether any of these should be split further (e.g. a `memory_delegate` analogous to
`memory_update`) is unevaluated here — the action count alone does not establish usage skew
toward one or two actions without call telemetry.

### 3. Weak signal, listed not asserted: `memory_context` tier/purpose mismatch

`memory_context` is classified Extended/rare-admin-or-diagnostic in `SKILL.md` (loaded only via
ToolSearch), yet its own docstring (`context.ts:8-17`) and `MCP_TOOLS.md` describe it as the
tool an agent should call "before a sensitive write" to check its workspace role — a
protocol-adjacent orientation check, not a rare admin/diagnostic action. This is weaker than
signal #1: it is a tier-placement observation, not a demonstrated duplication or a shipped
atomization precedent, and it is listed here for completeness rather than asserted as an
actionable candidate.

## Closing note: telemetry prerequisite

None of the candidates above should be acted on — split, merged, or deprecated — without real
usage evidence. This catalog is built from designed intent (docstrings, protocol trigger rules,
and action-count structure), not from measured call frequency, because **no per-tool-name usage
telemetry exists in this codebase today** (confirmed absent, see the header). Before a future
change executes any fusion or atomization decision above, adding a lightweight per-tool-name call
counter (e.g., analogous to `tokensSavedByMechanism` in `packages/server/src/metrics.ts`) would
let that change confirm which surface real clients actually use, rather than deciding on
inference alone. That telemetry addition is out of scope for this document and is recorded here
only as a prerequisite for the change that eventually acts on these candidates.
