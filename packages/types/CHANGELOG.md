# Changelog

## 3.6.2 (unreleased)

The `3.6.1` on npm (2026-07-22) predates most of what this package exports today; the repository
kept saying `3.6.1` while its content moved on. This version is the first that matches the source.

### Added

* i18n core shared by the CLI, MCP and server: `DEFAULT_LOCALE`, locale resolution and
  linear-time template matching. The CLI imports it at start-up, so a CLI built from this tree
  fails against types 3.6.1.
* Sensitivity helpers (`tiersAtOrBelow`, `sensitivityAtLeast`), recall trace, decision event,
  session, health, undo-log and recall-metric stats types used by the server and the dashboard.


## 3.6.0-alpha.0 (2026-07-06)


### Added

* **api:** Task 12 — 7 missing REST endpoints
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** emit queue_depth gauge from pending outbox count
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** add appendMeterEvent + getMonthToDateUsageFromDb storage port methods (F15)
* **types:** add deterministic dependency-free text-delta codec (DELTAMEM §16)
* **types:** add optional RecallHit.embedding for RecMem rerank gate
* **types:** BreakGlassStore port + InMemory double (F10)
* **types:** declare 5 missing domain span names
* **types:** extend MnemoSpanAttributes with spec fields + mnemo.write alias (F18)
* **types:** fold episode residual deltas via applyDelta in InMemoryStorageAdapter (F4)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* **w4:** core cognitive validation + API surface freeze gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **audit:** thread real actor_type through the audit trail
* **core:** §33 — run deterministic consensus on the production fact-write path
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status


### Documentation

* **types:** correct stale hyperedge comment + add e2e member-expansion test

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **api:** Task 12 — 7 missing REST endpoints
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** emit queue_depth gauge from pending outbox count
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** add appendMeterEvent + getMonthToDateUsageFromDb storage port methods (F15)
* **types:** add deterministic dependency-free text-delta codec (DELTAMEM §16)
* **types:** add optional RecallHit.embedding for RecMem rerank gate
* **types:** BreakGlassStore port + InMemory double (F10)
* **types:** declare 5 missing domain span names
* **types:** extend MnemoSpanAttributes with spec fields + mnemo.write alias (F18)
* **types:** fold episode residual deltas via applyDelta in InMemoryStorageAdapter (F4)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* **w4:** core cognitive validation + API surface freeze gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **audit:** thread real actor_type through the audit trail
* **core:** §33 — run deterministic consensus on the production fact-write path
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status


### Documentation

* **types:** correct stale hyperedge comment + add e2e member-expansion test

## 3.4.0-alpha.0 (2026-07-05)


### Added

* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **api:** Task 12 — 7 missing REST endpoints
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** emit queue_depth gauge from pending outbox count
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** add appendMeterEvent + getMonthToDateUsageFromDb storage port methods (F15)
* **types:** add deterministic dependency-free text-delta codec (DELTAMEM §16)
* **types:** add optional RecallHit.embedding for RecMem rerank gate
* **types:** BreakGlassStore port + InMemory double (F10)
* **types:** declare 5 missing domain span names
* **types:** extend MnemoSpanAttributes with spec fields + mnemo.write alias (F18)
* **types:** fold episode residual deltas via applyDelta in InMemoryStorageAdapter (F4)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* **w4:** core cognitive validation + API surface freeze gate
* Wave T — standards + security hardening
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **audit:** thread real actor_type through the audit trail
* **core:** §33 — run deterministic consensus on the production fact-write path
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Documentation

* **types:** correct stale hyperedge comment + add e2e member-expansion test

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **api:** Task 12 — 7 missing REST endpoints
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **remember:** accept host-side precomputed embedding vector
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** emit queue_depth gauge from pending outbox count
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** add appendMeterEvent + getMonthToDateUsageFromDb storage port methods (F15)
* **types:** add deterministic dependency-free text-delta codec (DELTAMEM §16)
* **types:** add optional RecallHit.embedding for RecMem rerank gate
* **types:** BreakGlassStore port + InMemory double (F10)
* **types:** declare 5 missing domain span names
* **types:** extend MnemoSpanAttributes with spec fields + mnemo.write alias (F18)
* **types:** fold episode residual deltas via applyDelta in InMemoryStorageAdapter (F4)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* **w4:** core cognitive validation + API surface freeze gate
* Wave T — standards + security hardening
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **audit:** thread real actor_type through the audit trail
* **core:** §33 — run deterministic consensus on the production fact-write path
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Documentation

* **types:** correct stale hyperedge comment + add e2e member-expansion test

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **api:** Task 12 — 7 missing REST endpoints
* **composition:** lazy-seed built-in composition rules on first workspace write
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **audit:** thread real actor_type through the audit trail

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter,types:** anticipation view read methods (Wave G2)
* **adapter,types:** meta-cognition view read methods (Wave F2)
* **adapter,types:** real episode depth + reconstructEpisode (spec §16)
* **anticipation:** 4-way blend + conditional/co-occurrence patterns + pre-injection (spec §30)
* **cache:** §9 L2/L3 cache layers + Redis-down degradation ladder
* **core,adapter:** entity-keyed confidence map + coverage/freshness + trends + strengths + suggestedAction (spec §31)
* **core,governance:** §11 promote/demote/canonical actions + max-5-hop TD + governance.propagate
* **core,types,adapter:** kind-differentiated decay + Hebbian STDP/homeostatic (Wave Y1, §25.2/§25.3)
* **core,types,adapter:** materialiseInference port + composition engine (Wave H2)
* **core,types,adapter:** TD(λ) propagation + Wilson-score lower bound (Wave J3)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** compositionality relation/fact_value DSL + multi-hop + warnings + conflicts + 4 seed rules (spec §32)
* **core,types:** hyperedge expansion in recall-cold stage 3b + outbox bump (Wave D4)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** enforce worth serving gate + λ-drift time decay (spec §11)
* **core:** Experience-Compression cross-level episode-subtree compression (spec §2)
* **core:** fact topic-key idempotent upsert mirroring decision.ts (spec §25.4)
* **core:** L0 working memory — workGet/Set/Checkpoint/bloom/rateLimit (spec §9)
* **core:** pure in-process typed event bus (spec §4)
* **core:** Tier 2 pointer recall + CALMem token-budget pre-stage (spec §17)
* **core:** UCE knowledge-type scheduler + collapse extraction bias (spec §10,§7)
* **core:** unify RecMem recurrence gate + add gated recall rerank (spec §1/§2,§7)
* extend PrimitiveKind with hyperedge + updateWorth support (Wave D5)
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
* **reasoning:** CoT distillation cache loop — resolve/record/feedback + quarantine/golden (spec §8)
* **recall-log:** TASK-4001 — mnemo_recall_log, port methods, DrizzleStorageAdapter, Stage 4 ACT-R
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** Wave X1 — recall-path injection/anomaly/cache-poisoning detection
* **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
* **server,types,adapter:** single cron registry + verify.codebase + all missing §28 crons (Wave Y2)
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **session:** pins + scratchpad + token/turn triggers + linking episode + hot-promote (spec §7)
* **storage:** add listWorkspaceIds() to StorageAdapter port, DrizzleStorageAdapter, InMemoryStorageAdapter
* **tasks:** state-machine guard + delegate + auto-extract + event annotations (spec §18)
* **types,adapter-postgres:** AccessPolicyStore + ApprovalStore ports + adapters (§19)
* **types,adapter-postgres:** hyperedge CRUD port + adapters (Wave D1)
* **types:** 15 spec memory scopes + spec-shaped AgentMemoryAccess/ApprovalTrigger (§6,§19)
* **types:** composition rule DSL schemas + DerivedInference (Wave H1)
* **types:** InMemory adapter Beta-Bernoulli parity (Wave C4)
* **types:** pointerCandidates + upsertFactLsh ports + lsh_upsert outbox event (spec §17)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* Wave T — standards + security hardening
* Wave W Part B — §19 Agent RBAC + Approval Gate + §6 mTLS + Service JWT
* Wave Y — Engram Neuro-Dynamics + Cron Registry (§25/§28)
* Wave Z — Cognitive Completeness (RecMem, UCE, Compression, Governance, Cache)
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-k:** correctness fixes — consolidation gate, worth gate, hyperedge members, delta episodes
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave/p:** Retrieval Tier 2 — POINTER/LSH + fact topic-key upsert
* **webhooks:** HTTP delivery, HMAC signing, CRUD endpoints, DB migration


### Fixed

* **adapter,types:** guard cross-workspace parent lookup in createEpisode
* **core:** §33 — run deterministic consensus on the production fact-write path
* **guard-tests:** add /// &lt;reference types='node' /&gt; to suppress implicit-any in guard tests
* **reasoning:** recordReasoningUse on resolve HIT + InMemory updateWorth/queryReasoning fixes
* **recall-log:** uuid() instead of node:crypto, explicit type cast in recall-cold Stage 4
* **tests:** use allowed relation verb in contract test
* **tests:** use valid UUIDs for workspaceId in contract tests
* **types:** align RelationVerb with SQL schema CHECK constraint
* **types:** mark vitest external in tsup — fixes integration test runner
* **types:** remove duplicate MnemoHyperedge from relations.ts (Wave D TS fix)
* **types:** rename MnemoBusEventType→MnemoEventType
* **v3.1:** wire federation peer dep, fix status docs, complete InMemoryStorageAdapter
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Documentation

* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* fix stale DATA_MODEL_V3.md refs + add bitemporal Cursor rule
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul
