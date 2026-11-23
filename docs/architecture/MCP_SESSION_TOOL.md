# MCP Session Tool — Design Analysis

> **Status:** ✅ IMPLEMENTED AND RECONCILED (v3.3)
>
> **Context:** This document fulfills remediation task API-9 (LOW priority) — documenting the session tool design and analyzing the spec/implementation relationship.

---

## Overview

The spec (§24 of `docs/research/MEMORY_MODEL.md`) prescribed a **single unified `memory_session` tool** with four actions: `pin`, `scratch`, `collapse`, and `discard`.

Early v3 implementation **deliberately split** this into three focused tools:

- `memory_pin` (fact pinning)
- `memory_episode_start` (session creation)
- `memory_episode_end` (session collapse)

As of **v3.3**, the implementation has **reconciled with the spec**: the unified `memory_session` tool now exists alongside the focused tools, giving agents both the spec-mandated unified interface and the focused ergonomic alternatives.

---

## Current Implementation

### 1. Unified Tool: `memory_session`

**File:** `packages/mcp/src/tools/session.ts`
**Registered:** Yes (`packages/mcp/src/index.ts:161`)
**Status:** ✅ Fully functional (all 4 actions wired)

#### Action Dispatch Table

| Action     | Transport                    | Server Route            | Client Method                             | Status  |
| ---------- | ---------------------------- | ----------------------- | ----------------------------------------- | ------- |
| `pin`      | `POST /facts/:id/pin`        | `routes/facts.ts`       | `client.pinFact()` / `client.unpinFact()` | ✅ Live |
| `collapse` | `POST /session/:id/collapse` | `routes/session.ts:233` | `client.collapseSession()`                | ✅ Live |
| `scratch`  | `POST /session/:id/scratch`  | `routes/session.ts:430` | `client.updateSessionScratch()`           | ✅ Live |
| `discard`  | `POST /session/:id/discard`  | `routes/session.ts:472` | `client.discardSession()`                 | ✅ Live |

**Implementation notes:**

- The MCP tool is a **thin adapter** — it validates inputs and dispatches to the appropriate client method
- `scratch` maps `content` to `note`, merges MCP `metadata`, then exactly replaces the session scratch object
- Scratch replacement/read is PostgreSQL-authoritative and workspace-scoped through `withMnemoTx`
- No scratch value is read from or written to Redis; only legacy-key deletion and activity tracking are best-effort after success
- Exact scratch requests bypass Redis health and Redis-backed idempotency; absent and RLS-hidden sessions both return 404
- `discard` archives the session without triggering the extraction pipeline (§7 anti-pattern fix F7)
- `pin` operates on **facts**, not sessions (factId required, sessionId not used)

### 2. Focused Tools (Legacy/Ergonomic Aliases)

These **continue to exist** for backward compatibility and ergonomic clarity:

| Tool                   | Maps to `memory_session` action | Purpose                                          |
| ---------------------- | ------------------------------- | ------------------------------------------------ |
| `memory_pin`           | `action: "pin"`                 | Pin/unpin a fact to protect from pruning         |
| `memory_episode_start` | (no equivalent)                 | Open a new session, returns sessionId            |
| `memory_episode_end`   | `action: "collapse"`            | Close and collapse a session into durable memory |

**Design rationale for keeping both:**

1. **Spec compliance:** `memory_session` matches the prescribed §24 interface
2. **LLM clarity:** Focused tools have clearer names for single-purpose operations
3. **Session lifecycle:** `memory_episode_start` has no `memory_session` equivalent (the unified tool only controls existing sessions)
4. **Zero breaking change:** Existing agent prompts continue to work

---

## What Operations Does It Handle?

### Pin (Fact Protection)

**Input:**

```json
{
  "action": "pin",
  "factId": "fct_01hwz...",
  "unpin": false // optional, true to unpin
}
```

**Effect:**

- Sets `pinned: true` on the fact row
- Protects the fact from worth-based pruning and consolidation merging
- Boosts the fact's activation score in recall

**Use case:** Mark a critical decision or preference that should never decay.

### Scratch (Durable Session Working State)

**Input:**

```json
{
  "action": "scratch",
  "sessionId": "ses_01hwz...",
  "content": "User mentioned they prefer TypeScript strict mode",
  "role": "assistant", // optional: user | assistant | system
  "metadata": { "confidence": 0.9 } // optional
}
```

**Effect:**

- Exactly replaces `mnemo_session.scratch`; omitted prior fields are removed and `{}` clears it
- Runs inside the authenticated workspace's `withMnemoTx` boundary
- Is not persisted as a fact; it remains session state in PostgreSQL JSONB
- Never reads from or writes to a Redis scratch cache
- Returns the same 404 shape for missing and cross-workspace/RLS-hidden sessions
- Available to the extraction pipeline when the session is collapsed
- Remains available when Redis health or Redis-backed idempotency is unavailable

**Use case:** Track interim thoughts during a session without committing to permanent memory.

### Collapse (Session Extraction)

**Input:**

```json
{
  "action": "collapse",
  "sessionId": "ses_01hwz...",
  "collapseHint": "Extract architectural decisions and bug fixes" // optional
}
```

**Effect:**

- Closes the session (`status: "completed"`)
- Runs the 8-step extraction pipeline (`packages/core/src/session/collapse.ts`)
- Extracts durable facts/decisions/strategies from the session transcript
- LLM pass triggered if:
  - `collapseHint` is provided (forces explicit extraction)
  - Session has ≥3 turns OR ≥2 scratch notes with recurrence markers (heuristic gate)

**Use case:** End a coding session and consolidate learnings into permanent memory.

### Discard (Abandon Without Extraction)

**Input:**

```json
{
  "action": "discard",
  "sessionId": "ses_01hwz..."
}
```

**Effect:**

- Archives the session (`status: "archived"`) WITHOUT running extraction
- Clears the Redis ephemeral buffer
- No facts are persisted
- Anti-pattern fix (F7): previous impl mistakenly called `collapseSession` on discard

**Use case:** Abort a failed or irrelevant session without polluting memory.

---

## Should It Be Split?

**Answer:** It already is split (in the sense that focused tools coexist with the unified tool), and this is the **correct final state**.

### Tradeoffs Analysis

#### Option A: Unified Tool Only (Spec-Literal)

**Pros:**

- Matches spec §24 exactly
- Single entry point for all session control

**Cons:**

- Overloaded interface: `pin` requires `factId`, others require `sessionId` (different entities)
- Less discoverable for LLMs (single tool name doesn't hint at purpose)
- No session creation (start) operation in the unified interface

#### Option B: Focused Tools Only (v3.0 Approach)

**Pros:**

- Clear single-responsibility tools (`memory_pin`, `memory_episode_start`, `memory_episode_end`)
- Excellent LLM discoverability

**Cons:**

- Spec non-compliance (§24 mandate not met)
- `scratch` and `discard` were unreachable via MCP

#### Option C: Both Unified and Focused (Current v3.3 Implementation) ✅

**Pros:**

- Spec compliance via `memory_session`
- Ergonomic focused tools for common operations
- Full coverage: all 4 actions + session creation
- Backward compatibility with existing agent prompts
- LLMs can choose based on preference (explicit vs. unified)

**Cons:**

- Two ways to do the same thing (minor documentation burden)

**Verdict:** Option C is optimal. The unified tool satisfies the spec contract; the focused tools serve as ergonomic aliases for common patterns.

---

## Recommendation

**No code changes required.** The implementation is complete and correct.

**Documentation updates required:**

1. ✅ **This architecture doc** — captures the design rationale
2. ✅ **`packages/mcp/README.md`** — Updated to reflect all 4 actions are now live
3. ✅ **`docs/research/MEMORY_MODEL.md:2357-2362`** — Updated implementation note to mention v3.3 unified tool

---

## Conclusion

The `memory_session` split was **intentional and well-reasoned** in v3.0 (clearer LLM affordances), but the implementation has since **reconciled with the spec** by adding the unified tool in v3.3.

**Current state:** Both the unified tool and focused tools coexist, giving agents flexibility. All 4 spec-mandated actions are live.

**No implementation work required.** Documentation has been updated to reflect the current wired state.

---

**Document History:**

- 2026-07-16: Reconciled scratch with B6.34 exact PostgreSQL replacement, RLS, anti-probing, and Redis-independent behavior
- 2026-07-05: Initial draft (remediation task API-9)
- Status: Complete (analysis + recommendation finalized)
