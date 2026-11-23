# Changelog

## 3.6.0-alpha.0 (2026-07-06)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **ci:** wire §29 quality gate — bench:quality script + CI step
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **composition:** lazy-seed built-in composition rules on first workspace write
* **core,server,client-ts:** asOf temporal filter on main graph endpoint
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core:** §17 — hot-tier near-duplicate suppression (embedding-free)
* **core:** §29 — absolute quality gates + v1.6↔v3.0 comparison
* **core:** §29 — deterministic synthetic eval corpus + end-to-end harness
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** add mnemo_semantic_neighbor table (migration 0073)
* **core:** add mnemoSemanticNeighbor drizzle model
* **core:** add modeled per-metric USD cost table + meterEventCostUsd helper (§35, F15)
* **core:** add optional collapse.storage port to CreateCoreOptions
* **core:** add pure resolveCollapsePolicy helper with spec defaults (F2)
* **core:** buildCollapseContext uses injected collapse.storage (v3 RLS path)
* **core:** collapse reads turns via SessionBuffer durable path + clears Redis on success
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** emit composition + rerank child spans in recallCold
* **core:** emit mnemo.embed child span in recall embedding read-through
* **core:** emit task.completed MnemoEvent on auto-extract alongside Episode (F26)
* **core:** encode spec latency budgets as a benchmark gate (hot/warm/cold/write)
* **core:** kNN semantic-neighbor backfill + edge loader
* **core:** lightweight in-process self-edit undo window (revertSelfEdit) (F27)
* **core:** multi-hop temporal relation traversal via recursive CTE
* **core:** P0-4 — wire §33 saveFactWithAutoResolve into the live write path
* **core:** P1/P2 cognitive remediation (workflow, verified green)
* **core:** pure computeAnticipationAccuracy helper reading .id (F1 Bug B)
* **core:** re-export METER_UNIT_COST_USD + meterEventCostUsd from v3 barrel
* **core:** reconstruct compression source via applyDelta over residual deltas (F4)
* **core:** SessionBuffer — write-through Redis L1 session tier over PG
* **core:** set recall result attributes on mnemo.recall span (F18)
* **core:** store residual delta vs reconstructed parent in computeDeltaEpisodeLink (F4)
* **core:** thread semantic edges through graph assembly
* **core:** wire §36 migration reweight (FTS 0.7/vector 0.3) into cold recall (F28 2/2)
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **federation:** honor since cursor for incremental item pulls
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **server:** add /v1/admin/graph/semantic-backfill endpoint
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-1 — benchmark regression gate (tsx + check-regression + baseline + CI job)
* **ver:** VER-3 — recall-quality harness: eval-fixture.json + R@5≥0.95 integration test
* **W0:** Quality Baseline & CI Hard Gate
* **w4:** core cognitive validation + API surface freeze gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **audit:** thread real actor_type through the audit trail
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* complete Mnemosyne remediation phases A-F
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add missing public schema v3 columns via migration 0072
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** collapse reads anticipation .id via pure helper; non-silent catch — F1 Bug B
* **core:** collapseSession fallback close uses ctx.storage (RLS-safe)
* **core:** complete telemetry span mocks broken by A2 child spans (recall-cold)
* **core:** default collapse per-turn mode to 'auto' not invalid 'standard' (F2)
* **core:** fix three fresh-DB crash bugs found by T0.2 empirical audit
* **core:** pass anticipation slot object to workSet (single-encode) — F1 Bug A
* **core:** populate cold-path hit embeddings so RecMem rerank gate can skip the LLM
* **core:** restore DTS build by using .returning() without field selectors
* **gdpr:** SEC-3 — make DEK destruction fatal in GDPR hard-delete path
* **migrations:** legacy public schema v3-compat (worth + sensitivity + api-key cols)
* **migrations:** renumber post-baseline migrations to 0012-0014
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **rdd:** RDD-8 — restore anti-gaming caps (maxStrengthens=3, maxWeakens=5) + per-fact daily strengthen cap
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **sec:** §17/§5 — cold-tier sensitivity leak (viewFact hardcoded "internal")
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **test:** correct apply-governance promote test values (Wilson lower bound fix) + add node ref to cup tests
* **test:** resolve TS errors in hard-delete-gdpr.test.ts
* **tests:** resolve TS errors in procedural.test.ts mock.calls access


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **core:** split factory.ts 2922→1900 lines into 3 focused modules
* **core:** use array form for pgTable extraConfig (non-deprecated)
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **core:** fix worth.ts header to Beta(2,2) posterior mean α/(α+β) (F23)
* **types:** correct stale hyperedge comment + add e2e member-expansion test


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.6.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **ci:** wire §29 quality gate — bench:quality script + CI step
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **composition:** lazy-seed built-in composition rules on first workspace write
* **core,server,client-ts:** asOf temporal filter on main graph endpoint
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core:** §17 — hot-tier near-duplicate suppression (embedding-free)
* **core:** §29 — absolute quality gates + v1.6↔v3.0 comparison
* **core:** §29 — deterministic synthetic eval corpus + end-to-end harness
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** add mnemo_semantic_neighbor table (migration 0073)
* **core:** add mnemoSemanticNeighbor drizzle model
* **core:** add modeled per-metric USD cost table + meterEventCostUsd helper (§35, F15)
* **core:** add optional collapse.storage port to CreateCoreOptions
* **core:** add pure resolveCollapsePolicy helper with spec defaults (F2)
* **core:** buildCollapseContext uses injected collapse.storage (v3 RLS path)
* **core:** collapse reads turns via SessionBuffer durable path + clears Redis on success
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** emit composition + rerank child spans in recallCold
* **core:** emit mnemo.embed child span in recall embedding read-through
* **core:** emit task.completed MnemoEvent on auto-extract alongside Episode (F26)
* **core:** encode spec latency budgets as a benchmark gate (hot/warm/cold/write)
* **core:** kNN semantic-neighbor backfill + edge loader
* **core:** lightweight in-process self-edit undo window (revertSelfEdit) (F27)
* **core:** multi-hop temporal relation traversal via recursive CTE
* **core:** P0-4 — wire §33 saveFactWithAutoResolve into the live write path
* **core:** P1/P2 cognitive remediation (workflow, verified green)
* **core:** pure computeAnticipationAccuracy helper reading .id (F1 Bug B)
* **core:** re-export METER_UNIT_COST_USD + meterEventCostUsd from v3 barrel
* **core:** reconstruct compression source via applyDelta over residual deltas (F4)
* **core:** SessionBuffer — write-through Redis L1 session tier over PG
* **core:** set recall result attributes on mnemo.recall span (F18)
* **core:** store residual delta vs reconstructed parent in computeDeltaEpisodeLink (F4)
* **core:** thread semantic edges through graph assembly
* **core:** wire §36 migration reweight (FTS 0.7/vector 0.3) into cold recall (F28 2/2)
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **federation:** honor since cursor for incremental item pulls
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **server:** add /v1/admin/graph/semantic-backfill endpoint
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-1 — benchmark regression gate (tsx + check-regression + baseline + CI job)
* **ver:** VER-3 — recall-quality harness: eval-fixture.json + R@5≥0.95 integration test
* **W0:** Quality Baseline & CI Hard Gate
* **w4:** core cognitive validation + API surface freeze gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **audit:** thread real actor_type through the audit trail
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* complete Mnemosyne remediation phases A-F
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add missing public schema v3 columns via migration 0072
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** collapse reads anticipation .id via pure helper; non-silent catch — F1 Bug B
* **core:** collapseSession fallback close uses ctx.storage (RLS-safe)
* **core:** complete telemetry span mocks broken by A2 child spans (recall-cold)
* **core:** default collapse per-turn mode to 'auto' not invalid 'standard' (F2)
* **core:** fix three fresh-DB crash bugs found by T0.2 empirical audit
* **core:** pass anticipation slot object to workSet (single-encode) — F1 Bug A
* **core:** populate cold-path hit embeddings so RecMem rerank gate can skip the LLM
* **core:** restore DTS build by using .returning() without field selectors
* **gdpr:** SEC-3 — make DEK destruction fatal in GDPR hard-delete path
* **migrations:** legacy public schema v3-compat (worth + sensitivity + api-key cols)
* **migrations:** renumber post-baseline migrations to 0012-0014
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **rdd:** RDD-8 — restore anti-gaming caps (maxStrengthens=3, maxWeakens=5) + per-fact daily strengthen cap
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **sec:** §17/§5 — cold-tier sensitivity leak (viewFact hardcoded "internal")
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **test:** correct apply-governance promote test values (Wilson lower bound fix) + add node ref to cup tests
* **test:** resolve TS errors in hard-delete-gdpr.test.ts
* **tests:** resolve TS errors in procedural.test.ts mock.calls access


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **core:** split factory.ts 2922→1900 lines into 3 focused modules
* **core:** use array form for pgTable extraConfig (non-deprecated)
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **core:** fix worth.ts header to Beta(2,2) posterior mean α/(α+β) (F23)
* **types:** correct stale hyperedge comment + add e2e member-expansion test


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.5.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.4:** embedding-model migration engine
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **ci:** wire §29 quality gate — bench:quality script + CI step
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **composition:** lazy-seed built-in composition rules on first workspace write
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core:** §17 — hot-tier near-duplicate suppression (embedding-free)
* **core:** §29 — absolute quality gates + v1.6↔v3.0 comparison
* **core:** §29 — deterministic synthetic eval corpus + end-to-end harness
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** add modeled per-metric USD cost table + meterEventCostUsd helper (§35, F15)
* **core:** add optional collapse.storage port to CreateCoreOptions
* **core:** add pure resolveCollapsePolicy helper with spec defaults (F2)
* **core:** buildCollapseContext uses injected collapse.storage (v3 RLS path)
* **core:** collapse reads turns via SessionBuffer durable path + clears Redis on success
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** emit composition + rerank child spans in recallCold
* **core:** emit mnemo.embed child span in recall embedding read-through
* **core:** emit task.completed MnemoEvent on auto-extract alongside Episode (F26)
* **core:** encode spec latency budgets as a benchmark gate (hot/warm/cold/write)
* **core:** lightweight in-process self-edit undo window (revertSelfEdit) (F27)
* **core:** P0-4 — wire §33 saveFactWithAutoResolve into the live write path
* **core:** P1/P2 cognitive remediation (workflow, verified green)
* **core:** pure computeAnticipationAccuracy helper reading .id (F1 Bug B)
* **core:** re-export METER_UNIT_COST_USD + meterEventCostUsd from v3 barrel
* **core:** reconstruct compression source via applyDelta over residual deltas (F4)
* **core:** SessionBuffer — write-through Redis L1 session tier over PG
* **core:** set recall result attributes on mnemo.recall span (F18)
* **core:** store residual delta vs reconstructed parent in computeDeltaEpisodeLink (F4)
* **core:** wire §36 migration reweight (FTS 0.7/vector 0.3) into cold recall (F28 2/2)
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* **federation:** honor since cursor for incremental item pulls
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-1 — benchmark regression gate (tsx + check-regression + baseline + CI job)
* **ver:** VER-3 — recall-quality harness: eval-fixture.json + R@5≥0.95 integration test
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
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **audit:** thread real actor_type through the audit trail
* **c11:** wire propagateTdCredit in collapseSession
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add missing public schema v3 columns via migration 0072
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** collapse reads anticipation .id via pure helper; non-silent catch — F1 Bug B
* **core:** collapseSession fallback close uses ctx.storage (RLS-safe)
* **core:** complete telemetry span mocks broken by A2 child spans (recall-cold)
* **core:** default collapse per-turn mode to 'auto' not invalid 'standard' (F2)
* **core:** pass anticipation slot object to workSet (single-encode) — F1 Bug A
* **core:** populate cold-path hit embeddings so RecMem rerank gate can skip the LLM
* **core:** restore DTS build by using .returning() without field selectors
* **gdpr:** SEC-3 — make DEK destruction fatal in GDPR hard-delete path
* **migrations:** legacy public schema v3-compat (worth + sensitivity + api-key cols)
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **rdd:** RDD-8 — restore anti-gaming caps (maxStrengthens=3, maxWeakens=5) + per-fact daily strengthen cap
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **sec:** §17/§5 — cold-tier sensitivity leak (viewFact hardcoded "internal")
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **test:** correct apply-governance promote test values (Wilson lower bound fix) + add node ref to cup tests
* **test:** resolve TS errors in hard-delete-gdpr.test.ts
* **tests:** resolve TS errors in procedural.test.ts mock.calls access
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **core:** split factory.ts 2922→1900 lines into 3 focused modules
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **core:** fix worth.ts header to Beta(2,2) posterior mean α/(α+β) (F23)
* **types:** correct stale hyperedge comment + add e2e member-expansion test


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.4.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.4:** embedding-model migration engine
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **ci:** wire §29 quality gate — bench:quality script + CI step
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **composition:** lazy-seed built-in composition rules on first workspace write
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** hybridRecallWeights helper + RecallQuery.embeddingMigrationActive (F28 1/2)
* **core:** §17 — hot-tier near-duplicate suppression (embedding-free)
* **core:** §29 — absolute quality gates + v1.6↔v3.0 comparison
* **core:** §29 — deterministic synthetic eval corpus + end-to-end harness
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** add modeled per-metric USD cost table + meterEventCostUsd helper (§35, F15)
* **core:** add optional collapse.storage port to CreateCoreOptions
* **core:** add pure resolveCollapsePolicy helper with spec defaults (F2)
* **core:** buildCollapseContext uses injected collapse.storage (v3 RLS path)
* **core:** collapse reads turns via SessionBuffer durable path + clears Redis on success
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** emit composition + rerank child spans in recallCold
* **core:** emit mnemo.embed child span in recall embedding read-through
* **core:** emit task.completed MnemoEvent on auto-extract alongside Episode (F26)
* **core:** encode spec latency budgets as a benchmark gate (hot/warm/cold/write)
* **core:** lightweight in-process self-edit undo window (revertSelfEdit) (F27)
* **core:** P0-4 — wire §33 saveFactWithAutoResolve into the live write path
* **core:** P1/P2 cognitive remediation (workflow, verified green)
* **core:** pure §34.8 queue priority map + 3-stage shedding decision
* **core:** pure computeAnticipationAccuracy helper reading .id (F1 Bug B)
* **core:** re-export METER_UNIT_COST_USD + meterEventCostUsd from v3 barrel
* **core:** reconstruct compression source via applyDelta over residual deltas (F4)
* **core:** SessionBuffer — write-through Redis L1 session tier over PG
* **core:** set recall result attributes on mnemo.recall span (F18)
* **core:** store residual delta vs reconstructed parent in computeDeltaEpisodeLink (F4)
* **core:** wire §36 migration reweight (FTS 0.7/vector 0.3) into cold recall (F28 2/2)
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* **federation:** honor since cursor for incremental item pulls
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-1 — benchmark regression gate (tsx + check-regression + baseline + CI job)
* **ver:** VER-3 — recall-quality harness: eval-fixture.json + R@5≥0.95 integration test
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
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **audit:** thread real actor_type through the audit trail
* **c11:** wire propagateTdCredit in collapseSession
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add missing public schema v3 columns via migration 0072
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** collapse reads anticipation .id via pure helper; non-silent catch — F1 Bug B
* **core:** collapseSession fallback close uses ctx.storage (RLS-safe)
* **core:** complete telemetry span mocks broken by A2 child spans (recall-cold)
* **core:** default collapse per-turn mode to 'auto' not invalid 'standard' (F2)
* **core:** pass anticipation slot object to workSet (single-encode) — F1 Bug A
* **core:** populate cold-path hit embeddings so RecMem rerank gate can skip the LLM
* **core:** restore DTS build by using .returning() without field selectors
* **gdpr:** SEC-3 — make DEK destruction fatal in GDPR hard-delete path
* **migrations:** legacy public schema v3-compat (worth + sensitivity + api-key cols)
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **rdd:** RDD-8 — restore anti-gaming caps (maxStrengthens=3, maxWeakens=5) + per-fact daily strengthen cap
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* **sec:** §17/§5 — cold-tier sensitivity leak (viewFact hardcoded "internal")
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **test:** correct apply-governance promote test values (Wilson lower bound fix) + add node ref to cup tests
* **test:** resolve TS errors in hard-delete-gdpr.test.ts
* **tests:** resolve TS errors in procedural.test.ts mock.calls access
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **core:** split factory.ts 2922→1900 lines into 3 focused modules
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **core:** fix worth.ts header to Beta(2,2) posterior mean α/(α+β) (F23)
* **types:** correct stale hyperedge comment + add e2e member-expansion test


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.3.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **ci:** wire §29 quality gate — bench:quality script + CI step
* **composition:** lazy-seed built-in composition rules on first workspace write
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance


### Fixed

* **audit:** thread real actor_type through the audit trail
* **migrations:** legacy public schema v3-compat (worth + sensitivity + api-key cols)
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.4:** embedding-model migration engine
* **adapter,core:** LSH population path — remember→outbox→worker→mnemo_fact_lsh (spec §17)
* **anticipation:** 4-way blend + conditional/co-occurrence patterns + pre-injection (spec §30)
* **auth:** add key expiry + scope enforcement (P0.1 + P0.3)
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **cache:** §9 L2/L3 cache layers + Redis-down degradation ladder
* **core,adapter:** entity-keyed confidence map + coverage/freshness + trends + strengths + suggestedAction (spec §31)
* **core,governance:** §11 promote/demote/canonical actions + max-5-hop TD + governance.propagate
* **core,types,adapter:** kind-differentiated decay + Hebbian STDP/homeostatic (Wave Y1, §25.2/§25.3)
* **core,types,adapter:** materialiseInference port + composition engine (Wave H2)
* **core,types,adapter:** TD(λ) propagation + Wilson-score lower bound (Wave J3)
* **core,types,redis:** monotonic event ids + Redis-list replay buffer ops (§35)
* **core,types:** compositionality relation/fact_value DSL + multi-hop + warnings + conflicts + 4 seed rules (spec §32)
* **core,types:** hyperedge expansion in recall-cold stage 3b + outbox bump (Wave D4)
* **core,types:** wire composition hook into recall-cold; extend RecallHit/RecallResponse (Wave H3)
* **core:** §17 — hot-tier near-duplicate suppression (embedding-free)
* **core:** §29 — absolute quality gates + v1.6↔v3.0 comparison
* **core:** §29 — deterministic synthetic eval corpus + end-to-end harness
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** buildAnticipationFeed — anticipation envelope (Wave G3)
* **core:** buildSelfModel — §31 meta-cognition envelope (Wave F3)
* **core:** composition hook on hot-tier recall path (Wave J2)
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** enforce worth serving gate + λ-drift time decay (spec §11)
* **core:** Experience-Compression cross-level episode-subtree compression (spec §2)
* **core:** fact topic-key idempotent upsert mirroring decision.ts (spec §25.4)
* **core:** hyperedge recall includes members (spec §15)
* **core:** L0 working memory — workGet/Set/Checkpoint/bloom/rateLimit (spec §9)
* **core:** P0-4 — wire §33 saveFactWithAutoResolve into the live write path
* **core:** P1/P2 cognitive remediation (workflow, verified green)
* **core:** pure §34.8 queue priority map + 3-stage shedding decision
* **core:** pure in-process typed event bus (spec §4)
* **core:** pure RBAC decision engine + namespace policies (§19)
* **core:** pure SimHash LSH banding over first 64 Matryoshka dims (spec §17)
* **core:** service-to-service federation JWT (EdDSA) + jti replay-prevention (§6)
* **core:** Tier 2 pointer recall + CALMem token-budget pre-stage (spec §17)
* **core:** UCE knowledge-type scheduler + collapse extraction bias (spec §10,§7)
* **core:** unify RecMem recurrence gate + add gated recall rerank (spec §1/§2,§7)
* **core:** wire session collapse pipeline — replace stub with 8-step collapse.ts call
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* extend PrimitiveKind with hyperedge + updateWorth support (Wave D5)
* **federation,core:** §33 complete — resolveConflict 4 rules + federatedConsensus contested + saveFactWithAutoResolve
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* **pii:** NER layer (Phase 5.2) + LLM layer (Phase 5.3) for PII detection
* **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
* **reasoning:** CoT distillation cache loop — resolve/record/feedback + quarantine/golden (spec §8)
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall-log:** TASK-4001 — mnemo_recall_log, port methods, DrizzleStorageAdapter, Stage 4 ACT-R
* **reminders:** 30s background evaluation polling — time-based auto-trigger
* **security:** P0.1+P0.3+P0.2+P0.4+P1.2+P1.3+P1.4 — full security hardening sprint
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **security:** sensitivity ceiling on GET /facts routes (P0.2)
* **security:** Wave X1 — recall-path injection/anomaly/cache-poisoning detection
* **security:** Wave X2 — access-path detection, export approval gate, GDPR hard delete
* **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
* **session:** pins + scratchpad + token/turn triggers + linking episode + hot-promote (spec §7)
* **session:** wire session routes + patchFact in PATCH /memory/:id
* **tasks:** state-machine guard + delegate + auto-extract + event annotations (spec §18)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-1 — benchmark regression gate (tsx + check-regression + baseline + CI job)
* **ver:** VER-3 — recall-quality harness: eval-fixture.json + R@5≥0.95 integration test
* Wave T — standards + security hardening
* Wave W Part A — §33 Distributed Consensus + §20 Federation Protocol core
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
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **wave/p:** Retrieval Tier 2 — POINTER/LSH + fact topic-key upsert


### Fixed

* §15 Hebbian relation weight (wrong relation) · §31 introspect limit (MCP+client)
* **c11:** wire propagateTdCredit in collapseSession
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* **core,adapter:** quality review fixes — correct LSH embedding indexing, embed-error fallback, outbox guard
* **core,adapter:** remove stale createHash import, fix unused e var, use array form for Drizzle table config
* **core,federation:** decideAutoResolution explicit confidence gate + zero-llm fix
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add node types to tsconfig to resolve Buffer TS errors
* **core:** enforce sensitivity ceiling in the hot tier (recall-hot)
* **core:** handle concurrent topicKey upsert race + index predicate audit
* **core:** LSH planes must be 64-dim not 8-dim (spec §17)
* **core:** remove unused hotTierKey import in recall-hot-composition.test.ts
* **core:** restore DTS build by using .returning() without field selectors
* **core:** wire maybeRerank into recallCold pipeline (spec Z-A1.3 Step 12)
* **CRIT-01:** standardize GUC name to mnemosyne.workspace_id in tx.ts
* **gdpr:** SEC-3 — make DEK destruction fatal in GDPR hard-delete path
* **guard-tests:** add /// &lt;reference types='node' /&gt; to suppress implicit-any in guard tests
* **rdd:** RDD-8 — restore anti-gaming caps (maxStrengthens=3, maxWeakens=5) + per-fact daily strengthen cap
* **recall-log:** uuid() instead of node:crypto, explicit type cast in recall-cold Stage 4
* **sec:** §17/§5 — cold-tier sensitivity leak (viewFact hardcoded "internal")
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **self-edit:** enforce requireReason in evaluateSelfEdit at policy layer
* **self-edit:** quality fixes — Map pruning, cadence exact-match, profile strengthen guard, reason forwarding, Span stub shape
* **self-edit:** remove unused policy param from applySelfEdit
* **self-edit:** scope editsBySession/deletesByDay per mountSelf call for test isolation + fix countsAsEdit bug
* **test:** correct apply-governance promote test values (Wilson lower bound fix) + add node ref to cup tests
* **test:** resolve TS errors in hard-delete-gdpr.test.ts
* **tests:** resolve TS errors in procedural.test.ts mock.calls access
* **types:** align RelationVerb with SQL schema CHECK constraint
* **types:** remove unused sql import; fix node type resolution in test files (Wave E post)
* **types:** rename MnemoBusEventType→MnemoEventType
* **wave-ad:** wire all critical boot deps + fix monorepo build
* **wave-f:** replace inline import() types with top-level imports; remove unused ConfidenceMapRow import
* **wave-x:** spec gap fixes — score demotion, anomaly outbox ordering, InjectionScore export, missing tests


