# Changelog
> Pre-2026-06-25 `/v1` mentions below predate the server's root-mount change (`app.route("/", v1)`); see `docs/architecture/API.md` for the current mount.

## 3.6.0-alpha.0 (2026-07-06)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **api:** Task 15 — /v1/memory/* compatibility aliases for canonical /v1/* paths
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **capture:** use workspace LLM provider for passive capture extraction
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **config:** add temperature, maxTokens, embedDimensions, embedBatchSize, baseUrl to LLM config API
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **events:** onEventRecorded hook + builtin reactions (close-fact / worth-decrement)
* **federation:** honor since cursor for incremental item pulls
* **federation:** P0-1 — wire app-layer Ed25519+AES-GCM crypto into serve/pull
* **federation:** thread conflictResolution into both prod apply paths
* **idempotency:** expose recovery_point + phase recorder on request context (spec §RDD9)
* **idempotency:** record collapse phases + resume on retry (spec §RDD9 F16)
* **idempotency:** recovery_point on Redis + in-memory live stores (spec §RDD9)
* **idempotency:** selectable Postgres recovery-point store (MNEMO_IDEMPOTENCY_STORE=postgres)
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** multi-level recall — workspace + user + tenant (Gap 4)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **observability:** add CoT resolve latency histogram (topic_key|vector)
* **observability:** compute roi_multiplier metric + ROI&lt;1.5 burn alert
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **observability:** Phase D — real OTel adapter, domain counter wiring, USE gauges, metrics alias, docker port fix, webhook dispatcher
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **plugins:** add createTask + createEpisode to PluginContext
* **plugins:** ctx.createEvent — persist via storage.createEvent before bus emit
* **plugins:** ctx.createFact — storage path + clampSensitivity + subject/metadata
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **rbac:** enforce maxSelfEditsPerSession + maxSessionsConcurrent limits
* **rbac:** enforce taskScopes.canCreate + canDelegate/canDelegateTo in task handlers
* **rbac:** map granular 15-scope vocabulary per route/RPC family
* **rbac:** MNEMO_RBAC_DEFAULT_DENY zero-trust flag
* **rbac:** reach cross_agent_read trigger via x-mnemo-target-agent header
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **resilience:** Redis-backed idempotency + jti stores + 72h reaper
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **self-edit:** wire RDD-7 strengthen/weaken daily budget counters (Task 4)
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** §19 — enforce per-agent rate limits (limits.*)
* **server:** §22 — reasoning_tokens_saved + log↔trace correlation; fix duplicate metric
* **server:** §22 — register remaining metric families + wire recall_empty/federation_conflicts
* **server:** §3 — canonical MNEMO_001..010 operational error-code registry
* **server:** §34.6 — validate composition DSL verbs/ops at create (400)
* **server:** §35(n) — decision.created/superseded webhooks (12/12 canonical events)
* **server:** §35p — wire the embedding-migration cron (mnemo.embed.migration)
* **server:** /v1/break-glass request + approve routes (F10)
* **server:** /v1/usage + /v1/cost read durable DB-sourced usage & spend (F15)
* **server:** add /v1/admin/graph/semantic-backfill endpoint
* **server:** add webhook event dispatcher for domain events (OPS-6)
* **server:** API-1..4 — governance REST routes + admin stats
* **server:** API-5..8 — implement 4 Unimplemented gRPC RPCs
* **server:** distinguish EMPTY_SCOPE vs INSUFFICIENT_SCOPE in scope-guard 403
* **server:** drive SyncEngine.processBatch from gRPC FederationSync stream (F20)
* **server:** durable meter write-through + DB-sourced usage + boot persister cron (F15)
* **server:** emit mnemo.auth span from createAuthMiddleware
* **server:** emit queue_depth gauge from pending outbox count
* **server:** gate mk_admin_ privileged ops behind break-glass two-person grant (F10)
* **server:** gRPC session collapse threads per-agent CollapsePolicy (F2)
* **server:** H5 — wire emitMeter billing calls into route handlers
* **server:** HTTP collapse handler threads per-agent CollapsePolicy (F2)
* **server:** inject DrizzleStorageAdapter into factory collapse (collapse.storage)
* **server:** P0-2 vB — mount scoped-key auth alongside live keys (dark-launch)
* **server:** P1 — recall tiering + workflows/skills routes, gRPC Session/Import, webhooks, metrics
* **server:** route session turn/scratch/pin through write-through SessionBuffer
* **server:** SEC-1 — mount RBAC policy + approval-gate middleware
* **server:** sweep resolves per-agent CollapsePolicy instead of hardcoded 50/8192/30min (F2)
* **server:** thread CALMem tokenBudget + RecMem rerank into POST /v1/recall
* **server:** upgrade OpenTelemetry to v2 with backward compatibility
* **server:** wire DrizzleBreakGlassStore through ServerDeps + boot (F10)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** Phase 2 Security Enforcement — 9 tasks complete
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** declare 5 missing domain span names
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-2 — load-test harness (server.ts + run.ts + README)
* **W0:** Quality Baseline & CI Hard Gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **audit:** thread real actor_type through the audit trail
* **authz:** self_edit scope guard matched /self-edit but routes are /self/edit — scope was never enforced
* **ci:** canary SLO query uses emitted mnemo_recall_duration_seconds metric (C9)
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **ci:** wire adapter-postgres migrations + stub embed for load-smoke
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* complete Mnemosyne remediation phases A-F
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **cron:** RDD-3 — stale-task cron flags at 14d instead of auto-archiving at 7d
* **federation:** reject plaintext pull when peer keys configured (F9)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **obs/sec:** enrich /health/deep, per-operation rate-limit matrix, escalate Merkle tamper
* **obs:** emit mnemo_requests_total globally + route label; emit-or-delete dead metrics
* **ops:** P0-5 — instantiate the §34.8 job-shedding gate at boot
* **rbac:** thread taskScopes.canDelegateTo allow-list (supports '*')
* **scripts:** create-api-key generates/validates UUID workspace
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** §6/§13 — gRPC SelfEdit RPC requires memory:self_edit (not memory:write)
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **sec:** gRPC RBAC parity with HTTP (Forget scope, SelfEdit budgets, IP, RBAC/approval)
* **sec:** P0-3 — audit recall operations (detached, best-effort)
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** §19 RBAC — populate req.namespace so namespace allow-lists enforce
* **server:** §8c — topic-key resolve path enforces the Wilson confidence gate
* **server:** audit fixes — §31 introspect capping, §22 dead metrics, §3 MNEMO wiring
* **server:** clear TS errors introduced by SEC-1 + pre-existing unused vars
* **server:** deny empty-scope full-access bypass by default (F11)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **server:** enforce RDD-7 self-edit per-day caps on gRPC SelfEdit
* **server:** fail-closed encryption boot gate (F8)
* **server:** fail-closed RBAC limit deps boot assertion (F11)
* **server:** import writes all 11 entity types with explicit skip accounting (F13)
* **server:** JSONL export covers decision/entity/strategy/workflow (4 missing spec types)
* **server:** recall without embedder returns 501 not 500
* **server:** register mountMemory route in app.ts
* **server:** route WS gap frame through subscriber buffer to preserve event ordering
* **server:** ship runtime workspace deps so the image boots
* **server:** wire §19 activeSessions dep so production boot passes assertRbacLimitsWired
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **server:** wire webhookSecretCipher into delivery cron + test /webhooks/:id/test route
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard
* **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
* **test:** sync server tests to current implementation (stale-cron 14d+enqueueReview, 16 cron keys, otel shutdown ECONNREFUSED)
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **dry:** add getAuthCtx helper, replace 51 inline c.get() auth extractions
* **dry:** centralize toIso helper and offset/limit pagination schema
* remove all v1/v2/v3 version labels from codebase
* **security:** centralize sensitivity ceiling checks into rbac.ts helpers
* **server:** drive inactivity sweep from sess:active ZSet, remove per-session N+1 connection
* **server:** extract boot sections from index.ts into src/boot/
* **server:** share RDD-7 self-edit counter keys between HTTP and gRPC
* **server:** split routes/index.ts 1297→78 lines into domain route files
* **server:** undo duplicate mountMemory in app.ts


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **recall:** document CALMem tokenBudget + RecMem rerank activation contract


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.5-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.6.0-alpha.0
    * @mnemo-ai/adapter-redis bumped to 3.6.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.5.0-alpha.0
    * @mnemo-ai/federation bumped to 3.5.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.6.0-alpha.0
    * @mnemo-ai/types bumped to 3.6.0-alpha.0
  * devDependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.5-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.6.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.5.0-alpha.0
    * @mnemo-ai/consolidation bumped to 3.5.0-alpha.0
    * @mnemo-ai/federation bumped to 3.5.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.6.0-alpha.0
  * peerDependencies
    * @mnemo-ai/consolidation bumped to 3.5.0-alpha.0
    * @mnemo-ai/core bumped to 3.6.0-alpha.0
    * @mnemo-ai/llm-providers bumped to 3.4.0-alpha.0

