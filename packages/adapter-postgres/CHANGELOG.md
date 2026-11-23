# Changelog

## Unreleased

### Note for databases that applied migration 0060 between 36518b34 and 5745e19e

`0060_instance_metrics.sql` was edited in place six minutes after its first commit
(`36518b34`, fixed in `5745e19e`, both on main, 2026-11-17): the fix makes
`mnemo_instance_workspace_figures` take the last write only from live facts the caller can
read. A database that ran the first version keeps that older function and stores checksum
`a0dbb0e66793…`; the runner now refuses to start on it ("Migration 0060_instance_metrics.sql
was modified after being applied"). Databases that first migrated at `5745e19e` or later are
fine (checksum `aef67b015c57…`). To bring an affected database to the final version, as the
migration role:

```bash
psql "$MNEMO_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f packages/adapter-postgres/migrations/baseline/0060_instance_metrics.down.sql \
  -f packages/adapter-postgres/migrations/baseline/0060_instance_metrics.sql \
  -c "UPDATE mnemosyne.schema_migrations SET checksum = 'aef67b015c57890918cfbc5453959d0bf27b07d5551eebef4e3e21eb37813052' WHERE filename = '0060_instance_metrics.sql'"
```

From now on a pushed migration is never edited; a correction goes in the next number (see the
README, "Running Migrations").

## 3.6.0-alpha.0 (2026-07-06)


### Added

* **adapter-postgres:** add DrizzleIdempotencyStore.reap() (RLS-safe, non-superuser)
* **adapter-postgres:** add durable mnemo_meter_event table (RLS+BRIN+idempotency) (F15, §35)
* **adapter-postgres:** break-glass two-person request table (F10)
* **adapter-postgres:** DrizzleBreakGlassStore with two-person guard (F10)
* **adapter-postgres:** export DrizzleBreakGlassStore (F10)
* **adapter-postgres:** fold episode residual deltas via applyDelta on reconstruct (F4)
* **adapter-postgres:** GUC-configurable anticipation MV windows, defaults preserved (F21)
* **adapter-postgres:** implement appendMeterEvent + DB-sourced spend/usage queries (F15)
* **adapter-postgres:** implement DrizzleSyncStorage.markSuperseded (RLS-safe federation merge)
* **adapter-postgres:** migration 0073 sync supersession-chain table
* **adapter-postgres:** MNEMO_DEPLOY_MODE-aware pool sizing (embedded/standalone/ha)
* **adapter-postgres:** P0-2 vB — production DrizzleApiKeyStore + migration 0055
* **adapter-postgres:** P2 — apply procedural/reasoning Beta decay + migration 0053
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **ci:** OPS-8 — migration safety linter covers full committed v3 set
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** add tenant/user/workspace tables + scope_owner field (Gap 1+2+3)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **server:** emit queue_depth gauge from pending outbox count
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-pg:** episode_id nullable + schema-qualify mnemo_set_workspace
* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **adapter-postgres:** C1 — correct DEK encoding, outbox plaintext leak, workspace-scope DEK pk
* **adapter-postgres:** encrypt audit detail with actor DEK + crypto-erasure read state (C3)
* **adapter-postgres:** exclude *.down.sql from the forward migration runner (data-loss guard)
* **adapter-postgres:** GRANT SELECT on mnemo_outbox to mnemo_app_role (queue_depth gauge)
* **adapter-postgres:** implement updateSessionSummary so collapse summary persists (C5)
* **adapter-postgres:** logRecall writes fact_id(TEXT)+activation_score (C4)
* **adapter-postgres:** migration linter exempts CREATE INDEX on same-migration new tables
* **adapter-postgres:** OutboxWorker silently no-ops due to snake_case/camelCase mismatch
* **adapter-postgres:** populate materialized views on fresh install (F4)
* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **adapter-postgres:** query mnemo_fact (not mnemo_facts) in listWorkspaceIds
* **adapter-postgres:** rename outbox payload key statement→text in createFact
* **adapter-postgres:** serialize audit appends + hash only spec fields (C2)
* **adapter-postgres:** serve Beta-Bernoulli worth for strategy/workflow/skill/reasoning (C7)
* **audit:** thread real actor_type through the audit trail
* **ci:** add vector extension + missing api_key columns to squash baseline
* **ci:** align vitest versions — coverage-v8@4.1.9 requires vitest@4.1.9
* **ci:** correct migration numbering to restore gap-free sequence 1-5
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** grant USAGE on mnemosyne schema directly to app_user
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** pin vitest@4.1.9 in adapter-postgres to match coverage-v8@4.1.9
* **ci:** rename 0004 migration to 0005 to avoid duplicate prefix
* **ci:** rename migration 0004→0005 to resolve prefix collision
* **ci:** resolve both adapter and server integration test failures
* **ci:** restore 0004 prefix on schema-access migration
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* complete Mnemosyne remediation phases A-F
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** fix three fresh-DB crash bugs found by T0.2 empirical audit
* **migration:** 0054 down — add migrate:allow-drop marker for the safety linter
* **migrations:** 0002 handles duplicate table when 0001 baseline already created it in mnemosyne
* **migrations:** 0056 episode index plain CREATE INDEX + linter allow-marker (fixes CI integration)
* **migrations:** add scope_owner column to mnemosyne.mnemo_fact (0007)
* **migrations:** grant SELECT to mnemo_owner on v3 tables + update-checksums command
* **migrations:** recreate mv_confidence_map and mv_knowledge_gaps dropped by CASCADE
* **migrations:** regenerate squash baseline from pg_dump of 75 pre-squash migrations
* **migrations:** renumber post-baseline migrations to 0012-0014
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **procedural:** monotonic prompt versioning + session A/B stamping
* **rdd:** RDD-7 — correct composition rule verbs and confidences to spec
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* resolve 2 pre-existing test failures blocking green gate
* **rls:** grant DML on public.mnemo_semantic_neighbor to mnemo_app_role
* **sec:** §5 — Merkle audit hash commits to userAgent/metadata/timestamp
* **sec:** P0-6 — idempotency begin() correctly rejects concurrent duplicates
* **security:** C1 cross-tenant authz, C2+H2 RLS policies, H3 pepper guard, 3 CI no-ops, 4 silent failures
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics


### Changed

* **adapter-postgres:** explode DrizzleStorageAdapter 5582→507 lines
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.6.0-alpha.0
    * @mnemo-ai/types bumped to 3.6.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)