### Changed

* **core:** remove as-any casts in expandHyperedgeMembers


### Documentation

* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* fix stale DATA_MODEL_V3.md refs + add bitemporal Cursor rule
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.1.0-alpha.0

## 2.4.0-alpha.0 (2026-06-13)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* **graph:** port newer Memory Graph from Orchester — client/server split
* per-workspace LLM provider config (migration 0065)
* **session:** wire session routes + patchFact in PATCH /memory/:id
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* **core:** add node types to tsconfig to resolve Buffer TS errors
* **core:** factory.recall mapper reads h.fact.{id,statement} not raw top-level
* **CRIT-01:** standardize GUC name to mnemosyne.workspace_id in tx.ts
* **db:** add missing confidence column to mnemo_decision (0064)
* **docker:** update create-api-key.js references to .cjs
* **guard-tests:** add /// &lt;reference types='node' /&gt; to suppress implicit-any in guard tests
* **migration:** make 0065 idempotent (DROP POLICY IF EXISTS, DROP TRIGGER IF EXISTS)
* **migrations:** CREATE EXTENSION vector in 0015 so 0016+ can declare columns of type vector(N)
* **migrations:** make the full stream portable — verified against live pgvector
* resolve all 22 audit findings (6 critical) — green build + tests
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector
* **server:** accept seed-style ids on entity/episode/review routes + fix entity-facts 500
* **types:** align RelationVerb with SQL schema CHECK constraint


### Documentation

* unify repo — remove v3 fragmentation, mega README overhaul

## 2.3.0-alpha.0 (2026-06-13)


### Added

* **session:** wire session routes + patchFact in PATCH /memory/:id


### Fixed

* **core:** add node types to tsconfig to resolve Buffer TS errors
* **CRIT-01:** standardize GUC name to mnemosyne.workspace_id in tx.ts
* **guard-tests:** add /// &lt;reference types='node' /&gt; to suppress implicit-any in guard tests
* **server:** accept seed-style ids on entity/episode/review routes + fix entity-facts 500
* **types:** align RelationVerb with SQL schema CHECK constraint


### Documentation

* unify repo — remove v3 fragmentation, mega README overhaul

## 2.2.0-alpha.0 (2026-06-11)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* **graph:** port newer Memory Graph from Orchester — client/server split
* per-workspace LLM provider config (migration 0065)
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* **core:** factory.recall mapper reads h.fact.{id,statement} not raw top-level
* **db:** add missing confidence column to mnemo_decision (0064)
* **docker:** update create-api-key.js references to .cjs
* **migration:** make 0065 idempotent (DROP POLICY IF EXISTS, DROP TRIGGER IF EXISTS)
* **migrations:** CREATE EXTENSION vector in 0015 so 0016+ can declare columns of type vector(N)
* **migrations:** make the full stream portable — verified against live pgvector
* resolve all 22 audit findings (6 critical) — green build + tests
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector

## 2.1.0-alpha.0 (2026-06-07)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* **graph:** port newer Memory Graph from Orchester — client/server split
* per-workspace LLM provider config (migration 0065)
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* **core:** factory.recall mapper reads h.fact.{id,statement} not raw top-level
* **db:** add missing confidence column to mnemo_decision (0064)
* **docker:** update create-api-key.js references to .cjs
* **migration:** make 0065 idempotent (DROP POLICY IF EXISTS, DROP TRIGGER IF EXISTS)
* **migrations:** CREATE EXTENSION vector in 0015 so 0016+ can declare columns of type vector(N)
* **migrations:** make the full stream portable — verified against live pgvector
* resolve all 22 audit findings (6 critical) — green build + tests
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector
