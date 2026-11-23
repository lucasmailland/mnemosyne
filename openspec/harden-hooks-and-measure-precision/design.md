# Design: Slice 4 — Precision-at-k report (Requirements 5, 6)

## Status

Implemented. The join this report needs **does exist** end-to-end through already-persisted
data. No hard-stop was hit; no new write path, port write method, or schema migration was
added.

## 4.1 — Data mapping (end to end)

Verified against HEAD in this worktree.

### What gets written today

1. **`recordRecall`** (`packages/core/src/cognitive/recall-cold.ts:969-988`) — for every served
   fact hit, inserts one row into `mnemo_recall_log`:
   `workspaceId, factId, sessionId, queryText, hitRank, tdCredit = 0.7^hitRank, activationScore,
latencyMs`. `recalledAt` defaults to `now()` at insert time (`RecallRepository.recordRecall`,
   `packages/adapter-postgres/src/repositories/RecallRepository.ts:196-221`). This is the
   **exposure** signal: "this hit was served, at this rank, in this session."

2. **Collapse Step 7.6** (`packages/core/src/session/collapse.ts:612-690`) — gated by
   `if (createdFactIds.length > 0 && input.learningMode !== true && ...)`:
   - Persists `factCount = createdFactIds.length` on the session row unconditionally at Step 7b
     (`updateSessionSummary`, `packages/adapter-postgres/src/repositories/SessionRepository.ts:342-360`
     — writes into `mnemo_session.fact_count`, **not** gated by `learningMode`).
   - For each created fact, calls `propagateTdCredit(ctx, workspaceId, sessionId, id, delta)`
     (`packages/core/src/cognitive/worth.ts:85-113`), which:
     - Calls `getTdPredecessors(workspaceId, sessionId, excludeFactId)`
       (`RecallRepository.ts:223-253`) — `SELECT fact_id, td_credit, recalled_at FROM
mnemo_recall_log WHERE workspace_id = ? AND session_id = ? AND fact_id != ?
ORDER BY recalled_at DESC LIMIT 20`. This is the **only** query in the whole system that
       reads `mnemo_recall_log` back out for TD purposes, and it caps at the 20
       most-recently-recalled facts in the session.
     - For every predecessor returned (`tdCredit > 0`, true for any real rank), calls
       `ctx.storage.updateWorth(predecessorFactId, workspaceId, "fact", {..., creditWeight:
delta.creditWeight * p.tdCredit * timeDecay})` — this **mutates the fact's aggregate
       `worth_alpha`/`worth_beta`**. It does **not** write anything back onto the
       `mnemo_recall_log` row that was read. There is no per-hit "credited" flag anywhere.
   - Step 8 (`closeSession`, `SessionRepository.ts:163-186`) sets `status = 'collapsed'` and
     `collapsed_at = now()` on the session row **unconditionally**, whether or not any fact was
     created — this is the reliable "did this session resolve" signal.

3. **`POST /session/:id/feedback`** (`packages/server/src/routes/session.ts:497-548`) — thumbs
   up/down. Reads `getRecalledFactIds(workspaceId, sessionId)` (all facts ever recalled in the
   session, no rank/window limit) and calls `updateWorth` on every one of them with a delta
   derived from the rating. **This mutates fact worth directly and persists nothing else** — no
   session-level "this session was rated" column is ever written. `mnemo_session.outcome_rating`
   exists in the Drizzle schema (`packages/adapter-postgres/src/schema/sessions.ts:32`) but is
   **never written anywhere in the codebase** (verified: zero write sites; two read sites —
   `MeteringRepository.ts`, `PluginRepository.ts` — both filter `WHERE outcome_rating IS NOT
NULL`, which is therefore always false today). It is dead schema, not a usable signal.

4. **Collapse's own outcome classification** (`summary.outcome`, e.g. `"resolved"`) is persisted,
   but folded into `mnemo_session.context_snapshot` (jsonb) via `updateSessionSummary`
   (`SessionRepository.ts:342-360`), not into a queryable top-level column, and it is an
   LLM/heuristic classification of the conversation, not literal user feedback.

### What this means for the join

