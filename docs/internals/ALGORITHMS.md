# COGNITIVE_ALGORITHMS.md

# Mnemosyne v3 — Cognitive Algorithm Specification

> **Status:** Mixed. §1 (recall) describes the code at `packages/core/src/cognitive/` as it runs today. Other sections are the original specification and may describe steps the code does not run; check the source file each section names, and `docs/STATUS.md`, before relying on a detail.

> **Status**: Implementation reference for `@mnemo-ai/core`.
> All algorithms receive adapters via dependency injection. Feature flags control activation.
> Graceful degradation contract: if a required adapter is unavailable, skip that step — never crash.

---

## Table of Contents

1. [Three-Tier Retrieval Cascade](#1-three-tier-retrieval-cascade)
2. [Session Collapse Pipeline](#2-session-collapse-pipeline)
3. [CoT Distillation Engine](#3-cot-distillation-engine)
4. [Memory Worth & TD(λ) Propagation](#4-memory-worth--tdλ-propagation)
5. [Consolidation Gate](#5-consolidation-gate)
6. [Self-Editing Memory](#6-self-editing-memory)
7. [Procedural Memory (Prompt Evolution)](#7-procedural-memory-prompt-evolution)
8. [Predictive Memory (Anticipation Engine)](#8-predictive-memory-anticipation-engine)
9. [Meta-Cognition (Self-Model)](#9-meta-cognition-self-model)
10. [Composition Engine (Rule-Based Inference)](#10-composition-engine-rule-based-inference)
11. [Trust-Anchor Consensus](#11-trust-anchor-consensus)
12. [Hebbian Learning & ACT-R](#12-hebbian-learning--act-r)
13. [Recall Explainability (BOM — Bill of Materials)](#13-recall-explainability-bom--bill-of-materials)
14. [Extraction Prefilter](#14-extraction-prefilter)
15. [Auto-Recall / Triggering](#15-auto-recall--triggering)
16. [Adaptive Recall Budget (Cap Tiers)](#16-adaptive-recall-budget-cap-tiers)
17. [Trust Ladder (Relation Provenance)](#17-trust-ladder-relation-provenance)
18. [Entity Mention Queue (Unresolved Resolution)](#18-entity-mention-queue-unresolved-resolution)

---

## Field Name Reference

> **Authority**: DATA_MODEL.md §2. This table is the single source of truth for column names
> used in all SQL snippets below. If DATA_MODEL.md and this table disagree, DATA_MODEL.md wins.

| Primitive | Table           | Primary content column | Secondary content    | Notes                      |
| --------- | --------------- | ---------------------- | -------------------- | -------------------------- |
| fact      | mnemo_fact      | statement              | subject TEXT         |                            |
| decision  | mnemo_decision  | title                  | body TEXT            | no `rationale` column      |
| episode   | mnemo_episode   | title                  | narrative TEXT       | no `description` column    |
| entity    | mnemo_entity    | name                   | aliases TEXT[]       | no `canonical_name` column |
| strategy  | mnemo_strategy  | trigger                | action TEXT          | no `title` column          |
| workflow  | mnemo_workflow  | name                   | steps JSONB          |                            |
| skill     | mnemo_skill     | name                   | prompt_template TEXT |                            |
| task      | mnemo_task      | title                  | description TEXT     |                            |
| event     | mnemo_event     | name                   | description TEXT     |                            |
| reasoning | mnemo_reasoning | question               | conclusion TEXT      | no `summary` column        |

---

## 1. Three-Tier Retrieval Cascade

**Purpose**: Answer a recall with the hits most relevant to the query, consulting the cheaper tiers first.

**Source of truth**: `packages/core/src/cognitive/index.ts` (orchestrator), `recall-hot.ts`,
`recall-pointer.ts`, `recall-cold.ts` and `recall-relevance.ts` in the same folder. This section
describes what that code runs; where it and an older spec disagree, the code wins.

**Entry points**: `POST /recall` (`packages/server/src/routes/recall.ts`) and the `memory_recall`
MCP tool, which calls the same route. The query type is `RecallQuery`, the answer
`RecallResponse`, both in `packages/types/src/recall.ts`.

**Order of the orchestrator** (`recall()` in `cognitive/index.ts`):

```
1. Token-budget gate (only when a budget is set, see §1.1).
2. No embedder configured (model "none") and no precomputed vector → cold tier, lexical path.
3. Embed the query (embedding LRU cache read-through). If the provider does not answer,
   the cold tier runs its lexical path instead (strict `mode: "semantic"` answers 503).
4. L3 result cache: a cached result for a query with cosine ≥ 0.95, at most 5 minutes old,
   is reused. Only for the default, unfiltered request shape (`canUseL3ResultCache`).
5. Hot tier → pointer tier → cold tier. The first tier that answers wins. The hot and pointer
   tiers are skipped when the request sets `minSimilarity` or `asOf`.
```

### 1.1 Token Budget Gate (CALMem pattern) — opt-in

`applyTokenBudget()` in `recall-pointer.ts`. It applies only when the request sets `tokenBudget`
or the server sets `MNEMO_RECALL_DEFAULT_TOKEN_BUDGET`; without either the full cascade runs.

```
budget < 500   → no recall: empty response
budget < 2000  → hot tier only, at most 3 hits
budget < 8000  → hot + pointer tiers, at most 5 hits
budget ≥ 8000  → full cascade with the requested limit
```

The server does not compute a budget from the context window. The caller sends a number.

### 1.2 Tier 1 — Hot (`recall-hot.ts`, `tryHotTier`)

```
Source: Redis sorted set mnemo:{workspaceId}:hot:facts (facts only). Without a cache
        adapter the tier is skipped.
Skipped when: includeArchived, filter.kinds without "fact", or a query with fewer than
        two content terms (RECALL-8).
Score: Petrov activation from the recall log, squashed with tanh, +0.3 when the fact was
        recalled in the last 5 minutes, capped at 1. Sensitivity ceiling and worth gate
        apply; injection-flagged content is demoted.
Query relevance: a warm fact is kept only if it covers more than half of the query's
        content terms (keepQueryRelevant).
Sufficiency: served only when ≥ 3 candidates score > 0.7; otherwise null and the cascade
        continues. A Redis failure counts as a miss (CHAOS-4).
```

### 1.3 Tier 2 — Pointer (`recall-pointer.ts`, `tryPointerTier`)

```
Source: facts only, through storage.pointerCandidates(): full-text terms extracted from the
        query (up to 8, stopwords removed) UNION LSH band collisions of the query embedding.
Score:  exact cosine(query, fact) × worth, after the sensitivity ceiling, filters and the
        worth gate.
Sufficiency: served only when ≥ 3 hits score > 0.7; otherwise null and the cascade continues
        to the cold tier.
```

### 1.4 Tier 3 — Cold (`recall-cold.ts`, `recallCold`)

The 7 stages named in the file header. Every kind in `RECALLABLE_KINDS` can be returned; the
kinds searched are `filter.kinds` when given, otherwise `DEFAULT_RECALL_KINDS` (plus entities).

```
Stage 1. Query preparation
         Embedding of the query text, or the precomputed `embedding`. Its width is the
         embedding model's (bge-m3, the local default, is 1024). With `hyde: true` an LLM
         writes a hypothetical answer whose embedding is averaged with the query's; without
         an LLM, or on failure, the plain query embedding is used.
         `mode: "lexical"` (or no embedder) runs the lexical path only.

Stage 2. Candidates, each keeping its raw cosine (`similarity`) and lexical rank apart
         - facts: HNSW search over mnemo_fact (ctx.vector.search), up to 1,000, cosine ≥ 0.1
         - entities: findSimilarEntities, cosine ≥ 0.3, kind weight 0.85
         - other recallable kinds: storage.recallableCandidates(), cosine ≥ 0.35
         - hybrid mode (`mode: "hybrid"` or `hybridFts: true`): FTS over facts and ts_rank
           over the other kinds, as lexical arms
         An explicit `minSimilarity` drops any candidate whose cosine is below it, whatever
         its kind, before ranking.

Stage 3. Eligibility (before any per-hit I/O)
         Validity (or `asOf`), lifecycle, the worth gate, the request filters (including
         `scopeOwner`) and the caller's sensitivity ceiling.
         Worth gate (passesWorthGate in worth.ts): a fact is served only if worth > 0.5 and
         its Wilson lower bound ≥ 0.3. Facts with no recall evidence yet are exempt, other
         kinds are not gated, and `includeLowWorth: true` turns the gate off.

Stage 4. Relevance and base score (recall-relevance.ts)
         relevance  = cosine, or in hybrid mode with lexical evidence a weighted RRF
                      (k = 60) between ONE semantic ranking (every kind, by cosine) and the
                      lexical ranking. There is no third source.
         worthPrior = 1 + 0.1 × (worth − 0.5)
         base       = relevance × kindWeight × worthPrior × (injection-flagged ? 1 − injectionScore : 1)

Stage 5. Exact-content dedup and activation tie-break
         Candidates with the same normalised content are collapsed (CHAOS-11); there is no
         cosine-threshold dedup. `nothingRelevant` is judged here, over every eligible
         candidate, before pagination.
         Petrov activation A(t) = ln(∑ t_j^(−0.5)) from mnemo_recall_log is read only for
         candidates that can still reach the page:
         score = base × (1 + 0.02 × tanh A)
         So the full rule is: relevance × kindWeight × worthPrior × (1 + 0.02·tanh A).
         Sort, then paginate (`offset`, `limit`).

Stage 6. Context for the served page only
         Open relations of each served hit, and the hyperedges it belongs to. Hyperedge
         co-members are HINTS on the hit (`hyperedges[].coMembers`); they are never added as
         hits (RECALL-2). Unresolved conflicts set `status: "contested"`.

Stage 7. Assemble RecallHit[] with structured security labels, `kind`, `topicKey`,
         `subject`, `status`, `similarity`.
```

**Rerank** runs only when the request sets `rerank: true` and an LLM is configured. Even then the
RecMem gate (`recmem.ts`) skips the LLM call when the served hits are thematically scattered
(recurrence signal below `recurrenceThreshold`, default 0.6). The LLM call has a 3-second
timeout; on failure the first-stage order is kept and `debug.rerankDegraded` is set. Pages that
hold confidential or restricted text are not sent to a remote LLM unless policy allows it.

**Failure modes**: embedder down → lexical path (strict `semantic` → 503
`semantic_search_unavailable`); no LLM → no HyDE and no rerank; storage arms that fail
(entities, non-fact kinds, FTS) contribute nothing and recall continues.

### 1.5 After the Answer

The cold tier runs these only for organic traffic (`appliesOrganicEffects`), never for `asOf`
reads:

```
- Composition engine (§10): inferences derived from the served hits, returned in the
  response; persisted only with `materialiseInferences: true`.
- hyperedge_bump outbox event for each hyperedge named on a served hit.
- Top 3 served facts promoted to the hot tier (async).
- Graph learning from retrieval — `related` relations between co-recalled facts
  (recordCoRecall) and Hebbian hyperedges after repeated co-recall — runs ONLY when the host
  sets `recallGraphLearning: true`. It is off by default (RECALL-11).
```

For every tier, the final delivered hits (after pagination and rerank) are recorded once per
request through the recall observation port (`recall-observation.ts`), which feeds
`mnemo_recall_log`, `hit_count` and the TD(λ) worth credit. Candidates that were not served are
not logged. Each tier also reports `mnemo_recall_duration_seconds{tier}`.

There is no token-adaptive truncation step inside the pipeline. The HTTP route can shorten each
hit with `projection: "compact"` (first 300 characters plus `truncated: true`); that is a wire
choice and does not change ranking.

---

## 2. Session Collapse Pipeline

**Purpose**: Extract durable knowledge from ephemeral session turns into long-term memory.

**Inputs**:

```typescript
interface CollapseInput {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  policy: CollapsePolicy;
  collapseReason: "inactivity" | "explicit" | "max_turns" | "max_tokens";
}
```

**Outputs**:

```typescript
interface CollapseOutput {
  status: "skipped" | "completed" | "failed";
  factsCreated: number;
  decisionsCreated: number;
  strategiesCreated: number;
  episodeId?: string;
  llmTokensUsed: number;
}
```

### 2.1 Trigger Conditions

```
Auto-collapse fires when ANY of the following is true:
  - inactivity:  lastActivityAt < now() - policy.inactivityTimeout (default 1800s)
  - max_turns:   len(session.turns) >= policy.maxTurns (default 50)
  - max_tokens:  estimated token count of turns >= policy.maxTokens (default 8192)
  - explicit:    agent calls session.collapse() explicitly
```

### 2.2 Algorithm

```
Step 1. Load session from Redis:
        turns   = LRANGE mnemo:{ws}:sess:{id}:turns 0 -1
        state   = HGETALL mnemo:{ws}:sess:{id}

Step 2. Minimum viability check:
        if len(turns) < policy.minTurnsForCollapse (default 3):
          → status: "skipped", reason: "too_few_turns". Exit.
        if policy.requirePin and not any(t.pinned for t in turns):
          → status: "skipped", reason: "no_pins". Exit.

Step 3. RecMem gate (arXiv:2605.16045):
        Compute sustained similarity signal:
          embeddings = [embed(t.content) for t in turns]
          pairwiseSimilarities = cosine_matrix(embeddings)
          sustainedSignal = mean(max_per_row(pairwiseSimilarities))
        if sustainedSignal < policy.recurrenceThreshold (default 0.6):
          if policy.skipLlmIfBelowThreshold:
            → status: "skipped", reason: "low_recurrence_signal". Exit.
        // Signal is high enough → proceed with LLM extraction.

Step 4. UCE classify — detect knowledge types:
        Scan turns for signals:
          facts:      factual assertions, measurements, configurations
          decisions:  "we decided", "going with", "chose"
          strategies: "when X happens, do Y", "if we see Z"
          tasks:      "TODO", "need to", "action item"
        Tag each turn with candidate knowledge types.
        Disable extraction for types not detected (save tokens).

Step 5. Single LLM extraction call:
        Build prompt with:
          - Classified turns (pinned turns get priority position)
          - Active knowledge types to extract
          - SessionCollapseSummary output schema (mandatory structured output)

        Call: llmAdapter.extract(prompt, schema=SessionCollapseSummarySchema)

        // SessionCollapseSummary shape:
        {
          goal: string,
          outcome: "resolved" | "partial" | "abandoned" | "delegated",
          facts: [{ content, confidence, topicKey? }],
          decisions: [{ content, rationale, supersedes? }],
          strategies: [{ trigger, action, context }],
          discoveries: string[],
          nextSteps?: string[],
          relevantEntities: string[],
          turnsProcessed: number,
          pinsUsed: number,
          llmTokensUsed: number,
          collapseReason: string,
        }

Step 5b. Surprise gate (prediction error) — per extracted item:
        For each fact/decision/strategy extracted in Step 5:
          embed(item.content) → HNSW search on the target table (mnemo_fact / mnemo_decision / ...)
          maxSim = max cosine similarity to any existing memory in this workspace
          PE = 1 − maxSim   // Prediction Error: 0 = already known, 1 = completely new

          if PE < config.surpriseThreshold (default 0.3):
            → discard item (already known, no information gain)
          else:
            → pass item to Step 6 (deduplication + persist)

        // Source: packages/core/src/session/collapse.ts lines 14-18
        // and packages/core/src/remember.ts:computePredictionError()
        // The threshold is tunable per workspace via collapseConfig.surpriseThreshold.

Step 6. Deduplication against existing memory:
        For each extracted item (fact/decision/strategy):
          a) topic_key upsert check:
             if item.topicKey is set:
               existing = SELECT * FROM {table} WHERE topic_key = item.topicKey
               if existing: → UPDATE (evolve). Skip conflict check. Continue.

          b) Cosine conflict check (only if no topic_key hit):
             embed(item.content) → HNSW search on target table
             candidates = results with cosine >= 0.82
             if candidates:
               verdict = resolveConflict(candidates[0], item)  // §11
               if verdict.winner == "incoming" → supersede existing
               if verdict.winner == "local" → discard incoming item
               if verdict.winner == "undecided" → enqueue human review, keep both

Step 7. Hybrid extraction dedup gate:
        per_turn_keys = SELECT topic_key FROM mnemo_fact
                        WHERE session_id = :id AND extraction_source = 'per_turn'
        Remove any collapse output whose topic_key is in per_turn_keys.

Step 8. Atomic persist to PostgreSQL:
        BEGIN TRANSACTION;
          for fact in summary.facts:
            INSERT INTO mnemo_fact (statement, confidence, topic_key, session_id,
                                    extraction_source='collapse', ...)
          for decision in summary.decisions:
            INSERT INTO mnemo_decision (title, body, supersedes_id, session_id, ...)
          for strategy in summary.strategies:
            INSERT INTO mnemo_strategy (trigger, action, context, session_id, ...)

          episode = INSERT INTO mnemo_episode (goal, outcome, session_id, ...)
                    RETURNING id

          for item in all_created:
            INSERT INTO mnemo_citation (source_id=session.id, target_id=item.id, ...)
        COMMIT;

Step 9. Hot tier promotion:
        for fact in created_facts:
          actr_boost(fact.id, delta=+0.5)  // Newly learned facts start warm
          record_entity_cooccurrence(fact.entity_ids)

Step 10. Clean session from Redis:
         DEL mnemo:{ws}:sess:{id}:turns
         DEL mnemo:{ws}:sess:{id}
         ZREM mnemo:{ws}:sess:active {sessionId}

         INSERT INTO mnemo_session (id, workspace_id, agent_id, goal,
                                    outcome, turns_processed, summary_json, ...)
         // Original turn content is NOT stored. Only summary survives.
         // Exception: pinned turns → INSERT INTO mnemo_citation as episodic evidence.

Failure mode: if LLM unavailable at Step 5 → status: "failed". Session data preserved in Redis.
              Retry with exponential backoff (max 3 attempts, 5/30/300s delays).
```

---

## 3. CoT Distillation Engine

**Purpose**: Cache successful reasoning chains. Serve cached CoT to avoid re-running expensive LLM reasoning on identical or near-identical queries.

**Inputs**:

```typescript
type CotPhase = "resolve" | "record" | "feedback";
```

### 3.1 RESOLVE Phase

```
Input: { query: string, topicKey?: string }
Target latency: <20ms (topic-key path), <50ms (vector path)

Step 1. Topic-key exact match (O(1), ~1ms):
        if topicKey is provided:
          result = SELECT * FROM mnemo_reasoning
                   WHERE topic_key = :topicKey
                     AND worth > 0.5
                     AND confidence > 0.3
          if result AND result.success_rate > 0.7 AND result.worth > 0.5:
            → CACHE HIT. Return:
              { cached_cot: result.reasoning, output: result.output,
                suggested_model: "haiku",   // signal: downgrade is safe
                reasoning_id: result.id }

Step 2. If no topic-key hit → embed query:
        queryEmbedding = embedAdapter.embed(query)

        candidates = HNSW search on mnemo_reasoning.embedding
                     WHERE valid_to IS NULL
                     LIMIT 5

Step 3. Evaluate top candidate:
        if candidates[0].cosine >= 0.88
           AND candidates[0].success_rate > 0.7
           AND candidates[0].worth > 0.5:
          → CACHE HIT. Return cached result + suggested_model: "haiku".
        else:
          → CACHE MISS. Return:
            { action: "execute",
              similar_attempts: candidates  // hints for the executing agent
            }

Failure mode: if embed adapter unavailable → skip Step 2, return cache miss.
```

### 3.2 RECORD Phase (Post-Execution)

```
Input: { query: string, reasoning: string, output: string, success: boolean }

Step 1. Embed input:
        queryEmbedding = embedAdapter.embed(query)

Step 2. Similarity check against existing records:
        candidates = HNSW search on mnemo_reasoning.embedding WHERE valid_to IS NULL LIMIT 3

        if candidates[0].cosine >= 0.95:
          → UPSERT (near-duplicate):
            UPDATE mnemo_reasoning SET
              reasoning = merge(existing.reasoning, input.reasoning),
              use_count = use_count + 1,
              updated_at = now()
            WHERE id = candidates[0].id
            Return existing id.
        else:
          → INSERT new record:
            INSERT INTO mnemo_reasoning (query, embedding, reasoning, output,
                                         success_count=1, failure_count=0,
                                         worth=1.0, confidence=0.0,  // will converge
                                         created_at=now())

Step 3. Initialize worth counters:
        if success: worth_success = 1, worth_failure = 0
        else:       worth_success = 0, worth_failure = 1
                    -- Record failure context for avoidance
                    UPDATE mnemo_reasoning SET failure_context = input.context

Failure mode: if insert fails → log and return. Record is a cache optimization, not critical.
```

### 3.3 FEEDBACK Phase

```
Input: { reasoning_id: string, outcome: "success" | "failure" }

Step 1. Update worth counters:
        if outcome == "success":
          UPDATE mnemo_reasoning SET success_count = success_count + 1
          WHERE id = :reasoning_id
        else:
          UPDATE mnemo_reasoning SET failure_count = failure_count + 1
          WHERE id = :reasoning_id

Step 2. Recompute derived signals (GENERATED columns update automatically):
        worth = success_count / (success_count + failure_count)

        // Wilson score lower bound at 95% CI:
        n = success_count + failure_count
        p = worth
        z = 1.96   // 95% CI
        confidence = (p + z²/(2n) - z*sqrt(p*(1-p)/n + z²/(4n²))) / (1 + z²/n)

Step 3. Lifecycle transitions:
        new_worth = SELECT worth FROM mnemo_reasoning WHERE id = :reasoning_id
        new_conf  = SELECT confidence FROM mnemo_reasoning WHERE id = :reasoning_id

        if new_worth < 0.3 AND new_conf > 0.5:
          UPDATE mnemo_reasoning SET status = 'quarantined' WHERE id = :reasoning_id
          // Quarantined records are excluded from RESOLVE results

        if new_worth > 0.8 AND new_conf > 0.5 AND use_count >= 50:
          UPDATE mnemo_reasoning SET status = 'golden' WHERE id = :reasoning_id
          // Golden records get priority in RESOLVE + are never consolidated

Failure mode: feedback is best-effort. If update fails, log + continue. Never block the caller.
```

---

## 4. Memory Worth & TD(λ) Propagation

**Purpose**: Measure the causal utility of each memory (not just recall frequency), and propagate credit backward through provenance chains.

### 4.1 Worth Signal Computation

```typescript
// Two-counter convergent signal
interface MemoryWorth {
  successCount: number; // Times recalled AND outcome was good
  failureCount: number; // Times recalled AND outcome was bad
  worth: number; // GENERATED: successCount / (successCount + failureCount)
  confidence: number; // GENERATED: Wilson score lower bound at 95% CI
}

// Decision rule:
// worth > 0.7 AND confidence > 0.5 → PROMOTE
// Wilson UPPER bound < 0.3         → DEMOTE (confident the worth is low;
//                                    ~17 unreinforced recalls from the prior)
// otherwise                        → neutral treatment
// Only serve in Tier 2/3 if worth > 0.3 (below this = excluded in Post-Processing)
```

### 4.2 Outcome Capture

Three signal sources, combined by confidence-weighted average:

```typescript
// Signal 1: EXPLICIT (highest confidence: 0.95)
// Source: agent calls session.collapse({ outcome: "resolved" })
//         or user thumbs-up/down
// Scores: resolved=1.0, partial=0.7, abandoned=0.3, failed=0.0

// Signal 2: TASK COMPLETION (medium confidence: 0.8)
// Source: linked tasks completion status
// Scores: all_completed=1.0, some_completed=0.6, none_completed=0.3
// Only fires if session has linked tasks

// Signal 3: HEURISTIC (low confidence: 0.4, always fires)
// Source: session shape analysis (zero LLM)
// Scores:
//   last message contains "thanks|perfect|great|done" → 0.9
//   user repeated same question → 0.2
//   turns > 20 and outcome == "abandoned" → 0.3
//   turns <= 3 and user stopped → 0.5 (ambiguous)
//   default → 0.5

function computeOutcome(signals: OutcomeSignal[]): number {
  const totalWeight = signals.reduce((sum, s) => sum + s.confidence, 0);
  return signals.reduce((sum, s) => sum + s.score * s.confidence, 0) / totalWeight;
}
```

**Convergence note**: Heuristic-only updates (confidence=0.4) move worth ~0.4x as fast as explicit signals. You need ~25 heuristic observations to equal the weight of 5 explicit ones. This is intentional.

### 4.3 TD(λ) Backward Propagation

```
Trigger: after each session collapse with a computed outcome score.
Cron: mnemo.worth.propagate (daily 02:00 UTC as catch-up, but also runs inline on collapse).

Step 1. Collect all memories recalled in the collapsed session:
        recalled_ids = SELECT DISTINCT memory_id FROM mnemo_recall_log
                       WHERE session_id = :sessionId

Step 2. For each recalled memory, trace provenance DAG backward:
        frontier = [{ id: memory_id, depth: 0, traceValue: 1.0 }]
        visited  = {}
        λ = 0.7
        max_hops = 5

        while frontier is not empty:
          node = frontier.pop()
          if node.depth > max_hops: continue
          if node.id in visited: continue
          visited[node.id] = node.traceValue

          // Traverse upstream provenance edges
          parents = SELECT from_id FROM mnemo_relation
                    WHERE to_id = node.id
                      AND verb IN ('derived_from', 'part_of')
          for parent in parents:
            frontier.push({
              id: parent.from_id,
              depth: node.depth + 1,
              traceValue: node.traceValue * λ
            })

Step 3. Apply decayed credit to each visited memory:
        outcome = computeOutcome(signals)  // 0.0 to 1.0

        for memory_id, trace_value in visited.items():
          credit = outcome * trace_value
          if credit >= 0.5:   // session contributed positively
            UPDATE mnemo_fact SET success_count = success_count + credit
          else:
            UPDATE mnemo_fact SET failure_count = failure_count + (1 - credit)
          // Wilson confidence recalculates via GENERATED columns

Failure mode: if provenance graph is sparse → only direct recalled memories get updated.
              This degrades gracefully: less credit propagation, not wrong propagation.
```

### 4.4 Promotion / Demotion Actions

```
PROMOTE (worth > 0.7 AND confidence > 0.5):
  - actr_boost(memory_id, delta=+0.3)
  - If canonical status not set: mark as "canonical candidate"
  - Exempt from consolidation (see §5)

DEMOTE (Wilson upper bound < 0.3):
  - hot-tier activation -10
  - Review row "low_worth_archive_candidate" (one while it stays pending,
    however many daily sweeps re-flag the fact)
  - Will be picked up by consolidation gate cluster analysis

NEUTRAL (everything else):
  - No action. Mid-band worth, or not enough evidence to decide.
```

---

## 5. Consolidation Gate

**Purpose**: Safely merge redundant low-worth memories without destroying useful episodic evidence. Gated by 6 conditions with post-validation rollback.

**Cron**: `mnemo.consolidation.run` — weekly, Sunday 03:00 UTC.

### 5.1 Algorithm

```
Step 1. Find similarity clusters:
        candidates = SELECT * FROM mnemo_fact
                     WHERE valid_to IS NULL
                       AND worth < 0.5         // only low-worth candidates
                       AND last_recalled_at < now() - INTERVAL '14 days'

        For each pair of candidates:
          if cosine(a.embedding, b.embedding) >= 0.85:
            add to same cluster

        clusters = connected_components(similarity_graph)
        clusters = [c for c in clusters if len(c) >= 3]   // discard pairs

Step 2. For each cluster, evaluate all 6 gate conditions:

        Condition 1: worth < 0.5 for ALL members
          → pass: all(m.worth < 0.5 for m in cluster)
          → fail reason: "high_worth_member"

        Condition 2: cluster size >= 3
          → pass: len(cluster) >= 3
          → fail reason: "cluster_too_small"

        Condition 3: no member recalled in last 14 days
          → pass: all(m.last_recalled_at < now() - 14d for m in cluster)
          → fail reason: "recently_active"

        Condition 4: no member has confidence > 0.7
          → pass: all(m.confidence <= 0.7 for m in cluster)
          → fail reason: "high_confidence_member"

        Condition 5: pairwise similarity >= 0.85 (tighter than historical 0.75)
          → pass: min(cosine(a,b) for all pairs) >= 0.85
          → fail reason: "insufficient_similarity"

        Condition 6: gate override not set
          → pass: not exists admin_gate_lock for this workspace
          → fail reason: "admin_gate_active"

        if ANY condition fails:
          → SKIP this cluster.
          → LOG: { cluster_ids, fail_reason, evaluated_at }
          → Continue to next cluster.

Step 3. Generate canonical summary for passing clusters:
        if len(cluster) <= 5 AND all similar (cosine > 0.92):
          → Use LCS (Longest Common Subsequence) extraction — no LLM needed
        else:
          → LLM summarize: "Merge these N facts into one canonical statement."
                           Input: cluster contents only (no extra context).

Step 4. Persist:
        BEGIN TRANSACTION;
          canonical = INSERT INTO mnemo_fact (statement=summary, status='canonical',
                                              derived_from_ids=cluster_ids, ...)
          for member in cluster:
            UPDATE mnemo_fact SET valid_to=now(), archived_by=canonical.id
            INSERT INTO mnemo_relation (from_id=canonical.id, to_id=member.id,
                                        verb='derived_from')
        COMMIT;

Step 5. Post-consolidation validation:
        test_queries = SELECT query FROM mnemo_recall_log
                       WHERE memory_id = ANY(:cluster_ids)
                       ORDER BY created_at DESC LIMIT 10

        for query in test_queries:
          before_hits = archive_recall(query, use_archived=true)   // pre-consolidation
          after_hits  = recall(query)                               // post-consolidation
          quality_delta = quality_score(after_hits) - quality_score(before_hits)

        avg_quality_delta = mean(quality_deltas)

        if avg_quality_delta < -0.05:   // quality dropped more than 5%
          → ROLLBACK:
            BEGIN TRANSACTION;
              UPDATE mnemo_fact SET valid_to=NULL, archived_by=NULL
              WHERE id = ANY(:cluster_ids)
              DELETE FROM mnemo_fact WHERE id = canonical.id
              DELETE FROM mnemo_relation WHERE from_id = canonical.id
            COMMIT;
            LOG: { event: "consolidation_rollback", cluster_ids, quality_delta }
        else:
          LOG: { event: "consolidation_success", cluster_ids, quality_delta }

Episode preservation rule: episodes are NEVER consolidated.
Only mnemo_fact rows derived from episodes can be candidates.
The episode → fact citation chain must be preserved after consolidation.
When returning a consolidated fact, check if source episodes score higher.
If so, prefer the episode (richer context).

Failure mode: if LLM unavailable in Step 3 → use LCS for all clusters.
              if validation query fails → rollback that cluster, continue others.
```

---

## 6. Self-Editing Memory

**Purpose**: Allow agents to correct, strengthen, or forget their own memories with safety guardrails preventing abuse.

**MCP Tool**: `memory_self_edit`

### 6.1 Action Dispatch

```typescript
type SelfEditAction = "append" | "replace" | "strengthen" | "weaken" | "forget" | "reflect";

interface SelfEditInput {
  action: SelfEditAction;
  target: string; // fact_id | "profile" | "strategy:{id}"
  content?: string; // required for append / replace
  reason: string; // always required — audit trail
}
```

### 6.2 Rate Limit Check (Runs First, Before Any Action)

```
Step 1. Load agent's edit counters from Redis:
        edits_this_session = GET mnemo:{ws}:edits:{agentId}:session:{sessionId}
        deletes_today      = GET mnemo:{ws}:deletes:{agentId}:{YYYY-MM-DD}

Step 2. Enforce limits:
        if edits_this_session >= policy.maxEditsPerSession (default 5):
          → REJECT. Return error: "edit_limit_reached_for_session"

        if action == "forget" AND deletes_today >= policy.maxDeletesPerDay (default 3):
          → REJECT. Return error: "delete_limit_reached_for_day"

Step 3. Enforce edit cooldown:
        last_edit_at = GET mnemo:{ws}:last_edit:{agentId}:{target}
        if last_edit_at AND now() - last_edit_at < policy.editGracePeriod (300s):
          → REJECT. Return error: "edit_cooldown_active"
```

### 6.3 Per-Action Logic

```
Action: APPEND
  → UPDATE mnemo_fact SET statement = statement || '\n' || :new_statement
  → Worth: PRESERVE (no change to counters)
  → Increment edits_this_session counter.

Action: REPLACE
  → UPDATE mnemo_fact SET statement = :new_statement
  → Worth: PRESERVE (identity of the fact unchanged)
  → Old statement archived in mnemo_edit_history.
  → Increment edits_this_session counter.

Action: STRENGTHEN
  → Check: strengthens_today for this fact < 3 (anti-gaming cap)
  → UPDATE mnemo_fact SET success_count = success_count + 1
  → ACT-R boost: actr_boost(target, delta=+0.2)
  → Increment edits_this_session counter.
  → Increment strengthens_today counter.

Action: WEAKEN
  → UPDATE mnemo_fact SET failure_count = failure_count + 1
  → ACT-R decay: actr_decay(target, penalty=0.1)
  → Increment edits_this_session counter.

Action: FORGET (soft delete)
  → Freeze worth: record current worth in mnemo_edit_history (for restore)
  → UPDATE mnemo_fact SET valid_to = now(), deletion_reason = :reason
  → Schedule hard delete after editGracePeriod (300s) unless restored.
  → Increment edits_this_session AND deletes_today counters.

Action: REFLECT
  → Trigger self-reflection cycle (see §6.4).
  → Does not count against edits_this_session.
```

### 6.4 Self-Reflection Cycle

```
Trigger: every 10 sessions OR explicit reflect action.

Step 1. Load last 10 session collapse summaries for this agent.

Step 2. Identify patterns:
        high_worth_strategies = strategies recalled with worth > 0.7
        low_worth_strategies  = strategies recalled with worth < 0.3
        contradicted_facts    = facts with recent conflict events in mnemo_audit_log
        missing_topics        = knowledge gaps from mv_knowledge_gaps (§9)

Step 3. Apply pattern-derived edits (counting against maxEditsPerSession):
        for strategy in high_worth_strategies:   strengthen(strategy)
        for strategy in low_worth_strategies:    weaken(strategy)
        for fact in contradicted_facts:          flag for user review (not auto-edit)
        for gap in missing_topics[:3]:           append to profile: "Known gap: {gap.topic}"

Step 4. Optionally rewrite profile summary:
        if profile.staleness > 30d:
          new_summary = summarize(recent_sessions + strength_areas + gaps)
          replace(target="profile", content=new_summary)

Step 5. Log as Episode:
        INSERT INTO mnemo_episode (title="reflection", narrative=reflection_log,
                                   agent_id=:agentId, ...)

Failure mode: if any step fails, log and continue. Reflection is best-effort.
```

---

## 7. Procedural Memory (Prompt Evolution)

**Purpose**: Evolve the agent's system prompt based on what behavioral patterns correlate with successful vs. failed outcomes. The only LLM-using algorithm with a clear cost model.

**Cron**: `mnemo.procedural.evaluate` — weekly, Saturday 02:00 UTC.
**LLM cost**: ~$0.006/agent/month (Haiku-class: 5k input + 200 output tokens/evaluation).

### 7.1 Algorithm

```
Step 1. Budget gate:
        monthly_spend = get_workspace_spend_this_month()
        if monthly_spend < policy.skipIfBudgetBelow (default $0.01):
          → SKIP. Not enough activity to justify evaluation.

Step 2. Collect K recent trajectories:
        K = min(20, available_scored_sessions)
        trajectories = SELECT session_id, outcome_score, summary_json
                       FROM mnemo_session
                       WHERE agent_id = :agentId
                         AND outcome_score IS NOT NULL
                       ORDER BY created_at DESC
                       LIMIT K

Step 3. Group by performance:
        high_group = [t for t in trajectories if t.outcome_score > 0.8]
        low_group  = [t for t in trajectories if t.outcome_score < 0.4]

        if len(high_group) < 2 OR len(low_group) < 2:
          → SKIP. Insufficient contrast for meaningful analysis.

Step 4. Retrieve current active prompt:
        current_prompt = SELECT prompt_text FROM mnemo_prompt_version
                         WHERE agent_id = :agentId AND status = 'active'
                         ORDER BY version DESC LIMIT 1

Step 5. Metaprompt LLM call (Haiku-class model):
        Input prompt structure:
          "High-scoring sessions (outcome > 0.8): {high_group summaries}
           Low-scoring sessions (outcome < 0.4): {low_group summaries}
           Current guidelines: {current_prompt}

           Identify behavioral patterns that correlate with success vs. failure.
           Generate a prompt delta:
             ADD: guidelines for patterns seen in high-scoring sessions
             REMOVE: guidelines associated with failure patterns

           Output format: { add: string[], remove: string[], rationale: string }"

Step 6. Token budget validation:
        candidate_prompt = apply_delta(current_prompt, delta)
        if token_count(candidate_prompt) > policy.maxPromptTokens (default 2000):
          → Truncate REMOVE list first, then ADD list, to fit budget.

Step 7. Insert as candidate version:
        new_version = INSERT INTO mnemo_prompt_version (
          workspace_id, agent_id,
          version = current.version + 1,
          prompt_text = candidate_prompt,
          diff_from_previous = generate_diff(current_prompt, candidate_prompt),
          algorithm = 'metaprompt',
          trajectories_used = K,
          avg_score_before = mean(t.outcome_score for t in trajectories),
          status = 'testing',
          activated_at = now()
        )

Step 8. A/B testing phase (10 sessions):
        Tag agent with: active_test_version = new_version.id
        Route agent to use new prompt for next 10 sessions.
        Existing sessions continue with current prompt.

Step 9. Evaluate after 10 test sessions:
        test_scores = SELECT outcome_score FROM mnemo_session
                      WHERE agent_id = :agentId AND prompt_version_id = new_version.id
                      LIMIT 10

        avg_score_after = mean(test_scores)
        improvement = avg_score_after - new_version.avg_score_before

        if improvement >= 0.05:
          UPDATE mnemo_prompt_version SET status = 'active', avg_score_after = avg_score_after
          UPDATE mnemo_prompt_version SET status = 'superseded' WHERE id = current.id
        else:
          UPDATE mnemo_prompt_version SET status = 'rolled_back', avg_score_after = avg_score_after
          // Agent reverts to previous active prompt automatically

Failure mode: if LLM unavailable → skip evaluation. Will retry next weekly cron.
              if test sessions fail to produce scores → rollback after 30 days with no data.
```

---

## 8. Predictive Memory (Anticipation Engine)

**Purpose**: Pre-inject likely-needed facts into session context before the agent asks. Zero LLM. Zero incremental cost.

**Cron**: `mnemo.anticipate.mine` — daily 06:30 UTC. Refreshes materialized views.

### 8.1 Pattern Mining (SQL)

```sql
-- Pattern 1: SEQUENTIAL — "after event A, event B usually follows within 24h"
CREATE MATERIALIZED VIEW mv_sequential_patterns AS
SELECT
  e1.name AS trigger_event,
  e2.name AS following_event,
  COUNT(*) AS observations,
  COUNT(*)::float / total.cnt AS confidence,
  AVG(EXTRACT(EPOCH FROM e2.occurred_at - e1.occurred_at)) AS avg_delay_seconds
FROM mnemo_event e1
JOIN mnemo_event e2 ON e2.workspace_id = e1.workspace_id
  AND e2.occurred_at > e1.occurred_at
  AND e2.occurred_at < e1.occurred_at + INTERVAL '24 hours'
CROSS JOIN LATERAL (
  SELECT COUNT(*) AS cnt FROM mnemo_event
  WHERE name = e1.name AND workspace_id = e1.workspace_id
) total
WHERE e1.workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid
GROUP BY e1.name, e2.name, total.cnt
HAVING COUNT(*) >= 3 AND COUNT(*)::float / total.cnt > 0.5;

-- Pattern 2: PERIODIC — "every Monday 9am, agent recalls metrics topics"
CREATE MATERIALIZED VIEW mv_periodic_patterns AS
SELECT
  EXTRACT(DOW  FROM created_at) AS day_of_week,
  EXTRACT(HOUR FROM created_at) AS hour_of_day,
  mode() WITHIN GROUP (ORDER BY query_topic) AS peak_topic,
  COUNT(*) AS recall_count
FROM mnemo_query_cache
WHERE workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY 1, 2
HAVING COUNT(*) >= 5;

-- Pattern 3: CONDITIONAL — "when entity A is mentioned, fact B is almost always recalled"
-- Derived from mnemo_recall_log joined to query entity mentions (entity_ids column)

-- Pattern 4: CO-OCCURRENCE — from existing Hebbian co_recall_count (already tracked)
```

### 8.2 Pre-Injection at Session Start

```
Step 1. Determine session context:
        current_dow  = EXTRACT(DOW  FROM now())
        current_hour = EXTRACT(HOUR FROM now())
        current_entities = entities mentioned in session's first message (if any)
        recent_events    = SELECT name FROM mnemo_event ORDER BY occurred_at DESC LIMIT 5

Step 2. Query materialized views for matching patterns:

        periodic_matches = SELECT peak_topic FROM mv_periodic_patterns
                           WHERE day_of_week = :dow AND hour_of_day = :hour

        sequential_matches = SELECT following_event, confidence FROM mv_sequential_patterns
                             WHERE trigger_event = ANY(:recent_events)
                             ORDER BY confidence DESC LIMIT 3

        conditional_matches = (entity-based lookup if current_entities non-empty)

Step 3. Resolve to actual facts:
        topics = collect(periodic_matches, sequential_matches, conditional_matches)
        topics = deduplicate(topics)[:3]   // cap at top-3 predictions

        for topic in topics:
          facts = recall(topic, topK=2, tier="warm")   // cheap warm-tier only

Step 4. Inject into session context:
        session.preFetchedContext = facts
        // Invisible to the agent — surfaced when session context is assembled
        // Agents can also call memory_anticipate tool explicitly

Expected savings: 300–600 tokens/session (avoided recall queries).
                  200–600ms latency (skipped round-trips).

Failure mode: if materialized views not yet populated (cold start < 14d) → skip.
              Pre-injection is always additive — failure = no pre-injection, not error.
```

---

## 9. Meta-Cognition (Self-Model)

**Purpose**: Give the agent a queryable map of what it knows well and what it doesn't, so it can make better decisions about when to recall vs. ask vs. act with confidence. Zero LLM.

**Cron**: `mnemo.metacognition.refresh` — daily 07:00 UTC.

### 9.1 Confidence Map

```sql
CREATE MATERIALIZED VIEW mv_confidence_map AS
SELECT
  e.id           AS entity_id,
  e.canonical_name,
  e.kind,
  COUNT(f.id)    AS fact_count,
  AVG(f.worth)   AS avg_worth,
  AVG(f.confidence) AS avg_confidence,
  MAX(f.created_at) AS newest_fact,
  -- Coverage level:
  CASE
    WHEN COUNT(f.id) >= 10 AND AVG(f.worth) > 0.7 THEN 'expert'
    WHEN COUNT(f.id) >= 5  AND AVG(f.worth) > 0.5 THEN 'familiar'
    WHEN COUNT(f.id) >= 2                          THEN 'aware'
    WHEN COUNT(f.id) >= 1                          THEN 'minimal'
    ELSE 'blind'
  END AS coverage_level,
  -- Freshness:
  CASE
    WHEN MAX(f.created_at) > NOW() - INTERVAL '7 days'  THEN 'current'
    WHEN MAX(f.created_at) > NOW() - INTERVAL '30 days' THEN 'recent'
    WHEN MAX(f.created_at) > NOW() - INTERVAL '90 days' THEN 'aging'
    ELSE 'stale'
  END AS freshness
FROM mnemo_entity e
LEFT JOIN mnemo_fact f ON f.entity_id = e.id AND f.valid_to IS NULL
WHERE e.workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid
GROUP BY e.id, e.canonical_name, e.kind;
```

### 9.2 Knowledge Gap Detection

```sql
CREATE MATERIALIZED VIEW mv_knowledge_gaps AS
SELECT
  q.query_topic         AS topic,
  COUNT(q.id)           AS recall_attempts,
  AVG(CASE WHEN q.hit_count > 0 THEN 1.0 ELSE 0.0 END) AS hit_rate,
  CASE
    WHEN AVG(CASE WHEN q.hit_count > 0 THEN 1.0 ELSE 0.0 END) < 0.3
         THEN 'ask_user'
    WHEN AVG(CASE WHEN q.hit_count > 0 THEN 1.0 ELSE 0.0 END) < 0.6
         THEN 'search_codebase'
    ELSE 'wait_for_data'
  END AS suggested_action
FROM mnemo_query_cache q
WHERE q.workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid
  AND q.created_at > NOW() - INTERVAL '30 days'
GROUP BY q.query_topic
HAVING COUNT(q.id) >= 3 AND AVG(CASE WHEN q.hit_count > 0 THEN 1.0 ELSE 0.0 END) < 0.6;
```

### 9.3 Performance Trends (7-Day Rolling)

```sql
-- Compare current 7 days vs previous 7 days for each agent
SELECT
  agent_id,
  AVG(CASE WHEN created_at > now()-'7d'::interval THEN hit_rate END) AS hit_rate_current,
  AVG(CASE WHEN created_at BETWEEN now()-'14d'::interval AND now()-'7d'::interval
      THEN hit_rate END) AS hit_rate_previous,
  -- Repeat for latency_ms, collapse_quality, strategy_success
FROM mnemo_daily_agent_stats
GROUP BY agent_id;
```

### 9.4 Agent Decision Flow (Self-Model Usage)

```
Before any recall call, agent checks self-model via memory_introspect:

  if coverage_level == "blind":
    → SKIP recall. Ask user directly. (saves empty-recall tokens)

  if coverage_level in ("expert", "familiar") AND freshness in ("current", "recent"):
    → TRUST recall results. No user confirmation needed.
    → Estimated savings: ~200 tokens per avoided confirmation loop.

  if coverage_level == "aware" OR freshness in ("aging", "stale"):
    → Recall but append caveat: "This may be outdated — please verify."

  if topic in knowledge_gaps (hit_rate < 0.3):
    → Execute suggested_action ("ask_user" | "search_codebase" | "wait_for_data")
    → Do not recurse into recall — it has historically failed for this topic.
```

**MCP tool**: `memory_introspect(aspect: "coverage|trends|gaps|strengths|all", entity?: string)`

---

## 10. Composition Engine (Rule-Based Inference)

**Purpose**: Derive new facts by applying forward-chaining rules over the knowledge graph. Zero LLM. Deterministic. Fully auditable.

**Execution point**: post-recall hook — runs AFTER retrieval, BEFORE returning results to agent.

### 10.1 Relation Verbs (9 Locked)

```typescript
type RelationVerb =
  | "related" // generic association
  | "compatible" // can coexist
  | "scoped" // A is scoped to context B
  | "conflicts_with" // contradiction
  | "supersedes" // A replaces B
  | "not_conflict" // explicitly not conflicting (post-resolution)
  | "derived_from" // A was derived from B
  | "part_of" // A is component of B
  | "member_of"; // A belongs to group B

// Custom rules must use only these verbs.
// API validates: if rule.pattern.relations[].verb not in LOCKED_VERBS → 400 error
```

### 10.2 Built-In Rules

```typescript
const BUILTIN_RULES: CompositionRule[] = [
  {
    id: "transitive_part_of",
    pattern: {
      relations: [
        { from: "A", to: "B", verb: "part_of" },
        { from: "B", to: "C", verb: "part_of" },
      ],
    },
    inference: {
      template: "{{A}} is transitively part of {{C}} (via {{B}})",
      confidence: 0.8,
      type: "fact",
    },
  },
  {
    id: "conflict_propagation",
    pattern: {
      relations: [
        { from: "A", to: "B", verb: "conflicts_with" },
        { from: "B", to: "C", verb: "supersedes" },
      ],
    },
    inference: {
      template: "{{A}} may conflict with {{C}} (conflicts with its predecessor {{B}})",
      confidence: 0.5,
      type: "warning",
    },
  },
  {
    id: "scope_inheritance",
    pattern: {
      relations: [
        { from: "A", to: "B", verb: "scoped" },
        { from: "C", to: "B", verb: "scoped" },
      ],
    },
    inference: {
      template: "{{A}} and {{C}} share scope {{B}} — may be relevant together",
      confidence: 0.6,
      type: "fact",
    },
  },
  {
    id: "shared_dependency_risk",
    pattern: {
      relations: [
        { from: "A", to: "X", verb: "related" },
        { from: "B", to: "X", verb: "related" },
        { from: "C", to: "X", verb: "related" },
      ],
    },
    inference: {
      template:
        "{{X}} is a shared dependency of {{A}}, {{B}}, {{C}} — single point of failure risk",
      confidence: 0.75,
      type: "warning",
    },
  },
];
```

### 10.3 Execution Algorithm

```typescript
function composeInferences(
  hits: RecallHit[],
  graph: SubGraph,
  workspaceId: string
): ComposedInference[] {
  // Load built-in + workspace custom rules
  const rules = [...BUILTIN_RULES, ...loadCustomRules(workspaceId)];
  const inferences: ComposedInference[] = [];

  for (const rule of rules) {
    // Step 1. Match relation patterns against graph
    const matches = matchPattern(rule.pattern, hits, graph);
    // matchPattern: iterate relation conditions, resolve variable bindings
    // Uses simple unification — no backtracking beyond 3 levels

    for (const match of matches) {
      // Step 2. Compute inference confidence
      const factConfidence = avgConfidence(match.facts);
      const inferenceConfidence = rule.inference.confidence * factConfidence;

      if (inferenceConfidence <= 0.5) continue; // filter low-confidence inferences

      // Step 3. Interpolate template
      const content = interpolate(rule.inference.template, match.bindings);

      inferences.push({
        content,
        confidence: inferenceConfidence,
        type: rule.inference.type,
        provenance: match.facts.map((f) => f.id),
        ruleId: rule.id,
        isInferred: true, // mark as inferred — never "observed"
      });

      // Step 4. Log to audit trail
      db.insert("mnemo_inference_log", {
        rule_id: rule.id,
        workspace_id: workspaceId,
        fact_ids: match.facts.map((f) => f.id),
        inference_content: content,
        confidence: inferenceConfidence,
        served_at: new Date(),
      });
    }
  }

  return inferences;
}
```

**Failure mode**: if rule matching throws → log + return `[]`. Inference is additive. Never blocks recall.

---

## 11. Trust-Anchor Consensus

**Purpose**: Resolve conflicting facts deterministically, without LLM arbitration. Runs inside `saveFactWithCandidates()` before queuing for human review.

### 11.1 Trust Anchor Hierarchy

```typescript
const TRUST_ANCHORS: Record<string, number> = {
  codebase_verified: 100, // verified against actual code/config
  user_stated: 90, // user explicitly said this
  user_confirmed: 85, // user confirmed when asked
  api_response: 80, // from an authoritative API
  document_extracted: 70, // from official documentation
  agent_observed: 60, // agent saw this happen (tool output)
  agent_inferred: 40, // agent concluded from reasoning
  llm_generated: 30, // LLM extraction without user confirmation
  federation_received: 20, // from a federated peer (untrusted by default)
} as const;
```

### 11.2 Resolution Algorithm

```typescript
function resolveConflict(local: MnemoFact, incoming: MnemoFact): ConflictVerdict {
  const localScore = TRUST_ANCHORS[local.attribution] ?? 0;
  const incomingScore = TRUST_ANCHORS[incoming.attribution] ?? 0;

  // Rule 1: Higher trust anchor wins
  if (localScore !== incomingScore) {
    const winner = localScore > incomingScore ? "local" : "incoming";
    return { winner, reason: "trust_anchor", confidence: 0.9 };
  }

  // Rule 2: Same anchor → more recent valid_from wins (bitemporal)
  if (local.validFrom.getTime() !== incoming.validFrom.getTime()) {
    const winner = local.validFrom > incoming.validFrom ? "local" : "incoming";
    return { winner, reason: "recency", confidence: 0.7 };
  }

  // Rule 3: Same recency → higher memory worth wins (if delta > 0.2)
  if (Math.abs(local.worth - incoming.worth) > 0.2) {
    const winner = local.worth > incoming.worth ? "local" : "incoming";
    return { winner, reason: "worth", confidence: 0.6 };
  }

  // Rule 4: Cannot determine → queue for human review
  return { winner: "undecided", reason: "ambiguous", confidence: 0 };
}
```

### 11.3 Integration Point

```typescript
async function saveFactWithAutoResolve(input: CreateFactInput): Promise<SaveResult> {
  const { fact, candidates } = await saveFactWithCandidates(input);

  for (const candidate of candidates) {
    const verdict = resolveConflict(candidate.existingFact, fact);

    if (verdict.winner === "incoming" && verdict.confidence > 0.7) {
      // Auto-supersede: close old fact, keep new
      await closeFact(candidate.existingFact.id, {
        reason: verdict.reason,
        superseded_by: fact.id,
      });
    } else if (verdict.winner === "local" && verdict.confidence > 0.7) {
      // Auto-reject: incoming is less trustworthy
      return { status: "rejected", reason: verdict.reason };
    } else {
      // Ambiguous: queue for review (existing behavior)
      await enqueueReview({
        ...candidate,
        verdictAttempt: verdict,
        confidence: verdict.confidence,
      });
    }
  }

  return { status: "created", fact };
}
```

### 11.4 Federation Voting

```typescript
function federatedConsensus(votes: FederationVote[]): ConsensusResult {
  // weight = trust_anchor_score × worth × freshness_decay
  // freshness_decay = e^(-days_old / 30)

  const groups = groupBy(votes, (v) => v.factVersion);
  const scores = Object.entries(groups).map(([version, voteGroup]) => ({
    version,
    totalWeight: sum(
      voteGroup.map(
        (v) =>
          (TRUST_ANCHORS[v.trustAnchor] / 100) * v.worth * Math.exp(-daysSince(v.freshness) / 30)
      )
    ),
    voterCount: voteGroup.length,
  }));

  const totalWeight = sum(scores.map((s) => s.totalWeight));

  // Supermajority: winner needs > 66% of total weight
  const winner = scores.find((s) => s.totalWeight / totalWeight > 0.66);
  if (winner) {
    return {
      status: "consensus",
      adoptedVersion: winner.version,
      confidence: winner.totalWeight / totalWeight,
    };
  }

  // No supermajority → contested: preserve both versions
  return {
    status: "contested",
    versions: scores.map((s) => s.version),
    recommendation: "human_review",
  };
}

// Federation trust is NOT transitive:
// If instance A trusts instance B, A does NOT automatically trust B's peers.
// Direct peer trust only.
```

---

## 12. Hebbian Learning & ACT-R

**Purpose**: Maintain two complementary scoring systems: Hebbian co-occurrence (relational weight between facts), and ACT-R activation (individual recall likelihood for hot-tier routing).

### 12.1 Hebbian STDP (Spike-Timing-Dependent Plasticity)

```
Trigger: every recall that returns multiple facts (co-recall event).

Step 1. For each pair (A, B) in returned facts:
        UPDATE mnemo_relation
        SET co_recall_count = co_recall_count + 1
        WHERE (from_id = A.id AND to_id = B.id)
           OR (from_id = B.id AND to_id = A.id)

        If no relation exists: INSERT with co_recall_count = 1, verb = 'related'

Step 2. Asymmetric weight update (STDP — temporal order matters):
        if A was retrieved BEFORE B (by rank or timestamp):
          UPDATE mnemo_relation
          SET hebbian_weight = hebbian_weight + 0.05   // A → B directional boost
          WHERE from_id = A.id AND to_id = B.id

        (The reverse direction B → A gets a smaller passive update: +0.01)

Step 3. Homeostatic normalization (weekly cron: mnemo.hebbian.normalize):
        -- Prevent runaway weight growth
        -- Normalize all hebbian_weights to [0, 1] using percentile-based scaling
        WITH ranked AS (
          SELECT id, hebbian_weight,
                 PERCENT_RANK() OVER (ORDER BY hebbian_weight) AS pct
          FROM mnemo_relation
          WHERE workspace_id = :ws
        )
        UPDATE mnemo_relation r
        SET hebbian_weight = ranked.pct
        FROM ranked
        WHERE r.id = ranked.id;

Execution: async, non-blocking. Runs after recall returns to the agent.
Failure mode: if update fails → log + skip. Co-recall counters are optimization data, not critical.
```

**Implementation note (`p60-corecall-stdp-convergence`, 2026-08-11)**: `recordCoRecall`
(`packages/core/src/cognitive/co-recall.ts`) is the **sole** writer of co-recall STDP. Until this
change, `packages/server/src/routes/recall.ts` ran a second, uncoordinated pass
(`recordCoRecallStdpForHits`) over the same `mnemo_relation` rows on every `POST /recall` —
uncapped, single-direction, strengthen-only, racing core's own capped
(`CO_RECALL_TOP_K = 6`), canonical-ordered, create-or-strengthen pass. Depending on whether hit
rank happened to agree with sorted-id order, this either double-counted a co-recall event or
silently missed the strengthen entirely. The server pass has been deleted; a cross-layer
regression test (`recall-co-recall-single-writer.test.ts`) asserts exactly once per qualifying
pair per request, so a second writer re-introduced later fails CI.

**Within-workspace rule**: co-recall never forms cross-workspace pairs. `multiLevelRecall`
(personal / workspace / tenant blended recall) issues up to three independent
`cognitive.recall` calls, each with its own `workspaceId`; each one runs its own `recallCold` →
`recordCoRecall` scoped to the workspace it actually queried. Merging the resulting hit objects
for the blended response (`mergeHits`) triggers no further writes. This was true before this
change too — the deleted server pass was the only code path that ever mixed workspaces (it ran
once over the merged set under the route's single `workspaceId`, so cross-workspace pairs
silently found nothing under RLS — a no-op, not a leak).

**Tail counter**: deleting the server pass permanently drops STDP for fact pairs ranked beyond
`CO_RECALL_TOP_K` (rank 7+) — Option 1 of the convergence decision, chosen because that tail was
already unreliable (missed roughly half the time by rank/sorted-id disagreement, double-counted
the other half). To make the size of that loss observable rather than assumed, `recordCoRecall`
takes an optional `onTail` hook (`CoreContext.onCoRecallTail`, same fire-and-forget host-hook
pattern as `onHotTierEvict`/`onCacheError`) fired once per invocation with `candidateFacts >= 2`,
before the pair loop: `candidateFacts` (distinct fact ids offered, pre-cap), `capK`
(`CO_RECALL_TOP_K`), `processedPairs` (`C(min(candidateFacts, capK), 2)`), and `skippedPairs`
(`C(candidateFacts, 2) - processedPairs`). The server wires this to four Prometheus counters
(`mnemo_co_recall_events_total`, `mnemo_co_recall_events_over_cap_total`,
`mnemo_co_recall_pairs_processed_total`, `mnemo_co_recall_pairs_skipped_total`,
`packages/server/src/metrics/index.ts`) plus a JSON `/metrics` snapshot accumulator
(`recordCoRecallTail`, `packages/server/src/metrics.ts`). Unlabeled by workspace — bounded
cardinality, and the follow-up decision below is global.

**Read-later decision rule**: raise the cap (a deliberately deferred Option 3 — it needs a
background-DB-load justification, not just a bigger number) only if, sustained over time,
`pairs_skipped / (pairs_skipped + pairs_processed) > ~0.25` **or**
`events_over_cap / events > ~0.3`. Below that threshold the tail loss is noise and the
single-writer convergence (`docs/archive/BACKLOG.md` P60) stays closed as-is.

### 12.2 ACT-R Activation Model (Petrov 2006)

Single canonical formula — replaces all previous variants (CA §5.1, RC §3):

```
  A(t) = ln(∑_{j=1}^{n} t_j^{-d}) + W

where:
  t_j = seconds elapsed since j-th retrieval event
  d   = decay parameter = 0.5 (Anderson 2004 empirical value)
  W   = associative activation from Hebbian co-occurrence weights (§12.1)

Practical approximation (for storage in mnemo_fact.actr_score):
  A ≈ ln(hit_count + 1) - d × ln(age_seconds + 1) + W

  age_seconds = EXTRACT(EPOCH FROM now() - last_recalled_at)

This formulation:
- Eliminates the undefined `recency_bonus` and `confidence` terms
- Is monotonically decreasing with time (no discontinuities at midnight)
- Supersedes §12.4 hourly decay cron (decay is implicit in the formula)

The §12.5 nightly full-rebuild cron (mnemo.actr.rebuild) is REMOVED — see §12.5.
```

### 12.3 ACT-R Update Triggers

```
On recall (every hit):
  UPDATE mnemo_actr_activation
  SET hit_count = hit_count + 1,
      last_recalled_at = now()
  WHERE fact_id = :factId

  // Redis sorted set update (hot tier):
  ZADD mnemo:{ws}:actr:{agentId} {new_score} {factId}

On new fact created (session collapse):
  INSERT INTO mnemo_actr_activation (fact_id, hit_count=1, initial_boost=0.5)
  ZADD mnemo:{ws}:actr:{agentId} 0.5 {factId}

On consolidation (fact archived):
  ZREM mnemo:{ws}:actr:{agentId} {archivedFactId}
  DELETE FROM mnemo_actr_activation WHERE fact_id = :archivedFactId
```

### 12.4 ACT-R Decay (Hourly Cron)

```
Cron: mnemo.actr.decay — hourly.

UPDATE mnemo_actr_activation
SET score = score * 0.995    -- 0.5% decay per hour
WHERE workspace_id = :ws

// After update, rebuild Redis sorted set for hot tier:
// (only for facts whose score changed by > 0.01 to minimize Redis writes)
```

### 12.5 Hot Tier Consistency (Background Job)

The daily full-rebuild cron (`mnemo.actr.rebuild`) is REMOVED (ALG-01 fix).

Reason: the nightly overwrite erased 23 hours of event-driven ACT-R updates,
fighting with the hourly decay cron. The Petrov formula (§12.2) makes decay
implicit — activation scores are recomputed lazily at recall time from the
stored `hit_count` and `last_recalled_at` columns, eliminating the need for
a separate cron rebuild.

Hot tier consistency is now maintained by:

1. Incremental updates on each recall event (§12.3) — score += event delta.
2. Lazy score recomputation when facts enter Tier 1 (compare stored vs live formula).
3. Periodic partial scan (optional): once per 6h, refresh top-500 facts per workspace.

---

## Appendix: Cron Job Registry

| Job Key                         | Schedule         | Algorithm | Purpose                             |
| ------------------------------- | ---------------- | --------- | ----------------------------------- |
| `mnemo.worth.propagate`         | Daily 02:00 UTC  | §4        | TD(λ) backward credit propagation   |
| `mnemo.consolidation.run`       | Weekly Sun 03:00 | §5        | Gated consolidation with rollback   |
| `mnemo.procedural.evaluate`     | Weekly Sat 02:00 | §7        | Prompt evolution A/B evaluation     |
| `mnemo.anticipate.mine`         | Daily 06:30 UTC  | §8        | Refresh temporal pattern views      |
| `mnemo.metacognition.refresh`   | Daily 07:00 UTC  | §9        | Refresh confidence map + gaps       |
| `mnemo.composition.validate`    | Weekly Sun       | §10       | Validate inferences still hold      |
| `mnemo.hebbian.normalize`       | Weekly           | §12       | Homeostatic weight normalization    |
| `mnemo.actr.decay`              | Hourly           | §12       | Decay activation scores             |
| `mnemo.task.stale`              | Daily 08:00 UTC  | —         | Flag stale tasks (no auto-close)    |
| `mnemo.entity.resolve_mentions` | Hourly           | §18       | Auto-resolve + sweep stale mentions |

## Appendix: Cold Start Behavior

All algorithms in §§1,4,5,7,8,9 are disabled during "learning mode" (first 14 days or until graduation criteria met):

```
Learning mode disables: hot tier, anticipation, composition, worth tracking, consolidation.
Learning mode enables:  aggressive extraction, session collapse, entity extraction.

Graduation (exit learning mode) when ANY of:
  - fact_count >= 50
  - session_count >= 10
  - entity_count >= 5
  - days_elapsed >= 14

On graduation, enable all algorithms and pre-populate hot tier from most-recalled facts.
```

## Appendix: Graceful Degradation Matrix

| Adapter Missing     | Effect                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Redis unavailable   | Tier 1 (hot) skipped. Tier 2+3 unaffected.                                                         |
| EmbedAdapter down   | Tier 2 LSH skipped. Tier 3 vector search skipped. FTS + pointer only.                              |
| LLMAdapter down     | HyDE skipped. Rerank skipped. CoT RESOLVE still works (topic-key path). Session collapse deferred. |
| PostgreSQL degraded | Full read-fallback to Redis for recent session data. Writes queued.                                |
| Pattern views stale | Anticipation skips pre-injection. Session starts normally.                                         |

No algorithm crashes when its dependency is missing. Every step checks adapter availability and continues or skips gracefully.

---

## 13. Recall Explainability (BOM — Bill of Materials)

**Purpose**: Produce a machine-readable audit record for every recall decision so any stakeholder can answer "why did the system return this fact?" long after the deploy that produced it.

**Source files**: `packages/core/src/bom/types.ts`, `packages/core/src/bom/compose.ts`

### 13.1 BOM Shape

```typescript
// Six slices, each capturing a different dimension of the recall decision.
interface DecisionBOM {
  traceId: string; // matches the recall request's X-Trace-Id
  workspaceId: string;
  decisionAt: string; // ISO-8601

  // Who made the call
  agentIdentity: BOMIdentitySlice; // { userId, agentId | null, role }

  // How big is the workspace at decision time
  trustSnapshot: BOMTrustSlice; // { factCount, factCountTier }

  // Which stage caps and feature flags were active
  policySnapshot: BOMPolicySlice; // { stageCapByTier, flags }

  // Full pipeline telemetry stream
  traceEvents: RecallMetricEvent[]; // one event per pipeline stage

  // Audit log window (last N actions on workspace, e.g. 5 min)
  auditWindow: BOMAuditSlice; // { entries[], windowMs }

  // Final result summary
  decisionOutcome: BOMOutcomeSlice; // { hits, totalMs }
}
```

### 13.2 Completeness Score

```typescript
const REQUIRED_BOM_FIELDS = [
  "agentIdentity",
  "trustSnapshot",
  "policySnapshot",
  "traceEvents",
  "auditWindow",
  "decisionOutcome",
] as const;

// Returns 0.0 (empty BOM) → 1.0 (all 6 slices present).
// Used by the Inspector UI to flag partial BOMs as yellow/red.
function completenessScore(bom: Partial<DecisionBOM>): number {
  let present = 0;
  for (const k of REQUIRED_BOM_FIELDS) {
    const v = (bom as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) present++;
  }
  return present / REQUIRED_BOM_FIELDS.length;
}
```

### 13.3 Composition Algorithm

```
The BOM is assembled by the host endpoint, not inside the recall pipeline.
This keeps the pipeline latency-clean — no BOM overhead on the hot path.

Step 1. Recall pipeline executes normally and emits telemetry events per
        stage (already in §1). Each event carries: stage name, latencyMs,
        resultCount, scoresMin/Max, tierUsed.

Step 2. Host endpoint (POST /api/mnemo/decisions/:traceId) fetches 4 sources
        in parallel:
          a) identity     — from the authenticated session
          b) factCount    — getCachedFactCount(workspaceId)  // see §16
          c) auditEntries — SELECT FROM mnemo_audit_log WHERE ...
                            AND created_at > now() - :windowMs
          d) traceEvents  — SELECT FROM mnemo_recall_metric WHERE trace_id = :traceId

Step 3. composeBOM(input) joins all slices:
          trustSnapshot.factCountTier = factCountTier(factCount)
          policySnapshot.stageCapByTier = STAGE_CAP_BY_TIER  // see §16
          auditWindow.entries mapped to stable ISO strings (bigint seq serialized)

Step 4. Return DecisionBOM as JSON. completenessScore() is computed client-side.

Failure mode: if audit log unavailable → return BOM with auditWindow.entries = [].
             completenessScore() will be < 1.0, flagging the gap in the UI.
             Never block the recall response while assembling the BOM.
```

### 13.4 API

```
GET  /memory/recall/explain/:traceId
     Returns: { bom: DecisionBOM, completeness: number }
     Auth: workspace-scoped. Agents only see their own workspace BOMs.

The Inspector UI uses this to render:
  "Recalled via Tier 2 (warm). Workspace has <1k facts → stage cap: drawerGrep=6.
   Pipeline took 12ms. 3 hits. Audit window: 1 admin action in last 5 min."
```

---

## 14. Extraction Prefilter

**Purpose**: Eliminate conversation turns with no extractable knowledge BEFORE sending them to the LLM, reducing extraction token cost by up to 80%.

**Source file**: `packages/core/src/extraction/prefilter.ts`

### 14.1 Inputs / Outputs

```typescript
interface PrefilterMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

interface PrefilterResult {
  yes: boolean;
  reason: string; // label for observability: "indicator_match" | "too_short" | ...
}
```

### 14.2 Live Prefilter — `shouldExtract`

Four sequential gates. Any rejection exits immediately (no further checks).

```
Gate 1. Total length:
        totalChars = sum(m.content.length for m in messages)
        if totalChars < 40 → reject: "too_short"
        // Floor is tuned so a single signal-rich sentence (~50-80 chars)
        // still passes. Chitchat is caught by Gate 2.

Gate 2. All-short check:
        if every message has content.length < 30 → reject: "all_short_messages"
        // Catches multi-message pure chitchat that cleared Gate 1 in aggregate.

Gate 3. Content token density:
        tokens = words(messages, lowercase) filtered by:
          - not in STOPWORDS set (150+ common English words + greetings)
          - length >= 3
        if len(tokens) < 5 → reject: "no_content_tokens"

Gate 4. Dialogue presence:
        if no message has role "user" or "assistant" → reject: "no_dialogue"
        // Tool / system-only turns are never extractable.

Positive indicator check (final):
        POSITIVE_INDICATORS = [
          /\b(prefer|like|love|hate|need|want|always|never|usually)\b/i,
          /\b(decided|will|going to|plan to|chose|adopted)\b/i,
          /\b(at|in|from|works for|lives in|located)\b/i,
          /\b(my (name|email|phone|address|company|team|role))\b/i,
          /\b([A-Z][a-z]+ [A-Z][a-z]+)\b/,   // ProperName pattern
        ]
        if any indicator matches any message:
          → accept: "indicator_match"
        else:
          → reject: "no_indicator"
```

### 14.3 Backfill Prefilter — `shouldExtractBackfill`

Used by the sweeper for retroactive passes. Applies looser thresholds to catch turns the live filter dropped:

```
Differences from shouldExtract:
  - totalChars floor: 20 (vs 40)
  - token floor: 2 (vs 5)
  - POSITIVE_INDICATORS check: DROPPED
    → turns without indicators return yes=true, reason="backfill_no_indicator"
    → LLM makes the final judgment in the second pass
  - "no_dialogue" hard gate: RETAINED (tool-only turns are never extractable)
```

### 14.4 Integration Point

```
Session Collapse Pipeline (§2), Step 5 (LLM extraction call):

  BEFORE: all turns were sent to the LLM
  AFTER:  shouldExtract(turns) gates the call

  if shouldExtract returns yes=false:
    → skip LLM call entirely for this turn batch
    → record: { prefiltered: true, reason }
    → estimated savings: 40-80% of extraction calls (predominantly
      pure Q&A turns, greetings, and acknowledgments)

Backfill sweeper runs shouldExtractBackfill on archived sessions to
catch facts missed during live sessions.
```

**Failure mode**: if prefilter itself throws → log + allow extraction to proceed (fail open). Prefilter is a cost optimization, not a correctness gate.

---

## 15. Auto-Recall / Triggering

**Purpose**: Decide per-turn whether to run a deeper recall query (Layer 2), so the system skips recall on ~50% of turns that don't need it while erring on the side of triggering when past context might be relevant.

**Source file**: `packages/core/src/recall/triggering.ts`

### 15.1 Inputs / Outputs

```typescript
interface ShouldTriggerRecallInput {
  userTurn: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  minTurnLength?: number; // default 15; turns shorter than this skip recall
}

interface TriggerDecision {
  trigger: boolean;
  reason: string; // short label: "greeting" | "reference_word" | "named_entities" | ...
  confidence: number; // 0..1 — confidence the skip/trigger decision was correct
}
```

### 15.2 Algorithm

The classifier is pure code — no LLM, no DB round-trip. Runs in microseconds on every agent turn.

```
Hard SKIP rules (apply first, cheapest checks):

  Rule S1. Empty turn → skip (confidence: 1.0, reason: "empty")

  Rule S2. Punctuation / emoji only → skip (confidence: 0.95, reason: "punctuation_only")
           Pattern: /^\s*[\s\p{P}\p{S}\p{Emoji}]+\s*$/u

  Rule S3. Pure number → skip (confidence: 0.9, reason: "number_only")
           Matches: "5", "10:30am", "$50.00", "42%"

  Rule S4. Greeting / closing / ack → skip (confidence: 0.95, reason: "greeting")
           Bilingual patterns (EN + ES/Rioplatense): hi, ok, thanks, dale, listo,
           chau, gracias, sí, 👍, 🙏, etc.

  Rule S5. turn.length < minTurnLength (default 15) → skip (confidence: 0.7, reason: "too_short")

Hard TRIGGER rules (apply after skip rules pass):

  Rule T1. Explicit reference word → trigger (confidence: 0.95, reason: "reference_word")
           Words: "previously", "last time", "recordá", "decidimos", "talked about",
           "remember", "recall", "earlier", "que habíamos", etc.

  Rule T2. Past-tense question → trigger (confidence: 0.9, reason: "past_question")
           Pattern: question word + past verb in same clause
           e.g. "what did we decide?", "cuándo hablamos de esto?"

  Rule T3. Anaphoric pronoun + history depth → trigger (confidence: 0.7, reason: "pronoun_with_history")
           Fires only when history >= 5 turns (otherwise pronoun has no referent to resolve)
           Pronouns: "it", "they", "that", "eso", "ella", "aquello", etc.

  Rule T4. Multiple proper nouns → trigger (confidence: 0.7, reason: "named_entities")
           countProperNouns(turn) > 1
           Excludes the first word of the turn (autocorrect capitalization)
           Matches: capitalized words with accented chars (Á, É, Ñ, etc.)

Default (no rule fired):
  → trigger (confidence: 0.5, reason: "default")
  // When in doubt, recall — Layer 1 (distilled profile) already covers
  // must-know context, so a missed Layer 2 hit is the costlier failure.
```

### 15.3 Relationship to Anticipation Engine (§8)

| Dimension    | Triggering (§15)                                | Anticipation Engine (§8)                                |
| ------------ | ----------------------------------------------- | ------------------------------------------------------- |
| When         | Every agent turn, real-time                     | Pre-session batch (cron 06:30 UTC)                      |
| Input        | Current user message                            | Historical patterns (sequential, periodic, conditional) |
| Output       | `TriggerDecision` — fire Layer 2 recall or skip | Pre-fetched facts injected into session context         |
| Cost         | Zero (pure regex/heuristic)                     | SQL over materialized views                             |
| Configurable | `minTurnLength`                                 | `policy.anticipationEnabled`                            |

**Failure mode**: if the classifier throws → default to `trigger: true`. Recall cost is acceptable; missing context is not.

---

## 16. Adaptive Recall Budget (Cap Tiers)

**Purpose**: Scale recall depth and result counts to workspace size so small workspaces aren't overwhelmed with irrelevant results and large ones aren't under-served by artificially tight caps.

**Source files**: `packages/core/src/recall/cap-tiers.ts`, `packages/core/src/recall/stage-caps.ts`

> **Not wired into recall.** These helpers are exported from `@mnemo-ai/core`, but the recall
> pipeline (§1) does not call them: its candidate limits are fixed in `recall-cold.ts`. The
> algorithm below is the specification.

### 16.1 Tier Vocabulary

```typescript
// Four canonical tiers. Strings are frozen — dashboards key on these values.
type TieredFactCountBucket = "<1k" | "<10k" | "<100k" | ">=100k";

function factCountTier(factCount: number): TieredFactCountBucket {
  if (factCount < 1_000) return "<1k";
  if (factCount < 10_000) return "<10k";
  if (factCount < 100_000) return "<100k";
  return ">=100k";
}
```

### 16.2 Per-Stage Caps

```typescript
// v2 splits the cap across two pipeline points (vs. v1.1's single final cap):
//   drawerGrep  — entity-filtered FTS fetch; high precision, tight cap
//   firstStage  — full recall pool; wider cap = lower floor miss-rate

const STAGE_CAP_BY_TIER: Readonly<
  Record<TieredFactCountBucket, { drawerGrep: number; firstStage: number }>
> = {
  "<1k": { drawerGrep: 6, firstStage: 10 },
  "<10k": { drawerGrep: 10, firstStage: 15 },
  "<100k": { drawerGrep: 16, firstStage: 25 },
  ">=100k": { drawerGrep: 20, firstStage: 30 },
};

// graph-expansion depth stays at final maxResults for all tiers
// so neighbours can still promote past direct hits.
```

### 16.3 Algorithm

```
Step 1. Determine fact count:
        factCount = getCachedFactCount(workspaceId)
        // CacheAdapter: 5-minute TTL. Falls back to PostgreSQL COUNT query.

Step 2. Bucket the workspace:
        tier = factCountTier(factCount)

Step 3. Apply stage caps:
        drawerGrep = STAGE_CAP_BY_TIER[tier].drawerGrep
        firstStage = STAGE_CAP_BY_TIER[tier].firstStage

        // Tier 2 warm recall (§1.3): LIMIT :drawerGrep * 4 on entity drawer
        // Tier 3 cold pipeline (§1.4): LIMIT :firstStage * 3 on each source

Step 4. Final result cap:
        maxResults = topK override from request  // explicit override wins
                  ?? min(firstStage, policy.maxResults)

Step 5. Tag telemetry:
        emit "total" event with tag: fact_count_tier = tier
        // Enables external dashboards to group latency/quality by tier.
```

### 16.4 Override and Calibration Notes

```
- Explicit topK in the recall request always overrides tier caps.
- Numbers in STAGE_CAP_BY_TIER are v2 spec proposals (§7.2). Re-calibration
  against 4 weeks of telemetry (mnemo.recall.<stage>.count distributions)
  is required before production use.
- STAGE_CAP_BY_TIER is exported and frozen. The BOM policySnapshot
  includes it verbatim so every recall decision documents which caps were
  active (§13.3).
```

**Failure mode**: if getCachedFactCount fails → default to tier "<1k" (most conservative). Never block recall; underserve rather than over-fetch.

---

## 17. Trust Ladder (Relation Provenance)

**Purpose**: Classify each edge in the knowledge graph by how reliably its provenance was established, so graph expansion scores respect the trustworthiness of the edges being traversed.

**Source file**: `packages/core/src/recall/trust-ladder.ts`

**Note**: This is separate from Trust-Anchor Consensus (§11). Trust anchors score per-FACT credibility (who stated the fact). The trust ladder scores per-RELATION reliability (how was the edge derived). They are complementary.

### 17.1 The Five Rungs

```typescript
type TrustLadderRung = "unverified" | "pending" | "heuristic" | "llm" | "verified";

// Decay cap applied during graph expansion.
// Final edge weight = base × verbPriority × trustCap
const TRUST_LADDER_DECAY: Readonly<Record<TrustLadderRung, number>> = {
  verified: 1.0, // human-confirmed via review queue. Survives auto-pin.
  llm: 1.0, // LLM-extracted, no human review. Back-compat default.
  // NULL provenance maps here (v1.1 default: no cap).
  heuristic: 0.5, // system-synthesized: alias merge, coref, dedup.
  // v1.1 cap — preserved verbatim for score compatibility.
  pending: 0.4, // extracted but blocked on unresolved entity mention.
  // Edge exists; flagged low-trust until mention resolves (§18).
  unverified: 0.25, // external integration without a trust signal
  // (webhook import, third-party sync, unknown strings).
};
```

### 17.2 Classification Function

```typescript
function classifyTrustRung(raw: string | null | undefined): TrustLadderRung {
  if (raw == null) return "llm"; // back-compat: NULL = LLM-derived
  switch (raw) {
    case "verified":
    case "llm":
    case "heuristic":
    case "pending":
    case "unverified":
      return raw;
    default:
      return "unverified"; // unknown strings → treat as lowest trust
  }
}

// Convenience wrapper for hot paths — avoids allocating the rung string.
function trustDecay(raw: string | null | undefined): number {
  return TRUST_LADDER_DECAY[classifyTrustRung(raw)];
}
```

### 17.3 Use in Graph Expansion (§1.4, Stage 7)

> **Not wired into recall.** The recall pipeline (§1) does not expand the graph: relations and
> hyperedges are attached to served hits as context and hints, never scored as neighbours. The
> rule below is the specification for `trust-ladder.ts`, which `@mnemo-ai/core` exports.

```
For each edge traversed in graph expansion:
  edgeDecay = expandDecay × verbPriority × trustDecay(edge.provenance)
  neighborScore = directHitScore × edgeDecay

Effect per rung:
  - verified   (1.0): neighbor scores unpenalized — treated like direct hits
  - llm        (1.0): same as verified (backward-compatible)
  - heuristic  (0.5): neighbor score halved — competes from weaker floor
  - pending    (0.4): neighbor score reduced 60% — nearly suppressed
  - unverified (0.25): neighbor score reduced 75% — rarely surfaces
```

### 17.4 Schema Notes

```
Column: mnemo_relation.provenance TEXT DEFAULT NULL

No migration required to extend the ladder. The column was deliberately
TEXT DEFAULT NULL in v1.1 so new rung strings could be added without
downtime. classifyTrustRung handles unknown values defensively.

v1.1 edge inventory:
  NULL       → "llm" (all LLM-extracted edges)
  "heuristic" → "heuristic" (alias merge / coref / dedup edges)

v2 new rungs ("pending", "unverified", "verified") have no existing
rows yet. They are written by: the mention-queue resolver (§18),
external integrations, and the human review queue respectively.
```

**Failure mode**: if provenance column is unreadable → `trustDecay(undefined)` returns 1.0 (llm default). Expansion proceeds without penalty rather than crashing.

---

## 18. Entity Mention Queue (Unresolved Resolution)

**Purpose**: When extraction identifies entity names that cannot be confidently matched to an existing canonical entity, queue them for later resolution rather than silently dropping them or creating duplicate entity rows.

**Source file**: `packages/core/src/entity/mention-queue.ts`

### 18.1 Schema

```typescript
interface MnemoUnresolvedMention {
  id: string;
  workspaceId: string;
  rawName: string; // exact mention text seen by the extractor
  context: string | null; // surrounding text (~500 chars) for disambiguation
  sourceFactId: string | null; // soft reference to the fact the mention came from
  confidence: number; // [0,1] extractor certainty rawName is a real entity
  suggestedEntityId: string | null; // extractor's best-guess canonical entity
  mentionCount: number; // times this rawName was seen since last pending mention
  status: "pending" | "resolved" | "dismissed";
  resolvedEntityId: string | null; // set when status = "resolved"
  resolvedAt: Date | null;
  metadata: Record<string, unknown>; // extractor version, model, etc.
  createdAt: Date;
  updatedAt: Date;
}
```

### 18.2 Queueing Algorithm (Upsert with Dedup)

```
On extraction: extractor finds entity mention but confidence < threshold
               OR entity does not exist in mnemo_entity.

Step 1. Attempt INSERT with ON CONFLICT (workspace_id, raw_name)
        WHERE status = 'pending':

        New mention (no conflict):
          → INSERT with mentionCount = 1

        Duplicate pending mention (conflict fires):
          → mentionCount += 1
          → context, suggestedEntityId updated ONLY IF new confidence > existing
          → sourceFactId preserved (first-wins — original context is most useful)
          → confidence = GREATEST(existing, new)

        Effect: multiple extractor passes on the same ambiguous name collapse
                into one queue item. Reviewer inbox stays manageable.

Step 2. Return upserted row.
        Callers check mentionCount > 1 to know whether this was a merge.
```

### 18.3 Resolution Strategies

```
Strategy A — Manual (human review):
  Reviewer calls: resolveUnresolvedMention({ id, entityId })
  → UPDATE status = 'resolved', resolvedEntityId = entityId, resolvedAt = now()
  → Throws if mention is not pending or not in workspace (strict ownership check)

Strategy B — Dismiss (noise):
  Reviewer calls: dismissUnresolvedMention({ id })
  → UPDATE status = 'dismissed'
  → After dismissal: a fresh occurrence of the same rawName opens a NEW pending
    mention (UNIQUE partial index covers only pending rows — dismissed rows
    don't block future insertions)

Strategy C — Stale sweep (janitor cron):
  mnemo.entity.resolve_mentions (hourly or configurable)
  → DELETE / archive mentions where status = 'pending'
    AND created_at < now() - INTERVAL '30 days'
  → These aged out without a resolution — entity graph quality not impacted
    because the mention was never linked in the first place.
```

### 18.4 API

```
GET  /memory/entities/mentions/pending
     Query: { limit?: number (1-200, default 50), before?: ISO timestamp }
     Returns: MnemoUnresolvedMention[] ordered by createdAt DESC
     Use: human review queue; agents with admin role can also poll this.

POST /memory/entities/mentions/:id/resolve
     Body: { entityId: string }
     Resolves the mention to an existing canonical entity.

POST /memory/entities/mentions/:id/dismiss
     Marks the mention as noise. Fresh occurrences will re-open the queue.
```

### 18.5 Effect on Trust Ladder (§17)

```
While a mention is pending (status = 'pending'):
  → Any relation that references the unresolved entity gets
    provenance = "pending" in mnemo_relation.
  → trustDecay("pending") = 0.4 → edge is suppressed in graph expansion.

After resolution (status = 'resolved'):
  → Edge provenance can be upgraded to "heuristic" or "llm"
    by the resolver process, increasing the decay cap.

This creates a feedback loop: resolving ambiguous mentions directly
improves graph traversal quality in the recall pipeline.
```

**Failure mode**: if queue INSERT fails → log + continue extraction. The fact is saved without the entity link. The mention is not queued — a silent gap is preferable to blocking the extraction pipeline.

---

## §19 — Knowledge Type Scheduler (UCE-Inspired Rebalancing)

**Purpose**: Detect when a workspace has too many facts but too few strategies/workflows/skills
and bias the session-collapse extraction prompt toward underrepresented knowledge types.
Inspired by Unified Cognitive Engine (UCE) rebalancing loops.

**Cron**: `mnemo.type.schedule` — daily, 06:00 UTC per workspace.

**Inputs**

```
workspace_id       UUID        Target workspace
target_distribution Record<KnowledgeType, number>   % targets (configurable, defaults below)
```

**Algorithm**

```
Step 1. Count active records per type:
  SELECT kind, count(*) FROM mnemo_fact
    WHERE workspace_id = :ws AND status = 'active'
  UNION ALL SELECT 'strategy', count(*) FROM mnemo_strategy WHERE workspace_id = :ws
  UNION ALL SELECT 'workflow',  count(*) FROM mnemo_workflow  WHERE workspace_id = :ws
  UNION ALL SELECT 'skill',     count(*) FROM mnemo_skill     WHERE workspace_id = :ws
  UNION ALL SELECT 'decision',  count(*) FROM mnemo_decision  WHERE workspace_id = :ws
  UNION ALL SELECT 'episode',   count(*) FROM mnemo_episode   WHERE workspace_id = :ws
  UNION ALL SELECT 'task',      count(*) FROM mnemo_task      WHERE workspace_id = :ws
  UNION ALL SELECT 'event',     count(*) FROM mnemo_event     WHERE workspace_id = :ws
  -- entity + reasoning are auto-derived, not extraction targets

Step 2. Compute actual distribution:
  total = sum of all counts (minimum 1 to avoid divide-by-zero)
  actual_pct[type] = count[type] / total

Step 3. Compare against target distribution (defaults):
  fact=40%  decision=15%  strategy=15%  episode=10%
  workflow=5%  skill=5%  task=5%  event=5%

Step 4. Compute bias weights:
  For each extraction-target type:
    raw_bias[type] = max(0, (target_pct[type] - actual_pct[type]) / target_pct[type])
  Normalize: bias[type] = raw_bias[type] / sum(raw_bias)
  If sum(raw_bias) == 0: all bias values = 0 (distribution already balanced)

Step 5. Inject bias hints into the collapse prompt:
  If bias['strategy'] > 0.3:
    Prepend: "Pay special attention to behavioral patterns (when X, do Y)."
  If bias['workflow'] > 0.3:
    Prepend: "Look for multi-step procedures that could be extracted as workflows."
  If bias['decision'] > 0.3:
    Prepend: "Extract policy decisions with explicit rationale."
  If bias['skill'] > 0.3:
    Prepend: "Identify reusable skills or techniques demonstrated in this session."
  (Multiple hints may be active simultaneously)

Step 6. Persist bias cache:
  Key:  mnemo:{workspace_id}:cache:type_bias
  Type: Redis Hash — field=kind, value=float string
  TTL:  24 h (refreshed each run)
  Fallback: in-memory map if Redis unavailable (process-local, single-pod only)

Step 7. Collapse pipeline reads cache:
  collapseChain.loadTypeBias(workspace_id)
    → cache HIT  → apply hints
    → cache MISS → run Steps 1-5 inline (synchronous, <200 ms for <50K facts)
```

**Outputs**

```
bias cache written to Redis (or in-memory fallback)
collapse prompt enriched with 0-4 hint sentences
```

**Failure modes**

```
Count query fails (DB error)   → use neutral bias (all zeros); log warning;
                                 collapse proceeds without extraction preference
Redis unavailable              → fallback to in-memory map; single-pod consistency only
```

**Cold start behavior**

```
First 14 days of workspace lifetime (fact count < 50):
  → Skip bias calculation entirely; extract everything aggressively (no hints injected)
  → Threshold configurable via workspace.settings.typeBiasMinFacts (default 50)
```

---

## §20 — Embedding Migration (Model Switch Procedure)

**Purpose**: When a workspace changes its embedding model, existing vector embeddings become
dimensionally incompatible with the new model. This algorithm handles lazy re-embedding so recall
degrades gracefully during the transition rather than breaking completely.

**Trigger**: admin action — `POST /admin/providers` with a new embedding model.

**Job key**: `mnemo.embed.migration`

**Inputs**

```
workspace_id    UUID
old_model       string    e.g. "text-embedding-ada-002"
new_model       string    e.g. "text-embedding-3-large"
new_dimensions  number    e.g. 1024
batch_size      number    default 100
```

**Algorithm**

```
Step 1. Admin triggers model change:
  POST /admin/providers { embedding: { model: "new-model", dimensions: 1024 } }
  System validates that the new model is reachable (test embed of "ping").
  Stores new config in mnemo_workspace_settings.embedding_model.

Step 2. Mark all existing embeddings as stale:
  UPDATE mnemo_fact
    SET embedding_stale = true, embedding_model = :old_model
  WHERE workspace_id = :ws AND embedding IS NOT NULL
  (Bulk UPDATE — no row-level locks needed; MVCC snapshot keeps readers unblocked)

Step 3. Switch recall to hybrid mode:
  Recall pipeline checks embedding_migration_active flag (workspace setting).
  While active:
    FTS weight:    0.7  (up from normal 0.4)
    Vector weight: 0.3  (down from normal 0.6)
    Vector search: WHERE embedding_stale = false ONLY
  This keeps recall functional (FTS-dominant) while re-embedding proceeds in background.

Step 4. Background re-embedding job (batched):
  LOOP until no stale rows remain:
    a) SELECT id, statement FROM mnemo_fact
         WHERE workspace_id = :ws AND embedding_stale = true
         ORDER BY last_recalled_at DESC NULLS LAST
         LIMIT :batch_size
    b) vectors = embedAdapter.embed(rows.map(r => r.statement))   -- new model
    c) UPDATE mnemo_fact
         SET embedding = vectors[i], embedding_stale = false, embedding_model = :new_model
       WHERE id = rows[i].id
    d) Emit: mnemo_embedding_migration_remaining{workspace} = remaining_count
    e) Throttle: if workspace.budgetCap configured, respect token budget before next batch

Step 5. Monitor progress:
  Gauge: mnemo_embedding_migration_remaining{workspace}
  Log:   INFO embed_migration_batch_complete { workspace, remaining, batch_size }

Step 6. Migration complete (remaining = 0):
  Restore normal recall weights (FTS 0.4, Vector 0.6).
  Clear embedding_migration_active flag.
  Log event: "embedding_migration_complete" with duration and total_reembedded count.
  Emit counter: mnemo_embedding_migration_completed_total{workspace}
```

**Outputs**

```
All mnemo_fact rows for workspace: embedding refreshed, embedding_stale = false
Recall weights restored to normal
embedding_migration_complete event logged
```

**Failure modes**

```
Embed provider down during migration
  → Job retries with exponential backoff (1s, 2s, 4s … max 5 min)
  → Stale facts remain stale; recall continues in hybrid mode
  → Admin notified via alert: mnemo_embedding_migration_stalled

Workspace deleted during migration
  → Job finds zero rows on next batch query; loop exits naturally
  → No cleanup required (FK cascade handles embedding column)

New model has different dimensions than HNSW index
  → Detected at Step 1 validation
  → System schedules ALTER COLUMN on the embedding column and rebuilds HNSW index
    before marking migration active (index rebuild is offline — schedule maintenance window)

Budget cap reached mid-migration
  → Job pauses; resumes at next scheduled run (same job key, next daily window)
  → Hybrid recall mode stays active until migration completes
```

**Estimated duration**

```
10 000 facts, batch_size=100, 1 API call/sec  → ~100 seconds (~2 min)
10 000 facts, budget-throttled (1 call/10 sec) → ~17 minutes
100 000 facts, budget-throttled               → hours (migration may span multiple cron windows)
```

---

## §21 — Cross-Workspace Consolidation (Org-Level Knowledge Sharing)

**Purpose**: For organizations with multiple workspaces (e.g., one per team), identify facts
duplicated across workspaces and promote them to a shared org-level knowledge layer, improving
recall across the org without duplicating storage.

**Cron**: `mnemo.consolidation.cross_workspace` — weekly, Saturday 04:00 UTC.

**Feature flag**: `crossWorkspaceConsolidation.enabled` — default `false`, Cloud mode only.

**Inputs**

```
org_id              UUID       Organization identifier
cosine_threshold    float      Minimum similarity for cross-workspace match (default 0.90)
min_workspace_count number     Minimum workspaces a fact must appear in to be promotable (default 3)
min_avg_worth       float      Minimum average worth score across instances (default 0.6)
```

**Algorithm**

```
Step 1. Identify candidate workspaces (same organization):
  SELECT workspace_id FROM mnemo_api_keys
  WHERE org_id = :org AND status = 'active'
  -- Cloud mode only; single-tenant deployments have no org concept → skip entirely

Step 2. Load candidate facts from all workspaces:
  For each workspace_id in candidate_workspaces:
    SELECT id, statement, embedding, worth, pii_tagged
    FROM mnemo_fact
    WHERE workspace_id = :ws AND status = 'active'
      AND embedding IS NOT NULL AND embedding_stale = false
  (Requires admin-level pg role to bypass RLS: SET LOCAL ROLE mnemo_admin)

Step 3. Cluster across workspaces (pure algorithm — see cross-workspace.ts):
  Input: flat list of { fact_id, workspace_id, embedding, statement, worth, pii_tagged }
  a) Group by (subject, kind) as initial candidate buckets
  b) Within each bucket: compute pairwise cosine similarity
  c) Cluster: facts with cosine ≥ 0.90 AND from different workspaces → same cluster
  d) Output: List<CrossWorkspaceCluster> where each cluster has ≥ 2 members

Step 4. Evaluate promotion criteria per cluster:
  Promotable if ALL conditions met:
    (a) members span ≥ min_workspace_count distinct workspaces
    (b) avg(member.worth) ≥ min_avg_worth
    (c) No conflicting versions: pairwise cosine of all member statements ≥ 0.85
        (high cosine means they say the same thing; low cosine = conflicting → skip)
    (d) No member has pii_tagged = true (org facts must be non-personal)

Step 5. Promote eligible clusters:
  For each promotable cluster:
    a) Choose canonical statement: member with highest worth (tie-break: oldest created_at)
    b) INSERT into mnemo_fact (workspace_id = org.shared_workspace_id, ...)
    c) INSERT relations: promoted_fact derived_from → each source fact_id
    d) UPDATE source facts: metadata.promoted_to = org_fact_id

Step 6. Recall integration (ongoing — not part of cron):
  When recall fires for any workspace within the org:
    UNION query includes org.shared_workspace_id facts
    Org facts receive score_weight *= 0.8 penalty
    (Surfaces org knowledge without it dominating workspace-specific results)

Step 7. Conflict flags:
  Clusters that failed criterion (c) above:
    INSERT into mnemo_org_consolidation_conflicts
      (org_id, cluster_members, detected_at, status='pending_review')
    Exposed via GET /admin/org/consolidation/conflicts for manual review
```

**Outputs**

```
org.shared_workspace: new mnemo_fact rows for each promoted cluster
source facts: metadata.promoted_to populated
mnemo_org_consolidation_conflicts: rows for unresolvable conflicting clusters
```

**Failure modes**

```
Org grouping not configured (single-tenant)
  → Feature flag check at Step 1 exits early; no work done

RLS prevents cross-workspace reads
  → Requires admin pg role (SET LOCAL ROLE mnemo_admin in transaction)
  → If role not available: log error, skip org, alert admin

Conflicting versions across workspaces
  → Do not promote; insert into conflicts table for manual review
  → Partial promotion (some clusters succeed, others conflict) is acceptable

Embed provider unavailable at cron time
  → Step 3 requires embeddings already present (embedding_stale = false)
  → Facts with stale embeddings are excluded from clustering (not a blocker)
  → If >30% of facts are stale, defer entire org run and log warning

org.shared_workspace not provisioned
  → Auto-create on first promotion run, owned by org.owner_user_id
  → If creation fails: abort run, alert admin
```

**Implementation note**: the clustering pure function lives at
`packages/core/src/consolidation/cross-workspace.ts`. It has no DB or LLM
dependencies — takes embeddings in, returns clusters out. The cron is the thin
orchestrator over it (Phase 4, gated on legal + security signoff per the design doc).
