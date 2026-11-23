# Conflict Resolution — Write-Time vs. Consolidation-Time

> Verified against source 2026-08-05; sections 1 and 3 updated 2026-10-18
> (WP-7 of the 2026-10-17 evaluation). Written after comparing Mnemosyne's
> conflict-handling machinery against Engram's `mem_save` → `FindCandidates`
> → `mem_judge` pattern.

## Current state

Mnemosyne has **three** independent conflict-detection mechanisms today, plus
one that was built and never wired in. Section 1 is the only one that answers
in the `memory_remember` response itself, and only for a classified
contradiction.

### 1. Write-time: classified candidates in `remember()` (facts only)

**Opt-in.** This path costs up to 3 LLM calls on every fact write, so it runs
only with `MNEMO_WRITE_CONFLICT_CLASSIFICATION=true`
(`CoreConfig.writeConflictClassification`). Off, the default, `remember()`
looks up no candidates, calls no model and defers nothing: `conflict` never
appears at write time, paraphrases are not folded, and contradictions with a
close neighbour (≥ 0.85) surface later through the scoped check (section 3).

With the flag on, every `remember()` call for a fact that does not merge by `topicKey` or repeat
an exact statement (content hash) runs, **before** inserting
(`packages/core/src/cognitive/remember.ts`, `screenFactCandidates`):

1. `ctx.storage.findContradictingFacts()` returns the 3 closest active facts:
   cosine ≥ 0.55 for rows with a usable vector (P130), the lexical predicate
   (`subject = $1 OR fts`) for rows without one. The subject clause only fires
   for a specific subject — never for the default `general` or an empty one
   (PRIM-5) — and a zero vector (NaN cosine) is never a candidate.
2. Each candidate goes through `classifyFactPair`
   (`packages/core/src/cognitive/fact-pair-classifier.ts`, shared with the
   consolidation package) on `ctx.llm`, in parallel, under an 8 s deadline
   (`ResolvedConfig.conflictClassificationTimeoutMs`). Similarity alone never
   makes a conflict: with bge-m3 two sentences about the same project clear
   0.55 whether they agree or not.
3. Verdicts:
   - **CONTRADICTION** → after the insert, a pending `conflicts_with` relation
     (new fact → existing fact, `evidence.detectedBy: "section33_resolver"`,
     `classification: "CONTRADICTION"`), then a `contradiction` review item
     carrying the relation id. The response carries
     `conflict: { judgmentRequired: true, candidates }`, one candidate per
     relation. The pure §33 resolver (`decideAutoResolution`) still runs and
     its `supersede | reject | review` verdict rides on the candidate as a
     recommendation; nothing is archived automatically (P108).
   - **DUPLICATE** → the write reuses the existing fact instead of inserting
     (LIFECYCLE-11), only when the cosine is ≥ 0.85 and scope, scopeRef,
     owner, sensitivity and (unless the write's subject is generic) subject
     all match, the tier is below `confidential` (those rows are stored
     encrypted), and no `topicKey` was sent. The response returns the existing
     id and its statement as `storedContent`. No content-hash alias is written
     for the new wording, so a repeat of it is screened again.
   - **COMPATIBLE** → nothing.
   - **No verdict** (no `ctx.llm`, an error, an unreadable reply, the
     deadline; the flag must be on) → nothing at write time and no `conflict` field. The failure is
     logged and the pair is handed to the scoped check (section 3). After an
     error or a timeout the classifier is skipped for 60 s, so an outage does
     not make every write wait for the deadline.

`conflict` is absent unless a contradiction was classified. A classifier
failure is never treated as COMPATIBLE: `classifyFactPair` rejects with
`FactPairClassificationError` (LIFECYCLE-14).

Decisions and strategies do not go through this path. An exact repeat of an
active decision or strategy (same kind/title/body or trigger/action, owner,
scopeRef and sensitivity) returns the existing record instead of a second row
(PRIM-18).

### 2. Consolidation-time: LLM contradiction detection → `conflicts_with` (enabled by default as of `enable-deep-mode-consolidation`)

The background deep-consolidation scheduler
(`packages/consolidation/src/scheduler.ts`) clusters facts and runs
`SemanticClassifier` (LLM) to label pairs DUPLICATE / CONTRADICTION /
COMPATIBLE. CONTRADICTION creates a `conflicts_with` relation
(`scheduler.ts:646-669`). `memory_judge action=list`
(`packages/server/src/routes/conflicts.ts`) surfaces exactly these rows for
interactive resolution (`supersede_a/supersede_b/keep_both/merge`).

**Update (2026-08-05, `enable-deep-mode-consolidation`): this path now runs
in production by default.** `packages/server/src/boot/consolidation.ts` sets
`schedulerCtx.mode` from the `MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED` env var:
unset or any value other than the literal string `"false"` resolves to
`mode: "deep"`; only an explicit `MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED=false`
reverts the scheduler to `mode: "fast"` (cosine-only, no LLM classification,
matching the pre-2026-08-05 default). The resolved mode is logged on every
boot via `logger.info({ mode }, "consolidation.scheduler_started")`, so
`mode: "fast"` vs `mode: "deep"` is directly observable in server logs
without inspecting env vars.

Two production-safety properties were added alongside default-enablement so
enabling deep mode does not mean unbounded LLM spend:

- **Pair-level memoization.** Before classifying an absorbed fact against its
  cluster survivor, the scheduler loads existing `conflicts_with` /
  `not_conflict` relations between the exact pair (`loadLinkedFactIds`,
  `packages/consolidation/src/relation-memo.ts` — a two-direction
  `getRelations` lookup shared with the write-time scoped check in section 3).
  A memo hit skips the LLM call entirely; a pair is classified at most once,
  ever, regardless of how many later scheduler ticks re-form the same cluster.
- **COMPATIBLE verdicts are now durably recorded.** A first-time COMPATIBLE
  classification creates a **new** `not_conflict` relation
  (`metadata: { detectedBy: "semantic_classifier", consolidationMode: "deep" }`),
  symmetric to the existing CONTRADICTION → `conflicts_with` write. This is a
  **new, permanent, non-invalidated side effect**: `not_conflict` rows are
  never expired, TTL'd, or revisited by a later tick — like `conflicts_with`
  rows, they persist for the life of the two facts they link (or until an
  operator manually removes them) and exist purely to make the memoization
  above effective. A `classifyFactPair` throw is excluded from the merge (no
  write, no silent fallthrough — see the failure-safe-default fix below) and
  a `getRelations` memo-load throw skips the whole cluster for that tick
  (`skippedPairs++`), so a DB hiccup degrades to "classify less this tick",
  never to a corrupted memo state.

Also fixed alongside default-enablement: the classification `catch` block
previously logged "(treating as DUPLICATE)" and let the fact fall through
into the merge unfiltered — a thrown classification silently behaved as if
it had returned DUPLICATE. It now excludes the fact from the merge set
entirely and logs "(skipping fact, no merge)".

### 3. Write-time scoped semantic conflict check (new, wired at boot as of `auto-trigger-scoped-consolidation`)

Unlike section 2's periodic deep-mode path (60s scheduler tick over
low-worth clusters), this one runs near-real-time, off the write path itself.
`remember()` (`packages/core/src/cognitive/remember.ts`) reuses
the vector-neighbour search it already performs for every new fact: if any
neighbour clears cosine similarity ≥ `SCOPED_CONFLICT_SIMILARITY_THRESHOLD`
(0.85), the top `SCOPED_CONFLICT_MAX_NEIGHBOURS` (3) candidates are appended
as one `queue_job` outbox row (`job: "scoped_semantic_conflict_check"`,
nested `data` envelope — see design's D1). No qualifying neighbour → no
outbox row at all. This is unconditional with respect to §33: a fact can be
lexically clean (no same-subject/FTS overlap) yet still have a
non-overlapping semantic neighbour, so the append never branches on the §33
verdict. Gated by `scopedConflictCheckEnabled` (default `true`;
`MNEMO_SCOPED_CONFLICT_CHECK_ENABLED=false` disables it at the producer, zero
outbox rows, no env reads inside `packages/core/src/cognitive/`).

`OutboxWorker` drains the row (~1s poll) into the shared job queue at
priority 4 (`JOB_TIERS["scoped_semantic_conflict_check"]`,
`packages/core/src/resilience/queue-shedding.ts` — lowest tier, shed first
under pool pressure). `packages/consolidation/src/scoped-conflict-check.ts`'s
handler is registered against that queue from `wireConsolidation()`
(`packages/server/src/boot/consolidation.ts`), which the server calls
strictly **before** `outboxWorker.start()` (`packages/server/src/index.ts`)
so no job appended in the gap between queue creation and handler
registration is silently drained-and-lost — this ordering fix also covered
the two pre-existing orphaned `queue_job` producers, `staging_evaluation` and
`anomaly_review`, which shared the same at-risk window.

P74 dealt with both of those directly. `staging_evaluation` is gone: its
producer diverted low-prediction-error writes into a path with no table, no
consumer and no promotion step, so the content was lost and the caller was
handed a fabricated id. `anomaly_review` remains a producer with no consumer,
but it no longer fails silently — its payload now nests under `data` (the shape
`OutboxWorker` actually reads, so the content travels), and
`InMemoryQueueAdapter` logs a warning naming any job it drops for want of a
handler instead of returning as if the job had been accepted.

Since WP-7 the job is also the fallback for section 1: its candidates are the
neighbours at ≥ 0.85 plus every section-1 candidate that got no verdict at
write time (at any cosine), minus the pairs that did get one.

The handler: resolves an LLM (per-workspace, else global; no provider →
logged no-op) → loads the fact, requiring `status === "active"` (a §33
supersede may have archived it in the meantime) → dedupes against any
existing `conflicts_with` or `not_conflict` relation touching the fact in
either direction (`memory_judge` keep_both turns the relation into
`not_conflict`, so a judged pair is never reopened) → for each remaining
candidate (≤3), runs the same `classifyFactPair` LLM classifier the scheduler
uses; a failed classification is logged as
`scoped_conflict_check.classification_failed` and leaves the pair untouched;
only `CONTRADICTION` creates a `conflicts_with` relation, tagged
`metadata: { detectedBy: "scoped_write_time_check", similarity }`. Every step
is `try`/`catch` + logged — the handler never throws, matching the
best-effort/advisory posture of the rest of this document's mechanisms.
`memory_judge action=list` surfaces these rows alongside the periodic
deep-mode rows from section 2 (both are now production-live), distinguishable
by `metadata.detectedBy` (`"scoped_write_time_check"` vs.
`"semantic_classifier"`).

This closes part of "the actual gap" below: Mnemosyne now has one working
semantic (LLM-based) contradiction path, running near-real-time at write
time rather than on a periodic cycle. Its verdicts reach `GET /conflicts`, not
the `memory_remember` response; section 1 is what answers synchronously.

### 4. Orphaned v2 code: candidate-on-write already built, never wired

`packages/core/src/conflict/fact-candidate.ts::saveFactWithCandidates` and
`candidate.ts::saveDecisionWithCandidates` implement almost exactly Engram's
pattern: FTS candidates, a `judgmentRequired` boolean, one `judgmentId`
(pending relation id) per candidate, an `enqueueOnNoJudge` option. Per the
file's own doc comment: _"Tested end-to-end but no production caller
invokes it yet"_ — confirmed by `rg` (zero callers outside the
`auto-resolve.ts` wrapper, the package barrel export, and tests). This code
lives outside `src/cognitive/`, i.e. it's v2-era, not part of the current
v3 write path.