| Question                                                                                                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can we tell which `mnemo_recall_log` rows belong to a session that collapsed?                                                 | **Yes** — join on `session_id`, filter `mnemo_session.collapsed_at IS NOT NULL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Can we tell whether that session's collapse actually created a fact (the precondition for `propagateTdCredit` to run at all)? | **Yes** — `mnemo_session.fact_count > 0`, set unconditionally at Step 7b regardless of `learningMode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Can we tell whether a _specific_ recall_log row was inside the 20-most-recent window `getTdPredecessors` actually reads?      | **Yes** — re-derive with `ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY recalled_at DESC)`, the exact ordering and cap `getTdPredecessors` applies.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Can we tell whether `updateWorth` was actually invoked for that row (the real credit event)?                                  | **No, not with certainty.** `updateWorth` mutates only the fact's aggregate `worth_alpha`/`worth_beta` — it never writes a per-recall-event marker. Re-deriving "would `getTdPredecessors` have returned this row" is the closest available proxy, and it is _deterministic given the same inputs_, but it cannot see `input.learningMode` (RDD-5 cold-start gate), which is not persisted per-session anywhere queryable after the fact. `fact_count > 0` can therefore be true on a session where the propagation call was actually skipped by the `learningMode` guard. |
| Can we tell whether a session received explicit thumbs feedback?                                                              | **No.** The feedback route mutates fact worth immediately and persists no session-level record of the rating. `outcome_rating` is dead schema.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Can we tell a session's LLM-classified outcome (resolved/abandoned/etc.)?                                                     | **Yes**, via `context_snapshot->>'outcome'`, but this is a classification, not literal explicit feedback, and it does not gate `propagateTdCredit` (which uses `summary.outcome` earlier, as one heuristic-weighted input among several — not a hard gate).                                                                                                                                                                                                                                                                                                                |

**Conclusion: the join exists.** `mnemo_recall_log` (`session_id`, `hit_rank`, `recalled_at`) →
`mnemo_session` (`collapsed_at`, `fact_count`) is a real, keyed, already-persisted join that
faithfully reconstructs — with one documented imprecision (`learningMode` invisibility) — exactly
which hits the production TD(λ) propagation code would have touched. This is why Slice 4 shipped
instead of stopping: the data to compute a _defensible, honestly-scoped_ precision-at-k already
exists, and Requirement 6 explicitly permits (requires) documenting where the proxy is coarse
rather than blocking on perfect per-hit attribution (which is D5's job, out of scope here).

## 4.2 — Precision-at-k, precisely defined

### "Hit"

One row in `mnemo_recall_log` with a non-null `session_id` and non-null `hit_rank`. Rows with no
`session_id` (recalls outside any session) are excluded entirely — credit is defined
per-session, so a session-less recall can be neither credited nor pending; it simply isn't in
this report's domain.

### "Credited"

A hit is **credited** iff **all** of:

1. Its session collapsed: `mnemo_session.collapsed_at IS NOT NULL`.
2. That collapse created at least one fact: `mnemo_session.fact_count > 0` — the exact
   precondition collapse checks (`collapse.ts:622`) before calling `propagateTdCredit` at all.
3. The hit is within the 20-most-recently-recalled window for its session:
   `ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY recalled_at DESC) <= 20` — the exact
   `LIMIT 20` `getTdPredecessors` applies.

This is a **binary, coarse** signal — "was this hit in the blast radius of a credit-propagation
call" — not "did this specific hit demonstrably shape the created fact." Sign of the delta
(positive vs. negative worth movement) is deliberately not modeled: `propagateTdCredit`'s delta
always carries both a `success` and `failure` component (from `computeOutcome`'s blended score),
so a binary credited/not-credited split is the only thing derivable without re-running the
heuristic outcome classifier — and Requirement 6 asks for a coarse proxy, not a reconstruction of
`computeOutcome`.

**Known imprecision (documented, not correctable without a new write):** `fact_count > 0` can be
true on a session where `propagateTdCredit` was actually skipped by the `learningMode` cold-start
guard (`collapse.ts:622`, `input.learningMode !== true`), because `factCount` is persisted
unconditionally at Step 7b while the propagation call is gated separately, and `learningMode`'s
value at collapse time is not persisted anywhere queryable per-session. This means precision-at-k
can **overcount** credit for workspaces that were in learning mode during part of their history.
This is exactly the kind of gap Requirement 6 asks to be surfaced rather than hidden — see
`methodologyNote` in the response, and `RECALL_PRECISION_METHODOLOGY_NOTE` in
`packages/types/src/ports.ts`.

### Sessions that never collapsed

**Decision: excluded from the denominator, not counted as failures.**

A session that never collapsed (still active, abandoned mid-conversation, or genuinely still in
progress) has not yet produced an answer to "did the hits it served turn out to be useful" — the
mechanism that would answer that question (collapse's TD propagation) simply never ran. Counting
these as failures would silently conflate "this hit was retrieved and later judged unhelpful"
with "the conversation is still ongoing, or ended without ever reaching collapse" — two
completely different things that the data cannot distinguish from a failure. That conflation
would make the reported precision _systematically pessimistic_ in exactly the workspaces most
worth measuring (active, high-volume ones with many in-flight sessions at query time), and it
would move the number for reasons that have nothing to do with recall quality.

Excluded hits are not silently dropped from the report, though — `pendingHits` (and `totalHits`
for context) are always returned alongside `precisionAtK`, so an operator can see how much of the
log is still unresolved rather than assuming the denominator is the whole log.

### Formula

For each `k ∈ {1, 3, 5}`:

```
sampleSize(k) = count of hits where hitRank < k AND session collapsed
credited(k)   = count of hits where hitRank < k AND session collapsed AND credited (per above)
precision(k)  = credited(k) / sampleSize(k)   if sampleSize(k) > 0
              = null                           otherwise (insufficient data — never a fabricated 0 or 1)
```

`insufficientData` (report-level) is `true` iff every `sampleSize(k) == 0` — i.e., the workspace
has no recall history with a resolved session at any of the three k values.

## 4.3/4.4 — Implementation

- **New read-only port method**: `RecallPort.getRecallPrecision(workspaceId): Promise<RecallPrecisionReport>`
  (`packages/types/src/ports.ts`). No write method was added or changed.
- **Adapter-postgres**: `RecallRepository.getRecallPrecision` — a single aggregate SQL query
  (`COUNT(*) FILTER (...)` per k, computed inside a subquery that derives `collapsed_flag` /
  `credited_flag` per hit via the join above), wrapped in the same `this.db.transaction(...) +
SELECT mnemo_set_workspace(...)` pattern every other method in this file already uses for RLS
  scoping (this is the adapter-postgres repository-layer equivalent of `withMnemoTx` — the actual
  `withMnemoTx` helper lives one layer up in `@mnemo-ai/core` and is not used directly inside
  adapter repositories, which instead set the workspace GUC per-transaction; every sibling method
  in `RecallRepository.ts` follows this same convention). No migration; reads only
  `mnemo_recall_log` and `mnemo_session`, both pre-existing tables.
- **In-memory adapter**: `packages/types/src/testing/in-memory/recall.ts`'s
  `getRecallPrecision` mirrors the SQL definition exactly, using array push-order as the recency
  ordering (`RecallLogEntry` carries no `recalledAt` field in-memory; `state.recallLog` is
  push-appended chronologically, so array position is equivalent to `ORDER BY recalled_at`).
- **Surface**: extended `GET /admin/stats`'s existing `recall` object
  (`packages/server/src/routes/admin-stats.ts`) with `precisionAtK`, `precisionTotalHits`,
  `precisionPendingHits`, `precisionInsufficientData`, `precisionMethodologyNote`. Chosen over
  `memory_doctor` because `/admin/stats` already aggregates workspace-scoped, live-computed
  metrics from multiple ports in one call (`getWorkspaceVitals`, `getHealthSnapshot`) — this is
  the same shape of thing, and it keeps the "don't add tools/routes" rule intact (no new route,
  no new MCP tool). The precision read is best-effort: if it throws, the route falls back to an
  explicit insufficient-data shape (never a fabricated number) rather than failing the whole
  `/admin/stats` call, matching Requirement 4's degradation discipline (unavailability
  distinguishable from emptiness) even though Requirement 4 itself only targets the hooks.

## 4.5 — Sample size and insufficient-data

Every `RecallPrecisionAtK` entry carries its own `sampleSize`. The report also carries
`totalHits` and `pendingHits` for overall context. `insufficientData` is `true` whenever every k
has `sampleSize === 0` (empty workspace, or a workspace whose sessions never collapsed) — the
route never returns a fabricated `0` or `1` in that case; `precision` is `null` per-k instead.

## Out of scope, confirmed not touched

- No `createCitation`, no write to `mnemo_citation`, no attribution wiring (D5).
- No schema migration — both tables read here (`mnemo_recall_log`, `mnemo_session`) already
  exist with the exact columns used.
- No new MCP tool, no new HTTP route — extended the existing `GET /admin/stats`.
- `packages/core/src/cognitive/` untouched — this entire change lives in `packages/types`
  (port + in-memory), `packages/adapter-postgres` (repository), and `packages/server`
  (route), preserving the hexagonal purity guard.