### Added

* **adapter-postgres:** add DrizzleIdempotencyStore.reap() (RLS-safe, non-superuser)
* **adapter-postgres:** add durable mnemo_meter_event table (RLS+BRIN+idempotency) (F15, §35)
* **adapter-postgres:** break-glass two-person request table (F10)
* **adapter-postgres:** DrizzleBreakGlassStore with two-person guard (F10)
* **adapter-postgres:** export DrizzleBreakGlassStore (F10)
* **adapter-postgres:** fold episode residual deltas via applyDelta on reconstruct (F4)
* **adapter-postgres:** GUC-configurable anticipation MV windows, defaults preserved (F21)
* **adapter-postgres:** implement appendMeterEvent + DB-sourced spend/usage queries (F15)
* **adapter-postgres:** implement DrizzleSyncStorage.markSuperseded (RLS-safe federation merge)
* **adapter-postgres:** migration 0073 sync supersession-chain table
* **adapter-postgres:** MNEMO_DEPLOY_MODE-aware pool sizing (embedded/standalone/ha)
* **adapter-postgres:** P0-2 vB — production DrizzleApiKeyStore + migration 0055
* **adapter-postgres:** P2 — apply procedural/reasoning Beta decay + migration 0053
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **ci:** OPS-8 — migration safety linter covers full committed v3 set
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** add tenant/user/workspace tables + scope_owner field (Gap 1+2+3)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **server:** emit queue_depth gauge from pending outbox count
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-pg:** episode_id nullable + schema-qualify mnemo_set_workspace
* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **adapter-postgres:** C1 — correct DEK encoding, outbox plaintext leak, workspace-scope DEK pk
* **adapter-postgres:** encrypt audit detail with actor DEK + crypto-erasure read state (C3)
* **adapter-postgres:** exclude *.down.sql from the forward migration runner (data-loss guard)
* **adapter-postgres:** GRANT SELECT on mnemo_outbox to mnemo_app_role (queue_depth gauge)
* **adapter-postgres:** implement updateSessionSummary so collapse summary persists (C5)
* **adapter-postgres:** logRecall writes fact_id(TEXT)+activation_score (C4)
* **adapter-postgres:** migration linter exempts CREATE INDEX on same-migration new tables
* **adapter-postgres:** OutboxWorker silently no-ops due to snake_case/camelCase mismatch
* **adapter-postgres:** populate materialized views on fresh install (F4)
* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **adapter-postgres:** query mnemo_fact (not mnemo_facts) in listWorkspaceIds
* **adapter-postgres:** rename outbox payload key statement→text in createFact
* **adapter-postgres:** serialize audit appends + hash only spec fields (C2)
* **adapter-postgres:** serve Beta-Bernoulli worth for strategy/workflow/skill/reasoning (C7)
* **audit:** thread real actor_type through the audit trail
* **ci:** add vector extension + missing api_key columns to squash baseline
* **ci:** align vitest versions — coverage-v8@4.1.9 requires vitest@4.1.9
* **ci:** correct migration numbering to restore gap-free sequence 1-5
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** grant USAGE on mnemosyne schema directly to app_user
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** pin vitest@4.1.9 in adapter-postgres to match coverage-v8@4.1.9
* **ci:** rename 0004 migration to 0005 to avoid duplicate prefix
* **ci:** rename migration 0004→0005 to resolve prefix collision
* **ci:** resolve both adapter and server integration test failures
* **ci:** restore 0004 prefix on schema-access migration
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* complete Mnemosyne remediation phases A-F
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **core:** fix three fresh-DB crash bugs found by T0.2 empirical audit
* **migration:** 0054 down — add migrate:allow-drop marker for the safety linter
* **migrations:** 0002 handles duplicate table when 0001 baseline already created it in mnemosyne
* **migrations:** 0056 episode index plain CREATE INDEX + linter allow-marker (fixes CI integration)
* **migrations:** add scope_owner column to mnemosyne.mnemo_fact (0007)
* **migrations:** grant SELECT to mnemo_owner on v3 tables + update-checksums command
* **migrations:** recreate mv_confidence_map and mv_knowledge_gaps dropped by CASCADE
* **migrations:** regenerate squash baseline from pg_dump of 75 pre-squash migrations
* **migrations:** renumber post-baseline migrations to 0012-0014
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **procedural:** monotonic prompt versioning + session A/B stamping
* **rdd:** RDD-7 — correct composition rule verbs and confidences to spec
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* resolve 2 pre-existing test failures blocking green gate
* **rls:** grant DML on public.mnemo_semantic_neighbor to mnemo_app_role
* **sec:** §5 — Merkle audit hash commits to userAgent/metadata/timestamp
* **sec:** P0-6 — idempotency begin() correctly rejects concurrent duplicates
* **security:** C1 cross-tenant authz, C2+H2 RLS policies, H3 pepper guard, 3 CI no-ops, 4 silent failures
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics


### Changed

* **adapter-postgres:** explode DrizzleStorageAdapter 5582→507 lines
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.5.0-alpha.0
    * @mnemo-ai/types bumped to 3.5.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)


### Added

* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter-postgres:** add DrizzleIdempotencyStore.reap() (RLS-safe, non-superuser)
* **adapter-postgres:** add durable mnemo_meter_event table (RLS+BRIN+idempotency) (F15, §35)
* **adapter-postgres:** break-glass two-person request table (F10)
* **adapter-postgres:** DrizzleBreakGlassStore with two-person guard (F10)
* **adapter-postgres:** export DrizzleBreakGlassStore (F10)
* **adapter-postgres:** fold episode residual deltas via applyDelta on reconstruct (F4)
* **adapter-postgres:** GUC-configurable anticipation MV windows, defaults preserved (F21)
* **adapter-postgres:** implement appendMeterEvent + DB-sourced spend/usage queries (F15)
* **adapter-postgres:** implement DrizzleSyncStorage.markSuperseded (RLS-safe federation merge)
* **adapter-postgres:** migration 0073 sync supersession-chain table
* **adapter-postgres:** MNEMO_DEPLOY_MODE-aware pool sizing (embedded/standalone/ha)
* **adapter-postgres:** P0-2 vB — production DrizzleApiKeyStore + migration 0055
* **adapter-postgres:** P2 — apply procedural/reasoning Beta decay + migration 0053
* **adapter-postgres:** zero-downtime migration safety — 5-check linter + no-transaction runner + CI shadow-apply (spec §35)
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **ci:** OPS-8 — migration safety linter covers full committed v3 set
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** add tenant/user/workspace tables + scope_owner field (Gap 1+2+3)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server:** emit queue_depth gauge from pending outbox count
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* Wave T — standards + security hardening
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **adapter-postgres:** C1 — correct DEK encoding, outbox plaintext leak, workspace-scope DEK pk
* **adapter-postgres:** encrypt audit detail with actor DEK + crypto-erasure read state (C3)
* **adapter-postgres:** exclude *.down.sql from the forward migration runner (data-loss guard)
* **adapter-postgres:** GRANT SELECT on mnemo_outbox to mnemo_app_role (queue_depth gauge)
* **adapter-postgres:** implement updateSessionSummary so collapse summary persists (C5)
* **adapter-postgres:** logRecall writes fact_id(TEXT)+activation_score (C4)
* **adapter-postgres:** migration linter exempts CREATE INDEX on same-migration new tables
* **adapter-postgres:** OutboxWorker silently no-ops due to snake_case/camelCase mismatch
* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **adapter-postgres:** query mnemo_fact (not mnemo_facts) in listWorkspaceIds
* **adapter-postgres:** rename outbox payload key statement→text in createFact
* **adapter-postgres:** serialize audit appends + hash only spec fields (C2)
* **adapter-postgres:** serve Beta-Bernoulli worth for strategy/workflow/skill/reasoning (C7)
* **audit:** thread real actor_type through the audit trail
* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** add vector extension + missing api_key columns to squash baseline
* **ci:** align vitest versions — coverage-v8@4.1.9 requires vitest@4.1.9
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** pin vitest@4.1.9 in adapter-postgres to match coverage-v8@4.1.9
* **ci:** resolve both adapter and server integration test failures
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **migration:** 0054 down — add migrate:allow-drop marker for the safety linter
* **migrations:** 0002 handles duplicate table when 0001 baseline already created it in mnemosyne
* **migrations:** 0056 episode index plain CREATE INDEX + linter allow-marker (fixes CI integration)
* **migrations:** add scope_owner column to mnemosyne.mnemo_fact (0007)
* **migrations:** grant SELECT to mnemo_owner on v3 tables + update-checksums command
* **migrations:** recreate mv_confidence_map and mv_knowledge_gaps dropped by CASCADE
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **procedural:** monotonic prompt versioning + session A/B stamping
* **rdd:** RDD-7 — correct composition rule verbs and confidences to spec
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* resolve 2 pre-existing test failures blocking green gate
* **sec:** §5 — Merkle audit hash commits to userAgent/metadata/timestamp
* **sec:** P0-6 — idempotency begin() correctly rejects concurrent duplicates
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Changed

* **adapter-postgres:** explode DrizzleStorageAdapter 5582→507 lines
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.4.0-alpha.0
    * @mnemo-ai/types bumped to 3.4.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter-postgres:** add DrizzleIdempotencyStore.reap() (RLS-safe, non-superuser)
* **adapter-postgres:** add durable mnemo_meter_event table (RLS+BRIN+idempotency) (F15, §35)
* **adapter-postgres:** break-glass two-person request table (F10)
* **adapter-postgres:** DrizzleBreakGlassStore with two-person guard (F10)
* **adapter-postgres:** export DrizzleBreakGlassStore (F10)
* **adapter-postgres:** fold episode residual deltas via applyDelta on reconstruct (F4)
* **adapter-postgres:** GUC-configurable anticipation MV windows, defaults preserved (F21)
* **adapter-postgres:** implement appendMeterEvent + DB-sourced spend/usage queries (F15)
* **adapter-postgres:** implement DrizzleSyncStorage.markSuperseded (RLS-safe federation merge)
* **adapter-postgres:** migration 0073 sync supersession-chain table
* **adapter-postgres:** MNEMO_DEPLOY_MODE-aware pool sizing (embedded/standalone/ha)
* **adapter-postgres:** P0-2 vB — production DrizzleApiKeyStore + migration 0055
* **adapter-postgres:** P2 — apply procedural/reasoning Beta decay + migration 0053
* **adapter-postgres:** zero-downtime migration safety — 5-check linter + no-transaction runner + CI shadow-apply (spec §35)
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **ci:** OPS-8 — migration safety linter covers full committed v3 set
* **composition:** lazy-seed built-in composition rules on first workspace write
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* **idempotency:** recovery_point port methods + Drizzle impl (spec §RDD9)
* **multi-tenant:** add tenant/user/workspace tables + scope_owner field (Gap 1+2+3)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** RLS policies for tenant/user/workspace tables + withMnemoTenantTx
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server:** emit queue_depth gauge from pending outbox count
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **W0:** Quality Baseline & CI Hard Gate
* Wave T — standards + security hardening
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** add mnemo_set_workspace GUC to session read methods
* **adapter-postgres:** C1 — correct DEK encoding, outbox plaintext leak, workspace-scope DEK pk
* **adapter-postgres:** encrypt audit detail with actor DEK + crypto-erasure read state (C3)
* **adapter-postgres:** exclude *.down.sql from the forward migration runner (data-loss guard)
* **adapter-postgres:** GRANT SELECT on mnemo_outbox to mnemo_app_role (queue_depth gauge)
* **adapter-postgres:** implement updateSessionSummary so collapse summary persists (C5)
* **adapter-postgres:** logRecall writes fact_id(TEXT)+activation_score (C4)
* **adapter-postgres:** migration linter exempts CREATE INDEX on same-migration new tables
* **adapter-postgres:** OutboxWorker silently no-ops due to snake_case/camelCase mismatch
* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **adapter-postgres:** query mnemo_fact (not mnemo_facts) in listWorkspaceIds
* **adapter-postgres:** rename outbox payload key statement→text in createFact
* **adapter-postgres:** serialize audit appends + hash only spec fields (C2)
* **adapter-postgres:** serve Beta-Bernoulli worth for strategy/workflow/skill/reasoning (C7)
* **audit:** thread real actor_type through the audit trail
* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** add vector extension + missing api_key columns to squash baseline
* **ci:** align vitest versions — coverage-v8@4.1.9 requires vitest@4.1.9
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** pin vitest@4.1.9 in adapter-postgres to match coverage-v8@4.1.9
* **ci:** resolve both adapter and server integration test failures
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **migration:** 0054 down — add migrate:allow-drop marker for the safety linter
* **migrations:** 0002 handles duplicate table when 0001 baseline already created it in mnemosyne
* **migrations:** 0056 episode index plain CREATE INDEX + linter allow-marker (fixes CI integration)
* **migrations:** add scope_owner column to mnemosyne.mnemo_fact (0007)
* **migrations:** grant SELECT to mnemo_owner on v3 tables + update-checksums command
* **migrations:** recreate mv_confidence_map and mv_knowledge_gaps dropped by CASCADE
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **procedural:** monotonic prompt versioning + session A/B stamping
* **rdd:** RDD-7 — correct composition rule verbs and confidences to spec
* **remember:** apply fact embeddings synchronously + authoritatively (Bug 2)
* resolve 2 pre-existing test failures blocking green gate
* **sec:** §5 — Merkle audit hash commits to userAgent/metadata/timestamp
* **sec:** P0-6 — idempotency begin() correctly rejects concurrent duplicates
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Changed

* **adapter-postgres:** explode DrizzleStorageAdapter 5582→507 lines
* remove all v1/v2/v3 version labels from codebase


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/core bumped to 3.3.0-alpha.0
    * @mnemo-ai/types bumped to 3.3.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **api:** Task 12 — 7 missing REST endpoints
* **composition:** lazy-seed built-in composition rules on first workspace write
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** C1 — correct DEK encoding, outbox plaintext leak, workspace-scope DEK pk
* **adapter-postgres:** encrypt audit detail with actor DEK + crypto-erasure read state (C3)
* **adapter-postgres:** implement updateSessionSummary so collapse summary persists (C5)
* **adapter-postgres:** logRecall writes fact_id(TEXT)+activation_score (C4)
* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **adapter-postgres:** serialize audit appends + hash only spec fields (C2)
* **adapter-postgres:** serve Beta-Bernoulli worth for strategy/workflow/skill/reasoning (C7)
* **audit:** thread real actor_type through the audit trail
* **migrations:** 0056 episode index plain CREATE INDEX + linter allow-marker (fixes CI integration)
* **migrations:** runners honor no-transaction via dollar-quote-aware statement splitter (fixes CONCURRENTLY)
* **procedural:** monotonic prompt versioning + session A/B stamping
* resolve 2 pre-existing test failures blocking green gate


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
    * @mnemo-ai/core bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* **aa2.4:** embedding-model migration engine
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter-postgres:** Drizzle worth = α/(α+β) (Wave C2)
* **adapter-postgres:** migration 0013 — Beta-Bernoulli worth posterior (Wave C1)
* **adapter-postgres:** migration 0016 — metacognition MVs (Wave F1)
* **adapter-postgres:** migration 0017 — anticipation MVs (Wave G1)
* **adapter-postgres:** migration 0032 — mnemo_access_policy + mnemo_approval_request (§19)
* **adapter-postgres:** P0-2 vB — production DrizzleApiKeyStore + migration 0055
* **adapter-postgres:** P2 — apply procedural/reasoning Beta decay + migration 0053
* **adapter-postgres:** updateWorth bumps α/β + raw counters (Wave C3)
* **adapter-postgres:** zero-downtime migration safety — 5-check linter + no-transaction runner + CI shadow-apply (spec §35)
* **adapter,core:** LSH population path — remember→outbox→worker→mnemo_fact_lsh (spec §17)
* **adapter,types:** anticipation view read methods (Wave G2)
* **adapter,types:** meta-cognition view read methods (Wave F2)
* **adapter,types:** real episode depth + reconstructEpisode (spec §16)
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **adapter:** mnemo_fact_lsh table + lookup index migration 0023 (spec §17 Tier 2)
* **adapter:** partial unique index idx_fact_topic on mnemo_fact migration 0024 (spec §25.4)
* **anticipation:** 4-way blend + conditional/co-occurrence patterns + pre-injection (spec §30)
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **cache:** §9 L2/L3 cache layers + Redis-down degradation ladder
* **ci:** OPS-8 — migration safety linter covers full committed v3 set
* **core,adapter:** entity-keyed confidence map + coverage/freshness + trends + strengths + suggestedAction (spec §31)
* **core,governance:** §11 promote/demote/canonical actions + max-5-hop TD + governance.propagate
* **core,types,adapter:** kind-differentiated decay + Hebbian STDP/homeostatic (Wave Y1, §25.2/§25.3)
* **core,types,adapter:** materialiseInference port + composition engine (Wave H2)
* **core,types,adapter:** TD(λ) propagation + Wilson-score lower bound (Wave J3)
* **core,types:** compositionality relation/fact_value DSL + multi-hop + warnings + conflicts + 4 seed rules (spec §32)
* **core,types:** hyperedge expansion in recall-cold stage 3b + outbox bump (Wave D4)
* **core/adapter:** RSN-1 — A/B session measurement + procedural transition
* **core/types:** RDD-1..5 — outcome signals, dedup gate, learning mode
* **core:** DELTAMEM — episode embeddings + delta-episode auto-formation
* **core:** enforce worth serving gate + λ-drift time decay (spec §11)
* **core:** Experience-Compression cross-level episode-subtree compression (spec §2)
* **core:** UCE knowledge-type scheduler + collapse extraction bias (spec §10,§7)
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* extend PrimitiveKind with hyperedge + updateWorth support (Wave D5)
* **federation:** DrizzleSyncStorage persistent sync state in Postgres (migration 0011)
* **gdpr:** per-actor DEK for crypto-erasure (P1.2)
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
* **reasoning:** CoT distillation cache loop — resolve/record/feedback + quarantine/golden (spec §8)
* **recall-log:** TASK-4001 — mnemo_recall_log, port methods, DrizzleStorageAdapter, Stage 4 ACT-R
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** P0.1+P0.3+P0.2+P0.4+P1.2+P1.3+P1.4 — full security hardening sprint
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **security:** Wave X2 — access-path detection, export approval gate, GDPR hard delete
* **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server,types,adapter:** single cron registry + verify.codebase + all missing §28 crons (Wave Y2)
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **session:** pins + scratchpad + token/turn triggers + linking episode + hot-promote (spec §7)
* **storage:** add listWorkspaceIds() to StorageAdapter port, DrizzleStorageAdapter, InMemoryStorageAdapter
* **tasks:** state-machine guard + delegate + auto-extract + event annotations (spec §18)
* **types,adapter-postgres:** AccessPolicyStore + ApprovalStore ports + adapters (§19)
* **types,adapter-postgres:** hyperedge CRUD port + adapters (Wave D1)
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
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **wave/p:** Retrieval Tier 2 — POINTER/LSH + fact topic-key upsert
* **webhooks:** HTTP delivery, HMAC signing, CRUD endpoints, DB migration


### Fixed

* **adapter-postgres:** add types:node to tsconfig — resolves Buffer/process IDE errors
* **adapter-postgres:** exclude *.down.sql from the forward migration runner (data-loss guard)
* **adapter-postgres:** materialiseInference — single atomic db.transaction()
* **adapter,types:** guard cross-workspace parent lookup in createEpisode
* **adapter:** decayKind kind-filter + per-row elapsed time + RETURNING row count
* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** doc-lint tool count 14→23 + add mnemo_owner role to baseline migration
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** resolve both adapter and server integration test failures
* **consolidation:** align gate with spec §12 — cluster≥3, worth&lt;0.5, 14d recency, conf≤0.7, admin-lock, rollback
* **core,adapter:** quality review fixes — correct LSH embedding indexing, embed-error fallback, outbox guard
* **core,adapter:** remove stale createHash import, fix unused e var, use array form for Drizzle table config
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** §33 — run deterministic consensus on the production fact-write path
* **core:** handle concurrent topicKey upsert race + index predicate audit
* **guard-tests:** add /// &lt;reference types='node' /&gt; to suppress implicit-any in guard tests
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migration:** 0054 down — add migrate:allow-drop marker for the safety linter
* **migrations:** include created_at in mnemo_audit_log primary key
* **rdd:** RDD-7 — correct composition rule verbs and confidences to spec
* **sec:** §5 — Merkle audit hash commits to userAgent/metadata/timestamp
* **sec:** P0-6 — idempotency begin() correctly rejects concurrent duplicates
* **TASK-5001:** use Uint8Array for bytea, remove unused fields
* **types:** correct Drizzle update return type and complete MnemoFact test factory
* **types:** remove duplicate MnemoHyperedge from relations.ts (Wave D TS fix)
* **types:** remove unused sql import; fix node type resolution in test files (Wave E post)
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build
* **wave-f:** replace inline import() types with top-level imports; remove unused ConfidenceMapRow import


### Documentation

* comprehensive documentation update for v2.0.0-alpha.1
* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* fix stale DATA_MODEL_V3.md refs + add bitemporal Cursor rule
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* unify repo — remove v3 fragmentation, mega README overhaul


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