## Engram's mechanism, for contrast

`mem_save` runs `FindCandidates` (BM25/FTS) synchronously and returns
`judgment_required` + `candidates[]` (each with a `judgment_id`) in the same
tool response. The agent is expected to loop `mem_judge` over the candidates
before moving on. There's no auto-resolution: every candidate gets a verdict,
though a confidence heuristic lets the agent silently pick low-stakes verbs
(`related`/`compatible`/`scoped`/`not_conflict`) without asking the user —
only `supersedes`/`conflicts_with` on architecture/policy/decision types
below a confidence threshold force a user-facing question.

## The actual gap

At the time this was first written, the gap was framed as "nothing surfaces
synchronously." That part is now fixed (see the proposal below, shipped as
`write-time-conflict-surfacing`). A second gap remained, corrected in two
steps: until `auto-trigger-scoped-consolidation` (section 3) and, later,
`enable-deep-mode-consolidation` (section 2), the only conflict detection
that actually ran was the deterministic, lexical, write-time §33 resolver —
same-subject or FTS overlap only; the LLM-based periodic path existed in code
but never executed. Both gaps are now closed: section 3 added a near-real-time
semantic write-time path, and section 2's periodic LLM classification is now
enabled by default in production. Engram, by contrast, can optionally run
semantic (not just lexical) conflict detection at write-time via its own LLM.
Mnemosyne now has two semantic detection paths — section 3 is near-real-time
rather than truly synchronous (it runs off the transactional outbox, roughly
one poll interval after the write, not inside the `remember()` call itself),
and section 2 runs periodically (60s scheduler tick) over low-worth clusters
rather than per-write — but neither is dead code any longer.

## Proposal: wire synchronous candidate surfacing into `remember()`

Goal: `memory_remember` optionally returns enough for the calling agent to
judge in the same turn, instead of waiting for the consolidation pass or
polling separately.

1. Extend the remember response type (`packages/types/src/...`) with an
   optional
   `conflict?: { judgmentRequired: boolean; candidates: Array<{ id: string; subject: string; statement: string; action: "supersede" | "reject" | "review"; relationId?: string }> }`.
2. In `resolveFactContradictions()`, keep the `supersede` fast-path exactly
   as-is (high-confidence trust/recency wins don't need a human — that's
   the point of §33). For `reject`/`review` outcomes, in addition to
   `enqueueReviewItem`, also create a `conflicts_with` pending relation
   (reuse the `createRelation` helper the consolidation scheduler already
   calls) — this simultaneously closes the gap where `memory_judge` never
   sees write-time-detected contradictions, only consolidation-time ones.
3. Return the candidate + the new relation's id (as `relationId`, i.e. the
   `judgmentId`) up through `remember()`.
4. Surface it in `packages/mcp/src/tools/memory-remember.ts`'s response so
   an agent naturally knows to follow up with
   `memory_judge action=resolve relationId=…`.
5. Once this lands, the orphaned `saveFactWithCandidates` /
   `saveDecisionWithCandidates` module is largely redundant for facts —
   candidate for deletion, or explicit repurposing as the decision-primitive
   counterpart (decisions still have zero write-time contradiction handling
   today, orphaned or otherwise).

This is wiring, not new algorithms — `decideAutoResolution` and the
relation-creation pattern both already exist and are already proven in
production (consolidation) and in tests (v2 module). Stays clear of the
`src/cognitive/` purity boundary: relation creation goes through the storage
port, same as `scheduler.ts` already does.

## Open question

Should `review`-outcome candidates (ambiguous, confidence ≤ 0.7) also
optionally auto-enqueue an LLM judge call (mirroring Engram's beta
`engram conflicts scan --semantic`) instead of always waiting for a human or
the next deep-consolidation cycle? Out of scope for this note — worth a
follow-up once the synchronous-surfacing wiring above is in place.