## 3.5.0-alpha.0 (2026-07-06)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **api:** Task 15 — /v1/memory/* compatibility aliases for canonical /v1/* paths
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **capture:** use workspace LLM provider for passive capture extraction
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **config:** add temperature, maxTokens, embedDimensions, embedBatchSize, baseUrl to LLM config API
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **events:** onEventRecorded hook + builtin reactions (close-fact / worth-decrement)
* **federation:** honor since cursor for incremental item pulls
* **federation:** P0-1 — wire app-layer Ed25519+AES-GCM crypto into serve/pull
* **federation:** thread conflictResolution into both prod apply paths
* **idempotency:** expose recovery_point + phase recorder on request context (spec §RDD9)
* **idempotency:** record collapse phases + resume on retry (spec §RDD9 F16)
* **idempotency:** recovery_point on Redis + in-memory live stores (spec §RDD9)
* **idempotency:** selectable Postgres recovery-point store (MNEMO_IDEMPOTENCY_STORE=postgres)
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** multi-level recall — workspace + user + tenant (Gap 4)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **observability:** add CoT resolve latency histogram (topic_key|vector)
* **observability:** compute roi_multiplier metric + ROI&lt;1.5 burn alert
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **observability:** Phase D — real OTel adapter, domain counter wiring, USE gauges, metrics alias, docker port fix, webhook dispatcher
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **plugins:** add createTask + createEpisode to PluginContext
* **plugins:** ctx.createEvent — persist via storage.createEvent before bus emit
* **plugins:** ctx.createFact — storage path + clampSensitivity + subject/metadata
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **rbac:** enforce maxSelfEditsPerSession + maxSessionsConcurrent limits
* **rbac:** enforce taskScopes.canCreate + canDelegate/canDelegateTo in task handlers
* **rbac:** map granular 15-scope vocabulary per route/RPC family
* **rbac:** MNEMO_RBAC_DEFAULT_DENY zero-trust flag
* **rbac:** reach cross_agent_read trigger via x-mnemo-target-agent header
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **resilience:** Redis-backed idempotency + jti stores + 72h reaper
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **self-edit:** wire RDD-7 strengthen/weaken daily budget counters (Task 4)
* **server,client-ts,core:** expose graph traversal and path endpoints
* **server,client:** expose includeSemantic on /v1/graph + SDK
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** §19 — enforce per-agent rate limits (limits.*)
* **server:** §22 — reasoning_tokens_saved + log↔trace correlation; fix duplicate metric
* **server:** §22 — register remaining metric families + wire recall_empty/federation_conflicts
* **server:** §3 — canonical MNEMO_001..010 operational error-code registry
* **server:** §34.6 — validate composition DSL verbs/ops at create (400)
* **server:** §35(n) — decision.created/superseded webhooks (12/12 canonical events)
* **server:** §35p — wire the embedding-migration cron (mnemo.embed.migration)
* **server:** /v1/break-glass request + approve routes (F10)
* **server:** /v1/usage + /v1/cost read durable DB-sourced usage & spend (F15)
* **server:** add /v1/admin/graph/semantic-backfill endpoint
* **server:** add webhook event dispatcher for domain events (OPS-6)
* **server:** API-1..4 — governance REST routes + admin stats
* **server:** API-5..8 — implement 4 Unimplemented gRPC RPCs
* **server:** distinguish EMPTY_SCOPE vs INSUFFICIENT_SCOPE in scope-guard 403
* **server:** drive SyncEngine.processBatch from gRPC FederationSync stream (F20)
* **server:** durable meter write-through + DB-sourced usage + boot persister cron (F15)
* **server:** emit mnemo.auth span from createAuthMiddleware
* **server:** emit queue_depth gauge from pending outbox count
* **server:** gate mk_admin_ privileged ops behind break-glass two-person grant (F10)
* **server:** gRPC session collapse threads per-agent CollapsePolicy (F2)
* **server:** H2 — wire Prometheus metrics into business route handlers
* **server:** H5 — wire emitMeter billing calls into route handlers
* **server:** HTTP collapse handler threads per-agent CollapsePolicy (F2)
* **server:** inject DrizzleStorageAdapter into factory collapse (collapse.storage)
* **server:** P0-2 vB — mount scoped-key auth alongside live keys (dark-launch)
* **server:** P1 — recall tiering + workflows/skills routes, gRPC Session/Import, webhooks, metrics
* **server:** route session turn/scratch/pin through write-through SessionBuffer
* **server:** SEC-1 — mount RBAC policy + approval-gate middleware
* **server:** sweep resolves per-agent CollapsePolicy instead of hardcoded 50/8192/30min (F2)
* **server:** thread CALMem tokenBudget + RecMem rerank into POST /v1/recall
* **server:** upgrade OpenTelemetry to v2 with backward compatibility
* **server:** wire DrizzleBreakGlassStore through ServerDeps + boot (F10)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** Phase 2 Security Enforcement — 9 tasks complete
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** declare 5 missing domain span names
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-2 — load-test harness (server.ts + run.ts + README)
* **W0:** Quality Baseline & CI Hard Gate
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **audit:** thread real actor_type through the audit trail
* **authz:** self_edit scope guard matched /self-edit but routes are /self/edit — scope was never enforced
* **ci:** canary SLO query uses emitted mnemo_recall_duration_seconds metric (C9)
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **ci:** wire adapter-postgres migrations + stub embed for load-smoke
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* complete Mnemosyne remediation phases A-F
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **cron:** RDD-3 — stale-task cron flags at 14d instead of auto-archiving at 7d
* **federation:** reject plaintext pull when peer keys configured (F9)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **obs/sec:** enrich /health/deep, per-operation rate-limit matrix, escalate Merkle tamper
* **obs:** emit mnemo_requests_total globally + route label; emit-or-delete dead metrics
* **ops:** P0-5 — instantiate the §34.8 job-shedding gate at boot
* **rbac:** thread taskScopes.canDelegateTo allow-list (supports '*')
* **scripts:** create-api-key generates/validates UUID workspace
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** §6/§13 — gRPC SelfEdit RPC requires memory:self_edit (not memory:write)
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **sec:** gRPC RBAC parity with HTTP (Forget scope, SelfEdit budgets, IP, RBAC/approval)
* **sec:** P0-3 — audit recall operations (detached, best-effort)
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** §19 RBAC — populate req.namespace so namespace allow-lists enforce
* **server:** §8c — topic-key resolve path enforces the Wilson confidence gate
* **server:** audit fixes — §31 introspect capping, §22 dead metrics, §3 MNEMO wiring
* **server:** clear TS errors introduced by SEC-1 + pre-existing unused vars
* **server:** deny empty-scope full-access bypass by default (F11)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **server:** enforce RDD-7 self-edit per-day caps on gRPC SelfEdit
* **server:** fail-closed encryption boot gate (F8)
* **server:** fail-closed RBAC limit deps boot assertion (F11)
* **server:** H1 — wire circuit breakers into route handlers + fix thunkFactory type
* **server:** import writes all 11 entity types with explicit skip accounting (F13)
* **server:** JSONL export covers decision/entity/strategy/workflow (4 missing spec types)
* **server:** recall without embedder returns 501 not 500
* **server:** register mountMemory route in app.ts
* **server:** route WS gap frame through subscriber buffer to preserve event ordering
* **server:** ship runtime workspace deps so the image boots
* **server:** wire §19 activeSessions dep so production boot passes assertRbacLimitsWired
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **server:** wire webhookSecretCipher into delivery cron + test /webhooks/:id/test route
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard
* **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
* **test:** sync server tests to current implementation (stale-cron 14d+enqueueReview, 16 cron keys, otel shutdown ECONNREFUSED)
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **dry:** add getAuthCtx helper, replace 51 inline c.get() auth extractions
* **dry:** centralize toIso helper and offset/limit pagination schema
* remove all v1/v2/v3 version labels from codebase
* **security:** centralize sensitivity ceiling checks into rbac.ts helpers
* **server:** drive inactivity sweep from sess:active ZSet, remove per-session N+1 connection
* **server:** extract boot sections from index.ts into src/boot/
* **server:** share RDD-7 self-edit counter keys between HTTP and gRPC
* **server:** split routes/index.ts 1297→78 lines into domain route files
* **server:** undo duplicate mountMemory in app.ts


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **recall:** document CALMem tokenBudget + RecMem rerank activation contract


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.4-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.5.0-alpha.0
    * @mnemo-ai/adapter-redis bumped to 3.5.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.4.0-alpha.0
    * @mnemo-ai/federation bumped to 3.4.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.5.0-alpha.0
    * @mnemo-ai/types bumped to 3.5.0-alpha.0
  * devDependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.4-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.5.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.4.0-alpha.0
    * @mnemo-ai/consolidation bumped to 3.4.0-alpha.0
    * @mnemo-ai/federation bumped to 3.4.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.5.0-alpha.0
  * peerDependencies
    * @mnemo-ai/consolidation bumped to 3.4.0-alpha.0
    * @mnemo-ai/core bumped to 3.5.0-alpha.0
    * @mnemo-ai/llm-providers bumped to 3.3.0-alpha.0

## 3.4.0-alpha.0 (2026-07-05)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.3:** REST catch-up GET /v1/memory/events?since=&channel=
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **api:** Task 15 — /v1/memory/* compatibility aliases for canonical /v1/* paths
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **capture:** use workspace LLM provider for passive capture extraction
* **chaos:** 6 resilience experiments + harness + weekly workflow + gameday runbook (spec §35)
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **config:** add temperature, maxTokens, embedDimensions, embedBatchSize, baseUrl to LLM config API
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* **events:** onEventRecorded hook + builtin reactions (close-fact / worth-decrement)
* **federation:** honor since cursor for incremental item pulls
* **federation:** P0-1 — wire app-layer Ed25519+AES-GCM crypto into serve/pull
* **federation:** thread conflictResolution into both prod apply paths
* **idempotency:** expose recovery_point + phase recorder on request context (spec §RDD9)
* **idempotency:** record collapse phases + resume on retry (spec §RDD9 F16)
* **idempotency:** recovery_point on Redis + in-memory live stores (spec §RDD9)
* **idempotency:** selectable Postgres recovery-point store (MNEMO_IDEMPOTENCY_STORE=postgres)
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** multi-level recall — workspace + user + tenant (Gap 4)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **observability:** add CoT resolve latency histogram (topic_key|vector)
* **observability:** compute roi_multiplier metric + ROI&lt;1.5 burn alert
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **observability:** Phase D — real OTel adapter, domain counter wiring, USE gauges, metrics alias, docker port fix, webhook dispatcher
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **plugins:** add createTask + createEpisode to PluginContext
* **plugins:** ctx.createEvent — persist via storage.createEvent before bus emit
* **plugins:** ctx.createFact — storage path + clampSensitivity + subject/metadata
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **rbac:** enforce maxSelfEditsPerSession + maxSessionsConcurrent limits
* **rbac:** enforce taskScopes.canCreate + canDelegate/canDelegateTo in task handlers
* **rbac:** map granular 15-scope vocabulary per route/RPC family
* **rbac:** MNEMO_RBAC_DEFAULT_DENY zero-trust flag
* **rbac:** reach cross_agent_read trigger via x-mnemo-target-agent header
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **resilience:** Redis-backed idempotency + jti stores + 72h reaper
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **self-edit:** wire RDD-7 strengthen/weaken daily budget counters (Task 4)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server,federation:** workspace region-lock + cross-region metadata-only federation + residency docs (spec §35)
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** §19 — enforce per-agent rate limits (limits.*)
* **server:** §22 — reasoning_tokens_saved + log↔trace correlation; fix duplicate metric
* **server:** §22 — register remaining metric families + wire recall_empty/federation_conflicts
* **server:** §3 — canonical MNEMO_001..010 operational error-code registry
* **server:** §34.6 — validate composition DSL verbs/ops at create (400)
* **server:** §35(n) — decision.created/superseded webhooks (12/12 canonical events)
* **server:** §35p — wire the embedding-migration cron (mnemo.embed.migration)
* **server:** /v1/break-glass request + approve routes (F10)
* **server:** /v1/usage + /v1/cost read durable DB-sourced usage & spend (F15)
* **server:** add webhook event dispatcher for domain events (OPS-6)
* **server:** API-1..4 — governance REST routes + admin stats
* **server:** API-5..8 — implement 4 Unimplemented gRPC RPCs
* **server:** distinguish EMPTY_SCOPE vs INSUFFICIENT_SCOPE in scope-guard 403
* **server:** drive SyncEngine.processBatch from gRPC FederationSync stream (F20)
* **server:** durable meter write-through + DB-sourced usage + boot persister cron (F15)
* **server:** emit mnemo.auth span from createAuthMiddleware
* **server:** emit queue_depth gauge from pending outbox count
* **server:** gate mk_admin_ privileged ops behind break-glass two-person grant (F10)
* **server:** gRPC session collapse threads per-agent CollapsePolicy (F2)
* **server:** H2 — wire Prometheus metrics into business route handlers
* **server:** H5 — wire emitMeter billing calls into route handlers
* **server:** HTTP collapse handler threads per-agent CollapsePolicy (F2)
* **server:** inject DrizzleStorageAdapter into factory collapse (collapse.storage)
* **server:** P0-2 vB — mount scoped-key auth alongside live keys (dark-launch)
* **server:** P1 — recall tiering + workflows/skills routes, gRPC Session/Import, webhooks, metrics
* **server:** per-WS-connection ring buffer + slow-consumer + drop-oldest (§34.10)
* **server:** route session turn/scratch/pin through write-through SessionBuffer
* **server:** SEC-1 — mount RBAC policy + approval-gate middleware
* **server:** sweep resolves per-agent CollapsePolicy instead of hardcoded 50/8192/30min (F2)
* **server:** thread CALMem tokenBudget + RecMem rerank into POST /v1/recall
* **server:** upgrade OpenTelemetry to v2 with backward compatibility
* **server:** wire DrizzleBreakGlassStore through ServerDeps + boot (F10)
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** Phase 2 Security Enforcement — 9 tasks complete
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** declare 5 missing domain span names
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-2 — load-test harness (server.ts + run.ts + README)
* **W0:** Quality Baseline & CI Hard Gate
* Wave T — standards + security hardening
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **audit:** thread real actor_type through the audit trail
* **authz:** self_edit scope guard matched /self-edit but routes are /self/edit — scope was never enforced
* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** canary SLO query uses emitted mnemo_recall_duration_seconds metric (C9)
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **ci:** wire adapter-postgres migrations + stub embed for load-smoke
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **cron:** RDD-3 — stale-task cron flags at 14d instead of auto-archiving at 7d
* **federation:** reject plaintext pull when peer keys configured (F9)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **obs/sec:** enrich /health/deep, per-operation rate-limit matrix, escalate Merkle tamper
* **obs:** emit mnemo_requests_total globally + route label; emit-or-delete dead metrics
* **ops:** P0-5 — instantiate the §34.8 job-shedding gate at boot
* **rbac:** thread taskScopes.canDelegateTo allow-list (supports '*')
* **scripts:** create-api-key generates/validates UUID workspace
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** §6/§13 — gRPC SelfEdit RPC requires memory:self_edit (not memory:write)
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **sec:** gRPC RBAC parity with HTTP (Forget scope, SelfEdit budgets, IP, RBAC/approval)
* **sec:** P0-3 — audit recall operations (detached, best-effort)
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** §19 RBAC — populate req.namespace so namespace allow-lists enforce
* **server:** §8c — topic-key resolve path enforces the Wilson confidence gate
* **server:** audit fixes — §31 introspect capping, §22 dead metrics, §3 MNEMO wiring
* **server:** clear TS errors introduced by SEC-1 + pre-existing unused vars
* **server:** deny empty-scope full-access bypass by default (F11)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **server:** enforce RDD-7 self-edit per-day caps on gRPC SelfEdit
* **server:** fail-closed encryption boot gate (F8)
* **server:** fail-closed RBAC limit deps boot assertion (F11)
* **server:** H1 — wire circuit breakers into route handlers + fix thunkFactory type
* **server:** import writes all 11 entity types with explicit skip accounting (F13)
* **server:** JSONL export covers decision/entity/strategy/workflow (4 missing spec types)
* **server:** recall without embedder returns 501 not 500
* **server:** register mountMemory route in app.ts
* **server:** route WS gap frame through subscriber buffer to preserve event ordering
* **server:** ship runtime workspace deps so the image boots
* **server:** wire §19 activeSessions dep so production boot passes assertRbacLimitsWired
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **server:** wire webhookSecretCipher into delivery cron + test /webhooks/:id/test route
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard
* **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
* **test:** sync server tests to current implementation (stale-cron 14d+enqueueReview, 16 cron keys, otel shutdown ECONNREFUSED)
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **dry:** add getAuthCtx helper, replace 51 inline c.get() auth extractions
* **dry:** centralize toIso helper and offset/limit pagination schema
* remove all v1/v2/v3 version labels from codebase
* **security:** centralize sensitivity ceiling checks into rbac.ts helpers
* **server:** drive inactivity sweep from sess:active ZSet, remove per-session N+1 connection
* **server:** extract boot sections from index.ts into src/boot/
* **server:** share RDD-7 self-edit counter keys between HTTP and gRPC
* **server:** split routes/index.ts 1297→78 lines into domain route files
* **server:** undo duplicate mountMemory in app.ts


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **recall:** document CALMem tokenBudget + RecMem rerank activation contract


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.3-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.4.0-alpha.0
    * @mnemo-ai/adapter-redis bumped to 3.4.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.3.0-alpha.0
    * @mnemo-ai/federation bumped to 3.3.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.4.0-alpha.0
    * @mnemo-ai/types bumped to 3.4.0-alpha.0
  * devDependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.3-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.4.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.3.0-alpha.0
    * @mnemo-ai/consolidation bumped to 3.3.0-alpha.0
    * @mnemo-ai/federation bumped to 3.3.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.4.0-alpha.0
  * peerDependencies
    * @mnemo-ai/consolidation bumped to 3.3.0-alpha.0
    * @mnemo-ai/core bumped to 3.4.0-alpha.0
    * @mnemo-ai/llm-providers bumped to 3.2.0-alpha.0

## 3.3.0-alpha.0 (2026-07-05)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.3:** REST catch-up GET /v1/memory/events?since=&channel=
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **api:** Task 12 — 7 missing REST endpoints
* **api:** Task 15 — /v1/memory/* compatibility aliases for canonical /v1/* paths
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **auth:** reject non-UUID workspace with 400 invalid_workspace (was 500)
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **bootstrap:** self-hosted API key provisioning via push endpoint
* **cache:** add Hash ops (hSet/hGet/hGetAll/hDel) to CacheAdapter port + Redis impl
* **capture:** use workspace LLM provider for passive capture extraction
* **chaos:** 6 resilience experiments + harness + weekly workflow + gameday runbook (spec §35)
* **collapse:** wire workspace LLM override into collapseSession + cron sweep
* **config:** add temperature, maxTokens, embedDimensions, embedBatchSize, baseUrl to LLM config API
* **consolidation:** replay merged facts against last-10 real queries (synthetic fallback)
* **consolidation:** wire per-workspace LLM into replay validator (P6)
* **core,server:** bridge hot-tier eviction + size into Prometheus via onHotTierEvict hook (F19)
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **core:** wire optional eps-DP embedding noise (MNEMO_EMBEDDING_NOISE, default off)
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* **events:** onEventRecorded hook + builtin reactions (close-fact / worth-decrement)
* **federation:** honor since cursor for incremental item pulls
* **federation:** P0-1 — wire app-layer Ed25519+AES-GCM crypto into serve/pull
* **federation:** thread conflictResolution into both prod apply paths
* **idempotency:** expose recovery_point + phase recorder on request context (spec §RDD9)
* **idempotency:** record collapse phases + resume on retry (spec §RDD9 F16)
* **idempotency:** recovery_point on Redis + in-memory live stores (spec §RDD9)
* **idempotency:** selectable Postgres recovery-point store (MNEMO_IDEMPOTENCY_STORE=postgres)
* **mcp:** add memory_doctor — 27th tool with 8 operational diagnostics
* **multi-tenant:** bind user_id + tenant_id to auth context (Gap 5)
* **multi-tenant:** HTTP routes for tenant/user/workspace management (Gap 1+2)
* **multi-tenant:** multi-level recall — workspace + user + tenant (Gap 4)
* **multi-tenant:** populate scope_owner on all new facts
* **multi-tenant:** targetWorkspaceId on memory_remember — write to any accessible workspace
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **observability:** add CoT resolve latency histogram (topic_key|vector)
* **observability:** compute roi_multiplier metric + ROI&lt;1.5 burn alert
* **observability:** inject W3C trace context on outbound federation/webhook/outbox calls
* **observability:** Phase D — real OTel adapter, domain counter wiring, USE gauges, metrics alias, docker port fix, webhook dispatcher
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* orchester-mnemosyne connection fix & hardening
* **p4:** memory_update, FTS fallback, passive capture, memory_judge
* **p5:** complete CLI commands, 4 new MCP tools, multi-agent plugin support
* **p6:** dynamic LLM config per workspace — DB-stored, hot-swappable
* **P7/P13/P14:** API key management + /me identity + doctor CLI
* **P9:** wire scope + scopeRef into memory_remember and memory_recall
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **plugins:** add createTask + createEpisode to PluginContext
* **plugins:** ctx.createEvent — persist via storage.createEvent before bus emit
* **plugins:** ctx.createFact — storage path + clampSensitivity + subject/metadata
* **quality:** LLM-enhanced consolidation, recall reranking, remind_when, anticipate
* **rbac:** enforce maxSelfEditsPerSession + maxSessionsConcurrent limits
* **rbac:** enforce taskScopes.canCreate + canDelegate/canDelegateTo in task handlers
* **rbac:** map granular 15-scope vocabulary per route/RPC family
* **rbac:** MNEMO_RBAC_DEFAULT_DENY zero-trust flag
* **rbac:** reach cross_agent_read trigger via x-mnemo-target-agent header
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **remember:** accept host-side precomputed embedding vector
* **resilience:** Redis-backed idempotency + jti stores + 72h reaper
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** provision non-superuser DB role so production passes assertSafeDbRole
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **self-edit:** wire RDD-7 strengthen/weaken daily budget counters (Task 4)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server,federation:** workspace region-lock + cross-region metadata-only federation + residency docs (spec §35)
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** §19 — enforce per-agent rate limits (limits.*)
* **server:** §22 — reasoning_tokens_saved + log↔trace correlation; fix duplicate metric
* **server:** §22 — register remaining metric families + wire recall_empty/federation_conflicts
* **server:** §3 — canonical MNEMO_001..010 operational error-code registry
* **server:** §34.6 — validate composition DSL verbs/ops at create (400)
* **server:** §35(n) — decision.created/superseded webhooks (12/12 canonical events)
* **server:** §35p — wire the embedding-migration cron (mnemo.embed.migration)
* **server:** /v1/break-glass request + approve routes (F10)
* **server:** /v1/usage + /v1/cost read durable DB-sourced usage & spend (F15)
* **server:** add webhook event dispatcher for domain events (OPS-6)
* **server:** API-1..4 — governance REST routes + admin stats
* **server:** API-5..8 — implement 4 Unimplemented gRPC RPCs
* **server:** distinguish EMPTY_SCOPE vs INSUFFICIENT_SCOPE in scope-guard 403
* **server:** drive SyncEngine.processBatch from gRPC FederationSync stream (F20)
* **server:** durable meter write-through + DB-sourced usage + boot persister cron (F15)
* **server:** emit mnemo.auth span from createAuthMiddleware
* **server:** emit queue_depth gauge from pending outbox count
* **server:** gate mk_admin_ privileged ops behind break-glass two-person grant (F10)
* **server:** gRPC session collapse threads per-agent CollapsePolicy (F2)
* **server:** H2 — wire Prometheus metrics into business route handlers
* **server:** H5 — wire emitMeter billing calls into route handlers
* **server:** HTTP collapse handler threads per-agent CollapsePolicy (F2)
* **server:** inject DrizzleStorageAdapter into factory collapse (collapse.storage)
* **server:** P0-2 vB — mount scoped-key auth alongside live keys (dark-launch)
* **server:** P1 — recall tiering + workflows/skills routes, gRPC Session/Import, webhooks, metrics
* **server:** per-WS-connection ring buffer + slow-consumer + drop-oldest (§34.10)
* **server:** route session turn/scratch/pin through write-through SessionBuffer
* **server:** SEC-1 — mount RBAC policy + approval-gate middleware
* **server:** shedding gate wrapping QueueAdapter (§34.8)
* **server:** sweep resolves per-agent CollapsePolicy instead of hardcoded 50/8192/30min (F2)
* **server:** thread CALMem tokenBudget + RecMem rerank into POST /v1/recall
* **server:** wire DrizzleBreakGlassStore through ServerDeps + boot (F10)
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **spec-100:** full remediation — 14 work-packages closing F1-F30 audit findings
* **spec-100:** Phase 2 Security Enforcement — 9 tasks complete
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **types:** declare 5 missing domain span names
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-2 — load-test harness (server.ts + run.ts + README)
* **W0:** Quality Baseline & CI Hard Gate
* Wave T — standards + security hardening
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac3:** close final 0.5% spec gap — contract tests + per-workspace anticipation gauge
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **audit:** thread real actor_type through the audit trail
* **authz:** self_edit scope guard matched /self-edit but routes are /self/edit — scope was never enforced
* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** canary SLO query uses emitted mnemo_recall_duration_seconds metric (C9)
* **ci:** create mnemosyne.mnemo_api_keys before ALTER + silence unseeded Date() in tests
* **ci:** make migrations, typecheck, tests, and docker build all green
* **ci:** unblock load-smoke — schema mismatch + alias intercept + plan upgrade
* **ci:** unblock red main tip from multi-tenant batch (4 jobs)
* **ci:** wire adapter-postgres migrations + stub embed for load-smoke
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* collapse RLS v3 read-path — anticipation gauge non-null under prod role
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **core:** add search_path + v3 GUC to all postgres pools and withMnemoTx
* **cron:** RDD-3 — stale-task cron flags at 14d instead of auto-archiving at 7d
* **federation:** reject plaintext pull when peer keys configured (F9)
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **multi-tenant:** reconcile tenant RLS branch with main
* **multi-tenant:** reconcile tenant RLS branch with main
* **obs/sec:** enrich /health/deep, per-operation rate-limit matrix, escalate Merkle tamper
* **obs:** emit mnemo_requests_total globally + route label; emit-or-delete dead metrics
* **ops:** P0-5 — instantiate the §34.8 job-shedding gate at boot
* **rbac:** thread taskScopes.canDelegateTo allow-list (supports '*')
* **scripts:** create-api-key generates/validates UUID workspace
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** §6/§13 — gRPC SelfEdit RPC requires memory:self_edit (not memory:write)
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **sec:** gRPC RBAC parity with HTTP (Forget scope, SelfEdit budgets, IP, RBAC/approval)
* **sec:** P0-3 — audit recall operations (detached, best-effort)
* **security:** consolidate public.mnemo_* tables into mnemosyne schema — fixes S2 RLS bypass
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)
* **server:** §19 RBAC — populate req.namespace so namespace allow-lists enforce
* **server:** §8c — topic-key resolve path enforces the Wilson confidence gate
* **server:** audit fixes — §31 introspect capping, §22 dead metrics, §3 MNEMO wiring
* **server:** clear TS errors introduced by SEC-1 + pre-existing unused vars
* **server:** deny empty-scope full-access bypass by default (F11)
* **server:** discard truly discards (archiveSession, no extraction) + write 'archived' status
* **server:** encrypt webhook signing secret at rest with workspace KEK (F12)
* **server:** enforce RDD-7 self-edit per-day caps on gRPC SelfEdit
* **server:** fail-closed encryption boot gate (F8)
* **server:** fail-closed RBAC limit deps boot assertion (F11)
* **server:** H1 — wire circuit breakers into route handlers + fix thunkFactory type
* **server:** import writes all 11 entity types with explicit skip accounting (F13)
* **server:** JSONL export covers decision/entity/strategy/workflow (4 missing spec types)
* **server:** recall without embedder returns 501 not 500
* **server:** register mountMemory route in app.ts
* **server:** route WS gap frame through subscriber buffer to preserve event ordering
* **server:** ship runtime workspace deps so the image boots
* **server:** wire §19 activeSessions dep so production boot passes assertRbacLimitsWired
* **server:** wire collapse adapters into factory core so §30 anticipation gauge works (F1)
* **server:** wire webhookSecretCipher into delivery cron + test /webhooks/:id/test route
* **tech-debt:** T1-T4 — doctor vocab, workspaceId fetch, squash baseline, capture heuristics
* **test:** align CI-failing tests with F9 reject-by-default + F11 scope guard
* **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
* **test:** sync server tests to current implementation (stale-cron 14d+enqueueReview, 16 cron keys, otel shutdown ECONNREFUSED)
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build


### Changed

* **core:** rename CoreLike → CoreContract, keep CoreLike as alias
* **dry:** add getAuthCtx helper, replace 51 inline c.get() auth extractions
* **dry:** centralize toIso helper and offset/limit pagination schema
* remove all v1/v2/v3 version labels from codebase
* **security:** centralize sensitivity ceiling checks into rbac.ts helpers
* **server:** drive inactivity sweep from sess:active ZSet, remove per-session N+1 connection
* **server:** extract boot sections from index.ts into src/boot/
* **server:** share RDD-7 self-edit counter keys between HTTP and gRPC
* **server:** split routes/index.ts 1297→78 lines into domain route files
* **server:** undo duplicate mountMemory in app.ts


### Documentation

* comprehensive accuracy pass — align all public docs + diagrams with shipped reality
* **recall:** document CALMem tokenBudget + RecMem rerank activation contract


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.2-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.3.0-alpha.0
    * @mnemo-ai/adapter-redis bumped to 3.3.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.2.0-alpha.0
    * @mnemo-ai/federation bumped to 3.2.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.3.0-alpha.0
    * @mnemo-ai/types bumped to 3.3.0-alpha.0
  * devDependencies
    * @mnemo-ai/adapter-llm bumped to 3.1.2-alpha.0
    * @mnemo-ai/adapter-postgres bumped to 3.3.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.2.0-alpha.0
    * @mnemo-ai/consolidation bumped to 3.2.0-alpha.0
    * @mnemo-ai/federation bumped to 3.2.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.3.0-alpha.0
  * peerDependencies
    * @mnemo-ai/consolidation bumped to 3.2.0-alpha.0
    * @mnemo-ai/core bumped to 3.3.0-alpha.0
    * @mnemo-ai/llm-providers bumped to 3.1.0-alpha.0

## 3.2.0-alpha.0 (2026-06-21)


### Added

* **api:** Task 12 — 7 missing REST endpoints
* **api:** Task 15 — /v1/memory/* compatibility aliases for canonical /v1/* paths
* **events:** onEventRecorded hook + builtin reactions (close-fact / worth-decrement)
* path-to-100 — Tasks 12–16 complete (all 16 tasks done)
* Phase 1 — close all 8 correctness/security spec bugs (C1–C7, C9)
* **plugins:** add createTask + createEpisode to PluginContext
* **plugins:** ctx.createEvent — persist via storage.createEvent before bus emit
* **plugins:** ctx.createFact — storage path + clampSensitivity + subject/metadata
* **rbac:** enforce maxSelfEditsPerSession + maxSessionsConcurrent limits
* **rbac:** enforce taskScopes.canCreate + canDelegate/canDelegateTo in task handlers
* **rbac:** map granular 15-scope vocabulary per route/RPC family
* **rbac:** MNEMO_RBAC_DEFAULT_DENY zero-trust flag
* **rbac:** reach cross_agent_read trigger via x-mnemo-target-agent header
* **recall:** route POST /v1/recall through worth-gated v3 three-tier cascade
* **resilience:** Redis-backed idempotency + jti stores + 72h reaper
* **self-edit:** wire RDD-7 strengthen/weaken daily budget counters (Task 4)
* **spec-100:** Phase 2 Security Enforcement — 9 tasks complete
* **spec-100:** phase3 correctness remediation — 18 tasks, ~99.5% spec compliance
* **webhooks:** delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable


### Fixed

* **adapter-postgres:** provision per-actor DEK and fail closed on confidential writes (C1)
* **audit:** thread real actor_type through the audit trail
* **authz:** self_edit scope guard matched /self-edit but routes are /self/edit — scope was never enforced
* **ci:** canary SLO query uses emitted mnemo_recall_duration_seconds metric (C9)
* **rbac:** thread taskScopes.canDelegateTo allow-list (supports '*')
* **server,core:** thread CollapsePolicy from agent profile into collapse pipeline (C6)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/adapter-redis bumped to 3.2.0-alpha.0
    * @mnemo-ai/types bumped to 3.2.0-alpha.0
  * devDependencies
    * @mnemo-ai/adapter-postgres bumped to 3.2.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.1.0-alpha.0
    * @mnemo-ai/consolidation bumped to 3.1.1-alpha.0
    * @mnemo-ai/federation bumped to 3.1.1-alpha.0
    * @mnemo-ai/plugins bumped to 3.2.0-alpha.0
  * peerDependencies
    * @mnemo-ai/adapter-postgres bumped to 3.2.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.1.0-alpha.0
    * @mnemo-ai/consolidation bumped to 3.1.1-alpha.0
    * @mnemo-ai/core bumped to 3.2.0-alpha.0
    * @mnemo-ai/federation bumped to 3.1.1-alpha.0
    * @mnemo-ai/llm-providers bumped to 3.0.2-alpha.0
    * @mnemo-ai/plugins bumped to 3.2.0-alpha.0

## 3.1.0-alpha.0 (2026-06-19)


### Added

* §30/§31 — anticipate lookAhead+context params; introspect limit
* **aa2.2:** WS replay engine — ID stamping, resubscribe handler, replay singleton
* **aa2.3:** REST catch-up GET /v1/memory/events?since=&channel=
* **aa2.5:** hot-tier dump engine — ZSet→PG→reload on boot/shutdown
* **adapter/server/mcp:** SEC-4 + RSN-3 + RDD-6
* **anticipation:** 4-way blend + conditional/co-occurrence patterns + pre-injection (spec §30)
* **auth:** add key expiry + scope enforcement (P0.1 + P0.3)
* **auth:** P0-2(A) — §6 key deprecation grace on the live key scheme
* **billing:** 7-type meter events + 5-min aggregation + overage throttle + spend alerts + /v1/usage (spec §35)
* **cache:** §9 L2/L3 cache layers + Redis-down degradation ladder
* **chaos:** 6 resilience experiments + harness + weekly workflow + gameday runbook (spec §35)
* **consolidation-mcp:** activate memory_consolidate + consolidation scheduler in server boot
* **consolidation:** add background scheduler — 60s interval, top-20 candidates
* **core,adapter:** entity-keyed confidence map + coverage/freshness + trends + strengths + suggestedAction (spec §31)
* **core,governance:** §11 promote/demote/canonical actions + max-5-hop TD + governance.propagate
* **core,types:** compositionality relation/fact_value DSL + multi-hop + warnings + conflicts + 4 seed rules (spec §32)
* **core/cron:** COG-1..3 — wire governance actions into production cron
* **cron:** COG-4..8 — real bodies for 5 remaining empty cron handlers
* **deploy:** canary SLO auto-rollback decision + SloRollbackMonitor + pipeline/DR runbooks + weekly test-restore (spec §35)
* **dx:** type/param error format + mk_test_ sandbox keys + CLI subcommands + mock server (spec §35)
* **federation-sync:** InMemorySyncStorage + SyncEngine wiring — POST /sync executes real peer sync
* **federation:** HTTP routes, InMemoryPeerStore/JobStore, server boot wiring
* **federation:** implement HTTP pull transport (PullClient + /items endpoint)
* **federation:** LWW conflict resolution — remove POST /resolve 501
* **federation:** make /peers/pending self-describing (discovery.enabled=false)
* **federation:** P0-1 — wire app-layer Ed25519+AES-GCM crypto into serve/pull
* **mcp:** memory_strategy tool + HTTP routes + SDK methods (Wave B4)
* **obs:** completion-path LLM token metrics via hexagonal usage hook
* **observability:** Phase D — real OTel adapter, domain counter wiring, USE gauges, metrics alias, docker port fix, webhook dispatcher
* **obs:** real LLM completion cost end-to-end + instrument all completion sites
* **p2:** merge Wave A–I — §30-33, compositionality, anticipation, consensus
* **perf:** coalescer + batch embedding + cursor pagination + slow-query thresholds (spec §35)
* **plugins:** PluginLoader with in-process plugin support + server boot wiring
* **prospective-memory:** reminders schema, evaluator, HTTP routes, MCP tool activation
* **reasoning:** CoT distillation cache loop — resolve/record/feedback + quarantine/golden (spec §8)
* **reasoning:** RSN-2 procedural unit tests, RSN-4 durable self-edit budgets, RSN-5 fix memory_introspect description
* **reminders:** 30s background evaluation polling — time-based auto-trigger
* **sec:** per-key sensitivity ceiling — recall honors the API key's maxSensitivity
* **security:** P0.1+P0.3+P0.2+P0.4+P1.2+P1.3+P1.4 — full security hardening sprint
* **security:** SEC-2 — IP allowlist + key-type prefixes (migration 0051)
* **security:** sensitivity ceiling on GET /facts routes (P0.2)
* **security:** Wave X2 — access-path detection, export approval gate, GDPR hard delete
* **self-edit:** Wave M2 — Self-Editing Memory with 6-action policy + agent profile + reflection cadence (spec §13)
* **server,adapter:** idempotency keys + date versioning + multi-layer rate limiting (Wave T1, spec §35/§34.9)
* **server,client-ts:** add composition admin routes + client namespace getter (Wave H4)
* **server,client-ts:** hyperedge HTTP routes + SDK flat methods (Wave D2)
* **server,federation:** workspace region-lock + cross-region metadata-only federation + residency docs (spec §35)
* **server,mcp,client-ts:** /v1/anticipation + memory_anticipate (Wave G4)
* **server,mcp,client-ts:** /v1/metacognition + memory_introspect (Wave F4)
* **server,types,adapter:** single cron registry + verify.codebase + all missing §28 crons (Wave Y2)
* **server,types:** H7 — validateTestKeyBinding in ScopedApiKeyAdapter.authenticate()
* **server:** §19 — enforce per-agent rate limits (limits.*)
* **server:** §22 — reasoning_tokens_saved + log↔trace correlation; fix duplicate metric
* **server:** §22 — register remaining metric families + wire recall_empty/federation_conflicts
* **server:** §3 — canonical MNEMO_001..010 operational error-code registry
* **server:** §34.6 — validate composition DSL verbs/ops at create (400)
* **server:** §35(n) — decision.created/superseded webhooks (12/12 canonical events)
* **server:** §35p — wire the embedding-migration cron (mnemo.embed.migration)
* **server:** /v1/events routes (Wave A4)
* **server:** /v1/reasoning routes (Wave A5)
* **server:** /v1/tasks routes (Wave A3)
* **server:** add webhook event dispatcher for domain events (OPS-6)
* **server:** anticipation mining cron + STATUS update (Wave G5)
* **server:** API-1..4 — governance REST routes + admin stats
* **server:** API-5..8 — implement 4 Unimplemented gRPC RPCs
* **server:** DrizzleSyncStorage swap + session inactivity sweep
* **server:** emit 11 lifecycle events onto bus (spec §4)
* **server:** full 15-scope guard mapping incl. hard_delete/governance/subscribe (§6)
* **server:** graceful shutdown fix + metrics mount + coverage config
* **server:** gRPC streaming RPCs over the Wave Q event bus (spec §4 R2)
* **server:** gRPC/ConnectRPC transport — proto + buf codegen + 7 unary RPCs (spec §4 R1)
* **server:** H2 — wire Prometheus metrics into business route handlers
* **server:** H5 — wire emitMeter billing calls into route handlers
* **server:** metacognition refresh cron at boot + STATUS update (Wave F5)
* **server:** mnemo_queue_* + mnemo_ws_* backpressure metrics (§34.8/§34.10)
* **server:** P0-2 vB — mount scoped-key auth alongside live keys (dark-launch)
* **server:** P1 — recall tiering + workflows/skills routes, gRPC Session/Import, webhooks, metrics
* **server:** per-WS-connection ring buffer + slow-consumer + drop-oldest (§34.10)
* **server:** RBAC policy middleware (60s cache) + approval-gate 202/resume (§19)
* **server:** SEC-1 — mount RBAC policy + approval-gate middleware
* **server:** shared row→wire mappers for task/event/reasoning (Wave A1)
* **server:** shedding gate wrapping QueueAdapter (§34.8)
* **server:** W4.3 wire mTLS+service-JWT binding into federation sync route
* **server:** Wave R — gRPC/ConnectRPC transport (spec §4 R1 + R2 + R3)
* **server:** WebSocket subscriptions at /v1/memory/ws (spec §4)
* **server:** wire plugin hooks into facts/recall routes + PluginContext builder (spec §21 U1.6+U1.7)
* **server:** wire Redis hot tier into v3 core boot (gated on MNEMO_REDIS_URL)
* **server:** wire v3 MnemoCore — remember/forget/recall use full v3 pipeline
* **session:** pins + scratchpad + token/turn triggers + linking episode + hot-promote (spec §7)
* **session:** wire session routes + patchFact in PATCH /memory/:id
* **tasks:** state-machine guard + delegate + auto-extract + event annotations (spec §18)
* **v8-v10:** outbox DB-level backoff, CLI export/import, contract tests, M10 ports, H11-H13 cron/deploy
* **ver:** VER-2 — load-test harness (server.ts + run.ts + README)
* Wave T — standards + security hardening
* Wave W Part B — §19 Agent RBAC + Approval Gate + §6 mTLS + Service JWT
* Wave Y — Engram Neuro-Dynamics + Cron Registry (§25/§28)
* Wave Z — Cognitive Completeness (RecMem, UCE, Compression, Governance, Cache)
* **wave-aa:** Backpressure & Resilience — shedding, WS replay, embed migration, hot-tier dump
* **wave-ac:** schema & contract completeness — final sweep (AC1–AC4 §34.6/7/9)
* **wave-i:** §33 Distributed Consensus — TRUST_ANCHORS, resolveConsensus, supermajority /resolve
* **wave-k:** correctness fixes — consolidation gate, worth gate, hyperedge members, delta episodes
* **wave-t:** T2 auth hardening — argon2id, break-glass MFA, key rotation, anomaly detection
* **wave-t:** T3 encryption at rest — DEK→KEK hierarchy, column-level PII, ε-DP noise, KEK rotation
* **wave-t:** T4 OutcomeSignal + cold-start learning mode + stale-task cron
* **wave-u:** §14 Procedural Memory — metaprompt evolution engine + HTTP routes + weekly cron (U2+U3)
* **wave-v:** §22 Observability + §26 Infra + §29 Benchmarks + §27 CUP keyset + §36 Webhooks/Export/Contracts
* **webhooks:** HTTP delivery, HMAC signing, CRUD endpoints, DB migration
* **webhooks:** Stripe-style t=ts,v1=sig format with 300s replay window (P1.3)


### Fixed

* **c9:** wire PII column encryption in createFact (GDPR crypto-erasure)
* **ci:** make migrations, typecheck, tests, and docker build all green
* **cog:** enforce self-edit cooldown + log working-memory fallback eviction
* **consolidation:** align gate with spec §12 — cluster≥3, worth&lt;0.5, 14d recency, conf≤0.7, admin-lock, rollback
* **core:** §25.2 — make kind-differentiated decay actually run (semantic + crons)
* **cron:** RDD-3 — stale-task cron flags at 14d instead of auto-archiving at 7d
* **federation:** use static import + globalThis in tests after pull transport
* **mcp/sdk/plugins:** expose asOf + anticipation context/lookAhead; clamp plugin write sensitivity
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **migrate:** provision both schemas — resolve dual-core deploy gap (finding #0)
* **obs/sec:** enrich /health/deep, per-operation rate-limit matrix, escalate Merkle tamper
* **obs:** emit mnemo_requests_total globally + route label; emit-or-delete dead metrics
* **ops:** P0-5 — instantiate the §34.8 job-shedding gate at boot
* **rbac.test:** explicit array type to suppress implicit-any on filterBySensitivity map
* **reasoning:** recordReasoningUse on resolve HIT + InMemory updateWorth/queryReasoning fixes
* **recall:** degrade gracefully to lexical-only when no LLM provider configured
* **routes:** add sensitivity to Fact/RecallHit deps + PATCH ceiling guard
* **sec:** §5 per-key rate limit · §6 procedural scope · §7 remember sensitivity
* **sec:** §6/§13 — gRPC SelfEdit RPC requires memory:self_edit (not memory:write)
* **sec:** close P0 recall sensitivity leak on /v1/recall + gRPC recall
* **sec:** federation — close P0 JWT replay + P1 scope/egress/peer-enroll gaps
* **sec:** gRPC RBAC parity with HTTP (Forget scope, SelfEdit budgets, IP, RBAC/approval)
* **sec:** P0-3 — audit recall operations (detached, best-effort)
* **self-edit:** quality fixes — Map pruning, cadence exact-match, profile strengthen guard, reason forwarding, Span stub shape
* **self-edit:** remove unused policy param from applySelfEdit
* **self-edit:** scope editsBySession/deletesByDay per mountSelf call for test isolation + fix countsAsEdit bug
* **server:** §19 RBAC — populate req.namespace so namespace allow-lists enforce
* **server:** §8c — topic-key resolve path enforces the Wilson confidence gate
* **server:** add .max() caps to task body schemas, clean createTask handler
* **server:** add .openapi("ListEventsQuery") to events query schema
* **server:** audit fixes — §31 introspect capping, §22 dead metrics, §3 MNEMO wiring
* **server:** clear TS errors introduced by SEC-1 + pre-existing unused vars
* **server:** guard governance.propagate against abandoned sessions (spec §11)
* **server:** H1 — wire circuit breakers into route handlers + fix thunkFactory type
* **server:** remove embeddingStale from reasoningToWire wire shape (storage-layer flag)
* **server:** remove unused randomUUID import in tasks.ts
* **server:** reuse EventAnnotationSchema in response, add .min(1) to description, add DELETE tests
* **tests:** resolve TS errors in grpc-unary + admin-route + mcp reasoning
* **test:** sync server tests to current implementation (stale-cron 14d+enqueueReview, 16 cron keys, otel shutdown ECONNREFUSED)
* **types:** rename MnemoBusEventType→MnemoEventType
* vector-index non-fact primitives + filter.kind; wire real LLM token/cost metrics
* **wave-ad:** wire all critical boot deps + fix monorepo build
* **wave-h:** fix mock type errors in composition-route.test.ts
* **wave-x:** spec gap fixes — score demotion, anomaly outbox ordering, InjectionScore export, missing tests


### Changed

* **middleware/rbac:** import SENSITIVITY_ORDER and Sensitivity from @mnemo-ai/types (dedup)


### Documentation

* fix final-audit findings — accurate API examples, real MCP tool surface, package statuses, session SVG
* reflect hot-tier wiring, sensitivity guard, ESM-only bin, and federation discovery flag
* **repo:** Phase 1+3 — LLM-oriented docs, TSDoc, and algorithm explanations
* **status:** Wave L verified — relation DSL + multi-hop inference, entity-keyed metacognition + trends


### Security

* federation_received items keep trust score capped at 20.


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @mnemo-ai/adapter-redis bumped to 3.1.0-alpha.0
    * @mnemo-ai/types bumped to 3.1.0-alpha.0
  * devDependencies
    * @mnemo-ai/adapter-postgres bumped to 3.1.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.0.1-alpha.0
    * @mnemo-ai/consolidation bumped to 3.1.0-alpha.0
    * @mnemo-ai/federation bumped to 3.1.0-alpha.0
    * @mnemo-ai/plugins bumped to 3.1.0-alpha.0
  * peerDependencies
    * @mnemo-ai/adapter-postgres bumped to 3.1.0-alpha.0
    * @mnemo-ai/adapter-vector bumped to 3.0.1-alpha.0
    * @mnemo-ai/consolidation bumped to 3.1.0-alpha.0
    * @mnemo-ai/core bumped to 3.1.0-alpha.0
    * @mnemo-ai/federation bumped to 3.1.0-alpha.0
    * @mnemo-ai/llm-providers bumped to 3.0.1-alpha.0
    * @mnemo-ai/plugins bumped to 3.1.0-alpha.0

## 2.4.0-alpha.0 (2026-06-13)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* per-workspace LLM provider config (migration 0065)
* **server:** graceful shutdown fix + metrics mount + coverage config
* **session:** wire session routes + patchFact in PATCH /memory/:id
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* **rbac.test:** explicit array type to suppress implicit-any on filterBySensitivity map
* resolve all 22 audit findings (6 critical) — green build + tests
* **routes:** add sensitivity to Fact/RecallHit deps + PATCH ceiling guard
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector
* **server:** accept seed-style ids on entity/episode/review routes + fix entity-facts 500
* **server:** accept underscore entity ids in graph focus param
* **test:** use portable path resolution instead of hardcoded /Users/... in integration test


### Changed

* **middleware/rbac:** import SENSITIVITY_ORDER and Sensitivity from @mnemo-ai/types (dedup)


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @mnemo-ai/core bumped to 2.4.0-alpha.0

## 2.3.0-alpha.0 (2026-06-13)


### Added

* **server:** graceful shutdown fix + metrics mount + coverage config
* **session:** wire session routes + patchFact in PATCH /memory/:id


### Fixed

* **rbac.test:** explicit array type to suppress implicit-any on filterBySensitivity map
* **routes:** add sensitivity to Fact/RecallHit deps + PATCH ceiling guard
* **server:** accept seed-style ids on entity/episode/review routes + fix entity-facts 500
* **server:** accept underscore entity ids in graph focus param


### Changed

* **middleware/rbac:** import SENSITIVITY_ORDER and Sensitivity from @mnemo-ai/types (dedup)


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @mnemo-ai/core bumped to 2.3.0-alpha.0

## 2.2.0-alpha.0 (2026-06-11)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* per-workspace LLM provider config (migration 0065)
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* resolve all 22 audit findings (6 critical) — green build + tests
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector
* **test:** use portable path resolution instead of hardcoded /Users/... in integration test


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @mnemo-ai/core bumped to 2.2.0-alpha.0

## 2.1.0-alpha.0 (2026-06-07)


### Added

* add GET /v1/graph endpoint + client.graph() SDK method
* extract Mnemosyne v2.0.0-alpha.0 to standalone monorepo
* per-workspace LLM provider config (migration 0065)
* tramo 1 — 5 read endpoints (entities + episodes)
* tramo 2 — 5 write endpoints (entities POST/PATCH + review CRUD)
* tramo 3 — audit + export + restore + decisions (5 endpoints)
* tramo 4 — 10 endpoints (facts CRUD + decisions writes + relations + citations + review enqueue)
* tramo 5 — GET /v1/facts with FTS + keyset cursor + asOf


### Fixed

* resolve all 22 audit findings (6 critical) — green build + tests
* **runtime:** end-to-end fixes found by live HTTP testing against pgvector
* **test:** use portable path resolution instead of hardcoded /Users/... in integration test


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * @mnemo-ai/core bumped to 2.1.0-alpha.0
